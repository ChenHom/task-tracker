> **已取代／歷史紀錄（2026-07-16）**：現行政策見 [user06 Sonnet 5 路由恢復設計](../specs/2026-07-16-user06-sonnet5-route-restoration-design.md)。user06 一般工作使用 Claude `claude-sonnet-5`，不設 AGY fallback；notification preflight 使用 Codex `gpt-5.4-mini`。以下內容保留為歷史記錄。

# user06 Notification Runner Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear user06 notifications through a side-effect-capable runner while keeping AGY for her normal frontend work, then determine whether AGY can safely return to notification automation.

**Architecture:** Add a notification-only model route to the member configuration. Normal member execution remains unchanged; notification preflights use the override when it exists. The existing notification gate continues to be the only component that can mark an item read.

**Tech Stack:** TypeScript, Node built-in assertions, Codex CLI, AGY CLI.

---

## File structure

- `sim/run.ts` — route model and select notification preflight runner.
- `sim/run.test.ts` — verify override and default routing.
- `docs/operations.md` — record whether AGY remains isolated.

### Task 1: Establish the notification-route contract

**Files:**
- Modify: `sim/run.test.ts:8-56, 680-708`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Write the failing route test.**

Import `notificationRouteForMember`, then assert these exact results:

```ts
assert.deepStrictEqual(notificationRouteForMember({
  email: 'user06@test.local', name: '小芸', user: 'user06',
  runner: 'agy', model: 'Gemini 3.5 Flash (High)', profile: 'frontend',
  notificationRoute: { runner: 'codex', model: 'gpt-5.4-mini' },
}), { runner: 'codex', model: 'gpt-5.4-mini' });
assert.deepStrictEqual(notificationRouteForMember({
  email: 'user02@test.local', name: '小美', user: 'user02',
  runner: 'codex', model: 'gpt-5.4-mini', profile: 'general',
}), { runner: 'codex', model: 'gpt-5.4-mini' });
```

- [ ] **Step 2: Verify RED.**

Run: `npx tsx sim/run.test.ts`.

Expected: failure because `notificationRouteForMember` is not exported.

### Task 2: Implement the containment route

**Files:**
- Modify: `sim/run.ts:42-80, 400-450, 1034-1056, 1981-1996, 2162-2171`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Add optional notification route fields.**

Add `notificationRoute?: ModelRoute` to `Member` and `MemberRunnerConfig`. Set only user06 to `notificationRoute: { runner: 'codex', model: 'gpt-5.4-mini' }`, and return that field from `loadMembersFromUsers()`.

- [ ] **Step 2: Implement the selector.**

```ts
export function notificationRouteForMember(member: Pick<Member, 'runner' | 'model' | 'notificationRoute'>): ModelRoute {
  return member.notificationRoute ?? { runner: member.runner, model: member.model };
}
```

- [ ] **Step 3: Separate actor notification and normal routes.**

Add `notificationRoute?: ModelRoute` to `runActorSessionWithNotificationGate` input. Its preflight callback uses `input.notificationRoute ?? { runner: input.runner, model: input.model }`; retain `input.normal` unchanged.

- [ ] **Step 4: Route both team-sweep preflight paths through the selector.**

In the initial all-member notification sweep call `runSession` with `notificationRouteForMember(member)`. At the normal member wrapper call pass `notificationRoute: notificationRouteForMember(m)`. No normal user06 task invocation may change from AGY.

- [ ] **Step 5: Verify GREEN and commit.**

Run: `npx tsx sim/run.test.ts`.

Expected: PASS.

Commit: `git add sim/run.ts sim/run.test.ts && git commit -m "fix: route user06 notifications through codex"`.

### Task 3: Probe the AGY adapter and record the root-cause decision

**Files:**
- Modify: `docs/operations.md:134-139`

- [ ] **Step 1: Run the bounded, non-mutating capability probe.**

Run: `agy --print --model 'Gemini 3.5 Flash (High)' --mode accept-edits --dangerously-skip-permissions 'Use curl to GET http://localhost:3000/api/health. Output the HTTP status and JSON body only. Do not modify any file or call a POST, PATCH, PUT, or DELETE endpoint.'`

Expected success: output contains HTTP `200` and `{\"status\":\"ok\",\"db\":true}`. A model-identification-only response is failure.

- [ ] **Step 2: Record the capability result without widening AGY permissions.**

Do not add `--dangerously-skip-permissions` to the shared AGY invocation: that would broaden every user06 normal task session, beyond the notification-recovery scope. In `docs/operations.md`, record the observed probe result and keep this operating rule:

```md
`user06` normal work remains on AGY, but her notification preflight is routed to Codex until AGY can execute the required curl side effect without widening the shared runner permissions; the notification gate never marks an item read without its verified comment.
```

Run: `npx tsx sim/run.test.ts`.

Expected: PASS.

- [ ] **Step 3: Commit the documented root-cause outcome.**

Commit: `git add docs/operations.md && git commit -m "docs: record user06 AGY notification containment"`.

### Task 4: Verify without a live sweep

**Files:** no production-file changes.

- [ ] **Step 1: Run static and focused checks.**

Run: `npx tsc --noEmit && npx tsc -p sim/tsconfig.json && npx tsx sim/run.test.ts && git diff --check`.

Expected: all commands exit 0.

- [ ] **Step 2: Preserve the live verification boundary.**

Do not run `npm run sim -- --sweep team`. Only with a new explicit authorization, verify all four current user06 notifications receive `read_at`, then confirm a later tick schedules her normal assigned task.
