# Sim Model Route Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `user04` to Codex GPT-5.6 Luna and Owner opening/ideation to Claude Opus 5.5 without changing any other sim route.

**Architecture:** Keep the existing static routing in `sim/run.ts`. Add focused regression assertions to the existing sim test, change only the two configured model IDs, and update the current-state fleet documentation while preserving explicitly historical notes.

**Tech Stack:** TypeScript, Node.js assertions, `tsx`, TypeScript compiler

---

### Task 1: Pin the two new model routes

**Files:**
- Modify: `sim/run.test.ts:1247`
- Modify: `sim/run.ts:362-376`
- Modify: `sim/run.ts:1755-1761`

- [x] **Step 1: Write the failing route assertions**

Add these focused assertions beside the existing `user02` model assertion:

```ts
assert.strictEqual(
  members.find((member) => member.email === 'user04@test.local')?.model,
  'gpt-5.6-luna',
  '婷婷的工作必須使用 GPT-5.6 Luna',
);
assert.ok(
  source.includes("const OWNER_OPEN_MODEL = 'claude-opus-5-5';"),
  'Owner 開場與發想必須使用 Claude Opus 5.5',
);
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx sim/run.test.ts
```

Expected: FAIL because `user04` still resolves to `gpt-5.4-mini` and Owner opening still uses `claude-sonnet-5`.

- [x] **Step 3: Apply the minimal route changes**

Change only these values in `sim/run.ts`:

```ts
{ email: 'user04@test.local', runner: 'codex', model: 'gpt-5.6-luna',
```

```ts
const OWNER_OPEN_MODEL = 'claude-opus-5-5';
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx tsx sim/run.test.ts
```

Expected: exit code 0 and the sim test completion message.

### Task 2: Align current-state documentation and verify types

**Files:**
- Modify: `docs/tasks/current.md:179`

- [x] **Step 1: Update the active fleet summary**

Replace the stale mixed-fleet summary with an explicit current route summary:

```markdown
- [x] 現行混合車隊：Owner 開場/發想=Claude Opus 5.5，中場/收尾/repair=Codex GPT-5.6 Sol；user02=Claude Sonnet 5（AGY Claude Sonnet 4.6 Thinking fallback）；user03=Codex GPT-5.6 Terra；user04=Codex GPT-5.6 Luna；user05=Codex GPT-5.6 Luna；user06=AGY Gemini 3.7 Flash High（AGY Claude Sonnet 4.6 Thinking fallback）。歷史路由與遷移紀錄保留於下方各階段說明。
```

- [x] **Step 2: Run required verification**

Run:

```bash
npx tsc --noEmit
npx tsx sim/run.test.ts
```

Expected: both commands exit 0.

- [x] **Step 3: Inspect the scoped diff**

Run:

```bash
git diff --check
git diff -- sim/run.ts sim/run.test.ts docs/tasks/current.md
```

Expected: no whitespace errors; diff contains only the two model changes, two assertions, and current-state documentation update.

Do not run `npm run sim` or any sweep command.
