import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  destroySession,
  parseCookies,
  sessionCookie,
} from './auth';

// ── 密碼 ──
const stored = hashPassword('correct horse');
assert.ok(verifyPassword('correct horse', stored), '正確密碼應通過');
assert.ok(!verifyPassword('wrong', stored), '錯誤密碼應被拒');
assert.ok(!verifyPassword('x', 'malformed'), '格式錯誤的 hash 應回 false 而非丟例外');
assert.notStrictEqual(hashPassword('a'), hashPassword('a'), '同密碼不同 salt → 不同 hash');

// ── Session（用 in-memory db，不污染 dev.db）──
const db = new DatabaseSync(':memory:');
runMigrations(db);
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run('u1', 'a@b.com', stored);

const token = createSession('u1', db);
assert.strictEqual(getSessionUser(token, db), 'u1', '有效 session 應回 user_id');
assert.strictEqual(getSessionUser('nope', db), null, '不存在的 token 應回 null');
assert.strictEqual(getSessionUser(undefined, db), null, 'undefined token 應回 null');

// 過期 session：查詢時回 null 並清除
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
  'expired',
  'u1',
  '2000-01-01T00:00:00.000Z',
);
assert.strictEqual(getSessionUser('expired', db), null, '過期 session 應回 null');
assert.strictEqual(db.prepare("SELECT 1 FROM sessions WHERE id = 'expired'").get(), undefined, '過期 session 應被清除');

destroySession(token, db);
assert.strictEqual(getSessionUser(token, db), null, 'destroy 後應回 null');

// FK CASCADE：刪 user 連帶清掉其 session
createSession('u1', db);
db.prepare("DELETE FROM users WHERE id = 'u1'").run();
assert.strictEqual(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 0, '刪 user 應 CASCADE 清掉 session');

// ── Cookie ──
assert.deepStrictEqual(parseCookies('session=abc; theme=dark'), { session: 'abc', theme: 'dark' });
assert.deepStrictEqual(parseCookies(undefined), {});
const cookie = sessionCookie('tok123');
assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'), 'cookie 應含 HttpOnly + SameSite');

console.log('auth.test.ts OK');
