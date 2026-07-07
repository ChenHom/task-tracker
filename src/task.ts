import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { appendEvent, loadEvents, registerProjection, CommandError, type StoredEvent } from './eventStore';
import { buildMetadata as meta } from './requestContext';
import { getWorkspaceStatus } from './workspace';

// ── 值域 ───────────────────────────────────────────────────────────
const ACTIVE_STATUSES = ['Todo', 'Doing', 'Review', 'Done'] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export type TaskStatus = ActiveStatus | 'Archived';

const PRIORITIES = ['Low', 'Medium', 'High'] as const;
type Priority = (typeof PRIORITIES)[number];

// 狀態機：只允許相鄰前進 + 一步回退。Archived 由 task.archived 事件達成（不是 status_changed 目標）。
const TRANSITIONS: Record<ActiveStatus, ActiveStatus[]> = {
  Todo: ['Doing'],
  Doing: ['Review', 'Todo'],
  Review: ['Done', 'Doing'],
  Done: ['Review'],
};

// ── 輸入驗證（信任邊界，OWASP：每個 command 都驗）──────────────────
function validateTitle(title: unknown): string {
  if (typeof title !== 'string') throw new CommandError('title 必須是字串');
  const t = title.trim();
  if (!t) throw new CommandError('title 不可為空');
  if (t.length > 200) throw new CommandError('title 過長（上限 200 字）');
  return t;
}
function validateDescription(desc: unknown): string {
  if (desc == null) return '';
  if (typeof desc !== 'string') throw new CommandError('description 必須是字串');
  if (desc.length > 5000) throw new CommandError('description 過長（上限 5000 字）');
  return desc;
}
function validatePriority(p: unknown): Priority {
  if (typeof p !== 'string' || !PRIORITIES.includes(p as Priority)) throw new CommandError(`priority 不合法：${String(p)}`);
  return p as Priority;
}
function validateTargetStatus(s: unknown): ActiveStatus {
  if (typeof s !== 'string' || !ACTIVE_STATUSES.includes(s as ActiveStatus)) throw new CommandError(`status 不合法：${String(s)}`);
  return s as ActiveStatus;
}
function validateAssignee(a: unknown): string | null {
  // ponytail: 只驗格式；不檢查 assignee 是否為該 workspace member，要嚴謹就查 workspace_members_read_model。
  if (a == null) return null;
  if (typeof a !== 'string' || !a.trim()) throw new CommandError('assignee 必須是 user id 或 null');
  return a.trim();
}
function validateDueAt(d: unknown): string | null {
  if (d == null) return null;
  if (typeof d !== 'string') throw new CommandError('due_at 必須是 ISO 字串或 null');
  const t = Date.parse(d);
  if (Number.isNaN(t)) throw new CommandError('due_at 不是合法日期');
  return new Date(t).toISOString();
}

// ── Aggregate：只追蹤狀態機相關欄位（其他欄位變更不影響轉換）──────
interface TaskState {
  exists: boolean;
  status: TaskStatus;
  deleted: boolean;
}
const INITIAL: TaskState = { exists: false, status: 'Todo', deleted: false };

function reduce(state: TaskState, e: StoredEvent): TaskState {
  switch (e.event_type) {
    case 'task.created':
      return { exists: true, status: 'Todo', deleted: false };
    case 'task.status_changed':
      return { ...state, status: (e.payload as { status: TaskStatus }).status };
    case 'task.archived':
      return { ...state, status: 'Archived' };
    case 'task.deleted':
      return { ...state, deleted: true };
    default:
      return state; // title / description / priority / assignee / due 不影響狀態機
  }
}

function load(taskId: string, database: DatabaseSync): { state: TaskState; version: number } {
  const events = loadEvents(taskId, database);
  const state = events.reduce(reduce, INITIAL);
  const version = events.length ? events[events.length - 1].aggregate_version : 0;
  return { state, version };
}

// 可修改的前提：存在、未刪除、未歸檔。用於欄位變更與 status_changed。
function requireEditable(state: TaskState): void {
  if (!state.exists || state.deleted) throw new CommandError('task 不存在');
  if (state.status === 'Archived') throw new CommandError('task 已歸檔，不可修改');
}

// ── Command handlers：load → 驗證 → append（絕不直接改 read model）──
export interface CreateTaskInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  assignee?: unknown;
  dueAt?: unknown;
  projectId?: unknown;
}
// 只在「建立」時 gate workspace 生命週期：不讓新 task 落進 archived/deleted/不存在的 workspace（防孤兒資料）。
// ponytail: 已存在 task 的 patch/archive/delete 不再回查 workspace，故 archived workspace 內既有 task 仍可微調。
//   要完全凍結需每個 command 跨 aggregate 查 workspace 狀態，或用 process manager 級聯 archive/delete task；等有需求再上。
function requireActiveWorkspace(workspaceId: string, database: DatabaseSync): void {
  const status = getWorkspaceStatus(workspaceId, database);
  if (status === null) throw new CommandError('workspace 不存在');
  if (status !== 'active') throw new CommandError(`workspace 目前為 ${status}，不可新增 task`);
}

export function createTask(actorId: string, workspaceId: string, input: CreateTaskInput, database = db): string {
  requireActiveWorkspace(workspaceId, database);
  const title = validateTitle(input.title);
  const description = validateDescription(input.description);
  const priority = input.priority == null ? 'Medium' : validatePriority(input.priority);
  const assigneeId = validateAssignee(input.assignee);
  const dueAt = validateDueAt(input.dueAt);
  const projectId = input.projectId == null ? null : String(input.projectId); // Project 是 Phase 6，先允許 null
  const id = randomUUID();
  appendEvent(
    'Task',
    id,
    0,
    'task.created',
    { workspaceId, projectId, title, description, status: 'Todo', priority, assigneeId, dueAt },
    meta(actorId),
    database,
  );
  return id;
}

export function changeTaskTitle(actorId: string, taskId: string, title: unknown, database = db): void {
  const clean = validateTitle(title);
  const { state, version } = load(taskId, database);
  requireEditable(state);
  appendEvent('Task', taskId, version, 'task.title_changed', { title: clean }, meta(actorId), database);
}

export function changeTaskDescription(actorId: string, taskId: string, description: unknown, database = db): void {
  const clean = validateDescription(description);
  const { state, version } = load(taskId, database);
  requireEditable(state);
  appendEvent('Task', taskId, version, 'task.description_changed', { description: clean }, meta(actorId), database);
}

export function changeTaskStatus(actorId: string, taskId: string, status: unknown, database = db): void {
  const { state, version } = load(taskId, database);
  requireEditable(state);
  const target = validateTargetStatus(status);
  const allowed = TRANSITIONS[state.status as ActiveStatus];
  if (!allowed.includes(target)) throw new CommandError(`不允許的狀態轉換：${state.status} → ${target}`);
  appendEvent('Task', taskId, version, 'task.status_changed', { status: target }, meta(actorId), database);
}

export function changeTaskPriority(actorId: string, taskId: string, priority: unknown, database = db): void {
  const clean = validatePriority(priority);
  const { state, version } = load(taskId, database);
  requireEditable(state);
  appendEvent('Task', taskId, version, 'task.priority_changed', { priority: clean }, meta(actorId), database);
}

export function changeTaskAssignee(actorId: string, taskId: string, assignee: unknown, database = db): void {
  const clean = validateAssignee(assignee);
  const { state, version } = load(taskId, database);
  requireEditable(state);
  appendEvent('Task', taskId, version, 'task.assignee_changed', { assigneeId: clean }, meta(actorId), database);
}

export function changeTaskDueDate(actorId: string, taskId: string, dueAt: unknown, database = db): void {
  const clean = validateDueAt(dueAt);
  const { state, version } = load(taskId, database);
  requireEditable(state);
  appendEvent('Task', taskId, version, 'task.due_date_changed', { dueAt: clean }, meta(actorId), database);
}

export function archiveTask(actorId: string, taskId: string, database = db): void {
  const { state, version } = load(taskId, database);
  requireEditable(state); // 已 archived / deleted 都會被擋
  appendEvent('Task', taskId, version, 'task.archived', {}, meta(actorId), database);
}

export function deleteTask(actorId: string, taskId: string, database = db): void {
  const { state, version } = load(taskId, database);
  if (!state.exists || state.deleted) throw new CommandError('task 不存在');
  appendEvent('Task', taskId, version, 'task.deleted', {}, meta(actorId), database);
}

// HTTP PATCH 分派：一次只改一個欄位（避免多欄位逐一 append 的部分成功語意）。
const PATCH_FIELDS = ['title', 'description', 'status', 'priority', 'assignee', 'dueAt'] as const;
export function applyTaskPatch(actorId: string, taskId: string, body: Record<string, unknown>, database = db): void {
  const keys = PATCH_FIELDS.filter((k) => k in body);
  if (keys.length !== 1) throw new CommandError('PATCH 一次只能改一個欄位');
  switch (keys[0]) {
    case 'title': return changeTaskTitle(actorId, taskId, body.title, database);
    case 'description': return changeTaskDescription(actorId, taskId, body.description, database);
    case 'status': return changeTaskStatus(actorId, taskId, body.status, database);
    case 'priority': return changeTaskPriority(actorId, taskId, body.priority, database);
    case 'assignee': return changeTaskAssignee(actorId, taskId, body.assignee, database);
    case 'dueAt': return changeTaskDueDate(actorId, taskId, body.dueAt, database);
  }
}

// ── Projection → tasks_read_model（version 一併寫入供樂觀鎖 / UI）──
export function registerTaskProjections(): void {
  registerProjection('task.created', (e, database) => {
    const p = e.payload as {
      workspaceId: string;
      projectId: string | null;
      title: string;
      description: string;
      status: string;
      priority: string;
      assigneeId: string | null;
      dueAt: string | null;
    };
    database
      .prepare(
        `INSERT INTO tasks_read_model
           (task_id, workspace_id, project_id, title, description, status, priority, assignee_id, due_at, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.aggregate_id, p.workspaceId, p.projectId, p.title, p.description, p.status, p.priority, p.assigneeId, p.dueAt, e.aggregate_version, e.occurred_at);
  });

  const setCol = (col: string) => (e: StoredEvent, database: DatabaseSync, value: unknown) => {
    database
      .prepare(`UPDATE tasks_read_model SET ${col} = ?, version = ?, updated_at = ? WHERE task_id = ?`)
      .run(value as never, e.aggregate_version, e.occurred_at, e.aggregate_id);
  };
  registerProjection('task.title_changed', (e, database) => setCol('title')(e, database, (e.payload as { title: string }).title));
  registerProjection('task.description_changed', (e, database) => setCol('description')(e, database, (e.payload as { description: string }).description));
  registerProjection('task.status_changed', (e, database) => setCol('status')(e, database, (e.payload as { status: string }).status));
  registerProjection('task.priority_changed', (e, database) => setCol('priority')(e, database, (e.payload as { priority: string }).priority));
  registerProjection('task.assignee_changed', (e, database) => setCol('assignee_id')(e, database, (e.payload as { assigneeId: string | null }).assigneeId));
  registerProjection('task.due_date_changed', (e, database) => setCol('due_at')(e, database, (e.payload as { dueAt: string | null }).dueAt));
  registerProjection('task.archived', (e, database) => setCol('status')(e, database, 'Archived'));
  registerProjection('task.deleted', (e, database) => {
    database.prepare('DELETE FROM tasks_read_model WHERE task_id = ?').run(e.aggregate_id);
  });
}

// ── Query ──────────────────────────────────────────────────────────
export interface TaskRow {
  task_id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee_id: string | null;
  due_at: string | null;
  version: number;
  updated_at: string | null;
}
export function listTasks(workspaceId: string, database = db): TaskRow[] {
  return database
    .prepare('SELECT * FROM tasks_read_model WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId) as unknown as TaskRow[];
}

export function getTask(taskId: string, database = db): TaskRow | null {
  const row = database.prepare('SELECT * FROM tasks_read_model WHERE task_id = ?').get(taskId) as TaskRow | undefined;
  return row ?? null;
}

// PATCH / archive / delete 用：查資源歸屬的 workspace 以做權限檢查。null = task 不存在（或已刪）。
export function getTaskWorkspaceId(taskId: string, database = db): string | null {
  const row = database.prepare('SELECT workspace_id FROM tasks_read_model WHERE task_id = ?').get(taskId) as
    | { workspace_id: string }
    | undefined;
  return row?.workspace_id ?? null;
}
