# Safe Main Discussion Member Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore substantive, independently verified member replies to main-workspace notifications while keeping external research capability isolated and preserving the existing notification gate and scheduler behavior.

**Architecture:** Keep the actor cookie and all task-tracker mutations in `sim/run.ts`. Add a pure notification-security module for Unicode/control/secret sanitization, bounded prompt construction, reply validation, and public URL/query policy. Main-workspace notifications call an injected safe discussion runner; the production runner is Claude-only with `WebSearch`/`WebFetch`, an empty cwd, minimal environment, and a Claude `PreToolUse` egress hook. General-workspace notifications remain API-only, and every failure remains unread.

**Tech Stack:** Node 24, TypeScript, `node:child_process`, Claude CLI tool allowlists/hooks, existing `sim/run.test.ts` offline fake HTTP client, existing notification telemetry.

---

### Task 1: Add pure notification security and packet contracts

**Files:**
- Create: `sim/notificationSecurity.ts`
- Test: `sim/run.test.ts` (new imports and pure helper assertions)

- [ ] **Step 1: Write failing sanitization and validation tests**

Add imports for `buildDiscussionPacket`, `sanitizeUntrustedText`, `validateDiscussionReply`, `validatePublicUrl`, `validateEgressCall`, and add assertions covering the required contract:

```ts
const raw = 'A\u0000B\u202E C session=super-secret password:pw 192.168.50.109 http://user:pass@localhost:3000/x';
const sanitized = sanitizeUntrustedText(raw, 5000);
assert.ok(!sanitized.includes('\u0000'));
assert.ok(!sanitized.includes('\u202E'));
assert.ok(!sanitized.includes('super-secret'));
assert.ok(!sanitized.includes('password:pw'));
assert.ok(!sanitized.includes('192.168.50.109'));
assert.ok(!sanitized.includes('user:pass@localhost'));

const packet = buildDiscussionPacket({
  actorName: '小美', actorProfile: '安全與 auth',
  taskTitle: '討論公開 OAuth 風險',
  taskDescription: '請查證公開資料',
  sourceComment: raw,
  contextComments: [],
});
assert.ok(packet.prompt.length <= 16_000);
assert.ok(packet.prompt.includes('UNTRUSTED_TASK_DATA'));
assert.ok(!packet.prompt.includes('super-secret'));

assert.deepStrictEqual(validateDiscussionReply('【同意】理由足夠具體，公開來源與目前風險一致。', { name: '小美', email: 'user02@test.local' }), {
  ok: true,
  content: '【同意】理由足夠具體，公開來源與目前風險一致。',
});
assert.strictEqual(validateDiscussionReply('已閱讀，目前無補充。', gateActor).ok, false);
assert.strictEqual(validateDiscussionReply('【同意】', gateActor).ok, false);
assert.strictEqual(validateDiscussionReply('【疑慮】@小美 需要更多資訊才能判斷。', gateActor).ok, false);
assert.strictEqual(validatePublicUrl('http://127.0.0.1:3000/api/health').ok, false);
assert.strictEqual(validatePublicUrl('https://example.com/research').ok, true);
assert.strictEqual(validateEgressCall({ type: 'WebSearch', query: 'session=secret' }, { sourceTexts: [] }).ok, false);
assert.strictEqual(validateEgressCall({ type: 'WebSearch', query: 'OAuth security' }, { sourceTexts: ['OAuth security design'] }).ok, false);
```

- [ ] **Step 2: Run the focused test and verify it fails for missing exports**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL before any production implementation, with the new security helpers unavailable or their assertions failing. Existing baseline assertions are expected to run until the first new failure.

- [ ] **Step 3: Implement the pure security module**

Create `sim/notificationSecurity.ts` with these exported contracts:

```ts
export interface DiscussionPacketInput {
  actorName: string;
  actorProfile: string;
  taskTitle: string;
  taskDescription: string;
  sourceComment: string;
  contextComments: readonly { content: string; created_at?: string }[];
}

export interface DiscussionPacket {
  prompt: string;
  sourceTexts: string[];
  truncated: boolean;
}

export function sanitizeUntrustedText(value: string, maxChars: number): string;
export function buildDiscussionPacket(input: DiscussionPacketInput): DiscussionPacket;
export function validateDiscussionReply(content: string, actor: { name: string; email: string }): { ok: true; content: string } | { ok: false; reason: string };
export function validatePublicUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string };
export function validateEgressCall(call: { type: string; query?: string; url?: string }, policy: { sourceTexts: readonly string[]; fetchAllowed?: boolean; searchCount?: number }): { ok: true } | { ok: false; reason: string };
```

Normalize to NFC, normalize CRLF, remove C0/C1 and bidi/invisible controls while preserving newline/tab, mask credential-like assignments/JWT/key prefixes/private IPs/private hosts/URL userinfo, and truncate after masking. Build a 16,000-character prompt with fixed rules, actor profile/title/source first, then bounded description/context and an explicit omission line. `validateDiscussionReply` accepts only a trimmed reply beginning with `AGREE_MARKER` or `CONCERN_MARKER`, 20–1,500 characters, with substantive body; reject the no-op text, self-mentions, credentials, internal URLs/IPs, shell/API/tool envelopes. `validateEgressCall` rejects non-web tools, invalid/private URLs, credential-like or overlong queries, more than three searches, and any query sharing a 24-character normalized substring with source text.

- [ ] **Step 4: Run the focused tests and verify the pure helpers pass**

Run: `npx tsx sim/run.test.ts`

Expected: the new pure security assertions pass; existing main-notification assertions still fail because the fixed-reply behavior has not yet been replaced. Do not change those existing assertions in this step.

- [ ] **Step 5: Commit the pure security boundary**

```bash
git add sim/notificationSecurity.ts sim/run.test.ts
git commit -m "test: define safe discussion notification boundary"
```

### Task 2: Replace fixed main-workspace reply with injected discussion processing

**Files:**
- Modify: `sim/run.ts:725-1100` (notification types, prompt callback, gate flow)
- Modify: `sim/run.test.ts:250-680` (notification gate contract tests)

- [ ] **Step 1: Add failing gate tests for substantive replies and fail-closed output**

Replace the old main-workspace fixed-reply fixture with injected discussion callbacks. Add tests that assert a valid `【同意】` and `【疑慮】` are posted and read only after comment readback, while fixed no-op, invalid marker, generator failure, and invalid self-mention leave the notification unread and do not POST or mark read. Add a three-notification fixture where callbacks return success/failure/success and assert only the middle notification remains unread. Keep the general-workspace test asserting the callback is never called.

Use this callback shape in tests:

```ts
runDiscussion: async ({ prompt, notificationId }) => {
  assert.ok(prompt.includes('UNTRUSTED_TASK_DATA'));
  assert.ok(notificationId === 'n-main');
  return { output: '【同意】理由具體，公開來源與目前討論的風險描述一致。' };
}
```

The fake API queue must return the exact injected content in the post-readback comments response, and the test must assert the POST body equals that content—not the old no-op.

- [ ] **Step 2: Run the focused gate tests and verify the old implementation fails**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because `processNotificationGate()` still accepts only `runPreflight`, posts the fixed no-op, and never invokes `runDiscussion`.

- [ ] **Step 3: Implement the gate callback and validation flow**

In `sim/run.ts`, import the pure security helpers and define:

```ts
export interface NotificationDiscussionInput {
  notificationId: string;
  actor: NotificationGateActor;
  task: NotificationTask;
  sourceComment: NotificationComment;
  comments: readonly NotificationComment[];
  prompt: string;
}

export interface NotificationDiscussionResult {
  output: string;
  session?: SessionResult;
}
```

Change `processNotificationGate()` to accept `runDiscussion?: (input: NotificationDiscussionInput) => Promise<NotificationDiscussionResult>`. For the main workspace, build the bounded packet, fail if no callback exists, invoke it once per notification, validate its output, POST the validated content with the actor cookie, re-fetch comments, and require one new actor-authored comment whose content exactly matches the validated output and has no self-mention before marking the notification read. Remove `NOTIFICATION_NOOP_REPLY` and `postNotificationNoopReply`. Preserve 403/404 unavailable handling, independent notification loop, final readback, and general-workspace API-only behavior. Do not add a fallback reply.

- [ ] **Step 4: Run focused tests and verify the gate is green**

Run: `npx tsx sim/run.test.ts`

Expected: all new gate cases and existing non-notification tests pass. The old source assertions that require fixed no-op or “no agent” must be updated in the same task to assert the safe callback contract instead.

- [ ] **Step 5: Commit the gate behavior**

```bash
git add sim/run.ts sim/run.test.ts
git commit -m "feat: restore substantive main discussion replies"
```

### Task 3: Add the isolated Claude discussion runner and egress hook

**Files:**
- Create: `sim/notification-egress-hook.ts`
- Modify: `sim/run.ts:1200-1510` (safe tool constants, invocation options, session result capture)
- Modify: `sim/run.test.ts:100-180,800-850` (safe invocation assertions)

- [ ] **Step 1: Add failing invocation and session-capture tests**

Add assertions that `buildRunnerInvocation({ runner: 'claude', model: 'claude-sonnet-5' }, ..., { safeDiscussion: true, tools: 'WebSearch,WebFetch', settings: '/tmp/settings.json' })` contains `--tools WebSearch,WebFetch`, `--allowedTools WebSearch,WebFetch`, `--settings /tmp/settings.json`, and no Bash/curl. Assert normal Claude invocation remains unchanged. Add a test for `safeDiscussionEnvironment()` that excludes `PASSWORD`, `SESSION`, `TOKEN`, and arbitrary environment keys. Add a test that `runSafeDiscussionSession` refuses a Codex/AGY route and uses no fallback.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because current invocation options have no safe discussion mode, session results do not expose final output, and no egress hook exists.

- [ ] **Step 3: Implement the safe runner boundary**

Add `SAFE_DISCUSSION_ROUTE = { runner: 'claude', model: 'claude-sonnet-5' }`, `SAFE_DISCUSSION_TOOLS = 'WebSearch,WebFetch'`, and a safe timeout. Extend `buildRunnerInvocation()` with optional `safeDiscussion`, `claudeTools`, and `settings` fields; only the safe branch adds Claude `--tools`, the same `--allowedTools`, `--settings`, empty `--setting-sources`, and `--no-session-persistence`, leaving all normal invocations byte-compatible. Extend `SessionOptions` and `SessionResult` with an optional captured `output`; when `captureContent=false`, do not write prompt/stdout/stderr artifacts but still return Claude stdout as `output` and keep existing telemetry fields. Add a filtered `safeDiscussionEnvironment()` and use an empty `mkdtempSync(join(tmpdir(), 'task-tracker-discussion-'))` cwd.

Create `sim/notification-egress-hook.ts` as a stdin JSON command hook. It reads a policy file path from `NOTIFICATION_EGRESS_POLICY_FILE`, calls `validateEgressCall`, exits `0` for allowed WebSearch/WebFetch input and exits `2` for rejection; it never logs query, URL, source text, or fetched content. The settings JSON passed to Claude must match `WebSearch|WebFetch` in `PreToolUse` and invoke the repository's absolute Node executable with the repository's absolute `node_modules/tsx/dist/loader.mjs` and hook path (the temporary cwd must not affect module resolution). The policy file contains only sanitized source fingerprints, fetch capability, and current search count; set mode `0600` and delete it/settings/temp cwd in `finally`.

Implement `runSafeDiscussionSession(input)` to require the Claude route, construct the settings/policy files, call `runSession()` with no fallback, `captureContent:false`, safe tools/environment/empty cwd, and return the captured output or a failed `SessionResult`. It must not receive actor cookie/password or API mutation functions.

- [ ] **Step 4: Run invocation and session tests**

Run: `npx tsx sim/run.test.ts`

Expected: safe invocation, environment filtering, route rejection, and output-capture tests pass; all normal runner tests remain green.

- [ ] **Step 5: Commit the isolated runner**

```bash
git add sim/run.ts sim/run.test.ts sim/notification-egress-hook.ts
git commit -m "feat: isolate notification research runner"
```

### Task 4: Wire safe discussion into every member notification gate

**Files:**
- Modify: `sim/run.ts:1027-1090,1330-1365,2035-2080,2555-2590`
- Modify: `sim/run.test.ts:560-680,1580-1630` (member sweep/gate wiring)

- [ ] **Step 1: Add failing wiring tests**

Assert `runNotificationSweepForMember()` passes a discussion callback to the gate, while general notifications do not call it. Assert `runActorSessionWithNotificationGate()` member paths pass the safe callback and owner paths do not silently use a fixed reply. Assert a safe runner failure leaves the notification unread and skips normal work. Keep the existing login retry behavior unchanged.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because member sweep and normal member gate currently call `processNotificationGate()` without a discussion callback.

- [ ] **Step 3: Wire the callback and telemetry**

Add a `runDiscussion` override to `NotificationSweepForMemberInput` for offline injection; production defaults to `runSafeDiscussionSession` with the current member. Pass the same callback through `runActorSessionWithNotificationGate` for user02–user06 normal and sweep sessions. Do not pass it to OWNER sessions. Record each safe session attempt through existing notification telemetry with actor/task/notification identifiers, route/model, latency/token total, and structured outcome; never record prompt/output/query/cookie. Preserve per-notification independence and the existing blocked-member selection logic.

- [ ] **Step 4: Run the complete local simulation tests**

Run: `npx tsx sim/run.test.ts`

Expected: all gate, runner, telemetry, roster, scheduler, and source-contract assertions pass. No command may invoke `npm run sim` or a sweep.

- [ ] **Step 5: Commit member wiring**

```bash
git add sim/run.ts sim/run.test.ts
git commit -m "feat: wire safe replies into member notification gates"
```

### Task 5: Synchronize operations/current-state documentation

**Files:**
- Modify: `docs/operations.md:184-230`
- Modify: `docs/tasks/current.md` notification-gate section

- [ ] **Step 1: Write documentation assertions/checklist**

Before editing, locate and quote the old fixed-reply statements so the final diff removes every claim that notification preflight never starts AI or applies the fixed no-op. Keep the existing statements about `SIM_NOTIFICATION_GATE`, 403/404 unavailable handling, unread-on-failure, and `--sweep owner` excluding member notification runs.

- [ ] **Step 2: Update docs**

Document the safe Claude route, sanitized bounded packet, WebSearch/WebFetch plus egress policy hook, no cookie/API/shell access, no fallback no-op, per-notification readback, and the fact that normal member routes and scheduler budget are unchanged. Mark live sweep validation as not performed until explicit authorization. In `docs/tasks/current.md`, separate code/test delivery from live timer/sweep verification.

- [ ] **Step 3: Verify documentation consistency**

Run:

```bash
rg -n "固定回覆|固定 allowlist|不啟動 AI|已閱讀，目前無補充|WebSearch|WebFetch|safe discussion" docs/operations.md docs/tasks/current.md
git diff --check
```

Expected: no stale operational statement says that main-workspace notifications use the fixed no-op or that all notification preflights are driver-only; historical specs may retain their historical note.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/operations.md docs/tasks/current.md
git commit -m "docs: document safe discussion notification flow"
```

### Task 6: Full verification and delivery checkpoint

**Files:**
- Verify all changed files; do not modify production data or execute live sweep.

- [ ] **Step 1: Run required verification**

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json
npx tsx sim/run.test.ts
git diff --check
git status --short
```

Expected: typecheck and sim tests pass, diff check is clean, and only intentional commits/files are present.

- [ ] **Step 2: Inspect the final diff for security regressions**

Confirm that no notification path contains `Bash(curl:*)`, `--dangerously-bypass`, actor cookie/password in a discussion prompt, fixed no-op POST, Codex/AGY safe fallback, or live sweep invocation. Confirm normal `MEMBER_TOOLS`, `workSessionForMember`, owner route, and scheduler selection are unchanged.

- [ ] **Step 3: Finish with deployment status separated from code status**

Report code/test completion separately from service/timer/live status. Do not restart timers or call `npm run sim` without explicit live authorization. If requested later, use `/api/health`, `systemctl --user`, and a synthetic safe notification for controlled live verification.
