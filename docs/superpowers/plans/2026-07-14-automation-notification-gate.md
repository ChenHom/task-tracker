# Automation Notification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every existing automated Owner and member session clear the unread-notification snapshot taken at login before it performs normal board work, with a verified reply for main-workspace sources.

**Architecture:** Keep this entirely in the sim harness. A runner-owned gate logs in, snapshots unread notifications, reads each source task and source comment, gives resolvable sources to a dedicated API-only preflight session, and lets the runner—not the LLM—mark notifications read only after the required evidence exists. The gate is invoked before every regular Owner/member session in normal runs and sweeps; it does not add a frontend inbox, a backend route, or a database migration.

**Tech Stack:** TypeScript, Node `fetch`, the existing cookie-authenticated HTTP API, `node:assert` tests executed with `tsx`.

---

## Scope and fixed decisions

- Current automated identities are `user01` (Owner) and the existing `MEMBER_RUNNERS` identities `user02`–`user06`. `user09` is a main-workspace Commenter but has no configured runner, model, worktree, or automated session; this plan deliberately does **not** create one. Its notifications remain available to a future frontend inbox or an explicitly approved runner addition.
- A snapshot means only rows returned as `read_at === null` by the single `GET /api/notifications` made immediately after the actor login. Notifications created after that call are not processed until the next automated session.
- The driver owns `POST /api/notifications/:id/read`. The preflight LLM must never call that endpoint. This prevents an invalid main-workspace reply from becoming irreversibly read before the driver verifies it.
- A main-workspace source is one whose fetched `task.workspace_id === MAIN_WORKSPACE_ID`. One valid post-snapshot comment by the actor clears every snapshot notification for that same main task.
- A source `403` or `404`, including a missing `source_comment_id` in an otherwise successful comment list, is unavailable: log it and mark it read. Network exceptions, response bodies with the wrong shape, `5xx`, other non-`200` source responses, failed preflight session, failed read mark, a missing verified main reply, or an actor-created `@自己` reply leave the unresolved notification unread and skip the actor's regular session.

## File structure

| File | Responsibility |
| --- | --- |
| `sim/run.ts` | Define narrow API/result types, resolve a notification snapshot, construct the preflight prompt, verify main replies, own marking/readback, and wrap every regular automated session with the gate. |
| `sim/run.test.ts` | Use an injected fake HTTP client and fake preflight runner to cover gate ordering, all terminal outcomes, snapshot boundaries, prompt requirements, and the no-self-mention rule. |
| `docs/operations.md` | Explain the active automated identities, gate order, retry/unavailable behavior, and the continuing no-live-sweep authorization rule. |
| `docs/tasks/current.md` | Record the completed sim-harness capability without claiming a browser notification UI or a user09 runner. |

### Task 1: Establish a deterministic notification-gate contract

**Files:**

- Modify: `sim/run.ts:369-390` (HTTP helper types) and add gate helpers immediately after `login()`.
- Modify: `sim/run.test.ts:1-120` (imports/source assertions) and append gate behavior tests after the existing pure-helper tests.

- [ ] **Step 1: Add the failing gate-contract tests to `sim/run.test.ts`.**

  Import these new exports from `./run`:

  ```ts
  import {
    notificationGatePrompt,
    processNotificationGate,
    runNotificationGatedSession,
    type NotificationGateActor,
    type NotificationGateRequest,
  } from './run';
  ```

  Add a reusable fake request recorder whose queue is keyed by `METHOD path`, then add these exact behavioral cases:

  ```ts
  const actor = {
    id: 'user-02', email: 'user02@test.local', name: '小美',
  } satisfies NotificationGateActor;

  const noUnread = await processNotificationGate({
    actor,
    cookie: 'session=test',
    request: fakeRequest({ 'GET /api/notifications': [{ status: 200, body: [] }] }),
    runPreflight: async () => { throw new Error('不該啟動 preflight'); },
    log: () => undefined,
    snapshotAt: '2026-07-14T04:00:00.000Z',
  });
  assert.deepStrictEqual(noUnread, { ready: true, snapshotIds: [] });

  let regularRuns = 0;
  const skipped = await runNotificationGatedSession(
    async () => ({ ready: false, snapshotIds: ['n-main'] }),
    async () => { regularRuns++; return { errored: false, timedOut: false, quotaExhausted: false }; },
  );
  assert.strictEqual(skipped, null);
  assert.strictEqual(regularRuns, 0, 'gate 未清空時不得進入一般 session');
  ```

  Add fixtures for the API shapes already documented in `docs/api.md`:

  ```ts
  const unread = (notificationId: string, taskId: string, commentId: string) => ({
    notification_id: notificationId, recipient_id: actor.id, source_task_id: taskId,
    source_comment_id: commentId, snippet: '請確認', created_at: '2026-07-14T03:59:00.000Z', read_at: null,
  });
  const task = (taskId: string, workspaceId: string) => ({
    task_id: taskId, workspace_id: workspaceId, creator_id: 'creator', project_id: null,
    title: '通知來源', description: '說明', status: 'Todo', priority: 'Medium',
    assignee_id: null, due_at: null, version: 1, updated_at: '2026-07-14T03:58:00.000Z',
  });
  const sourceComment = (taskId: string, commentId: string) => ({
    comment_id: commentId, task_id: taskId, user_id: 'owner', content: '@小美 請確認',
    created_at: '2026-07-14T03:59:00.000Z',
  });
  ```

  Cover these cases with call-order assertions on the fake client:

  1. A normal-workspace source fetches task and comments, runs the dedicated preflight once, then posts `/api/notifications/n-general/read`; a final notifications readback has no snapshot id with `read_at === null`.
  2. A main-workspace source returns an actor comment whose `created_at` is later than `snapshotAt`; the second comments GET occurs before the read POST and produces `{ ready: true }`.
  3. The same main source without a post-snapshot actor comment returns `{ ready: false }` and never posts its read endpoint.
  4. A new main comment containing `@小美` returns `{ ready: false }` and never posts its read endpoint.
  5. Task `403`, task `404`, and a `200` comment list missing `source_comment_id` each log `notification=<id> task=<id> status=<status>` and post their read endpoint without running the LLM.
  6. Task `500`, malformed notifications/body, a thrown request, a non-`200` read response, and a failed/timed-out preflight all return `{ ready: false }` and do not mark the unresolved item read.
  7. A snapshot containing two unread rows and one already-read row marks both unread ids exactly once, never marks the already-read id, and ignores a new unread row added only in the final readback.

- [ ] **Step 2: Run the focused test to prove the missing exports fail.**

  Run:

  ```bash
  npx tsx sim/run.test.ts
  ```

  Expected: TypeScript execution fails because `notificationGatePrompt`, `processNotificationGate`, and `runNotificationGatedSession` do not yet exist.

- [ ] **Step 3: Add the minimal typed HTTP and notification models in `sim/run.ts`.**

  Replace the anonymous API return type with the reusable contract below, retaining the existing fetch/body parsing behavior:

  ```ts
  export interface ApiResult { status: number; body: unknown }
  export type NotificationGateRequest = (
    path: string,
    init?: RequestInit,
    cookie?: string,
  ) => Promise<ApiResult>;

  export interface NotificationGateActor { id?: string; email: string; name: string }
  interface NotificationRow {
    notification_id: string; recipient_id: string; source_task_id: string; source_comment_id: string;
    read_at: string | null;
  }
  interface NotificationTask { task_id: string; workspace_id: string; title: string; description: string }
  interface NotificationComment {
    comment_id: string; task_id: string; user_id: string; content: string; created_at: string;
  }
  interface ResolvedNotification {
    notification: NotificationRow; task: NotificationTask; sourceComment: NotificationComment;
    comments: NotificationComment[];
  }
  export interface NotificationGateResult { ready: boolean; snapshotIds: string[] }
  ```

  Add shape guards that reject malformed HTTP data rather than treating it as an empty list:

  ```ts
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
  function requireNotificationRows(value: unknown): NotificationRow[] {
    if (!Array.isArray(value) || !value.every((row) => isRecord(row)
      && typeof row.notification_id === 'string'
      && typeof row.recipient_id === 'string'
      && typeof row.source_task_id === 'string'
      && typeof row.source_comment_id === 'string'
      && (typeof row.read_at === 'string' || row.read_at === null))) {
      throw new Error('notifications response 格式不合法');
    }
    return value as NotificationRow[];
  }
  ```

- [ ] **Step 4: Implement the runner-owned gate and its narrow session wrapper.**

  Implement these helpers after `login()`; use `MAIN_WORKSPACE_ID` to classify main sources, preserve the first snapshot's ids in a `Set`, and never issue a read POST before the relevant conditions below are true:

  ```ts
  export async function runNotificationGatedSession(
    gate: () => Promise<NotificationGateResult>,
    runNormal: () => Promise<SessionResult>,
  ): Promise<SessionResult | null> {
    const result = await gate();
    return result.ready ? runNormal() : null;
  }

  function isUnavailable(status: number): boolean {
    return status === 403 || status === 404;
  }

  function hasSelfMention(content: string, actor: Pick<NotificationGateActor, 'email' | 'name'>): boolean {
    const local = actor.email.slice(0, actor.email.indexOf('@'));
    const escaped = [actor.name, local, actor.email]
      .filter(Boolean)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return escaped.some((value) => new RegExp(`@${value}(?=$|[\\s.,，。！？!?;；:：)\\]}>])`, 'iu').test(content));
  }
  ```

  `processNotificationGate` must take `{ actor, cookie, request, runPreflight, log, snapshotAt }`. Its exact order is:

  1. `GET /api/notifications` is the first protected request after `login()`. Shape-check it and retain only `read_at === null` as the immutable snapshot. Return `{ ready: true, snapshotIds: [] }` without a preflight call when it is empty. For a non-empty snapshot, require one non-empty `recipient_id` shared by every row and derive the actor id from it; this avoids a pre-snapshot `/api/auth/me` request.
  2. For each snapshot row, `GET /api/tasks/<source_task_id>` then `GET /api/tasks/<source_task_id>/comments`; confirm that the task has the requested id and that a comment with the requested `source_comment_id` exists.
  3. On `403`/`404` from either request, or missing source comment, log `[notification] unavailable notification=<notification_id> task=<source_task_id> status=<status>`, call `POST /api/notifications/<notification_id>/read`, and require its `200` response. A missing comment uses status `404` in this log.
  4. For all resolvable sources, call `runPreflight(notificationGatePrompt(...))` once. If it errors or times out, return `ready: false` without marking those resolvable sources.
  5. Re-read comments once for each distinct main task. Require at least one comment by the derived actor id whose `created_at > snapshotAt`; reject the task if any actor comment created after the snapshot contains a self mention. Only then POST read for every resolvable snapshot notification belonging to that main task. After the successful preflight, read normal-workspace notification ids as well.
  6. Re-run `GET /api/notifications`; return `ready: false` if any original snapshot id is still present with `read_at === null`. Do not inspect ids that were not in the first snapshot.

  Make all thrown request errors, malformed bodies, `5xx`, unexpected source statuses, read failures, and failed final readback return `{ ready: false, snapshotIds }` after logging an error. Do not swallow the reason in the log.

- [ ] **Step 5: Re-run the gate test and commit the passing contract.**

  Run:

  ```bash
  npx tsx sim/run.test.ts
  npx tsc -p sim/tsconfig.json
  ```

  Expected: both commands pass; no runner, network, or live sweep process starts.

  Commit only the two relevant files:

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "feat: add automated notification gate"
  ```

### Task 2: Add the dedicated preflight prompt and gate every automated session

**Files:**

- Modify: `sim/run.ts:680-735` (prompt helpers), `sim/run.ts:1166-1238` (normal run), and `sim/run.ts:1480-1560` (owner/team sweeps).
- Modify: `sim/run.test.ts` (prompt and call-site assertions).

- [ ] **Step 1: Add failing prompt and call-site assertions to `sim/run.test.ts`.**

  Add direct tests for the exported prompt builder:

  ```ts
  const prompt = notificationGatePrompt({
    actor,
    jar: '/tmp/notification.jar',
    sources: [{
      notification: unread('n-main', 'task-main', 'comment-main'),
      task: task('task-main', MAIN_WORKSPACE_ID),
      sourceComment: { ...sourceComment('task-main', 'comment-main'), content: '請確認' },
      comments: [{ ...sourceComment('task-main', 'comment-main'), content: '請確認' }],
    }],
  });
  assert.ok(prompt.includes('通知前置處理'), 'owner/member 共用 prompt 必須標示 preflight');
  assert.ok(prompt.includes('已閱讀，目前無補充。'), 'main source 無補充時必須有固定留言');
  assert.ok(prompt.includes('不得呼叫 POST /api/notifications'), 'read endpoint 必須由 runner 控制');
  assert.ok(prompt.includes('不得在留言中 @ 自己'), 'prompt 必須禁止自我 mention');
  assert.ok(!prompt.includes('@小美'), 'prompt 指令不得以 actor handle 組出自我 mention');
  ```

  Add source assertions that prove both member and owner paths call the shared gated wrapper before their normal `runSession` invocation. Check for the exact helper name `runActorSessionWithNotificationGate(` at the member normal-run path, owner open/mid/close/repair paths, sweep owner path, and sweep member path; keep the existing `MAIN_OWNER_TOOLS === 'Bash(curl:*)'` assertion unchanged.

- [ ] **Step 2: Run the focused test to verify the prompt/wrapper is still absent.**

  Run:

  ```bash
  npx tsx sim/run.test.ts
  ```

  Expected: FAIL because `notificationGatePrompt` and `runActorSessionWithNotificationGate` are not yet implemented or wired into every path.

- [ ] **Step 3: Implement the single dedicated prompt builder.**

  Add this exported function beside `API_RULES`; interpolate the already fetched source data, but do not interpolate an actor handle with `@`:

  ```ts
  export function notificationGatePrompt(input: {
    actor: NotificationGateActor;
    jar: string;
    sources: ResolvedNotification[];
  }): string {
    const sourceText = input.sources.map((source, index) => [
      `## 通知 ${index + 1}`,
      `notification_id: ${source.notification.notification_id}`,
      `task_id: ${source.task.task_id}`,
      `workspace_id: ${source.task.workspace_id}`,
      `title: ${source.task.title}`,
      `description: ${source.task.description}`,
      `來源留言: ${source.sourceComment.content}`,
      `目前留言:\n${source.comments.map((comment) => `- ${comment.created_at} ${comment.content}`).join('\n')}`,
    ].join('\n')).join('\n\n');
    return `你是「${input.actor.name}」（${input.actor.email}）。這是通知前置處理；只處理下列來源，不做一般巡檢、認領、狀態變更、程式碼修改或其他 task。\n${API_RULES(input.jar)}\n\n${sourceText}\n\n規則：\n- 主協作工作區來源：每個不同 task 至少 POST 一則新的留言；沒有補充時，內容必須完全是「已閱讀，目前無補充。」；有補充時寫具體問題、風險或建議。\n- 一般工作區來源：先讀內容，再依內容決定是否留下必要回覆；不要求每筆都留言。\n- 不得呼叫 POST /api/notifications/:id/read；runner 會在驗證後處理。\n- 不得在留言中 @ 自己，也不得為了確認身份加入任何指向自己的 @ 提及。\n結束時只輸出一行處理摘要。`;
  }
  ```

- [ ] **Step 4: Implement the actor-session wrapper and wire it into every path.**

  Add one helper which logs in, makes `GET /api/notifications` through `processNotificationGate` as its immediately following protected request, derives the actor id from the snapshot rows when needed, and only then starts the supplied ordinary session:

  ```ts
  async function runActorSessionWithNotificationGate(input: {
    label: string;
    actor: Pick<NotificationGateActor, 'email' | 'name'>;
    jar: string;
    runner: Runner;
    model: string;
    preflightOptions: SessionOptions;
    normal: () => Promise<SessionResult>;
  }): Promise<SessionResult | null> {
    const cookie = await login(input.actor.email);
    return runNotificationGatedSession(
      () => processNotificationGate({
        actor: input.actor, cookie, request: api,
        runPreflight: (prompt) => runSession(`${input.label}-通知`, input.runner, input.model, prompt, input.preflightOptions),
        log: (line) => console.log(`[${input.label}] ${line}`), snapshotAt: new Date().toISOString(),
      }),
      input.normal,
    );
  }
  ```

  Use this helper in all of the following places. A `null` result means that actor's ordinary session is skipped, without calling `commitMemberWork` or changing the existing timeout accounting.

  - In `main()`, wrap every member round session before `runMemberSession`; wrap Owner open, mid review, close, and each repair call. For the Owner opening gate failure, retain the existing clean-worktree/report cleanup path and do not dispatch its member round.
  - In `sweep()`, create the run directory/prompt artifact list before invoking the Owner gate, then wrap the Owner sweep session when `ownerBudget > 0`. A failed Owner gate consumes the attempted Owner budget but must not prevent independent member gates in a `both` sweep.
  - In the sweep member `settleAllOrThrow` closure, run each member's gate after its jitter and before `runMemberSession`; a failed gate skips only that member and does not call the commit callback.
  - Keep main-workspace Owner preflight `tools: MAIN_OWNER_TOOLS`; all other Owner/member preflights reuse the corresponding ordinary session tools, working directory, timeout, prompt artifact array, and fallback routing.

  Store preflight prompt artifacts with a `-notification` label so logs distinguish notification work from ordinary board work. Do not change `MEMBER_RUNNERS`, create a user09 runner, use a browser, or add a frontend call to `/api/notifications`.

- [ ] **Step 5: Run focused tests and commit the session integration.**

  Run:

  ```bash
  npx tsx sim/run.test.ts
  npx tsc -p sim/tsconfig.json
  ```

  Expected: both commands pass; the source assertions show all normal Owner/member launch paths now pass through the gate.

  Commit:

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "feat: gate automated sessions on notifications"
  ```

### Task 3: Document the operational behavior and complete verification

**Files:**

- Modify: `docs/operations.md:107-180`.
- Modify: `docs/tasks/current.md:87-104`.

- [ ] **Step 1: Update `docs/operations.md` under `## Sim harness`.**

  Add a `### Notification preflight` subsection with this content:

  ```markdown
  Every automated Owner and configured member session (`user01`, `user02`–`user06`) first snapshots its own unread `GET /api/notifications` rows. The driver reads the source task/comment and runs a dedicated API-only notification session before ordinary board work.

  Main-workspace sources require a new post-snapshot comment by that actor; when there is no addition the required text is `已閱讀，目前無補充。`. The driver, not the AI session, marks a notification read after this verification. Normal-workspace sources may be read without a compulsory reply. A `403`/`404` or deleted source is logged and marked read; malformed data, network/5xx failures, a failed preflight, or missing/invalid main reply stay unread and skip that actor's ordinary session for this run.

  The snapshot is bounded to login time. Notifications received later wait for the next actor session. The runner never creates a self-mention in notification handling. `user09` is not currently a sim runner, so this automation does not consume that account's notifications. This is not a frontend inbox and does not authorize running a live sweep.
  ```

- [ ] **Step 2: Update the Phase 12 checklist in `docs/tasks/current.md`.**

  Add a completed bullet immediately after the existing runner/lock bullets:

  ```markdown
  - [x] 每個既有自動 Owner／member session 先處理登入當下的未讀通知；主工作區需驗證新的非自我 mention 留言後才已讀，來源 403/404 會記錄並清除，其他失敗保留未讀並跳過該 actor 的一般工作（不含前端通知 UI 或 user09 runner）
  ```

- [ ] **Step 3: Verify the full non-live change.**

  Run:

  ```bash
  npx tsx sim/run.test.ts
  npx tsc --noEmit
  npm test
  npm run build
  git diff --check
  git status --short
  ```

  Expected: all verification commands exit `0`; `git diff --check` emits no output; status contains only the intended `sim/run.ts`, `sim/run.test.ts`, and documentation changes plus the pre-existing unrelated `public/css/task-detail.css` and `src/frontend.test.ts` edits, which must not be staged.

- [ ] **Step 4: Commit documentation without absorbing unrelated work.**

  ```bash
  git add docs/operations.md docs/tasks/current.md
  git commit -m "docs: document automated notification gate"
  ```

  Do not run `npm run sim`, `npm run sim -- --sweep`, enable a timer, restart the application service, or modify the two unrelated frontend files. This feature changes the future sim-runner process only; no deployed HTTP server artifact is changed.

## Completion checklist

- [ ] `processNotificationGate` has an injected-request test for empty, general, verified-main, missing-main, self-mention, unavailable, transient failure, and multiple-snapshot behavior.
- [ ] Every normal Owner/member session in `main()` and `sweep()` is invoked through `runActorSessionWithNotificationGate`.
- [ ] Only snapshot notification ids govern the final readback; subsequent notifications are not consumed.
- [ ] The driver exclusively owns notification read marks and log records for unavailable sources include notification id, task id, and status.
- [ ] The preflight prompt explicitly prevents self mentions and direct read endpoint calls.
- [ ] `npm test`, `npm run build`, TypeScript checks, and diff check pass without a live sweep.
