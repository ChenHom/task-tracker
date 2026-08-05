# Owner Sweep Worktree Recovery Design

## Goal

Restore legacy Owner sweep execution and prevent a missing shared member worktree from aborting an entire Owner tick.

## Confirmed root cause

The directories under `sim-work/user03` through `sim-work/user06` were removed, but Git retained their worktree administrative entries under `.git/worktrees/`. `git worktree prune --dry-run` reports those entries as prunable. `sim/user03` still exists and is two commits ahead of `master`, so deleting the branch would discard reviewable work.

`ensureWorktree()` currently checks only whether the target directory exists. When it is absent, it calls `git worktree add`; Git rejects the add because the stale administrative entry still claims the branch is checked out. The exception escapes the sweep before the canonical workspace Owner session can run.

## Scope

In scope:

- Remove only confirmed stale worktree metadata from the current checkout.
- Recreate `sim-work/user03` from the existing `sim/user03` branch without resetting or deleting commits.
- Add a narrow `ensureWorktree()` recovery path for an absent target whose Git worktree registration is stale.
- Add regression coverage for stale registration recovery and branch preservation.
- Verify the existing Owner timer, service health, and next scheduled tick without manually starting a live AI sweep.

Out of scope:

- Merging `sim/user03`'s notification telemetry commits.
- Changing task-tracker API behavior, DB state, timer cadence, or Owner prompts.
- Running `npm run sim -- --sweep` manually.
- Deleting or force-resetting any `sim/user03` branch.

## Design

The operational recovery runs first: inspect with `git worktree prune --dry-run`, prune only missing worktree registrations, and reattach `sim/user03` from its branch. The branch's ahead count and commit IDs are checked before and after the operation.

The harness recovery remains narrow. When `ensureWorktree()` is asked to materialize a missing member worktree, it first detects whether Git has a stale registration for that exact expected path. If the path is absent and the registration is prunable, it prunes stale registrations and retries the existing `git worktree add` path once. A present path still goes through the existing validation and is never pruned. A non-prunable or unexpected registration continues to fail loudly.

## Verification

The regression test will create a temporary Git repository, create a branch with an unmerged commit, add a worktree, remove only the worktree directory, and invoke the recovery helper. It will assert that the worktree is recreated on the same branch and that the unmerged commit remains reachable. Existing worktree validation tests must remain green.

Run:

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json
node --import tsx sim/run.test.ts
npm test
git diff --check
```

After the operational recovery, verify `git worktree list --porcelain`, `/api/health`, and the Owner timer's next trigger. The next scheduled timer tick is the runtime validation; no manual AI sweep is required for this fix.
