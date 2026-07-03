import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './schema';
import { resetProjections, loadEvents, CommandError } from './eventStore';
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
  getTaskWorkspaceId,
  registerTaskProjections,
} from './task';

const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerTaskProjections();

const WS = 'ws-1';
// createTask 會檢查 workspace 生命週期 → 需要 workspaces_read_model 有 active 的 fixture。
const seedWs = (id: string, status = 'active') =>
  db.prepare('INSERT INTO workspaces_read_model (workspace_id, name, status, created_at) VALUES (?, ?, ?, ?)').run(id, id, status, 't');
seedWs(WS);
seedWs('ws-other');
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

console.log('task.test.ts OK');
