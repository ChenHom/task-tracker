# 開發任務 v2

> 對應 [DESIGN_V2.md](DESIGN_V2.md)，接續 [TASKS.md](TASKS.md) 已完成的 Phase 0-7。
> 順序：建立使用者 + Seeder → 忘記密碼 → Member 邀請 API → 前端串接。

---

## Phase 8 — 建立使用者 + Seeder ✅

- [x] `createUser(email, password)` 內部函式（複用 `hashPassword`，寫入 `users` table）
- [x] 重複 email 的 SQLite UNIQUE 例外包裝成乾淨的 `CommandError`
- [x] Seeder 腳本：產生 ≥30 位使用者，固定測試密碼、可預期 email（`user01@test.local` ~ `user30@test.local`）
- [x] Seeder idempotent（`createUser` 對已存在 email 丟 `CommandError`，seeder catch 掉即跳過）
- [x] 自我驗證：seeder 跑兩次，`users` 數量不變（[seed.test.ts](src/seed.test.ts) + 實際對 dev.db 跑兩次確認 30 筆）

> 實測：seed 出來的帳號可透過 `POST /api/auth/login` 真的登入（`npm run seed` 產生，密碼固定 `test1234`）。

---

## Phase 9 — 忘記密碼（Email 重設連結）✅

- [x] `password_resets` table：`id / user_id / token_hash / expires_at / used_at`
- [x] `POST /api/auth/forgot-password`（email → 產生一次性 token，1 小時過期）
  - [x] email 存在與否回一模一樣的成功訊息（擋帳號枚舉，同 login 端做法）
  - [x] 重設連結印到 server console/log（不接真實 email 服務）
- [x] `POST /api/auth/reset-password`（token + 新密碼 → 驗證存在/未過期/未使用過 → 更新密碼、token 標記已用）
- [x] 重設成功後該 user 其他裝置 session 全部失效（`sessions` 新增依 `user_id` 批次刪除）

> 實測：以 curl 打 `/api/auth/forgot-password`，存在與不存在的 email 回應一字不差；只有存在時 console 印出重設連結。
> 用印出的 token 打 `/api/auth/reset-password` 成功改密碼，新密碼可登入、舊密碼失效，同一 token 重打第二次回 400；
> 重設前建立的 session 在重設後也全部失效（`getSessionUser` 回 null）。單元測試涵蓋 token hash 化、過期、單次使用等情境（[auth.test.ts](src/auth.test.ts)）。

---

## Phase 10 — Member 邀請 API 　`RBAC` ✅

- [x] `POST /api/workspaces/:id/members`（邀請，需 Admin+；email 查 `users` 找 user id，找不到回錯誤）
- [x] `GET /api/workspaces/:id/members`（列出成員+角色）
- [x] `PATCH /api/workspaces/:id/members/:userId`（改角色，需 Admin+；擋 Admin 任命/邀請 Owner）
- [x] `DELETE /api/workspaces/:id/members/:userId`（移除，需 Admin+；IDOR 檢查：確認 `:userId` 真的是該 workspace 成員）
- [x] `POST /api/workspaces/:id/members/join`（`joinWorkspace`，讓被邀請者自己接受邀請）
- [x] `archiveWorkspace` / `deleteWorkspace` 加守門：查 `workspace_members_read_model` active 成員數必須 == 1
- [x] 同守門邏輯套用到 Owner 自我移除/降級（非唯一成員時擋）

> 實測：以 `npm run seed` 的 user01/user02/user03 對真實 dev server 跑過完整流程——user01 建立 workspace 後自動為 Owner；
> `POST .../members` 邀請 user02 為 Member，`GET .../members` 只列出已 join 的人（user02 join 前不出現）；
> `POST .../members/join` 讓 user02 真的加入、之後才出現在列表；Member（user02）打 `POST .../members` 邀請別人回 403；
> owner 把 user02 升為 Admin 後，Admin 邀請/任命 Owner 一律回 400「只有 Owner 能任命 Owner」，但 Admin 邀一般角色成功；
> `PATCH`/`DELETE .../members/:userId` 對不是該 workspace 成員的 `:userId` 回 404（IDOR 檢查）；
> Owner 在還有其他成員時嘗試自我移除回 400，移除到只剩自己一人後 `archiveWorkspace`（直接呼叫函式驗證，此 phase 未加 HTTP 路由）才成功；
> 邀請不存在的 email 回 400「找不到該 email 對應的使用者」，不會靜默成功；`POST .../members/join` 與 `PATCH/DELETE .../members/:userId`
> 這組容易撞在一起的路由分開驗證過，join 不會被當成 `:userId` 吃掉。單元測試涵蓋權限升級（Admin 任命/受任 Owner）、
> Admin 動既有 Owner 被擋、Owner 自我降級/移除需唯一成員、`countActiveMembers` 本身（[member.test.ts](src/member.test.ts)），
> 以及 `archiveWorkspace`/`deleteWorkspace` 在非唯一成員時被拒絕（[workspace.test.ts](src/workspace.test.ts)）。

---

## Phase 11 — 前端串接

- [x] 單頁 hash routing：`{hash 前綴: renderFn}` 查表 + `switch`，無框架
- [x] 登入頁（呼叫既有 `/api/auth/login`，401 導回登入）
- [x] Workspace 列表 + 建立 + 切換
- [x] Task 列表（狀態 `<select>` 列出 Todo/Doing/Review/Done 全部四個選項，不在前端硬編合法轉換；
      PATCH 交給後端狀態機判斷，非法轉換由後端回 400、前端原樣顯示錯誤訊息 — 落實「權限/規則判斷不能只在前端做」）
- [x] Comment（列表 + 新增）
- [x] Attachment（上傳 + 列表 + 下載連結，走下載非內嵌渲染）
- [x] Search 輸入框
- [x] Member 管理頁（依賴 Phase 10）
- [x] Audit 檢視頁
- [x] 所有使用者輸入渲染一律 `textContent`，不用 `innerHTML`

> 實測：`npx tsc --noEmit` 與 `npm test` 皆乾淨通過。另起 `npx tsx src/server.ts` 手動以 curl 模擬瀏覽器 fetch 行為，
> 走過完整流程並確認回應形狀與 `public/app.js` 的呼叫方式一致：
> `POST /api/auth/login` 登入拿到 `Set-Cookie: session=...`、`GET/POST /api/workspaces` 列出並建立
> workspace、`POST /api/workspaces/:id/tasks` 建立 task、`PATCH /api/tasks/:id` 驗證合法轉換
> Todo→Doing 成功、非法轉換 Todo→Done 回 400 `{"error":"不允許的狀態轉換：Todo → Done"}`（前端原樣顯示，
> 未在 JS 端擋）、`POST/GET /api/tasks/:id/comments` 新增並列出留言（含 `<script>` 內容確認走
> `textContent` 不會被解析）、以 raw bytes + `X-Filename` header 上傳附件並用
> `GET /api/attachments/:id` 下載回原始內容、確認回應帶 `Content-Disposition: attachment` 與
> `X-Content-Type-Options: nosniff`、`GET /api/search?...` 與 `GET /api/audit?...` 回傳形狀與
> `search.ts`/`audit.ts` 定義相符、未帶 cookie 打 `/api/workspaces` 收到 401（對應前端的導回登入邏輯）。
> 未動用瀏覽器 headless 工具，但已逐一比對 `public/app.js` 的 fetch 呼叫路徑/方法/body 與上述 curl 完全一致。

---

## Phase 12 — AI 模擬使用者（sim harness，Claude + Codex 混合車隊）

- [x] `sim/run.ts` driver：純 fetch bootstrap（建模擬 workspace、邀請 user02-05、join）→ spawn headless 子行程
- [x] 混合車隊：Owner=user01（`claude -p` opus，開場建 task/收尾巡場）；Member user02/03（`claude -p` haiku）、user04/05（`codex exec` gpt-5.4-mini，走 ChatGPT 額度）
- [x] 主題 Dogfooding：owner prompt 內嵌本專案真實技術債清單（ponytail: 註記）出題
- [x] 全員 QA 規則：可重現的系統問題建 `[BUG]` task（重現步驟/預期 vs 實際/原始回應），owner 收尾 triage
- [x] `--smoke` 模式 + 結算統計（tasks/comments/event_store/[BUG] 清單，直接讀 dev.db）
- [ ] 跑完整一場（`npm run sim`，約 15-25 分鐘：opus×2 + haiku×6 + gpt-5.4-mini×6）

> 實測（smoke）：bootstrap 5 人就位；haiku member 正確走「無指派→建詢問 task」分支（3/12 curl）；
> codex member 同樣完成（曾卡在 `codex exec` 等 piped stdin EOF，已修：spawn 後立即 `child.stdin.end()`）。
> `tsc`（standalone flags 檢查 sim/run.ts）與 `npm test` 均乾淨；sim/ 不在 tsconfig include，不影響 build。

---

## 橫切關注 — OWASP checklist（v2 新增部分）

- [x] 忘記密碼 token：`randomBytes` 產生、存 hash、單次使用、有過期時間
- [x] Member 邀請：權限升級檢查（Admin 不能任命 Owner）、IDOR 檢查、最後一個 Owner 防呆
- [x] 前端 XSS：使用者輸入一律 `textContent`（`public/app.js` 的 `el()` helper 一律用 `textContent`；
      `innerHTML` 只用在檔案內自己寫死、無變數插值的靜態骨架 markup）
