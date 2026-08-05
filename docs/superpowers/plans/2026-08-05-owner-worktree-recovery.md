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

- [ ] Add `pruneStaleWorktreeRegistration` to the `./run` imports.
- [ ] Add a temporary Git repository test that creates `sim/user03` one commit ahead, removes only its worktree directory, calls `pruneStaleWorktreeRegistration(repo, worktree)`, asserts the helper returns `true`, asserts the branch head is unchanged and remains one commit ahead, reattaches the worktree, and asserts `git branch --show-current` is `sim/user03`.
- [ ] Use `try/finally` to run `git worktree remove --force` when the temporary worktree exists and then remove the temporary repository.
- [ ] Run `node --import tsx sim/run.test.ts` and confirm RED because the helper is not exported yet.

### Task 2: Implement the minimal recovery seam

**Files:**
- Modify: `sim/run.ts` near `validateMemberWorktree()` and `ensureWorktree()`.

- [ ] Export `pruneStaleWorktreeRegistration(repoRoot, worktreePath)`. Return `false` when the path exists or its exact `git worktree list --porcelain` entry is not marked `prunable`; otherwise run `git worktree prune --expire now` in `repoRoot` and return `true`.
- [ ] Call `pruneStaleWorktreeRegistration(RUN.repoRoot, wt(m))` only after `ensureWorktree()` has found the expected path missing and before existing branch-ahead handling.
- [ ] Leave existing branch handling unchanged: ahead branches are reattached, zero-ahead branches may be recreated from `master`.
- [ ] Do not add `--force`, delete ahead branches, reset files, merge user03, or change timer behavior.
- [ ] Run `node --import tsx sim/run.test.ts` and confirm GREEN.

### Task 3: Verify code and repository safety

**Files:**
- No additional files.

- [ ] Run `npx tsc --noEmit`, `npx tsc -p sim/tsconfig.json`, `node --import tsx sim/run.test.ts`, and `git diff --check`; all must exit 0.
- [ ] Run `npm test`; lint, application tests, sim tests, escalation tests, and production runner tests must pass.
- [ ] Confirm `git diff --name-only` contains only the intended plan/spec and recovery implementation/test files, and `git rev-parse sim/user03` remains `66f31351f27346155cea0a8642f480de0f59b576`.

### Task 4: Recover live stale metadata without starting an AI run

**Files:**
- Runtime metadata only: `.git/worktrees/*` and `sim-work/user03`.

- [ ] Capture `git rev-parse sim/user03` before pruning.
- [ ] Run `git worktree prune --dry-run`, then `git worktree prune`; only confirmed missing `user03`–`user06` registrations may be removed.
- [ ] Run `git worktree add sim-work/user03 sim/user03`, then verify `git -C sim-work/user03 status --short --branch` and the unchanged branch head.
- [ ] Verify `/api/health`, `systemctl --user list-timers --all 'sim-sweep-*' --no-pager`, and that `sim-logs/.run.lock` is absent.
- [ ] Do not run `npm run sim -- --sweep`; the next existing Owner timer tick is the runtime validation.
