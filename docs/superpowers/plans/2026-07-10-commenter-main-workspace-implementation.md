# Commenter And Main Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Commenter 權限並把固定主工作區治理成所有人可發起討論、只有 user01 可推進與交接實作的「主協作工作區」。

**Architecture:** 保留既有 event store、角色階層與 HTTP route 結構。用一個無狀態政策檔集中固定 UUID／名稱／規則文字；domain command 負責主工作區不變條件，啟動同步只負責名稱、成員與規則 task，前端與 sim 只呈現及遵守同一流程。

**Tech Stack:** Node.js 24、TypeScript、`node:sqlite`、原生 HTTP server、原生 ES modules 前端、assert 測試、Playwright CLI。

**Design spec:** `docs/superpowers/specs/2026-07-10-commenter-main-workspace-design.md`

**Status:** 待實作。現況基準為 `4902e287393f48b7fe13f8a0187bda009a2f7b86`（2026-07-11）。

## Current Baseline

- `4902e28` 已完成 `sim/run.ts` 的 canonical workspace lookup、候選收錄與 `[CROSS-REPO]` prompt；詳見 `docs/superpowers/plans/2026-07-10-crossrepo-workspace-routing.md`。
- `4902e28` 的 report-independent candidate 使用 epoch timestamp，但目前排序只看 timeout／startedAt；owner budget 長期滿載時 canonical workspace 仍可能飢餓。Task 6 會連同主工作區加入明確優先序。
- Commenter、主工作區同步、`task.discussion_started`、主工作區 UI 與 main-workspace sweep 尚未實作；`src/`、`public/`、`sim/` 目前找不到對應識別字。
- `npm test` 已在 `4902e28` 實跑通過；這只證明現有基準乾淨，不代表本計畫功能已完成。
- 既有 isolated worktree `.worktrees/commenter-main-workspace`／branch `feature/commenter-main-workspace` 仍停在 `90d5823`，開始實作前必須先 fast-forward 到包含 `4902e28` 的最新 `master`。
- `sim-sweep-owner.timer`／`sim-sweep-team.timer` 目前由使用者停用；本計畫不得自行重新啟用。

---

## File Map

- Create `src/mainWorkspacePolicy.ts`: 固定主工作區識別、名稱、owner email、task 前綴與規則內容；不可讀 DB。
- Create `src/mainWorkspace.ts`: 啟動／登入同步名稱、成員及 `[規則]` task。
- Create `src/mainWorkspace.test.ts`: 同步、改名、removed member 回補與冪等測試。
- Modify `src/member.ts`: Commenter 階層、API 最低角色、removed member 再邀請、主工作區成員不變條件。
- Modify `src/member.test.ts`: RBAC、Commenter lifecycle 與主工作區成員守門測試。
- Modify `src/task.ts`: Commenter create 限制、新舊主工作區 task 正規化、`task.discussion_started` 與 `task.main_discussion_normalized` 原子事件。
- Modify `src/task.test.ts`: create 限制、前綴、legacy backfill、固定預設值與原子狀態／指派測試。
- Modify `src/server.ts`: route 最低角色、啟動同步與成功登入同步。
- Modify `src/workspace.ts`: 固定主工作區只接受 `MAIN_WORKSPACE_NAME`，防止 API 改名漂移。
- Modify `src/test.ts`: 納入 `mainWorkspace.test.ts`。
- Modify `public/js/state.js`: Commenter 角色、前端角色比較與主工作區常數。
- Modify `public/js/views/kanban.js`: banner、依角色收斂新增／狀態／封存／刪除／project 控制、規則 task 排序。
- Modify `public/js/views/task-detail.js`: Commenter 唯讀 task 欄位、保留留言、附件唯讀與安全 HTTP(S) URL link。
- Modify `public/js/views/members.js`: Commenter 選項、非管理者唯讀、主工作區成員管理鎖定。
- Modify `public/css/kanban.css`: 固定規則 banner 樣式。
- Modify `src/frontend.test.ts`: Commenter UI 與 URL protocol 驗證。
- Modify `sim/run.ts`: 在既有 canonical routing 上增加固定主工作區 sweep 候選、規則 task 排除、owner 喚醒條件及依 target repo 選 workspace 的新 prompt。
- Modify `sim/run.test.ts`: 主工作區候選、task 分類、owner 喚醒與 canonical directory 共存測試。
- Modify `TASKS_V2.md`: 新增並完成 Phase 15 驗收紀錄。
- Modify `docs/operations.md`: 主協作工作區政策、同步、sweep 與故障檢查。
- Modify `docs/superpowers/specs/2026-07-10-commenter-main-workspace-design.md`: 驗收後把狀態改為已完成。

---

### Task 0: Fast-Forward The Isolated Worktree To The Verified Baseline

**Files:**
- Verify only: `/home/hom/code/task-tracker/.worktrees/commenter-main-workspace`

- [ ] **Step 1: Confirm both worktrees are clean and the feature branch has no unique commit**

Run:

```bash
git -C /home/hom/code/task-tracker status --short --branch
git -C /home/hom/code/task-tracker/.worktrees/commenter-main-workspace status --short --branch
git -C /home/hom/code/task-tracker log --oneline master..feature/commenter-main-workspace
```

Expected: both worktrees are clean and the final command has no output. Stop if either worktree is dirty or the feature branch contains a unique commit.

- [ ] **Step 2: Fast-forward the feature branch and prove it contains the canonical routing baseline**

Run:

```bash
git -C /home/hom/code/task-tracker/.worktrees/commenter-main-workspace merge --ff-only master
git -C /home/hom/code/task-tracker/.worktrees/commenter-main-workspace merge-base --is-ancestor 4902e287393f48b7fe13f8a0187bda009a2f7b86 HEAD
```

Expected: fast-forward succeeds and `merge-base --is-ancestor` exits 0.

- [ ] **Step 3: Re-run the baseline gate in the implementation worktree**

Run: `npm test`

Expected: all existing suites print `OK`; exit 0. Stop before Task 1 if the baseline fails.

---

### Task 1: Add Commenter RBAC And Main Membership Guards

**Files:**
- Create: `src/mainWorkspacePolicy.ts`
- Modify: `src/member.ts:8-15,55-65,91-119,181-214`
- Test: `src/member.test.ts:31-58,136-150`

- [ ] **Step 1: Write failing role, reinvite, and main workspace guard assertions**

Add imports for `ACCESS_ROLE` and the main workspace constants, then add these assertions to `src/member.test.ts`:

```ts
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

db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
  .run('eve', 'e@x.com', 'Eve', 'x');
const WS_REINVITE = 'ws-reinvite';
seedOwner(WS_REINVITE, 'owner', db);
inviteMember('owner', WS_REINVITE, 'eve', 'Commenter', db);
joinWorkspace('eve', WS_REINVITE, db);
removeMember('owner', WS_REINVITE, 'eve', db);
inviteMember('owner', WS_REINVITE, 'eve', 'Commenter', db);
joinWorkspace('eve', WS_REINVITE, db);
assert.strictEqual(getMemberRole(WS_REINVITE, 'eve', db), 'Commenter');

db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
  .run('main-owner', MAIN_OWNER_EMAIL, '阿哲', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
  .run('main-user', 'user02@test.local', '小美', 'x');
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
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --import tsx src/member.test.ts`

Expected: TypeScript/runtime failure because `Commenter`, `ACCESS_ROLE`, and `mainWorkspacePolicy.ts` do not exist yet.

- [ ] **Step 3: Add the fixed policy constants**

Create `src/mainWorkspacePolicy.ts`:

```ts
export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const MAIN_WORKSPACE_NAME = '主協作工作區';
export const MAIN_OWNER_EMAIL = 'user01@test.local';
export const MAIN_DISCUSSION_PREFIX = '[討論]';
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
export const MAIN_POLICY_DESCRIPTION = [
  '此處只建立討論，不直接實作。',
  '所有人都可新增 Todo 討論與留言。',
  '只有 user01 可以改變狀態；開始討論時系統會自動指派 user01。',
  '決議後先判斷 target repo，使用 canonical／對應工作區建立實作 task、回寫完整連結，再完成原討論。',
].join('\n');
```

- [ ] **Step 4: Implement the role hierarchy and membership invariants**

In `src/member.ts`, use this role/access definition:

```ts
export const ROLE_RANK = { Viewer: 0, Commenter: 1, Member: 2, Admin: 3, Owner: 4 } as const;
export type Role = keyof typeof ROLE_RANK;

export const ACCESS_ROLE = {
  read: 'Viewer',
  createTask: 'Commenter',
  createComment: 'Commenter',
  mutateOwnComment: 'Commenter',
  mutateTask: 'Member',
  writeProject: 'Member',
  writeAttachment: 'Member',
} as const satisfies Record<string, Role>;
```

Add a local email lookup and enforce the fixed main roles in `inviteMember()` and `changeMemberRole()`:

```ts
function userEmail(userId: string, database: DatabaseSync): string | null {
  const row = database.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  return row?.email ?? null;
}

function requireMainRole(workspaceId: string, userId: string, role: Role, database: DatabaseSync): void {
  if (workspaceId !== MAIN_WORKSPACE_ID) return;
  const expected = userEmail(userId, database) === MAIN_OWNER_EMAIL ? 'Owner' : 'Commenter';
  if (role !== expected) throw new CommandError(`主工作區成員固定為 ${expected}`);
}
```

Call `requireMainRole(workspaceId, userId, r, database)` immediately after `validateRole(role)` in `inviteMember()` and before appending `member.role_changed` in `changeMemberRole()`.

Allow a removed aggregate to receive a new invite:

```ts
if (state.status !== 'none' && state.status !== 'removed') {
  throw new CommandError('該使用者已被邀請或已是成員');
}
```

Before appending `member.role_changed`, add:

```ts
if (workspaceId === MAIN_WORKSPACE_ID && userEmail(userId, database) === MAIN_OWNER_EMAIL) {
  throw new CommandError('不可變更主工作區流程負責人角色');
}
requireMainRole(workspaceId, userId, r, database);
```

At the start of `removeMember()`, add:

```ts
if (workspaceId === MAIN_WORKSPACE_ID) {
  throw new CommandError('主工作區成員由系統同步，不可手動移除');
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --import tsx src/member.test.ts`

Expected: `member.test.ts OK`

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/mainWorkspacePolicy.ts src/member.ts src/member.test.ts
git commit -m "feat: add Commenter workspace role"
```

---

### Task 2: Enforce Main Discussion Rules And Legacy Normalization Atomically

**Files:**
- Modify: `src/task.ts:8-22,68-80,110-167,214-250`
- Test: `src/task.test.ts:22-54,69-93,128-137`

- [ ] **Step 1: Write failing Commenter and main discussion tests**

Import `appendEvent` from `eventStore` and `normalizeMainDiscussion` from `task`. Register main users/members directly in the existing in-memory fixture, then add:

```ts
seedWs(MAIN_WORKSPACE_ID);
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
  .run('main-owner', MAIN_OWNER_EMAIL, '阿哲', 'x');
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
  .run('main-user', 'user02@test.local', '小美', 'x');
db.prepare('INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
  .run(MAIN_WORKSPACE_ID, 'main-owner', 'Owner', 't');
db.prepare('INSERT INTO workspace_members_read_model (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
  .run(MAIN_WORKSPACE_ID, 'main-user', 'Commenter', 't');

assert.throws(
  () => createTask('main-user', MAIN_WORKSPACE_ID, { title: '方向', priority: 'High' }, db),
  /Commenter 建立 task 只能提交 title 與 description/,
);
assert.throws(
  () => createTask('main-user', MAIN_WORKSPACE_ID, { title: MAIN_POLICY_TITLE }, db),
  /只有 user01 可以建立主工作區規則 task/,
);
const discussionId = createTask('main-user', MAIN_WORKSPACE_ID, { title: '方向', description: '討論內容' }, db);
let discussion = getTask(discussionId, db)!;
assert.strictEqual(discussion.title, '[討論] 方向');
assert.strictEqual(discussion.priority, 'Medium');
assert.strictEqual(discussion.assignee_id, null);
assert.strictEqual(discussion.project_id, null);
assert.strictEqual(discussion.due_at, null);

assert.throws(
  () => changeTaskStatus('main-user', discussionId, 'Doing', db),
  /只有 user01 可以改變主工作區 task 狀態/,
);
changeTaskStatus('main-owner', discussionId, 'Doing', db);
discussion = getTask(discussionId, db)!;
assert.strictEqual(discussion.status, 'Doing');
assert.strictEqual(discussion.assignee_id, 'main-owner');
assert.strictEqual(loadEvents(discussionId, db).at(-1)?.event_type, 'task.discussion_started');
const startedVersion = discussion.version;
normalizeMainDiscussion('main-owner', discussionId, db);
assert.strictEqual(getTask(discussionId, db)?.assignee_id, 'main-owner', 'restart normalization 不可清掉 Doing assignee');
assert.strictEqual(getTask(discussionId, db)?.version, startedVersion, '已符合規則的 Doing task 不追加 event');

const ruleId = createTask('main-owner', MAIN_WORKSPACE_ID, { title: MAIN_POLICY_TITLE }, db);
assert.strictEqual(getTask(ruleId, db)?.title, MAIN_POLICY_TITLE);

const legacyId = 'legacy-main-task';
appendEvent('Task', legacyId, 0, 'task.created', {
  workspaceId: MAIN_WORKSPACE_ID,
  projectId: 'legacy-project',
  title: '舊任務',
  description: '保留描述',
  status: 'Todo',
  priority: 'High',
  assigneeId: 'main-user',
  dueAt: '2026-08-01T00:00:00.000Z',
}, { actor_id: 'main-owner' }, db);
normalizeMainDiscussion('main-owner', legacyId, db);
const normalized = getTask(legacyId, db)!;
assert.strictEqual(normalized.title, '[討論] 舊任務');
assert.strictEqual(normalized.description, '保留描述');
assert.strictEqual(normalized.status, 'Todo');
assert.strictEqual(normalized.priority, 'Medium');
assert.strictEqual(normalized.assignee_id, null);
assert.strictEqual(normalized.project_id, null);
assert.strictEqual(normalized.due_at, null);
assert.strictEqual(loadEvents(legacyId, db).at(-1)?.event_type, 'task.main_discussion_normalized');
const normalizedVersion = normalized.version;
normalizeMainDiscussion('main-owner', legacyId, db);
assert.strictEqual(getTask(legacyId, db)?.version, normalizedVersion, '已正規化 task 不追加 event');
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --import tsx src/task.test.ts`

Expected: assertions fail because main workspace normalization, legacy backfill, and `task.discussion_started` are absent.

- [ ] **Step 3: Reject forbidden Commenter create fields and normalize main tasks**

Extend `CreateTaskInput` with the two HTTP fields currently ignored so they can be rejected explicitly:

```ts
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
```

Add these imports to `src/task.ts`:

```ts
import { getMemberRole } from './member';
import {
  MAIN_DISCUSSION_PREFIX,
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
} from './mainWorkspacePolicy';
```

At the start of `createTask()`, after checking the workspace is active, add:

```ts
const role = getMemberRole(workspaceId, actorId, database);
if (role === 'Commenter') {
  const forbidden = ['status', 'priority', 'assignee', 'assigneeId', 'projectId', 'dueAt']
    .filter((key) => key in input);
  if (forbidden.length) {
    throw new CommandError('Commenter 建立 task 只能提交 title 與 description');
  }
}

const cleanTitle = validateTitle(input.title);
if (workspaceId === MAIN_WORKSPACE_ID && cleanTitle === MAIN_POLICY_TITLE) {
  const owner = database.prepare('SELECT id FROM users WHERE email = ?').get(MAIN_OWNER_EMAIL) as { id: string } | undefined;
  if (!owner || actorId !== owner.id) {
    throw new CommandError('只有 user01 可以建立主工作區規則 task');
  }
  const existing = database.prepare(
    'SELECT 1 FROM tasks_read_model WHERE workspace_id = ? AND title = ? AND status <> ?',
  ).get(MAIN_WORKSPACE_ID, MAIN_POLICY_TITLE, 'Archived');
  if (existing) throw new CommandError('主工作區規則 task 已存在');
}
const isMainDiscussion = workspaceId === MAIN_WORKSPACE_ID && cleanTitle !== MAIN_POLICY_TITLE;
const title = isMainDiscussion && !cleanTitle.startsWith(MAIN_DISCUSSION_PREFIX)
  ? `${MAIN_DISCUSSION_PREFIX} ${cleanTitle}`
  : cleanTitle;
const priority = isMainDiscussion ? 'Medium' : input.priority == null ? 'Medium' : validatePriority(input.priority);
const assigneeId = isMainDiscussion ? null : validateAssignee(input.assignee);
const dueAt = isMainDiscussion ? null : validateDueAt(input.dueAt);
const projectId = isMainDiscussion ? null : input.projectId == null ? null : String(input.projectId);
```

- [ ] **Step 4: Add the two single-event main workspace commands**

Teach the aggregate and projection about the event:

```ts
case 'task.discussion_started':
  return { ...state, status: 'Doing' };
```

```ts
registerProjection('task.discussion_started', (e, database) => {
  const p = e.payload as { status: 'Doing'; assigneeId: string };
  database.prepare(
    'UPDATE tasks_read_model SET status = ?, assignee_id = ?, version = ?, updated_at = ? WHERE task_id = ?',
  ).run(p.status, p.assigneeId, e.aggregate_version, e.occurred_at, e.aggregate_id);
});
```

In `changeTaskStatus()`, keep the existing transition validation, then branch only for the fixed workspace:

```ts
if (getTaskWorkspaceId(taskId, database) === MAIN_WORKSPACE_ID) {
  const owner = database.prepare('SELECT id FROM users WHERE email = ?').get(MAIN_OWNER_EMAIL) as { id: string } | undefined;
  if (!owner || actorId !== owner.id) {
    throw new CommandError('只有 user01 可以改變主工作區 task 狀態');
  }
  if (state.status === 'Todo' && target === 'Doing') {
    appendEvent(
      'Task', taskId, version, 'task.discussion_started',
      { status: 'Doing', assigneeId: owner.id }, meta(actorId), database,
    );
    return;
  }
}
appendEvent('Task', taskId, version, 'task.status_changed', { status: target }, meta(actorId), database);
```

Add `normalizeMainDiscussion()` for startup backfill. It must preserve status/description and append nothing when all normalized fields already match:

```ts
export function normalizeMainDiscussion(actorId: string, taskId: string, database = db): void {
  const task = getTask(taskId, database);
  if (!task || task.workspace_id !== MAIN_WORKSPACE_ID || task.title === MAIN_POLICY_TITLE || task.status === 'Archived') {
    throw new CommandError('不是可正規化的主工作區 task');
  }
  const owner = database.prepare('SELECT id FROM users WHERE email = ?').get(MAIN_OWNER_EMAIL) as { id: string } | undefined;
  if (!owner || actorId !== owner.id) throw new CommandError('只有 user01 可以正規化主工作區 task');
  const title = task.title.startsWith(MAIN_DISCUSSION_PREFIX)
    ? task.title
    : `${MAIN_DISCUSSION_PREFIX} ${task.title}`;
  const assigneeId = task.status === 'Todo' ? null : task.assignee_id;
  if (title === task.title && task.priority === 'Medium' && task.assignee_id === assigneeId
      && task.project_id === null && task.due_at === null) return;
  const { version } = loadEditableTask(taskId, database);
  appendEvent('Task', taskId, version, 'task.main_discussion_normalized', {
    title,
    priority: 'Medium',
    assigneeId,
    projectId: null,
    dueAt: null,
  }, meta(actorId), database);
}
```

Register one projection that updates all normalized fields atomically:

```ts
registerProjection('task.main_discussion_normalized', (e, database) => {
  const p = e.payload as {
    title: string;
    priority: 'Medium';
    assigneeId: string | null;
    projectId: null;
    dueAt: null;
  };
  database.prepare(
    `UPDATE tasks_read_model
        SET title = ?, priority = ?, assignee_id = ?, project_id = ?, due_at = ?, version = ?, updated_at = ?
      WHERE task_id = ?`,
  ).run(p.title, p.priority, p.assigneeId, p.projectId, p.dueAt, e.aggregate_version, e.occurred_at, e.aggregate_id);
});
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `node --import tsx src/task.test.ts`

Expected: `task.test.ts OK`

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/task.ts src/task.test.ts
git commit -m "feat: enforce main discussion task policy"
```

---

### Task 3: Synchronize Main Workspace Name, Members, And Rule Task

**Files:**
- Create: `src/mainWorkspace.ts`
- Create: `src/mainWorkspace.test.ts`
- Modify: `src/workspace.ts:59-65`
- Modify: `src/server.ts:24-50,133-159,697-714`
- Modify: `src/test.ts:1-17`

- [ ] **Step 1: Write the failing synchronization test**

Create `src/mainWorkspace.test.ts` with this fixture, which registers all projections needed by the synchronizer and seeds the fixed aggregate with the old name:

```ts
const db = new DatabaseSync(':memory:');
runMigrations(db);
resetProjections();
registerWorkspaceProjections();
registerMemberProjections();
registerTaskProjections();

const insertUser = db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)');
insertUser.run('u01', MAIN_OWNER_EMAIL, '阿哲', 'x');
insertUser.run('u02', 'user02@test.local', '小美', 'x');
insertUser.run('u09', 'user09@test.local', '老闆', 'x');
appendEvent(
  'Workspace',
  MAIN_WORKSPACE_ID,
  0,
  'workspace.created',
  { name: 'Owner→阿哲 收件匣' },
  { actor_id: 'u01' },
  db,
);
seedOwner(MAIN_WORKSPACE_ID, 'u01', db);
inviteMember('u01', MAIN_WORKSPACE_ID, 'u09', 'Commenter', db);
joinWorkspace('u09', MAIN_WORKSPACE_ID, db);
```

Because Task 1 forbids assigning Member in the fixed workspace, create the historical user09 Member state by appending `member.role_changed` directly instead of calling `changeMemberRole()`:

```ts
const user09Aggregate = `${MAIN_WORKSPACE_ID}:u09`;
appendEvent(
  'Member',
  user09Aggregate,
  loadEvents(user09Aggregate, db).at(-1)!.aggregate_version,
  'member.role_changed',
  { workspaceId: MAIN_WORKSPACE_ID, userId: 'u09', role: 'Member' },
  { actor_id: 'u01' },
  db,
);

const legacyTaskId = 'legacy-main-task';
appendEvent('Task', legacyTaskId, 0, 'task.created', {
  workspaceId: MAIN_WORKSPACE_ID,
  projectId: null,
  title: 'workspace的封存功能',
  description: 'legacy discussion',
  status: 'Todo',
  priority: 'Medium',
  assigneeId: null,
  dueAt: null,
}, { actor_id: 'u01' }, db);
```

Then assert:

```ts
syncMainWorkspace(db);

const workspace = db.prepare(
  'SELECT name FROM workspaces_read_model WHERE workspace_id = ?',
).get(MAIN_WORKSPACE_ID) as { name: string };
assert.strictEqual(workspace.name, MAIN_WORKSPACE_NAME);
assert.throws(
  () => renameWorkspace('u01', MAIN_WORKSPACE_ID, '其他名稱', db),
  /主工作區名稱固定為主協作工作區/,
);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u01', db), 'Owner');
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u02', db), 'Commenter');
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u09', db), 'Commenter');
const legacyTask = getTask(legacyTaskId, db)!;
assert.strictEqual(legacyTask.title, '[討論] workspace的封存功能');
assert.strictEqual(loadEvents(legacyTaskId, db).at(-1)?.event_type, 'task.main_discussion_normalized');

const policy = listTasks(MAIN_WORKSPACE_ID, db).find((task) => task.title === MAIN_POLICY_TITLE);
assert.ok(policy);
assert.strictEqual(policy?.description, MAIN_POLICY_DESCRIPTION);

const before = (db.prepare('SELECT count(*) AS count FROM event_store').get() as { count: number }).count;
syncMainWorkspace(db);
const after = (db.prepare('SELECT count(*) AS count FROM event_store').get() as { count: number }).count;
assert.strictEqual(after, before, '重複同步不得追加事件');
```

Simulate a historical removal by appending `member.removed` directly to `u02`'s member aggregate, then verify login-time repair:

```ts
const memberAggregateId = `${MAIN_WORKSPACE_ID}:u02`;
const memberEvents = loadEvents(memberAggregateId, db);
appendEvent(
  'Member',
  memberAggregateId,
  memberEvents.at(-1)!.aggregate_version,
  'member.removed',
  { workspaceId: MAIN_WORKSPACE_ID, userId: 'u02' },
  { actor_id: 'u01' },
  db,
);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u02', db), null);
syncMainWorkspaceUser('u02', db);
assert.strictEqual(getMemberRole(MAIN_WORKSPACE_ID, 'u02', db), 'Commenter');
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `node --import tsx src/mainWorkspace.test.ts`

Expected: module-not-found failure for `src/mainWorkspace.ts`.

- [ ] **Step 3: Implement the minimum idempotent synchronizer**

Import `MAIN_WORKSPACE_ID` and `MAIN_WORKSPACE_NAME` in `src/workspace.ts`, then add this guard to `renameWorkspace()` after `validateName()` and before loading the aggregate:

```ts
if (id === MAIN_WORKSPACE_ID && clean !== MAIN_WORKSPACE_NAME) {
  throw new CommandError('主工作區名稱固定為主協作工作區');
}
```

Create `src/mainWorkspace.ts` with these public functions and no timer/background loop:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { db } from './db';
import { CommandError } from './eventStore';
import { inviteMember, joinWorkspace, changeMemberRole, getMemberRole } from './member';
import { renameWorkspace, getWorkspaceStatus } from './workspace';
import { createTask, changeTaskDescription, listTasks, normalizeMainDiscussion } from './task';
import {
  MAIN_OWNER_EMAIL,
  MAIN_POLICY_DESCRIPTION,
  MAIN_POLICY_TITLE,
  MAIN_WORKSPACE_ID,
  MAIN_WORKSPACE_NAME,
} from './mainWorkspacePolicy';

function mainOwner(database: DatabaseSync): { id: string } {
  if (getWorkspaceStatus(MAIN_WORKSPACE_ID, database) !== 'active') {
    throw new CommandError('主工作區不存在或不是 active');
  }
  const owner = database.prepare('SELECT id FROM users WHERE email = ?').get(MAIN_OWNER_EMAIL) as { id: string } | undefined;
  if (!owner || getMemberRole(MAIN_WORKSPACE_ID, owner.id, database) !== 'Owner') {
    throw new CommandError('user01 不存在或不是主工作區 Owner');
  }
  return owner;
}

function ensureCommenter(ownerId: string, userId: string, database: DatabaseSync): void {
  const current = getMemberRole(MAIN_WORKSPACE_ID, userId, database);
  if (current === 'Commenter') return;
  if (current) {
    changeMemberRole(ownerId, MAIN_WORKSPACE_ID, userId, 'Commenter', database);
    return;
  }
  try {
    joinWorkspace(userId, MAIN_WORKSPACE_ID, database);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    inviteMember(ownerId, MAIN_WORKSPACE_ID, userId, 'Commenter', database);
    joinWorkspace(userId, MAIN_WORKSPACE_ID, database);
  }
}

export function syncMainWorkspaceUser(userId: string, database = db): void {
  const owner = mainOwner(database);
  if (userId !== owner.id) ensureCommenter(owner.id, userId, database);
}

export function syncMainWorkspace(database = db): void {
  const owner = mainOwner(database);
  const workspace = database.prepare('SELECT name FROM workspaces_read_model WHERE workspace_id = ?')
    .get(MAIN_WORKSPACE_ID) as { name: string };
  if (workspace.name !== MAIN_WORKSPACE_NAME) {
    renameWorkspace(owner.id, MAIN_WORKSPACE_ID, MAIN_WORKSPACE_NAME, database);
  }
  const users = database.prepare('SELECT id FROM users ORDER BY id').all() as unknown as { id: string }[];
  for (const user of users) {
    if (user.id !== owner.id) ensureCommenter(owner.id, user.id, database);
  }
  const tasks = listTasks(MAIN_WORKSPACE_ID, database);
  for (const task of tasks) {
    if (task.status !== 'Archived' && task.title !== MAIN_POLICY_TITLE) {
      normalizeMainDiscussion(owner.id, task.task_id, database);
    }
  }
  const policy = tasks
    .find((task) => task.status !== 'Archived' && task.title === MAIN_POLICY_TITLE);
  if (!policy) {
    createTask(owner.id, MAIN_WORKSPACE_ID, { title: MAIN_POLICY_TITLE, description: MAIN_POLICY_DESCRIPTION }, database);
  } else if (policy.description !== MAIN_POLICY_DESCRIPTION) {
    changeTaskDescription(owner.id, policy.task_id, MAIN_POLICY_DESCRIPTION, database);
  }
}
```

- [ ] **Step 4: Wire startup and successful login without blocking either path**

In `src/server.ts`, add one logging wrapper:

```ts
function syncMainWorkspaceSafely(userId?: string): void {
  try {
    if (userId) syncMainWorkspaceUser(userId);
    else syncMainWorkspace();
  } catch (error) {
    console.error('[main-workspace] sync failed:', error);
  }
}
```

Call `syncMainWorkspaceSafely(userId)` after successful credential validation and before returning the login response. Call `syncMainWorkspaceSafely()` once before `server.listen()`.

- [ ] **Step 5: Register and run the test**

Add `import './mainWorkspace.test';` to `src/test.ts` immediately after `member.test` and before `task.test`.

Run: `node --import tsx src/mainWorkspace.test.ts`

Expected: `mainWorkspace.test.ts OK`

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/mainWorkspace.ts src/mainWorkspace.test.ts src/workspace.ts src/server.ts src/test.ts
git commit -m "feat: synchronize main collaboration workspace"
```

---

### Task 4: Apply The HTTP Permission Matrix

**Files:**
- Modify: `src/server.ts:277-637`
- Test: `src/member.test.ts:31-87`

- [ ] **Step 1: Extend middleware assertions for Commenter**

Create an active Commenter session in `src/member.test.ts`, then verify:

```ts
const commenterTok = createSession('eve', db);
cap = capture();
assert.strictEqual(
  requirePermission(fakeReq(commenterTok), cap.res, WS_REINVITE, ACCESS_ROLE.createComment, db),
  'eve',
);
cap = capture();
assert.strictEqual(
  requirePermission(fakeReq(commenterTok), cap.res, WS_REINVITE, ACCESS_ROLE.mutateTask, db),
  null,
);
assert.strictEqual(cap.get(), 403);
```

- [ ] **Step 2: Run the focused test**

Run: `node --import tsx src/member.test.ts`

Expected: PASS after Task 1; this locks the middleware behavior before route edits.

- [ ] **Step 3: Replace route thresholds with the tested access constants**

Import `ACCESS_ROLE` from `member.ts`, then apply exactly this mapping:

```ts
// workspace task list/create
requirePermission(req, res, workspaceId, ACCESS_ROLE.read);
requirePermission(req, res, workspaceId, ACCESS_ROLE.createTask);

// single task
const taskRole = req.method === 'GET' ? ACCESS_ROLE.read : ACCESS_ROLE.mutateTask;
requirePermission(req, res, workspaceId, taskRole);

// archive/delete task
requirePermission(req, res, workspaceId, ACCESS_ROLE.mutateTask);

// comment list/create/update/delete
requirePermission(req, res, workspaceId, ACCESS_ROLE.read);
requirePermission(req, res, workspaceId, ACCESS_ROLE.createComment);
requirePermission(req, res, ctx.workspace_id, ACCESS_ROLE.mutateOwnComment);

// project writes
requirePermission(req, res, workspaceId, ACCESS_ROLE.writeProject);

// attachment list/download and writes
requirePermission(req, res, workspaceId, ACCESS_ROLE.read);
requirePermission(req, res, workspaceId, ACCESS_ROLE.writeAttachment);
requirePermission(req, res, ctx.workspace_id, ACCESS_ROLE.writeAttachment);
```

Keep the existing comment ownership check after the Commenter role check. Do not lower workspace/member management or audit endpoints.

- [ ] **Step 4: Run backend tests and build**

Run: `npm test`

Expected: every `src/*.test.ts` and `sim/run.test.ts` prints `OK`; exit 0.

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/server.ts src/member.test.ts
git commit -m "feat: apply Commenter API permissions"
```

---

### Task 5: Make The Browser UI Role-Aware And Link Handoffs Safely

**Files:**
- Modify: `public/js/state.js:7-17,30-81`
- Modify: `public/js/views/kanban.js:21-83,89-164,166-239,248-380,504-529,540-581`
- Modify: `public/js/views/task-detail.js:1-23,229-321,323-608,612-821,1048-1120`
- Modify: `public/js/views/members.js:17-176`
- Modify: `public/css/kanban.css`
- Test: `src/frontend.test.ts:169-212,223-379`

- [ ] **Step 1: Add failing frontend policy and URL tests**

Expose `safeHttpUrl()` through the existing VM transform in `src/frontend.test.ts`, put the native `URL` constructor in the sandbox, and assert:

```ts
assert.strictEqual(safeHttpUrl('https://example.com/tracker/#/task/abc'), 'https://example.com/tracker/#/task/abc');
assert.strictEqual(safeHttpUrl('http://localhost:3000/#/task/abc'), 'http://localhost:3000/#/task/abc');
assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);
assert.strictEqual(safeHttpUrl('not-a-url'), null);
```

Open the modal as `currentRole: 'Commenter'` in the fixed workspace and assert no task save/status/upload controls exist while the comment submit button still exists:

```ts
assert.strictEqual(findElement(overlay, (node) => node.textContent === '儲存'), null);
assert.strictEqual(findElement(overlay, (node) => node.className === 'status-change-btn'), null);
assert.strictEqual(findElement(overlay, (node) => node.textContent === '上傳附件'), null);
assert.ok(findElement(overlay, (node) => node.textContent === '留言'));
```

- [ ] **Step 2: Run the frontend test and confirm it fails**

Run: `node --import tsx src/frontend.test.ts`

Expected: `safeHttpUrl` and role-aware controls are not defined yet.

- [ ] **Step 3: Add shared browser policy constants**

In `public/js/state.js`:

```js
export const ROLE_RANK = Object.freeze({ Viewer: 0, Commenter: 1, Member: 2, Admin: 3, Owner: 4 });
export const ROLES = Object.keys(ROLE_RANK);
export const hasRole = (role, minimum) => ROLE_RANK[role] >= ROLE_RANK[minimum];
export const MAIN_WORKSPACE_ID = '11a82028-fc50-466a-a723-e002032cd9a6';
export const MAIN_OWNER_EMAIL = 'user01@test.local';
export const MAIN_POLICY_TITLE = '[規則] 主工作區協作與交接';
```

- [ ] **Step 4: Restrict Kanban controls and show the fixed banner**

After members load, derive the current role and capabilities:

```js
const currentMember = members.find(member => member.email === state.userEmail);
currentRole = currentMember ? currentMember.role : 'Viewer';
const isMainWorkspace = state.workspaceId === MAIN_WORKSPACE_ID;
const canCreateTask = hasRole(currentRole, 'Commenter');
const canManageTask = hasRole(currentRole, 'Member')
  && (!isMainWorkspace || state.userEmail === MAIN_OWNER_EMAIL);
```

For the main workspace, render a full-width `.main-workspace-policy` band above `#task-error` with these five lines: only discussion here, all users can create Todo/comment, only user01 changes state, starting assigns user01, and accepted work first identifies the target repo then uses its canonical/corresponding workspace and links back.

Build inline adders only for `['Todo']` when the current user is Commenter or the workspace is main; preserve `['Todo', 'Doing', 'Review']` for Member+ in other workspaces. Commenter POST body must be exactly:

```js
{ title, description: '' }
```

Only append project creation, transition, archive, and delete controls when `canManageTask` is true. Skip the old unassigned check for `Todo -> Doing` when `isMainWorkspace && state.userEmail === MAIN_OWNER_EMAIL`.

Sort a copy of the filtered tasks before rendering:

```js
const ordered = [...filtered].sort((a, b) =>
  Number(b.title === MAIN_POLICY_TITLE) - Number(a.title === MAIN_POLICY_TITLE));
```

- [ ] **Step 5: Restrict task detail and member management controls**

Pass `currentRole` and `isMainWorkspace` into `openTaskDetailModal()`. In the modal calculate the same `canManageTask`; when false:

- render title/description as readonly text and omit the save button;
- render the status badge without transition buttons;
- render priority, assignee, and due date as text instead of form controls;
- keep attachment download links but omit upload and delete buttons;
- keep comment create/edit/delete-own controls for Commenter+.

In `members.js`, derive the current member after loading rows. Show invite/role/remove controls only for Admin+ and never in `MAIN_WORKSPACE_ID`; all other users receive the same member table without mutation controls. The invite role list continues to default to `Member` and now includes `Commenter`.

- [ ] **Step 6: Add safe HTTP(S) URL rendering**

In `task-detail.js`, add:

```js
export function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
```

Extend the rich-text tokenizer regex with `(https?:\\/\\/[^\\s<>"']+)`. For a URL token, call `safeHttpUrl(part)` and append either an anchor or a text node:

```js
const href = safeHttpUrl(part);
if (href) {
  fragment.appendChild(el('a', {
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
    class: 'rich-url-link',
  }, part));
} else {
  fragment.appendChild(document.createTextNode(part));
}
```

- [ ] **Step 7: Add restrained banner CSS and run frontend checks**

Add a full-width, non-card banner with a stable border and responsive wrapping:

```css
.main-workspace-policy {
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  border-left: 4px solid #176b4d;
  background: #eef8f2;
  color: #18352a;
  line-height: 1.5;
}

.main-workspace-policy strong {
  display: block;
  margin-bottom: 0.25rem;
}
```

Run: `node --import tsx src/frontend.test.ts`

Expected: `frontend.test.ts OK`

Run: `npm run lint`

Expected: exit 0.

- [ ] **Step 8: Verify desktop and mobile behavior with Playwright CLI**

Run the app, then:

```bash
playwright-cli open http://localhost:3000/
playwright-cli resize 1440 900
playwright-cli snapshot
playwright-cli screenshot --filename=/tmp/main-workspace-commenter-desktop.png
playwright-cli resize 390 844
playwright-cli snapshot
playwright-cli screenshot --filename=/tmp/main-workspace-commenter-mobile.png
playwright-cli console
playwright-cli close
```

Log in as `user02@test.local`, open the main workspace, verify only Todo add/comment controls are actionable and no text overlaps. Repeat as `user01@test.local` and verify `Todo -> Doing` succeeds without pre-assignment and the resulting card shows user01 as assignee.

- [ ] **Step 9: Commit Task 5**

```bash
git add public/js/state.js public/js/views/kanban.js public/js/views/task-detail.js public/js/views/members.js public/css/kanban.css src/frontend.test.ts
git commit -m "feat: add Commenter collaboration UI"
```

---

### Task 6: Teach Sweep The Main Workspace Discussion Flow

**Files:**
- Modify: `sim/run.ts:9-24,170-202,561-608,1209-1284,1362-1368`
- Test: `sim/run.test.ts:7-38,197-214`

- [ ] **Step 1: Write failing main-workspace policy tests while retaining the existing canonical tests**

Do not rewrite the `4902e28` assertions for `canonicalWorkspaceForRepoRoot()` and `ensureCanonicalWorkspaceCandidates()`. Export and test these additional helpers:

```ts
const candidates = new Map<string, { key: string; startedAt: string }>();
ensureMainWorkspaceCandidate(candidates);
assert.strictEqual(candidates.get(MAIN_WORKSPACE_ID)?.key, 'self-directed');

assert.strictEqual(isSweepWorkTask({ title: MAIN_POLICY_TITLE }), false);
assert.strictEqual(isSweepWorkTask({ title: '[討論] 方向' }), false);
assert.strictEqual(isSweepWorkTask({ title: '實作功能' }), true);

assert.strictEqual(mainDiscussionNeedsOwner('Todo', 'u01', 'u01'), true);
assert.strictEqual(mainDiscussionNeedsOwner('Doing', 'u02', 'u01'), true);
assert.strictEqual(mainDiscussionNeedsOwner('Doing', 'u01', 'u01'), false);

const directory = canonicalWorkspaceDirectory();
assert.match(directory, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(directory, /d9da9945-ce5f-400f-806e-1d75e95e313a/);

const ordered = [
  { wsId: 'ordinary-new', startedAt: '2026-07-11T00:00:00.000Z' },
  { wsId: 'timed-out', startedAt: '1970-01-01T00:00:00.000Z' },
  { wsId: EXPECTED_ROOT_WORKSPACE_ID, startedAt: '1970-01-01T00:00:00.000Z' },
  { wsId: MAIN_WORKSPACE_ID, startedAt: '1970-01-01T00:00:00.000Z' },
].sort((a, b) => compareSweepCandidates(a, b, ['timed-out']));
assert.deepStrictEqual(ordered.map((item) => item.wsId), [
  'timed-out',
  MAIN_WORKSPACE_ID,
  EXPECTED_ROOT_WORKSPACE_ID,
  'ordinary-new',
]);
```

- [ ] **Step 2: Run the sim test and confirm it fails**

Run: `node --import tsx sim/run.test.ts`

Expected: missing exported helper failures.

- [ ] **Step 3: Implement candidate, task filtering, and wake rules**

Import the shared main policy constants. Add:

```ts
export function ensureMainWorkspaceCandidate(
  candidates: Map<string, { key: string; startedAt: string }>,
): void {
  if (!candidates.has(MAIN_WORKSPACE_ID)) {
    candidates.set(MAIN_WORKSPACE_ID, { key: 'self-directed', startedAt: '1970-01-01T00:00:00.000Z' });
  }
}

export function isSweepWorkTask(task: { title: string }): boolean {
  return task.title !== MAIN_POLICY_TITLE && !task.title.startsWith(MAIN_DISCUSSION_PREFIX);
}

export function mainDiscussionNeedsOwner(
  status: string,
  latestCommentUserId: string | undefined,
  ownerId: string,
): boolean {
  return status === 'Todo' || latestCommentUserId !== ownerId;
}

export function canonicalWorkspaceDirectory(): string {
  const entries = Object.entries(CANONICAL_WORKSPACE_BY_REPOROOT);
  return entries.length
    ? entries.map(([repoRoot, workspaceId]) => `- ${repoRoot} -> workspace ${workspaceId}`).join('\n')
    : '- （目前沒有登記）';
}

export function compareSweepCandidates(
  a: { wsId: string; startedAt: string },
  b: { wsId: string; startedAt: string },
  timedOutWs: string[],
): number {
  const canonicalIds = Object.values(CANONICAL_WORKSPACE_BY_REPOROOT);
  const score = (item: { wsId: string }) => {
    if (timedOutWs.includes(item.wsId)) return 3;
    if (item.wsId === MAIN_WORKSPACE_ID) return 2;
    if (canonicalIds.includes(item.wsId)) return 1;
    return 0;
  };
  const priority = score(b) - score(a);
  return priority || b.startedAt.localeCompare(a.startedAt);
}
```

Insert `ensureMainWorkspaceCandidate(wsScenario)` immediately before the existing `ensureCanonicalWorkspaceCandidates(wsScenario)` call added by `4902e28`. Keep both calls exactly once, so main workspace and canonical workspaces are all discovered without `report.json`. See `docs/superpowers/plans/2026-07-10-crossrepo-workspace-routing.md`. Exclude `[規則]` and `[討論]` with `isSweepWorkTask()` in both initial and post-owner task scans.

For the fixed workspace, load user01's runtime id and use `mainDiscussionNeedsOwner()`; for every other workspace, preserve the existing user09 latest-comment behavior.

Replace the inline `pendings.sort()` comparator with `compareSweepCandidates(a, b, ownerState.timedOutWs)`. This keeps timeout recovery first while preventing main/canonical epoch candidates from starving behind continually newer workspaces.

- [ ] **Step 4: Replace the contradictory main owner instructions**

Add a main-workspace branch at the start of `ownerSweepPrompt()`. Its prompt must direct user01 to:

1. ignore `[規則]` as work;
2. read each active `[討論]` task;
3. move Todo to Doing, relying on automatic assignment;
4. reply to discussion without editing code or assigning a member in the main workspace;
5. after agreement, first identify the target repository from the discussion; show `canonicalWorkspaceDirectory()` in the prompt and use the workspace mapped to that target repo when an exact mapping exists;
6. never default every discussion to `ROOT`: the main workspace can discuss any repository; when the target repo is not registered, find a matching existing workspace or create one, and note `未登記，人工介入選定` in the discussion comment;
7. use existing workspace/task APIs to create the implementation task, with source discussion URL and target repo in its description;
8. post the complete `http://localhost:3000/#/task/<id>` URL to the original discussion;
9. move the original discussion through Review to Done using legal adjacent transitions.

Do not place the old instruction that `[討論]` tasks always remain Todo in the new main-workspace prompt. Keep that instruction in the existing default prompt so other workspaces retain their current behavior. Add this short policy line to `API_RULES()` so every owner/member agent knows the boundary:

```text
- 主協作工作區（11a82028-fc50-466a-a723-e002032cd9a6）只放討論；非 user01 不改狀態，實作 task 必須建立在目標工作區。
```

- [ ] **Step 5: Run sim and full checks**

Run: `node --import tsx sim/run.test.ts`

Expected: `sim/run.test.ts OK`

Run: `npm run typecheck`

Expected: exit 0, including `sim/tsconfig.json`.

- [ ] **Step 6: Commit Task 6**

```bash
git add sim/run.ts sim/run.test.ts
git commit -m "feat(sim): sweep main workspace discussions"
```

---

### Task 7: Verify The Feature Branch And Prepare Integration Docs

**Files:**
- Modify: `TASKS_V2.md`
- Modify: `docs/operations.md`
- Modify: `docs/superpowers/specs/2026-07-10-commenter-main-workspace-design.md:3-8`

- [ ] **Step 1: Run the full branch gate**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all commands exit 0; all assert suites print `OK`.

- [ ] **Step 2: Verify no-history discovery without spending model quota**

Run: `node --import tsx sim/run.test.ts`

Expected: the empty-`Map` assertions prove both main and canonical workspaces are registered without `report.json`; exit 0. Do not run a live owner LLM session here.

- [ ] **Step 3: Document only branch-verified work**

Append `Phase 15 - Commenter 與主協作工作區治理` to `TASKS_V2.md`. Check RBAC, synchronization, domain rules, UI, URL handoff, sweep unit tests, `npm test`, and build. Keep deployment, DB read-back, HTTP smoke, and live owner sweep unchecked.

Add this operations section:

```markdown
## 主協作工作區

- 固定 UUID：`11a82028-fc50-466a-a723-e002032cd9a6`
- 固定名稱：`主協作工作區`
- `user01@test.local` 是唯一 Owner；其餘現有 users 由啟動／登入同步為 Commenter。
- 所有人可建立 `[討論]` Todo 與留言；只有 user01 可改狀態。
- Todo -> Doing 會在單一事件中指派 user01。
- 決議後先判斷 target repo，再查 `CANONICAL_WORKSPACE_BY_REPOROOT`；有登記就使用該 workspace，未登記才找既有 workspace 或新增，並回貼完整 URL。
- `[規則] 主工作區協作與交接` 不屬於 sweep 工作，缺少或內容過期時由啟動同步修正。
- sim sweep timers 由操作人員控制，本功能不得自動 enable。
```

Change the design spec status to `實作完成，待合併後 rollout 驗收`; do not claim HTTP smoke or live sweep success.

- [ ] **Step 4: Re-run the branch gate after documentation edits**

Run:

```bash
npm test
npm run build
git diff --check
git status --short
```

Expected: tests/build/diff check exit 0; status lists only the intended Task 7 documentation files.

- [ ] **Step 5: Commit Task 7**

```bash
git add TASKS_V2.md docs/operations.md docs/superpowers/specs/2026-07-10-commenter-main-workspace-design.md
git commit -m "docs: document main collaboration workflow"
```

- [ ] **Step 6: Use the finishing workflow; do not deploy from the linked worktree**

Use `superpowers:finishing-a-development-branch` to review and integrate the feature branch. `task-tracker.service` runs `/home/hom/code/task-tracker/dist/server.js`, so restarting it before the feature reaches `master` would test old code.

---

### Task 8: Post-Merge Rollout And HTTP Smoke

**Files:**
- Modify after verification: `TASKS_V2.md`
- Modify after verification: `docs/superpowers/specs/2026-07-10-commenter-main-workspace-design.md`

- [ ] **Step 1: Confirm the implementation is integrated into a clean master**

Run:

```bash
git branch --show-current
git status --short
git log --oneline --grep='feat: add Commenter workspace role' -1
git log --oneline --grep='feat(sim): sweep main workspace discussions' -1
```

Expected: branch is `master`, status has no output, and both implementation commits are present. Stop if any condition fails.

- [ ] **Step 2: Build, restart, and verify synchronization state**

Run:

```bash
npm test
npm run build
systemctl --user restart task-tracker.service
systemctl --user is-active task-tracker.service
curl -sS http://127.0.0.1:3000/api/health
```

Expected: tests/build exit 0, service is `active`, and health JSON contains `"status":"ok"` and `"db":true`.

Run this DB read-back:

```bash
node - <<'NODE'
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/dev.db', { readOnly: true });
const workspaceId = '11a82028-fc50-466a-a723-e002032cd9a6';
const workspace = db.prepare('SELECT name, status FROM workspaces_read_model WHERE workspace_id = ?').get(workspaceId);
assert.strictEqual(workspace.name, '主協作工作區');
assert.strictEqual(workspace.status, 'active');
const userCount = db.prepare('SELECT count(*) AS count FROM users').get().count;
const members = db.prepare(`
  SELECT u.email, m.role
    FROM workspace_members_read_model m
    JOIN users u ON u.id = m.user_id
   WHERE m.workspace_id = ?
`).all(workspaceId);
assert.strictEqual(members.length, userCount);
assert.strictEqual(members.filter((member) => member.email === 'user01@test.local' && member.role === 'Owner').length, 1);
assert.ok(members.filter((member) => member.email !== 'user01@test.local').every((member) => member.role === 'Commenter'));
const policyCount = db.prepare(`
  SELECT count(*) AS count FROM tasks_read_model
   WHERE workspace_id = ? AND title = ? AND status <> 'Archived'
`).get(workspaceId, '[規則] 主工作區協作與交接').count;
assert.strictEqual(policyCount, 1);
const legacy = db.prepare(`
  SELECT task_id, title FROM tasks_read_model
   WHERE task_id IN (?, ?)
`).all('de228444-7c30-4252-92e2-7d21896767fc', '1f369e88-669a-44c9-85b8-c52a9c63a018');
assert.strictEqual(legacy.length, 2);
assert.ok(legacy.every((task) => task.title.startsWith('[討論] ')));
db.close();
NODE
```

Expected: exit 0 with no assertion error.

- [ ] **Step 3: Run HTTP smoke as Commenter and owner**

Run this exact smoke flow against the integrated service. This case declares task-tracker as the target repo, so it must use the registered canonical workspace instead of creating another workspace:

```bash
BASE=http://127.0.0.1:3000
MAIN_WS=11a82028-fc50-466a-a723-e002032cd9a6
TARGET_REPO=/home/hom/code/task-tracker
TARGET_WS=d9da9945-ce5f-400f-806e-1d75e95e313a

curl -sS -c /tmp/user02.jar -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"user02@test.local","password":"test1234"}'
CREATE_JSON=$(curl -sS -b /tmp/user02.jar -X POST "$BASE/api/workspaces/$MAIN_WS/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Commenter smoke","description":"target repo: /home/hom/code/task-tracker"}')
TASK_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id)" "$CREATE_JSON")

COMMENT_JSON=$(curl -sS -b /tmp/user02.jar -X POST "$BASE/api/tasks/$TASK_ID/comments" \
  -H 'Content-Type: application/json' -d '{"content":"第一則討論"}')
COMMENT_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id)" "$COMMENT_JSON")
test "$(curl -sS -o /tmp/own-comment.json -w '%{http_code}' -b /tmp/user02.jar \
  -X PATCH "$BASE/api/comments/$COMMENT_ID" -H 'Content-Type: application/json' \
  -d '{"content":"已更新的討論"}')" = 200

test "$(curl -sS -o /tmp/commenter-extra.json -w '%{http_code}' -b /tmp/user02.jar \
  -X POST "$BASE/api/workspaces/$MAIN_WS/tasks" -H 'Content-Type: application/json' \
  -d '{"title":"非法欄位","priority":"High"}')" = 400
test "$(curl -sS -o /tmp/commenter-patch.json -w '%{http_code}' -b /tmp/user02.jar \
  -X PATCH "$BASE/api/tasks/$TASK_ID" -H 'Content-Type: application/json' -d '{"status":"Doing"}')" = 403
test "$(curl -sS -o /tmp/commenter-archive.json -w '%{http_code}' -b /tmp/user02.jar \
  -X POST "$BASE/api/tasks/$TASK_ID/archive")" = 403
test "$(curl -sS -o /tmp/commenter-project.json -w '%{http_code}' -b /tmp/user02.jar \
  -X POST "$BASE/api/workspaces/$MAIN_WS/projects" -H 'Content-Type: application/json' \
  -d '{"name":"不可建立"}')" = 403
test "$(curl -sS -o /tmp/commenter-attachment.json -w '%{http_code}' -b /tmp/user02.jar \
  -X POST "$BASE/api/tasks/$TASK_ID/attachments" -H 'X-Filename: smoke.txt' \
  -H 'Content-Type: text/plain' --data-binary 'x')" = 403

curl -sS -c /tmp/user01.jar -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"user01@test.local","password":"test1234"}'
ME_JSON=$(curl -sS -b /tmp/user01.jar "$BASE/api/auth/me")
USER01_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id)" "$ME_JSON")
curl -sS -b /tmp/user01.jar -X PATCH "$BASE/api/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' -d '{"status":"Doing"}'
TASK_JSON=$(curl -sS -b /tmp/user01.jar "$BASE/api/tasks/$TASK_ID")
node -e "const task=JSON.parse(process.argv[1]); if(task.status!=='Doing'||task.assignee_id!==process.argv[2]) process.exit(1)" \
  "$TASK_JSON" "$USER01_ID"

OWNER_COMMENT_JSON=$(curl -sS -b /tmp/user01.jar -X POST "$BASE/api/tasks/$TASK_ID/comments" \
  -H 'Content-Type: application/json' -d '{"content":"user01 smoke comment"}')
OWNER_COMMENT_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id)" "$OWNER_COMMENT_JSON")
test "$(curl -sS -o /tmp/other-comment.json -w '%{http_code}' -b /tmp/user02.jar \
  -X PATCH "$BASE/api/comments/$OWNER_COMMENT_ID" -H 'Content-Type: application/json' \
  -d '{"content":"不可修改"}')" = 403

TARGET_TASK_JSON=$(curl -sS -b /tmp/user01.jar -X POST "$BASE/api/workspaces/$TARGET_WS/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"實作 Commenter smoke 決議\",\"description\":\"來源：$BASE/#/task/$TASK_ID；target repo：$TARGET_REPO\"}")
TARGET_TASK_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id)" "$TARGET_TASK_JSON")
curl -sS -b /tmp/user01.jar -X POST "$BASE/api/tasks/$TASK_ID/comments" \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"交接：$BASE/#/task/$TARGET_TASK_ID\"}"
curl -sS -b /tmp/user01.jar -X PATCH "$BASE/api/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' -d '{"status":"Review"}'
curl -sS -b /tmp/user01.jar -X PATCH "$BASE/api/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' -d '{"status":"Done"}'
FINAL_JSON=$(curl -sS -b /tmp/user01.jar "$BASE/api/tasks/$TASK_ID")
node -e "if(JSON.parse(process.argv[1]).status!=='Done') process.exit(1)" "$FINAL_JSON"
```

Expected: every `test` and `node` assertion exits 0; the discussion is Done and links to a target task in the canonical task-tracker workspace.

- [ ] **Step 4: Keep live sweep opt-in**

The pure sweep tests are mandatory and already run. Because `sim-sweep-owner.timer` and `sim-sweep-team.timer` are intentionally disabled, do not enable them. Run a live `npm run sim -- --sweep owner` only after explicit user approval; otherwise leave live sweep observation pending.

- [ ] **Step 5: Record verified rollout results**

After Steps 1-3 pass, check the deployment, DB read-back, and HTTP smoke entries in `TASKS_V2.md`. Change the design spec status to `已實作並驗收`. Keep live owner sweep unchecked when Step 4 was not authorized.

Run `git diff --check`, then commit only those follow-up documentation changes:

```bash
git add TASKS_V2.md docs/superpowers/specs/2026-07-10-commenter-main-workspace-design.md
git commit -m "docs: record main workspace rollout verification"
```

---

## Scope Boundary

This plan deliberately does not add a permission table, handoff API, task relation schema, workspace move command, background scheduler, or URL parsing dependency. It reuses the code-based canonical workspace registry introduced by `4902e28`; it does not add a second registry. Add a formal handoff relation only when the product needs cross-discussion reporting that cannot be answered from comments.
