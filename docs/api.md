# API 說明

本文件以 `src/server.ts` 目前實作為準，記錄 Task Tracker 全部 `/api/*` HTTP endpoint 的 request、權限、response 與錯誤契約。

## 共通規則

### Base URL

以下範例使用：

```bash
BASE=http://127.0.0.1:3000
```

部署在 nginx `/tracker/` 時，將 `BASE` 換成實際公開網址；API path 本身仍以 `/api/...` 結尾。

### Authentication

登入是 cookie-based session：

1. 呼叫 `POST /api/auth/login`。
2. 保存 response 的 `Set-Cookie: session=...`。
3. 後續受保護 API 帶上 `Cookie: session=...`。

Session cookie 為 `HttpOnly`、`SameSite=Strict`，有效期 7 天。未登入的受保護 API 統一回：

```json
{ "error": "未登入" }
```

HTTP `401`。

### Workspace roles

角色階層為 `Owner > Admin > Member > Commenter > Viewer`。workspace-scoped API 的最低角色如下：

| 最低角色 | 能力 |
| --- | --- |
| `Viewer` | 讀取 workspace、task、project、comment、attachment、search |
| `Commenter` | 建立 task、建立 comment、修改/刪除自己的 comment、修改自己建立 task 的 description |
| `Member` | 修改/刪除/archive/move task、建立/修改/刪除 project、上傳/刪除 attachment |
| `Admin` | workspace 改名/archive/delete、成員邀請/列表/角色/移除、audit |
| `Owner` | `Admin` 能力，以及 Owner 專屬的 Owner 任命/移交規則 |

前端隱藏控制項不是授權來源；server 會重新檢查 session、workspace membership、role 與資源歸屬。

### Request and error conventions

- JSON request 使用 JSON object；server 的 JSON body 上限為 1 MB。
- mutation request 若帶 `Origin` header，Origin 的 host 必須與 request `Host` 相同，否則回 `403`：

  ```json
  { "error": "CSRF 檢查失敗（Origin 不符）" }
  ```

- 一般 domain validation error 回 `400`，body 為 `{ "error": "<訊息>" }`。
- 業務衝突（例如 workspace 還有其他成員、狀態不允許）回 `409`。
- 權限不足回 `403`；資源不存在或不屬於可見 workspace 時回 `404`。
- attachment body 超過上限回 `413`；login/forgot-password rate limit 回 `429`。
- 成功的 mutation 通常回 `{ "ok": true }`；建立資源通常回 `201` 與 `{ "id": "..." }`。

## Endpoint index

| Area | Method | Path | Auth / minimum role | Success |
| --- | --- | --- | --- | --- |
| Health | GET | `/api/health` | public | `200` health object |
| Auth | POST | `/api/auth/login` | public | `200` + session cookie |
| Auth | POST | `/api/auth/logout` | public/session optional | `200` + cleared cookie |
| Auth | GET | `/api/auth/me` | login | `200` user |
| Auth | POST | `/api/auth/forgot-password` | public | `200` generic message |
| Auth | POST | `/api/auth/reset-password` | public token | `200` |
| Users | GET | `/api/users/search?q=...` | login | `200` user suggestions |
| Quota | GET | `/api/quota` | login | `200` provider array |
| Workspace | GET/POST | `/api/workspaces` | login | list / `201` id |
| Workspace | PATCH | `/api/workspaces/:id` | Admin | `200` |
| Workspace | POST | `/api/workspaces/:id/archive` | Admin | `200` |
| Workspace | POST | `/api/workspaces/:id/delete` | Admin | `200` |
| Members | GET/POST | `/api/workspaces/:id/members` | Viewer / Admin | list / `201` |
| Members | POST | `/api/workspaces/:id/members/join` | login | `200` |
| Members | PATCH/DELETE | `/api/workspaces/:id/members/:userId` | Admin | `200` |
| Tasks | GET/POST | `/api/workspaces/:id/tasks` | Viewer / Commenter | list / `201` |
| Task | GET/PATCH/DELETE | `/api/tasks/:id` | Viewer / field-dependent / Member | `200` |
| Task | POST | `/api/tasks/:id/archive` | Member | `200` |
| Task | POST | `/api/tasks/:id/move` | Member in source and target | `200` |
| Notifications | GET | `/api/notifications` | login | `200` notification array |
| Notifications | POST | `/api/notifications/:id/read` | login, recipient only | `200` |
| Projects | GET/POST | `/api/workspaces/:id/projects` | Viewer / Member | list / `201` |
| Project | PATCH/DELETE | `/api/projects/:id` | Member | `200` |
| Comments | GET/POST | `/api/tasks/:id/comments` | Viewer / Commenter | list / `201` |
| Comment | PATCH/DELETE | `/api/comments/:id` | Commenter + author | `200` |
| Attachments | GET/POST | `/api/tasks/:id/attachments` | Viewer / Member | list / `201` |
| Attachment | GET/DELETE | `/api/attachments/:id` | Viewer / Member | file / `200` |
| Search | GET | `/api/search?workspace=:id&q=...` | Viewer | `200` search object |
| Audit | GET | `/api/audit?aggregate_id=...` | Admin | `200` event array |

## Common response objects

### User

`GET /api/auth/me` 回傳：

```json
{ "id": "user-uuid", "email": "user01@test.local", "name": "阿哲" }
```

`GET /api/users/search` 的每筆結果只包含 `email` 與 `name`。

### Workspace

`GET /api/workspaces` 的每筆資料：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `workspace_id` | string | workspace UUID |
| `name` | string | workspace 名稱 |
| `status` | `active \| archived \| deleted` | workspace 狀態 |
| `created_at` | string | UTC ISO timestamp |
| `updated_at` | string | UTC ISO timestamp |

### Member

`GET /api/workspaces/:id/members` 的每筆資料：

```json
{
  "user_id": "user-uuid",
  "role": "Member",
  "joined_at": "2026-07-13T01:00:00.000Z",
  "email": "user02@test.local",
  "name": "小美"
}
```

### Task

task list 與 single-task GET 的欄位：

| 欄位 | 型別 |
| --- | --- |
| `task_id` | string |
| `workspace_id` | string |
| `creator_id` | string \| null |
| `project_id` | string \| null |
| `title` | string |
| `description` | string |
| `status` | `Todo \| Doing \| Review \| Done \| Archived` |
| `priority` | `Low \| Medium \| High` |
| `assignee_id` | string \| null |
| `due_at` | string \| null，UTC ISO timestamp |
| `version` | number |
| `updated_at` | string \| null，UTC ISO timestamp |

### Project

```json
{
  "project_id": "project-uuid",
  "workspace_id": "workspace-uuid",
  "name": "Backend"
}
```

### Comment

```json
{
  "comment_id": "comment-uuid",
  "task_id": "task-uuid",
  "user_id": "user-uuid",
  "content": "請確認 API response",
  "created_at": "2026-07-13T01:00:00.000Z"
}
```

### Attachment metadata

```json
{
  "attachment_id": "attachment-uuid",
  "task_id": "task-uuid",
  "original_name": "report.pdf",
  "mime_type": "application/pdf",
  "size": 12345
}
```

### Notification

```json
{
  "notification_id": "notification-uuid",
  "recipient_id": "user-uuid",
  "source_task_id": "task-uuid",
  "source_comment_id": "comment-uuid",
  "snippet": "@小美 請確認這個 API",
  "created_at": "2026-07-13T01:00:00.000Z",
  "read_at": null
}
```

### Audit event

`GET /api/audit` 的每筆事件：

| 欄位 | 說明 |
| --- | --- |
| `id` | event_store row id |
| `aggregate_type` | `Workspace`、`Member` 或 `Task` |
| `aggregate_id` | aggregate UUID；Member 為 `workspace_id:user_id` |
| `aggregate_version` | 該 aggregate 的事件版本 |
| `event_type` | 例如 `task.created`、`task.status_changed` |
| `payload` | 已 parse 的事件 payload |
| `metadata` | 已 parse 的 actor/ip/user-agent/request id metadata |
| `occurred_at` | UTC ISO timestamp |

## Health and authentication

### `GET /api/health`

公開健康檢查，不需要登入。

```json
{ "status": "ok", "db": true }
```

### `POST /api/auth/login`

Request JSON：

```json
{ "email": "user01@test.local", "password": "test1234" }
```

成功回 `200`、`{ "ok": true }`，並設定新的 `session` cookie。登入成功會使 request 帶入的舊 session 失效。

- body 缺欄位：`400`，`email 與 password 為必填`
- 帳密錯誤：`401`，`帳號或密碼錯誤`
- 同一 client IP 失敗過多：`429`，`登入嘗試過於頻繁，請稍後再試`

### `POST /api/auth/logout`

不要求登入；若 request 有 session，就刪除該 session。成功回 `200`、`{ "ok": true }`，並設定過期的 `session` cookie。

### `GET /api/auth/me`

需要登入。成功回 `200` 與 [User](#user) object。

### `POST /api/auth/forgot-password`

Request JSON：

```json
{ "email": "user01@test.local" }
```

不論 email 是否存在，都回同一個 `200` response，避免帳號枚舉：

```json
{ "ok": true, "message": "若該 email 已註冊，重設連結已寄出" }
```

目前不寄真實 email；存在的帳號會把一次性、1 小時有效的 reset link 印到 server log。body 缺 email 回 `400`；同一 client IP 失敗過多回 `429`。

### `POST /api/auth/reset-password`

Request JSON：

```json
{ "token": "reset-token", "password": "new-password" }
```

成功回 `200`、`{ "ok": true }`。token 必須存在、未過期且未使用；成功後該 user 的所有 session 失效。缺欄位、無效、過期或已使用 token 回 `400`。

## Users and quota

### `GET /api/users/search?q=...`

需要登入。`q` 是 email 或 name 的 prefix search，最多回 10 筆：

```json
[
  { "email": "user02@test.local", "name": "小美" }
]
```

空 `q` 回 `[]`。此 API 只接受帶 query string 的形式；建議永遠使用 `?q=` 並以 URL encoding 傳值。

### `GET /api/quota`

需要登入，不綁定 workspace。回傳固定順序的 `codex`、`claude`、`agy` provider array：

```json
[
  {
    "provider": "codex",
    "remaining": "78%",
    "resetAt": "2026-07-19T19:00:07.000Z",
    "source": "chatgpt.com/backend-api/wham/usage",
    "unavailable": false,
    "stale": false,
    "windows": [
      { "window": "five_hour", "remaining": null, "resetAt": null, "available": false },
      { "window": "seven_day", "remaining": "78%", "resetAt": "2026-07-19T19:00:07.000Z", "available": true }
    ]
  },
  {
    "provider": "claude",
    "remaining": "100%",
    "resetAt": null,
    "source": "api.anthropic.com/api/oauth/usage",
    "unavailable": false,
    "stale": false,
    "windows": [
      { "window": "five_hour", "remaining": "100%", "resetAt": null, "available": true },
      { "window": "seven_day", "remaining": "14%", "resetAt": "2026-07-14T23:00:00.207Z", "available": true }
    ]
  },
  {
    "provider": "agy",
    "remaining": "64%",
    "resetAt": "2026-07-13T23:59:59.000Z",
    "source": "daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels#model=gemini-3-flash-agent",
    "unavailable": false,
    "stale": false,
    "windows": [
      { "window": "five_hour", "remaining": "64%", "resetAt": "2026-07-13T23:59:59.000Z", "available": true },
      { "window": "seven_day", "remaining": null, "resetAt": null, "available": false }
    ]
  }
]
```

`remaining` 與 `resetAt` 是摘要欄位：優先使用可用的 `five_hour`，不存在時 fallback `seven_day`。`windows` 永遠依五小時、七天排列；`available: false` 表示該視窗沒有資料。`resetAt` 保持 UTC ISO timestamp，前端固定轉為 `Asia/Taipei`。

資料由獨立的 `/home/hom/services/ai-quota` systemd timer 寫入 `~/.local/state/ai-quota/quota.json`；task-tracker 不讀 provider credentials，也不呼叫外部 usage API。agy（Antigravity 額度）與 codex、claude 共用同一份 snapshot，目前只回報 `five_hour` 視窗，`seven_day` 恆為 unavailable。`stale: true` 表示顯示的是最後成功資料或 snapshot 無法取得；`unavailable: true` 只表示該 provider 沒有可顯示視窗，不影響其他 provider；snapshot 缺 agy 或形狀不符（舊版相容）時，agy 會標記 `unavailable: true` 且 `source` 為 `ai-quota-agy-missing`。

2026-07-13 正式驗證：Codex 僅回七天視窗時，摘要正確 fallback 七天；Claude 五小時視窗為 `100%` 且 `resetAt: null` 時仍視為可用。Footer hover 會同時顯示五小時與七天資料，並將 UTC `resetAt` 固定格式化為 `Asia/Taipei`，API 本身不改寫 timestamp。

## Workspaces and members

### `GET /api/workspaces`

需要登入。回傳目前 user 有 membership 的 workspace array，包含 archived/deleted workspace；deleted 排在最後。

### `POST /api/workspaces`

需要登入。Request JSON：

```json
{ "name": "產品開發" }
```

成功回 `201`：

```json
{ "id": "workspace-uuid" }
```

name 必須是非空、最多 200 字串。建立者自動成為 Owner。workspace 建立後若符合主協作 workspace 的 demo policy，server 也會同步固定 observer。

### `PATCH /api/workspaces/:id`

需要該 workspace `Admin`。Request JSON：`{ "name": "新名稱" }`。成功回 `{ "ok": true }`。name 驗證規則同建立 workspace；inactive workspace 不可改名。主協作 workspace 名稱固定，不可改成其他名稱。

### `POST /api/workspaces/:id/archive`

需要 `Admin`。無 body。成功回 `{ "ok": true }` 並將 workspace 狀態設為 `archived`。

- workspace 不存在：`400`
- workspace 已非 active，或 active member 不只一人：`409`

### `POST /api/workspaces/:id/delete`

需要 `Admin`。無 body。成功回 `{ "ok": true }` 並將 workspace 狀態設為 `deleted`。

- workspace 不存在：`400`
- active member 不只一人，或 workspace 已 deleted：`409`

### `GET /api/workspaces/:id/members`

需要 `Viewer`。回傳 [Member](#member) array，只列已 join 的 active member；pending invite 不會出現在列表。

### `POST /api/workspaces/:id/members`

需要 `Admin`。Request JSON：

```json
{ "email": "user02@test.local", "role": "Member" }
```

`role` 可為 `Viewer`、`Commenter`、`Member`、`Admin`、`Owner`。成功回 `201`、`{ "ok": true }`，邀請對象必須是已存在的 user。email 不存在、role 不合法、已邀請/已加入或角色升級違規回 `400`。

### `POST /api/workspaces/:id/members/join`

需要登入，但不要求目前已是 workspace member。無 body；只有該 user 有 pending invite 時可成功。成功回 `{ "ok": true }`，沒有待接受邀請回 `400`。

### `PATCH /api/workspaces/:id/members/:userId`

需要 `Admin`。Request JSON：`{ "role": "Member" }`。成功回 `{ "ok": true }`。

target 必須是該 workspace 的 active member，否則回 `404`。Owner 任命、主協作 workspace 固定角色、最後 Owner 自我降級等 domain rules 違反時回 `400`。

### `DELETE /api/workspaces/:id/members/:userId`

需要 `Admin`。無 body。target 必須是 active member，否則回 `404`；成功回 `{ "ok": true }`。主協作 workspace 不允許手動移除成員；移除 Owner 或 Owner 自我離開受 Owner/唯一成員規則限制，違反回 `400`。

## Tasks

### `GET /api/workspaces/:id/tasks`

需要 `Viewer`。回傳 [Task](#task) array。

### `POST /api/workspaces/:id/tasks`

需要 `Commenter`。一般 Member/Owner/Admin 可使用下列欄位：

```json
{
  "title": "修正登入錯誤",
  "description": "重現步驟與驗收條件",
  "priority": "High",
  "assignee": "user-uuid",
  "dueAt": "2026-07-20T00:00:00.000Z",
  "projectId": "project-uuid"
}
```

欄位規則：

- `title` 必填，非空，最多 200 字。
- `description` 選填，最多 5000 字；省略時為空字串。
- `priority` 為 `Low`、`Medium`、`High`，省略時為 `Medium`。
- `assignee` 為 user id 或 `null`；`dueAt` 為可解析的日期字串或 `null`。
- `projectId` 可為 project id 或 `null`；目前只保存參照，不在 create API 額外檢查 project 是否屬於同一 workspace。
- 新 task 的 status 一律為 `Todo`；request 的 `status` 不會改變初始狀態。
- Commenter 只能提交 `title`、`description`，並固定使用 `Medium`、未指派、無 due date/project。
- 主協作 workspace 的一般 task 會自動加上 `[討論]` 前綴，且只有 user01 能建立固定規則 task。

成功回 `201`：`{ "id": "task-uuid" }`。

### `GET /api/tasks/:id`

需要 task 所屬 workspace 的 `Viewer`。成功回單一 [Task](#task) object；task 不存在回 `404`。

### `PATCH /api/tasks/:id`

需要登入，且一次只能修改一個欄位。可用 body：

```json
{ "title": "新標題" }
{ "description": "新描述" }
{ "status": "Doing" }
{ "priority": "High" }
{ "assignee": "user-uuid" }
{ "dueAt": "2026-07-20T00:00:00.000Z" }
```

成功回 `{ "ok": true }`。規則：

- `title`、`description`、`priority`、`assignee`、`dueAt` 都會做型別/長度/日期驗證。
- status 只允許相鄰流程：`Todo → Doing → Review → Done`，以及一步回退 `Doing → Todo`、`Review → Doing`、`Done → Review`。
- Commenter 只有在 task creator 是自己時，才能只 PATCH `description`；其他欄位需要 Member。
- 主協作 workspace 的 task status 只有 user01 能改。
- archived task、deleted task 或 inactive workspace 的修改會被拒絕。
- 多欄位、未知欄位或不符合欄位格式回 `400`。

### `DELETE /api/tasks/:id`

需要 `Member`。無 body；成功回 `{ "ok": true }`。task 不存在回 `404`，domain validation/ inactive workspace 等錯誤回 `400`。

### `POST /api/tasks/:id/archive`

需要 `Member`。無 body；成功回 `{ "ok": true }`，task status 變為 `Archived`。不存在回 `404`；已 archived/deleted 或主 workspace 非 user01 操作等錯誤回 `400`。

### `POST /api/tasks/:id/move`

需要 actor 在 source 與 target workspace 都至少是 `Member`。Request JSON：

```json
{ "targetWorkspaceId": "target-workspace-uuid" }
```

成功回：

```json
{ "ok": true }
```

若原 task 有 assignee 且該 assignee 尚未加入 target，server 會發出 Member invite，回：

```json
{ "ok": true, "message": "已對 assignee 發邀請，待其接受" }
```

target 必須存在且為 active，不能與 source 相同；archived/deleted task 不可搬移。違反 source/target 權限、workspace 狀態或 task 狀態回 `400`；task 不存在回 `404`。

## Notifications

通知由 comment 內容中的 `@Name` 或 `@email-local-part` 觸發；不通知自己，同一留言同一收件人只產生一筆。`source_comment_id` 現行固定回字串，前端可直接拿來做留言錨點。
前端接線與 UI 呈現細節請見 [@mention 與通知 API 前端整合指南](./frontend/mentions-and-notifications.md)。

### `GET /api/notifications`

需要登入。只回傳目前 user 的 [Notification](#notification) array，未讀優先，再依建立時間新到舊排序。

### `POST /api/notifications/:id/read`

需要登入，且 notification 必須屬於目前 user。無 body；成功回 `{ "ok": true }`。重複標已讀仍回成功；不存在或不屬於目前 user 回 `400`。

## Projects

### `GET /api/workspaces/:id/projects`

需要 `Viewer`。回傳 [Project](#project) array。

### `POST /api/workspaces/:id/projects`

需要 `Member`。Request JSON：`{ "name": "Backend" }`。name 必須非空、最多 200 字；workspace 必須 active。成功回 `201`、`{ "id": "project-uuid" }`。

### `PATCH /api/projects/:id`

需要 project 所屬 workspace 的 `Member`。Request JSON：`{ "name": "新名稱" }`。成功回 `{ "ok": true }`；project 不存在回 `404`，name validation 回 `400`。

### `DELETE /api/projects/:id`

需要 `Member`。無 body；成功回 `{ "ok": true }`。刪除 project 會先把關聯 task 的 `project_id` 清為 `null`；project 不存在回 `404`。

## Comments

### `GET /api/tasks/:id/comments`

需要 task workspace 的 `Viewer`。回傳 [Comment](#comment) array；task 不存在回 `404`。

### `POST /api/tasks/:id/comments`

需要 `Commenter`。Request JSON：

```json
{ "content": "請 @小美 確認這個 API" }
```

content trim 後必須非空、最多 5000 字。成功回 `201`、`{ "id": "comment-uuid" }`；同時可能建立 mention notification。

### `PATCH /api/comments/:id`

需要 comment 所屬 workspace 的 `Commenter`，且只能是原作者。Request JSON：`{ "content": "更新後的留言" }`。成功回 `{ "ok": true }`；comment 不存在回 `404`，非作者回 `403`，content validation 回 `400`。

### `DELETE /api/comments/:id`

需要 comment 所屬 workspace 的 `Commenter`，且只能是原作者。無 body；成功回 `{ "ok": true }`，並刪除由該 comment 產生的 notifications。comment 不存在回 `404`，非作者回 `403`。

## Attachments

### `GET /api/tasks/:id/attachments`

需要 task workspace 的 `Viewer`。回傳 [Attachment metadata](#attachment-metadata) array；task 不存在回 `404`。

### `POST /api/tasks/:id/attachments`

需要 `Member`。這不是 multipart；request body 是原始檔案 bytes：

- `X-Filename`：原始檔名，可 URL encoded；省略時使用 `file`。
- `Content-Type`：必須是 `image/png`、`image/jpeg`、`image/gif`、`application/pdf` 或 `text/plain`。
- body 不可為空，且預設最多 10 MiB；可用 `ATTACHMENT_MAX_BYTES` 環境變數調整。

成功回 `201`、`{ "id": "attachment-uuid" }`。檔案過大回 `413`；空檔、MIME 不支援或 magic bytes 不符回 `400`。

curl 範例：

```bash
curl -sS -b /tmp/task-tracker-session.jar \
  -X POST "$BASE/api/tasks/$TASK_ID/attachments" \
  -H 'X-Filename: report.txt' \
  -H 'Content-Type: text/plain' \
  --data-binary 'report content'
```

### `GET /api/attachments/:id`

需要 attachment 所屬 workspace 的 `Viewer`。成功回原始檔案 bytes，並設定：

- `Content-Type`：儲存時驗證過的 MIME。
- `Content-Disposition: attachment`：強制下載，包含 sanitized original filename。
- `X-Content-Type-Options: nosniff`。

attachment 不存在回 `404`。

### `DELETE /api/attachments/:id`

需要 attachment 所屬 workspace 的 `Member`。無 body；成功回 `{ "ok": true }` 並刪除檔案與 metadata。attachment 不存在回 `404`。

## Search and audit

### `GET /api/search?workspace=:workspaceId&q=...`

需要該 workspace 的 `Viewer`。`workspace` 必填；`q` trim 後最多取 200 字，會搜尋 task title/description、project name、comment content。空 q 不掃表，直接回：

```json
{ "tasks": [], "projects": [], "comments": [] }
```

有結果時 response shape：

```json
{
  "tasks": [{ "task_id": "...", "title": "...", "status": "Doing" }],
  "projects": [{ "project_id": "...", "name": "Backend" }],
  "comments": [{ "comment_id": "...", "task_id": "...", "content": "..." }]
}
```

缺 `workspace` 回 `400`；未登入/權限不足依共通規則回 `401/403`。

### `GET /api/audit?aggregate_id=:id`

需要 aggregate 所屬 workspace 的 `Admin`。`aggregate_id` 必填；目前可解析的 aggregate 是：

- Workspace：aggregate id 就是 workspace UUID。
- Member：格式為 `workspace_id:user_id`。
- Task：使用 task 建立事件的 workspace。

成功回該 aggregate 的完整 [Audit event](#audit-event) array，來源是 `event_store`。缺參數回 `400`；aggregate 不存在或類型不支援回 `404`；跨 workspace 或角色不足回 `403`。

## Source references

- Route dispatch：[`src/server.ts`](../src/server.ts)
- Domain contracts：[`src/auth.ts`](../src/auth.ts)、[`src/workspace.ts`](../src/workspace.ts)、[`src/member.ts`](../src/member.ts)、[`src/task.ts`](../src/task.ts)
- CRUD/read models：[`src/project.ts`](../src/project.ts)、[`src/comment.ts`](../src/comment.ts)、[`src/attachment.ts`](../src/attachment.ts)、[`src/notification.ts`](../src/notification.ts)、[`src/search.ts`](../src/search.ts)、[`src/audit.ts`](../src/audit.ts)
- Quota implementation/test：[`src/quota.ts`](../src/quota.ts)、[`src/quota.test.ts`](../src/quota.test.ts)
