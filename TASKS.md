# 開發任務

> 對應 [DESIGN.md](DESIGN.md)。順序由簡到繁，先把 Event Sourcing 那條線跑通再往上疊。
> 每個 Phase 標注它練到的主題：ES / CQRS / RBAC / OWASP / 狀態機 / 審計。

---

## Phase 0 — 專案骨架 ✅

- [x] TS + tsx + `node:http` + `node:sqlite` 初始化
- [x] 靜態檔案伺服 + path traversal 守門（`staticPath.ts`）
- [x] `GET /api/health`
- [x] `X-Content-Type-Options: nosniff`

---

## Phase 1 — Auth 　`OWASP`

先做，其他模組都要靠登入態。

- [x] `users` table（id, email, password_hash, created_at）
- [x] 密碼雜湊用 `node:crypto` 的 `scrypt`（不要自己刻、不要明碼）
- [x] `sessions` table + HttpOnly cookie
- [x] `POST /api/auth/login`、`POST /api/auth/logout`
- [x] `login_events`（登入成功/失敗紀錄）
- [x] `requireAuth` middleware（未登入 → 401）

---

## Phase 2 — Event Sourcing 骨架 　`ES` `CQRS`

**最重要**。先用最小 aggregate 把 `append → project → read model` 這條線跑通一次，邏輯先不管對不對。

- [x] `event_store` table（照 DESIGN.md 的欄位）
- [x] `appendEvent(aggregateType, aggregateId, expectedVersion, eventType, payload, metadata)`
  - [x] 樂觀鎖：`expectedVersion` 對不上就拒絕（並發衝突偵測，這是 ES 的核心練習點）
- [x] `loadEvents(aggregateId)` → 重建 aggregate 現狀
- [x] 同步 projection dispatcher：一個 event_type 對一個 handler
- [x] 端到端自我驗證：append 一個事件 → read model 有值

---

## Phase 3 — Workspace aggregate 　`ES` `狀態機`

事件最少（4 個），拿來驗證 ES 骨架。

- [ ] `workspace.created / renamed / archived / deleted`
- [ ] command handler（load events → 驗證 → append）
- [ ] `workspaces_read_model` projection
- [ ] `GET /api/workspaces`、`POST /api/workspaces`

---

## Phase 4 — Member + 權限 　`RBAC`

- [ ] `member.invited / joined / role_changed / removed`
- [ ] `workspace_members_read_model` projection（權限檢查全靠這張）
- [ ] `requirePermission(workspaceId, minRole)` middleware — 查 members read model
- [ ] 角色階層：Owner > Admin > Member > Viewer
- [ ] 資源同 workspace 檢查（跨 workspace 存取 → 403）

---

## Phase 5 — Task aggregate 　`ES` `狀態機`

系統核心，事件最多，留到骨架穩了再做。

- [ ] 9 個 `task.*` 事件（created / title_changed / … / archived / deleted）
- [ ] 狀態機：`Todo → Doing → Review → Done → Archived` 只允許合法轉換
- [ ] `tasks_read_model` projection
- [ ] Task API（全部透過 command，不直接改 read model）

---

## Phase 6 — CRUD 模組（不走 ES）

DESIGN.md 已定：這幾個一律傳統 CRUD，不要手癢加進 event sourcing。

- [ ] Project — `projects_read_model` 直接 CRUD
- [ ] Comment — `comments` table CRUD
- [ ] Attachment — upload / download / delete
  - [ ] MIME 驗證、檔名處理（不信任原始檔名）
  - [ ] symlink 守門（`realpath` 檢查，字串比對擋不住 symlink）
  - [ ] 上傳檔一律 `nosniff`
- [ ] Search — `LIKE` 掃 task / comment / project

---

## Phase 7 — Audit 　`審計`

不做 `activity_logs`，`event_store` 本身就是 audit log。

- [ ] 每個 append 都寫 metadata：`actor_id, ip, user_agent, request_id`
- [ ] `GET /api/audit?aggregate_id=` → 直接查 `event_store`

---

## 橫切關注 — OWASP checklist

- [x] `nosniff`
- [x] path traversal 守門
- [ ] symlink 守門（Attachment 目錄）
- [ ] 每個 command 做輸入驗證（信任邊界）
- [ ] SQL 全用 prepared statement（`db.prepare`，已有 pattern）
- [ ] session 固定 / CSRF 防護
- [ ] 登入 rate limit
