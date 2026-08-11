# task-tracker Internal Capability Profiles Implementation Plan

> **For agentic workers:** Execute this plan inline with verification checkpoints. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add explicit Owner and Team internal capability profiles for task-tracker API/repo work while keeping the public-only safe discussion route isolated.

**Architecture:** Keep `safeDiscussion` unchanged for external research and main-workspace reply validation. Add a separate internal discussion runner that uses the existing Owner/Member repo tools, an actor-scoped temporary cookie jar, and a repo/worktree cwd. The driver remains responsible for posting the validated discussion reply and marking the notification read; internal sessions may inspect task-tracker state and repo files but must not bypass the notification readback contract.

**Tech Stack:** TypeScript, Node 24 `node:fs`/`node:path`, Claude CLI invocation, existing `sim/run.ts` runner, `sim/notificationSecurity.ts`, offline `sim/run.test.ts`.

---

### Task 1: Add explicit capability contracts and cookie-jar helpers

**Files:**
- Create: `sim/agentCapabilities.ts`
- Test: `sim/agentCapabilities.test.ts`
- Modify: `package.json` only if the focused test is not picked up by the existing `npm test` command

- [x] **Step 1: Write failing tests for profiles, paths, and actor cookie jars**

The tests must assert:

```ts
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTERNAL_OWNER_PROFILE,
  INTERNAL_MEMBER_PROFILE,
  SAFE_DISCUSSION_PROFILE,
  assertCapabilityPath,
  writeActorCookieJar,
} from './agentCapabilities';

assert.strictEqual(SAFE_DISCUSSION_PROFILE.kind, 'safeDiscussion');
assert.strictEqual(INTERNAL_OWNER_PROFILE.kind, 'ownerInternal');
assert.strictEqual(INTERNAL_MEMBER_PROFILE.kind, 'memberInternal');
assert.ok(INTERNAL_OWNER_PROFILE.tools.includes('Bash(curl:*)'));
assert.ok(INTERNAL_MEMBER_PROFILE.tools.includes('Bash(git status:*)'));
assert.throws(() => assertCapabilityPath(INTERNAL_MEMBER_PROFILE, '/home/hom/code/other-repo/file.ts'), /capability path/);
assert.doesNotThrow(() => assertCapabilityPath(INTERNAL_MEMBER_PROFILE, '/home/hom/code/task-tracker/sim-work/user02/src/run.ts'));

const dir = mkdtempSync(join(tmpdir(), 'task-tracker-capability-test-'));
try {
  const jar = join(dir, '.jar-user02.txt');
  writeActorCookieJar(jar, 'session=abc123');
  const text = readFileSync(jar, 'utf8');
  assert.ok(text.includes('localhost\tFALSE\t/\tFALSE\t0\tsession\tabc123'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npx tsx sim/agentCapabilities.test.ts`

Expected: FAIL because `sim/agentCapabilities.ts` does not exist yet.

- [x] **Step 3: Implement the minimal capability module**

Define a `CapabilityProfile` with `kind`, `tools`, and `repoRoot`. Keep the tool strings in this new module (and re-export them from `run.ts`) so the policy module does not import `run.ts` and create a cycle. Keep `SAFE_DISCUSSION_TOOLS` empty of shell tools, enforce paths with `resolve()` plus `relative()`, and write only the `session` cookie in Netscape cookie-jar format with mode `0600`. Reject cookie strings without a `session=` pair.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `npx tsx sim/agentCapabilities.test.ts`

Expected: PASS.

### Task 2: Add internal discussion session invocation

**Files:**
- Modify: `sim/run.ts:1323-1735`
- Test: `sim/run.test.ts`

- [x] **Step 1: Write failing runner contract tests**

Add assertions that internal invocation keeps the safe invocation unchanged, uses the selected internal cwd, does not add `--no-session-persistence`, and never places the raw cookie in the prompt or runner arguments. Add a fake internal session test that creates a temporary jar and removes it after completion.

- [x] **Step 2: Run `npx tsx sim/run.test.ts` and confirm the new assertions fail**

Expected: FAIL because no internal discussion invocation exists.

- [x] **Step 3: Implement `runInternalDiscussionSession`**

Add an input containing `profile`, `cwd`, `cookie`, `prompt`, and `sourceTexts`. Validate the cwd with `assertCapabilityPath`, create a temporary actor jar under that cwd, build an internal prompt that explicitly permits task-tracker API/repo operations while forbidding credential disclosure and direct notification readback, inject only the jar path into that prompt, call the existing `runSession` with `captureContent: false`, and remove the jar in `finally`. Keep `SAFE_DISCUSSION_ROUTE` on its existing isolated code path. Internal sessions may use the profile tools but continue returning text to the driver instead of directly marking notifications read.

The notification packet must carry an explicit `safe`/`internal` discussion mode so the internal runner does not receive the safe route's contradictory “no shell/API/files” instructions. The safe mode remains the default; only the Owner/Team main-workspace callback opts into the internal mode.

- [x] **Step 4: Run `node --import tsx sim/run.test.ts` and verify the runner contract passes**

Expected: PASS, including the existing safe invocation assertions.

### Task 3: Wire Owner and Team main-workspace notifications to the internal profile

**Files:**
- Modify: `sim/run.ts:728-1208,1457-1485,2740-2805`
- Test: `sim/run.test.ts`

- [x] **Step 1: Add failing wiring tests**

Assert that the Owner sweep and Team notification sweep each pass an explicit internal runner callback, that the callback uses the actor-specific profile and cookie, and that ordinary Team work continues to use its own worktree. Keep a source-contract assertion that safe discussion remains available for the public-research path.

- [x] **Step 2: Run `node --import tsx sim/run.test.ts` and verify the wiring tests fail**

Expected: FAIL because the current Owner callback is absent and the Team callback is hard-wired to the safe member runner.

- [x] **Step 3: Implement the smallest wiring change**

Extend the notification discussion callback boundary to receive the already authenticated actor cookie. Add separate Owner and Team internal callbacks that call `runInternalDiscussionSession` with `INTERNAL_OWNER_PROFILE`/`INTERNAL_MEMBER_PROFILE`, `RUN.repoRoot`/`wt(member)`, and the actor cookie. Keep the driver-side reply validation, POST, exact-comment readback, and notification readback unchanged; the internal prompt must explicitly tell the model not to perform those final writes itself.

- [x] **Step 4: Run `node --import tsx sim/run.test.ts` and verify all notification gate tests pass**

Expected: PASS; the gate must still leave failed or invalid notifications unread and must not run the ordinary session when the internal session fails.

### Task 4: Update documentation and run the full verification suite

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-task-tracker-internal-capabilities-discussion.md`
- Modify: `docs/operations.md` only where the actual capability contract differs from the recorded discussion
- Test: `sim/agentCapabilities.test.ts`, `sim/run.test.ts`, full `npm test`

- [x] **Step 1: Document the implemented profiles and unresolved exclusions**

Record the exact internal API base, repo/worktree roots, cookie lifetime, Git allowlist, and the fact that safe public WebFetch remains private-destination blocked. Remove no historical design text; append the implementation status and verification evidence.

- [x] **Step 2: Run focused verification**

Run: `npx tsx sim/agentCapabilities.test.ts`

Run: `npx tsx sim/run.test.ts`

Run: `npx tsc --noEmit`

Expected: all commands exit `0`.

- [x] **Step 3: Run the full repository verification**

Run: `npm test`

Expected: lint, both TypeScript checks, application tests, sim tests, and production coordinator tests all exit `0`.

- [x] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: only the planned source, test, and documentation files are changed; no cookie jars, temporary worktrees, or live sweep logs are added.
