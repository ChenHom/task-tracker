# Task Tracker 系統設計

## 目標

目標不做一套 Trello、Jira，只跟著練習以下主題的任務管理系統：

1. Event Sourcing
2. CQRS
3. RBAC
4. OWASP Top10
5. 狀態機設計
6. 審計追蹤

---

## 架構總覽

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

---

## 模組

### Auth

負責：登入、登出、Session、密碼重設、登入紀錄

資料表：`users`、`sessions`、`login_events`

---

### Workspace

代表一個團隊 / 公司 / Side Project，例如：`Hom Personal`、`Company Internal`、`Open Source Team`。

---

### Member

管理：邀請、加入、角色變更、移除

角色（權限由高至低）：`Owner` > `Admin` > `Member` > `Viewer`

---

### Project

分類用途：

```text
Workspace
 ├─ Backend
 ├─ Frontend
 └─ Mobile
```

Project 本身先不用 Event Sourcing。

---

### Task

系統核心。

狀態：`Todo` → `Doing` → `Review` → `Done` → `Archived`

欄位：`Title`、`Description`、`Priority`、`Assignee`、`Due Date`、`Status`

---

### Comment

任務留言。第一版走普通 CRUD 即可，不要 Event Sourcing。

---

### Attachment

功能：上傳、下載、刪除

重點：權限檢查、檔名處理、MIME 驗證

---

### Search

搜尋範圍：Task、Comment、Project

SQLite 先用 `LIKE` 即可。

---

## Event Sourcing

只套用在 `Workspace`、`Member`、`Task` 三個 Aggregate。

### Workspace Aggregate

| 項目 | 內容 |
|---|---|
| Aggregate | `Workspace` |
| aggregate_id | `workspace_uuid` |
| 事件 | `workspace.created`、`workspace.renamed`、`workspace.archived`、`workspace.deleted` |

---

### Member Aggregate

| 項目 | 內容 |
|---|---|
| Aggregate | `Workspace Member` |
| aggregate_id | `workspace_uuid:user_uuid` |
| 事件 | `member.invited`、`member.joined`、`member.role_changed`、`member.removed` |

---

### Task Aggregate

| 項目 | 內容 |
|---|---|
| Aggregate | `Task` |
| aggregate_id | `task_uuid` |
| 事件 | `task.created`、`task.title_changed`、`task.description_changed`、`task.status_changed`、`task.priority_changed`、`task.assignee_changed`、`task.due_date_changed`、`task.archived`、`task.deleted` |

---

## Event Store

只有一張。不要拆成 `task_events`、`member_events`、`workspace_events`，全部進 `event_store`。

### event_store 欄位

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `aggregate_type` | 聚合類型（Workspace / Member / Task） |
| `aggregate_id` | 聚合 ID |
| `aggregate_version` | 版本號 |
| `event_type` | 事件類型 |
| `payload_json` | 事件內容 |
| `metadata_json` | 中繼資料 |
| `occurred_at` | 發生時間 |

範例：

```text
id=1  aggregate_type=Task  aggregate_id=task-123  event_type=task.created
id=2  aggregate_type=Task  aggregate_id=task-123  event_type=task.status_changed
```

---

## Read Model

查詢永遠不碰 `event_store`。

### workspaces_read_model

`workspace_id`、`name`、`status`、`created_at`

---

### workspace_members_read_model

`workspace_id`、`user_id`、`role`、`joined_at`

這張很重要，所有權限檢查都靠它。

---

### projects_read_model

`project_id`、`workspace_id`、`name`

---

### tasks_read_model

`task_id`、`workspace_id`、`project_id`、`title`、`description`、`status`、`priority`、`assignee_id`、`due_at`、`version`

---

### comments

`comment_id`、`task_id`、`user_id`、`content`

---

### attachments

`attachment_id`、`task_id`、`original_name`、`stored_name`、`mime_type`、`size`

---

## Projection

資料流：

```text
task.status_changed → event_store → projection → tasks_read_model.status
```

第一版採**同步 Projection**，不引入 Queue / Kafka / RabbitMQ / Redis / Background Worker。

---

## 權限模型

每個 Request 必查：

1. 是否登入
2. 是否屬於 Workspace
3. 是否有角色權限
4. 資源是否屬於同一個 Workspace

權限來源：`workspace_members_read_model`

---

## Audit

不用再做 `activity_logs`，因為 `event_store` 本身就是 audit log，直接查 `event_store` 即可得到「誰、什麼時間、改了什麼」。

metadata 範例：

```json
{
  "actor_id": "user-1",
  "ip": "127.0.0.1",
  "user_agent": "...",
  "request_id": "..."
}
```

---

## SQLite 第一版原則

- 單體架構
- SQLite
- 無快取
- 無 Queue
- 同步 Projection
- 單一 Event Store
- UUID 當 Aggregate ID

---

## 最終資料表

| 分類 | 資料表 |
|---|---|
| 使用者 / 認證 | `users`、`sessions`、`login_events` |
| Event Sourcing | `event_store` |
| Read Model | `workspaces_read_model`、`workspace_members_read_model`、`projects_read_model`、`tasks_read_model` |
| 其他 | `comments`、`attachments` |

目前這個範圍剛好。再多加通知、即時協作、WebSocket、看板拖拉、子任務、標籤系統，很快就會從「練 Event Sourcing」變成「做產品」，焦點會失掉。
