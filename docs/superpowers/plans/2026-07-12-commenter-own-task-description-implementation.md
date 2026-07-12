# Commenter Own Task Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a Commenter in any workspace to edit only the description of a task they created, without changing workspace role synchronization.

**Architecture:** Reuse the creator ID already stored in the `task.created` event metadata and attach it to task query results. The HTTP route admits description-only PATCH requests at Commenter level, while the task command enforces ownership; the task detail UI exposes only the description editor for the matching creator.

**Tech Stack:** TypeScript, Node SQLite event store, Node assert tests, browser JavaScript DOM harness.

---

### Task 1: Task Creator Query And Domain Guard

**Files:**
- Modify: `src/task.test.ts`
- Modify: `src/task.ts`

- [ ] **Step 1: Write the failing domain tests**

Add a second Commenter fixture and assert creator projection plus description ownership:

```ts
insertMember.run(COMMENTER_WS, 'other-commenter', 'Commenter', 't');
const ownTask = createTask('main-user', COMMENTER_WS, { title: 'Own', description: 'before' }, db);
assert.strictEqual(getTask(ownTask, db)?.creator_id, 'main-user');
changeTaskDescription('main-user', ownTask, 'after', db);
assert.strictEqual(getTask(ownTask, db)?.description, 'after');
assert.throws(
  () => changeTaskDescription('other-commenter', ownTask, 'blocked', db),
  { name: 'CommandError', message: 'Commenter 只能修改自己建立 task 的描述' },
);
```

Also assert a historical `task.created` event without `metadata.actor_id` returns `creator_id: null` and is not editable by a Commenter.

- [ ] **Step 2: Run the domain test and verify RED**

Run: `node --import tsx src/task.test.ts`

Expected: FAIL because `creator_id` is absent and another Commenter can still change the description.

- [ ] **Step 3: Add the minimal creator lookup and ownership guard**

In `src/task.ts`, derive the creator from the existing first event without changing schema:

```ts
function taskCreatorId(taskId: string, database: DatabaseSync): string | null {
  const created = loadEvents(taskId, database).find((event) => event.event_type === 'task.created');
  const actorId = (created?.metadata as { actor_id?: unknown } | undefined)?.actor_id;
  return typeof actorId === 'string' && actorId ? actorId : null;
}
```

Add `creator_id: string | null` to `TaskRow`, attach it in `listTasks()` and `getTask()`, and in `changeTaskDescription()` reject only when the actor's current workspace role is Commenter and `creator_id !== actorId`. Keep the existing editable/archive/workspace checks before appending `task.description_changed`.

- [ ] **Step 4: Run the domain test and verify GREEN**

Run: `node --import tsx src/task.test.ts`

Expected: `task.test.ts OK`.

- [ ] **Step 5: Commit the domain change**

```bash
git add src/task.ts src/task.test.ts
git commit -m "feat: allow Commenter own task description edits"
```

### Task 2: Description-Only HTTP Permission

**Files:**
- Modify: `src/server.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Write the failing permission tests**

Add a pure exported route helper and tests that specify the only lowered permission:

```ts
assert.strictEqual(taskPatchRole({ description: 'updated' }), 'Commenter');
assert.strictEqual(taskPatchRole({ title: 'renamed' }), 'Member');
assert.strictEqual(taskPatchRole({ status: 'Doing' }), 'Member');
assert.strictEqual(taskPatchRole({ description: 'x', title: 'y' }), 'Member');
assert.strictEqual(taskPatchRole({}), 'Member');
```

- [ ] **Step 2: Run the server test and verify RED**

Run: `node --import tsx src/server.test.ts`

Expected: FAIL because `taskPatchRole` does not exist.

- [ ] **Step 3: Route description-only PATCH through Commenter permission**

Add the minimal helper in `src/server.ts`:

```ts
export function taskPatchRole(body: Record<string, unknown>): 'Commenter' | 'Member' {
  return Object.keys(body).length === 1 && 'description' in body ? 'Commenter' : 'Member';
}
```

For `PATCH /api/tasks/:id`, parse the body before permission selection, call `requirePermission()` with `taskPatchRole(body)`, then call `applyTaskPatch()`. Keep GET at Viewer and DELETE at Member. Invalid or multi-field PATCH bodies must not receive Commenter permission.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --import tsx src/server.test.ts && node --import tsx src/task.test.ts`

Expected: both tests print `OK`.

- [ ] **Step 5: Commit the HTTP change**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: admit Commenter description-only task patches"
```

### Task 3: Role-Aware Description Editor And Documentation

**Files:**
- Modify: `src/frontend.test.ts`
- Modify: `public/js/views/task-detail.js`
- Modify: `TASKS_V2.md`
- Modify: `docs/operations.md`
- Modify: `docs/superpowers/specs/2026-07-12-commenter-own-task-description-design.md`

- [ ] **Step 1: Write the failing frontend test**

Add a Commenter-owned task fixture with `creator_id: 'user-1'`, current member email matching `state.userEmail`, and assert:

```ts
assert.ok(findElement(overlay, (node) => node.tag === 'textarea' && node.value === 'Own description'));
assert.ok(findElement(overlay, (node) => node.tag === 'button' && node.textContent === '儲存'));
assert.strictEqual(findElement(overlay, (node) => node.tag === 'input'), null);
assert.strictEqual(findElement(overlay, (node) => node.classList.contains('status-change-btn')), null);
```

Keep the existing non-owner Commenter fixture without a matching creator and assert it has no task save button.

- [ ] **Step 2: Run the frontend test and verify RED**

Run: `node --import tsx src/frontend.test.ts`

Expected: FAIL because the owned Commenter task still renders a read-only description.

- [ ] **Step 3: Render only the owned description editor**

In `task-detail.js`, find the current member from `cachedMembers` and calculate:

```js
const currentUserId = cachedMembers.find(
  (member) => member.email.trim().toLowerCase() === state.userEmail
)?.user_id;
const canEditDescription = canManageTask
  || (currentRole === 'Commenter' && currentTask.creator_id === currentUserId);
```

Render the title input only for `canManageTask`; otherwise render the existing read-only title. Render the textarea and save control for `canEditDescription`; otherwise render the read-only description. Update `saveTask()` so a missing `titleInput` uses `currentTask.title` and never sends a title PATCH.

- [ ] **Step 4: Update the existing docs**

- Add the completed behavior and verification to Phase 15 in `TASKS_V2.md`.
- Add the Commenter self-created description rule to `docs/operations.md`.
- Change the design status to implemented after all checks pass.
- Keep the explicit rule that only the main workspace synchronizes non-user01 users to Commenter.

- [ ] **Step 5: Run the complete verification gate**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit UI and documentation**

```bash
git add src/frontend.test.ts public/js/views/task-detail.js TASKS_V2.md docs/operations.md docs/superpowers/specs/2026-07-12-commenter-own-task-description-design.md
git commit -m "docs: document Commenter owned description editing"
```

### Task 4: Deployment Smoke

**Files:**
- Modify after verification: `TASKS_V2.md`
- Modify after verification: `docs/operations.md`

- [ ] **Step 1: Recheck automation is stopped**

Run `systemctl --user is-active` for owner/team timers, services, and the one-shot audit. Stop if any unit is active.

- [ ] **Step 2: Restart and verify the service**

Run:

```bash
systemctl --user restart task-tracker.service
curl -sS http://127.0.0.1:3000/api/health
```

Expected: `{"status":"ok","db":true}`.

- [ ] **Step 3: Run a minimal HTTP smoke**

As a Commenter, create a task, PATCH its description successfully, verify title/status PATCH returns 403, and verify changing another Commenter's task description returns 400. Verify another workspace's existing Member behavior is unchanged.

- [ ] **Step 4: Record rollout and commit**

Mark smoke evidence in `TASKS_V2.md` and `docs/operations.md`, run `git diff --check`, then commit:

```bash
git add TASKS_V2.md docs/operations.md
git commit -m "docs: record Commenter description rollout"
```
