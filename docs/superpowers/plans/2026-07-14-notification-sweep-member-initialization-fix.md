# Notification Sweep Member Initialization Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 `team`／`both` sweep 將尚未初始化的 `RUN.members` 傳入通知巡檢，確保每輪實際巡檢 user02–user06。

**Architecture:** 保留既有 `RUN` scenario context 與 workspace 派工流程，只將全員通知巡檢的輸入改成 `sweep()` 開頭由 `loadMembersFromUsers()` 取得的區域變數 `members`。測試鎖定實際 wiring，明確禁止通知巡檢再次使用初始為空的 `RUN.members`；不新增 helper、狀態或重構。

**Tech Stack:** TypeScript、Node.js、既有 `sim/run.ts` harness、`node --import tsx`／`npx tsx` 測試。

---

## 檔案與責任

- Modify: `sim/run.ts:1798-1800`
  - 將通知巡檢輸入從尚未初始化的 `RUN.members` 改為已載入的 `members`。
- Modify: `sim/run.test.ts:137-140`
  - 先建立會失敗的 wiring 回歸測試。
  - 保留既有五位成員順序執行、單人失敗隔離、零未讀不啟動 AI 等行為測試。
- Create: `docs/superpowers/plans/2026-07-14-notification-sweep-member-initialization-fix.md`
  - 記錄根因、最小修正、驗證與 live 驗收邊界。

### Task 1: 用回歸測試鎖定正確成員來源

**Files:**
- Modify: `sim/run.test.ts:137-140`
- Test: `sim/run.test.ts`

- [ ] **Step 1: 將既有 source assertion 改成正確 wiring**

把目前要求 `runNotificationSweep(RUN.members, ...)` 的 assertion 替換為以下兩條：

```ts
assert.ok(
  /runNotificationSweep\(\s*members/.test(source),
  '通知巡檢必須使用 sweep 開頭已載入的 members',
);
assert.ok(
  !/runNotificationSweep\(\s*RUN\.members/.test(source),
  '通知巡檢不得使用尚未 activate scenario 的 RUN.members',
);
```

既有 `runNotificationSweep()` 行為測試保持不變，繼續驗證 user02–user06 五人都會被呼叫，以及 user03 失敗不阻斷其餘四人。

- [ ] **Step 2: 執行 focused 測試並確認先失敗**

Run:

```bash
npx tsx sim/run.test.ts
```

Expected: FAIL，訊息包含「通知巡檢必須使用 sweep 開頭已載入的 members」或「通知巡檢不得使用尚未 activate scenario 的 RUN.members」。

### Task 2: 套用一行最小修正

**Files:**
- Modify: `sim/run.ts:1798-1800`
- Test: `sim/run.test.ts`

- [ ] **Step 1: 改用區域變數 `members`**

將：

```ts
const results = await runNotificationSweep(
  RUN.members,
```

改為：

```ts
const results = await runNotificationSweep(
  members,
```

不要提前呼叫 `activateMainSweepContext()`，不要移動通知巡檢區塊，也不要修改 `RUN` 初始值；後續每個 workspace 仍照現行流程切換 scenario context。

- [ ] **Step 2: 執行 focused 測試確認通過**

Run:

```bash
npx tsx sim/run.test.ts
```

Expected: `sim/run.test.ts OK`。

- [ ] **Step 3: 檢查 diff 只包含預期修正**

Run:

```bash
git diff -- sim/run.ts sim/run.test.ts
```

Expected: `sim/run.ts` 只有 `RUN.members` → `members` 的一行修正；`sim/run.test.ts` 只有 wiring assertion 更新。

### Task 3: 完整自動驗證

**Files:**
- Test: `sim/run.test.ts`
- Test: existing repository test suite

- [ ] **Step 1: 執行兩組 TypeScript 檢查**

Run:

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json --noEmit
```

Expected: 兩個 command 都 exit 0，無 TypeScript error。

- [ ] **Step 2: 執行完整測試**

Run:

```bash
npm test
```

Expected: 所有 `src/*.test.ts` 與 `sim/run.test.ts` PASS。

- [ ] **Step 3: 執行 build 與 whitespace 檢查**

Run:

```bash
npm run build
git diff --check
```

Expected: build exit 0，`git diff --check` 無輸出。

### Task 4: Live 驗收（僅在取得新的明確人工授權後）

**Files:**
- Read: `sim-logs/`
- Read: `data/dev.db`

- [ ] **Step 1: 執行 live 前置健康檢查**

Run:

```bash
systemctl --user is-active task-tracker.service
curl -sS http://127.0.0.1:3000/api/health
test ! -e sim-logs/.run.lock
```

Expected: service 為 `active`、health 為 `{"status":"ok","db":true}`、沒有 live sweep lock。

- [ ] **Step 2: 取得人工授權後只執行一次 team sweep**

Run:

```bash
npm run sim -- --sweep team
```

Expected: 輸出依序包含以下十個 driver 紀錄，每位成員各一個開始與結束：

```text
[notification-sweep:user02] 開始
[notification-sweep:user02] 結束
[notification-sweep:user03] 開始
[notification-sweep:user03] 結束
[notification-sweep:user04] 開始
[notification-sweep:user04] 結束
[notification-sweep:user05] 開始
[notification-sweep:user05] 結束
[notification-sweep:user06] 開始
[notification-sweep:user06] 結束
```

零未讀成員只能出現 driver 開始／結束，不應出現 `<user>-notification-sweep` 的模型開始紀錄；有未讀成員才啟動 dedicated notification session。

- [ ] **Step 3: 驗證成功與失敗語意**

使用 Node.js `node:sqlite` 唯讀查詢 user02–user06 的 `notifications_read_model`：

```sql
SELECT u.email, COUNT(n.notification_id) AS unread
  FROM users u
  LEFT JOIN notifications_read_model n
    ON n.recipient_id = u.id
   AND n.read_at IS NULL
 WHERE u.email IN (?, ?, ?, ?, ?)
 GROUP BY u.id, u.email
 ORDER BY u.email;
```

Expected: 巡檢完成者未讀數降為 0；若某成員登入、API、模型或主工作區留言驗證失敗，log 必須顯示「未完成」，該成員未讀數保持不變，其他成員仍完成。

### Task 5: 提交最小修正

**Files:**
- Modify: `sim/run.ts`
- Modify: `sim/run.test.ts`
- Create: `docs/superpowers/plans/2026-07-14-notification-sweep-member-initialization-fix.md`

- [ ] **Step 1: 確認不包含既有無關修改**

Run:

```bash
git status --short
```

Expected: 本題檔案只有 `sim/run.ts`、`sim/run.test.ts` 與本 plan；既有 `public/css/task-detail.css`、`src/frontend.test.ts` 不加入 staging。

- [ ] **Step 2: 提交修正**

```bash
git add sim/run.ts sim/run.test.ts docs/superpowers/plans/2026-07-14-notification-sweep-member-initialization-fix.md
git commit -m "fix: initialize notification sweep members"
```

## 自我檢查

- 根因覆蓋：通知巡檢不再讀取初始為空的 `RUN.members`。
- 範圍控制：一行 production 修正，不新增 helper、不移動流程、不改 scenario context。
- 測試覆蓋：wiring assertion 會在誤用 `RUN.members` 時失敗；既有行為測試繼續驗證五人執行與失敗隔離。
- 操作邊界：自動測試不呼叫真實 AI；live sweep 必須取得新的人工授權。
