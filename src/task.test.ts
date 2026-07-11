import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { appendEvent, resetProjections, loadEvents, CommandError } from './eventStore';
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
  normalizeMainDiscussion,
  registerTaskProjections,
} from './task';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerTaskProjections();

const WS = 'ws-1';
const COMMENTER_WS = 'ws-commenter';
// createTask 會檢查 workspace 生命週期 → 需要 workspaces_read_model 有 active 的 fixture。
const seedWs = (id: string, status = 'active') =>
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)').run(id, id, status, 't');
seedWs(WS);
seedWs('ws-other');
seedWs(COMMENTER_WS);
seedWs(MAIN_WORKSPACE_ID);
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('main-owner', MAIN_OWNER_EMAIL, 'Main Owner', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('main-user', 'user02@test.local', 'Main User', 'x');
const insertMember = db.prepare(
  'INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
);
insertMember.run(MAIN_WORKSPACE_ID, 'main-owner', 'Owner', 't');
insertMember.run(MAIN_WORKSPACE_ID, 'main-user', 'Commenter', 't');
insertMember.run(COMMENTER_WS, 'main-user', 'Commenter', 't');
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

// ── create 帶完整欄位 ──
const id2 = createTask('u1', WS, { title: 'Full', description: 'desc', priority: 'High', assignee: 'bob', dueAt: '2026-08-01' }, db);
t = one(id2);
assert.strictEqual(t.priority, 'High');
assert.strictEqual(t.assignee_id, 'bob');
assert.strictEqual(t.due_at, new Date('2026-08-01').toISOString(), 'due_at 正規化成 ISO');

// ── 狀態機：合法前進 Todo → Doing → Review → Done ──
changeTaskStatus('u1', id, 'Doing', db);
assert.strictEqual(one(id).status, 'Doing');
changeTaskStatus('u1', id, 'Review', db);
changeTaskStatus('u1', id, 'Done', db);
assert.strictEqual(one(id).status, 'Done');
assert.strictEqual(one(id).version, 4, 'created + 3 status_changed → version 4');

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
const commenterTaskId = createTask('main-user', COMMENTER_WS, { title: '一般方向', description: '一般討論' }, db);
assert.strictEqual(getTask(commenterTaskId, db)?.title, '一般方向', '一般 workspace 不加討論 prefix');

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
archiveTask('main-owner', archivedDiscussionId, db);
assert.throws(
  () => normalizeMainDiscussion('main-owner', archivedDiscussionId, db),
  { name: 'CommandError', message: '不是可正規化的主工作區 task' },
);

// ── 主討論 Todo → Doing：狀態與負責人在單一事件內更新 ──
assert.throws(
  () => changeTaskStatus('main-user', discussionId, 'Doing', db),
  { name: 'CommandError', message: '只有 user01 可以改變主工作區 task 狀態' },
);
const beforeStartEvents = loadEvents(discussionId, db);
changeTaskStatus('main-owner', discussionId, 'Doing', db);
const started = getTask(discussionId, db)!;
const afterStartEvents = loadEvents(discussionId, db);
assert.strictEqual(started.status, 'Doing');
assert.strictEqual(started.assignee_id, 'main-owner');
assert.strictEqual(afterStartEvents.length, beforeStartEvents.length + 1, '開始討論只新增一個 event');
assert.strictEqual(afterStartEvents.at(-1)?.event_type, 'task.discussion_started');
assert.deepStrictEqual(afterStartEvents.at(-1)?.payload, { status: 'Doing', assigneeId: 'main-owner' });

const beforeStartedNormalize = { eventCount: afterStartEvents.length, version: started.version };
normalizeMainDiscussion('main-owner', discussionId, db);
assert.strictEqual(getTask(discussionId, db)?.assignee_id, 'main-owner', 'Doing normalize 保留負責人');
assert.strictEqual(loadEvents(discussionId, db).length, beforeStartedNormalize.eventCount, '已合規時不追加 event');
assert.strictEqual(getTask(discussionId, db)?.version, beforeStartedNormalize.version, '已合規時 version 不變');

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

// ── legacy 非 Todo 討論正規化時保留既有負責人 ──
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
    status: 'Doing',
    priority: 'Medium',
    assigneeId: 'main-owner',
    projectId: null,
    dueAt: null,
  },
);
assert.strictEqual(loadEvents(legacyDoingId, db).at(-1)?.event_type, 'task.main_discussion_normalized');

console.log('task.test.ts OK');
