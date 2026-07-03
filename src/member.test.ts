import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, CommandError } from './eventStore';
import { createSession } from './auth';
import {
  inviteMember,
  joinWorkspace,
  changeMemberRole,
  removeMember,
  seedOwner,
  getMemberRole,
  hasPermission,
  requirePermission,
  registerMemberProjections,
} from './member';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerMemberProjections();
// requirePermission 會查 session → 需要 users/sessions 有資料
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run('owner', 'o@x.com', 'x');
db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run('bob', 'b@x.com', 'x');

const WS = 'ws-1';

// ── 角色階層 ──
assert.ok(hasPermission('Owner', 'Admin'), 'Owner 應 >= Admin');
assert.ok(hasPermission('Admin', 'Admin'), '同級應通過');
assert.ok(!hasPermission('Member', 'Admin'), 'Member 應 < Admin');
assert.ok(!hasPermission('Viewer', 'Member'), 'Viewer 應 < Member');

// ── seedOwner：invited + joined → read model 有 Owner ──
seedOwner(WS, 'owner', db);
assert.strictEqual(getMemberRole(WS, 'owner', db), 'Owner', 'seedOwner 後應為 Owner');

// ── 生命週期：invite（未 joined 不進 read model）→ join → role_changed → removed ──
inviteMember('owner', WS, 'bob', 'Member', db);
assert.strictEqual(getMemberRole(WS, 'bob', db), null, 'invited 未 joined → 尚無權限紀錄');

joinWorkspace('bob', WS, db);
assert.strictEqual(getMemberRole(WS, 'bob', db), 'Member', 'joined 後 read model 應有 Member');

changeMemberRole('owner', WS, 'bob', 'Admin', db);
assert.strictEqual(getMemberRole(WS, 'bob', db), 'Admin', 'role_changed 後應為 Admin');

removeMember('owner', WS, 'bob', db);
assert.strictEqual(getMemberRole(WS, 'bob', db), null, 'removed 後應從 read model 消失');

// ── 狀態機非法轉換 ──
assert.throws(() => joinWorkspace('bob', WS, db), CommandError, '沒有邀請不能 join');
assert.throws(() => inviteMember('owner', WS, 'owner', 'Admin', db), CommandError, '已是成員不能重複邀請');
assert.throws(() => changeMemberRole('owner', WS, 'bob', 'Owner', db), CommandError, '非 active 成員不能改角色');
assert.throws(() => inviteMember('owner', WS, 'bob', 'Superuser', db), CommandError, '不合法 role 應拒絕');

// ── requirePermission middleware ──
const fakeReq = (token?: string): any => ({ headers: token ? { cookie: `session=${token}` } : {} });
const capture = () => {
  let status = 0;
  const res: any = { writeHead: (s: number) => { status = s; }, end: () => {} };
  return { res, get: () => status };
};

const ownerTok = createSession('owner', db);
// owner 對自己的 workspace 有 Owner 權限，通過 Admin 門檻
let cap = capture();
assert.strictEqual(requirePermission(fakeReq(ownerTok), cap.res, WS, 'Admin', db), 'owner', 'Owner 應通過 Admin 檢查');

// 未登入 → 401
cap = capture();
assert.strictEqual(requirePermission(fakeReq(), cap.res, WS, 'Viewer', db), null, '未登入應回 null');
assert.strictEqual(cap.get(), 401, '未登入應寫 401');

// 已登入但非該 workspace 成員 → 403（bob 已被移除）
const bobTok = createSession('bob', db);
cap = capture();
assert.strictEqual(requirePermission(fakeReq(bobTok), cap.res, WS, 'Viewer', db), null, '非成員應回 null');
assert.strictEqual(cap.get(), 403, '非成員應寫 403');

// 跨 workspace：owner 是 ws-1 的 Owner，但對 ws-2 沒有任何角色 → 403
cap = capture();
assert.strictEqual(requirePermission(fakeReq(ownerTok), cap.res, 'ws-2', 'Viewer', db), null, '跨 workspace 應回 null');
assert.strictEqual(cap.get(), 403, '跨 workspace 應寫 403');

console.log('member.test.ts OK');
