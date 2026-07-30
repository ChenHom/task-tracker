# 主工作區發想與四人共識 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓主工作區真的產出「來源在 repo 以外」的點子：owner 自己做外部查證並開題，成員在通知 session 裡用 `【同意】`／`【疑慮】` 表態，owner 清點四人共識後依既有討論協議收尾。

**Architecture:** 全部在 prompt 層加規則，`src/` 一行不動。四人門檻不做成 validator，由 owner 在收尾時自行清點——`176b576`（07-14）建立共識守門、`75e2033`（07-23）又拆掉，同一道閘門一個月內建了又拆；純 prompt 規則沒有 validator 對手就沒得漂移，最壞情況是被忽略，不會造成 400。成員的喚醒完全靠 notification sweep，所以本計畫的最後一步是恢復 07-29 停用的 gate，而恢復之前要先補上成員側 login 的可診斷性與韌性。

**Tech Stack:** TypeScript, Node `node:sqlite`, `tsx` focused tests, npm build/test scripts, systemd user timers.

---

## 為什麼是「owner 自己查」——原設計的三個前提實測是錯的

| 原前提 | 實際 |
|---|---|
| `[發想]` 前綴的 task 會被成員排程撿起來 | **假。** `src/task.ts:178` 對主工作區每一則非規則 task **強制前置 `[討論]`**，`[發想] X` 被存成 `[討論] [發想] X`；`isSweepWorkTask`（`sim/run.ts:383`）排除所有 `[討論]` 開頭 → 永遠不進 `work`／`work2` |
| owner 可以「建立 task 並指派一位成員」 | **假。** `src/task.ts:181-183` `useDefaults = isMainDiscussion \|\| isCommenter` → `assigneeId = null`。實測 12 則主工作區 task 的 `assignee_id` 全為 null |
| 每個 team tick 對全部成員跑 `runNotificationSweep` | **半假。** `sim/run.ts:2091` 是 `if (role !== 'owner' && notificationGateEnabled())`，而 `SIM_NOTIFICATION_GATE` 在 `/home/hom/.local/bin/sim-sweep-cron.sh` 裡沒有設（07-29 00:44 `15e2641` 停用）→ 通知巡檢一次都不會跑 |

前兩列封死成員的工作路線，第三列封死通知路線。查證因此改由 owner 承擔。

## 仍然成立的前提

- **owner sweep session 有網路。** 主工作區 owner sweep 走 `runSession` → `buildRunnerInvocation` **不帶 `sandbox`**，預設 `workspace-write` + `network_access=true`（`sim/run.ts:1128-1134`）。`MAIN_OWNER_TOOLS = 'Bash(curl:*)'`（`:945`）對 codex 無效——只有 claude 分支吃 `--allowedTools`。
- **成員的 `【同意】` 不會干擾收尾。** `resolveMainDiscussionConclusion` 只認 `user_id === ownerId` 的留言（`src/mainDiscussion.ts:132,138,165`），且不看標題前綴。
- **owner 有時間。** `SWEEP_OWNER_TIMEOUT` 20 分鐘，逾時 streak 可長到 30 分（`sim/run.ts:1895,2153`）。

## 驗收標準

1. **有 repo 以外的具體來源**（至少三個可追溯的出處）。
2. **四人共識**：同意池是 **user01、user02、user03、user04、user05、user09** 六位，其中 4 位同意。owner 走 `【結論】` 本身即代表 user01 同意（算 1 票），所以 owner 要在 **user02–05 與 user09 這 5 個票源裡數到 ≥3 位**。

user06 依決策跳過通知，不在池內。

## 刻意延後（不是遺漏）

- **無腦按讚**：不要求 `【同意】` 附理由，不加任何檢查。
- **來源灌水**：prompt 照樣要求 ≥3 條可追溯出處，但不驗證品質、不安排人工審。

兩者都等流程證明跑得通之後再處理。**後續 session 不要「順手補回來」。**

---

## File structure

- Modify `sim/run.ts:1253`（marker 常數 + `notificationGatePrompt` 主工作區規則）、`:2010-2032`（`ownerSweepPrompt` 主工作區分支）、`:172-173`（user02 route）、`:2092`（通知巡檢名單）、`:821-826`（`runNotificationSweepForMember` 的 login）。
- Modify `sim/run.test.ts:1220-1278` — 沿用檔尾既有的「prompt ↔ validator round-trip 守門」與 `describeError` 區塊風格，往後接新斷言。
- Modify `/home/hom/.local/bin/sim-sweep-cron.sh` — 最後一步才加 `export SIM_NOTIFICATION_GATE=1`。
- Modify `docs/operations.md:139` 附近的「Notification preflight（目前停用）」段落 — gate 恢復後改寫狀態。

**動工前先確認 timer 已停**（目前兩個都 inactive）：

```bash
systemctl --user stop sim-sweep-owner.timer sim-sweep-team.timer
pgrep -f '\.bin/tsx sim/run\.ts' || echo "無殘留 sim 行程"
```

理由見 memory `sim-timers-edit-live-src`：AI 車隊會在你讀寫之間改同一個檔。

---

### Task 1: 表態的兩個 marker 與通知 prompt 的第三條出路

現行主工作區規則只有「無補充的罐頭句」與「提出問題／風險」兩條出路，結構上產不出同意票。

**Files:**
- Modify: `sim/run.ts:1253`（`notificationGatePrompt` 之前加常數；`:1280` 的規則行）
- Test: `sim/run.test.ts`（接在 `describeError` 區塊之後）

- [ ] **Step 1: Write the failing focused tests**

  在 `sim/run.test.ts` 匯入 `AGREE_MARKER`、`CONCERN_MARKER`、`notificationGatePrompt`，並附加：

  ```ts
  // 表態三選一：少任何一條出路，成員就在結構上產不出同意票（原本只有兩條）。
  {
    const prompt = notificationGatePrompt({
      actor: { email: 'user03@test.local', name: 'x', user: 'user03' },
      jar: '/tmp/jar.txt',
      source: MAIN_WORKSPACE_NOTIFICATION_FIXTURE,
    });
    assert.ok(prompt.includes(AGREE_MARKER), `同意出路必須在 prompt 裡：${AGREE_MARKER}`);
    assert.ok(prompt.includes(CONCERN_MARKER), `疑慮出路必須在 prompt 裡：${CONCERN_MARKER}`);
    assert.ok(prompt.includes('已閱讀，目前無補充。'), '無補充的罐頭句不得被移除');
  }
  ```

  `MAIN_WORKSPACE_NOTIFICATION_FIXTURE` 用一則 `workspace_id === MAIN_WORKSPACE_ID` 的最小 `ResolvedNotification`；若檔內已有可重用的 fixture，優先重用而不要新建。

- [ ] **Step 2: Run the focused test and verify red**

  Run: `npx tsx sim/run.test.ts`

  Expected: FAIL —— `AGREE_MARKER` 尚未 export。

- [ ] **Step 3: 加常數並改規則行**

  在 `sim/run.ts` 的 `notificationGatePrompt`（`:1253`）之前加：

  ```ts
  // 表態 marker：notification prompt 是寫入端、owner prompt 是清點端，兩邊必須用同一個字串。
  // 不放進 src/mainWorkspacePolicy.ts —— 那裡是 validator 的詞彙表，這兩個 marker 沒有 validator，
  // 放過去只會製造 :7-9 註解在講的那種跨目錄耦合。日後真的替它們寫 validator 再搬。
  export const AGREE_MARKER = '【同意】';
  export const CONCERN_MARKER = '【疑慮】';
  ```

  把 `:1280` 那條主協作工作區規則改成三選一（`【同意】` **不要**求附理由，見「刻意延後」）：

  ```
  - 主協作工作區來源：這一筆通知必須 POST 一則新的留言，三選一：贊成就以「${AGREE_MARKER}」開頭；有具體風險或反對理由就以「${CONCERN_MARKER}」開頭並寫明風險；沒有補充時，內容必須完全是「已閱讀，目前無補充。」
  ```

  保留其餘三條規則不動（一般工作區來源、不得呼叫 read、不得 @ 自己）。

- [ ] **Step 4: Run the focused test and verify green**

  Run: `npx tsx sim/run.test.ts`

  Expected: exits 0，結尾 `sim/run.test.ts: OK`。

- [ ] **Step 5: Static checks and commit**

  Run: `npx tsc --noEmit && npx tsc -p sim/tsconfig.json --noEmit && npm test && git diff --check`

  Expected: 全部 exit 0，`git diff --check` 無輸出。

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "feat(sim): 通知表態加入同意/疑慮兩條出路"
  ```

  ⚠️ commit 到 master **即自動部署**（`sim-autodeploy.path`，memory `master-commit-autodeploys`）——不要手動 build/restart。

---

### Task 2: owner 主工作區 prompt——查證、開題、清點

**Files:**
- Modify: `sim/run.ts:2010-2032`（`ownerSweepPrompt` 的 `wsId === MAIN_WORKSPACE_ID` 分支）
- Test: `sim/run.test.ts`

- [ ] **Step 1: Write the failing focused tests**

  ```ts
  // owner 主工作區 prompt：查證、開題、清點三件事缺一件，發想流程就走不完整。
  {
    const prompt = ownerSweepPrompt(MAIN_WORKSPACE_ID, SCENARIO_FIXTURE, [], '老闆', 20);
    assert.ok(!prompt.includes('只用 curl/API'), 'owner 有 workspace-write + network，不得再自陳只能 curl');
    assert.ok(prompt.includes('不得編輯、提交或合併任何程式碼'), '真正的約束必須保留');
    assert.ok(/repo 以外/.test(prompt), '開題必須要求主題在 repo 以外');
    assert.ok(/來源/.test(prompt) && /三/.test(prompt), '必須要求 ≥3 條可追溯出處');
    assert.ok(prompt.includes(AGREE_MARKER), '清點端必須用與通知 prompt 相同的同意 marker');
    for (const voter of ['user02', 'user03', 'user04', 'user05', 'user09']) {
      assert.ok(prompt.includes(voter), `清點說明必須列出票源 ${voter}`);
    }
  }
  ```

- [ ] **Step 2: Run the focused test and verify red**

  Run: `npx tsx sim/run.test.ts` → FAIL。

- [ ] **Step 3: 改 prompt**

  在 `sim/run.ts:2011` 的開頭句，把「這個 session 只用 curl/API 操作，不得編輯、提交或合併任何程式碼」改成明說有網路、保留真正的約束，例如：

  ```
  你可以連外網查資料（這個 session 有網路），但不得編輯、提交或合併任何程式碼。
  ```

  **新增開題步驟**（放在現行步驟 1 之後）：`[討論]` 的 Todo 少於 3 則時，先連外網查證，再建立**一則**新討論；主題必須指向 repo 以外的具體領域（別人怎麼做、什麼在變、我們沒看到什麼），不得是自家看板的 UI 微調。標題**不要**自己加 `[討論]`——伺服器會自動加（`src/task.ts:178`）。

  **步驟 2（`【OWNER想法】`）補來源要求**：六欄之後另起一個「來源」區塊，列 ≥3 條可追溯出處，並要求「現況／問題」與「預期價值」呼應這些來源。

  > ⚠️ **六欄的值必須單行。** `lineValue`（`src/mainDiscussion.ts:17-20`）用 `^欄名：(.+?)$` 配 `m` flag，只取同一行。來源清單要放在六欄**之外**，不能當 `現況／問題` 的續行，否則欄位解析只拿到第一行。

  **步驟 6（收尾）補清點**：明寫同意池是 user01–user05 與 user09 六位、需 4 位；owner 自己算 1 票，所以要在 user02–05 與 user09 之中數到 ≥3 位 `${AGREE_MARKER}` 才可走 `${CONCLUSION_MARKER}`＋開實作 task；否則 `${NO_IMPLEMENTATION_MARKER}` 或 `${NO_CONSENSUS_MARKER}`。

  **不要動步驟 3**：它已經要求 @mention 全體 Commenter，擴散機制本來就在。

- [ ] **Step 4: Run the focused test and verify green**

  Run: `npx tsx sim/run.test.ts` → exits 0。

  另外確認檔尾既有的「prompt ↔ validator round-trip 守門」（`sim/run.test.ts:1220-1266`）仍綠——那道測試就是為了防止改 prompt 沒改 validator（07-23、07-29 各斷過一次）。

- [ ] **Step 5: Static checks and commit**

  Run: `npx tsc --noEmit && npx tsc -p sim/tsconfig.json --noEmit && npm test && git diff --check`

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "feat(sim): owner 主工作區 prompt 加入查證開題與四人清點"
  ```

---

### Task 3: user02 改走 claude sonnet-5

表態階段需要至少一個非 codex 的模型。user06 已跳過通知，所以由 user02 承擔 claude 這一票。

**Files:**
- Modify: `sim/run.ts:172-173`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Write the failing focused tests**

  ```ts
  // user02 是表態階段唯一的非 codex 票源；route 掉回 codex 就失去跨模型意義。
  assert.deepStrictEqual(
    notificationRouteForMember(user02),
    { runner: 'claude', model: 'claude-sonnet-5' },
    'user02 表態必須由 claude 產生',
  );
  assert.deepStrictEqual(
    workSessionForMember(user02).route,
    { runner: 'claude', model: 'claude-sonnet-5' },
    'user02 一般工作也改走 claude',
  );
  assert.ok(workSessionForMember(user02).fallback, 'claude 額度滿了必須有退路，否則靜默失敗');
  ```

- [ ] **Step 2: Run the focused test and verify red**

  Run: `npx tsx sim/run.test.ts` → FAIL。

- [ ] **Step 3: 改 route**

  `sim/run.ts:172-173` 的 user02 改為：

  ```ts
  { email: 'user02@test.local', runner: 'claude', model: 'claude-sonnet-5',
    fallback: { runner: 'agy', model: 'Claude Sonnet 4.6 (Thinking)' },
    profile: '細心，擅長小範圍 auth/安全類修補與補測試，適合範圍明確的小題' },
  ```

  兩個連帶影響要知道：
  - claude 分支**會強制執行 `--allowedTools`**，所以 user02 的工作 session 從「實際不設限」（codex 忽略 `tools`）變成「真的只有 `MEMBER_TOOLS` 白名單」（`:943`）。user06 的 workRoute 本來就是 `claude-sonnet-5` 且吃同一份白名單，有前例，**先不擴白名單**。
  - `fallback` 是必要的：claude 額度現在同時被 user02（工作＋通知）與 user06（工作）吃，`isQuotaExhaustion`（`:1145`）偵測得到但 `shouldFallbackToModel`（`:1149`）需要有 fallback 才會退。

- [ ] **Step 4: Run the focused test and verify green**

  Run: `npx tsx sim/run.test.ts` → exits 0。

- [ ] **Step 5: Static checks and commit**

  Run: `npx tsc --noEmit && npx tsc -p sim/tsconfig.json --noEmit && npm test && git diff --check`

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "feat(sim): user02 改走 claude sonnet-5 並補 agy fallback"
  ```

---

### Task 4: 通知巡檢跳過 user06

**Files:**
- Modify: `sim/run.ts:2092`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Write the failing focused test**

  `runNotificationSweep`（`:848`）本身沒有跳過機制，過濾要發生在呼叫端。用 source 契約守門（沿用檔內既有的 `source.includes(...)` 風格）：

  ```ts
  assert.ok(
    /NOTIFICATION_SWEEP_SKIP/.test(source),
    '通知巡檢的跳過名單必須是具名常數，否則下一個人看不出 user06 為什麼不見了',
  );
  assert.deepStrictEqual(
    notificationSweepMembers(ALL_MEMBERS_FIXTURE).map((m) => m.user),
    ['user02', 'user03', 'user04', 'user05'],
    '通知巡檢名單必須排除 user06、保留 user02-05',
  );
  ```

- [ ] **Step 2: Run the focused test and verify red**

  Run: `npx tsx sim/run.test.ts` → FAIL。

- [ ] **Step 3: 加具名常數與過濾函式**

  ```ts
  // user06 依 2026-07-30 決策不參與表態（它的 notificationRoute 本來也被導到 codex，
  // 留著只是讓循序的通知巡檢多跑一位）。它仍會被 owner @mention，未讀會累積，無害。
  const NOTIFICATION_SWEEP_SKIP = new Set(['user06']);

  export function notificationSweepMembers<T extends { user: string }>(members: readonly T[]): T[] {
    return members.filter((m) => !NOTIFICATION_SWEEP_SKIP.has(m.user));
  }
  ```

  `:2092` 的 `runNotificationSweep(members, ...)` 改成 `runNotificationSweep(notificationSweepMembers(members), ...)`。

  順帶收益：那個 `for` 迴圈是**循序**的，每位上限 `SWEEP_MEMBER_TIMEOUT` 20 分鐘（`:1896`），5 位最壞 100 分鐘而 team timer 每 15 分鐘觸發（靠 wrapper 的 pgrep 互斥擋重疊）。降到 4 位。

- [ ] **Step 4: Run the focused test and verify green**

  Run: `npx tsx sim/run.test.ts` → exits 0。

- [ ] **Step 5: Static checks and commit**

  Run: `npx tsc --noEmit && npx tsc -p sim/tsconfig.json --noEmit && npm test && git diff --check`

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "feat(sim): 通知巡檢跳過 user06"
  ```

---

### Task 5: 成員通知 login 的可診斷性與韌性（開 gate 前的前置）

`runNotificationSweepForMember` 的 `input.loginActor(...)`（`sim/run.ts:823`）**就是表態路線的 login**，而 `:824` 的失敗訊息是 `String(error)`——與 `675e1bc` 剛修掉的 owner 版是同一個問題：fetch 失敗只會印出 `TypeError: fetch failed`，errno 藏在 `cause` 裡。

**不能比照 `cd92ec7` 複用 cookie。** owner 能複用是因為 `:2173` 早就登入過；成員的通知巡檢跑在 tick 最前面（`:2091`），前面沒有任何 cookie 可用。而且它**不在重負載之後**（team tick 依 `:2220` 註解不跑 `verifyBranches`）——這大概就是為什麼 540 次失敗全在 owner、member 從未觀察到。所以成員側的正解是重試＋留下 errno，不是複用。

**Files:**
- Modify: `sim/run.ts:821-826`
- Test: `sim/run.test.ts`

- [ ] **Step 1: Write the failing focused tests**

  `loginActor` 是注入的，可以直接數呼叫次數：

  ```ts
  // 連線層失敗要重試（前一次 gate 停用就是因為 login 一失敗整個 session 就被略過）；
  // 但 HTTP 失敗不能重試 —— 登入限流是 15 分鐘 / 10 次失敗的窗口（src/server.ts:62），硬打鎖更久。
  {
    let calls = 0;
    const result = await runNotificationSweepForMember({
      ...NOTIFICATION_MEMBER_FIXTURE,
      loginActor: async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); },
      log: (line) => { logged.push(line); },
    });
    assert.strictEqual(calls, 3, '連線層失敗必須重試 2 次（共 3 次呼叫）');
    assert.strictEqual(result.ready, false, '重試用盡仍要回報未完成');
    assert.ok(logged.some((l) => l.includes('ECONNREFUSED')), 'cause 的 errno 必須進 log，否則下次又是無從診斷');
  }
  {
    let calls = 0;
    await runNotificationSweepForMember({
      ...NOTIFICATION_MEMBER_FIXTURE,
      loginActor: async () => { calls++; throw new Error('login user03@test.local 失敗: 429'); },
      log: () => {},
    });
    assert.strictEqual(calls, 1, 'HTTP 失敗（含 429）不得重試');
  }
  ```

  重試的等待若用真 timer，測試會慢 7 秒。優先把 sleep 做成可注入的參數（預設真 sleep），測試傳 no-op。

- [ ] **Step 2: Run the focused test and verify red**

  Run: `npx tsx sim/run.test.ts` → FAIL（目前只呼叫一次、log 沒有 errno）。

- [ ] **Step 3: 加重試並改用 `describeError`**

  `describeError` 已在 `sim/run.ts:567` export，直接用。判準：`error instanceof TypeError`——`login()` 自己的 HTTP 失敗丟的是 `Error('login X 失敗: <status>')`，只有 fetch 的連線失敗是 `TypeError`。上限 2 次重試，間隔 2s／5s。

  ```ts
  // 連線層失敗重試；HTTP 失敗（尤其 429，限流窗口 15 分鐘）立刻放棄。
  // gate 失敗會「略過一般 session」，所以這裡多撐一次就少一次整輪空轉——
  // 2026-07-16～07-29 owner 側就是這樣連續 540 次沒跑。
  ```

- [ ] **Step 4: Run the focused test and verify green**

  Run: `npx tsx sim/run.test.ts` → exits 0。

- [ ] **Step 5: Static checks and commit**

  Run: `npx tsc --noEmit && npx tsc -p sim/tsconfig.json --noEmit && npm test && git diff --check`

  ```bash
  git add sim/run.ts sim/run.test.ts
  git commit -m "fix(sim): 成員通知 login 留下 errno 並重試連線層失敗"
  ```

---

### Task 6: 開啟 gate、重啟 timer、實跑驗收

**Task 1-5 全部 green 且已 commit 之後才做這一步。** gate 是本計畫唯一的成員喚醒機制，也是造成 07-16～07-29 斷流 13 天的東西。

**Files:**
- Modify: `/home/hom/.local/bin/sim-sweep-cron.sh`
- Modify: `docs/operations.md`（「Notification preflight（目前停用）」段落）
- Read: `sim-logs/`, `data/dev.db`

- [ ] **Step 1: 開 gate**

  在 `/home/hom/.local/bin/sim-sweep-cron.sh` 第 7 行 `export PATH=...` 之後加：

  ```bash
  export SIM_NOTIFICATION_GATE=1
  ```

- [ ] **Step 2: 重啟 timer**

  ```bash
  systemctl --user start sim-sweep-owner.timer sim-sweep-team.timer
  systemctl --user list-timers 'sim-*' --no-pager
  ```

  Expected: 兩個 timer 都有 `NEXT`（owner :00/:30、team :15）。

- [ ] **Step 3: 第一個 team tick 之後，數 gate 有沒有再吃掉 session**

  這是斷流 13 天的機制（577 tick 裡 540 次被略過），gate 失敗會**靜默略過一般 session**，所以必須主動數，不能等看板出問題：

  ```bash
  cd /home/hom/code/task-tracker
  grep -c '略過一般 session' sim-logs/sweep-*-cron-$(date +%Y%m%d)-*.log 2>/dev/null | grep -v ':0$'
  grep -h 'notification-sweep:' sim-logs/sweep-team-cron-$(date +%Y%m%d)-*.log | tail -30
  ```

  Expected: 第一個指令**無輸出**（沒有任何 tick 被略過）；第二個看到 user02–05 各一組「開始／結束」、**沒有 user06**。

  任何一行 `略過一般 session` 都要看它後面 `describeError` 印出的 cause，不要當雜訊。若 member login 又出現 `fetch failed`，記下 errno 後**先把 gate 關掉**再排查，不要放它連續空轉。

- [ ] **Step 4: 更新 `docs/operations.md`**

  改寫「Notification preflight（目前停用）」段落：記錄 gate 於本次恢復、恢復前補了哪些東西（Task 5）、以及 Step 3 那組「數略過次數」的指令是恢復後的常規檢查。

  ```bash
  git add docs/operations.md
  git commit -m "docs: 記錄 notification gate 恢復與恢復後的檢查方式"
  ```

- [ ] **Step 5: 端到端驗收（接下來 24-48 小時的看板）**

  owner :00/:30、team :15，一輪發想要跨數個 tick：

  - 主工作區是否出現**主題在 repo 以外**的新 `[討論]`
  - `【OWNER想法】` 是否真的附 ≥3 條可追溯來源，且**六欄仍解析得出來**（收尾沒有丟「收尾前必須留下完整的 OWNER想法」）
  - user02–05 是否留言，且是否出現 `【同意】`／`【疑慮】`（這一輪只看流程通不通，**不評價票的品質**）
  - user02 那一票是否確實由 claude 產生（看 `sim-logs/*/` 的 prompt artifact 與 session log）
  - 是否有任何一則走完「四人共識 → 目標工作區開新 task → 原 task Done」

  機械式查法（發想的結局全部落在同一個事件）：

  ```bash
  node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/dev.db',{readOnly:true});
  db.prepare(\"SELECT aggregate_id, occurred_at, json_extract(payload_json,'\$.outcome') o FROM event_store WHERE event_type='task.main_discussion_concluded' ORDER BY occurred_at DESC LIMIT 10\").all().forEach(r=>console.log(r.aggregate_id.slice(0,8),r.occurred_at,r.o));"
  ```

- [ ] **Step 6: 把觀察寫進 `docs/tasks/current.md`**

  不論成敗都要記，包含「沒發生什麼」。若一輪下來仍是 0 個 repo 外主題，那是 prompt 沒吃進去，不是 gate 的問題——先看 prompt artifact 確認新規則真的在裡面。

---

## 明確不做

1. **不動 `src/`。** 四人門檻由 owner 清點；`[發想]` 前綴整個放棄（`src/task.ts:178` 會蓋掉它，改它等於重演 repo 已付過兩次代價的前綴 churn）。
2. **不改 `MEMBER_TOOLS`。** 原設計加 `WebSearch,WebFetch` 是為了讓成員查證；查證改由 owner 做，這一項失去理由。
3. **不加 `memberPrompt` 的 `[發想]` 分支。** 同上。
4. **不把主工作區 owner sweep 換成 `OWNER_OPEN_MODEL`。** `sim/run.ts:948` 的註解寫著「owner 開場是生成型工作（發想＋開題）」，很容易誤以為該用它——但它是 claude，而 claude **會**強制執行 `--allowedTools`，`MAIN_OWNER_TOOLS` 只有 `Bash(curl:*)`（`:945`）。換過去等於把 owner 的網路收掉，正好砍斷本計畫的前提。sweep 維持 codex `OWNER_REVIEW_MODEL`。
5. **不使用 `move`。** 發想 task 從頭到尾留在主工作區，最終狀態一律 Done；實作永遠是目標工作區的新 task。這讓每則發想的結局都能從 `task.main_discussion_concluded` 的 `outcome` 機械式讀出。
6. **不修 `sim/run.ts:2290` 的成員工作 session gate login。** 那是工作巡檢路徑、不是表態路徑，本計畫不依賴它；`675e1bc` 的 `describeError` 已讓它可診斷，先觀察。
7. **不動 scenario。** `taskCreationMode` 是**死欄位**（全 repo 只有宣告、沒人讀），既有的 `product-ideation` scenario 沒有任何行為；主工作區在 `ensureMainWorkspaceCandidate`（`:241`）硬寫成 `self-directed`。

## 已知風險

- **通知 gate 是本計畫唯一的成員喚醒機制，而它剛造成 13 天斷流。** Task 5 是緩解不是根治——`fetch failed` 的底層成因仍未查明（CI 負載、server 重啟、keep-alive 靜默失效三個假說已本機實測推翻，見 `docs/tasks/current.md`）。
- **查證與決策都壓在 owner 身上。** 它要在 20 分鐘的巡檢 session 裡兼做查證、開題、清點、收尾。
- **claude 額度**：user02（工作＋通知）與 user06（工作）都吃 claude。Task 3 的 `fallback` 是緩解；若仍常撞額度，要重新分配 route。
- **票源只有 5 個而要 3 票**：user09（真人）不表態時，user02–05 這 4 位要有 3 位同意——容得下 1 個 `【疑慮】`，2 個就過不了。若卡住的點子開始堆積，門檻要重新談。
- **user06 的未讀會累積**：owner 仍會 @mention 它（既有 prompt 步驟 3），但沒有人消化。無害，但日後恢復 user06 通知時會面對積壓。
