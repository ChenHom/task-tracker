import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
