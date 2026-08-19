# sim 車隊結構化 trace 開發文件

> 狀態：階段 0-4 全數完成（2026-08-19）。實作時修正了本文九處與原稿不符的地方，見〈實作與設計的出入〉。查證日 2026-08-18。本文所有 `file:line` 均為撰寫當日實際存在的位置；實作前請重新確認行號未因其他 session 提交而位移。

## 決策摘要

把 sim 車隊目前的自由文字紀錄（`sim/run.ts` 的 55 處 `console.log`、`sim-logs/*.log` 的 PROMPT/STDOUT/STDERR 純文字檔）補成一份可查詢的 trace：固定事件語意、ISO 時間、task/session ID、來源與 evidence 類型。

四個關鍵決定：

1. **事件語意不發明，從既有狀態機推導**。`task_runs.phase` 的 CHECK 約束、`coordinator.ts` 的 outcome union、`action_log.kind` 的實際值，三者已經是詞彙的 SSOT。trace 對齊它們，不建立平行的第二套事實。
2. **事件掛在編排層，不掛資料層**。`sim/production/state.ts` 與 `policy.ts` 維持純粹；trace 呼叫落在 `sim/production.ts`、`sim/production/coordinator.ts` 與 `sim/run.ts` 三個編排層。重複出現的序列包成 wrapper，讓實際呼叫點收斂到約 10 處——見〈掛載點〉的 wrapper 說明。
   `sim/run.ts` 有 `main()` 與 `sweep()` **兩種執行模式**（`:3355` 分派），sweep 才是 timer 每天觸發數十次的常態路徑，階段 3 優先做它。
3. **寫入端依事件檢查、落盤維持扁平**。`TraceArgs` mapped type 讓漏填 evidence 當場編譯失敗，而 `formatTraceRecord` 與 `jq` 只面對一種形狀。見〈為什麼寫入端與落盤端用不同型別〉。
4. **不引入 logging 框架**。本 repo `dependencies` 為空（`package.json` 只有四個 devDependencies），DB 用 `node:sqlite`。理由與翻案條件見〈附錄：為何不用 logging 框架〉。

不動 `src/` 應用層：`src/audit.ts:24` 已載明 `event_store` 本身即 audit log，metadata 帶 actor/ip/request_id，重複建置沒有價值。

## 範圍

| 納入 | 排除 |
| --- | --- |
| `sim/production.ts` 編排流程（coordinator tick） | `src/` 應用層（已有 `event_store`） |
| `sim/run.ts` 編排流程（一場 sim） | `sim/notificationTelemetry.ts`（已是完整 telemetry，見下） |
| `sim/production/runner.ts`、`sim/run.ts` 的 AI session 起訖 | `sim-logs/*.log` 的檔案格式（一個字都不改） |

**與 `notificationTelemetry` 的關係**：`sim/notificationTelemetry.ts` 已是 196 行零依賴的 JSONL telemetry，有固定 enum、runtime 驗證、retention 與 aggregates，但範圍只涵蓋 notification gate 流程。**不合併、不重寫**——它有外部 contract 和自己的 runtime 驗證（因為吃外部 JSON）。trace 在 session 事件上記一個指向它的 `evidence.ref` 即可。它同時是本設計的形式範本：`createNotificationTelemetryRecorder`（`sim/notificationTelemetry.ts:167`）的 partial application 寫法直接沿用。

## 事件語意

14 個事件，分五組。每一個都有出處，不是憑空分類——出處全部在 2026-08-18 的程式掃描中實查過。

| 組別 | 事件 | 語意 | 出處 |
| --- | --- | --- | --- |
| 生命週期 | `run.started` / `run.ended` | 一個 coordinator tick、一場 sim 或一次 sweep 的邊界 | `production.ts:689` `beginTick`／`:694`·`:737`·`:755`·`:778` 四處 `endTick`；`run.ts:2774` `main`、`:3085` `sweep` |
| 生命週期 | `session.started` / `session.ended` | 一次 AI 呼叫。`session_id` 由此產生 | `runner.ts:88` `runAiSession` 內的 `logFile`；`run.ts:2002` `runSessionAttempt` |
| 工作推進 | `task.phase_changed` | task 狀態轉移，帶 `from`/`to` | `state.ts:37-40` `task_runs.phase` CHECK 的 8 個值 |
| 工作推進 | `task.attempted` | 成員嘗試一次，含 evidence 是否變化 | `coordinator.ts:108` `recordMemberAttempt` 呼叫處 |
| 工作推進 | `action.started` / `action.ended` | 一個具冪等 key 的 mutation 起訖 | `state.ts:324/336/351` `beginAction`/`completeAction`/`failAction` |
| 證據產生 | `ci.checked` | 三種檢查的結果，由 `reason` 區分 | `coordinator.ts:231`·`:244`·`:250`；`run.ts:2680` `verifyBranches` |
| 證據產生 | `commit.recorded` | 代 commit 成功或因未允許檔案被拒 | `run.ts:2550` `commitMemberWork` |
| 證據產生 | `merge.integrated` | 分支併入 master | `coordinator.ts:270` `mergeTaskIntoMaster` 呼叫處 |
| 交付 | `completion.confirmed` | readback 確認完成三要件成立 | `completion.ts:153` `postCompletionAndTransitionToDone` |
| 交付 | `notify.sent` | 完成通知送出 | `coordinator.ts:544` `recordBatchAttempt` 呼叫處 |
| 阻塞 | `gate.skipped` | notification gate 未過，略過一般 session | `run.ts:1875/2801` |

五組各 4 / 4 / 3 / 2 / 1 個事件，合計 14。

### `ci.checked` 的三種來源，用 `reason` 區分

CI 不是單一檢查。production 側走注入點 `deps.runBranchCi`（預設實作在 `production.ts:710`，就是 `npm test`），實際呼叫分三處：

| `reason` | 位置 | 檢查內容 |
| --- | --- | --- |
| `branch_ci` | `coordinator.ts:231` | 分支 CI |
| `integration` | `coordinator.ts:244` | `npm test` / `npm run build` / `git diff --check`（清單在 `:160`） |
| `task_specific` | `coordinator.ts:250` | task 專屬驗收 |

**不要掛 `state.ts:377` 的 `storeCiRun`**——它連同 `lookupCiRun`（`:387`）、`ciCacheKey`（`git.ts:301`）與 `ci_runs` 表都是死碼，只有測試碰過。詳見〈已知細節與待確認〉。

### 為什麼移除 `escalation.raised`

`[ESCALATE]` 不是編排層產生的事件，是 **AI 自己寫在留言正文裡的字串**（prompt 在 `run.ts:2257`），事後由 `sim/escalateNotify.ts:9` `scanNewEscalates` 以 `LIKE '%[ESCALATE]%'` 掃 DB 撈出。`run.ts:2527` 那行只是本場統計的印出，不是事件產生點。

至於呼叫端——2026-08-19 實跑 sweep 時查到，它其實**每個 tick 都會跑**：呼叫端在 repo 外的 `~/.local/bin/sim-sweep-cron.sh`（`npm run sim -- --sweep` 之後緊接著 `node --import tsx sim/escalateNotify.ts`）。先前寫「沒有任何呼叫端」是只搜了 repo 內部，錯了。但移除的理由不受影響——它掃的是留言正文，那不是編排層事件。

事後掃留言內容得到的東西不屬於 trace 的語意。**移出，14 個事件。**

### 為什麼是一個 `task.phase_changed` 而不是七個事件

`task_runs.phase` 有 8 個狀態、7 條主要邊。若每條邊一個事件，DB CHECK 改動時要同步改 trace enum，必然漂移。改用單一事件加 `from`/`to` 欄位，值域直接引用 phase 型別，無法脫鉤。

**規則：`from === to` 不送事件。** `upsertTaskCheckpoint` 是 upsert，`sim/production.ts` 的 7 個以上呼叫處有好幾個是把 phase 寫成本來就是的值（例如 `:1327` 固定寫 `'doing'`）。不設這條規則的話，trace 會被沒有實際轉移的事件淹掉。

### 為什麼 coordinator 的 9 種失敗不進 enum

`coordinator.ts:202-210` 已有 `fatal_blocked` / `branch_ci_failed` / `integration_conflict` / `integration_command_failed` / `task_specific_acceptance_failed` / `deploy_precondition_failed` / `deployed` / `deploy_indeterminate` / `deploy_failed_post_merge` 的 discriminated union。這些是**結果**不是**事件類別**，放進 `reason` 欄位，值域沿用該 union。新增一種失敗時不需要動 trace enum（OCP）。同理，`action_log.kind` 的實際值（`assign`、`status`、`dispatch_notice`、`human_blocked_notice`、`fatal_error`、`reject`、`deployment_rollback_notice`、`main_discussion_conclusion`、`done`、`comment_failed`、`patch_failed`）也走 `reason`。

## 記錄格式

JSONL，一行一事件。`run_id` 有**三種來源**，切檔策略隨之不同：

| 執行路徑 | 進入點 | 觸發方式 | `run_id` | 檔案 |
| --- | --- | --- | --- | --- |
| coordinator tick | `sim/production.ts` | `sim-coordinator.timer` | `tick_id` | `trace/<YYYY-MM-DD>.jsonl` |
| **sweep 巡檢** | `sim/run.ts` `sweep()` | `sim-sweep-owner/team.timer` | `runDir` 的 basename（`sweep-<stamp>-<role>`） | `trace/<YYYY-MM-DD>.jsonl` |
| 一場完整 sim | `sim/run.ts:2774` `main()` | 手動 | sim tag | `trace/<run_id>.jsonl` |

`sim/run.ts` 有兩種執行模式，在 `:3355` 分派：

```ts
await withRunLock(lockPath, () => SWEEP ? sweep(SWEEP_ROLE) : main());
```

**sweep 才是常態路徑**——systemd timer 每天觸發數十次，而 `main()` 是手動跑的完整場。sweep 其實**早就有識別碼**（`createRunDir(LOG_DIR, `sweep-${stamp}-${role}`)`），不必另發；實作只是把那兩行從函式中段提到最前面，讓 `run_id` 早於第一個事件存在。

切檔：定時觸發的兩條路徑按日切，否則 coordinator 每天約 72 個 tick（見 [current.md](tasks/current.md) 的 07-29 量測）加上 sweep，一年會生出幾萬個小檔，重演 `sim-logs/` 現有 8199 個 `.log` 的老路。`run_id` 留在欄位裡照樣可 `jq` 篩。手動跑的 `main()` 一場一檔。

選 JSONL 不選 JSON array：append-only、可 `tail -f`、壞一行不毀整檔。這是 log 的既定規範，也與 `notificationTelemetry` 落盤方式一致。

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `ts` | string | ISO 8601 UTC。沿用 `notificationTelemetry` 的 `assertTimestamp` 慣例 |
| `event` | `TraceEvent` | 上表 14 個之一 |
| `run_id` | string | coordinator 的 `tick_id`，或一場 sim 的 tag |
| `round` | number \| null | 成員第幾輪 |
| `session_id` | string \| null | AI session 的 logFile basename（見下） |
| `task_id` | string \| null | |
| `actor` | string | `阿凱`、`coordinator`、`owner` |
| `model` | string \| null | `claude-opus-5`；非 AI 來源為 null |
| `outcome` | `Outcome \| null` | `'ok' \| 'fail' \| 'skip' \| 'refused'`。**「開始」類事件為 `null`**——`run.started` / `session.started` 尚未有結果，補 `'ok'` 在語意上是錯的 |
| `reason` | string \| null | 值域為既有 union，見上節 |
| `evidence` | `{ kind, ref }` \| null | 見〈evidence 的型別強制〉 |
| `detail` | string | 現在那句人話。**上限 300 字元，超出截斷** |

`actor` 與 `model` 拆成兩欄而非單一 `source` 字串：要能 `group by` 模型看哪個 route 出問題，字串裡塞分隔符遲早解析錯。

`detail` **只供人閱讀，不得被任何程式解析**。300 字元上限沿用 `sim/run.ts:2038` 現行的 `tail.slice(0, 200)` 做法並放寬；AI 回應全文留在 `sim-logs/*.log`，trace 只記指標。

`ref` 是 sha、logFile 路徑或 URL——只記類型與指標，全文留在原處。`kind` 與事件一一對應，不得任意搭配。**沒有事件用得到的 kind 不預先定義**——原先列的 `http` 已於實作時移出，需要時再加一個字串字面量：

| `kind` | `ref` 是什麼 | 用在哪個事件 |
| --- | --- | --- |
| `tsc` / `test` | 檢查輸出的 logFile 路徑 | `ci.checked` |
| `git` | commit 或 merge sha | `commit.recorded`、`merge.integrated` |
| `readback` | 被讀回驗證的 comment / notification id | `completion.confirmed` |
| `log` | `sim-logs/` 下的 transcript 路徑 | `session.ended` |

### session_id 的粒度

`session_id` = **一次 AI 呼叫**，直接取 `runner.ts:88` 既有產生的 `<ISO>-<label>.log` 的 basename。不發新 ID，順手把現有 8199 個純文字 transcript 與 trace 綁在一起，transcript 格式不用改。「這輪重試了幾次」由另一個 `round` 欄位承載，兩種粒度都拿得到。

**掛載位置的硬性限制**：`logFile` 是在 `runAiSession` **內部**（`runner.ts:88`）算出來的，`createMemberSessionRunner`（`:287`）那一層要 `await` 回來才拿得到。因此 `session.started` 必須掛在 `runAiSession` 內部、`logFile` 算出之後、spawn 之前——掛在 runner 工廠那層的話 `session.started` 的 `session_id` 會是 `null`，整條 session 綁定就斷了。`sim/run.ts` 的 `runSessionAttempt`（`:2002`）沒有這個問題，它的 `logFile` 在 `:2004` 同一個函式內產生。

### 欄位命名

落盤一律 snake_case，對齊 `notificationTelemetry` 與 DB 欄位。`sim/run.ts` 內部維持 camelCase，在 `buildTraceRecord` 邊界轉換。落盤格式的一致性優先於程式內慣例。

## 模組設計

`sim/trace.ts`（實作 112 行，含註解）。核心是一張 mapped type：**寫入端依事件收不同參數，落盤是單一扁平形狀**。

```ts
// 每個事件收哪些參數。這張表就是〈事件語意〉那節的程式碼形式。
type TraceArgs = {
  'run.started':        { detail: string };
  'session.started':    { detail: string };
  'task.phase_changed': { from: Phase; to: Phase; detail: string };
  'ci.checked':         { outcome: Outcome; evidence: Evidence; detail: string };        // evidence 不可 null
  'commit.recorded':    { outcome: Outcome; evidence: Evidence | null; detail: string };
  // … 共 14 條
};

export type TraceEvent = keyof TraceArgs;   // enum 由表推導，不另外維護一份
export type TraceSink = (record: TraceRecord) => void;

interface TraceBase { run_id: string; session_id: string | null; task_id: string | null; actor: string; model: string | null; round: number | null }

// 落盤形狀：扁平、每行欄位相同。表裡沒給的欄位由 buildTraceRecord 補 null。
interface TraceRecord extends TraceBase { ts: string; event: TraceEvent; outcome: Outcome | null; reason: string | null; evidence: Evidence | null; from: Phase | null; to: Phase | null; detail: string }

function buildTraceRecord<E extends TraceEvent>(base: TraceBase, event: E, args: TraceArgs[E], now: Date): TraceRecord;  // 純函式
function formatTraceRecord(r: TraceRecord): string;   // 人話那行；單一函式，無 switch
export function createFileSink(fileName?: string): TraceSink;   // 省略 fileName 則按日切檔

export function createTracer(base: TraceBase, sink?: TraceSink, now?: () => Date): Tracer;
```

export 面積為 `createTracer` / `createFileSink` / `formatTraceRecord` 與型別；`buildTraceRecord` 與 `TraceArgs` 為 internal。`createFileSink` 要 export 是因為手動跑的 `main()` 需要一場一檔，`formatTraceRecord` 則是階段 4 的 fixture 判準要直接斷言它。測試以 memory sink 驗證欄位齊全（`sim/trace.test.ts`）。

### 為什麼寫入端與落盤端用不同型別

型別保護的價值全在寫入端，union 的代價全在讀取端——兩端沒有理由共用一個型別：

| | 對象 | 數量 | 完整 union 的影響 |
| --- | --- | --- | --- |
| 寫入端 | 掛載點，每處只寫一種事件 | 約 10 處（wrapper 收斂後） | **有幫助**：漏填當場編譯失敗 |
| 讀取端 | `formatTraceRecord`、`jq`、日後分析 | 少但長命 | **有害**：每次讀都要 narrow |

若把 14 個事件做成完整的 `TraceRecord` union，`formatTraceRecord` 會變成 14 條 arm 的 `switch`——那正是本文件宣稱不做的 Visitor 式分派，等於從後門放進來；`jq` 那端也會從一種形狀變成十四種。

mapped type 兩邊都拿到：

```ts
trace('ci.checked', { outcome: 'ok', detail: '…' });        // ✗ 編譯失敗：缺 evidence
trace('run.started', { evidence: {…}, detail: '…' });       // ✗ 編譯失敗：多餘屬性
trace('task.phase_changed', { from: 'doing', to: 'review', detail: '…' });  // ✓
```

**誠實記下成本**：扁平化的代價是稀疏欄位。不收 evidence 的 9 個事件仍會寫出 `"evidence":null`（約 17 bytes/行），而 `from` / `to` 只有 `task.phase_changed` 用得到，其餘 13 個事件每行都帶兩個 null。差別在於沒有人需要手寫它們。不省略這些 key——固定形狀是本設計的核心價值，`jq` 也不必處理欄位有無。這是便宜，不是免費。

**上限規則**：事件專屬欄位（目前是 `from`、`to` 兩個）**不得超過 3 個**。超過就代表扁平化開始付不起，屆時重新評估——不要一路加到二十欄的稀疏表才回頭看。

### evidence 的型別強制

| evidence | 事件 |
| --- | --- |
| **必填、不可 null**（3） | `ci.checked`、`merge.integrated`、`completion.confirmed` |
| **`Evidence \| null`**（2） | `commit.recorded`、`session.ended` |
| **不收此參數**（9） | 其餘 |

`merge.integrated` 的必填已確認可行：`coordinator.ts:270` 的 `mergeTaskIntoMaster(...)` 回傳 `mergeSha`，evidence 拿得到。

`commit.recorded` 不能無條件要求 evidence：`sim/run.ts:2560/2574` 的「拒絕未允許檔案」路徑 `outcome` 是 `refused`，**沒有 sha 可填**。真正的規則是「`outcome === 'ok'` 時 evidence 必填」，那是 conditional type——TS 表達得出來，但讀起來會比它防的錯誤更難懂。**明確不做**，收 `Evidence | null` 即可。

### SOLID 對照

| 原則 | 本設計採取的具體形式 | 明確不做 |
| --- | --- | --- |
| SRP | 建事件 / 格式化 / 寫出，三個函式分離。純函式讓測試不必碰 fs | 不為此拆成三個檔案 |
| OCP | 新增事件 = `TraceArgs` 加一行，**沒有任何函式本體要改**；`reason` 承載可擴充值域 | 不用 Strategy / Visitor 分派，也不做完整 `TraceRecord` union（會逼出 15 arm switch） |
| LSP | 不適用，無繼承 | 不硬套 |
| ISP | export 面積最小化。呼叫端只認識 `createTracer` | 不定義 `TraceSink` class 階層 |
| DIP | `sink` 以參數注入，型別是 function type | **不定義 `interface TraceSink { write() }` + `FileTraceSink`/`MemoryTraceSink` 兩個 class** |

DIP 這一條與 repo 既有慣例完全一致：`sim/production.ts:211` 的 `GatherSnapshotDeps` 已經在注入 `db` / `now()` / client，`sim/production.ts:315` 更用 `Pick<TaskTrackerClient, 'listComments' | …>` 收窄介面——ISP 與 DIP 在這個 codebase 是既成事實，trace 只是多掛一個 `deps.trace`，不是新引入的架構。

### 設計模式

只用兩個，都是語言原生形式：

- **Mapped type + literal discriminant** 取代 Visitor / Strategy 分派。`event` 這個 literal 是 discriminant，但它 discriminate 的是**輸入參數**而非落盤記錄；mapped type 是資料不是分派。
- **Partial application** 取代 Factory / Builder：`createTracer(base)` 回傳綁好 `run_id` / `session_id` / `actor` / `model` 的函式，即 child logger。

明確不做：Observer（沒有第二個訂閱者）、Decorator（沒有要疊行為）、Singleton（module 本身就是）、Repository（一個 append 而已）。

## 掛載點

編排層是 `sim/production.ts`、`sim/production/coordinator.ts`、`sim/run.ts` 三個檔案。`sim/production/state.ts` 與 `sim/production/policy.ts` 保持純粹，不放任何 trace 呼叫。

### `checkpointAndTrace` wrapper

`upsertTaskCheckpoint` 在 `sim/production.ts` 有 **8 處**呼叫。若在每處手寫 trace，每處都要重複三件事：先取舊 phase、upsert、比對後決定送不送。包成一個 wrapper：

```ts
function checkpointAndTrace(deps, input, detail) {
  const before = getTaskRun(deps.db, input.taskId);
  const run = upsertTaskCheckpoint(deps.db, input, deps.now());
  if (before?.phase !== run.phase) {
    deps.trace('task.phase_changed', { from: before?.phase ?? null, to: run.phase, detail });
  }
  return run;
}
```

6 行，呼叫端反而變短。這不是抽象——沒有 interface、沒有多型、沒有為未來預留——只是同一組三步驟出現 8 次，抽成一個函式。名字帶 `AndTrace` 讓副作用自我說明。

**不包的話會有四種靜默失敗**，編譯器一種都擋不住：

| 失敗 | 後果 |
| --- | --- |
| 漏了 `getTaskRun` | `from` 為 `null`，看不出是否真的轉移（`from` 型別本來就允許 null） |
| 漏了 `from !== to` 判斷 | 假事件淹沒 trace |
| `getTaskRun` 寫在 upsert **之後** | `before` 即 `after`，永遠相等，**該事件一筆都不會產生** |
| 未來新增第 9 處呼叫忘了補 | trace 出現洞 |

第三種最危險：程式跑得好好的，直到出事要查 trace 才發現那個事件從頭到尾沒被記過。**一個會靜默漏記的 trace 比沒有 trace 更糟**，因為你會相信它是完整的。

### `withAction` wrapper

`beginAction` 在 `sim/production.ts` 也有 **8 處**呼叫，八處都是同一個骨架（`:944-957` 是其中一處），只有中間那段工作不同：

```ts
const key = `assign:${taskId}:${assigneeId}`;
if (!getAction(deps.db, key)) {                       // 冪等檢查
  beginAction(deps.db, { actionKey: key, taskId, kind: 'assign' }, now);
  try {
    …實際工作…
    completeAction(deps.db, key, resultJson, now);
  } catch (err) {
    failAction(deps.db, key, (err as Error).message, now);
    throw err;
  }
}
```

包成 wrapper，把冪等檢查、三段生命週期與 trace 一起收進去：

```ts
async function withAction(deps, key, kind, taskId, fn) {
  if (getAction(deps.db, key)) return;                 // 已做過就跳過
  beginAction(deps.db, { actionKey: key, taskId, kind }, deps.now());
  deps.trace('action.started', { reason: kind, detail: … });
  try {
    const result = await fn();
    completeAction(deps.db, key, result ?? null, deps.now());
    deps.trace('action.ended', { outcome: 'ok', reason: kind, detail: … });
  } catch (err) {
    failAction(deps.db, key, (err as Error).message, deps.now());
    deps.trace('action.ended', { outcome: 'fail', reason: kind, detail: … });
    throw err;
  }
}
```

**這比 `checkpointAndTrace` 大一個量級，要有心理準備**：前者是多包一層呼叫，後者是**接管控制流**——try / catch / rethrow / 冪等檢查全交給 wrapper，8 個區塊要重構成 callback 形式。目前 8 處的 catch 行為剛好都是 `throw err`，所以包得起來；日後若有一處要吞掉錯誤，就得為它加參數，不要為了預留而現在就加。

不包的代價是 8 × 3 = **24 處 trace 呼叫**，而漏掉 `fail` 那一條時，失敗的 action 就沒有 trace——失敗恰恰是最需要查的東西。

### 為什麼不把 action 的 trace 放進 `state.ts`

看起來最省：`beginAction` / `completeAction` / `failAction` 各加一行，3 個位置涵蓋全部呼叫、8 個呼叫端一個字都不用改、不可能漏。**但它會廢掉 `run_id`。**

`beginAction(db, { actionKey, taskId, kind }, now)` 的簽章裡沒有 `run_id`、`actor`、`session_id`——那些都在編排層。硬做的話 action 事件的 `run_id` 是 null，等於無法把一個 tick 的事件 group 起來，而那正是這份設計的核心用途。

要救就得把已綁好 base 的 tracer 整個傳進 `state.ts`。功能上可行，但簽章一樣要改、`state.ts` 還就此依賴 trace 型別，「純資料層」的規則破了卻沒省到多少。**明確不做。**

### 掛載點總表

14 個事件全部有掛點，無遺漏。

| 檔案 | 位置 | 送出事件 |
| --- | --- | --- |
| `sim/production.ts` | `:689` `beginTick` 呼叫處 | `run.started` |
| `sim/production.ts` | `endTickAndTrace` 內（取代 **五處** `endTick`——含 catch block 那處） | `run.ended` |
| `sim/production.ts` | `checkpointAndTrace` 內（取代 8 處 `upsertTaskCheckpoint` 直接呼叫） | `task.phase_changed` |
| `sim/production.ts` | `withAction` 內（取代 8 處 `beginAction` / `completeAction` / `failAction` 區塊） | `action.started` / `action.ended` |
| `sim/production.ts` | `applyMemberAttemptTransition` 內，`recordMemberSessionAttempt` 回傳後 | `task.attempted` |
| `sim/production/coordinator.ts` | `runDeployAcceptance` 內三處，以 `reason` 區分 | `ci.checked` |
| `sim/production/coordinator.ts` | `runDeployAcceptance` 內 `mergeTaskIntoMaster` 之後，`evidence.ref` = `mergeSha` | `merge.integrated` |
| `sim/production.ts` | `runDiscordOutboxTick` 回傳的 outcome 迴圈 | `notify.sent` |
| `sim/production.ts` | `completion.kind === 'done'` 分支（`completion.ts` 一個字都沒改） | `completion.confirmed` |
| `sim/production/runner.ts` | `runAiSession` 內部，算出 `logFile` 之後、spawn 之前（**不是** runner 工廠層），tracer 由 module-level `setSessionTraceFactory` 注入 | `session.started` / `session.ended` |
| `sim/run.ts` | `sweep()` 與 `main()` 各呼叫一次 `startRunTrace`；`run.ended` 由 `runCli` 的 try/catch 統一送 | `run.started` / `run.ended` |
| `sim/run.ts` | `runSessionAttempt`，`logFile` 算出之後 | `session.started` / `session.ended` |
| `sim/run.ts` | `commitMemberWork` 的三個結束點（1 成功 + 2 拒絕） | `commit.recorded` |
| `sim/run.ts` | `verifyBranches` 每個 packet 送兩筆（tsc、test） | `ci.checked` |
| `sim/run.ts` | `runActorSessionWithNotificationGate` 回傳 `null` 時 | `gate.skipped` |

**`sim/run.ts` 沒有 `merge.integrated`**：該側的合併是 owner AI session 自己下 `git merge --no-ff`（prompt 在 `:2407`、`:3075`），程式端只有 `abortStaleMerge()`（`:1663`）。沒有程式化的 merge 呼叫可掛，不靠掃 git log 或解析 AI 輸出硬湊。

## 落地階段

| 階段 | 內容 | 完成判準 |
| --- | --- | --- |
| 0 | 確認本文 14 個事件與出處無誤 | 人工過目（出處已於 2026-08-18 實查） |
| 1 ✅ | `sim/trace.ts` + `assert` 自檢 | 2026-08-19 完成：`npm test` 全綠（`sim/trace.test.ts` 已納入 `package.json` 的 test 串） |
| 2 ✅ | 包三個 wrapper，掛 `sim/production.ts`、`coordinator.ts`、`runner.ts` | 2026-08-19 完成：`production.integration.test.ts` 的 Todo→Done 端對端斷言——同一 `run_id`、10 種事件齊全、phase 轉移恰為 `∅→assigned→doing→review→done`、`ci.checked` 三種 `reason` 皆到齊且 evidence 非 null |
| 3 ✅ | 掛 `sim/run.ts` 六處 | 2026-08-19 程式完成：`npm run typecheck` 過、`sim/run.test.ts` 新增斷言（成功與拒絕兩種 `commit.recorded` 都送出、`run_id` 一致）。**未實跑一次 sweep tick**——那要真的燒 AI 呼叫 |
| 4 ✅ | 既有 `console.log` 改由 `formatTraceRecord` 產生同樣人話 | 2026-08-19 完成：`sim/run.ts` 刪掉 8 處與 trace 重複的 `console.log`，`sim/trace.test.ts` 以 6 筆 fixture 鎖住輸出格式 |

階段 4 的驗證方式：準備一組固定的 `TraceRecord` fixture，斷言 `formatTraceRecord()` 的輸出。

**「與舊模板逐字相同」做不到，也不該做**：一個無 switch 的格式化函式產不出 14 套 bespoke 模板，硬做就是把 Visitor 從後門放回來。實際契約是——**人話（`detail`）逐字保留，前綴由 `event` + 上下文取代**：

| 舊 | 新 |
| --- | --- |
| `[代commit] sim/member-x r1 → 8a2fc56` | `commit.recorded [阿凱 ok git:8a2fc56] sim/member-x r1 → 8a2fc56` |
| `[CI預跑] sim/member-x: tsc PASS / test FAIL（2 commit）` | 拆成兩筆 `ci.checked`，各自帶得到輸出檔位置 |

換來的是每行都能 `jq` 篩、CI 那行從「兩個結果擠一行」變成兩筆各自帶 `evidence.ref`。

**刪 `console.log` 的前提是輸出不會消失**：`traceOf` 在沒有 `run_id` 時（單元測試直接 import 這些函式）改用 console-only sink，而不是 no-op——否則刪掉 `console.log` 之後，缺進入點的情境會整段靜音。

**不要用「跑兩次 sim 再 diff 終端輸出」當判準**——`sim/run.ts:85` 為每行加了 `[HH:MM:SS]` 前綴，加上 session id、sha 與 AI 回應內容，兩次執行不可能逐字相同，那是一個永遠過不了的門檻。要驗的是格式化邏輯，不是跑一場 sim。

## 實作與設計的出入

階段 2 實作時發現六處與本文原稿不符，已直接改上面的表，理由記在這裡：

| 項目 | 原稿 | 實際 | 原因 |
| --- | --- | --- | --- |
| `endTick` | 四處 | **五處** | catch block 那處（`UNCLASSIFIED ERROR`）漏掉了，而那正是最需要記的一種 `run.ended` |
| `withAction` 覆蓋數 | 8 處 | **7 處** | `persistFatalError` 是 `beginAction` 之後直接 `failAction`，沒有工作區塊、也拿不到 `deps`，不適用 |
| `withAction` 錯誤處理 | 「目前 8 處剛好都 `throw err`」 | 兩處原本就吞掉 | `human_blocked_notice` 與 `deployment_rollback_notice` 的 catch 沒有 rethrow，wrapper 因此**現在就**需要 `onError: 'throw' \| 'swallow'`，不是日後才需要 |
| `task.attempted` | 掛 `coordinator.ts` | 掛 `production.ts` | `recordMemberSessionAttempt` 是 coordinator.ts 的純函式，塞 trace 進去會破壞它的零 I/O 契約 |
| `completion.confirmed` / `notify.sent` | 掛 `completion.ts` / `coordinator.ts` | 都掛 `production.ts` | 呼叫端本來就在 switch/迴圈裡拿得到結果，兩個檔案一個字都不用改 |
| `sweep()` 的 run_id | 「目前沒有任何 run 識別碼，需新發」 | **本來就有** | `createRunDir(LOG_DIR, `sweep-<stamp>-<role>`)` 早就在，只是建在函式中段，提前兩行即可 |
| `run.ts` 的 `run.ended` | 掛在 `sweep()` / `main()` 各自 | 統一由 `runCli` 送 | 兩個進入點都可能拋錯，收尾寫在共同的 try/catch 才不會漏；`endRunTrace` 沒開始過就 no-op |
| 階段 4 的「逐字相同」 | 斷言與舊模板逐字相同 | 只保 `detail` 逐字 | 單一無 switch 的函式產不出 14 套模板；要求逐字等於要求 Visitor |
| session 事件的 tracer | 直接掛進 `runAiSession` | 需要 module-level 注入點 | runner 工廠在 CLI 層（`production.ts:1603`）就建好，那時 `tickId` 還不存在；`session_id` 又只有 `runAiSession` 內部算得出來。兩頭夾擊，`setSessionTraceFactory` 是唯一能同時保住 `run_id` 與 `session_id` 的做法 |

另外，`RunDeployAcceptanceInput.trace` 刻意是**選填**：`sim/production.test.ts` 有 14 個 `runDeployAcceptance({...})` 呼叫點，為了一個測試根本不在意的欄位改 14 處不划算。正式呼叫端只有一個，`?.` 在程式碼裡看得見。

## 已知細節與待確認

- **`upsertTaskCheckpoint` 是 upsert，不知道舊 phase**（`state.ts:179`）。要送出 `task.phase_changed` 的 `from`，呼叫端必須先 `getTaskRun` 取值。這是把 trace 掛在編排層而非資料層的另一個理由——編排層本來就持有前後兩個狀態。
- **`ci_runs` 快取層是死碼**（2026-08-18 掃描發現，與 trace 無關的既有問題）。`storeCiRun`（`state.ts:377`）、`lookupCiRun`（`:387`）、`ciCacheKey`（`git.ts:301`）與 `ci_runs` 表都只有測試碰過，production 流程一次都沒呼叫——CI 快取寫好了從沒接上。**本 phase 不處理**（刪死碼超出範圍），但需另開 task：看到 `ci_runs` 表的人會誤以為 CI 有快取。
- **`sim/escalateNotify.ts` 的呼叫端在 repo 外**：`~/.local/bin/sim-sweep-cron.sh` 每個 sweep tick 結束後都會跑它（2026-08-19 實跑時查到；先前寫「沒有呼叫端」是只搜 repo 內部所致）。`escalation.raised` 仍然移出 trace，理由是它掃的是 AI 寫的留言正文、不是編排層事件——與有沒有呼叫端無關。
- **coordinator 的 `ci.checked` 沒有 logFile 可指**。`AcceptanceCheckResult` 只有 `{ passed, detail }`，檢查輸出沒有落成檔案，`evidence.ref` 只能填「在哪裡跑了什麼」（branch 名、`${command}@${worktreePath}`、`task:<id>`）而非輸出位置。要真的能回頭看輸出，得讓 `runBranchCi` / `runIntegrationCommand` 把輸出寫檔——那是另一件事。
- **`session.started` / `session.ended` 目前沒有測試覆蓋**。整合測試注入的是假 runner，走不到 `runAiSession`；要驗只能實跑一次 `--live`。
- **2026-08-19 11:27 實跑一次 `sim-sweep-team.service`**：`run.started` / `run.ended` 正確落進 `sim-logs/trace/2026-08-19.jsonl`，`run_id` = `sweep-2026-08-19-03-27-team`，程式未崩潰。當時看板全收乾淨，所以只產生這兩筆——`session.*` / `commit.recorded` / `ci.checked` / `gate.skipped` 仍未在真實環境出現過，要等有工作流動才會長出來。
- **`run_id` 的時間戳是 UTC，終端前綴是本地時間**（上例 `03-27` vs `[11:27:37]`）。這是 `createRunDir` 沿用已久的命名，不是 trace 引入的；對照 cron log 時要記得差 8 小時。
- **retention 未實作**。`sim-logs/` 是 gitignored，先不管。真要清時抄 `pruneNotificationTelemetry`（`sim/notificationTelemetry.ts:191`）那 10 行，不另設計。
- **`run.ts` 與 `production.ts` 是兩套並行的編排流程**，`run_id` 語意分別是 sim tag 與 tick_id。本設計不統一它們，只要求同一份 trace 格式。

## 施工注意

編輯 `sim/` 之下任何檔案前，先停 `sim-sweep-owner.timer` 與 `sim-sweep-team.timer`——AI 車隊會在讀寫之間改同一批檔案。另有並行 session 會 `git add -A`，改大檔請盡快自行 commit。

## 附錄：為何不用 logging 框架

1. **本 repo runtime 依賴為零**。`package.json` 只有 tsx / tsc / eslint / @types，DB 用 `node:sqlite` 的 `DatabaseSync`。裝 pino 會是第一個 runtime dep，換來的是取代 `appendFileSync(path, JSON.stringify(x) + '\n')` 一行。
2. **框架賣點多半用不到或已有**：
   - log levels — 我們要的是固定事件語意不是嚴重度，`event` + `outcome` 已承載，再加 `level` 只會打架後漂移。
   - transports — 目的地是本機一個檔案。
   - rotation — `sim-logs/` gitignored，且已有 10 行可抄。
   - child logger — 唯一真有用的，但它是 3 行 partial application，`createNotificationTelemetryRecorder` 已在用。
   - 非同步高吞吐寫入 — sim 一個 tick 幾百行。**同步寫在這裡反而正確**：session 掛掉時最後那行正是要看的那行，非同步 buffer 會吃掉它。
3. **框架不解決真正的難處**。難的是「事件 enum 定哪些、哪些欄位不得為空」。框架 API 長成 `logger.info({任意物件}, '訊息')`，是自由文字問題換一套衣服。schema 紀律終究得由 TypeScript 出。
4. **repo 內已有前例**。同一 repo 出現兩套形狀不同的 logging，比重複一次同樣的 pattern 糟。

**翻案條件**：不是換成 pino，而是直接上 OpenTelemetry。觸發條件為以下之一——跨 process / 跨主機需集中彙整、需執行期動態調 sampling、或同步寫入量到會卡住主迴圈。`session.started` / `session.ended` 配 `session_id` 本來就是 span 的形狀，屆時對得上。**在觸發前不為此加任何東西。**
