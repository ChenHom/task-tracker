# Owner Sweep Worktree Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Owner sweep worktree recovery without discarding `sim/user03` commits, and prevent stale Git worktree metadata from aborting future Owner ticks.

**Architecture:** Add one repo-scoped helper that detects an absent worktree path marked `prunable` by `git worktree list --porcelain`, prunes stale administrative entries, and returns whether recovery occurred. `ensureWorktree()` calls this helper before its existing branch-preservation and `git worktree add` logic; present or non-prunable worktrees retain current validation behavior.

**Tech Stack:** TypeScript, Node `child_process.execFileSync`, Git worktree metadata, and the existing assertion-based `sim/run.test.ts`.

---

### Task 1: Write the failing stale-registration regression

**Files:**
- Modify: `sim/run.test.ts` import list and worktree safety test section.
- Test: `sim/run.test.ts`

- [x] Add `isPrunableWorktreeEntry` to the `./run` imports.
- [x] Add a parser fixture containing normal, prunable, and unrelated worktree entries; assert only the exact target path marked `prunable` returns `true`.
- [x] Keep branch preservation and actual prune/reattach verification in the live shell steps, because this repository's TypeScript test runner cannot spawn temporary Git repositories inside the restricted sandbox.
- [x] Run the RED check before implementation; it failed because the parser helper was not exported yet.

### Task 2: Implement the minimal recovery seam

**Files:**
- Modify: `sim/run.ts` near `validateMemberWorktree()` and `ensureWorktree()`.

- [x] Export `isPrunableWorktreeEntry(listing, worktreePath)` and make it return `true` only when the exact target block from `git worktree list --porcelain` is marked `prunable`.
- [x] Export `pruneStaleWorktreeRegistration(repoRoot, worktreePath)`. Return `false` when the path exists or the exact listing entry is not prunable; otherwise run `git worktree prune --expire now` in `repoRoot` and return `true`.
- [x] Call `pruneStaleWorktreeRegistration(RUN.repoRoot, wt(m))` only after `ensureWorktree()` has found the expected path missing and before existing branch-ahead handling.
- [x] Leave existing branch handling unchanged: ahead branches are reattached, zero-ahead branches may be recreated from `master`.
- [x] Do not add `--force`, delete ahead branches, reset files, merge user03, or change timer behavior.
- [x] Run `node --import tsx sim/run.test.ts` and confirm GREEN.

### Task 3: Verify code and repository safety

**Files:**
- No additional files.

- [x] Run `npx tsc --noEmit`, `npx tsc -p sim/tsconfig.json`, the focused parser assertion, and `git diff --check`.
- [x] Run `npm test`; lint, application tests, sim tests, escalation tests, and production runner tests passed.
- [x] Confirm `git diff --name-only` contains only the intended plan/spec and recovery implementation/test files, and `git rev-parse sim/user03` remains `66f31351f27346155cea0a8642f480de0f59b576`.

### Task 4: Recover live stale metadata without starting an AI run

**Files:**
- Runtime metadata only: `.git/worktrees/*` and `sim-work/user03`.

- [x] Capture `git rev-parse sim/user03` before pruning.
- [ ] Run `git worktree prune --dry-run`, then `git worktree prune` when the host permits writes to `.git/worktrees`; only confirmed missing `user03`–`user06` registrations may be removed.
- [ ] If the current sandbox blocks `.git` writes, let the next existing Owner timer invoke the new self-heal path, then verify `git -C sim-work/user03 status --short --branch` and the unchanged branch head.
- [ ] Verify `/api/health`, `systemctl --user list-timers --all 'sim-sweep-*' --no-pager`, and that `sim-logs/.run.lock` is absent.
- [ ] Do not run `npm run sim -- --sweep`; the next existing Owner timer tick is the runtime validation.
