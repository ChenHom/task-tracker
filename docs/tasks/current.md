# 開發任務（目前狀態）

> 對應 [design.md](../../design.md)，接續 [history.md](history.md) 已完成的 Phase 0-7。
> 順序：建立使用者 + Seeder → 忘記密碼 → Member 邀請 API → 前端串接。
> 最後巡檢：2026-07-10；Phase 8-11 與 Phase 12 harness 已有實作證據，Phase 13 是目前交接。

---

## Phase 8 — 建立使用者 + Seeder ✅

- [x] `createUser(email, password)` 內部函式（複用 `hashPassword`，寫入 `users` table）
- [x] 重複 email 的 SQLite UNIQUE 例外包裝成乾淨的 `CommandError`
- [x] Seeder 腳本：產生 ≥30 位使用者，固定測試密碼、可預期 email（`user01@test.local` ~ `user30@test.local`）
- [x] Seeder idempotent（`createUser` 對已存在 email 丟 `CommandError`，seeder catch 掉即跳過）
- [x] 自我驗證：seeder 跑兩次，`users` 數量不變（[seed.test.ts](../../src/seed.test.ts) + 實際對 dev.db 跑兩次確認 30 筆）

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
> 重設前建立的 session 在重設後也全部失效（`getSessionUser` 回 null）。單元測試涵蓋 token hash 化、過期、單次使用等情境（[auth.test.ts](../../src/auth.test.ts)）。

---

## Phase 10 — Member 邀請 API  `RBAC` ✅

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
> Admin 動既有 Owner 被擋、Owner 自我降級/移除需唯一成員、`countActiveMembers` 本身（[member.test.ts](../../src/member.test.ts)），
> 以及 `archiveWorkspace`/`deleteWorkspace` 在非唯一成員時被拒絕（[workspace.test.ts](../../src/workspace.test.ts)）。

---

## Phase 11 — 前端串接 ✅

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
- [x] 混合車隊：Owner 開場=Claude Sonnet 5、中場/收尾/repair=Codex gpt-5.6-sol；user02=Codex gpt-5.3-codex；user03=Codex gpt-5.6-terra；user04=Codex gpt-5.4-mini；user05=Codex gpt-5.6-luna
- [x] 主題 Dogfooding：owner prompt 內嵌本專案真實技術債清單（ponytail: 註記）出題
- [x] 全員 QA 規則：可重現的系統問題建 `[BUG]` task（重現步驟/預期 vs 實際/原始回應），owner 收尾 triage
- [x] `--smoke` 模式 + 結算統計（tasks/comments/event_store/[BUG] 清單，直接讀 dev.db）
- [x] 各模式寫入 prompt artifacts、`report.md` 與 `report.json`；fast/deep 場在 branch 驗證後另寫 review packets
- [x] 支援 `self-directed` / `product-ideation` / `brain` scenario，以及 `--fast` / `--smoke` / `--sweep owner|team`
- [x] member session 統一由 driver commit；error/timeout 不提交，dirty worktree 在 review packet 標 FAIL 並保留續作
- [x] CI 結果改為 `PASS` / `FAIL` / `SKIP`；缺 tooling 或跨多個子專案不再製造假綠燈，SKIP 必須由 Owner 人工驗證
- [x] scenario 啟用前驗證 Git top-level/master，commit 前再驗 worktree/branch；legacy `technical-debt` report 明確映射，未知 scenario fail closed
- [x] `sim-logs/.run.lock` 序列化 manual/timer 流程並回收 dead-PID lock；平行 member 全部 settle 後才解鎖
- [x] Claude quota probe 只影響 owner 預算；`team` 不做全域 probe，`both` 在 Claude 不可用時仍保留 Codex member 預算
- [x] `sim/tsconfig.json` 納入 `npm test`，讓 sim harness 也受 strict TypeScript 檢查
- [x] `docs/operations.md` 記錄手動模式、scenario、systemd owner/team timers、logs、lock 與權限邊界
- [x] 跑完整端到端 `--fast` self-directed sprint（`sim-run-1783392991269`）
- [ ] 跑深度 `npm run sim`（含 r2/r3 與中場 owner 審查）

> 實測（smoke）：bootstrap 5 人就位；haiku member 正確走「無指派→建詢問 task」分支（3/12 curl）；
> codex member 同樣完成（曾卡在 `codex exec` 等 piped stdin EOF，已修：spawn 後立即 `child.stdin.end()`）。
> Fast 場於 2026-07-07 執行 18 分 21 秒：7 題全部 Done，4 支成員 branch 的 tsc/test 均 PASS，產生 26 則留言與 47 個 events。
> 本機證據：`sim-logs/sim-run-1783392991269/report.md`。產物/報告/scenario 實作主要來自 `3721b50`；後續 sandbox 路徑與重複 escalation 修正為 `e9fdb69`。
> 2026-07-10 hardening 保持單檔/stdlib 架構：member tool allowlist 是避免誤操作的操作政策，不是 hostile-code sandbox；driver 仍會執行 branch 的 tsc/test。需要執行不受信任程式碼時，應另放進 container/VM，而不是擴張這個 harness 的權限規則。

---

## Phase 13 — AI session 巡檢交接（2026-07-10）

> 來源：`data/dev.db` 的目前看板、`sim-logs/` 最新 sweep，以及 Claude/Codex session 記錄。下列功能必須用 `self-directed` 或 `product-ideation` scenario，讓 `repoRoot` 指向本 repo；不放寬 sandbox 白名單。

### 跨 workspace 搬移 task（原 `451c2509`，已轉移至 `11983af5` @ workspace `d9da9945`，High）

> `451c2509` 卡在 workspace `11db3331`（scenario=brain，repoRoot 不合）32 小時後人工轉移；本功能規格未變，下列 checklist 仍待實作。詳見 [2026-07-10-crossrepo-workspace-routing.md](../superpowers/plans/2026-07-10-crossrepo-workspace-routing.md)。

- [ ] `moveTask(actorId, taskId, targetWorkspaceId)` append `task.moved`，payload 含 source/target workspace
- [ ] projection 同步更新 `workspace_id`，並清掉舊 workspace 所屬的 `project_id`
- [ ] actor 在 source/target 均至少為 Member；source/target 都必須 active；archived task 不可搬移
- [ ] assignee 不在 target 時走既有 invite/join 流程，不隱式寫 read model；這是只限本 task 原 assignee、固定 Member 角色的受限例外，不得變成任意邀人或指定角色的旁路
- [ ] 已存在 pending invite 不可讓搬移失敗；測試必須證明受限例外沒有放寬一般 Member API 的 Admin+ 邊界
- [ ] 新增 `POST /api/tasks/:id/move`，使用既有 command error 映射
- [ ] 自動測試覆蓋成功、權限不足、inactive workspace、archived task、`project_id` 清空與 pending invite
- [ ] 真 HTTP smoke 用 A=source only、B=target only、C=雙邊成員驗證搬移前後 `GET/PATCH/comments` 權限完整反轉

> 最新 user03 sweep 未改程式。Brain repo 的 `20e8b2c` 只包含 `.jar-user03.txt`，不是 task-tracker 功能實作，不應合併當作交付。

### Workspace 封存入口（`de228444`，Todo / Medium）

- [x] domain 已有 `archiveWorkspace` / `deleteWorkspace` 與唯一 Owner 守門
- [ ] 確認並新增 archive HTTP 路由，保留後端權限為唯一權威；delete endpoint 不在本題範圍
- [ ] 前端 workspace 管理頁提供封存操作與清楚確認，不先做批次管理

### 台北時區顯示（`1f369e88`，Todo / Medium）

- [ ] 系統產生的任務/留言/審計時間在顯示層統一使用 `Asia/Taipei` (`+08:00`)
- [ ] 資料庫與 API 繼續儲存/傳輸 UTC ISO timestamp，不回填改寫歷史時間
- [ ] 不自動重寫使用者輸入的 title/description/comment 自由文字

### 巡檢發現

- [ ] 欄內新增 UI 會將 `status` 送到 create-task API，但後端目前忽略該欄位並固定建立 Todo；Doing/Review 欄的新增結果與 UI 預期不一致。

---

## 橫切關注 — OWASP checklist（v2 新增部分）

- [x] 忘記密碼 token：`randomBytes` 產生、存 hash、單次使用、有過期時間
- [x] Member 邀請：權限升級檢查（Admin 不能任命 Owner）、IDOR 檢查、最後一個 Owner 防呆
- [x] 前端 XSS：使用者輸入一律透過 `textContent` 渲染（共用 `el()` helper 位於 `public/js/utils.js`；
      各 `public/js/views/*` 模組的 `innerHTML` 只用於無使用者變數插值的靜態骨架 markup）

---

## Phase 14 — 看板與任務詳情加強功能 ✅

- [x] 在任務描述跟留言輸入框（含編輯模式）中，打上 `@` 可以選擇工作區成員（支援名稱與 Email 模糊搜尋，選取後插入 `@Name `）。
- [x] 留言板顯示時，會解析並渲染 `@Name` 為專屬的 Neo-brutalist 成員標籤 (`.rich-mention`)，hover 可查看 Email。
- [x] 打上 `#` 可以選擇任務內的留言（顯示為 `#N - 作者: 摘要`，支援編號、作者、摘要模糊搜尋，選取後插入 `#N `）。
- [x] 留言板顯示時，會解析並渲染 `#N` 為留言連結 (`.rich-comment-link`)，點擊時平滑捲動至目標留言並觸發 `highlight-flash` 閃爍動畫效果。
- [x] 任務送出留言時，或者失去焦點（blur）時，留言輸入框會自動收合恢復為原本的單行高度（`38px`）。
- [x] 任務卡片上方改以 CSS 偽元素 `::before` 顯示任務短 ID（UUID 前 8 碼），格式為 `::shortId`，呈現小字、灰色、不搶眼樣式。
- [x] 點擊卡片左上角的偽元素區域時，會攔截事件冒泡，並彈出操作選單，提供 **開啟**、**分享** (複製連結) 與 **複製 id** 等操作。
- [x] 打上 `::` 可以選擇工作區內的其他任務（支援短 ID 及任務標題模糊搜尋，選取後插入 `::shortId `）。
- [x] 留言板顯示時，會解析並渲染 `::shortId` 為翡翠綠色任務連結 (`.rich-task-link`)，hover 顯示完整標題，點擊會無縫切換 Hash 路由，在 Modal 中加載目標任務。

> 實測：Eslint 靜態檢查與 Jest/sim 測試均 100% 通過。實際操作上，`@`、`#` 與 `::` 能流暢地進行混合自動補全與鍵盤導覽；對 `::` 短 ID 點擊時彈出選單與偽元素座標點擊比對功能皆符合預期，大幅提升使用者在看板上的便利性與協作體驗。

---

## Phase 15 — Commenter 與主協作工作區 ✅

- [x] 新增 `Commenter` 角色與 RBAC／API 權限矩陣；可建立 Todo 討論及留言，但不可修改 task、project 或附件
- [x] 固定主協作工作區名稱、user01 Owner、其他 user Commenter，並由 startup／login 同步修復
- [x] 主工作區討論預設、legacy task 正規化與 `task.discussion_started` 單一事件已由 domain 測試覆蓋
- [x] 前端依角色收斂控制，並安全自動連結完整 HTTP(S) URL、保留網址尾端中英文標點
- [x] SIM sweep 固定發現主工作區、排除 policy task、依 target repo 路由，且 main 不占 canonical repo slot
- [x] feature branch 已通過 `npm test`、`npm run build`、`git diff --check` 與 focused `sim/run.test.ts`
- [x] 合併至 `master`、build、restart 與正式服務部署驗證
- [x] DB readback：固定名稱、30 位使用者角色、單一 policy task、legacy task title
- [x] 完整 Commenter／Owner HTTP smoke 與交接流程驗證
- [x] Commenter 可在任何 workspace 修改自己建立 task 的 description；標題、狀態、屬性、附件與他人 task 仍不可修改
- [ ] 經明確人工授權執行 live `npm run sim -- --sweep owner`

> 2026-07-12 rollout：`master` merge `efbeb4b` 後 `npm test`、`npm run build`、health check 全數通過。DB 為 1 Owner + 29 Commenter、唯一規則 task，兩筆 legacy task 已加上 `[討論]`。HTTP smoke 驗證 Commenter 可建討論／留言但改狀態為 403，user01 以單一 `task.discussion_started` 完成 Doing 指派，並建立 canonical task `af06f594-682c-4437-aea5-d71eb354471c`、回寫完整 URL、推進 Review → Done。Live AI sweep 未執行。

> 2026-07-12 description rollout：`master` fast-forward 至 `4794674` 後完整測試、build 與 health check 通過。Commenter 自建 task 描述 PATCH 為 200，標題／狀態為 403，他人描述為 400；user02 在非主工作區仍是 Member，標題與描述 PATCH 均為 200。
