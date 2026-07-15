# Main Owner Sweep Silence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the main-workspace Owner sweep from posting repetitive status comments when nothing material has changed.

**Architecture:** The Owner session already receives a dedicated main-workspace prompt. Add an explicit instruction there to compare discussion comments with the prior Owner update and remain silent for unchanged state. Keep the operator guide aligned and use the existing source-contract regression test to prevent prompt drift.

**Tech Stack:** TypeScript, Node built-in assertions, Markdown.

---

### Task 1: Lock the silent-sweep rule in a failing regression test

**Files:**
- Modify: `sim/run.test.ts:80-110`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Add the failing source-contract assertion after the existing main-workspace prompt assertions.**

```ts
assert.ok(
  source.includes('沒有新增實質意見、直接指示或流程節點變化時，不得 POST 留言'),
  '主工作區 owner 無變化時必須保持靜默，不能重複張貼期限或 Todo 摘要',
);
```

- [ ] **Step 2: Run the focused test and verify the expected failure.**

Run: `npx tsx sim/run.test.ts`

Expected: assertion failure stating that the silent-sweep rule is missing.

### Task 2: Add the explicit main-workspace prompt guard

**Files:**
- Modify: `sim/run.ts:1718-1741`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Add this instruction immediately after the existing deadline rule in `ownerSweepPrompt()`.**

```text
5. 沒有新增實質意見、直接指示或流程節點變化時，不得 POST 留言：重複說明仍為 Todo、截止尚未到、既有共識未變，全部視為無變化並保持靜默。只有新的實質 Commenter／建立者意見、老闆直接指示、初始 OWNER想法或全員通知、阻塞／範圍／決策變化，或到期收斂時才留言。
```

Renumber the following prompt steps without altering their lifecycle requirements.

- [ ] **Step 2: Run the focused test and verify it passes.**

Run: `npx tsx sim/run.test.ts`

Expected: exit code 0 and `sim/run.test.ts OK`.

### Task 3: Keep the operator guide and deployment evidence aligned

**Files:**
- Modify: `docs/owner-sweep-guide.md:45-48`
- Verify: `sim/run.test.ts`, TypeScript compiler, production health endpoint

- [ ] **Step 1: Amend the `留言與紀錄原則` paragraph to define an unchanged task as silent.**

```markdown
固定期限尚未到期、既有共識未變且沒有新實質意見時，Owner 不新增「仍為 Todo」或截止提醒；下一次有實質變化或必須收斂時再更新。
```

- [ ] **Step 2: Run the required code verification.**

Run: `npx tsx sim/run.test.ts && npx tsc --noEmit && npx tsc -p sim/tsconfig.json && git diff --check`

Expected: every command exits 0; focused test prints `sim/run.test.ts OK`.

- [ ] **Step 3: Commit the implementation.**

```bash
git add sim/run.ts sim/run.test.ts docs/owner-sweep-guide.md
git commit -m "fix: silence unchanged main owner sweeps"
```

- [ ] **Step 4: Build and deploy the committed master revision.**

```bash
npm run build
systemctl --user restart task-tracker.service
curl -sS http://127.0.0.1:3000/api/health
```

Expected: build exits 0, service restarts, and health returns `{"status":"ok","db":true}`. Do not run a live sweep; it is not required to deploy the prompt contract and requires separate authorization.
