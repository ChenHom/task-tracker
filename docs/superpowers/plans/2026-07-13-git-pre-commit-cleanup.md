# Git Pre-commit Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale API snapshot files and enforce the existing frontend lint command before commits.

**Architecture:** Keep the existing `npm run lint` script as the single lint entrypoint. Store a small executable hook in tracked `.githooks/`, then set this checkout's `core.hooksPath` to that directory.

**Tech Stack:** Git hooks, POSIX shell, npm, ESLint.

---

### Task 1: Remove stale API snapshots

**Files:**
- Delete: `.disc_comments.json`
- Delete: `.doc_comments.json`
- Delete: `.owner_tasks.json`
- Delete: `.quota_comments.json`
- Delete: `.sweep-disc.json`
- Delete: `.sweep-tasks.json`

- [ ] **Step 1: Delete only the six requested untracked snapshots**

```bash
rm .disc_comments.json .doc_comments.json .owner_tasks.json .quota_comments.json .sweep-disc.json .sweep-tasks.json
```

- [ ] **Step 2: Verify no requested snapshot remains**

```bash
test ! -e .disc_comments.json
test ! -e .doc_comments.json
test ! -e .owner_tasks.json
test ! -e .quota_comments.json
test ! -e .sweep-disc.json
test ! -e .sweep-tasks.json
```

### Task 2: Add the tracked pre-commit lint hook

**Files:**
- Create: `.githooks/pre-commit`

- [ ] **Step 1: Add an executable hook that runs the existing lint script**

```sh
#!/usr/bin/env sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
exec npm run lint
```

- [ ] **Step 2: Enable the tracked hook path for this checkout**

```bash
git config core.hooksPath .githooks
```

- [ ] **Step 3: Verify the hook is active and preserves lint failure**

```bash
test "$(git config --get core.hooksPath)" = ".githooks"
test -x .githooks/pre-commit
./.githooks/pre-commit
```

Expected: the hook exits non-zero with the existing `public/js/views/kanban.js:385` lint error until that unrelated error is fixed.

### Task 3: Final repository verification

- [ ] **Step 1: Check the final worktree scope**

```bash
git status --short
git diff --check
```

Expected: the six snapshot files are absent; only the hook and the two workflow documents are new, plus any pre-existing unrelated changes.

- [ ] **Step 2: Run the direct lint command for matching evidence**

```bash
npm run lint
```

Expected: the same known `kanban.js:385` lint failure as the hook, with no new errors from the hook itself.
