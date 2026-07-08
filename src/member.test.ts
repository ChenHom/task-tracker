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
  countActiveMembers,
  listMembers,
  autoAddObserver,
} from './member';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerMemberProjections();
// requirePermission 會查 session → 需要 users/sessions 有資料
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('owner', 'o@x.com', 'Owner', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('bob', 'b@x.com', 'Bob', 'x');

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

// ── Phase 10：權限升級 + 最後一個 Owner 防呆 ─────────────────────────
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('carol', 'c@x.com', 'Carol', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('dave', 'd@x.com', 'Dave', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('erin', 'e@x.com', 'Erin', 'x');

const WS2 = 'ws-2b';
seedOwner(WS2, 'owner', db);
assert.strictEqual(countActiveMembers(WS2, db), 1, 'countActiveMembers：剛建立只有 Owner 一人');

inviteMember('owner', WS2, 'carol', 'Admin', db);
joinWorkspace('carol', WS2, db);
assert.strictEqual(countActiveMembers(WS2, db), 2, 'countActiveMembers：Owner + Admin 共兩人');

// Admin 邀一般角色沒問題，但不能邀/任命 Owner（權限升級防呆）。
inviteMember('carol', WS2, 'dave', 'Member', db);
joinWorkspace('dave', WS2, db);
assert.strictEqual(countActiveMembers(WS2, db), 3, 'countActiveMembers：三人');
assert.throws(() => inviteMember('carol', WS2, 'erin', 'Owner', db), CommandError, 'Admin 不能邀請新成員為 Owner');
assert.throws(() => changeMemberRole('carol', WS2, 'dave', 'Owner', db), CommandError, 'Admin 不能任命 Owner（changeMemberRole）');

// Admin 不能動既有 Owner 的角色，也不能移除 Owner。
assert.throws(() => changeMemberRole('carol', WS2, 'owner', 'Admin', db), CommandError, 'Admin 不能改 Owner 的角色');
assert.throws(() => removeMember('carol', WS2, 'owner', db), CommandError, 'Admin 不能移除 Owner');

// Owner 自我降級/自我移除：還有其他成員時擋（避免出現「有成員但沒有 Owner」）。
assert.throws(() => changeMemberRole('owner', WS2, 'owner', 'Admin', db), CommandError, '還有其他成員時 Owner 不能自我降級');
assert.throws(() => removeMember('owner', WS2, 'owner', db), CommandError, '還有其他成員時 Owner 不能自我移除');

// listMembers：含 email，筆數符合目前 active 成員。
const rows = listMembers(WS2, db);
assert.strictEqual(rows.length, 3, 'listMembers 應列出目前所有 active 成員');
assert.ok(rows.some((r) => r.user_id === 'carol' && r.email === 'c@x.com' && r.role === 'Admin'), 'listMembers 應含 email 與角色');

// 清空其他成員，只剩 Owner 一人 → 才能自我降級。
removeMember('owner', WS2, 'carol', db);
removeMember('owner', WS2, 'dave', db);
assert.strictEqual(countActiveMembers(WS2, db), 1, '清空後只剩 Owner 一人');
changeMemberRole('owner', WS2, 'owner', 'Admin', db); // 唯一成員時允許自我降級
assert.strictEqual(getMemberRole(WS2, 'owner', db), 'Admin', '唯一成員時應允許 Owner 自我降級');

// 另開一個 workspace 驗證「唯一成員時允許 Owner 自我移除（離開）」。
const WS3 = 'ws-3b';
seedOwner(WS3, 'owner', db);
removeMember('owner', WS3, 'owner', db);
assert.strictEqual(getMemberRole(WS3, 'owner', db), null, '唯一成員時應允許 Owner 自我移除');
assert.strictEqual(countActiveMembers(WS3, db), 0, '移除後 active 成員數為 0');

// ── autoAddObserver：user01 建 workspace 時自動把老闆 user09 加成成員 ──
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('u01', 'user01@test.local', '阿哲', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('u09', 'user09@test.local', '老闆', 'x');

const WS_BOSS = 'ws-boss';
seedOwner(WS_BOSS, 'u01', db); // user01 建立
autoAddObserver('u01', WS_BOSS, db);
assert.strictEqual(getMemberRole(WS_BOSS, 'u09', db), 'Member', 'user01 建立的 workspace 應自動含老闆 user09（Member）');
assert.doesNotThrow(() => autoAddObserver('u01', WS_BOSS, db), '重複呼叫應 idempotent（吞已存在的 CommandError）');
assert.strictEqual(getMemberRole(WS_BOSS, 'u09', db), 'Member', '重複呼叫後老闆仍是 Member');

const WS_OTHER = 'ws-other';
seedOwner(WS_OTHER, 'bob', db); // 非 user01 建立
autoAddObserver('bob', WS_OTHER, db);
assert.strictEqual(getMemberRole(WS_OTHER, 'u09', db), null, '非 user01 建立的 workspace 不應自動加老闆');

console.log('member.test.ts OK');
