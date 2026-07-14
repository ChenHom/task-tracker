# 全成員通知巡檢 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `--sweep team` 與 `--sweep both` 每一輪都檢查 user02–user06 的未讀通知，不因成員目前沒有 Todo/Doing 任務而跳過通知處理。

**Architecture:** 在既有 workspace 任務派工前增加獨立的全成員通知巡檢。每位設定中的成員各登入一次並 snapshot 自己的未讀通知；沒有未讀時只留下零未讀紀錄，不啟動 AI；有未讀時沿用既有 `processNotificationGate`，主工作區仍要求合格的新留言後才標已讀。通知巡檢不建立 worktree、不占用 `memberBudget`、不 commit；一般任務 session 仍維持現有 claim-based 派工與 notification gate，失敗的成員本輪跳過一般工作。

**Tech Stack:** TypeScript、Node `fetch`、SQLite `node:sqlite`、既有 `sim/run.ts` runner、`npx tsx` 測試。

---

## 檔案與責任

- Modify: `sim/run.ts`
  - 新增全成員通知巡檢的結果型別與 orchestration。
  - 重用 `processNotificationGate` 的登入、來源讀取、主工作區留言驗證、標已讀規則。
  - 在 team/both sweep 的 workspace 任務派工前執行一次 user02–06 通知巡檢。
  - 將失敗成員的結果傳給一般 member session，避免同一輪繞過通知守門。
- Modify: `sim/run.test.ts`
  - 驗證五位成員都被巡檢，即使沒有指派任務。
  - 驗證零未讀不啟動 AI、未讀會啟動 preflight、主工作區不合格留言仍保留未讀。
  - 驗證 notification sweep 不改變既有 member budget 與 claim-based `toRun`。
- Modify: `docs/operations.md`
  - 說明通知巡檢的觸發角色、成員範圍、零未讀行為、失敗行為與 log 標記。
- Modify: `docs/tasks/current.md`
  - 新增 Phase 19 checklist 與驗收證據欄位，保留 Phase 18 既有內容。

### Task 1: 先寫通知巡檢的可測試介面

**Files:**
- Modify: `sim/run.ts`（靠近 `NotificationGateResult`、`runActorSessionWithNotificationGate`）
- Test: `sim/run.test.ts`

- [ ] **Step 1: 定義巡檢結果與純函式介面**

新增下列型別與介面，讓 orchestration 可注入登入、通知 API 與 runner，測試不需真的呼叫 AI：

```ts
export interface NotificationSweepResult {
  actor: string;
  ready: boolean;
  unreadCount: number;
  preflightStarted: boolean;
}

export type NotificationSweepMember = Pick<Member, 'email' | 'name' | 'user' | 'runner' | 'model' | 'fallback'>;
export type NotificationSweepRunner = (member: NotificationSweepMember) => Promise<NotificationSweepResult>;
```

新增 `runNotificationSweep(members, runOne, log)`：逐一處理傳入的五位成員，任何單一成員例外轉成 `ready: false` 並繼續其他成員；回傳依 `members` 順序排列的結果。這個函式不得呼叫 `ensureWorktree`、`commitMemberWork` 或扣減 `memberBudget`。

- [ ] **Step 2: 寫第一組失敗測試**

在 `sim/run.test.ts` 加入：

```ts
const sweepMembers = ['user02', 'user03', 'user04', 'user05', 'user06'];
const seen: string[] = [];
const results = await runNotificationSweep(
  sweepMembers.map((user) => ({
    email: `${user}@test.local`, name: user, user,
    runner: 'codex' as const, model: 'test-model', profile: 'test',
  })),
  async (member) => {
    seen.push(member.email);
    return { actor: member.email, ready: true, unreadCount: 0, preflightStarted: false };
  },
  () => {},
);
assert.deepStrictEqual(seen, sweepMembers.map((user) => `${user}@test.local`));
assert.strictEqual(results.length, 5);
```

測試例外隔離：user03 的 `runOne` throw 時，user02、04、05、06 仍會被呼叫，且 user03 結果 `ready === false`。

- [ ] **Step 3: 執行測試確認目前失敗**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL，直到 `runNotificationSweep` 與結果型別完成。

- [ ] **Step 4: 實作最小 orchestration**

以 `for...of` 順序執行 `runOne`，避免五個模型同時啟動造成額度與 log 競爭；每次呼叫前後寫入 `[notification-sweep:<user>]` 的開始／結束紀錄。`runOne` 的錯誤只影響該成員，不得 reject 整個 sweep。

- [ ] **Step 5: 執行測試確認通過**

Run: `npx tsx sim/run.test.ts`

Expected: PASS，且現有 notification gate 測試不變。

### Task 2: 將既有 notification gate 重用為全成員巡檢

**Files:**
- Modify: `sim/run.ts`（`processNotificationGate` 附近）
- Test: `sim/run.test.ts`

- [ ] **Step 1: 抽出單一成員通知巡檢 runner**

將 `NotificationGateResult` 擴充為含 `preflightStarted`，並新增 `runNotificationSweepForMember(member, runDir, promptArtifacts)`；行為固定如下：

1. `login(member.email)`。
2. 呼叫 `GET /api/notifications` 並只取登入時 `read_at === null` 的 rows。
3. 零筆時回 `{ ready: true, snapshotIds: [], preflightStarted: false }`，不得啟動 AI。
4. 有未讀時呼叫既有 `processNotificationGate`；其 `runPreflight` 使用成員自己的 runner/model 與 `promptLabel: `${member.user}-notification-sweep``。
5. 以 `snapshotIds.length` 作為未讀數，回傳 `ready`、未讀數與是否啟動 preflight；失敗時不標未讀為已讀。

巡檢 prompt 必須保留既有規則：不得呼叫 `POST /api/notifications/:id/read`、不得 @自己；主工作區沒有補充時使用 `已閱讀，目前無補充。`。

- [ ] **Step 2: 加入行為測試**

使用現有 `fakeGateRequest` 測試工具新增三案：

```ts
// 零未讀：不啟動 preflight
assert.deepStrictEqual(await runNotificationSweepForMember(fakeMember, options), {
  actor: 'user02@test.local', ready: true, unreadCount: 0, preflightStarted: false,
});

// 一般 workspace 有未讀：啟動一次 preflight，成功後標已讀
assert.strictEqual(generalSweepResult.preflightStarted, true);
assert.strictEqual(generalSweepResult.ready, true);

// 主 workspace 缺少合格新留言：ready=false，read endpoint 不得被呼叫
assert.strictEqual(mainSweepResult.ready, false);
assert.ok(!mainCalls.some((call) => call.includes('/read')));
```

- [ ] **Step 3: 執行 focused 測試確認失敗**

Run: `npx tsx sim/run.test.ts`

Expected: 新增測試 FAIL，既有 gate 測試 PASS。

- [ ] **Step 4: 完成單一成員 runner 並通過測試**

只使用既有 `login`、`api`、`processNotificationGate`、`runSession`；不可新增 notification API 或讀寫資料庫旁路。`user09` 不加入本功能，因目前沒有 `MEMBER_RUNNERS` 設定；user01 仍由 owner session 的既有 gate 處理。

- [ ] **Step 5: 執行 focused 測試**

Run: `npx tsx sim/run.test.ts`

Expected: PASS。

### Task 3: 接入 team/both sweep 並保留一般派工規則

**Files:**
- Modify: `sim/run.ts`（`sweep()`）
- Test: `sim/run.test.ts`

- [ ] **Step 1: 寫 sweep wiring 測試**

加入 source-level 或注入式測試，固定驗證：

```ts
assert.ok(source.includes("role !== 'owner'"));
assert.ok(source.includes('runNotificationSweep'));
assert.ok(source.includes('memberBudget -= toRun.length'));
assert.ok(source.includes('notification sweep 不占用 member budget'));
```

另驗證 `sweepBudgets('both', 0, false)` 仍為 `{ owner: 0, member: 2 }`，以及沒有未指派 Todo 時 `toRun` 仍不會把 idle 成員加入一般工作 session。

- [ ] **Step 2: 在 sweep 開始建立全成員通知結果**

在 `sweep()` 取得 `RUN.members` 後、workspace `pendings` 任務派工前加入（先建立本 tick 共用的 `runDir` 與 `promptArtifacts`）：

```ts
const notificationResults = role === 'owner'
  ? new Map<string, NotificationSweepResult>()
  : new Map((await runNotificationSweep(RUN.members, (member) =>
      runNotificationSweepForMember(member, runDir, promptArtifacts),
    (line) => console.log(line))).map((result) => [result.actor, result]));
```

`runDir`／`promptArtifacts` 建立在 `if (!pendings.length) return` 之前，讓通知巡檢與後續 workspace session 共用 artifacts；若本 tick 沒有 `pendings`，仍要先完成通知巡檢，不能直接零成本結束。

- [ ] **Step 3: 將通知結果套回一般 member session**

一般 member session 維持現有 `runActorSessionWithNotificationGate` 作最後一次 readback，但若 `notificationResults.get(m.email)?.ready === false`，直接記錄
`[<name>-巡檢] notification sweep 未完成，略過一般 session`，不得啟動正常工作 session。這保留現有「通知失敗不做一般工作」安全邊界；成功或零未讀才進入原本的 `toRun`。

- [ ] **Step 4: 執行 sim focused 測試**

Run: `npx tsx sim/run.test.ts`

Expected: PASS；既有 `sweepBudgets`、claim-based dispatch、主工作區 gate 與 self-mention 測試全部維持綠燈。

### Task 4: 補齊操作文件與目前狀態

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/tasks/current.md`

- [ ] **Step 1: 更新操作契約**

在 `docs/operations.md` 的 `Notification preflight` 後新增明確規則：

- `--sweep team` 與 `--sweep both` 每 tick 依序巡檢 user02–06。
- 零未讀只記錄結果，不啟動 AI；有未讀才啟動 dedicated notification session。
- 通知巡檢不占用 member task budget、不建立 worktree、不 commit。
- 失敗成員的未讀保留，且該成員本輪一般工作跳過；其他成員繼續。
- `--sweep owner` 不啟動 user02–06 通知巡檢；user01 仍走 owner session gate；user09 仍不在 sim runner 範圍。

- [ ] **Step 2: 更新目前任務狀態**

在 `docs/tasks/current.md` Phase 19 新增未完成 checklist：

```markdown
## Phase 19 — 全成員通知巡檢

- [ ] team/both sweep 每 tick 檢查 user02–06 未讀通知
- [ ] 零未讀不啟動 AI；有未讀沿用主工作區留言驗證與標已讀規則
- [ ] 通知巡檢不占用一般 member budget，失敗成員本輪跳過一般工作
- [ ] 單元測試、完整測試、build 與 live readback
```

### Task 5: 驗證與交付

**Files:**
- Test: `sim/run.test.ts`, existing `npm test` suite

- [ ] **Step 1: 執行型別與 focused 測試**

Run: `npx tsc --noEmit && npx tsx sim/run.test.ts`

Expected: both commands exit 0。

- [ ] **Step 2: 執行完整測試與 build**

Run: `npm test && npm run build && git diff --check`

Expected: all tests PASS、build 成功、`git diff --check` 無輸出。

- [ ] **Step 3: 做一次非 AI 的 dispatch readback**

用測試 fake request 確認五位成員皆被呼叫；不要在未取得新的人工授權前執行 `npm run sim -- --sweep`。若之後獲得 live 授權，再從 log 確認出現 user02、03、04、05、06 各一筆 `notification-sweep` 結束紀錄，並以 SQLite/API 讀回未讀數與主工作區留言結果。

- [ ] **Step 4: 提交變更**

```bash
git add sim/run.ts sim/run.test.ts docs/operations.md docs/tasks/current.md docs/superpowers/plans/2026-07-14-notification-sweep.md
git commit -m "feat: sweep notifications for all configured members"
```

提交前不得加入現有無關修改：`public/css/task-detail.css` 與 `src/frontend.test.ts`。

## 自我檢查

- 規格涵蓋：user02–06 全員巡檢、主工作區留言驗證、通知失敗保留未讀、一般派工不變、user09 不納入、team/both 觸發範圍、文件與驗證。
- 沒有新增 UI、資料表、通知 API 或 worktree；功能只擴充既有 sim 自動化流程。
- `memberBudget` 仍只控制一般 TASK session；通知巡檢的成本與結果獨立記錄。
