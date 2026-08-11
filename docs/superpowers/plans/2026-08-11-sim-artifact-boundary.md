# Sim Artifact Commit Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent member driver and Owner review from allowing generated root-level scratch files into the main branch while preserving legitimate product changes.

**Architecture:** Keep the existing isolated-worktree flow and add one fail-closed path policy at the driver commit boundary plus the Owner review boundary. Product directories are allowed, common root configuration/docs files are explicitly allowed, and any other newly added root-level file blocks the commit/review. Existing unrelated UI edits remain outside the cleanup and guard commits.

**Tech Stack:** TypeScript, `sim/run.ts`, `sim/run.test.ts`, Git porcelain/diff commands, `tsx` tests.

---

### Task 1: Remove already tracked generated artifacts

**Files:**
- Delete only the currently deleted generated files: `.c1.json`, `.c2.json`, `.c3.json`, `.kev_test.json`, `.node-vulns.json`, `.nvd1.json` through `.nvd6.json`, `.tasks_user02.json`, `comment_body_b399.txt`, `comments_b399.json`, `make_payload.js`, `make_payload.py`, `tasks_user06.json`.
- Do not stage `public/css/task-detail.css` or `public/js/views/task-detail.js`.

- [ ] Verify the cleanup staging set contains only those deletions.
- [ ] Commit with `chore: remove generated sim artifacts`.

### Task 2: Add failing path-policy tests

**Files:**
- Modify: `sim/run.test.ts`

- [ ] Add tests proving files under `src/`, `public/`, and `docs/` are allowed.
- [ ] Add tests proving unallowlisted root `.json`, `.txt`, `.js`, and `.py` files are rejected.
- [ ] Add a test proving an Owner review packet reports a committed root artifact as disallowed.
- [ ] Run the focused tests and confirm they fail before implementation.

### Task 3: Implement fail-closed driver and Owner checks

**Files:**
- Modify: `sim/run.ts`

- [ ] Add an explicit delivery-path policy using tracked top-level directories plus common root config/docs files.
- [ ] Make `commitMemberWork()` refuse to stage/commit any disallowed new or staged-added path.
- [ ] Add `disallowedFiles` to review packets and make Owner review fail when the branch contains one.
- [ ] Keep known dependency noise handling and existing product-path behavior intact.

### Task 4: Verify and commit guard changes

**Files:**
- Modify: `sim/run.test.ts`, `sim/run.ts`

- [ ] Run `npx tsx sim/run.test.ts`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Inspect `git diff --check` and the final staged file list.
- [ ] Commit with `fix: fail closed on sim artifact paths`.

