import assert from 'node:assert';
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

console.log('auth.test.ts OK');
