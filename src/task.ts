import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { appendEvent, loadEvents, registerProjection, CommandError, type StoredEvent } from './eventStore';
import { buildMetadata as meta } from './requestContext';
import { getWorkspaceStatus } from './workspace';
import { getMemberRole, getMembershipStatus, hasPermission, inviteMember } from './member';
import { getUserIdByEmail } from './auth';
import { MAIN_DISCUSSION_PREFIX, MAIN_OWNER_EMAIL, MAIN_POLICY_TITLE, MAIN_WORKSPACE_ID } from './mainWorkspacePolicy';
import {
  resolveMainDiscussionConclusion,
  type MainDiscussionConcludedPayload,
} from './mainDiscussion';

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
  if (a == null) return null;
  if (typeof a !== 'string' || !a.trim()) throw new CommandError('assignee 必須是 user id 或 null');
  return a.trim();
}

function requireActiveAssignee(workspaceId: string, assigneeId: string, database: DatabaseSync): void {
  if (!getMemberRole(workspaceId, assigneeId, database)) {
    throw new CommandError('assignee 必須是 workspace active member');
  }
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
    case 'task.discussion_started':
      return { ...state, status: (e.payload as { status: TaskStatus }).status };
    case 'task.main_discussion_concluded':
      return { ...state, status: (e.payload as MainDiscussionConcludedPayload).status };
    case 'task.main_discussion_normalized':
      return { ...state, status: (e.payload as { status?: TaskStatus }).status ?? state.status };
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

function requireTaskWorkspaceActive(taskId: string, database: DatabaseSync): void {
  const workspaceId = getTaskWorkspaceId(taskId, database);
  const status = workspaceId ? getWorkspaceStatus(workspaceId, database) : null;
  if (status === null) throw new CommandError('workspace 不存在');
  if (status !== 'active') throw new CommandError(`workspace 目前為 ${status}，不可修改 task`);
}

function loadEditableTask(taskId: string, database: DatabaseSync): { state: TaskState; version: number } {
  const task = load(taskId, database);
  requireEditable(task.state);
  requireTaskWorkspaceActive(taskId, database);
  return task;
}

// ── Command handlers：load → 驗證 → append（絕不直接改 read model）──
export interface CreateTaskInput {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  assignee?: unknown;
  assigneeId?: unknown;
  dueAt?: unknown;
  projectId?: unknown;
}

export interface MoveTaskResult {
  invitedAssignee: boolean;
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
  const isCommenter = getMemberRole(workspaceId, actorId, database) === 'Commenter';
  if (
    isCommenter
    && Object.keys(input).some((field) => field !== 'title' && field !== 'description')
  ) {
    throw new CommandError('Commenter 建立 task 只能提交 title 與 description');
  }

  let title = validateTitle(input.title);
  const description = validateDescription(input.description);
  const isMainDiscussion = workspaceId === MAIN_WORKSPACE_ID && title !== MAIN_POLICY_TITLE;

  if (workspaceId === MAIN_WORKSPACE_ID && title === MAIN_POLICY_TITLE) {
    if (actorId !== getUserIdByEmail(MAIN_OWNER_EMAIL, database)) {
      throw new CommandError('只有 user01 可以建立主工作區規則 task');
    }
    const existing = database
      .prepare('SELECT 1 FROM tasks_read_model WHERE workspace_id = ? AND title = ? AND status <> ? LIMIT 1')
      .get(MAIN_WORKSPACE_ID, MAIN_POLICY_TITLE, 'Archived');
    if (existing) throw new CommandError('主工作區規則 task 已存在');
  }

  if (isMainDiscussion) title = validateTitle(title.startsWith(MAIN_DISCUSSION_PREFIX) ? title : `${MAIN_DISCUSSION_PREFIX} ${title}`);
  const useDefaults = isMainDiscussion || isCommenter;
  const priority = useDefaults ? 'Medium' : input.priority == null ? 'Medium' : validatePriority(input.priority);
  const assigneeId = useDefaults ? null : validateAssignee(input.assignee);
  if (assigneeId) requireActiveAssignee(workspaceId, assigneeId, database);
  const dueAt = useDefaults ? null : validateDueAt(input.dueAt);
  const projectId = useDefaults ? null : input.projectId == null ? null : String(input.projectId); // Project 是 Phase 6，先允許 null
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
  let clean = validateTitle(title);
  const { version } = loadEditableTask(taskId, database);
  const task = getTask(taskId, database);
  if (task?.workspace_id === MAIN_WORKSPACE_ID) {
    if (task.title === MAIN_POLICY_TITLE) throw new CommandError('主工作區規則 task 標題固定');
    if (clean === MAIN_POLICY_TITLE) throw new CommandError('一般 task 不可改為主工作區規則 task');
    clean = validateTitle(clean.startsWith(MAIN_DISCUSSION_PREFIX) ? clean : `${MAIN_DISCUSSION_PREFIX} ${clean}`);
  }
  appendEvent('Task', taskId, version, 'task.title_changed', { title: clean }, meta(actorId), database);
}

export function changeTaskDescription(actorId: string, taskId: string, description: unknown, database = db): void {
  const clean = validateDescription(description);
  const { version } = loadEditableTask(taskId, database);
  const task = getTask(taskId, database)!;
  if (getMemberRole(task.workspace_id, actorId, database) === 'Commenter' && task.creator_id !== actorId) {
    throw new CommandError('Commenter 只能修改自己建立 task 的描述');
  }
  appendEvent('Task', taskId, version, 'task.description_changed', { description: clean }, meta(actorId), database);
}

export function changeTaskStatus(
  actorId: string,
  taskId: string,
  status: unknown,
  database = db,
  now = new Date(),
): void {
  const { state, version } = loadEditableTask(taskId, database);
  const target = validateTargetStatus(status);

  if (getTaskWorkspaceId(taskId, database) === MAIN_WORKSPACE_ID) {
    const task = getTask(taskId, database)!;
    const ownerId = getUserIdByEmail(MAIN_OWNER_EMAIL, database);
    if (actorId !== ownerId) throw new CommandError('只有 user01 可以改變主工作區 task 狀態');
    if (task.title === MAIN_POLICY_TITLE) throw new CommandError('主工作區規則 task 不使用討論收尾流程');
    if (state.status !== 'Todo' || target !== 'Done') {
      throw new CommandError(`主工作區討論只允許 Todo → Done：${state.status} → ${target}`);
    }
    const payload = resolveMainDiscussionConclusion(taskId, actorId, now, database);
    appendEvent('Task', taskId, version, 'task.main_discussion_concluded', payload, meta(actorId), database);
    return;
  }

  const allowed = TRANSITIONS[state.status as ActiveStatus];
  if (!allowed.includes(target)) throw new CommandError(`不允許的狀態轉換：${state.status} → ${target}`);
  if (target === 'Doing') {
    const task = getTask(taskId, database)!;
    if (!task.assignee_id) throw new CommandError('Todo → Doing 必須先指派 active workspace member');
    requireActiveAssignee(task.workspace_id, task.assignee_id, database);
  }
  appendEvent('Task', taskId, version, 'task.status_changed', { status: target }, meta(actorId), database);
}

export function normalizeMainDiscussion(actorId: string, taskId: string, database = db): void {
  const task = getTask(taskId, database);
  if (!task || task.workspace_id !== MAIN_WORKSPACE_ID || task.title === MAIN_POLICY_TITLE || task.status === 'Archived') {
    throw new CommandError('不是可正規化的主工作區 task');
  }
  if (actorId !== getUserIdByEmail(MAIN_OWNER_EMAIL, database)) {
    throw new CommandError('只有 user01 可以正規化主工作區 task');
  }

  const title = task.title.startsWith(MAIN_DISCUSSION_PREFIX) ? task.title : `${MAIN_DISCUSSION_PREFIX} ${task.title}`;
  const status = task.status === 'Doing' || task.status === 'Review' ? 'Todo' : task.status;
  const assigneeId = null;
  if (
    task.title === title
    && task.status === status
    && task.priority === 'Medium'
    && task.assignee_id === assigneeId
    && task.project_id === null
    && task.due_at === null
  ) return;

  const { version } = loadEditableTask(taskId, database);
  appendEvent(
    'Task',
    taskId,
    version,
    'task.main_discussion_normalized',
    { title, status, priority: 'Medium', assigneeId, projectId: null, dueAt: null },
    meta(actorId),
    database,
  );
}

export function changeTaskPriority(actorId: string, taskId: string, priority: unknown, database = db): void {
  const clean = validatePriority(priority);
  const { version } = loadEditableTask(taskId, database);
  appendEvent('Task', taskId, version, 'task.priority_changed', { priority: clean }, meta(actorId), database);
}

export function changeTaskAssignee(actorId: string, taskId: string, assignee: unknown, database = db): void {
  const clean = validateAssignee(assignee);
  const { version } = loadEditableTask(taskId, database);
  if (clean) {
    const task = getTask(taskId, database)!;
    requireActiveAssignee(task.workspace_id, clean, database);
  }
  appendEvent('Task', taskId, version, 'task.assignee_changed', { assigneeId: clean }, meta(actorId), database);
}

export function changeTaskDueDate(actorId: string, taskId: string, dueAt: unknown, database = db): void {
  const clean = validateDueAt(dueAt);
  const { version } = loadEditableTask(taskId, database);
  appendEvent('Task', taskId, version, 'task.due_date_changed', { dueAt: clean }, meta(actorId), database);
}

export function moveTask(actorId: string, taskId: string, targetWorkspaceId: string, database = db): MoveTaskResult {
  const task = getTask(taskId, database);
  if (!task) throw new CommandError('task 不存在');
  const { state, version } = load(taskId, database);
  requireEditable(state);

  const sourceWorkspaceId = task.workspace_id;
  if (sourceWorkspaceId === targetWorkspaceId) throw new CommandError('task 已在目標 workspace');

  const sourceRole = getMemberRole(sourceWorkspaceId, actorId, database);
  if (!sourceRole || !hasPermission(sourceRole, 'Member')) throw new CommandError('來源 workspace 權限不足');

  const targetStatus = getWorkspaceStatus(targetWorkspaceId, database);
  if (targetStatus === null) throw new CommandError('workspace 不存在');
  if (targetStatus !== 'active') throw new CommandError(`workspace 目前為 ${targetStatus}，不可搬入 task`);

  const targetRole = getMemberRole(targetWorkspaceId, actorId, database);
  if (!targetRole || !hasPermission(targetRole, 'Member')) throw new CommandError('目標 workspace 權限不足');

  let invitedAssignee = false;
  if (task.assignee_id) {
    const membershipStatus = getMembershipStatus(targetWorkspaceId, task.assignee_id, database);
    if (membershipStatus === 'none' || membershipStatus === 'removed') {
      inviteMember(actorId, targetWorkspaceId, task.assignee_id, 'Member', database);
      invitedAssignee = true;
    } else if (membershipStatus === 'invited') {
      invitedAssignee = true;
    }
  }

  appendEvent(
    'Task',
    taskId,
    version,
    'task.moved',
    { fromWorkspaceId: sourceWorkspaceId, toWorkspaceId: targetWorkspaceId },
    meta(actorId),
    database,
  );
  return { invitedAssignee };
}

export function archiveTask(actorId: string, taskId: string, database = db): void {
  const { version } = loadEditableTask(taskId, database); // 已 archived / deleted 都會被擋
  if (
    getTaskWorkspaceId(taskId, database) === MAIN_WORKSPACE_ID
    && actorId !== getUserIdByEmail(MAIN_OWNER_EMAIL, database)
  ) {
    throw new CommandError('只有 user01 可以改變主工作區 task 狀態');
  }
  appendEvent('Task', taskId, version, 'task.archived', {}, meta(actorId), database);
}

export function deleteTask(actorId: string, taskId: string, database = db): void {
  const { state, version } = load(taskId, database);
  if (!state.exists || state.deleted) throw new CommandError('task 不存在');
  requireTaskWorkspaceActive(taskId, database);
  appendEvent('Task', taskId, version, 'task.deleted', {}, meta(actorId), database);
}

// HTTP PATCH 分派：一次只改一個欄位（避免多欄位逐一 append 的部分成功語意）。
const PATCH_FIELDS = ['title', 'description', 'status', 'priority', 'assignee', 'dueAt'] as const;
export function applyTaskPatch(actorId: string, taskId: string, body: Record<string, unknown>, database = db): void {
  const keys = PATCH_FIELDS.filter((k) => k in body);
  if (keys.length !== 1) throw new CommandError('PATCH 一次只能改一個欄位');
  const workspaceId = getTaskWorkspaceId(taskId, database);
  if (workspaceId && getMemberRole(workspaceId, actorId, database) === 'Commenter' && !['title', 'description'].includes(keys[0])) {
    throw new CommandError('Commenter 只能修改 title 與 description');
  }
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
  registerProjection('task.discussion_started', (e, database) => {
    const p = e.payload as { status: string; assigneeId: string };
    database
      .prepare('UPDATE tasks_read_model SET status = ?, assignee_id = ?, version = ?, updated_at = ? WHERE task_id = ?')
      .run(p.status, p.assigneeId, e.aggregate_version, e.occurred_at, e.aggregate_id);
  });
  registerProjection('task.main_discussion_concluded', (e, database) => {
    const p = e.payload as MainDiscussionConcludedPayload;
    database
      .prepare('UPDATE tasks_read_model SET status = ?, assignee_id = NULL, version = ?, updated_at = ? WHERE task_id = ?')
      .run(p.status, e.aggregate_version, e.occurred_at, e.aggregate_id);
  });
  registerProjection('task.priority_changed', (e, database) => setCol('priority')(e, database, (e.payload as { priority: string }).priority));
  registerProjection('task.assignee_changed', (e, database) => setCol('assignee_id')(e, database, (e.payload as { assigneeId: string | null }).assigneeId));
  registerProjection('task.due_date_changed', (e, database) => setCol('due_at')(e, database, (e.payload as { dueAt: string | null }).dueAt));
  registerProjection('task.moved', (e, database) => {
    const p = e.payload as { toWorkspaceId: string };
    database
      .prepare('UPDATE tasks_read_model SET workspace_id = ?, project_id = NULL, version = ?, updated_at = ? WHERE task_id = ?')
      .run(p.toWorkspaceId, e.aggregate_version, e.occurred_at, e.aggregate_id);
  });
  registerProjection('task.main_discussion_normalized', (e, database) => {
    const p = e.payload as {
      title: string;
      status?: TaskStatus;
      priority: Priority;
      assigneeId: string | null;
      projectId: string | null;
      dueAt: string | null;
    };
    database
      .prepare(
        `UPDATE tasks_read_model
            SET title = ?, status = COALESCE(?, status), priority = ?, assignee_id = ?, project_id = ?, due_at = ?, version = ?, updated_at = ?
          WHERE task_id = ?`,
      )
      .run(p.title, p.status ?? null, p.priority, p.assigneeId, p.projectId, p.dueAt, e.aggregate_version, e.occurred_at, e.aggregate_id);
  });
  registerProjection('task.archived', (e, database) => setCol('status')(e, database, 'Archived'));
  registerProjection('task.deleted', (e, database) => {
    database.prepare('DELETE FROM tasks_read_model WHERE task_id = ?').run(e.aggregate_id);
    database.prepare('DELETE FROM notifications_read_model WHERE source_task_id = ?').run(e.aggregate_id);
    database.prepare('DELETE FROM main_discussion_windows WHERE task_id = ?').run(e.aggregate_id);
  });
}

// ── Query ──────────────────────────────────────────────────────────
export interface TaskRow {
  task_id: string;
  workspace_id: string;
  creator_id: string | null;
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

function getTaskCreatorId(taskId: string, database: DatabaseSync): string | null {
  const created = loadEvents(taskId, database).find((event) => event.event_type === 'task.created');
  const actorId = created?.metadata && typeof created.metadata === 'object'
    ? (created.metadata as { actor_id?: unknown }).actor_id
    : null;
  return typeof actorId === 'string' && actorId.length > 0 ? actorId : null;
}

export function listTasks(workspaceId: string, database = db): TaskRow[] {
  const rows = database
    .prepare('SELECT * FROM tasks_read_model WHERE workspace_id = ? ORDER BY rowid')
    .all(workspaceId) as unknown as TaskRow[];
  return rows.map((row) => ({ ...row, creator_id: getTaskCreatorId(row.task_id, database) }));
}

export function getTask(taskId: string, database = db): TaskRow | null {
  const row = database.prepare('SELECT * FROM tasks_read_model WHERE task_id = ?').get(taskId) as TaskRow | undefined;
  return row ? { ...row, creator_id: getTaskCreatorId(taskId, database) } : null;
}

// PATCH / archive / delete 用：查資源歸屬的 workspace 以做權限檢查。null = task 不存在（或已刪）。
export function getTaskWorkspaceId(taskId: string, database = db): string | null {
  const row = database.prepare('SELECT workspace_id FROM tasks_read_model WHERE task_id = ?').get(taskId) as
    | { workspace_id: string }
    | undefined;
  return row?.workspace_id ?? null;
}
