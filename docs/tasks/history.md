# 開發任務（歷史基線）

> 對應 [design.md](../../design.md)；保留 Phase 0-7 的原始 build order 與基礎 milestone。
> 目前 shipped state 與後續 backlog 請改看 [current.md](current.md)。

---

## Phase 0 — 專案骨架 ✅

- [x] TS + tsx + `node:http` + `node:sqlite` 初始化
- [x] 靜態檔案伺服 + path traversal 守門（`staticPath.ts`）
- [x] `GET /api/health`
- [x] `X-Content-Type-Options: nosniff`

---

## Phase 1 — Auth  `OWASP`

先做，其他模組都要靠登入態。

- [x] `users` table（id, email, password_hash, created_at）
- [x] 密碼雜湊用 `node:crypto` 的 `scrypt`（不要自己刻、不要明碼）
- [x] `sessions` table + HttpOnly cookie
- [x] `POST /api/auth/login`、`POST /api/auth/logout`
- [x] `login_events`（登入成功/失敗紀錄）
- [x] `requireAuth` middleware（未登入 → 401）

---

## Phase 2 — Event Sourcing 骨架  `ES` `CQRS`

**最重要**。先用最小 aggregate 把 `append → project → read model` 這條線跑通一次，邏輯先不管對不對。

- [x] `event_store` table（照 [design.md](../../design.md) 的欄位）
- [x] `appendEvent(aggregateType, aggregateId, expectedVersion, eventType, payload, metadata)`
  - [x] 樂觀鎖：`expectedVersion` 對不上就拒絕（並發衝突偵測，這是 ES 的核心練習點）
- [x] `loadEvents(aggregateId)` → 重建 aggregate 現狀
- [x] 同步 projection dispatcher：一個 event_type 對一個 handler
- [x] 端到端自我驗證：append 一個事件 → read model 有值

---

## Phase 3 — Workspace aggregate  `ES` `狀態機`

事件最少（4 個），拿來驗證 ES 骨架。

- [x] `workspace.created / renamed / archived / deleted`
- [x] command handler（load events → 驗證 → append）
- [x] `workspaces_read_model` projection
- [x] `GET /api/workspaces`、`POST /api/workspaces`

---

## Phase 4 — Member + 權限  `RBAC`

- [x] `member.invited / joined / role_changed / removed`
- [x] `workspace_members_read_model` projection（權限檢查全靠這張）
- [x] `requirePermission(workspaceId, minRole)` middleware — 查 members read model
- [x] 角色階層：Owner > Admin > Member > Viewer
- [x] 資源同 workspace 檢查（跨 workspace 存取 → 403）

> 建立者自動成為 Owner（`seedOwner`）；`GET /api/workspaces` 已改為只列出「我有 membership」的。
> `PATCH /api/workspaces/:id`（改名）示範 `requirePermission(id, 'Admin')`。

---

## Phase 5 — Task aggregate  `ES` `狀態機`

系統核心，事件最多，留到骨架穩了再做。

- [x] 9 個 `task.*` 事件（created / title_changed / … / archived / deleted）
- [x] 狀態機：`Todo → Doing → Review → Done` 只允許合法轉換
- [x] `tasks_read_model` projection
- [x] Task API（全部透過 command，不直接改 read model）

> 狀態機：`status_changed` 只在 Todo/Doing/Review/Done 間走（相鄰前進 + 一步回退）；`Archived` 由 `task.archived`、刪除由 `task.deleted`。
> 資源→workspace 權限：`PATCH/DELETE/archive /api/tasks/:id` 先查 `getTaskWorkspaceId` 再 `requirePermission`，補完 Phase 4 的資源層檢查。
> `createTask` 會擋 archived/deleted/不存在的 workspace（防孤兒資料）；既有 task 在 archived workspace 仍可微調（已知取捨，見 task.ts 註解）。

---

## Phase 6 — CRUD 模組（不走 ES）

[design.md](../../design.md) 已定：這幾個一律傳統 CRUD，不要手癢加進 event sourcing。

- [x] Project — `projects_read_model` 直接 CRUD
- [x] Comment — `comments` table CRUD
- [x] Attachment — upload / download / delete
  - [x] MIME 驗證、檔名處理（不信任原始檔名）
  - [x] symlink 守門（`realpath` 檢查，字串比對擋不住 symlink）
  - [x] 上傳檔一律 `nosniff`
- [x] Search — `LIKE` 掃 task / comment / project

---

## Phase 7 — Audit  `審計`

不做 `activity_logs`，`event_store` 本身就是 audit log。

- [x] 每個 append 都寫 metadata：`actor_id, ip, user_agent, request_id`
- [x] `GET /api/audit?aggregate_id=` → 直接查 `event_store`

> metadata 用 `AsyncLocalStorage`（[requestContext.ts](../../src/requestContext.ts)）per-request 注入，command 簽名不變；`request_id` 也回傳 `X-Request-Id` header。
> audit 授權：由 aggregate 推回 workspace（Workspace→自身 / Member→拆 id / Task→payload），需 Admin+，跨 workspace 擋。

---

## 橫切關注 — OWASP checklist

- [x] `nosniff`
- [x] path traversal 守門
- [x] symlink 守門（Attachment 目錄）
- [x] 每個 command 做輸入驗證（信任邊界）
- [x] SQL 全用 prepared statement（`db.prepare`，已有 pattern）
- [x] session 固定 / CSRF 防護
- [x] 登入 rate limit
