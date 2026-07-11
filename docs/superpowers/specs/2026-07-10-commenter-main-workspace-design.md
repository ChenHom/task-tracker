# Commenter 與主工作區討論治理設計

**日期：** 2026-07-10

**狀態：** 設計已確認，待實作（現況基準：`4902e287393f48b7fe13f8a0187bda009a2f7b86`）

**主工作區：** `11a82028-fc50-466a-a723-e002032cd9a6`（上線時改名為：主協作工作區）
**流程負責人：** `user01@test.local`

## 背景

目前 workspace 角色只有 `Viewer / Member / Admin / Owner`：

- `Viewer` 可讀，但不能建立 task 或留言。
- `Member` 一旦能留言，也同時能修改 task、轉換狀態、操作 project 與附件。

因此系統無法表達「可建立討論與留言，但不可推進工作流程」的使用者。主工作區目前也只有 user01 與 user09 是成員，且 sweep 只把 user09 的特定 `[討論]` 留言視為 owner 工作，無法承載所有 user 的討論入口。

## 現況基準（2026-07-11）

- `4902e28` 已在 `sim/run.ts` 實作 `CANONICAL_WORKSPACE_BY_REPOROOT`、`canonicalWorkspaceForRepoRoot()`、canonical sweep 候選與 `[CROSS-REPO]` prompt；詳見 `docs/superpowers/plans/2026-07-10-crossrepo-workspace-routing.md`。
- canonical registry 目前只登記 task-tracker repo：`/home/hom/code/task-tracker` → workspace `d9da9945-ce5f-400f-806e-1d75e95e313a`；brain repo 未登記。
- Commenter、主工作區名稱／成員／規則 task 同步、`task.discussion_started`、前端權限控制及 main-workspace sweep 尚未實作。
- `data/dev.db` 目前有 30 users，但主工作區只有 user01=Owner、user09=Member；名稱仍是 `Owner→阿哲 收件匣`。
- 主工作區目前有兩個 legacy Todo：`de228444`（workspace的封存功能）與 `1f369e88`（工作區裡統一使用+8時區的時間）。兩者預設欄位已是 Medium／未指派／無 project／無 due date，但 title 沒有 `[討論]`；若不 backfill，sweep 會誤判為實作工作。
- `npm test` 已在此基準通過；它驗證現有系統與 canonical routing，不能當成本設計已完成的證據。
- isolated worktree `feature/commenter-main-workspace` 仍停在 `90d5823`，實作前須先 fast-forward 到包含 `4902e28` 的最新 `master`。

## 目標

1. 新增通用 `Commenter` 角色，讓討論權與實作權分離。
2. 所有內部 user 都能看見主工作區、建立討論 task、留言及管理自己的留言。
3. 主工作區只有 user01 可以改變 task 狀態。
4. user01 開始討論時，系統把 task 原子地轉為 Doing 並指派給 user01。
5. 討論確立後，user01 在目標 workspace 建立實作 task，回寫連結，再把原討論 task 標為 Done。
6. 所有 UI 使用者與 AI agent 都能看見並遵循相同規則。
7. 既有主工作區普通 task 也要轉成 `[討論]` 格式，不能只限制新建 task。

## 非目標

- 不新增 capability/permission 資料表。
- 不新增 handoff API 或 discussion-to-implementation 關聯資料表。
- 不把原討論 task 搬到實作 workspace。
- 不在後端解析留言文字來判斷 Done 前是否已貼交接連結。
- 不修改 Phase 13 的 `moveTask` 範圍。
- 不新增第二套 canonical workspace registry；SIM 直接重用 `4902e28` 的 code-based registry。
- 不把 canonical routing 誤當成真正的 task move；目前仍是「在正確 workspace 建新 task + 原討論回貼連結」。

## 角色模型

角色階層改為：

```text
Viewer < Commenter < Member < Admin < Owner
```

| 能力 | Viewer | Commenter | Member | Admin | Owner |
|---|---:|---:|---:|---:|---:|
| 列出 workspace 內容 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 讀取 task／留言／附件／搜尋 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 建立 Todo task |  | ✓ | ✓ | ✓ | ✓ |
| 建立留言 |  | ✓ | ✓ | ✓ | ✓ |
| 修改／刪除自己的留言 |  | ✓ | ✓ | ✓ | ✓ |
| 修改 task 欄位或狀態 |  |  | ✓ | ✓ | ✓ |
| 刪除／封存 task |  |  | ✓ | ✓ | ✓ |
| 建立／修改／刪除 project |  |  | ✓ | ✓ | ✓ |
| 上傳／刪除附件 |  |  | ✓ | ✓ | ✓ |
| 管理成員 |  |  |  | ✓ | ✓ |
| 任命或管理 Owner |  |  |  |  | ✓ |

一般 workspace 邀請新成員時仍預設 `Member`；Owner/Admin 可明確選擇 `Commenter`。既有角色的相對權限不變。

### Commenter 建立 task 的限制

Commenter 只能提交 `title` 與 `description`。若 request body 含 `status`、`priority`、`assignee`、`assigneeId`、`projectId` 或 `dueAt`，伺服器回 HTTP 400，不忽略；合法建立使用固定值：

```text
status = Todo
priority = Medium
assignee = null
projectId = null
dueAt = null
```

Member 以上保留現有完整 create-task 輸入能力。

## API 權限調整

| Endpoint／動作 | 新最低角色 |
|---|---|
| `GET /api/workspaces/:id/tasks` | Viewer |
| `POST /api/workspaces/:id/tasks` | Commenter |
| `GET /api/tasks/:id` | Viewer |
| `PATCH /api/tasks/:id` | Member |
| `DELETE /api/tasks/:id` | Member |
| `POST /api/tasks/:id/archive` | Member |
| `GET /api/tasks/:id/comments` | Viewer |
| `POST /api/tasks/:id/comments` | Commenter |
| `PATCH/DELETE /api/comments/:id` | Commenter + 原作者 |
| project 寫入 | Member |
| attachment 寫入／刪除 | Member |

RBAC 不通過時沿用 `requirePermission()` 的 HTTP 403。Commenter 編修或刪除他人留言仍回 403。

## 主工作區政策

### 固定設定

程式集中定義：

```text
MAIN_WORKSPACE_ID = 11a82028-fc50-466a-a723-e002032cd9a6
MAIN_WORKSPACE_NAME = 主協作工作區
MAIN_OWNER_EMAIL = user01@test.local
MAIN_DISCUSSION_PREFIX = [討論]
MAIN_POLICY_TITLE = [規則] 主工作區協作與交接
```

這些設定是產品政策，不從可編輯資料推導，避免 workspace 改名後失去識別。

`renameWorkspace()` 對固定 UUID 只接受 `主協作工作區`；其他名稱由 domain 拒絕。啟動同步仍負責把現有舊名稱改成固定名稱。

### 成員同步

- Server 啟動時掃描所有 users。
- 主工作區名稱不同時更新為 `主協作工作區`。
- user01 必須已是主工作區 Owner；若不是，記錄明確設定錯誤並停止本輪同步，不自動提權。
- 所有非 user01 帳號都加入或調整為 `Commenter`；目前的 user09 會由 Member 調整為 Commenter。
- 重複同步不得建立重複 member events。
- 使用者成功登入時再同步該 user，涵蓋 server 啟動後新增的內部帳號。
- 主工作區禁止透過一般 Member API 移除 user、改變 user01 角色，或把其他 user 改成非 Commenter。
- 被移除後重新同步的 user 必須能重新邀請並 join；一般 workspace 也因此支援 removed member 再邀請。

主工作區因為永久含多名成員，既有「只剩唯一 Owner 才能 archive/delete workspace」規則會自然阻止關閉，不需新增例外。

### Task 建立規則

- 主工作區的普通 task 一律是討論 task。
- title 若未以 `[討論]` 開頭，由後端自動補上。
- 不論建立者角色，普通討論 task 都固定為 Todo、Medium、未指派、無 project、無 due date。
- `[規則]` task 是唯一例外，不補 `[討論]` 前綴。

### Legacy Task Backfill

- 啟動同步掃描主工作區所有非 Archived、非 `[規則]` task；只要 title／priority／assignee／project／due date 不符合討論預設，就 append 單一 `task.main_discussion_normalized` event。
- event payload 包含補過前綴的 title、`priority=Medium`、`projectId=null`、`dueAt=null`；Todo 使用 `assigneeId=null`，Doing／Review／Done 保留現有 assignee，避免 restart 清掉 `task.discussion_started` 指派的 user01。projection 一次更新全部欄位、version 與 updated_at，避免多事件部分完成。
- status 與 description 保持不變；Archived task 不回填。
- 目前兩個 legacy Todo 只會改 title，其他欄位值不變。重複啟動不得追加 normalization event。

### 狀態治理

- 主工作區只有 user01 可以執行任何狀態轉換，包括回退。
- 其他 user 即使因資料錯誤取得 Member/Admin，task domain 仍拒絕狀態轉換。
- user01 執行 `Todo → Doing` 時，不要求事先指派；系統寫入單一 `task.discussion_started` event，payload 的 `assigneeId` 使用資料庫中 `user01@test.local` 對應的 runtime UUID：

```json
{
  "status": "Doing",
  "assigneeId": "runtime user01 UUID"
}
```

- `task.discussion_started` reducer 更新 aggregate status；projection 在同一事件中更新 `status`、`assignee_id`、`version` 與 `updated_at`，避免兩事件部分成功。
- 其他由 user01 執行的合法轉換沿用 `task.status_changed` 與既有相鄰狀態機。

## 規則提示與 UI

主工作區 Kanban 頂端固定顯示以下原則的精簡版：

1. 此處只建立討論，不直接實作。
2. 所有人都可新增 Todo 討論與留言。
3. 只有 user01 可以改變狀態。
4. user01 開始討論時系統自動指派 user01。
5. 決議後先判斷 target repo，使用 canonical／對應 workspace 建立實作 task、回寫連結，再完成原討論。

Server 啟動時確保 `[規則] 主工作區協作與交接` task 存在。規則描述不同時才由 user01 更新，避免每次啟動追加事件。前端將此 task 排在 Todo 最前方，banner 才是永遠可見的主要提示。

UI 依目前使用者在 workspace 的角色收斂控制：

- Commenter 保留 Todo 新增入口與留言區。
- Commenter 隱藏 task title/description 儲存、狀態按鈕、priority、assignee、due date、archive/delete、project 與附件寫入控制。
- 主工作區只有 Todo 欄顯示新增入口。
- 非 user01 在主工作區看到「狀態由 user01 協調」而非狀態按鈕。
- user01 在主工作區 `Todo → Doing` 不顯示「必須先指派」的舊前端阻擋。
- 成員管理頁角色選單加入 Commenter。

前端限制只改善操作體驗；API/domain 仍是權限權威。

## 討論交接流程

```text
任何 user 建立討論
  → 系統建立 [討論] Todo
  → user01 開始處理
  → task.discussion_started（Doing + assignee=user01）
  → 所有人留言討論
  → user01 判斷 target repo，查 canonical workspace registry
  → 有登記則在 canonical workspace 建 task；未登記則找既有 workspace 或新增
  → user01 使用既有 API 建立實作 task
  → user01 在原討論留言貼目標 URL
  → user01 將原討論 task 移至 Done
```

### Target Workspace 路由

- 主工作區可討論任何 repo，不得把所有討論硬綁成 `ROOT`（task-tracker）。
- user01 先從討論內容判斷 target repoRoot，再對照 `CANONICAL_WORKSPACE_BY_REPOROOT`；exact match 存在時使用該 workspace。
- target repo 未登記時，先尋找對應的既有 workspace；仍不存在才新增 workspace，並在原討論留言註明 `未登記，人工介入選定`。
- 新實作 task 的 description 要保留來源討論 URL 與 target repo，避免重複建立及再次跨 repo 卡死。
- 目前只有 task-tracker repo 有 canonical workspace；不得因 registry 只有一筆就假設每個主工作區討論都屬於 task-tracker。

留言 rich-text renderer 增加安全的 HTTP(S) URL 自動連結；使用 DOM text/anchor 建構，不接受任意 HTML。內部 `#/task/...` 完整分享 URL 可直接開啟目標 task。

本次不強制 Done 前必須存在特定格式連結。等需要查詢「一個討論產生哪些實作」時，再新增正式 handoff 關聯模型。

## SIM 與 Sweep

- 主工作區 UUID 永遠加入 owner sweep 候選，不依賴 `sim-logs/report.json`。
- `4902e28` 已有 `ensureCanonicalWorkspaceCandidates()`；實作時在既有呼叫旁加入 `ensureMainWorkspaceCandidate()`，兩者各呼叫一次，不另做 registry。
- main／canonical 候選使用 epoch timestamp 只代表「無歷史時間」，不能因此永遠排在新 workspace 後面。排序優先序固定為：前輪 timeout → 主工作區 → canonical workspace → 其他 workspace 依 startedAt 新到舊。
- `[規則]` task 不列入 owner/team 待辦，也不可被 member session 認領。
- 主工作區 `[討論]` task 在以下情況喚醒 owner：
  - status 是 Todo；或
  - 最新留言作者不是 user01。
- Doing 且最新留言是 user01 時視為等待其他 user，不重複啟動 owner session。
- 主工作區 owner prompt 改為：回覆討論、Todo→Doing、判斷 target repo、顯示 canonical directory、在正確 workspace 建立目標工作、回寫 URL、Done。
- 其他 workspace 原有 `[討論]` 行為保持不變。
- 所有 owner/member prompt 都加入主工作區規則摘要：一般 user 不嘗試改狀態，任何實作不得留在主工作區。

## 錯誤處理

- 主 workspace 不存在：記錄設定錯誤，server 繼續提供其他 workspace，不建立替代 workspace。
- user01 不存在或不是 Owner：記錄設定錯誤，停止主工作區同步，不自動提權。
- 嘗試把固定主工作區改成其他名稱：HTTP 400／domain `CommandError`；不得只依賴下次 restart 改回。
- Commenter 呼叫 Member endpoint：HTTP 403。
- 非 user01 嘗試主工作區狀態轉換：route 通常先回 403；domain guard 仍防止內部繞過。
- 規則 task 建立／更新失敗：記錄錯誤，不阻止 server 啟動；下次啟動重試。
- URL renderer 遇到不合法 URL：保留純文字，不建立 anchor。
- target repo 未登記 canonical workspace：不得預設導向 task-tracker；找既有／新增 workspace，並回寫 `未登記，人工介入選定`。

## 測試與驗收

### 自動測試

- 角色排序：Viewer < Commenter < Member < Admin < Owner。
- Commenter invite/join/change role、removed member 重新邀請與同步冪等。
- 主工作區所有既有 users 回補為 Commenter，user01 保持 Owner，user09 由 Member 調整為 Commenter。
- Viewer、Commenter、Member 對 task/comment/project/attachment 的權限矩陣。
- Commenter task create 輸入被限制；Member create 行為不變。
- 主工作區自動 `[討論]` 前綴與固定預設值。
- 非 user01 狀態轉換失敗；user01 `Todo → Doing` 以單一事件同步更新 status/assignee。
- `[規則]` task 建立／內容同步冪等。
- legacy main task 以單一 `task.main_discussion_normalized` event 補 `[討論]` 並清回固定預設；第二次同步不追加事件。
- 已 Doing 且由 `task.discussion_started` 指派 user01 的 task 經 restart normalization 後仍保留 assignee，且不追加事件。
- UI banner、角色控制、規則 task 排序與安全 URL renderer。
- sweep 在沒有歷史 report 時仍發現主工作區，且只在真正需要 user01 時啟動。
- main workspace 與 canonical workspace 候選可同時加入空 `Map`，不互相覆蓋或重複註冊。
- sweep 排序測試證明 timeout workspace 優先於主工作區，主工作區優先於 canonical，canonical 優先於一般新 workspace，避免有限 owner budget 下飢餓。
- main owner prompt 顯示 canonical repoRoot → workspace directory，並明確禁止一律使用 `ROOT`。

### 完整驗證

```bash
npm test
npm run build
git diff --check
```

### HTTP smoke

1. user02 登入後，`GET /api/workspaces` 能看到主工作區。
2. user02 建立討論成功，結果是 `[討論]` Todo、Medium、未指派。
3. user02 建立留言及修改自己的留言成功。
4. user02 PATCH task status、priority、assignee、archive、project 或 attachment 寫入皆為 403。
5. user01 PATCH status Doing 成功，task 同時指派 user01。
6. user01 依 target repo 選 canonical／既有／新 workspace，建立 task，在原討論貼連結後移至 Done。
7. 連結可從留言直接開啟目標 task。

## Rollout

1. 在 isolated feature worktree 完成實作、`npm test`、`npm run build` 與 `git diff --check`。
2. 依 finishing workflow 將 feature branch 整合到 `master`；未合併前不得 restart 正式 service，否則只會測到舊的 `/home/hom/code/task-tracker/dist`。
3. 在乾淨 `master` 重新 build，再 restart `task-tracker.service`。
4. 啟動同步將主工作區改名為 `主協作工作區`、將現有非 user01 成員調整為 Commenter、加入其餘 users、正規化兩個 legacy Todo，並建立規則 task。
5. 驗證主工作區名稱、active member 數等於 users 數，且只有 user01 是 Owner。
6. 執行 HTTP smoke；通過後才能把本文件狀態改為 `已實作並驗收`。
7. `sim-sweep-owner.timer`／`sim-sweep-team.timer` 目前由使用者停用，不自動 enable。只有取得明確授權才跑 live owner sweep；否則保留為待驗收項目。

本次沒有 schema migration，也不需要重建 event store/read model。
