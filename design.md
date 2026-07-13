# Task Tracker Design

> 單一設計入口。最新 shipped state、驗證紀錄與 follow-up backlog 見 [docs/tasks/current.md](docs/tasks/current.md)；原始 Phase 0-7 建置歷史見 [docs/tasks/history.md](docs/tasks/history.md)。

## Goals

這個專案不是要複製 Jira 或 Trello，而是用一套可實跑的任務管理系統練習以下主題：

1. Event Sourcing
2. CQRS
3. RBAC
4. OWASP Top 10
5. 狀態機設計
6. 審計追蹤

## Architecture

```text
┌─────────────┐
│    User     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Command   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Permission  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Aggregate   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Event Store │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Projection  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Read Model  │
└─────────────┘
```

- `Workspace`、`Member`、`Task` 走 event sourcing。
- `Project`、`Comment`、`Attachment`、`Search` 與其他讀取型 API 維持簡單 CRUD / read model。
- Projection 採同步更新；查詢永遠不直接讀 `event_store`。

## Core Domain Rules

### Auth

- Cookie-based session，`POST /api/auth/login` 設 session cookie。
- 已完成忘記密碼：token hash 化、1 小時過期、單次使用、成功重設後其他 session 全失效。
- Seeder 會建立固定測試帳號 `user01@test.local` ~ `user30@test.local`，密碼固定 `test1234`。

### Workspace and Member

- Workspace 以 `active / archived / deleted` 管理生命週期。
- 角色階層為 `Owner > Admin > Member > Commenter > Viewer`。
- Workspace-scoped route 一律以 `requirePermission` 為權威，前端可收斂 UI，但不可自行放寬權限。
- `archiveWorkspace` / `deleteWorkspace` / Owner 自我降級與移除，都受「active 成員數必須收斂到允許狀態」的守門。

### Task

- 正常狀態流為 `Todo -> Doing -> Review -> Done`，允許一步回退。
- `Archived` 是獨立封存流程，不是正常前進狀態。
- Mutating API 走 command handler，不直接寫 `tasks_read_model`。

主協作工作區是狀態機的明確例外：所有成員都可建立 Todo 討論，OWNER 先留下結構化 `【OWNER想法】`，再以 `【全員回覆：N天】` 開啟固定 2–7 天窗口（0.5 天遞增；一天為連續 24 小時）。窗口一旦開啟不可延長、縮短或重開，期限到達前不可移動 task。期限到達後，只有 OWNER 能依完整證據直接將 `Todo` 結束為 `Done`；主工作區不使用 `Doing` 或 `Review`，也不從 `Done` 回退。

收尾證據分為三種：有共識且實作（`【結論】`、建立者/共同確認者的 `【確認結論】`、`【實作任務】工作區：...｜TASK：...`）、有共識但不實作（`【結論：不實作】` 與確認），或未達共識（`【未達共識】` 及分歧、缺少資訊、下次建議三欄）。前端不新增期限、逾期、回覆或缺席 UI；後端以 comment 與固定窗口資料作為唯一守門來源。

### Frontend

- 前端維持無 framework 的 Native ESM SPA，使用 hash routing。
- 所有使用者輸入渲染走 `textContent`，不用 `innerHTML`。
- 前端只處理體驗，不當權限來源。

### Main Workspace Governance

- 主協作工作區固定為 `11a82028-fc50-466a-a723-e002032cd9a6`。
- `user01@test.local` 是唯一 Owner；其餘內部測試帳號在主工作區同步為 `Commenter`。
- 主工作區只放討論與交接；實作工作需建立在對應 target workspace / repo。

主工作區的固定窗口 metadata 儲存在 `main_discussion_windows`（`task_id`、OWNER 想法留言、全員通知留言、`opened_at`、`wait_half_days`、`due_at`），每個 task 最多一筆。合法收尾追加 `task.main_discussion_concluded`，payload 保存 outcome、窗口時間、證據 comment id，以及實作時的工作區/TASK 名稱；該事件將 task read model 設為 `Done` 並清除 assignee。Comment 仍是既有 CRUD，窗口只保存後端 gate 所需資料。

## Event-Sourced Aggregates

### Workspace

- Aggregate id: `workspace_uuid`
- Events: `workspace.created`, `workspace.renamed`, `workspace.archived`, `workspace.deleted`

### Member

- Aggregate id: `workspace_uuid:user_uuid`
- Events: `member.invited`, `member.joined`, `member.role_changed`, `member.removed`

### Task

- Aggregate id: `task_uuid`
- Events: `task.created`, `task.title_changed`, `task.description_changed`, `task.status_changed`, `task.priority_changed`, `task.assignee_changed`, `task.due_date_changed`, `task.archived`, `task.deleted`

## Read Models

- `workspaces_read_model`: `workspace_id`, `name`, `status`, `created_at`
- `workspace_members_read_model`: `workspace_id`, `user_id`, `role`, `joined_at`
- `projects_read_model`: `project_id`, `workspace_id`, `name`
- `tasks_read_model`: `task_id`, `workspace_id`, `project_id`, `title`, `description`, `status`, `priority`, `assignee_id`, `due_at`, `version`
- `comments`: `comment_id`, `task_id`, `user_id`, `content`
- `attachments`: `attachment_id`, `task_id`, `original_name`, `stored_name`, `mime_type`, `size`

## Current Design Baselines

### Phase 0-7 Foundation

- 建立了最小可用的 auth、event store、workspace/member/task aggregates、project/comment/attachment/search 與 audit。
- 這一段的原始 build order 與逐 phase 歷史保留在 [docs/tasks/history.md](docs/tasks/history.md)。

### Phase 8-11 Product Surface

- 已完成 create-user seeder、forgot password、Member invite/join HTTP API、前端 SPA。
- 這些功能的 shipped evidence 與 follow-up backlog 保留在 [docs/tasks/current.md](docs/tasks/current.md)。

### Phase 12+ Team Workflow

- 已加入 sim harness、主協作工作區治理、Commenter 邊界與後續 backlog。
- live sim、quota、跨 workspace 搬移等工作仍以 [docs/tasks/current.md](docs/tasks/current.md) 為最新交接來源。

### AI Quota Boundary

- Codex 與 Claude 的 credentials、外部 usage requests、retry/backoff 與 snapshot persistence 由獨立 `/home/hom/services/ai-quota` repo 負責。
- Task-tracker 只讀 `~/.local/state/ai-quota/quota.json`，`/api/quota` 提供五小時與七天視窗；摘要優先五小時、缺少時 fallback 七天。
- Snapshot/API timestamps 保持 UTC；quota footer 固定以 `Asia/Taipei` 顯示重置時間。

## Security Baselines

- 密碼雜湊使用 `scrypt`，查詢使用 prepared statements。
- Login / forgot-password 有 rate limit。
- Mutating request 受 SameSite cookie + Origin 檢查保護。
- Static file / attachment 路徑穿越與 symlink 邊界都有守門。
- Audit metadata 透過 request context 寫入 `actor_id`, `ip`, `user_agent`, `request_id`。
