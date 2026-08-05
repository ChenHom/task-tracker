# Fixed Sweep Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the cross-repo baseline workspace to legacy Owner/Team sweep without confusing it with repo canonical routing.

**Architecture:** Keep `CANONICAL_WORKSPACE_BY_REPOROOT` for repo-to-receiving-workspace routing. Add a separate fixed `workspaceId -> scenarioKey` sweep allowlist, and include those IDs in managed-roster reconciliation so Owner can assign user02–user06 before Team runs them.

**Tech Stack:** TypeScript, existing `sim/run.ts` candidate discovery, assertion-based `sim/run.test.ts`, Markdown operations documentation, and user-level systemd timers.

---

### Task 1: Document the approved design

**Files:**
- Create: `docs/superpowers/specs/2026-08-05-fixed-sweep-workspace-design.md`
- Create: `docs/superpowers/plans/2026-08-05-fixed-sweep-workspace.md`

- [x] Record the distinction between canonical mapping and fixed sweep allowlist.
- [x] Record `b2637f07-44b3-49b0-b2c4-4da4e19cd1ac -> self-directed`, active-workspace filtering, and managed roster reconciliation.
- [x] Commit the design and plan before implementation.

### Task 2: Add the failing candidate and roster assertions

**Files:**
- Modify: `sim/run.test.ts` near the existing candidate and roster assertions.
- Test: `sim/run.test.ts`

- [ ] Import `ensureFixedSweepWorkspaceCandidates`, `FIXED_SWEEP_WORKSPACE_SCENARIOS`, and the roster helper used by `isManagedRosterWorkspace` tests.
- [ ] Assert the fixed candidate map adds `b2637f07-44b3-49b0-b2c4-4da4e19cd1ac` with `{ key: 'self-directed', startedAt: '1970-01-01T00:00:00.000Z' }`.
- [ ] Assert the existing canonical mapping still resolves only the task-tracker root to `d9da9945-ce5f-400f-806e-1d75e95e313a`.
- [ ] Assert `isManagedRosterWorkspace('b2637f07-44b3-49b0-b2c4-4da4e19cd1ac', false)` is true.
- [ ] Run `node --import tsx sim/run.test.ts`; it must fail because the new exports/helper do not exist yet.

### Task 3: Implement the separate fixed sweep allowlist

**Files:**
- Modify: `sim/run.ts` near `CANONICAL_WORKSPACE_BY_REPOROOT`, candidate helpers, and `isManagedRosterWorkspace`.

- [ ] Add `FIXED_SWEEP_WORKSPACE_SCENARIOS` with the exact b263 workspace ID mapped to `self-directed`.
- [ ] Add `ensureFixedSweepWorkspaceCandidates(candidates)` that inserts only missing fixed candidates and never overwrites report-derived scenario data.
- [ ] Add a managed workspace ID helper that combines canonical workspace IDs and fixed sweep workspace IDs without duplicates.
- [ ] Make `isManagedRosterWorkspace` use that combined set by default, while preserving explicit `managedWorkspaceIds` test overrides.
- [ ] Call `ensureFixedSweepWorkspaceCandidates(wsScenario)` after the existing main/canonical candidate calls.
- [ ] Leave all-repository DB discovery, fake report creation, and automatic Team self-assignment out of scope.

### Task 4: Write the operator usage guide

**Files:**
- Modify: `docs/operations.md` in the sweep candidate and managed-roster sections.

- [ ] Explain that canonical mapping is `repoRoot -> workspaceId` for fixed receiving destinations.
- [ ] Explain that fixed sweep allowlist is `workspaceId -> scenarioKey` for existing workspaces that should be swept without reports.
- [ ] Document the b263 mapping, `self-directed` scenario, active check, roster sync, Owner-first/Team-second sequence, and the rule not to fabricate reports.
- [ ] Document how to add another repo canonical mapping versus how to add another existing sweep workspace.

### Task 5: Verify and validate the live flow

**Files:**
- No additional files.

- [ ] Run `node --import tsx sim/run.test.ts`, `npx tsc --noEmit`, `npx tsc -p sim/tsconfig.json`, `npm test`, and `git diff --check`.
- [ ] Confirm the working tree contains only the intended code/test/docs changes and preserve all existing live sweep commits.
- [ ] Let the next scheduled Owner timer validate candidate discovery and roster reconciliation; do not manually start a live AI sweep.
- [ ] Verify the Owner log includes `b2637f07`, then verify the following Team log contains member handling after Owner assignments exist.
