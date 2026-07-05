import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db';
import { CommandError } from './eventStore';

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

// ── 建立使用者（無公開註冊，僅供 seeder / 內部呼叫）───────────────────
export function createUser(email: string, password: string, database = db): string {
  const norm = email.trim().toLowerCase();
  const id = randomUUID();
  try {
    database.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, norm, hashPassword(password));
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) throw new CommandError(`email 已被使用：${norm}`);
    throw e;
  }
  return id;
}

// 依 email 查 user id（給 member 邀請 API 用：以 email 找出既有帳號）。查無回 null。
export function getUserIdByEmail(email: string, database = db): string | null {
  const norm = email.trim().toLowerCase();
  const row = database.prepare('SELECT id FROM users WHERE email = ?').get(norm) as { id: string } | undefined;
  return row?.id ?? null;
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

// 讓某使用者「所有裝置」的 session 全部失效（重設密碼後強制重新登入）。
export function destroySessionsForUser(userId: string, database = db): void {
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
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

// ── 忘記密碼 / 重設密碼 ────────────────────────────────────────────
// token 是 randomBytes(32) 產生的高熵隨機值，本身已經無法猜測；落地只存
// SHA-256 hex digest（快速、確定性雜湊，可直接等值查找）。這跟密碼故意
// 用慢速+per-row salt 的 scrypt 是不同考量：密碼是低熵、需要防離線暴力
// 破解逐次嘗試；這裡的 token 已經夠隨機，只需要防「資料庫外洩後 token
// 明碼可直接使用」，SHA-256 digest 就足夠且能索引查詢。
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 小時

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 依 email 產生一次性重設 token；查無此 email 回 null（呼叫端無論如何都要回同一句訊息，
// 不得依此結果洩漏 email 是否存在）。
export function createPasswordResetToken(email: string, database = db): string | null {
  const norm = email.trim().toLowerCase();
  const user = database.prepare('SELECT id FROM users WHERE email = ?').get(norm) as { id: string } | undefined;
  if (!user) return null;
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  database
    .prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), user.id, hashToken(token), expiresAt);
  return token;
}

// 驗證 token（存在/未過期/未使用過）並更新密碼；成功後標記 token 已用、
// 讓該使用者所有裝置的 session 全部失效。不論失敗原因為何（不存在/過期/已用過）一律回 false，
// 不對外區分理由，避免洩漏額外資訊。
export function resetPassword(token: string, newPassword: string, database = db): boolean {
  const row = database.prepare('SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?').get(
    hashToken(token),
  ) as { id: string; user_id: string; expires_at: string; used_at: string | null } | undefined;
  if (!row) return false;
  if (row.used_at !== null) return false;
  if (new Date(row.expires_at).getTime() <= Date.now()) return false;

  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.user_id);
  database.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(row.id);
  destroySessionsForUser(row.user_id, database);
  return true;
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
