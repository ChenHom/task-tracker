import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { CommandError } from './eventStore';
import {
  hashPassword,
  verifyPassword,
  createUser,
  createSession,
  getSessionUser,
  destroySession,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  attemptLogin,
  currentUserId,
  requireAuth,
  createPasswordResetToken,
  resetPassword,
  SESSION_COOKIE,
} from './auth';

// ── 密碼 ──
const stored = hashPassword('correct horse');
assert.ok(verifyPassword('correct horse', stored), '正確密碼應通過');
assert.ok(!verifyPassword('wrong', stored), '錯誤密碼應被拒');
assert.ok(!verifyPassword('x', 'malformed'), '格式錯誤的 hash 應回 false 而非丟例外');
assert.notStrictEqual(hashPassword('a'), hashPassword('a'), '同密碼不同 salt → 不同 hash');

// ── createUser ──
const db = new DatabaseSync(':memory:');
runMigrations(db);
const newId = createUser('New@Example.com', 'whatever123', db);
assert.ok(newId, 'createUser 應回傳新 id');
const row = db.prepare('SELECT email FROM users WHERE id = ?').get(newId) as { email: string };
assert.strictEqual(row.email, 'new@example.com', 'email 應正規化為小寫');
assert.throws(() => createUser('new@example.com', 'other', db), CommandError, '重複 email 應丟 CommandError');

// ── Session（沿用上面的 db，不污染 dev.db）──
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
assert.ok(clearSessionCookie().includes('Max-Age=0'), '登出 cookie 應 Max-Age=0');

// ── 登入嘗試 + login_events（獨立 db，前面已把 u1 刪掉）──
const db2 = new DatabaseSync(':memory:');
runMigrations(db2);
db2.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run('u1', 'a@b.com', hashPassword('correct horse'));

assert.strictEqual(attemptLogin('a@b.com', 'correct horse', '1.2.3.4', 'ua', db2), 'u1', '正確帳密回 user_id');
assert.strictEqual(attemptLogin(' A@B.com ', 'correct horse', null, null, db2), 'u1', 'email 大小寫/空白正規化');
assert.strictEqual(attemptLogin('a@b.com', 'wrong', null, null, db2), null, '密碼錯回 null');
assert.strictEqual(attemptLogin('nobody@x.com', 'whatever', null, null, db2), null, '帳號不存在回 null');

const events = db2.prepare('SELECT email, user_id, success FROM login_events ORDER BY id').all() as
  { email: string; user_id: string | null; success: number }[];
assert.strictEqual(events.length, 4, '每次嘗試都記一筆 login_event');
assert.deepStrictEqual(events.map((e) => e.success), [1, 1, 0, 0], 'success 依序 成功,成功,失敗,失敗');
assert.strictEqual(events[2].user_id, 'u1', '密碼錯但帳號存在 → 仍記到 user_id');
assert.strictEqual(events[3].user_id, null, '帳號不存在的失敗 → user_id 為 null');
assert.strictEqual(events[3].email, 'nobody@x.com', '記下嘗試的 email（正規化後）');

// ── requireAuth / currentUserId ──
const fakeReq = (cookieHeader?: string): any => ({ headers: cookieHeader ? { cookie: cookieHeader } : {} });
const tok = createSession('u1', db2);
assert.strictEqual(currentUserId(fakeReq(`${SESSION_COOKIE}=${tok}`), db2), 'u1', '帶有效 session cookie → user_id');
assert.strictEqual(currentUserId(fakeReq(), db2), null, '無 cookie → null');

let status = 0;
const fakeRes: any = { writeHead: (s: number) => { status = s; }, end: () => {} };
assert.strictEqual(requireAuth(fakeReq(), fakeRes), null, '未登入 → requireAuth 回 null');
assert.strictEqual(status, 401, '未登入 → requireAuth 寫 401');

// ── 忘記密碼 / 重設密碼（獨立 db）──
const db3 = new DatabaseSync(':memory:');
runMigrations(db3);
const resetUserId = createUser('reset@example.com', 'old-password', db3);

// 存在的 email → 回 token；不存在的 email → 回 null（不洩漏帳號存在與否）
const resetToken = createPasswordResetToken('Reset@Example.com', db3); // 大小寫/空白正規化應仍找得到
assert.ok(resetToken, '已註冊 email 應回傳 token');
assert.strictEqual(createPasswordResetToken('nobody@example.com', db3), null, '未註冊 email 應回 null');

// 落地存的是 hash，不是明碼
const storedReset = db3.prepare('SELECT token_hash FROM password_resets WHERE user_id = ?').get(resetUserId) as
  | { token_hash: string }
  | undefined;
assert.ok(storedReset, '應寫入一筆 password_resets');
assert.notStrictEqual(storedReset!.token_hash, resetToken, 'token_hash 不應等於明碼 token');

// 重設前建立一個 session，重設成功後應該全部失效
const preResetSessionToken = createSession(resetUserId, db3);
assert.strictEqual(getSessionUser(preResetSessionToken, db3), resetUserId, '重設前 session 應有效');

// 有效 token → 密碼真的被改掉
assert.ok(resetToken);
assert.ok(resetPassword(resetToken!, 'new-password', db3), '有效 token 應重設成功');
const updatedHash = (db3.prepare('SELECT password_hash FROM users WHERE id = ?').get(resetUserId) as { password_hash: string })
  .password_hash;
assert.ok(!verifyPassword('old-password', updatedHash), '重設後舊密碼應失效');
assert.ok(verifyPassword('new-password', updatedHash), '重設後新密碼應生效');

// 同一 token 用過一次後不能再用
assert.ok(!resetPassword(resetToken!, 'another-password', db3), '用過的 token 不應再次成功');

// 過期 token：直接塞一筆過期的 password_resets（沿用 expired-session 測試的手法）
const expiredUserId = createUser('expired-reset@example.com', 'old-password', db3);
db3
  .prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
  .run('expired-reset-row', expiredUserId, createHash('sha256').update('deadbeef').digest('hex'), '2000-01-01T00:00:00.000Z');
assert.ok(!resetPassword('deadbeef', 'whatever123', db3), '過期 token 應重設失敗');

// 重設成功後，重設前建立的 session 應全部失效
assert.strictEqual(getSessionUser(preResetSessionToken, db3), null, '重設密碼後舊 session 應全部失效');

// ── cleanupExpiredSessions ──
import { cleanupExpiredSessions } from './auth';

const db4 = new DatabaseSync(':memory:');
runMigrations(db4);
const u1 = createUser('user1@example.com', 'pass', db4);
const u2 = createUser('user2@example.com', 'pass', db4);

// 建立有效 session
const validToken = createSession(u1, db4);

// 直接插入一個過期 session（模擬未被查詢到的過期 row）
const expiredToken2 = 'expired-token-2';
const expiredAt2 = new Date(Date.now() - 1000).toISOString();
db4.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
  expiredToken2,
  u2,
  expiredAt2,
);

// cleanup 前應有 2 個 session
let count = (db4.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n;
assert.strictEqual(count, 2, 'cleanup 前應有 2 個 session');

// 執行 cleanup
cleanupExpiredSessions(db4);

// cleanup 後應只剩 1 個 session（有效的那個）
count = (db4.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n;
assert.strictEqual(count, 1, 'cleanup 後過期 session 應被刪除');

// 驗證有效 session 保留
assert.strictEqual(getSessionUser(validToken, db4), u1, 'cleanup 後有效 session 應保留');

// 驗證過期 session 已刪除
assert.strictEqual(getSessionUser(expiredToken2, db4), null, 'cleanup 後過期 session 應不存在');

console.log('auth.test.ts OK');
