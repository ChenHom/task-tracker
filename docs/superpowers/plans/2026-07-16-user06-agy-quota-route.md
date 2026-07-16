# user06 AGY Quota Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporarily route user06's normal work through AGY while Claude's five-hour quota is exhausted, without changing Codex notification handling or allowing fallback.

**Architecture:** Reuse the existing `workRoute` override and `workSessionForMember` boundary. Change only user06's explicit work route to AGY; the resolver already returns `fallback: undefined` for every explicit work override, so both normal-work entry points remain fail-closed.

**Tech Stack:** TypeScript, `tsx`, npm test/build scripts.

---

### Task 1: Route user06 normal work through AGY

**Files:**
- Modify: `sim/run.ts:156-160`
- Modify: `sim/run.test.ts:704-724`

- [ ] **Step 1: Write the failing route assertion**

  Replace user06's current work-session expectation with:

  ```ts
  assert.deepStrictEqual(
    workSessionForMember(user06),
    { route: { runner: 'agy', model: 'Gemini 3.5 Flash (High)' }, fallback: undefined },
    'Claude 額度耗盡期間，user06 一般工作必須改走 AGY 且不得 fallback',
  );
  ```

- [ ] **Step 2: Run focused test and verify red**

  Run: `npx tsx sim/run.test.ts`

  Expected: FAIL because the user06 override is still Claude Sonnet 5.

- [ ] **Step 3: Change only the explicit user06 work route**

  In the user06 `MEMBER_RUNNERS` entry, replace:

  ```ts
  workRoute: { runner: 'claude', model: 'claude-sonnet-5' },
  ```

  with:

  ```ts
  workRoute: { runner: 'agy', model: 'Gemini 3.5 Flash (High)' },
  ```

  Keep `notificationRoute` as Codex. Do not remove the resolver or change its `fallback: undefined` rule.

- [ ] **Step 4: Run green verification and commit**

  Run: `npx tsx sim/run.test.ts && npx tsc --noEmit && npm test && npm run build && git diff --check`

  Expected: all commands exit 0.

  Commit:

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "fix: route user06 quota work through agy"
  ```

### Task 2: Verify AGY against the remaining user06 task

**Files:**
- Read: `sim-logs/`, `data/dev.db`, `sim-work/user06`
- No source changes expected.

- [ ] **Step 1: Confirm preconditions**

  Confirm user06 has an assigned Todo/Doing task, service health returns `{"status":"ok","db":true}`, and no sim run lock exists.

- [ ] **Step 2: Run one authorized team sweep after merge**

  Run: `npm run sim -- --sweep team`

  Expected: user06 normal session log identifies `agy/Gemini 3.5 Flash (High)`; notification handling, if invoked, identifies Codex; no fallback session starts.

- [ ] **Step 3: Accept only an observable outcome**

  Read user06 task/comment rows and worktree status/log. Success requires a new user06 task/comment/state/content effect or driver worktree commit. A self-introduction, exit 0 without side effect, error, or timeout is failure and leaves task state intact.
