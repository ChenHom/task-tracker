# Goal-driven Agent Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend task-tracker so one long-lived Project with one registered repository can carry multiple durable Goals, two-round Agent discussion, budget records, existing production-coordinator delivery, and visible Goal/Agent state.

**Architecture:** Keep Project as validated CRUD and Task/Goal as event-sourced aggregates in the existing SQLite database. Add one small orchestration layer that persists heartbeat and Run state before invoking bounded discussion or implementation runners; reuse the production coordinator for Git, CI, merge, deployment, and readback. Ship the UI and disabled timer only after domain and coordinator gates are proven with fake runners.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, current event store/projection pattern, plain browser ES modules, current production coordinator, systemd user units.

---

## File map

| Path | Responsibility |
| --- | --- |
| `src/schema.ts` | Add Project fields and Goal/Agent/Run persistence tables and indexes through idempotent migrations. |
| `src/repoRegistry.ts` | Parse the operator-owned registered-repository JSON and expose target path, checks and deployment policy. |
| `src/project.ts` | Validate registered repository, update/archive Project, and enforce archive guards. |
| `src/task.ts` | Validate and mutate Task `projectId`; persist optional `goalId` and delivery policy. |
| `src/goal.ts` | Goal aggregate, transition table, repo lease, revisions, cancellation, follow-up deduplication, projections and queries. |
| `src/agent.ts` | Six seeded Agent resources, route/status mutation, selection eligibility and queries. |
| `src/goalRun.ts` | Heartbeat/Run/Participation/Contribution commands, idempotency and usage records. |
| `src/goalOrchestrator.ts` | Owner scoping, round completion, synthesis transaction, verification and follow-up decisions. |
| `src/server.ts` | Permission-checked Project, Goal and Agent HTTP routes. |
| `sim/goalAdapters.ts` | Common implementation-runner preflight/estimate/result normalization for Claude, Codex and AGY. |
| `sim/goalDiscussion.ts` | Bounded safe-Claude context and Contribution validation without board mutation credentials. |
| `sim/production.ts`, `sim/production/policy.ts` | Read Project repo/check registry, skip non-Executing Goal Tasks, and reject legacy conflicts. |
| `public/js/views/kanban.js`, `public/js/views/task-detail.js`, `public/js/views/workspaces.js` | Project context, accessible Project dialog, Task Project reassignment, and archived Workspace visibility. |
| `public/js/views/goals.js`, `public/js/views/agents.js` | Goal history/control and Agent status/route views. |
| `public/js/routes.js`, `public/js/sidebar.js`, `public/index.html`, `public/css/*.css` | Register and expose the new views with keyboard/touch-capable controls. |
| `deploy/goal-discovery.service`, `deploy/goal-discovery.timer` | Disabled-by-default 12-hour discovery entry point. |
| `docs/api.md`, `docs/operations.md`, `docs/tasks/current.md`, `CHANGELOG.md` | Public API, operation and delivery contracts. |

## Task 1: Strengthen Project and Task ownership

**Files:**
- Modify: `src/schema.ts`
- Create: `src/repoRegistry.ts`
- Create: `src/repoRegistry.test.ts`
- Modify: `src/project.ts`
- Modify: `src/project.test.ts`
- Modify: `src/task.ts`
- Modify: `src/task.test.ts`
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [x] **Step 1: Write failing Project migration and domain tests**

Add assertions that an existing Project row migrates to `description=''`, `status='active'`, `target_repo=null`, and non-empty timestamps. Add tests using an injected registry:

```ts
const repos = new Set(['/srv/app']);
const id = createProject('ws-1', {
  name: 'Backend', description: 'API work', targetRepo: '/srv/app',
}, db, repos);
const project = getProject(id, db)!;
assert.deepStrictEqual({ ...project, created_at: '', updated_at: '' }, {
  project_id: id, workspace_id: 'ws-1', name: 'Backend',
  description: 'API work', status: 'active', target_repo: '/srv/app',
  created_at: '', updated_at: '',
});
assert.ok(project.created_at && project.updated_at);
assert.throws(() => createProject('ws-1', { name: 'Bad', targetRepo: '/tmp/nope' }, db, repos), /未登記/);
assert.throws(() => archiveProject(id, db), /未完成 task|active Goal|worktree/);
```

- [x] **Step 2: Run the Project test and observe the missing object API**

Run: `npx tsx src/project.test.ts`

Expected: FAIL because `createProject` still accepts only a name and the new columns/functions do not exist.

- [x] **Step 3: Implement the minimal Project migration and commands**

Add columns idempotently, keep legacy `target_repo=null`, and expose:

```ts
export type ProjectStatus = 'active' | 'archived';
export interface ProjectInput { name?: unknown; description?: unknown; targetRepo?: unknown }
export function createProject(workspaceId: string, input: ProjectInput, database = db, repos = registeredRepos()): string;
export function updateProject(projectId: string, patch: ProjectInput, database = db, repos = registeredRepos()): void;
export function archiveProject(projectId: string, database = db): void;
export function requireActiveProject(workspaceId: string, projectId: unknown, database = db): string;
```

`requireActiveProject` must reject missing, archived and cross-Workspace IDs. At this phase `archiveProject` rejects unfinished Tasks before setting `status='archived'`; no Goal or registered worktree can exist yet. Task 2 adds the active-Goal guard and Task 5 adds the registered-worktree guard when those records become possible. Keep `deleteProject` only for the compatibility route and do not expose it in new UI.

`src/repoRegistry.ts` reads `TASK_TRACKER_REPO_REGISTRY_PATH` only when first requested. The JSON is an object keyed by canonical realpath with `{ "checks": ["npm test"], "deployment": "task-tracker" | "not_required" }`; reject missing files, relative paths, duplicate realpaths, empty checks, unsupported commands and paths that do not exist. Tests pass an in-memory registry so they never depend on host configuration.

- [x] **Step 4: Write failing Task Project tests**

```ts
assert.throws(() => createTask('u1', 'ws-1', { title: 'x', projectId: 'other-project' }, db), /同一 workspace/);
changeTaskProject('u1', taskId, projectId, db);
assert.strictEqual(getTask(taskId, db)?.project_id, projectId);
changeTaskProject('u1', taskId, null, db);
assert.strictEqual(getTask(taskId, db)?.project_id, null);
```

Also assert `applyTaskPatch(..., { projectId })` is one-field-only and a Workspace move clears Project.

- [x] **Step 5: Run Task tests red, implement `task.project_changed`, then run green**

Run red: `npx tsx src/task.test.ts`

Add `projectId` to `PATCH_FIELDS`, validate with `requireActiveProject`, append `task.project_changed`, and project it to `tasks_read_model.project_id`.

Run green:

```bash
npx tsx src/project.test.ts
npx tsx src/task.test.ts
npx tsc --noEmit
```

- [x] **Step 6: Update HTTP tests and routes**

Test `POST /api/workspaces/:id/projects` with the object input, `PATCH /api/projects/:id` one field at a time, `POST /api/projects/:id/archive`, and Task `projectId` PATCH. Expect 400 for unregistered/cross-Workspace/archived Project and 403 at existing permission boundaries. Implement only those routes and keep DELETE compatibility unchanged.

- [x] **Step 7: Run focused server tests and commit**

```bash
npx tsx src/server.test.ts
git diff --check
git add src/schema.ts src/repoRegistry.ts src/repoRegistry.test.ts src/project.ts src/project.test.ts src/task.ts src/task.test.ts src/server.ts src/server.test.ts
git commit -m "feat: strengthen project ownership"
```

## Task 2: Add Goal aggregate and exclusive repository lease

**Files:**
- Create: `src/goal.ts`
- Create: `src/goal.test.ts`
- Modify: `src/schema.ts`
- Modify: `src/test.ts`
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [x] **Step 1: Write the failing Goal state-machine tests**

Define fixtures for `Queued -> Discussing -> Executing -> Verifying -> Done`, cancellation, blocked lease retention, safe pause lease release, resumption through `awaiting_lease`, revision increment, and Project one-to-many history:

```ts
const first = createGoal('human-1', { workspaceId: 'ws-1', projectId, objective: 'A', successCriteria: 'HTTP 200' }, db);
const second = createGoal('human-1', { workspaceId: 'ws-1', projectId, objective: 'B', successCriteria: 'No regression' }, db);
assert.notStrictEqual(first, second);
advanceGoal('owner-agent', first, 'Discussing', 'owner_scoping', db);
acquireRepoLease('owner-agent', first, db);
assert.throws(() => acquireRepoLease('owner-agent', second, db), /repo execution lease/);
blockGoal('owner-agent', first, 'needs human', db);
assert.throws(() => acquireRepoLease('owner-agent', second, db), /repo execution lease/);
cancelGoal('human-1', first, db);
acquireRepoLease('owner-agent', second, db);
```

- [x] **Step 2: Run red and implement event-sourced Goal**

Run: `npx tsx src/goal.test.ts`

Expected: FAIL because `src/goal.ts` does not exist.

Create `goals_read_model` plus a unique partial index on active `repo_leases`. Register Goal projections through the existing `registerProjection` mechanism. Expose explicit commands instead of a generic free-form transition:

```ts
createGoal(actorId, input, database): string
startDiscussion(actorId, goalId, database): void
setDiscussionPhase(actorId, goalId, phase, database): void
acquireRepoLease(actorId, goalId, database): void
startExecution(actorId, goalId, database): void
startVerification(actorId, goalId, database): void
completeGoal(actorId, goalId, evidenceRefs, database): void
pauseGoal(actorId, goalId, safeCheckpoint, database): void
resumeGoal(actorId, goalId, database): void
blockGoal(actorId, goalId, reason, database): void
cancelGoal(actorId, goalId, database): void
reviseGoal(actorId, goalId, successCriteria, database): void
```

Use a transaction for lease acquisition plus phase transition. Only `Done`, `Cancelled` release normally; safe `Paused` releases; `Blocked` retains.

Extend `archiveProject` in this same red/green cycle to reject any non-terminal Goal. The earlier unfinished-Task guard remains unchanged.

- [x] **Step 3: Add permission-checked Goal API tests and routes**

Cover list/create/detail and one-action endpoints `/start`, `/pause`, `/resume`, `/cancel`. Require an active Project with a registered target repo. Reject Owner-Agent Workspace creation by never adding such a route.

- [x] **Step 4: Verify and commit**

```bash
npx tsx src/goal.test.ts
npx tsx src/server.test.ts
npx tsc --noEmit
git add src/schema.ts src/goal.ts src/goal.test.ts src/test.ts src/server.ts src/server.test.ts
git commit -m "feat: add durable goal lifecycle"
```

## Task 3: Persist Agent resources, heartbeats, Runs and contributions

**Files:**
- Create: `src/agent.ts`
- Create: `src/agent.test.ts`
- Create: `src/goalRun.ts`
- Create: `src/goalRun.test.ts`
- Modify: `src/schema.ts`
- Modify: `src/seed.ts`
- Modify: `src/test.ts`
- Modify: `src/server.ts`

- [x] **Step 1: Write failing Agent seed and eligibility tests**

Assert exactly user01–user06 become Agent resources, user01 has `role='owner'`, user09 has no Agent, paused/error and Owner Agents are excluded from member selection, and route edits affect the next read.

- [x] **Step 2: Implement minimal Agent CRUD and seed**

Use `agent_id = user_id` and these stable columns: `role`, `skill_profile_json`, primary/fallback adapter/model, `status`, timestamps. Seed idempotently from canonical emails without changing Workspace membership. Only status and route fields are mutable.

- [x] **Step 3: Write failing heartbeat and Run ordering tests**

```ts
const heartbeat = enqueueHeartbeat({ scopeId: goalId, phase: 'round_1', agentId, revision: 1, triggerRef: 'phase' }, db);
assert.strictEqual(enqueueHeartbeat(sameInput, db), heartbeat);
const run = prepareRun({ heartbeatId: heartbeat, estimatedInputTokens: 500, estimatedOutputTokens: 200, quotaSnapshotJson: '{}' }, db);
assert.strictEqual(getRun(run, db)?.status, 'pending');
assert.throws(() => markRunRunning('missing', db), /run 不存在/);
```

Also cover two `@Owner` comment IDs, patrol slot, follow-up, `actual_tokens=null`, primary/fallback as separate Runs, immutable Participation and Contribution, and no-op Contribution rejection.

- [x] **Step 4: Implement persistence and read APIs**

Create unique heartbeat key `(scope_id, phase, agent_id, revision, trigger_ref)`. Store estimates/quota before `running`; allow actual tokens/cost to remain null. Contribution writes validate structured claim/reason/evidence and never expose a mutation endpoint to runners.

- [x] **Step 5: Verify and commit**

```bash
npx tsx src/agent.test.ts
npx tsx src/goalRun.test.ts
npx tsx src/server.test.ts
npx tsc --noEmit
git add src/schema.ts src/seed.ts src/agent.ts src/agent.test.ts src/goalRun.ts src/goalRun.test.ts src/test.ts src/server.ts
git commit -m "feat: persist agents and goal runs"
```

## Task 4: Add bounded two-round discussion orchestration

**Files:**
- Create: `src/goalOrchestrator.ts`
- Create: `src/goalOrchestrator.test.ts`
- Create: `sim/goalDiscussion.ts`
- Create: `sim/goalDiscussion.test.ts`
- Modify: `sim/notificationSecurity.ts`
- Modify: `src/comment.ts`
- Modify: `src/comment.test.ts`
- Modify: `src/test.ts`
- Modify: `sim/tsconfig.json`

- [ ] **Step 1: Write failing deterministic orchestration tests with a fake discussion runner**

Cover Owner selection of 1–5 eligible members, independent round-1 packets, round-2 only with at least two valid Contributions, `insufficient_peers`, one reconciliation then Blocked, and synthesis waiting for lease before Task creation.

- [ ] **Step 2: Implement bounded context and Contribution parser**

Reuse NFC/control/credential/private-address sanitizers from `notificationSecurity.ts`; add a repo context builder that accepts only realpaths under Project target repo and returns references plus bounded text. `runSafeDiscussion` must accept only Claude and construct an empty cwd/filtered environment invocation with no cookie, shell, Git-write or board mutation tools.

- [ ] **Step 3: Implement orchestration checkpoints**

`advanceGoalDiscussion(goalId, deps)` claims one pending heartbeat, records a pending Run with estimate/quota, invokes the fake/safe runner, validates Contribution, then closes the Run. Owner synthesis acquires lease first and creates Goal-linked Tasks in one SQLite transaction. A crash retry must return existing Contributions/Tasks by deterministic key.

- [ ] **Step 4: Add comment mention trigger tests**

Only an exact `@Owner` mention from a human comment creates one heartbeat keyed by `comment_id`; editing it does not create another. No mention creates none. Already-running Agents may receive the comment only through the next context build; user09 is never parsed as Agent output.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx src/goalOrchestrator.test.ts
npx tsx sim/goalDiscussion.test.ts
npx tsx src/comment.test.ts
npm run typecheck
git add src/goalOrchestrator.ts src/goalOrchestrator.test.ts sim/goalDiscussion.ts sim/goalDiscussion.test.ts sim/notificationSecurity.ts src/comment.ts src/comment.test.ts src/test.ts sim/tsconfig.json
git commit -m "feat: orchestrate goal discussions"
```

## Task 5: Normalize implementation adapters and connect production delivery

**Files:**
- Create: `sim/goalAdapters.ts`
- Create: `sim/goalAdapters.test.ts`
- Modify: `sim/production/runner.ts`
- Modify: `sim/production/runner.test.ts`
- Modify: `sim/production/policy.ts`
- Modify: `sim/production.test.ts`
- Modify: `sim/production.ts`

- [ ] **Step 1: Write failing adapter contract fixtures**

For Claude, Codex and AGY assert `preflight -> estimate -> persist -> invoke -> normalize -> verify -> actual usage`. AGY must build `agy --print --model <model> --mode accept-edits <prompt>`, keep the prompt last, and classify exit 0 + empty stdout + `no output produced` as `permission`. An uncertain side effect must not invoke fallback; zero-side-effect startup/quota/preflight failure may invoke exactly one fallback.

- [ ] **Step 2: Implement the common adapter boundary without changing CLI-specific arguments**

```ts
export interface AgentAdapter {
  preflight(input: AdapterInput): Promise<AdapterReadiness>;
  estimate(input: AdapterInput): UsageEstimate;
  run(input: AdapterInput): Promise<AgentRunResult>;
}
```

Move existing runner invocation and soft-denial classification behind this interface; do not add a dependency or `--dangerously-skip-permissions`.

- [ ] **Step 3: Write failing Project registry and Goal gate tests for production**

Use a temporary registered repo with per-repo `checks` and `deployment_not_required`. Assert the coordinator ignores a Goal Task unless its Goal is `Executing`, uses configured checks instead of hard-coded `npm test`, and legacy sweep refuses to create/merge in an active-Goal Project or leased repo.

- [ ] **Step 4: Implement the smallest production integration**

Replace `ALLOWED_WORKSPACE_IDS` at the Goal path with a Project repository registry read; keep legacy allowlist behavior for legacy Tasks. Add `goal_id` to Task projection/query and use it only as a gate around existing production actions. Continue using `action_log` for Task execution idempotency; do not duplicate it in heartbeat tables.

Register Goal worktrees when production first creates them and extend `archiveProject` to reject dirty or unmerged registered worktrees. This is the first phase where such records exist, so no earlier migration needs a speculative worktree abstraction.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx sim/goalAdapters.test.ts
npx tsx sim/production/runner.test.ts
npx tsx sim/production.test.ts
npm run typecheck
git add sim/goalAdapters.ts sim/goalAdapters.test.ts sim/production/runner.ts sim/production/runner.test.ts sim/production/policy.ts sim/production.test.ts sim/production.ts
git commit -m "feat: connect goals to production delivery"
```

## Task 6: Deliver Project, Goal and Agent user interfaces

**Files:**
- Modify: `public/js/views/kanban.js`
- Modify: `public/js/views/task-detail.js`
- Modify: `public/js/views/workspaces.js`
- Create: `public/js/views/goals.js`
- Create: `public/js/views/agents.js`
- Modify: `public/js/routes.js`
- Modify: `public/js/sidebar.js`
- Modify: `public/index.html`
- Modify: `public/css/kanban.css`
- Create: `public/css/goals.css`
- Create: `public/css/agents.css`
- Modify: `src/frontend.test.ts`
- Modify: `src/frontendViews.test.ts`

- [ ] **Step 1: Write failing DOM tests for Project controls**

Assert active Project search/selection, archived toggle, an accessible `<dialog>` replacing `prompt()`, fields for name/description/registered target repo, archive guard errors, and a Task detail Project select with `null` plus active same-Workspace Projects. Assert archived Workspaces are absent from the sidebar and main list until the user enables “顯示已封存”.

- [ ] **Step 2: Implement Project UI using existing `api`, `el`, role and modal patterns**

Preserve “所有專案” and “無專案”, sessionStorage selection, task badges and legacy unassigned Tasks. Use click/touch and keyboard-capable native controls; do not add a UI dependency.

- [ ] **Step 3: Write failing Goal and Agent view tests**

Assert Goal list/detail shows source, Project, state/phase, success criteria, parent, participants, Runs, token totals, evidence and Tasks. Assert create/pause/resume/cancel and `@Owner` controls obey role. Assert Agents list shows exactly six resources and route/status editing but no add/delete.

- [ ] **Step 4: Implement and register views**

Add `goals` and `agents` routes and sidebar links within Workspace navigation. Use text nodes and existing helpers for untrusted content; no `innerHTML` interpolation of API values.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx src/frontend.test.ts
npx tsx src/frontendViews.test.ts
npm run lint
npx tsc --noEmit
git add public/js public/css public/index.html src/frontend.test.ts src/frontendViews.test.ts
git commit -m "feat: add goal and agent management views"
```

## Task 7: Add verification, follow-up and disabled discovery scheduling

**Files:**
- Create: `sim/goalPatrol.ts`
- Create: `sim/goalPatrol.test.ts`
- Modify: `src/goalOrchestrator.ts`
- Modify: `src/goalOrchestrator.test.ts`
- Create: `deploy/goal-discovery.service`
- Create: `deploy/goal-discovery.timer`
- Modify: `deploy/README.md`
- Modify: `package.json`

- [ ] **Step 1: Write failing verification/follow-up tests**

Assert all required Tasks and deployment/readback evidence are required before Done; `deployment_not_required` is explicit. First verification failure returns to synthesis with revision+1 while retaining lease; second becomes Blocked. `goal.completed` creates one follow-up heartbeat, and a child requires changed criteria plus a distinct evidence fingerprint.

- [ ] **Step 2: Write failing patrol skip tests**

With fake clocks, assert a stable 12-hour `trigger_ref`, no model call when a discovery is running, an autonomous Goal is active, a human Goal is executing, or evidence fingerprint is unchanged. Assert at most one active Owner-created Goal per Workspace.

- [ ] **Step 3: Implement verification and patrol entry point**

`sim/goalPatrol.ts` defaults to read-only dry-run. `--once` persists the patrol heartbeat but still uses injected/fake runner in tests. It must never create Workspace and must reuse/match a Project before creating one.

- [ ] **Step 4: Add disabled systemd units**

Timer contract:

```ini
[Timer]
OnCalendar=*-*-* 00,12:00:00 Asia/Taipei
Persistent=false
Unit=goal-discovery.service
```

Document install and manual verification, but do not run `systemctl enable`, `start`, or any live Goal/AI command.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx sim/goalPatrol.test.ts
npx tsx src/goalOrchestrator.test.ts
systemd-analyze verify deploy/goal-discovery.service deploy/goal-discovery.timer
npm run typecheck
git add sim/goalPatrol.ts sim/goalPatrol.test.ts src/goalOrchestrator.ts src/goalOrchestrator.test.ts deploy/goal-discovery.service deploy/goal-discovery.timer deploy/README.md package.json
git commit -m "feat: add disabled goal discovery schedule"
```

## Task 8: End-to-end fake-runner acceptance and documentation

**Files:**
- Create: `sim/goal.integration.test.ts`
- Modify: `src/test.ts`
- Modify: `package.json`
- Modify: `docs/api.md`
- Modify: `docs/operations.md`
- Modify: `docs/tasks/current.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the fake-runner end-to-end test**

Drive a temporary database and Git repo through:

```text
Project -> Goal -> round 1 -> round 2 -> lease -> synthesis -> Goal Tasks
-> production worktree fixture -> CI fixture -> merge fixture
-> deployment fixture -> verification -> Done -> one follow-up evaluation
```

Restart the orchestrator at each checkpoint and assert no duplicate Contribution, Task, commit, heartbeat or child Goal.

- [ ] **Step 2: Add the test to the full gate and run it red, then close each concrete integration failure with TDD**

Run: `npx tsx sim/goal.integration.test.ts`

Expected first run: FAIL at the first unconnected boundary named by the assertion. For each failure, add the smallest focused test beside its owning module, observe that test fail, connect that boundary, and rerun both the focused test and integration test before advancing.

- [ ] **Step 3: Update contracts and changelog**

Document every new route, Project migration/default, Goal state/phase, permission, registered repo, disabled timer, recovery command and the fact that estimates are records rather than budget gates. Record that Workspace cleanup is excluded and remains a separate archive-first operation.

- [ ] **Step 4: Run the complete gate and security review**

```bash
npm test
npm run build
git diff --check
rg -n "dangerously-skip-permissions|cookie|authorization" src sim public deploy
```

Review findings must confirm: no credential/context logging, no path escape, no cross-Workspace Project/Goal association, no runner mutation credential in discussion, no destructive repo/worktree cleanup, and no enabled timer.

- [ ] **Step 5: Commit the final integration and documentation**

```bash
git add sim/goal.integration.test.ts src/test.ts package.json docs/api.md docs/operations.md docs/tasks/current.md CHANGELOG.md
git commit -m "test: verify goal collaboration workflow"
```

## Explicitly excluded operations

- Do not run `npm run sim`, `sim --sweep`, `goalPatrol --once` with a real runner, or AGY/Claude/Codex live smoke without separate human authorization.
- Do not enable/start `goal-discovery.timer` or change installed user units.
- Do not migrate, remove membership from, archive or delete existing production Workspaces.
- Do not delete target repositories, feature branches or worktrees; cleanup remains a separately approved operation.
