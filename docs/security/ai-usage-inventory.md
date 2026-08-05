# task-tracker AI 使用清冊與透明告知基線

更新日期：2026-08-05

這是一份第一輪、範圍受限的盤點。目的只在把現有 AI sweep / agent 協作流程的責任、審核點、輸出與證據位置寫清楚，方便 owner 回查；它不是法律意見，也不是新的治理平台或 runtime gate。

## 範圍

- 納入：有固定 owner、固定輸出去向，且會影響 task、comment、commit、review packet、通知 readback 或後續決策的工作流。
- 排除：純個人 prompt、離線測試、一次性實驗、未發布草稿、與 AI 無關的手工操作。
- 現況：活躍流程主要來自 [`sim/run.ts`](../../sim/run.ts)、[`sim/notificationTelemetry.ts`](../../sim/notificationTelemetry.ts)、[`docs/operations.md`](../operations.md) 與 [`docs/owner-sweep-guide.md`](../owner-sweep-guide.md)。[`sim/production.ts`](../../sim/production.ts) 已有程式碼但尚未啟用，這版先不列為活躍 AI 供應鏈。

## 盤點摘要

| Workflow | 是否 AI | Owner | 主要輸出 | 證據位置 |
| --- | --- | --- | --- | --- |
| Legacy sim sweep / agent 協作 | 是 | `user01@test.local` | task comments、commit、`report.md` / `report.json`、prompt artifacts、review packets | `sim-logs/`、`data/dev.db`、git history |
| Notification preflight gate | 否，只有前置門檻 | 依 sweep actor 而定 | notification read / unread state、遙測、log | `sim-logs/notification-preflight/`、`data/dev.db` |
| Production coordinator | 否，尚未啟用 | n/a | n/a | 只有 code，沒有啟用中的 runtime 證據 |

## 1. Legacy sim sweep / agent 協作工作流

### 用途

- `sim/run.ts` 的 owner / team sweep 會 bootstrap workspace、跑 member session、做 owner review、寫回 task / comment / status，必要時 merge / repair。
- 主工作區討論收尾也走同一個 owner 流程：先讀 comments，再留下 `【OWNER想法】`，最後依證據收斂成 `【結論】`、`【結論：不實作】` 或 `【未達共識】`。
- 目前 runner 配置由 `sim/run.ts` 的 `MEMBER_RUNNERS` 決定，涵蓋 Claude、Codex、Agy 與其 fallback / notification route。

### 受眾 / 受影響者

- `task-tracker` 內部協作者、workspace owner、後續接手的 member。
- 輸出會直接影響看板狀態、留言、commit 與 DB projection。

### 供應商 / deployer

- 實際執行由本 repo 的 sim harness 與 user-level timer / 手動 sweep 負責。
- 供應商與 deployer 的法規角色先標記為 `需法律確認`，本文件不自我宣稱合規。

### 人類審核點

- Owner 先看 task / discussion comments，再決定派工、收斂、退回或封存。
- member session 完成後，driver 先做 `npx tsc --noEmit`、相關 test、branch diff 與 `review-packets/*.md` 驗證，再把結果交給 owner。
- owner 的最終判斷落在 task comments、review packet、commit history 與 `report.md`，不是只看 AI 自述。

### 資料類型

- task titles / descriptions / comments
- branch diffs / commit messages
- prompt text
- review packet content
- command output
- DB event / read model data

### 輸出與證據位置

- `sim-logs/<run>/report.json`
- `sim-logs/<run>/report.md`
- `sim-logs/<run>/prompts/*.md`
- `sim-logs/<run>/review-packets/*.md`
- `sim-logs/sweep-owner-cron-*.log`
- `sim-logs/sweep-team-cron-*.log`
- git commits / branch history
- `data/dev.db` 的 comments、events、tasks read model

### 輸出使用地區

- 目前僅在本機 / 內部工作區與 task-tracker DB 內流轉，未宣告對外發布地區。
- 若未來要把這些輸出改成對外發布、公開文件或 EU 使用內容，必須先重做法律與業務情境確認。

### 最終發布責任

- 內部看板與 task 內容由 owner / driver 負責。
- 若要對外發佈，需先補上發布核准與版本封存流程；目前本地 workflow 只保留 task、commit 與 log evidence。

### 告知方式

- 目前以 task comments、owner dispatch 註記、review packet 與 [`docs/operations.md`](../operations.md) / [`docs/owner-sweep-guide.md`](../owner-sweep-guide.md) 的說明為主。
- 不另建治理平台，也不把模型輸出當成唯一告知來源。

## 2. Notification preflight gate

### 用途

- 這是 sweep 的前置門檻，不是新的模型工作流。
- 現行程式已把 notification preflight 收斂成 API / readback 流程；它不啟動新的模型 session，主要用途是確認未讀通知、必要回覆與 read state。

### 受眾 / 受影響者

- 參與 sweep 的個別 actor（目前涵蓋 user01 與 user02-user06 的配置）。
- 會影響該 actor 是否能進入後續一般工作 session。

### 供應商 / deployer

- 目前沒有模型產生內容；`sim/notificationTelemetry.ts` 只記錄 login / preflight 的嘗試與統計。
- 如果未來重新接回模型，provider / deployer 角色與資料可否跨地區使用要重新確認。

### 人類審核點

- driver 驗證 notification snapshot、reply / readback 與 read state。
- 主工作區通知要求固定回覆 `已閱讀，目前無補充。`，再由 driver readback。
- 一般 workspace 通知只需確認來源可讀與已讀，不進模型 session。

### 資料類型

- notification ids、task ids、comment ids、read state
- login / preflight 事件統計
- route / runner metadata（只作遙測，不是輸出內容）

### 輸出與證據位置

- `sim-logs/notification-preflight/runs/*.jsonl`
- `sim-logs/notification-preflight/aggregates/*.json`
- sweep / cron logs 內的 notification gate 記錄
- `data/dev.db` 的 notification read state 與 comments
- `sim/run.test.ts` 的 gate / telemetry regression coverage

### 輸出使用地區

- 目前只在內部與本機流轉，不對外發布。
- 若未來把 gate 重新改回模型驅動，或把輸出送入對外使用情境，需重新確認地區與保存規則。

### 最終發布責任

- 通知讀寫與 readback 由 driver / owner 流程負責。
- 若未來把 gate 再改回模型驅動，需先補 human review 與法務確認。

### 告知方式

- 在 sweep logs 與 task comments 中保留「預檢已完成 / 已讀」或「略過一般 session」等狀態。
- 不把 notification gate 假裝成獨立 AI workstream；它只是現行 sweep 的一個控制點。

## 3. 目前未納入正式清冊的項目

- `sim/production.ts` 與 `deploy/sim-coordinator.*`：程式已存在，但目前尚未啟用，這版先不當成活躍 AI 供應鏈。
- 純個人 prompt、離線驗證、一次性實驗、未發布草稿：不列入。
- `npm run sim` 與 live sweep：需要另行授權，不作為常態清冊內容。
- 僅供內部排程或維運的非 AI 記錄：如果不會影響 task / comment / commit / review / 對外內容，就不列入這份清冊。

## 需法律確認的問題

- `Claude` / `Codex` / `Agy` 在這裡到底算 provider、deployer，還是兩者都算？這份清冊先標 `需法律確認`。
- 內部 task comments、review packets、prompt artifacts、telemetry 的保存期間與可見範圍是否需要區分？
- 如果這些輸出未來要進入對外文件、公開頁面或 EU 使用場景，是否需要額外告知、審核或刪除規則？
- 目前的單一人工審核點，是否足以涵蓋會影響個人或決策的輸出？

## owner 回查路徑

- [`docs/operations.md`](../operations.md)
- [`docs/owner-sweep-guide.md`](../owner-sweep-guide.md)
- [`sim/run.ts`](../../sim/run.ts)
- [`sim/notificationTelemetry.ts`](../../sim/notificationTelemetry.ts)
- [`sim-logs/`](../../sim-logs/)
- [`data/dev.db`](../../data/dev.db)
