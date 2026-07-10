# Sim Run Hardening Implementation Plan

**Goal:** Make the sim harness fail closed around agent sessions and CI while keeping permissions narrow and allowing unaffected runners to continue.

**Architecture:** Keep the existing single-file harness and stdlib process model. Add small pure policy helpers, one native harness lock, driver-owned member commits, and explicit `pass` / `fail` / `skip` CI states. Do not add a database schema, permissions framework, or new orchestration package.

**Tech Stack:** TypeScript, Node.js stdlib, Git CLI/worktrees, existing `tsx` test runner.

---

## Task 1: Lock Down Session Completion

- [x] Add tests proving only a successful, non-timeout session may trigger a member commit.
- [x] Make Claude and Codex member sessions follow the same rule: agents edit and verify; the driver commits.
- [x] Remove direct member Git tool permission, validate the expected worktree/branch again, and run `git diff --cached --check` before driver commits.
- [x] Stop a new sprint when the owner opening session fails, write discovery/report data, and remove untouched worktrees/branches.
- [x] Wait for every parallel member session to settle before surfacing a commit failure and releasing the process lock.

## Task 2: Make CI Truthful

- [x] Replace `CommandCheck.ok` with `status: 'pass' | 'fail' | 'skip'`.
- [x] Treat missing tooling or multi-project checks as `skip`, require manual review, and never count it as a green branch.
- [x] Mark uncommitted failed-session diffs as CI `fail` so they remain recoverable instead of looking lost.
- [x] Update review packets, reports, prompts, sweep output, and merge filters.
- [x] Add focused formatter, policy, no-tooling, multi-project, and dirty-state tests/checks.

## Task 3: Isolate Quota and Concurrent Runs

- [x] Probe Claude only for owner work; do not cancel Codex member work when Claude is unavailable.
- [x] Add a pure sweep-budget helper and tests for `owner`, `team`, and `both` routing.
- [x] Add a native global process lock with stale-PID recovery so manual runs and timers cannot mutate the shared board/repos concurrently.
- [x] Process at most one workspace per repo in each sweep tick because member branches are still shared by repo.
- [x] Validate Git top-level/master, symlink-resolved worktree paths, and expected member branches; keep writable cookies in each worktree and package cache under `/tmp`.

## Task 4: Verify and Document

- [x] Add `sim/tsconfig.json` and include strict sim type-checking in `npm test`.
- [x] Run the focused sim test, TypeScript check, full test suite, build, and `git diff --check`.
- [x] Review the diff for permission expansion, false-green paths, and unrelated changes.
- [x] Update the Phase 12 tracker and sim amplification plan with implemented behavior and residual limits.

## Permission Boundary

- The Claude member tool allowlist prevents direct Git commands and reduces accidental history changes. It is an operational policy, not an adversarial sandbox: allowed `npm`/`npx` commands can execute project code.
- Codex keeps its existing `workspace-write` filesystem sandbox. Both runners still rely on driver-side pre-commit Git root/branch validation.
- Driver CI executes branch code on the host. Use a container or VM before accepting untrusted contributors or prompts; do not represent this harness as hostile-code isolation.

## Deferred

- Split `sim/run.ts` into modules only after these policies need reuse.
- Add structured task-to-repo metadata only when tasks can be moved between scenario workspaces.
- Add cross-run database tables only when file reports are insufficient for real queries.
- Include workspace IDs in branch/worktree names only when same-repo workspaces must run concurrently; current sweeps intentionally serialize them.
- Move driver CI into a container/VM if the trust model changes from cooperative agents to untrusted code.
