# sim 車隊結構化 trace 開發文件

> 狀態：設計定稿，尚未實作。查證日 2026-08-18。本文所有 `file:line` 均為撰寫當日實際存在的位置；實作前請重新確認行號未因其他 session 提交而位移。

## 決策摘要

把 sim 車隊目前的自由文字紀錄（`sim/run.ts` 的 55 處 `console.log`、`sim-logs/*.log` 的 PROMPT/STDOUT/STDERR 純文字檔）補成一份可查詢的 trace：固定事件語意、ISO 時間、task/session ID、來源與 evidence 類型。

三個關鍵決定：

1. **事件語意不發明，從既有狀態機推導**。`task_runs.phase` 的 CHECK 約束、`coordinator.ts` 的 outcome union、`action_log.kind` 的實際值，三者已經是詞彙的 SSOT。trace 對齊它們，不建立平行的第二套事實。
2. **事件掛在編排層，不掛資料層**。`sim/production/state.ts` 維持純資料存取，trace 呼叫全部落在 `sim/production.ts` 與 `sim/run.ts` 這兩個編排層。這讓呼叫點從 55 降到 10 個以內。
3. **不引入 logging 框架**。本 repo `dependencies` 為空（`package.json` 只有四個 devDependencies），DB 用 `node:sqlite`。理由與翻案條件見〈附錄：為何不用 logging 框架〉。

不動 `src/` 應用層：`src/audit.ts:24` 已載明 `event_store` 本身即 audit log，metadata 帶 actor/ip/request_id，重複建置沒有價值。

## 範圍

| 納入 | 排除 |
| --- | --- |
| `sim/production.ts` 編排流程（coordinator tick） | `src/` 應用層（已有 `event_store`） |
| `sim/run.ts` 編排流程（一場 sim） | `sim/notificationTelemetry.ts`（已是完整 telemetry，見下） |
| `sim/production/runner.ts`、`sim/run.ts` 的 AI session 起訖 | `sim-logs/*.log` 的檔案格式（一個字都不改） |

**與 `notificationTelemetry` 的關係**：`sim/notificationTelemetry.ts` 已是 196 行零依賴的 JSONL telemetry，有固定 enum、runtime 驗證、retention 與 aggregates，但範圍只涵蓋 notification gate 流程。**不合併、不重寫**——它有外部 contract 和自己的 runtime 驗證（因為吃外部 JSON）。trace 在 session 事件上記一個指向它的 `evidence.ref` 即可。它同時是本設計的形式範本：`createNotificationTelemetryRecorder`（`sim/notificationTelemetry.ts:167`）的 partial application 寫法直接沿用。

## 事件語意

15 個事件，分五組。每一個都有出處，不是憑空分類。

| 事件 | 語意 | 出處 |
| --- | --- | --- |
| `run.started` / `run.ended` | 一個 coordinator tick 或一場 sim 的邊界 | `state.ts:665` `beginTick` / `state.ts:680` `endTick`；`run.ts:1682` `bootstrap` |
| `session.started` / `session.ended` | 一次 AI 呼叫。`session_id` 由此產生 | `runner.ts:287/305` `createMemberSessionRunner`/`createOwnerSessionRunner`；`run.ts:2002` `runSessionAttempt` |
| `task.phase_changed` | task 狀態轉移，帶 `from`/`to` | `state.ts:37-40` `task_runs.phase` CHECK 的 8 個值 |
| `task.attempted` | 成員嘗試一次，含 evidence 是否變化 | `policy.ts:239` `recordMemberAttempt` |
| `action.started` / `action.ended` | 一個具冪等 key 的 mutation 起訖 | `state.ts:324/336/351` `beginAction`/`completeAction`/`failAction` |
| `ci.checked` | tsc / test 檢查結果 | `state.ts:377` `storeCiRun`；`run.ts:2680` `verifyBranches` |
| `commit.recorded` | 代 commit 成功或因未允許檔案被拒 | `run.ts:2550` `commitMemberWork` |
| `merge.integrated` | 分支併入 master | `production.ts` 整合流程 |
| `completion.confirmed` | readback 確認完成三要件成立 | `completion.ts:153` `postCompletionAndTransitionToDone` |
| `notify.sent` | 完成通知送出 | `state.ts:450+` completion outbox / batch |
| `escalation.raised` | `[ESCALATE]`：owner 解不了、需上層處理 | `run.ts:2527` |
| `gate.skipped` | notification gate 未過，略過一般 session | `run.ts:1875/2801` |

### 為什麼是一個 `task.phase_changed` 而不是七個事件

`task_runs.phase` 有 8 個狀態、7 條主要邊。若每條邊一個事件，DB CHECK 改動時要同步改 trace enum，必然漂移。改用單一事件加 `from`/`to` 欄位，值域直接引用 phase 型別，無法脫鉤。

### 為什麼 coordinator 的 9 種失敗不進 enum

`coordinator.ts:202-210` 已有 `fatal_blocked` / `branch_ci_failed` / `integration_conflict` / `integration_command_failed` / `task_specific_acceptance_failed` / `deploy_precondition_failed` / `deployed` / `deploy_indeterminate` / `deploy_failed_post_merge` 的 discriminated union。這些是**結果**不是**事件類別**，放進 `reason` 欄位，值域沿用該 union。新增一種失敗時不需要動 trace enum（OCP）。同理，`action_log.kind` 的實際值（`assign`、`status`、`dispatch_notice`、`human_blocked_notice`、`fatal_error`、`reject`、`deployment_rollback_notice`、`main_discussion_conclusion`、`done`、`comment_failed`、`patch_failed`）也走 `reason`。

## 記錄格式

JSONL，一行一事件，寫入 `sim-logs/trace/<run_id>.jsonl`。

選 JSONL 不選 JSON array：append-only、可 `tail -f`、壞一行不毀整檔。這是 log 的既定規範，也與 `notificationTelemetry` 落盤方式一致。

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `ts` | string | ISO 8601 UTC。沿用 `notificationTelemetry` 的 `assertTimestamp` 慣例 |
| `event` | `TraceEvent` | 上表 15 個之一 |
| `run_id` | string | coordinator 的 `tick_id`，或一場 sim 的 tag |
| `round` | number \| null | 成員第幾輪 |
| `session_id` | string \| null | AI session 的 logFile basename（見下） |
| `task_id` | string \| null | |
| `source` | string | `阿凱/claude-opus-5`、`coordinator`、`owner` |
| `outcome` | `'ok' \| 'fail' \| 'skip' \| 'refused'` | |
| `reason` | string \| null | 值域為既有 union，見上節 |
| `evidence` | `{ kind, ref }` \| null | **必填欄位、值可為 null** |
| `detail` | string | 現在那句人話原封不動 |

`evidence.kind`：`'tsc' | 'test' | 'readback' | 'git' | 'http' | 'log'`。`ref` 是 sha、logFile 路徑或 URL——只記類型與指標，全文留在原處。

### session_id 的粒度

`session_id` = **一次 AI 呼叫**，直接取 `runner.ts:88` 既有產生的 `<ISO>-<label>.log` 的 basename。不發新 ID，順手把現有 8199 個純文字 transcript 與 trace 綁在一起，transcript 格式不用改。「這輪重試了幾次」由另一個 `round` 欄位承載，兩種粒度都拿得到。

### 欄位命名

落盤一律 snake_case，對齊 `notificationTelemetry` 與 DB 欄位。`sim/run.ts` 內部維持 camelCase，在 `buildTraceRecord` 邊界轉換。落盤格式的一致性優先於程式內慣例。

## 模組設計

`sim/trace.ts`，約 40 行，三個角色：

```ts
export type TraceEvent = 'run.started' | 'run.ended' | 'session.started' | /* … */;
export type TraceSink = (record: TraceRecord) => void;

interface TraceBase { run_id: string; session_id: string | null; task_id: string | null; source: string; round: number | null }

function buildTraceRecord(base: TraceBase, event: TraceEvent, fields: TraceFields, now: Date): TraceRecord;  // 純函式
function formatTraceRecord(r: TraceRecord): string;                                                          // 人話那行
function defaultSink(r: TraceRecord): void;                                                                  // 寫檔 + console.log

export function createTracer(base: TraceBase, sink: TraceSink = defaultSink): Tracer;
```

export 面積只有 `createTracer` 與型別；`buildTraceRecord` / `formatTraceRecord` / `defaultSink` 為 internal，測試透過 memory sink 驗證。

### SOLID 對照

| 原則 | 本設計採取的具體形式 | 明確不做 |
| --- | --- | --- |
| SRP | 建事件 / 格式化 / 寫出，三個函式分離。純函式讓測試不必碰 fs | 不為此拆成三個檔案 |
| OCP | 事件用 discriminated union（沿用 `coordinator.ts:202` 同一寫法）；`reason` 承載可擴充值域 | 不用 Strategy / Visitor 分派 |
| LSP | 不適用，無繼承 | 不硬套 |
| ISP | export 面積最小化。呼叫端只認識 `createTracer` | 不定義 `TraceSink` class 階層 |
| DIP | `sink` 以參數注入，型別是 function type | **不定義 `interface TraceSink { write() }` + `FileTraceSink`/`MemoryTraceSink` 兩個 class** |

DIP 這一條與 repo 既有慣例完全一致：`sim/production.ts:211` 的 `GatherSnapshotDeps` 已經在注入 `db` / `now()` / client，`sim/production.ts:315` 更用 `Pick<TaskTrackerClient, 'listComments' | …>` 收窄介面——ISP 與 DIP 在這個 codebase 是既成事實，trace 只是多掛一個 `deps.trace`，不是新引入的架構。

### 設計模式

只用兩個，都是語言原生形式：

- **Discriminated union** 取代 Visitor / Strategy 分派。
- **Partial application** 取代 Factory / Builder：`createTracer(base)` 回傳綁好 `run_id` / `session_id` / `source` 的函式，即 child logger。

明確不做：Observer（沒有第二個訂閱者）、Decorator（沒有要疊行為）、Singleton（module 本身就是）、Repository（一個 append 而已）。

### 型別層面的強制

`evidence` 設為**必填但可為 `null`**，逼呼叫端明確寫 `evidence: null` 而非省略。型別層強制表態，零機制成本。

## 掛載點

全部落在編排層。`sim/production/state.ts` 與 `sim/production/policy.ts` 保持純粹，不放任何 trace 呼叫。

| 檔案 | 位置 | 送出事件 |
| --- | --- | --- |
| `sim/production.ts` | `:689` `beginTick` 呼叫處 | `run.started` |
| `sim/production.ts` | tick 結束處 | `run.ended` |
| `sim/production.ts` | `:883/:977/:1132/:1170/:1244/:1327/:1365` 等 `upsertTaskCheckpoint` 呼叫處 | `task.phase_changed` |
| `sim/production.ts` | `:946/:961/:1032/:1102/:1287/:1312/:1417/:1462` 等 `beginAction` 呼叫處 | `action.started` / `action.ended` |
| `sim/production/completion.ts` | `:153` `postCompletionAndTransitionToDone` | `completion.confirmed`、`notify.sent` |
| `sim/production/runner.ts` | `:287/:305` 兩個 session runner | `session.started` / `session.ended` |
| `sim/run.ts` | `:2002` `runSessionAttempt` | `session.started` / `session.ended` |
| `sim/run.ts` | `:2550` `commitMemberWork` | `commit.recorded` |
| `sim/run.ts` | `:2680` `verifyBranches` | `ci.checked` |
| `sim/run.ts` | `:1866` `runActorSessionWithNotificationGate` | `gate.skipped` |

## 落地階段

| 階段 | 內容 | 完成判準 |
| --- | --- | --- |
| 0 | 確認本文 15 個事件與出處無誤 | 人工過目 |
| 1 | `sim/trace.ts` + `assert` 自檢 | `npm run typecheck` 過、自檢通過 |
| 2 | 掛 `sim/production.ts` 與 `completion.ts` | 一次 tick 產出 `sim-logs/trace/<tick_id>.jsonl`，可 `jq` 查詢 |
| 3 | 掛 `sim/run.ts` 四處 | 一場 sim 的 trace 完整 |
| 4 | 既有 `console.log` 改由 `formatTraceRecord` 產生同樣人話 | 終端輸出與改動前逐字一致 |

階段 4 的驗證方式：改動前後各跑一次同樣場景，`diff` 兩份終端輸出。**終端輸出零變化是硬性要求**——人看不出差別，機器多一份可查的。

## 已知細節與待確認

- **`upsertTaskCheckpoint` 是 upsert，不知道舊 phase**（`state.ts:179`）。要送出 `task.phase_changed` 的 `from`，呼叫端必須先 `getTaskRun` 取值。這是把 trace 掛在編排層而非資料層的另一個理由——編排層本來就持有前後兩個狀態。
- **`merge.integrated` 的出處尚未定位到具體行號**，只確認流程在 `sim/production.ts` 內。階段 2 實作時補上。
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
