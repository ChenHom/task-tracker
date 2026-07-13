import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, CommandError, loadEvents } from './eventStore';
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
  ACCESS_ROLE,
} from './member';
import { MAIN_OWNER_EMAIL, MAIN_WORKSPACE_ID } from './mainWorkspacePolicy';

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
assert.ok(hasPermission('Commenter', 'Viewer'));
assert.ok(!hasPermission('Commenter', 'Member'));
assert.ok(hasPermission('Member', 'Commenter'));
assert.deepStrictEqual(ACCESS_ROLE, {
  read: 'Viewer',
  createTask: 'Commenter',
  createComment: 'Commenter',
  mutateOwnComment: 'Commenter',
  mutateTask: 'Member',
  writeProject: 'Member',
  writeAttachment: 'Member',
});

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

// ── removed member 可重新邀請 ──
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('eve', 'eve@x.com', 'Eve', 'x');
const WS_REINVITE = 'ws-reinvite';
seedOwner(WS_REINVITE, 'owner', db);
inviteMember('owner', WS_REINVITE, 'eve', 'Commenter', db);
joinWorkspace('eve', WS_REINVITE, db);
removeMember('owner', WS_REINVITE, 'eve', db);
inviteMember('owner', WS_REINVITE, 'eve', 'Commenter', db);
joinWorkspace('eve', WS_REINVITE, db);
assert.strictEqual(getMemberRole(WS_REINVITE, 'eve', db), 'Commenter');

const commenterTok = createSession('eve', db);
for (const [action, minRole] of [
  ['createTask', ACCESS_ROLE.createTask],
  ['createComment', ACCESS_ROLE.createComment],
  ['mutateOwnComment', ACCESS_ROLE.mutateOwnComment],
] as const) {
  cap = capture();
  assert.strictEqual(
    requirePermission(fakeReq(commenterTok), cap.res, WS_REINVITE, minRole, db),
    'eve',
    `Commenter 應通過 ${action}`,
  );
}
for (const [action, minRole] of [
  ['mutateTask', ACCESS_ROLE.mutateTask],
  ['writeProject', ACCESS_ROLE.writeProject],
  ['writeAttachment', ACCESS_ROLE.writeAttachment],
] as const) {
  cap = capture();
  assert.strictEqual(
    requirePermission(fakeReq(commenterTok), cap.res, WS_REINVITE, minRole, db),
    null,
    `Commenter 不應通過 ${action}`,
  );
  assert.strictEqual(cap.get(), 403, `Commenter 被拒絕 ${action} 應寫 403`);
}

// ── autoAddObserver：user01 建 workspace 時自動把老闆 user09 加成成員 ──
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('main-owner', MAIN_OWNER_EMAIL, '阿哲', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('u09', 'user09@test.local', '老闆', 'x');

const WS_BOSS = 'ws-boss';
seedOwner(WS_BOSS, 'main-owner', db); // user01 建立
autoAddObserver('main-owner', WS_BOSS, db);
assert.strictEqual(getMemberRole(WS_BOSS, 'u09', db), 'Member', 'user01 建立的 workspace 應自動含老闆 user09（Member）');
assert.doesNotThrow(() => autoAddObserver('main-owner', WS_BOSS, db), '重複呼叫應 idempotent（吞已存在的 CommandError）');
assert.strictEqual(getMemberRole(WS_BOSS, 'u09', db), 'Member', '重複呼叫後老闆仍是 Member');

const WS_OTHER = 'ws-other';
seedOwner(WS_OTHER, 'bob', db); // 非 user01 建立
autoAddObserver('bob', WS_OTHER, db);
assert.strictEqual(getMemberRole(WS_OTHER, 'u09', db), null, '非 user01 建立的 workspace 不應自動加老闆');

// ── 主工作區角色由同步流程固定管理 ──
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
  .run('main-user', 'user02@test.local', '小美', 'x');
assert.throws(
  () => inviteMember('main-owner', MAIN_WORKSPACE_ID, 'main-user', 'Member', db),
  /主工作區成員固定為 Commenter/,
);
assert.strictEqual(loadEvents(`${MAIN_WORKSPACE_ID}:main-user`, db).length, 0);
assert.throws(
  () => inviteMember('main-owner', MAIN_WORKSPACE_ID, 'main-owner', 'Commenter', db),
  /主工作區成員固定為 Owner/,
);
assert.strictEqual(loadEvents(`${MAIN_WORKSPACE_ID}:main-owner`, db).length, 0);
seedOwner(MAIN_WORKSPACE_ID, 'main-owner', db);
inviteMember('main-owner', MAIN_WORKSPACE_ID, 'main-user', 'Commenter', db);
joinWorkspace('main-user', MAIN_WORKSPACE_ID, db);
assert.throws(
  () => changeMemberRole('main-owner', MAIN_WORKSPACE_ID, 'main-user', 'Member', db),
  /主工作區成員固定為 Commenter/,
);
assert.throws(
  () => changeMemberRole('main-owner', MAIN_WORKSPACE_ID, 'main-owner', 'Admin', db),
  /不可變更主工作區流程負責人角色/,
);
assert.throws(
  () => removeMember('main-owner', MAIN_WORKSPACE_ID, 'main-user', db),
  /主工作區成員由系統同步/,
);

// 以相鄰 route marker 切段，避免跨 route 的 regex 假綠。
const serverSource = readFileSync(join(__dirname, 'server.ts'), 'utf8');
const routeBlock = (startMarker: string, endMarker: string): string => {
  const start = serverSource.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `找不到 route 起點：${startMarker}`);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `找不到 route 終點：${endMarker}`);
  return serverSource.slice(start, end);
};

const workspacePatchBlock = routeBlock('const patchMatch =', 'const wsMembersMatch =');
const workspaceMembersBlock = routeBlock('const wsMembersMatch =', 'const joinMatch =');
const memberMutationBlock = routeBlock('const memberMatch =', 'const wsTasksMatch =');
const workspaceTasksBlock = routeBlock('const wsTasksMatch =', 'const taskMatch =');
const taskBlock = routeBlock('const taskMatch =', 'const archiveMatch =');
const archiveBlock = routeBlock('const archiveMatch =', 'const wsProjectsMatch =');
const workspaceProjectsBlock = routeBlock('const wsProjectsMatch =', 'const projectMatch =');
const projectBlock = routeBlock('const projectMatch =', 'const taskCommentsMatch =');
const taskCommentsBlock = routeBlock('const taskCommentsMatch =', 'const commentMatch =');
const commentBlock = routeBlock('const commentMatch =', 'const taskAttachMatch =');
const taskAttachmentsBlock = routeBlock('const taskAttachMatch =', 'const attachMatch =');
const attachmentBlock = routeBlock('const attachMatch =', '// ── Search API');
const quotaBlock = routeBlock("if (req.url === '/api/quota' && req.method === 'GET')", "if (req.url === '/api/workspaces')");
const auditBlock = routeBlock('// ── Audit API', 'const filePath =');

assert.match(
  workspaceTasksBlock,
  /if \(req\.method === 'GET'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.read\)/,
  'workspace task GET 應使用 read 權限',
);
assert.match(
  workspaceTasksBlock,
  /if \(req\.method === 'POST'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.createTask\)/,
  'workspace task POST 應使用 createTask 權限',
);
assert.match(
  taskBlock,
  /const taskRole = req\.method === 'GET'\s*\? ACCESS_ROLE\.read\s*:\s*req\.method === 'PATCH'\s*\? taskPatchRole\(body\)\s*:\s*ACCESS_ROLE\.mutateTask;\s*const userId = requirePermission\(req, res, workspaceId, taskRole\)/,
  'single task GET 應 read，PATCH 應依 body 判定，DELETE 應 mutateTask',
);
assert.match(
  taskBlock,
  /if \(req\.method === 'PATCH' && !requireAuth\(req, res\)\) return;\s*const parsed = req\.method === 'PATCH' \? await readJson\(req\)/,
  'single task PATCH 應在讀取 body 前驗證登入',
);
assert.match(archiveBlock, /requirePermission\(req, res, workspaceId, ACCESS_ROLE\.mutateTask\)/, 'archive 應使用 mutateTask 權限');

assert.match(
  workspaceProjectsBlock,
  /if \(req\.method === 'GET'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, (?:ACCESS_ROLE\.read|'Viewer')\)/,
  'project GET 應維持 read 權限',
);
assert.match(
  workspaceProjectsBlock,
  /if \(req\.method === 'POST'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.writeProject\)/,
  'project POST 應使用 writeProject 權限',
);
assert.match(projectBlock, /requirePermission\(req, res, workspaceId, ACCESS_ROLE\.writeProject\)/, 'project PATCH/DELETE 應使用 writeProject 權限');

assert.match(
  taskCommentsBlock,
  /if \(req\.method === 'GET'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.read\)/,
  'comment GET 應使用 read 權限',
);
assert.match(
  taskCommentsBlock,
  /if \(req\.method === 'POST'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.createComment\)/,
  'comment POST 應使用 createComment 權限',
);
assert.match(commentBlock, /requirePermission\(req, res, ctx\.workspace_id, ACCESS_ROLE\.mutateOwnComment\)/, 'comment PATCH/DELETE 應使用 mutateOwnComment 權限');
assert.ok(
  commentBlock.indexOf('if (ctx.user_id !== userId)') > commentBlock.indexOf('ACCESS_ROLE.mutateOwnComment'),
  'comment ownership check 應保留在角色檢查之後',
);

assert.match(
  taskAttachmentsBlock,
  /if \(req\.method === 'GET'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.read\)/,
  'task attachment GET 應使用 read 權限',
);
assert.match(
  taskAttachmentsBlock,
  /if \(req\.method === 'POST'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, ACCESS_ROLE\.writeAttachment\)/,
  'task attachment POST 應使用 writeAttachment 權限',
);
assert.match(
  attachmentBlock,
  /if \(req\.method === 'GET'\)\s*{\s*const userId = requirePermission\(req, res, ctx\.workspace_id, ACCESS_ROLE\.read\)/,
  'single attachment GET 應使用 read 權限',
);
assert.match(attachmentBlock, /requirePermission\(req, res, ctx\.workspace_id, ACCESS_ROLE\.writeAttachment\)/, 'attachment DELETE 應使用 writeAttachment 權限');
assert.match(quotaBlock, /const userId = requireAuth\(req, res\)/, 'quota API 應要求登入');

assert.match(workspacePatchBlock, /requirePermission\(req, res, workspaceId, 'Admin'\)/, 'workspace rename 仍需 Admin');
assert.match(
  workspaceMembersBlock,
  /if \(req\.method === 'POST'\)\s*{\s*const userId = requirePermission\(req, res, workspaceId, 'Admin'\)/,
  'member invite 仍需 Admin',
);
assert.match(memberMutationBlock, /requirePermission\(req, res, workspaceId, 'Admin'\)/, 'member PATCH/DELETE 仍需 Admin');
assert.match(auditBlock, /requirePermission\(req, res, workspaceId, 'Admin'\)/, 'audit 仍需 Admin');

console.log('member.test.ts OK');
