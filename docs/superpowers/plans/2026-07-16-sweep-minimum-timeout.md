# Sweep Minimum Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every owner and team sweep session a 20-minute minimum so active member work is not aborted after seven minutes.

**Architecture:** Change only the two sweep timeout constants in `sim/run.ts`. Keep full-sprint timeout settings and the owner adaptive +6-minute, 30-minute-cap calculation unchanged. Use focused source contracts to make the configured minimum and cap explicit.

**Tech Stack:** TypeScript, `tsx`, npm test/build scripts.

---

### Task 1: Raise sweep session minimums

**Files:**
- Modify: `sim/run.ts:1822-1823`
- Modify: `sim/run.test.ts:45-80`

- [ ] **Step 1: Write the failing timeout contract**

  Add these assertions near the existing source-contract assertions in `sim/run.test.ts`:

  ```ts
  assert.ok(source.includes('const SWEEP_OWNER_TIMEOUT = 20 * 60 * 1000;'), 'owner sweep 基準必須至少 20 分鐘');
  assert.ok(source.includes('const SWEEP_MEMBER_TIMEOUT = 20 * 60 * 1000;'), 'team member sweep 必須至少 20 分鐘');
  assert.ok(
    source.includes('Math.min(SWEEP_OWNER_TIMEOUT + ownerState.streak * 6 * 60 * 1000, 30 * 60 * 1000)'),
    'owner sweep 必須保留既有 30 分鐘 adaptive cap',
  );
  ```

- [ ] **Step 2: Run focused test and verify red**

  Run: `npx tsx sim/run.test.ts`

  Expected: FAIL because the current source declares 12- and 7-minute sweep timeout constants.

- [ ] **Step 3: Change only the sweep constants**

  In `sim/run.ts`, replace:

  ```ts
  const SWEEP_OWNER_TIMEOUT = 12 * 60 * 1000;
  const SWEEP_MEMBER_TIMEOUT = 7 * 60 * 1000;
  ```

  with:

  ```ts
  const SWEEP_OWNER_TIMEOUT = 20 * 60 * 1000;
  const SWEEP_MEMBER_TIMEOUT = 20 * 60 * 1000;
  ```

  Do not change `MEMBER_TIMEOUT`, `OWNER_TIMEOUT`, the owner +6-minute increment, or its 30-minute cap.

- [ ] **Step 4: Run focused test and verify green**

  Run: `npx tsx sim/run.test.ts`

  Expected: exits 0 and prints `sim/run.test.ts OK`.

- [ ] **Step 5: Verify and commit**

  Run: `npx tsc --noEmit && npm test && npm run build && git diff --check`

  Expected: all commands exit 0; `git diff --check` has no output.

  Commit:

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "fix: extend sweep session timeouts"
  ```

### Task 2: Resume the retained user06 work

**Files:**
- Read: `sim-work/user06/public/js/views/kanban.js`, `sim-logs/`, `data/dev.db`
- No source change expected before the live run.

- [ ] **Step 1: Preserve and inspect the retained diff**

  Run `git -C sim-work/user06 status --short` and `git -C sim-work/user06 diff --stat`. Confirm the existing `public/js/views/kanban.js` diff remains present; do not reset, checkout, clean, or delete it.

- [ ] **Step 2: Execute the authorized team sweep after merge**

  Run: `npm run sim -- --sweep team`

  Expected: user06 normal session starts as `claude/claude-sonnet-5`, has a 20-minute limit, and runs in the existing `sim-work/user06` worktree.

- [ ] **Step 3: Read back task and worktree effects**

  Inspect the new sweep log, user06's task/comments, and `sim-work/user06` status/log. Accept success only if the retained/continued diff is committed by driver or user06 creates a task/comment/status side effect with concrete verification. Report a timeout or no-side-effect exit as failure; never discard the retained diff.
