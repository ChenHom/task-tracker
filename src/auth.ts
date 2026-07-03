import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db';

// ── 密碼雜湊（scrypt + 隨機 salt，存成 "salt:hash" hex）──────────────
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length);
  // constant-time 比對，避免 timing attack；長度不等時 timingSafeEqual 會丟例外，先擋
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Session ────────────────────────────────────────────────────────
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'session';

export function createSession(userId: string, database = db): string {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  database.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
  return id;
}

export function getSessionUser(token: string | undefined, database = db): string | null {
  if (!token) return null;
  const row = database.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(token) as
    | { user_id: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    destroySession(token, database);
    return null;
  }
  return row.user_id;
}

export function destroySession(token: string, database = db): void {
  database.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

// ── Cookie ─────────────────────────────────────────────────────────
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  // ponytail: 正式環境（HTTPS）要再加 `Secure`；本機 http dev 加了瀏覽器不會回送。
  const maxAge = Math.floor(TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

// ── 登入 ───────────────────────────────────────────────────────────
// user 不存在時仍跑一次 verify，讓成功/失敗耗時相近，擋 timing-based 帳號枚舉。
const DUMMY_HASH = hashPassword('');

export function recordLoginEvent(
  email: string,
  userId: string | null,
  success: boolean,
  ip: string | null,
  userAgent: string | null,
  database = db,
): void {
  database
    .prepare('INSERT INTO login_events (email, user_id, success, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(email, userId, success ? 1 : 0, ip, userAgent);
}

// 成功回 user_id、失敗回 null。不論成敗都寫一筆 login_event。
export function attemptLogin(
  email: string,
  password: string,
  ip: string | null,
  userAgent: string | null,
  database = db,
): string | null {
  const norm = email.trim().toLowerCase();
  const user = database.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(norm) as
    | { id: string; password_hash: string }
    | undefined;
  const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  recordLoginEvent(norm, user?.id ?? null, ok, ip, userAgent, database);
  return ok && user ? user.id : null;
}

// ── requireAuth middleware ─────────────────────────────────────────
export function currentUserId(req: IncomingMessage, database = db): string | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return getSessionUser(token, database);
}

// 未登入 → 寫 401 並回 null；handler 拿到 null 就 return。回 string 代表已登入。
export function requireAuth(req: IncomingMessage, res: ServerResponse): string | null {
  const userId = currentUserId(req);
  if (!userId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未登入' }));
    return null;
  }
  return userId;
}
