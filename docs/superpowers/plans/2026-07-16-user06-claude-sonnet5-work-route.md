> **已取代／歷史紀錄（2026-07-16）**：現行政策見 [user06 Sonnet 5 路由恢復設計](../specs/2026-07-16-user06-sonnet5-route-restoration-design.md)。user06 一般工作使用 Claude `claude-sonnet-5`，不設 AGY fallback；notification preflight 使用 Codex `gpt-5.4-mini`。以下內容保留為歷史記錄。

# user06 Claude Sonnet 5 Work Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route user06's normal member work through Claude Sonnet 5 without affecting its Codex notification preflight or permitting an AGY fallback.

**Architecture:** Add a `workRoute` override to the configured member shape and expose one resolver that returns both the route and permitted fallback. Both normal-work entry points consume the resolver; notification routing is unchanged. This makes a work override an explicit boundary that suppresses the member's configured AGY fallback.

**Tech Stack:** TypeScript, Node `node:sqlite`, `tsx` focused tests, npm build/test scripts.

---

## File structure

- Modify `sim/run.ts:41-60,145-158,439-465,1712-1725,2177-2186` — carry the work override from configuration, resolve route/fallback once, and use it at the full-sprint and team-sweep normal-session entry points.
- Modify `sim/run.test.ts:12-45,692-706` — import the resolver and assert user06's route/fallback boundary plus source contracts for both entry points.

### Task 1: Resolve user06 normal work independently of AGY

**Files:**
- Modify: `sim/run.ts:41-60,145-158,439-465,1712-1725,2177-2186`
- Test: `sim/run.test.ts:12-45,692-706`

- [ ] **Step 1: Write the failing focused tests**

  In `sim/run.test.ts`, import `workSessionForMember` and append these checks after the existing notification-route checks:

  ```ts
  assert.deepStrictEqual(
    workSessionForMember(user06),
    { route: { runner: 'claude', model: 'claude-sonnet-5' }, fallback: undefined },
    'user06 一般工作必須改走 Claude Sonnet 5，且不得回退 AGY',
  );
  assert.deepStrictEqual(
    workSessionForMember(user02),
    { route: { runner: 'codex', model: 'gpt-5.4-mini' }, fallback: undefined },
    '未設 override 的 user02 必須維持既有一般工作路由',
  );
  assert.ok(
    source.includes('const workSession = workSessionForMember(m);'),
    'full sprint 與 team sweep 必須透過一般工作 resolver',
  );
  assert.strictEqual(
    (source.match(/const workSession = workSessionForMember\(m\);/g) ?? []).length,
    2,
    'full sprint 與 team sweep 各應有一個一般工作 resolver 呼叫點',
  );
  ```

- [ ] **Step 2: Run the focused test and verify red**

  Run: `npx tsx sim/run.test.ts`

  Expected: FAIL because `workSessionForMember` is not exported yet.

- [ ] **Step 3: Add the minimal route resolver and user06 override**

  In `sim/run.ts`, add `workRoute?: ModelRoute` to both `Member` and `MemberRunnerConfig`; set only user06 to:

  ```ts
  workRoute: { runner: 'claude', model: 'claude-sonnet-5' },
  ```

  Copy `workRoute: config.workRoute` in `loadMembersFromUsers`. Directly after `notificationRouteForMember`, export:

  ```ts
  export function workSessionForMember(
    member: Pick<Member, 'runner' | 'model' | 'fallback' | 'workRoute'>,
  ): { route: ModelRoute; fallback: ModelRoute | undefined } {
    if (member.workRoute) return { route: member.workRoute, fallback: undefined };
    return { route: { runner: member.runner, model: member.model }, fallback: member.fallback };
  }
  ```

  At each normal member-session entry point, declare `const workSession = workSessionForMember(m);` and replace only normal-session `runner`, `model`, and `fallback` values with `workSession.route.runner`, `workSession.route.model`, and `workSession.fallback`. Keep notification preflight values and `notificationRouteForMember(m)` unchanged.

- [ ] **Step 4: Run the focused test and verify green**

  Run: `npx tsx sim/run.test.ts`

  Expected: exits 0 and ends with `sim/run.test.ts: OK`.

- [ ] **Step 5: Run static checks and commit the implementation**

  Run: `npx tsc --noEmit && npm test && npm run build && git diff --check`

  Expected: all commands exit 0 and `git diff --check` produces no output.

  Commit:

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "fix: route user06 work through claude sonnet 5"
  ```

### Task 2: Verify the authorized production-like team sweep

**Files:**
- Read: `data/dev.db`, `sim-logs/`, `docs/operations.md:Sim harness`
- No source changes expected.

- [ ] **Step 1: Check the live preconditions without mutating the board**

  Use the local database to confirm user06 has at least one assigned `Todo` or `Doing` task in an eligible workspace. Confirm the local service returns HTTP 200 at `http://127.0.0.1:3000/api/health`. If either condition fails, report the exact condition and do not run a sweep.

- [ ] **Step 2: Execute the one authorized live team sweep**

  Run: `npm run sim -- --sweep team`

  Expected: the user06 ordinary session log identifies `claude/claude-sonnet-5`; user06 notification work, if any, identifies `codex/gpt-5.4-mini`; neither phase starts an AGY session.

- [ ] **Step 3: Read back observable effects**

  Inspect the new sweep log and database task/comment/event rows for user06. Accept only a task state change, comment, task content change, or committed worktree change attributable to user06 as ordinary-work success. An exit code of 0 with only self-identification is failure; report it and leave the task state untouched.

- [ ] **Step 4: Commit only if operational evidence requires a source/doc correction**

  If no repository file changed, leave the worktree clean. If an evidence-backed correction is necessary, first write and run its focused regression test, then commit it separately with a narrow message.
