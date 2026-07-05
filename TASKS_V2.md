# 開發任務 v2

> 對應 [DESIGN_V2.md](DESIGN_V2.md)，接續 [TASKS.md](TASKS.md) 已完成的 Phase 0-7。
> 順序：建立使用者 + Seeder → 忘記密碼 → Member 邀請 API → 前端串接。

---

## Phase 8 — 建立使用者 + Seeder

- [ ] `createUser(email, password)` 內部函式（複用 `hashPassword`，寫入 `users` table）
- [ ] 重複 email 的 SQLite UNIQUE 例外包裝成乾淨的 `CommandError`
- [ ] Seeder 腳本：產生 ≥30 位使用者，固定測試密碼、可預期 email（`user01@test.local` ~ `user30@test.local`）
- [ ] Seeder idempotent（`INSERT OR IGNORE`，重複執行不重複建立）
- [ ] 自我驗證：seeder 跑兩次，`users` 數量不變

---

## Phase 9 — 忘記密碼（Email 重設連結）

- [ ] `password_resets` table：`id / user_id / token_hash / expires_at / used_at`
- [ ] `POST /api/auth/forgot-password`（email → 產生一次性 token，1 小時過期）
  - [ ] email 存在與否回一模一樣的成功訊息（擋帳號枚舉，同 login 端做法）
  - [ ] 重設連結印到 server console/log（不接真實 email 服務）
- [ ] `POST /api/auth/reset-password`（token + 新密碼 → 驗證存在/未過期/未使用過 → 更新密碼、token 標記已用）
- [ ] 重設成功後該 user 其他裝置 session 全部失效（`sessions` 新增依 `user_id` 批次刪除）

---

## Phase 10 — Member 邀請 API 　`RBAC`

- [ ] `POST /api/workspaces/:id/members`（邀請，需 Admin+；email 查 `users` 找 user id，找不到回錯誤）
- [ ] `GET /api/workspaces/:id/members`（列出成員+角色）
- [ ] `PATCH /api/workspaces/:id/members/:userId`（改角色，需 Admin+；擋 Admin 任命/邀請 Owner）
- [ ] `DELETE /api/workspaces/:id/members/:userId`（移除，需 Admin+；IDOR 檢查：確認 `:userId` 真的是該 workspace 成員）
- [ ] `POST /api/workspaces/:id/members/join`（`joinWorkspace`，讓被邀請者自己接受邀請）
- [ ] `archiveWorkspace` / `deleteWorkspace` 加守門：查 `workspace_members_read_model` active 成員數必須 == 1
- [ ] 同守門邏輯套用到 Owner 自我移除/降級（非唯一成員時擋）

---

## Phase 11 — 前端串接

- [ ] 單頁 hash routing：`{hash 前綴: renderFn}` 查表 + `switch`，無框架
- [ ] 登入頁（呼叫既有 `/api/auth/login`，401 導回登入）
- [ ] Workspace 列表 + 建立 + 切換
- [ ] Task 列表（顯示狀態機合法轉換，非法轉換不給選）
- [ ] Comment（列表 + 新增）
- [ ] Attachment（上傳 + 列表 + 下載連結，走下載非內嵌渲染）
- [ ] Search 輸入框
- [ ] Member 管理頁（依賴 Phase 10）
- [ ] Audit 檢視頁
- [ ] 所有使用者輸入渲染一律 `textContent`，不用 `innerHTML`

---

## 橫切關注 — OWASP checklist（v2 新增部分）

- [ ] 忘記密碼 token：`randomBytes` 產生、存 hash、單次使用、有過期時間
- [ ] Member 邀請：權限升級檢查（Admin 不能任命 Owner）、IDOR 檢查、最後一個 Owner 防呆
- [ ] 前端 XSS：使用者輸入一律 `textContent`
