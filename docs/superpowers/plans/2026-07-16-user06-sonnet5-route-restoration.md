# user06 Sonnet 5 Route Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore user06 normal work to Claude Sonnet 5 after the AGY no-side-effect trial and Claude quota recovery.

**Architecture:** Change user06's explicit `workRoute` from AGY back to Claude; the existing resolver continues to make the override fail closed. Update current-route documentation and mark the AGY quota design/plan historical.

**Tech Stack:** TypeScript, `tsx`, npm test/build scripts.

---

### Task 1: Restore the Sonnet 5 work route

**Files:**
- Modify: `sim/run.ts`, `sim/run.test.ts`
- Modify: `docs/operations.md`, `docs/tasks/current.md`, `docs/superpowers/specs/2026-07-16-user06-agy-quota-containment-design.md`, `docs/superpowers/plans/2026-07-16-user06-agy-quota-route.md`

- [ ] **Step 1: Write the failing route test**

  Change user06's work-session assertion to expect:

  ```ts
  { route: { runner: 'claude', model: 'claude-sonnet-5' }, fallback: undefined }
  ```

- [ ] **Step 2: Run focused test red**

  Run: `npx tsx sim/run.test.ts`

  Expected: FAIL while the route remains AGY.

- [ ] **Step 3: Restore only the explicit work route and current documentation**

  Set user06 `workRoute` to `{ runner: 'claude', model: 'claude-sonnet-5' }`; preserve Codex notification route and no-fallback resolver. Update operator/current-state docs and mark the AGY quota spec/plan superseded by the restoration spec.

- [ ] **Step 4: Run verification and commit**

  Run: `npx tsx sim/run.test.ts && npx tsc --noEmit && npm test && npm run build && git diff --check`

  Expected: all commands exit 0.

  Commit:

  ```bash
  git add sim/run.ts sim/run.test.ts docs/operations.md docs/tasks/current.md docs/superpowers/specs/2026-07-16-user06-agy-quota-containment-design.md docs/superpowers/plans/2026-07-16-user06-agy-quota-route.md
  git commit -m "fix: restore user06 Sonnet work route"
  ```

### Task 2: Verify one resumed user06 session

**Files:**
- Read: `sim-logs/`, `data/dev.db`, `sim-work/user06`

- [ ] **Step 1: Confirm service, lock, and assigned Doing task**

  Confirm `/api/health` is healthy, no run lock exists, and user06's notification task is still assigned/Doing.

- [ ] **Step 2: Run one authorized team sweep**

  Run: `npm run sim -- --sweep team`

  Expected: user06 normal log identifies `claude/claude-sonnet-5`, notifications remain Codex if needed, and AGY does not start.

- [ ] **Step 3: Require real side effects**

  Confirm user06 creates a task/comment/state/content effect or driver commit. A no-op exit is reported as failure and does not advance the task.
