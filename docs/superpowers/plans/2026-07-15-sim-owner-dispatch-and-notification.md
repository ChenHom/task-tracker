# SIM Owner 派工與逐筆通知處理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 SIM 以 Owner 專長派工、scheduler 嚴格執行已指派任務，並把每筆通知獨立 bounded、獨立驗證與獨立標記已讀。

**Architecture:** 保留現有 `sim/run.ts` 的 driver/API 邊界，新增可匯出的純函式供離線測試；通知 gate 改成逐 notification 的順序處理，scheduler 改成以 active assignee member 為選擇單位。`src/task.ts` 在 command 層查既有 workspace member read model，補上 assignee membership 與 Todo→Doing invariant，不新增 schema。

**Tech Stack:** TypeScript、Node `node:sqlite`、既有 HTTP API、Node assert tests、npm scripts。

---

### Task 1: Domain assignee 與 Doing 守門

**Files:**
- Modify: `src/task.ts:53-58,146-186,211-237,278-282`
- Modify: `src/task.test.ts`（補 active member fixture 與 domain cases）

- [ ] **Step 1: Write the failing tests**

在 `src/task.test.ts` 的 workspace/user fixture 補上 `u1`、`bob`、`carol`、`invite-assignee`、`pending-assignee` 使用者與相應 active Member read-model rows；新增下列 assert：非 active member assignee 的 create/PATCH 拒絕、無 assignee 的正常 workspace Todo→Doing 拒絕、active assignee 可進 Doing、move 後 pending invite 仍不可進 Doing、join 後可以進 Doing。既有正常 flow 在進入 Doing 前先明確指派 active member。

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx src/task.test.ts`

Expected: FAIL because `validateAssignee` 只檢查字串，且 `changeTaskStatus` 尚未檢查 assignee。

- [ ] **Step 3: Implement the minimal domain guards**

在 `src/task.ts` 新增 `requireActiveAssignee(workspaceId, assigneeId, database)`，使用 `getMemberRole(...)` 判斷 active membership；`createTask` 與 `changeTaskAssignee` 對非 null assignee 呼叫它。`changeTaskStatus` 在非主工作區、target 為 `Doing` 時讀取 task，要求非 null assignee 且 `getMemberRole` 不為 null；主工作區既有 Todo→Done 流程維持原樣。move 的既有 invite/join 行為不改。

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx src/task.test.ts`

Expected: PASS，包含新增 membership/Doing cases。

- [ ] **Step 5: Commit**

```bash
git add src/task.ts src/task.test.ts
git commit -m "feat: enforce task assignee membership"
```

### Task 2: Notification 每筆獨立 bounded preflight

**Files:**
- Modify: `sim/run.ts:397-620,1015-1041`
- Modify: `sim/run.test.ts`（新增 per-notification、bounded、failure isolation cases）

- [ ] **Step 1: Write the failing tests**

新增離線 fake request 與 runner assertions：同 task 三筆通知必須得到三次 `runPreflight`、三份不同 notification id 的 prompt、每份不超過 16,000 個 JavaScript 字元；A 成功、B 失敗、C 成功時 C 仍被呼叫且只有 B 未讀；主 workspace 每筆都必須以「處理前 comment id 集合」驗證自己的新 actor comment，前一筆留言不能讓下一筆通過；source comment 完整保留、context 依優先序裁減並帶省略標記。

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because current gate builds one prompt from `sources` and one runner call, and main validation is task-level。

- [ ] **Step 3: Implement the minimal notification flow**

在 `sim/run.ts`：

1. 將 `ResolvedNotification` 與 `MAX_NOTIFICATION_PROMPT_CHARS = 16_000` 匯出，新增 bounded context builder，保留完整 source comment，description 最多 2,000 字，加入最新 6 則與 source 前後各 2 則去重留言；超過上限附明確省略文字，固定規則加 source 仍超限則丟出 fail-closed error。
2. 讓 `notificationGatePrompt` 接受單一 `ResolvedNotification`，只生成該 notification 的 metadata/source/context。
3. `processNotificationGate` 將 snapshot 按 `created_at`、notification id 排序，逐筆重新 GET task/comments；每筆保存自己的 pre-comment id set，獨立呼叫 runner，主 workspace 驗證 actor 新 comment 不在該 set、非空且無 self mention，成功後立即只標記該 notification read；單筆錯誤記錄後繼續下一筆。
4. 403/404 按既有 unavailable 規則逐筆 read；5xx、runner error/timeout、格式錯誤與主留言驗證失敗逐筆保留 unread。snapshot readback 只在所有 snapshot notification 已 read 時讓 actor 進一般工作。

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx sim/run.test.ts`

Expected: PASS，並保留既有通知 gate 測試。

- [ ] **Step 5: Commit**

```bash
git add sim/run.ts sim/run.test.ts
git commit -m "feat: process sim notifications independently"
```

### Task 3: Managed roster reconciliation

**Files:**
- Modify: `sim/run.ts:140-180,690-727,1772-1900`
- Modify: `sim/run.test.ts`（新增 canonical scope/idempotency/role cases）

- [ ] **Step 1: Write the failing tests**

以 fake member API 驗證：canonical 缺 user06 會 invite/join、Viewer/Commenter 升為 Member、Member/Admin/Owner 不降級、重跑不重複 active membership 事件；main workspace 與歷史 workspace 不被同步；同步局部失敗時 missing user 不進 eligible roster，其他 active Member 仍可使用。

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because current sweep never reconciles canonical members and treats every listed runner as eligible。

- [ ] **Step 3: Implement the minimal roster flow**

新增 `reconcileManagedRoster` 與 `isEligibleRunner`：只接受 canonical workspace id 或 bootstrap 明確傳入的 newly-created workspace；讀 active members、補缺少/removed 的 invite+join、修正 Viewer/Commenter role，保留 Member/Admin/Owner。bootstrap 建立新 sprint workspace 後直接執行；sweep 只在 canonical candidate 進 Owner 派工前執行。把 `Member.role` 存入 runtime，eligible 必須是 `MEMBER_RUNNERS`、有完整 runner 設定、active user id 且 role 至少 Member；主 workspace Commenter 與 pending invite 一律排除。

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx sim/run.test.ts`

Expected: PASS，並確認 canonical/main/history scope。

- [ ] **Step 5: Commit**

```bash
git add sim/run.ts sim/run.test.ts
git commit -m "feat: reconcile managed sim roster"
```

### Task 4: Owner 派工與嚴格 scheduler

**Files:**
- Modify: `sim/run.ts:317-340,1043-1140,1481-1486,1632-1656,1710-1770,1937-1981`
- Modify: `sim/run.test.ts`（新增 prompt、strict assignment、ordering、budget 3 cases）

- [ ] **Step 1: Write the failing tests**

新增純函式測試：Owner prompt 包含 eligible profile/workload 且不含認領制；member prompt 只允許自己的 Todo/Doing，不含 PATCH assignee/claim；無 assignee Todo 會選出 0 member；Doing 優先、同狀態依最舊 `updated_at`、email tie-break；最多選 3 位、同 member 多題只占一個 session；notification-blocked 不占 budget；invalid assignee 與 owner unavailable 不自動改派；`sweepBudgets(...).member` 為 3。

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx sim/run.test.ts`

Expected: FAIL because prompts仍要求認領，`workspaceFitsSweepBudget` 接受 unassigned Todo，scheduler 固定 roster order 且 budget 為 2。

- [ ] **Step 3: Implement the minimal strict dispatch**

更新 Owner 開場、Owner sweep 與 member prompt：Owner 建 task 或 PATCH assignee，留下 `【OWNER派工】` 與負載/專長理由；member 只查自己名下工作，不得認領或改 assignee。把 `membersToRun`、`workspaceFitsSweepBudget` 與 sweep candidate 改成 assigned-only；新增 `selectAssignedMembers` 依 Doing→Todo、最舊 `updated_at`、email 排序，通知 blocked member 先排除再補足最多 3 位。將 `memberBudget` 固定為 3；owner runner 不可用不影響已指派 team work。`--smoke` 先跑 Owner，檢查至少兩筆合法 assignee task 後才跑最多兩位不同 member。

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx sim/run.test.ts`

Expected: PASS，且不再出現固定順序/認領制的測試匹配。

- [ ] **Step 5: Commit**

```bash
git add sim/run.ts sim/run.test.ts
git commit -m "feat: dispatch sim work by owner assignment"
```

### Task 5: 文件、整合驗證與受控交付

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/owner-sweep-guide.md`
- Modify: `docs/tasks/current.md`

- [ ] **Step 1: Update operational docs**

同步寫入逐筆通知、managed roster scope、Owner 派工、strict unassigned Todo、scheduler `memberBudget=3` 與 live sweep 需人工授權的操作說明；保留舊 spec 作歷史，不修改已提交設計 spec。

- [ ] **Step 2: Run full verification**

Run:

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json
npx tsx src/task.test.ts
npx tsx sim/run.test.ts
npm test
npm run build
git diff --check
```

Expected: all commands exit 0；不得執行 `npm run sim`、`--sweep` 或任何 live AI runner。

- [ ] **Step 3: Commit documentation and verification-ready implementation**

```bash
git add docs/operations.md docs/owner-sweep-guide.md docs/tasks/current.md
git commit -m "docs: record strict sim dispatch operations"
```

- [ ] **Step 4: Report live validation boundary**

回報測試結果、commit 清單與尚未執行的 controlled live validation；live 驗收待使用者另行授權。
