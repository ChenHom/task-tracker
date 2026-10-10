# Goal 驅動的多 Agent 協作與 Project 強化設計

## 狀態

已完成設計討論，等待使用者審閱。本文件只定義行為與邊界，不授權執行 live AI、啟用 timer、修改正式資料或清理既有 workspace／worktree。

## 問題

目前 task-tracker 已有 Workspace、Project、Task、RBAC、留言、附件、通知、Audit，以及 Claude／Codex／AGY 混合 sim 車隊、worktree、CI、Owner review、merge、部署與 health readback。然而協作目標、Agent 設定、執行成本與 session 狀態分散在 `sim/run.ts`、systemd、ai-quota snapshot、log 與文件中。

現行自主流程也常為一個短期主題建立新的 Workspace 或資料夾。少量 Task 完成後，Workspace 仍保有 Owner、Agent 或 user09 membership，無法直接封存；即使封存，現有 Workspace 列表仍會顯示 archived 項目。結果是短期執行容器長期占據主要導覽。

Project 現有 CRUD、Task 關聯、Kanban 篩選與 badge 可運作，但只有名稱欄位；前端把 Project 建立藏在篩選 select 中，Task 建立後不能更換 Project，後端也沒有驗證 `projectId` 是否存在且屬於同一 Workspace。Project 尚不足以承接長期工作主題與多個 Goal。

## 目標

- 人類或 Owner Agent 可以建立一個有成功條件的 Goal。
- Owner 依 Agent 能力與負載選擇 1–5 位參與者，不要求六位全員出席。
- 入選 Agent 在 Workspace 與 Project 指定 target repo 的既有資料下，完成兩輪協作。
- 每次模型執行前記錄 token 預估與 quota snapshot，執行後補實際用量；紀錄不阻擋執行。
- Owner 收斂後直接建立並派發 Task，沿用既有全自動 worktree、CI、review、merge、部署與 readback 流程。
- Claude、Codex、AGY 使用一致的 adapter 生命週期與結果契約，保留各 CLI 必要差異。
- 每個 Workspace 同時最多一個 Owner 自建的 active Goal；每 12 小時巡檢一次，Goal 完成後立即做一次後續評估。
- Workspace 成為長期容器，Project 成為長期工作主題，一個 Project 可承載多個 Goal。
- Owner Agent 不再自動建立 Workspace；archived Workspace／Project 預設不占主要列表空間。

## 非目標

- 不安裝或嵌入 Paperclip。
- 不建立第二套 Task、Git、CI、RBAC 或 Audit 真相來源。
- 不支援一個 Goal 同時修改多個 target repo。
- 不開放任意新增或刪除 Agent；第一版只正式化既有六位 AI 成員。
- 不新增 HTTP、MCP、Notion 或其他外部 connector。
- 不為訂閱制 CLI 假造單次金額，也不建立模型價格表。
- 不以預算作為 hard gate。
- 不自動刪除 target repo、含 dirty diff／未合併 commit 的 worktree 或既有歷史資料。
- 不改變主協作工作區既有討論規則；主協作討論只負責選定目標 Workspace／Project。
- 不在預設測試中呼叫真實 AI。

## 選定架構

```text
Workspace（長期團隊／產品容器）
└── Project（長期工作主題與單一 target repo）
    └── Goal（一次可驗收的目標，可有多個歷史 Goal）
        ├── Participation（Owner 選人與分工）
        ├── Contribution（兩輪分析與收斂）
        ├── Run／Heartbeat（預估、實際用量與執行狀態）
        └── Tasks（既有實作與交付流程）
```

task-tracker 是唯一事實來源。Goal orchestration 只負責目標、討論、派工與聚合交付證據；Task 建立後，既有 coordinator 繼續負責 worktree、commit、CI、Owner review、merge、部署及 readback。

## 資料模型與權威邊界

### Project

Project 保持傳統 CRUD，不改成 Event Sourcing。現有資料增加：

- `description`
- `status: active | archived`
- `target_repo`
- `created_at`
- `updated_at`

一個 Project 對應一個 target repo，可包含多個 Goal。既有 Project 可保留 `target_repo = null`，但設定完成前不得啟動任何 Goal。Project 有 active Goal 或 Todo／Doing／Review Task 時不可封存。

Project 不提供一般 UI 的 hard delete。封存不解除 Goal／Task 關聯。既有 DELETE API 在遷移期間保留相容性，但新 UI 不呼叫；移除前必須另開相容性任務與驗證既有 caller。

### Goal

Goal 使用 event store 保存權威歷史，read model 供查詢。必要欄位：

- `goal_id`
- `workspace_id`
- `project_id`
- `parent_goal_id | null`
- `source: human | owner_discovery | followup`
- `objective`
- `success_criteria`
- `status`
- `discussion_phase`
- `revision`
- `created_by`
- `owner_agent_id`
- `created_at / updated_at`

Goal 的 target repo 從 Project 取得。Project target repo 在 active Goal 期間不可變更。Goal revision 改變時保留舊成功條件與資料範圍的事件歷史。

### Agent

既有 user01–user06 的 AI 身分轉成正式 Agent resource，並連回現有 `user_id`。必要資料：

- 名稱、角色與 Capability Profile
- primary adapter／model
- fallback adapter／model
- 可存取 Workspace／repo
- `active | paused | error` 狀態
- 最近 Run、目前 Goal／Task 與累積 token

user09 是人類 Admin，不建立 Agent resource。第一版 UI 只允許暫停、恢復及修改既有 route，不提供新增／刪除 Agent。

### Participation 與 Contribution

Participation 記錄 Owner 選擇 Agent 的理由、分配的分析面向、選擇時負載與 Goal revision。討論和實作可重新選人，不要求同一批 Agent。

Contribution 是 immutable record，保存 round、Agent、結構化輸出、來源引用與建立時間。修正必須建立新 Goal revision 或新 Contribution，不覆寫歷史結果。

### Heartbeat 與 Run

每個 wakeup 先持久化，再啟動外部程序：

```text
pending -> running -> succeeded
                   -> failed
                   -> uncertain
```

Heartbeat 的冪等鍵為：

```text
goal_id + phase + agent_id + revision
```

每次 primary 或 fallback 是獨立 Run，並關聯同一 heartbeat。Run 至少保存：

- Goal／Task／Agent／phase
- adapter、model、primary 或 fallback
- 觸發事件與 session ID
- estimated input/output tokens、估算依據及可信度
- 執行前 quota snapshot
- actual input/output tokens，可為 `null`
- actual cost，可為 `null`
- started／ended timestamps
- outcome、error category 與 evidence reference

缺少 usage 不得寫成零。啟動後無法判定結果時寫 `unknown/uncertain`，交由 reconciliation 處理。

## Goal 狀態機

正常狀態：

```text
Queued -> Discussing -> Executing -> Verifying -> Done
```

例外狀態：

- `Paused`：人類 Goal 插隊或人工暫停。
- `Blocked`：Owner 與 fallback 無法繼續，需要人工處理。
- `Cancelled`：人類終止，不再產生 heartbeat。

`Discussing` 使用 `owner_scoping -> round_1 -> round_2 -> owner_synthesis` 子階段，不增加更多頂層狀態。

## 建立與選人

人類與 Owner 都能建立 Goal。人類建立時必須選擇既有 Workspace 與 active Project。主協作工作區的討論可以選定目標，但實際 Goal 建立在目標 Workspace／Project。

Owner discovery 先尋找既有 Project；只有確實沒有合適 Project 時才在同一 Workspace 建立 Project。Owner 不得建立 Workspace。child Goal 預設沿用父 Goal 的 Project。

系統先排除 paused/error Agent、無 Workspace／repo 權限者、Capability 完全不符者及已有不可並行工作的 Agent。Owner 再從合格名單選擇 1–5 位，保存選擇理由與分工。

## 兩輪協作

### Owner scoping

Owner 讀取 Goal、成功條件、Workspace 與 Project target repo，選人並為每位 Agent 指定不同分析面向。沒有選中的 Agent 不收到 heartbeat，也不產生 Run。

### Round 1：平行獨立分析

每位入選 Agent 只看到 Goal、自己的題目、允許資料與輸出契約，不能看到其他 Agent 的本輪輸出。全部完成或明確失敗後封存 round 1 集合。

### Round 2：交叉審查

每位 Agent 看到 round 1 的結構化摘要、來源與衝突觀點，輸出限於：

- 同意並附理由
- 疑慮並指出證據
- 修正並提出可替代方案

只回覆「收到」「了解」或重述內容不算有效 Contribution。

### Owner synthesis

Owner 產生最終判斷、採納／拒絕理由、實作 Task、依賴、修改範圍、驗收條件、不確定性與 rollback 條件。同一 transaction 建立 Task、寫入 `goal_id` 並指派實作 Agent，Goal 進入 `Executing`。

## user09 與一般留言

user09 使用自由格式，不受 Agent Contribution schema 約束，也不計入 round 完成數。

- 明確 `@Owner`：建立一次立即 Owner heartbeat。
- 沒有 `@Owner`：不建立 heartbeat，不特別啟動任何 Agent。
- 已因其他工作啟動的相關 Agent 若讀到留言，可依工作相關性、新增價值與 token 用量自行決定是否回覆。
- 不要求每位 Agent 回覆；保持沉默是合法結果。
- Agent 不得只回 no-op，也不得因自己的回覆再次喚醒自己。
- 留言在 context 建立後才出現時不中斷當前 Run。
- Owner 在正常 discovery、收斂或巡檢時讀取並判斷是否回覆。

## Context 與資料邊界

每個 Goal 只可讀：

```text
Goal 所屬 Workspace
+
Project 指定的單一 target repo
```

每次 Run 保存實際納入 context 的來源引用，不複製整份 repo 至資料庫。Context builder 套用既有 NFC、control/bidi、credential 與 private URL/IP 消毒，限制逐欄及總長度，並明示省略內容。

repo 內容一律視為不可信資料。路徑先經 realpath／allowlist 檢查；文件內指令不得擴張 Workspace、repo、外網或工具權限。討論階段不提供 shell、Git write、cookie 或 task-tracker mutation 工具。

## Adapter 契約

三種 runner 共用相同生命週期，不強迫使用相同 CLI 參數：

```text
preflight
-> estimate
-> 持久化 Run
-> invoke
-> normalize result
-> 驗證實際產物
-> 補 actual usage
-> 必要時 fallback
```

共同介面：

```ts
interface AgentAdapter {
  preflight(input): AdapterReadiness;
  estimate(input): UsageEstimate;
  run(input): AgentRunResult;
}
```

`preflight()` 不啟動 AI，只檢查 CLI、route 設定、cwd、資料範圍與本階段所需工具。不得讀出或記錄 credential 內容。

討論階段由 coordinator 組裝 bounded context，Agent 只回傳 Contribution；coordinator 驗證後寫入 task-tracker。Agent 不登入 task-tracker、不持有 cookie，也不用 curl PATCH／POST 狀態。

實作階段保留 runner 差異：Claude 使用 prompt/tool allowlist，Codex 使用 `exec`、cwd 與 sandbox，AGY 使用自己的 `--model ... --mode accept-edits --print <prompt>` 及 permissions 設定。三者回傳相同的 output、session ID、usage、exit status、error category 與 side-effect state。

成功不能只看 exit code：討論必須有通過 schema 的 Contribution；實作必須有符合 Task 範圍的 worktree 結果與完成報告。AGY `exit 0`、空 stdout 且 `no output produced` 必須分類為 permission failure。不得加入 `--dangerously-skip-permissions`。

## Fallback 與故障恢復

每個 Run 最多一次 fallback。以下情況可自動 fallback：

- preflight 失敗
- quota 或啟動失敗
- 討論階段沒有有效輸出
- 已證明沒有任何副作用的 runner failure

以下情況不可直接 fallback：

- Agent 可能已修改 worktree
- API mutation 結果未知
- timeout 後無法證明沒有留下檔案

這些進入 Owner reconciliation。Owner 必須改變範圍、資料、assignee 或處理方式並增加 revision；沒有實質變更不得原樣重跑。Owner primary 與 fallback 都失敗時，Goal 進入 `Blocked` 並通知人類。

AGY permission 失敗不使用另一個 AGY model 重試；應改用不同 adapter，或由 Owner 修正 capability 後建立新 revision。

程序崩潰後，`pending` heartbeat 可重新領取；lease 過期的 `running` 先 reconciliation。已有外部副作用但結果不明時標記 `uncertain`，不能直接重跑。

## 預算與用量

每次執行順序固定為：

1. 估算 input/output token。
2. 讀取並保存當時 ai-quota snapshot。
3. 將 Run 寫入資料庫。
4. 啟動模型。
5. 結束後補 actual usage。

估算與 quota 只記錄、不要求批准、不阻止執行。只有 adapter 提供可信 billing 資料時才寫金額。Goal 總計包含 discovery、成功、失敗、primary 與 fallback Run。

## 自動實作與交付

Owner synthesis 建立 Task 後沿用現有流程：

```text
task.assigned
-> worktree session
-> driver commit
-> CI
-> Owner review
-> merge
-> deploy
-> health/live readback
```

Coordinator 回送 `task.execution_started`、`commit.recorded`、`ci.checked`、`merge.integrated`、`deployment.verified` 與 `task.blocked` 等權威事件。Goal 只聚合結果，不重做 Git 或 CI。

所有必要 Task 為 Done，且部署版本與成功條件都通過後，Goal 才進入 Done。純文件或不需部署的 Task 必須明確標示 `deployment_not_required`，不能默認略過。

## 固定巡檢與持續自治

Owner discovery timer 每 12 小時觸發一次。Timer 先機械檢查：

- 是否已有 active 自治 Goal
- 是否有人類 Goal 正在執行
- 前一次 discovery 是否仍在執行
- Workspace／repo 是否有新資料

前三項任一成立即記錄 `skipped`，不啟動模型。沒有新 Task／Comment／Attachment、BUG、部署異常、commit、測試失敗或候選證據變化時，也不啟動 Owner。

同一 Workspace 同時最多一個 Owner 自建的 active Goal。人類 Goal 優先：尚未啟動的自治 Goal 回到 Queued；執行中的自治 Goal 在下一個安全 checkpoint 進入 Paused，不中止正在寫入的 transaction 或 worktree 操作。

同一 target repo 同時最多一個 Goal 可處於 `Executing` 或 `Verifying`，不論 Goal 由人類或 Owner 建立。其他 Goal 可完成討論，但在取得 repo execution lease 前停在 synthesis 後的等待點；人類 Goal 只取得下一個安全 checkpoint 的優先權，不強制中斷進行中的寫入、merge 或部署。

`goal.completed` 立即觸發一次 follow-up evaluation。Owner 只能選擇：結束、保存候選，或建立一個 child Goal。Child 必須有 `parent_goal_id`、增量證據、不同成功條件及另開 Goal 的理由；相同 Workspace、Project、成功條件與證據指紋不得重複建立。

Blocked、Cancelled 或驗收失敗的 Goal 不觸發持續自治。

## Workspace、Project 與資料夾生命週期

### Workspace

Owner Agent 永遠不能建立 Workspace。新產品或隔離空間只能由人類明確建立。一般 Goal 必須選擇既有 Workspace。

Workspace 頁預設只顯示 active 項目，提供「顯示已封存」切換；sidebar 排除 archived/deleted。Archived Workspace 仍可從 Audit、Goal 歷史或切換開關找到。

如果歷史上已有 Goal-owned Workspace，退場必須依序：

1. 確認沒有 active Goal。
2. 確認沒有 Todo／Doing／Review Task。
3. 確認沒有 dirty worktree 或未合併 commit。
4. 經正式 member API 移除 Agent 與 user09 membership。
5. 保留唯一 Owner。
6. 呼叫既有 archive API。
7. 回讀 `workspace.archived` 事件與 projection。

任一步驟不符即標記 `retirement_blocked`，不得直接修改 read model 或強制刪除。最後 Owner 不需移除；保留 Owner 是歷史與授權鏈的一部分。

既有閒置 Workspace 清理由獨立操作任務處理，先唯讀分類，再經正式 API 封存；本功能不在 migration 中批次改動正式 Workspace。

### Project

Project 是 Goal 的長期容器。Owner 可以在既有 Workspace 建 Project，但建立前先比對現有 Project 的名稱、描述與 target repo，避免重複。

Project 完成某個 Goal 後仍保持 active，可承載後續 Goal。只有沒有 active Goal、沒有未完成 Task、沒有未處理執行資源時才可封存。Archived Project 預設從 selector 隱藏，但歷史 Goal／Task 仍顯示原 Project。

### Worktree／資料夾

Goal 建立的 worktree 或暫存資料夾必須登記 `goal_id`、target repo、`temporary | persistent`、dirty／unmerged 狀態與 cleanup status。

target repo 永不自動刪除。Dirty、未合併或結果不確定的 worktree 標記 `cleanup_blocked` 並保留。已合併、乾淨且建立時已標記 temporary 的 worktree 可進待清理清單；實際清理必須依另行核准的操作政策執行，不能只因 Goal Done 就刪除。

## UI

### Project switcher 與管理

Workspace 頂部的 Project 從單純篩選提升為明確上下文：

- 顯示名稱、描述、target repo、active Goal 與進度。
- 保留「所有專案」及「無專案」處理總覽與 legacy Task。
- Archived Project 預設隱藏，可切換顯示。
- Project 多時可搜尋，支援滑鼠、觸控與鍵盤。
- 建立使用正式 dialog，不再使用原生 `prompt()`。
- 可編輯名稱、描述、target repo，並可在符合條件時封存。

建立 Task 時明確顯示 Project，預設目前選取的 Project。Task detail 可以切換同 Workspace 的 active Project 或設為無 Project。後端必須驗證 Project 存在、active 且屬於同一 Workspace；Task 搬移 Workspace 時沿用現行清空 Project 的行為。

### Goals

Goals 列表顯示目標、來源、Project、狀態、phase、Owner、參與 Agent、token 與最近事件。Goal 詳情顯示成功條件、父子關係、選人理由、兩輪 Contribution、Owner synthesis、Tasks、Run，以及 commit、CI、merge、deployment evidence。

人類可建立、暫停、恢復、取消 Goal，或以 `@Owner` 留言。修改成功條件或資料範圍會建立新 revision。

### Agents

Agents 頁顯示六位 Agent 的 Capability、primary／fallback route、狀態、目前 Goal／Task、最近 preflight／Run、累積 token、fallback 次數與未知 usage 次數。

## 安全與權限

- Workspace、Project、Goal、Task 的寫入都經既有 `requirePermission` 邊界。
- Project／Goal route 必須驗證資源確實屬於 URL 所指 Workspace。
- Task 的 `projectId` 必須存在、active 且同 Workspace。
- Discussion adapter 不持有 session cookie 或 mutation tool。
- Agent 不能因 repo 內容或留言擴張 Workspace、repo、外網或工具權限。
- Adapter log、Run 與 telemetry 不保存 credential、cookie 或完整 private context。
- user09 保持人類 Admin，不被 scheduler 當成 Agent。
- Archive 優先於 delete，保留歷史與 evidence。

## 測試策略

### Domain

- Project 欄位、同 Workspace 驗證、封存守門與 archived 隱藏。
- Task 建立／修改 Project 及跨 Workspace 拒絕。
- Project 一對多 Goal。
- Goal 合法狀態轉移、兩輪封存順序與 revision。
- 單一自治 Goal、人類插隊與 child 去重。
- 同一 target repo 的 execution lease 排他性與安全交接。
- user09 無 mention 不喚醒；`@Owner` 只喚醒一次。
- Run estimate 必須早於外部程序啟動。

### Adapter fixtures

- Claude／Codex／AGY command、cwd、preflight 與 token estimate。
- exit code、stderr、空輸出、timeout 與 quota 分類。
- AGY `no output produced` 判定 permission failure。
- 不確定副作用不自動 fallback。
- 有效 Contribution／實作產物才算成功。

### 整合

使用 fake adapters 與暫存 Git repo 驗證：

```text
Project -> Goal -> 兩輪討論 -> Owner synthesis -> Task
-> worktree -> CI -> merge -> deployment fixture -> Goal Done
```

在每個 checkpoint 模擬程序崩潰，證明不重複建立 Contribution、Task、commit 或 child Goal。

### 前端與 live smoke

- Project 建立、搜尋、選擇、記憶、Task 關聯修改與封存顯示。
- Goals／Agents 桌面、觸控及鍵盤操作。
- 正式 service health 與部署 revision readback。
- AGY 討論與 coding 各一次真實 smoke。
- primary 失敗後只 fallback 一次。
- Goal 完成後只產生一次 follow-up evaluation。
- 最後才啟用 12 小時 discovery timer。

Live smoke 不納入預設 `npm test`，必須取得明確 AI／timer 授權。

## 分階段交付

1. 強化 Project schema、後端守門、Task 關聯與 selector／管理 UI。
2. 建立 Goal、Agent、Participation、Contribution、Heartbeat、Run 資料模型與只讀 API。
3. 統一 Claude／Codex／AGY adapter lifecycle、preflight、estimate 與 fixture tests。
4. 交付人工 Goal 與兩輪討論，暫不建立實作 Task。
5. 接上既有全自動 worktree、CI、merge、deploy 與 readback。
6. 交付 Goals／Agents UI。
7. 啟用 Goal 完成後的 follow-up evaluation 與單一 child Goal。
8. 安裝每 12 小時 discovery timer；預設 disabled，完成 live smoke 後才另行授權啟用。
9. 另開唯讀盤點與正式 API 操作任務，整理既有閒置 Workspace；不與功能 migration 混在一起。

每階段都必須有直接相關測試、TypeScript check、整體 gate 與交付證據，能獨立停止或回退。不得為了後續階段預先加入未使用的 abstraction、connector 或設定。

## 驗收摘要

- 人類或 Owner 建立的 Goal 都落在既有 Workspace 的 active Project。
- Owner Agent 無法建立 Workspace。
- 一個 Project 可依序保存多個 Goal 與完整歷史。
- Owner 按能力選擇 1–5 位 Agent，完成兩輪協作後自動建立 Task。
- 每個 Run 在啟動前已有 token estimate 與 quota snapshot。
- AGY 經共同 adapter lifecycle 執行，permission soft-deny 不再被當成功。
- user09 無 `@Owner` 留言不喚醒 Agent，但已啟動的相關 Agent 可選擇補充。
- Task 經既有 CI、review、merge、部署與 readback 才能完成 Goal。
- 同一 Workspace 最多一個 active 自治 Goal，每 12 小時巡檢一次，完成後只評估一個 child Goal。
- 同一 target repo 最多一個 Goal 進入實作／驗證，並在安全 checkpoint 交接優先權。
- Archived Workspace／Project 預設不占主要列表；歷史仍可查。
