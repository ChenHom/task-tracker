import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { appendEvent, resetProjections, loadEvents, CommandError } from './eventStore';
import { createComment } from './comment';
import { MAIN_OWNER_EMAIL, MAIN_POLICY_TITLE, MAIN_WORKSPACE_ID } from './mainWorkspacePolicy';
import {
  createTask,
  changeTaskTitle,
  changeTaskStatus,
  changeTaskPriority,
  changeTaskAssignee,
  changeTaskDueDate,
  changeTaskDescription,
  archiveTask,
  deleteTask,
  applyTaskPatch,
  listTasks,
  getTask,
  getTaskWorkspaceId,
  moveTask,
  normalizeMainDiscussion,
  registerTaskProjections,
} from './task';
import { getMemberRole, getMembershipStatus, inviteMember, joinWorkspace, registerMemberProjections } from './member';

const OWNER_THOUGHT = `【OWNER想法】
現況／問題：流程沒有收斂點
預期價值：讓討論能準時結束
風險與反對理由：可能壓縮複雜議題
現行可替代方案：人工提醒
初步判斷：先採固定窗口
希望成員確認的問題：兩天是否足夠`;
const TWO_DAY_REQUEST = `【全員回覆：2天】
請補充或表示已閱讀。`;

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerTaskProjections();
registerMemberProjections();

const WS = 'ws-1';
const COMMENTER_WS = 'ws-commenter';
const MOVE_SOURCE_WS = 'ws-move-source';
const MOVE_TARGET_WS = 'ws-move-target';
const MOVE_ARCHIVED_WS = 'ws-move-archived';
// createTask 會檢查 workspace 生命週期 → 需要 workspaces_read_model 有 active 的 fixture。
const seedWs = (id: string, status = 'active') =>
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)').run(id, id, status, 't');
seedWs(WS);
seedWs('ws-other');
seedWs(COMMENTER_WS);
seedWs(MOVE_SOURCE_WS);
seedWs(MOVE_TARGET_WS);
seedWs(MOVE_ARCHIVED_WS, 'archived');
seedWs(MAIN_WORKSPACE_ID);
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('main-owner', MAIN_OWNER_EMAIL, 'Main Owner', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('main-user', 'user02@test.local', 'Main User', 'x');
for (const [id, email, name] of [
  ['u1', 'u1@test.local', 'User One'],
  ['bob', 'bob@test.local', 'Bob'],
  ['carol', 'carol@test.local', 'Carol'],
  ['mover', 'mover@test.local', 'Mover'],
  ['target-only', 'target-only@test.local', 'Target Only'],
  ['invite-assignee', 'invite-assignee@test.local', 'Invite Assignee'],
  ['pending-assignee', 'pending-assignee@test.local', 'Pending Assignee'],
] as const) {
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(id, email, name, 'x');
}
const insertMember = db.prepare(
  'INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
);
insertMember.run(MAIN_WORKSPACE_ID, 'main-owner', 'Owner', 't');
insertMember.run(MAIN_WORKSPACE_ID, 'main-user', 'Commenter', 't');
for (const userId of ['u1', 'bob', 'carol']) insertMember.run(WS, userId, 'Member', 't');
insertMember.run(COMMENTER_WS, 'main-user', 'Commenter', 't');
insertMember.run(MOVE_SOURCE_WS, 'mover', 'Member', 't');
for (const userId of ['invite-assignee', 'pending-assignee']) insertMember.run(MOVE_SOURCE_WS, userId, 'Member', 't');
insertMember.run(MOVE_TARGET_WS, 'mover', 'Member', 't');
insertMember.run(MOVE_TARGET_WS, 'target-only', 'Member', 't');
insertMember.run(MOVE_ARCHIVED_WS, 'mover', 'Member', 't');
insertMember.run(COMMENTER_WS, 'other-commenter', 'Commenter', 't');
const one = (id: string) => listTasks(WS, db).find((t) => t.task_id === id)!;

// ── create → read model 全欄位 + 預設值 ──
const id = createTask('u1', WS, { title: '  Ship it  ' }, db);
let t = one(id);
assert.strictEqual(t.title, 'Ship it', 'title 應 trim');
assert.strictEqual(t.status, 'Todo', '初始狀態 Todo');
assert.strictEqual(t.priority, 'Medium', 'priority 預設 Medium');
assert.strictEqual(t.description, '', 'description 預設空字串');
assert.strictEqual(t.assignee_id, null, 'assignee 預設 null');
assert.strictEqual(t.due_at, null, 'due 預設 null');
assert.strictEqual(t.workspace_id, WS);
assert.strictEqual(t.version, 1, 'created → version 1');
assert.strictEqual(getTaskWorkspaceId(id, db), WS, 'getTaskWorkspaceId 回歸屬 workspace');

// ── assignee membership 與 Todo → Doing 守門 ──
assert.throws(
  () => createTask('u1', WS, { title: 'Unknown assignee', assignee: 'not-a-member' }, db),
  /assignee 必須是 workspace active member/,
);
const unassignedDoingId = createTask('u1', WS, { title: 'Needs assignment' }, db);
assert.throws(
  () => changeTaskStatus('u1', unassignedDoingId, 'Doing', db),
  /Todo → Doing 必須先指派 active workspace member/,
);
changeTaskAssignee('u1', unassignedDoingId, 'u1', db);
changeTaskStatus('u1', unassignedDoingId, 'Doing', db);
assert.strictEqual(one(unassignedDoingId).status, 'Doing');
const invalidPatchAssigneeId = createTask('u1', WS, { title: 'Invalid patch assignee' }, db);
assert.throws(
  () => changeTaskAssignee('u1', invalidPatchAssigneeId, 'not-a-member', db),
  /assignee 必須是 workspace active member/,
);

// ── create 帶完整欄位 ──
const id2 = createTask('u1', WS, { title: 'Full', description: 'desc', priority: 'High', assignee: 'bob', dueAt: '2026-08-01' }, db);
t = one(id2);
assert.strictEqual(t.priority, 'High');
assert.strictEqual(t.assignee_id, 'bob');
assert.strictEqual(t.due_at, new Date('2026-08-01').toISOString(), 'due_at 正規化成 ISO');

// ── 狀態機：合法前進 Todo → Doing → Review → Done ──
changeTaskAssignee('u1', id, 'u1', db);
changeTaskStatus('u1', id, 'Doing', db);
assert.strictEqual(one(id).status, 'Doing');
changeTaskStatus('u1', id, 'Review', db);
changeTaskStatus('u1', id, 'Done', db);
assert.strictEqual(one(id).status, 'Done');
assert.strictEqual(one(id).version, 5, 'created + assignee + 3 status_changed → version 5');

// ── 狀態機：合法回退 Done → Review → Doing → Todo ──
changeTaskStatus('u1', id, 'Review', db);
changeTaskStatus('u1', id, 'Doing', db);
changeTaskStatus('u1', id, 'Todo', db);
assert.strictEqual(one(id).status, 'Todo', '可一路回退到 Todo');

// ── 狀態機：非法轉換（跳階 / 不相鄰）──
assert.throws(() => changeTaskStatus('u1', id, 'Done', db), CommandError, 'Todo → Done 跳階應拒');
assert.throws(() => changeTaskStatus('u1', id, 'Review', db), CommandError, 'Todo → Review 跳階應拒');
assert.throws(() => changeTaskStatus('u1', id, 'Archived', db), CommandError, 'status_changed 不能設 Archived');
assert.throws(() => changeTaskStatus('u1', id, 'Nope', db), CommandError, '未知狀態應拒');

// ── 欄位變更 projection ──
changeTaskTitle('u1', id, 'Renamed', db);
assert.strictEqual(one(id).title, 'Renamed');
changeTaskDescription('u1', id, 'hello', db);
assert.strictEqual(one(id).description, 'hello');
changeTaskPriority('u1', id, 'Low', db);
assert.strictEqual(one(id).priority, 'Low');
changeTaskAssignee('u1', id, 'carol', db);
assert.strictEqual(one(id).assignee_id, 'carol');
changeTaskAssignee('u1', id, null, db);
assert.strictEqual(one(id).assignee_id, null, 'assignee 可設回 null');
changeTaskDueDate('u1', id, '2026-09-15', db);
assert.strictEqual(one(id).due_at, new Date('2026-09-15').toISOString());

// ── 輸入驗證 ──
assert.throws(() => createTask('u1', WS, { title: '' }, db), CommandError, '空 title 應拒');
assert.throws(() => createTask('u1', WS, { title: 'x', priority: 'Urgent' }, db), CommandError, '非法 priority 應拒');
assert.throws(() => createTask('u1', WS, { title: 'x', dueAt: 'not-a-date' }, db), CommandError, '非法 dueAt 應拒');
assert.throws(() => createTask('u1', WS, {}, db), CommandError, '缺 title 應拒');
assert.throws(() => createTask('u1', WS, { title: 'x', status: 'Doing' }, db), CommandError, '非 Todo 初始 status 應拒');
const explicitTodoId = createTask('u1', WS, { title: 'Explicit todo', status: 'Todo' }, db);
assert.strictEqual(one(explicitTodoId).status, 'Todo', 'status: Todo 應允許並建立 Todo');

// ── workspace 生命週期 gate：archived / 不存在的 workspace 不可建 task（防孤兒資料）──
seedWs('ws-arch', 'archived');
assert.throws(() => createTask('u1', 'ws-arch', { title: 'x' }, db), CommandError, 'archived workspace 不可建 task');
assert.throws(() => createTask('u1', 'ws-missing', { title: 'x' }, db), CommandError, '不存在的 workspace 不可建 task');

// ── 已存在 task 若其 workspace 後來 archived，patch / archive / delete 都應被凍結 ──
seedWs('ws-frozen');
const frozenId = createTask('u1', 'ws-frozen', { title: 'freeze me' }, db);
db.prepare('UPDATE workspaces_read_model SET status = ? WHERE workspace_id = ?').run('archived', 'ws-frozen');
assert.throws(() => applyTaskPatch('u1', frozenId, { title: 'still editable?' }, db), CommandError, 'archived workspace 下 patch task 應拒');
assert.throws(() => archiveTask('u1', frozenId, db), CommandError, 'archived workspace 下 archive task 應拒');
assert.throws(() => deleteTask('u1', frozenId, db), CommandError, 'archived workspace 下 delete task 應拒');

// ── archive：active → Archived，之後唯讀 ──
archiveTask('u1', id, db);
assert.strictEqual(one(id).status, 'Archived');
assert.throws(() => changeTaskTitle('u1', id, 'x', db), CommandError, 'archived 不可改欄位');
assert.throws(() => changeTaskStatus('u1', id, 'Doing', db), CommandError, 'archived 不可改狀態');
assert.throws(() => archiveTask('u1', id, db), CommandError, '重複 archive 應拒');

// ── delete：archived 可刪；deleted 從 read model 消失、終態 ──
deleteTask('u1', id, db);
assert.strictEqual(listTasks(WS, db).find((x) => x.task_id === id), undefined, 'deleted 從 read model 移除');
assert.strictEqual(getTaskWorkspaceId(id, db), null, 'deleted task 的 workspace 查不到（→ 404）');
assert.throws(() => deleteTask('u1', id, db), CommandError, '重複 delete 應拒');
assert.throws(() => changeTaskTitle('u1', id, 'x', db), CommandError, 'deleted 不可改');

// ── applyTaskPatch：單欄位 OK、零/多欄位拒 ──
assert.throws(() => applyTaskPatch('u1', id2, {}, db), CommandError, '零欄位 patch 應拒');
assert.throws(() => applyTaskPatch('u1', id2, { title: 'a', priority: 'Low' }, db), CommandError, '多欄位 patch 應拒');
applyTaskPatch('u1', id2, { title: 'Patched' }, db);
assert.strictEqual(one(id2).title, 'Patched', '單欄位 patch 生效');

// ── 事件流：9 種事件都能 append，版本連續 ──
const evs = loadEvents(id, db);
assert.strictEqual(evs[0].event_type, 'task.created');
// 直接呼叫 command（無 HTTP context）→ metadata 只有 actor_id，ip/ua/request_id 為 null
assert.deepStrictEqual(evs[0].metadata, { actor_id: 'u1', ip: null, user_agent: null, request_id: null }, 'metadata 記 actor + audit 欄位');
assert.deepStrictEqual(evs.map((e) => e.aggregate_version), evs.map((_, i) => i + 1), '版本連續遞增');

// ── listTasks 只回該 workspace ──
createTask('u1', 'ws-other', { title: 'elsewhere' }, db);
assert.ok(listTasks(WS, db).every((x) => x.workspace_id === WS), 'listTasks 只回指定 workspace');

// ── getTask：單一 task 查詢 ──
const t3 = getTask(id2, db);
assert.ok(t3, 'getTask 返回存在的 task');
assert.strictEqual(t3?.task_id, id2);
assert.strictEqual(t3?.title, 'Patched', 'getTask 返回最新資料');
assert.strictEqual(getTask('nonexistent', db), null, 'getTask 不存在的 id 返回 null');

// ── moveTask：成功搬移會更新 workspace_id、清空 project_id，且 route 之後會跟著新 workspace 走 ──
const moveId = createTask('mover', MOVE_SOURCE_WS, { title: 'Move me', projectId: 'proj-1' }, db);
const moveResult = moveTask('mover', moveId, MOVE_TARGET_WS, db);
assert.deepStrictEqual(moveResult, { invitedAssignee: false });
assert.deepStrictEqual(
  {
    workspaceId: getTask(moveId, db)?.workspace_id,
    projectId: getTask(moveId, db)?.project_id,
    taskWorkspaceId: getTaskWorkspaceId(moveId, db),
  },
  {
    workspaceId: MOVE_TARGET_WS,
    projectId: null,
    taskWorkspaceId: MOVE_TARGET_WS,
  },
);
assert.strictEqual(loadEvents(moveId, db).at(-1)?.event_type, 'task.moved');
assert.deepStrictEqual(loadEvents(moveId, db).at(-1)?.payload, {
  fromWorkspaceId: MOVE_SOURCE_WS,
  toWorkspaceId: MOVE_TARGET_WS,
});

const noSourceRoleTaskId = createTask('mover', MOVE_SOURCE_WS, { title: 'No source role' }, db);
assert.throws(
  () => moveTask('target-only', noSourceRoleTaskId, MOVE_TARGET_WS, db),
  { name: 'CommandError', message: '來源 workspace 權限不足' },
);

const archivedTargetTaskId = createTask('mover', MOVE_SOURCE_WS, { title: 'Archived target' }, db);
assert.throws(
  () => moveTask('mover', archivedTargetTaskId, MOVE_ARCHIVED_WS, db),
  { name: 'CommandError', message: 'workspace 目前為 archived，不可搬入 task' },
);

const archivedMoveTaskId = createTask('mover', MOVE_SOURCE_WS, { title: 'Archived task cannot move' }, db);
archiveTask('mover', archivedMoveTaskId, db);
assert.throws(
  () => moveTask('mover', archivedMoveTaskId, MOVE_TARGET_WS, db),
  { name: 'CommandError', message: 'task 已歸檔，不可修改' },
);

const inviteAssigneeTaskId = createTask('mover', MOVE_SOURCE_WS, { title: 'Invite assignee', assignee: 'invite-assignee' }, db);
const inviteResult = moveTask('mover', inviteAssigneeTaskId, MOVE_TARGET_WS, db);
assert.deepStrictEqual(inviteResult, { invitedAssignee: true });
assert.strictEqual(getMembershipStatus(MOVE_TARGET_WS, 'invite-assignee', db), 'invited', 'assignee 應被顯式邀請到目標 workspace');
assert.strictEqual(getMemberRole(MOVE_TARGET_WS, 'invite-assignee', db), null, 'assignee 不可被隱式加入 read model');

inviteMember('mover', MOVE_TARGET_WS, 'pending-assignee', 'Member', db);
const pendingInviteEventsBefore = loadEvents(`${MOVE_TARGET_WS}:pending-assignee`, db).length;
const pendingInviteTaskId = createTask('mover', MOVE_SOURCE_WS, { title: 'Pending invite reuse', assignee: 'pending-assignee' }, db);
const pendingInviteResult = moveTask('mover', pendingInviteTaskId, MOVE_TARGET_WS, db);
assert.deepStrictEqual(pendingInviteResult, { invitedAssignee: true });
assert.strictEqual(loadEvents(`${MOVE_TARGET_WS}:pending-assignee`, db).length, pendingInviteEventsBefore, '既有 pending invite 不應重複追加事件');
assert.strictEqual(getMembershipStatus(MOVE_TARGET_WS, 'pending-assignee', db), 'invited');
assert.throws(
  () => changeTaskStatus('mover', pendingInviteTaskId, 'Doing', db),
  /assignee 必須是 workspace active member/,
);
joinWorkspace('pending-assignee', MOVE_TARGET_WS, db);
changeTaskStatus('mover', pendingInviteTaskId, 'Doing', db);
assert.strictEqual(getTask(pendingInviteTaskId, db)?.status, 'Doing');

// ── Commenter 建立 task 只能送 title / description，規則適用所有 workspace ──
assert.throws(
  () => createTask('main-user', MAIN_WORKSPACE_ID, { title: '方向', priority: 'High' }, db),
  { name: 'CommandError', message: 'Commenter 建立 task 只能提交 title 與 description' },
);
for (const field of ['status', 'priority', 'assignee', 'assigneeId', 'projectId', 'dueAt'] as const) {
  const input = { title: `forbidden ${field}`, [field]: null };
  assert.throws(
    () => createTask('main-user', COMMENTER_WS, input, db),
    { name: 'CommandError', message: 'Commenter 建立 task 只能提交 title 與 description' },
    `Commenter input 即使 ${field} 為 null 也應拒絕`,
  );
}
const unexpectedInput = { title: 'unexpected field', unexpected: null };
assert.throws(
  () => createTask('main-user', COMMENTER_WS, unexpectedInput, db),
  { name: 'CommandError', message: 'Commenter 建立 task 只能提交 title 與 description' },
);
const commenterTaskId = createTask('main-user', COMMENTER_WS, { title: '一般方向', description: '一般討論' }, db);
assert.strictEqual(getTask(commenterTaskId, db)?.title, '一般方向', '一般 workspace 不加討論 prefix');
assert.strictEqual(getTask(commenterTaskId, db)?.creator_id, 'main-user');
changeTaskDescription('main-user', commenterTaskId, '本人更新', db);
assert.strictEqual(getTask(commenterTaskId, db)?.description, '本人更新');
assert.throws(
  () => changeTaskDescription('other-commenter', commenterTaskId, '他人更新', db),
  { name: 'CommandError', message: 'Commenter 只能修改自己建立 task 的描述' },
);

const legacyCommenterTaskId = 'legacy-commenter-task';
appendEvent(
  'Task',
  legacyCommenterTaskId,
  0,
  'task.created',
  {
    workspaceId: COMMENTER_WS,
    projectId: null,
    title: '歷史 task',
    description: '舊描述',
    status: 'Todo',
    priority: 'Medium',
    assigneeId: null,
    dueAt: null,
  },
  {},
  db,
);
assert.strictEqual(getTask(legacyCommenterTaskId, db)?.creator_id, null);
assert.throws(
  () => changeTaskDescription('main-user', legacyCommenterTaskId, '新描述', db),
  { name: 'CommandError', message: 'Commenter 只能修改自己建立 task 的描述' },
);

// ── 主工作區建立規則：唯一 policy + 其餘固定為 Todo 討論 ──
assert.throws(
  () => createTask('main-user', MAIN_WORKSPACE_ID, { title: MAIN_POLICY_TITLE }, db),
  { name: 'CommandError', message: '只有 user01 可以建立主工作區規則 task' },
);
const discussionId = createTask('main-user', MAIN_WORKSPACE_ID, { title: '方向', description: '討論內容' }, db);
assert.deepStrictEqual(
  (() => {
    const row = getTask(discussionId, db)!;
    return {
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assigneeId: row.assignee_id,
      projectId: row.project_id,
      dueAt: row.due_at,
    };
  })(),
  {
    title: '[討論] 方向',
    description: '討論內容',
    status: 'Todo',
    priority: 'Medium',
    assigneeId: null,
    projectId: null,
    dueAt: null,
  },
);
const prefixedId = createTask('main-user', MAIN_WORKSPACE_ID, { title: '[討論] 已有前綴' }, db);
assert.strictEqual(getTask(prefixedId, db)?.title, '[討論] 已有前綴', '不得重複加討論 prefix');
assert.throws(
  () => createTask('main-user', MAIN_WORKSPACE_ID, { title: 'x'.repeat(200) }, db),
  /title 過長/,
  '加上討論 prefix 後 title 仍不可超過 200 字',
);

const policyId = createTask('main-owner', MAIN_WORKSPACE_ID, { title: MAIN_POLICY_TITLE }, db);
assert.strictEqual(getTask(policyId, db)?.title, MAIN_POLICY_TITLE);
assert.throws(
  () => createTask('main-owner', MAIN_WORKSPACE_ID, { title: MAIN_POLICY_TITLE }, db),
  { name: 'CommandError', message: '主工作區規則 task 已存在' },
);

// ── normalize 權限與適用範圍 ──
assert.throws(
  () => normalizeMainDiscussion('main-user', discussionId, db),
  { name: 'CommandError', message: '只有 user01 可以正規化主工作區 task' },
);
assert.throws(
  () => normalizeMainDiscussion('main-owner', commenterTaskId, db),
  { name: 'CommandError', message: '不是可正規化的主工作區 task' },
);
assert.throws(
  () => normalizeMainDiscussion('main-owner', policyId, db),
  { name: 'CommandError', message: '不是可正規化的主工作區 task' },
);
const archivedDiscussionId = createTask('main-user', MAIN_WORKSPACE_ID, { title: '已歸檔討論' }, db);
const beforeArchiveEventCount = loadEvents(archivedDiscussionId, db).length;
assert.throws(
  () => archiveTask('main-user', archivedDiscussionId, db),
  { name: 'CommandError', message: '只有 user01 可以改變主工作區 task 狀態' },
);
assert.strictEqual(getTask(archivedDiscussionId, db)?.status, 'Todo', '非 owner 不得 archive 主工作區 task');
assert.strictEqual(loadEvents(archivedDiscussionId, db).length, beforeArchiveEventCount, '拒絕 archive 時不可追加 event');
db.prepare('UPDATE users SET email = ? WHERE id = ?').run('former-main-owner@test.local', 'main-owner');
assert.throws(
  () => archiveTask('main-owner', archivedDiscussionId, db),
  { name: 'CommandError', message: '只有 user01 可以改變主工作區 task 狀態' },
);
assert.strictEqual(loadEvents(archivedDiscussionId, db).length, beforeArchiveEventCount, '找不到 runtime owner 時應 fail closed');
db.prepare('UPDATE users SET email = ? WHERE id = ?').run(MAIN_OWNER_EMAIL, 'main-owner');
archiveTask('main-owner', archivedDiscussionId, db);
assert.strictEqual(getTask(archivedDiscussionId, db)?.status, 'Archived');
assert.throws(
  () => normalizeMainDiscussion('main-owner', archivedDiscussionId, db),
  { name: 'CommandError', message: '不是可正規化的主工作區 task' },
);

// ── 主工作區 policy title 固定；一般 task rename 維持討論 prefix ──
assert.throws(
  () => changeTaskTitle('main-owner', discussionId, MAIN_POLICY_TITLE, db),
  /規則 task/,
);
assert.strictEqual(
  listTasks(MAIN_WORKSPACE_ID, db).filter((task) => task.title === MAIN_POLICY_TITLE && task.status !== 'Archived').length,
  1,
  'active policy 仍只能有一筆',
);
assert.throws(
  () => changeTaskTitle('main-owner', policyId, '其他名稱', db),
  /主工作區規則 task 標題固定/,
);
changeTaskTitle('main-owner', discussionId, '新方向', db);
assert.strictEqual(getTask(discussionId, db)?.title, '[討論] 新方向');
changeTaskTitle('main-owner', discussionId, '[討論] 已改方向', db);
assert.strictEqual(getTask(discussionId, db)?.title, '[討論] 已改方向', 'rename 不重複加討論 prefix');
assert.throws(
  () => changeTaskTitle('main-owner', discussionId, 'x'.repeat(200), db),
  /title 過長/,
  'rename 加上討論 prefix 後 title 仍不可超過 200 字',
);

// ── Commenter 不得從 prototype / non-enumerable forbidden fields 帶入初始值 ──
const inheritedCommenterInput = Object.create({
  priority: 'High',
  assignee: 'bad',
  projectId: 'bad',
  dueAt: '2027-01-01',
});
inheritedCommenterInput.title = 'inherited defaults';
inheritedCommenterInput.description = 'safe';
const inheritedCommenterTaskId = createTask('main-user', COMMENTER_WS, inheritedCommenterInput, db);
const inheritedCommenterTask = getTask(inheritedCommenterTaskId, db)!;
assert.deepStrictEqual(
  {
    priority: inheritedCommenterTask.priority,
    assigneeId: inheritedCommenterTask.assignee_id,
    projectId: inheritedCommenterTask.project_id,
    dueAt: inheritedCommenterTask.due_at,
  },
  { priority: 'Medium', assigneeId: null, projectId: null, dueAt: null },
);

// ── 主討論只允許 OWNER 在期限與雙方證據完成後 Todo → Done ──
assert.throws(
  () => changeTaskStatus('main-user', discussionId, 'Doing', db),
  { name: 'CommandError', message: '只有 user01 可以改變主工作區 task 狀態' },
);
assert.throws(
  () => changeTaskStatus('main-owner', discussionId, 'Doing', db),
  { name: 'CommandError', message: /主工作區討論只允許 Todo/ },
);
assert.throws(
  () => changeTaskStatus('main-owner', discussionId, 'Review', db),
  { name: 'CommandError', message: /主工作區討論只允許 Todo/ },
);
const beforeDiscussionEvidence = loadEvents(discussionId, db).length;
assert.throws(
  () => changeTaskStatus('main-owner', discussionId, 'Done', db, new Date('2026-07-15T08:00:00.000Z')),
  { name: 'CommandError', message: /主工作區討論尚未開啟回覆窗口/ },
);
assert.strictEqual(loadEvents(discussionId, db).length, beforeDiscussionEvidence, '缺少窗口時不可追加 event');

createComment(discussionId, 'main-owner', OWNER_THOUGHT, db, new Date('2026-07-14T08:00:00.000Z'));
createComment(discussionId, 'main-owner', TWO_DAY_REQUEST, db, new Date('2026-07-14T08:00:00.000Z'));
createComment(discussionId, 'main-owner', '【結論】\n採用。', db, new Date('2026-07-14T08:00:00.000Z'));
createComment(discussionId, 'main-user', '【確認結論】同意。', db, new Date('2026-07-14T08:00:00.000Z'));
createComment(discussionId, 'main-owner', '【實作任務】工作區：目標工作區｜TASK：實作討論方向', db, new Date('2026-07-14T08:00:00.000Z'));
changeTaskStatus('main-owner', discussionId, 'Done', db, new Date('2026-07-17T08:00:00.000Z'));
const concludedDiscussion = getTask(discussionId, db)!;
assert.strictEqual(concludedDiscussion.status, 'Done');
assert.strictEqual(concludedDiscussion.assignee_id, null, '收尾不可指派 OWNER');
assert.strictEqual(loadEvents(discussionId, db).at(-1)?.event_type, 'task.main_discussion_concluded');
assert.strictEqual((loadEvents(discussionId, db).at(-1)?.payload as { outcome: string }).outcome, 'implement');
assert.throws(
  () => changeTaskStatus('main-owner', discussionId, 'Todo', db, new Date('2026-07-18T08:00:00.000Z')),
  { name: 'CommandError', message: /主工作區討論只允許 Todo/ },
  'Done 不可回退',
);

// ── legacy Todo 討論正規化；description/status 保留且第二次完全 no-op ──
const legacyTodoId = 'legacy-main-todo';
appendEvent(
  'Task',
  legacyTodoId,
  0,
  'task.created',
  {
    workspaceId: MAIN_WORKSPACE_ID,
    projectId: 'legacy-project',
    title: '舊方向',
    description: '保留的舊內容',
    status: 'Todo',
    priority: 'High',
    assigneeId: 'main-user',
    dueAt: '2027-01-01T00:00:00.000Z',
  },
  { actor_id: 'legacy' },
  db,
);
normalizeMainDiscussion('main-owner', legacyTodoId, db);
const normalizedTodo = getTask(legacyTodoId, db)!;
assert.deepStrictEqual(
  {
    title: normalizedTodo.title,
    description: normalizedTodo.description,
    status: normalizedTodo.status,
    priority: normalizedTodo.priority,
    assigneeId: normalizedTodo.assignee_id,
    projectId: normalizedTodo.project_id,
    dueAt: normalizedTodo.due_at,
  },
  {
    title: '[討論] 舊方向',
    description: '保留的舊內容',
    status: 'Todo',
    priority: 'Medium',
    assigneeId: null,
    projectId: null,
    dueAt: null,
  },
);
assert.strictEqual(loadEvents(legacyTodoId, db).at(-1)?.event_type, 'task.main_discussion_normalized');
const normalizedTodoSnapshot = { eventCount: loadEvents(legacyTodoId, db).length, version: normalizedTodo.version };
normalizeMainDiscussion('main-owner', legacyTodoId, db);
assert.strictEqual(loadEvents(legacyTodoId, db).length, normalizedTodoSnapshot.eventCount);
assert.strictEqual(getTask(legacyTodoId, db)?.version, normalizedTodoSnapshot.version);

// ── legacy 非 Todo 討論正規化時回到 Todo 並清空負責人 ──
const legacyDoingId = 'legacy-main-doing';
appendEvent(
  'Task',
  legacyDoingId,
  0,
  'task.created',
  {
    workspaceId: MAIN_WORKSPACE_ID,
    projectId: 'legacy-project',
    title: '進行中的舊方向',
    description: '進行中內容',
    status: 'Todo',
    priority: 'High',
    assigneeId: 'main-owner',
    dueAt: '2027-02-01T00:00:00.000Z',
  },
  { actor_id: 'legacy' },
  db,
);
appendEvent('Task', legacyDoingId, 1, 'task.status_changed', { status: 'Doing' }, { actor_id: 'legacy' }, db);
normalizeMainDiscussion('main-owner', legacyDoingId, db);
const normalizedDoing = getTask(legacyDoingId, db)!;
assert.deepStrictEqual(
  {
    title: normalizedDoing.title,
    description: normalizedDoing.description,
    status: normalizedDoing.status,
    priority: normalizedDoing.priority,
    assigneeId: normalizedDoing.assignee_id,
    projectId: normalizedDoing.project_id,
    dueAt: normalizedDoing.due_at,
  },
  {
    title: '[討論] 進行中的舊方向',
    description: '進行中內容',
    status: 'Todo',
    priority: 'Medium',
    assigneeId: null,
    projectId: null,
    dueAt: null,
  },
);
assert.strictEqual(loadEvents(legacyDoingId, db).at(-1)?.event_type, 'task.main_discussion_normalized');

// ── Commenter 修改 description 權限控制 ──
// 需 Admin 建立測試用的 task（由 Commenter 建立）
const commenterCreatedTaskId = createTask('main-user', COMMENTER_WS, { title: 'Commenter Task', description: 'Original' }, db);
// 由 Admin 建立的 task（给 Commenter 嘗試修改）
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('admin-user', 'admin@test.local', 'Admin User', 'x');
insertMember.run(COMMENTER_WS, 'admin-user', 'Admin', 't');
const adminCreatedTaskId = createTask('admin-user', COMMENTER_WS, { title: 'Admin Task', description: 'Original' }, db);

// 測試 1: Commenter 對「自己建立」的 task 改 description → 成功
changeTaskDescription('main-user', commenterCreatedTaskId, 'Modified by Commenter', db);
assert.strictEqual(getTask(commenterCreatedTaskId, db)?.description, 'Modified by Commenter', 'Commenter 可以修改自己建立的 description');

// 測試 2: Commenter 對「別人建立」的 task 改 description → 應被擋
assert.throws(
  () => changeTaskDescription('main-user', adminCreatedTaskId, 'Modified by Commenter', db),
  { name: 'CommandError', message: /Commenter 只能修改自己建立/ },
  'Commenter 不能修改別人的 description',
);

// 測試 3: Commenter 修改非 title/description 欄位 → 應被擋
assert.throws(
  () => applyTaskPatch('main-user', commenterCreatedTaskId, { status: 'Doing' }, db),
  { name: 'CommandError' },
  'Commenter 不能修改 status',
);

console.log('task.test.ts OK');
