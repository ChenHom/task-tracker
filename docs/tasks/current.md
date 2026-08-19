# 開發任務（目前狀態）

> 對應 [design.md](../../design.md)，接續 [history.md](history.md) 已完成的 Phase 0-7。
> 順序：建立使用者 + Seeder → 忘記密碼 → Member 邀請 API → 前端串接。
> 最後巡檢：2026-08-18；Phase 8-11 與 Phase 12 harness 已有實作證據，Phase 25 為目前最新交付，Phase 26 階段 1-3 已實作，階段 4 待做。

---

## ⚠️ 2026-07-29 量測：sim 車隊全速空轉，這是當前最該追的問題

| 指標 | 07-12～07-17 | 07-18～07-28 |
|---|---|---|
| sweep tick | 每天 ~72 | **每天 ~72（一天沒少）** |
| driver commit / owner merge | 每天 2–7 | **11 天總共 3** |
| 新建 task（工作源頭） | 每天 2–16 | **07-19～07-27 連續九天掛零** |
| `[ESCALATE]` | 六天內 110 則 | 12 天內 2 則 |

11 天、約 790 次 AI sweep，產出 3 個 commit。**escalate 減少不是因為阻塞解除，是因為沒有工作在流動。**

已知原因之一：`75e2033`（07-23）讓主協作討論的每則徵詢留言都回 HTTP 400，而主討論是新工作的唯一源頭。已於 07-29 修復（`c145e96` 消除 `src/` ↔ `sim/` 的協議字串漂移、`7cd4fa9` 移除等待窗口守門）。

### 主因（07-29 查明）：notification gate 吃掉了 94% 的工作區 owner session

先前寫「斷流從 07-19 開始、成因不明」是錯的。實際起點是 **07-16 12:30**，機制是 notification gate：

```
[12:32:22] [owner-巡檢-d9da9945] notification gate login 失敗，略過一般 session：TypeError: fetch failed
```

gate 取不到 cookie 就 `略過一般 session` —— 整個 owner 巡檢直接不跑。sim-logs 統計（07-16 12:30 ～ 07-29 00:44 gate 停用為止）：

| | 次數 |
|---|---|
| 排到 `owner-巡檢-d9da9945`（工作區）的 tick | 577 |
| gate 失敗被略過 | **540** |
| 真的跑到 owner session | **37**（13 天，約每天 2.8 次，設計值 48） |
| 主工作區 `owner-巡檢-11a82028` 失敗 | **0** |

只有工作區會壞：`sweepCandidateUsesRepoSlot()` 讓主工作區跳過 `verifyBranches`，所以它的 gate login 緊接在 `sim/run.ts:2173` 的 login 之後；工作區的 gate login 則在 CI 預跑之後、隔了約 10 秒才發出。

**`TypeError: fetch failed` 的底層原因仍未查明。** 那行只印 `String(error)`，540 次失敗沒有一次留下 errno。已排除（皆為本機實測，非推論）：

| 假說 | 結果 |
|---|---|
| CI 負載打爆 server | **推翻**：5 路平行 `npm test` 351 秒、1166 次取樣，連線層失敗 0，最慢 36ms |
| server 重啟 | **推翻**：journald 顯示 07-28 全天 0 次重啟，同期 gate 仍每天失敗 48 次 |
| keep-alive socket 在靜默後失效 | ~~推翻~~ → **這一列判錯了，它就是成因**，見下方 07-30 段 |
| fd / process 上限 | 排除：`LimitNOFILE=1048576` |
| login rate limit | 排除：回 HTTP 429，`login()` 會丟 `失敗: 429`，不是 `TypeError` |

**修正與驗證**：`cd92ec7`（07-29 10:23）讓 owner 路徑改用 `:2173` 已取得的 `ownerCookie`（`() => Promise.resolve(ownerCookie)`）——**那次會失敗的 login 呼叫不存在了**，與底層成因無關。07-29 22:49 以 `SIM_NOTIFICATION_GATE=1` 實跑驗證：在 5 路平行 `npm test` 負載結束的同一秒取 cookie 成功、兩筆未讀通知都解析出 prompt、gate 放行。

**仍未處理**：member 路徑（`sim/run.ts:1800`、`:2290`）與非 sweep 的完整 sim run（`:1823`、`:1853`、`:1868`、`:1882`）還是直接 `login()`，同一個坑沒補；且 gate 自 `15e2641`（07-29 00:44）起仍停用，要恢復必須在 timer wrapper 設 `SIM_NOTIFICATION_GATE=1`。診斷缺口已補：`describeError()` 會把 `error.cause` 的 errno 印出來，下次再犯就有資料。

### 2026-07-30 結案：成因是閒置 keep-alive socket，07-29 的排除表判錯了一列

07-30 手動跑 owner tick 收殘留看板時當場重現，連跑三次拿到完整因果鏈：

| tick | 結果 |
|---|---|
| 1（16:43） | `[owner-巡檢-d9da9945] [notification] gate failed: TypeError: fetch failed` —— 還是那七個字 |
| 2（16:51） | `gate failed: TypeError: fetch failed（cause: SocketError UND_ERR_SOCKET other side closed）` |
| 3（16:53） | gate 放行，owner session 正常跑完並收掉 Review 中的 task |

**為什麼 07-29 的 `describeError()` 沒生效**：`cd92ec7` 只把它套在兩個 login 失敗處（`sim/run.ts:841`、`:1094`），`processNotificationGate()` 自己的 snapshot／readback／單筆 notification 失敗，以及 notification-sweep，四處全是 `String(error)`。而 07-16 起真正在爆的就是 gate 內部的 `GET /api/notifications`，不是 login。→ `a5d6f8a` 四處補齊。

**真正的成因**：sweep 先跑數十秒的 CI 預跑（`verifyBranches`），期間 server 關掉閒置的 keep-alive 連線，undici 仍從 pool 拿同一條 socket 送 gate 的第一個 GET，於是 `UND_ERR_SOCKET other side closed`。這正是 07-29 表格裡被判成「推翻」的那一列——當時的靜默實測沒重現，是因為它量的是「乾淨的靜默」，而實際情境是 CI 預跑期間 socket 被 pool 保留、server 側先關。也解釋了為什麼**只有工作區會壞、主工作區 0 失敗**：`sweepCandidateUsesRepoSlot()` 讓主工作區跳過 `verifyBranches`，它的 gate 請求緊接在 login 之後發出，socket 還沒閒置到被關。這一條在 07-29 已經寫在文件裡，只差沒把它跟 keep-alive 連起來。

**修正**：`afb583f` 讓 `sim/run.ts` 的 `api()` 對這類「請求送達 server 前就斷線」的 **GET** 重試一次（重開連線）。非 GET 不重試——錯誤本身無法分辨 server 是否已套用，重送會變成兩則留言或兩次狀態轉移，那類失敗留給下個 tick 自癒。判定函式 `isStaleSocketError()` 只認 `UND_ERR_SOCKET` / `ECONNRESET`；`ECONNREFUSED`（server 沒起來）重試也沒用，測試明確擋掉這個誤判。

**驗證**：`npm run typecheck` rc=0、`node --import tsx sim/run.test.ts` OK、第三次 owner tick 實跑 gate 放行。

**仍未處理**（沿用上面那條，範圍不變）：member 路徑與非 sweep 完整 sim run 的直接 `login()` 沒補；timer wrapper 已有 `SIM_NOTIFICATION_GATE=1`，但 timer 目前是停的。

---

## 2026-07-30 殘留看板清空（Doing 4 + Review 8 → 0）

清掉累積的 12 個 Doing/Review task。盤點後發現**六項安全修補裡有五項的程式碼與測試早就在 master**，只是 task 狀態卡住沒人收：`search` LIKE escape（`escapeLike` + `ESCAPE` 子句）、`attachment` symlink 硬化（`resolveInside` + `realpathSync`）、`clientIp` X-Forwarded-For（`src/clientIp.ts` + `TRUST_PROXY`）、cookie `Secure`（`COOKIE_SECURE`）、`cleanupExpiredSessions()`。真正缺的只有兩項，已補（`4664de9`）：

- **`src/rateLimit.ts` 加 `maxKeys`**（預設 10000）：新 key 且已達上限時，`cleanup()` 先清過期，仍滿則淘汰 Map 最舊一筆（Map 保插入序）。對外介面與既有限流行為不變。淘汰的是最早「第一次出現」的 key、不是最久沒用的，要真 LRU 再說（已留 ponytail 註記）。
- **全域 `#/tasks` 的階層式 Esc 返回**：新增 `public/js/escBack.js`（`shouldEscBack()` 純函式 + `OVERLAY_SELECTOR`），`app.js` 在**模組載入時**以 window capture 註冊 keydown——早於 task-detail modal 的 listener，所以讀到的是「按鍵開始時」的介面狀態，同一次事件不會關完 modal 又接續導頁。`kanban.js` 的 task-action popup 補上 Esc 關閉，讓第一次 Escape 只關最上層 menu。導向 `#/workspaces`（task 描述寫的 `#/workspace` 在本 repo 沒有對應路由）。

驗證：`npm test` rc=0、`npm run lint` rc=0，加上 Playwright 桌面 Chrome 實跑六項 smoke（`#/tasks`→`#/workspaces`；modal 開啟時 Esc 只關 modal 回 `#/tasks`；menu 開啟時首按只關 menu、次按才導頁；焦點在 select／contenteditable 不導頁；`isComposing` 不導頁；`#/search` 等其他頁面行為不變）。

### 其中 11 個 task 是由 workspace Owner 直接收的，不是 owner sweep 收的

它們散在「真實 Sprint 2026-07-06 09:37／10:17／14:09」與「模擬場」四個 workspace，而 **owner sweep 永遠掃不到那裡**：`sweep()` 的候選名單來自掃描 `sim-logs/*/report.json` 的 `workspaceId`，外加固定補上的 main（`11a82028`）與 canonical（`d9da9945`）；那四個 workspace 沒有 report.json。手動 tick 的輸出實測只列出 `d9da9945` 與 `11a82028`，佐證這點。

要讓 sweep 掃到就得補造 report.json，等於復活死掉的 AI sprint 還會觸發 member session，比直接結案糟——所以改由 workspace Owner（`user01@test.local`）逐一 PATCH `Done`，每個 task 都留了實作位置、測試位置、本次實跑證據與結案理由。canonical workspace 的那一個（`027c0052` 全域 tasks Esc）留給 owner，第三次 tick 由它自己審完收 `Done`。

**這是重複交付的根源**：同一份安全修補在 09:37／10:17／14:09 三個 sprint 各開了一次 task（`rate limiter maxKeys`、`clientIp XFF`、`cookie Secure` 各兩份），做完進了 master 卻沒人收，下一個 sprint 又開一次。

**下一步是量測，不是實作**：恢復 gate 後看新建 task 是否回到每天 2 個以上、commit 是否回來。不是把 production coordinator 上線 —— 後者解的是 branch 衝突，那類 escalate 在 07-17 之後就幾乎不再發生（判準見 [production-sim-coordinator plan](../superpowers/plans/2026-07-22-production-sim-coordinator.md) 任務 11 開頭）。

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

## Phase 12 — AI 模擬使用者（sim harness，Claude + Codex + Antigravity 混合車隊）

- [x] `sim/run.ts` driver：純 fetch bootstrap（建模擬 workspace、邀請 user02-06、join）→ spawn headless 子行程
- [x] 歷史混合車隊：Owner 開場=Claude Sonnet 5、中場/收尾/repair=Codex gpt-5.6-sol；user02=Codex gpt-5.3-codex；user03=Codex gpt-5.6-terra；user04=Codex gpt-5.4-mini；user05=Codex gpt-5.6-luna；user06 notification preflight 曾使用 Codex gpt-5.4-mini，正常工作=Claude claude-sonnet-5（現行主工作區 safe discussion route 見 Phase 24）
- [x] 主題 Dogfooding：owner prompt 內嵌本專案真實技術債清單（ponytail: 註記）出題
- [x] 全員 QA 規則：可重現的系統問題建 `[BUG]` task（重現步驟/預期 vs 實際/原始回應），owner 收尾 triage
- [x] `--smoke` 模式 + 結算統計（tasks/comments/event_store/[BUG] 清單，直接讀 dev.db）
- [x] 各模式寫入 prompt artifacts、`report.md` 與 `report.json`；fast/deep 場在 branch 驗證後另寫 review packets
- [x] 支援 `self-directed` / `product-ideation` / `brain` scenario，以及 `--fast` / `--smoke` / `--sweep owner|team`
- [x] member session 統一由 driver commit；error/timeout 不提交，dirty worktree 在 review packet 標 FAIL 並保留續作
- [x] CI 結果改為 `PASS` / `FAIL` / `SKIP`；缺 tooling 或跨多個子專案不再製造假綠燈，SKIP 必須由 Owner 人工驗證
- [x] scenario 啟用前驗證 Git top-level/master，commit 前再驗 worktree/branch；legacy `technical-debt` report 明確映射，未知 scenario fail closed
- [x] `sim-logs/.run.lock` 序列化 manual/timer 流程並回收 dead-PID lock；平行 member 全部 settle 後才解鎖
- [x] 每個既有自動 Owner／member session 先處理登入當下的未讀通知；主工作區需驗證新的非自我 mention 留言後才已讀，來源 403/404 會記錄並清除，其他失敗保留未讀並跳過該 actor 的一般工作（不含前端通知 UI 或 user09 runner）
- [x] Owner runner probe 只影響 owner 預算；`team` 不做全域 probe，member 各自依 runner 執行。user06 的舊 notification preflight 使用 Codex gpt-5.4-mini 僅為歷史設定；現行主工作區 notification 改走 Phase 24 的 Claude safe discussion，正常工作使用 Claude claude-sonnet-5 且無 AGY fallback；2026-07-16 AGY 試行沒有產生副作用，僅保留為歷史證據
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

> `451c2509` 卡在 workspace `11db3331`（scenario=brain，repoRoot 不合）32 小時後人工轉移。詳見 [2026-07-10-crossrepo-workspace-routing.md](../superpowers/plans/2026-07-10-crossrepo-workspace-routing.md)。
> **2026-07-17 使用者裁定：本項直接視為 done，不再處理。** 註：master 程式碼已有 `moveTask`（`src/task.ts:305`）、`task.moved` projection（`src/task.ts:429`）與 `POST /api/tasks/:id/move`（`src/server.ts:518`）實作；下列 checklist 未逐項驗證（未驗證）。

- [x] `moveTask(actorId, taskId, targetWorkspaceId)` append `task.moved`，payload 含 source/target workspace
- [x] projection 同步更新 `workspace_id`，並清掉舊 workspace 所屬的 `project_id`
- [x] actor 在 source/target 均至少為 Member；source/target 都必須 active；archived task 不可搬移
- [x] assignee 不在 target 時走既有 invite/join 流程，不隱式寫 read model；這是只限本 task 原 assignee、固定 Member 角色的受限例外，不得變成任意邀人或指定角色的旁路
- [x] 已存在 pending invite 不可讓搬移失敗；測試必須證明受限例外沒有放寬一般 Member API 的 Admin+ 邊界
- [x] 新增 `POST /api/tasks/:id/move`，使用既有 command error 映射
- [x] 自動測試覆蓋成功、權限不足、inactive workspace、archived task、`project_id` 清空與 pending invite
- [x] 真 HTTP smoke 用 A=source only、B=target only、C=雙邊成員驗證搬移前後 `GET/PATCH/comments` 權限完整反轉

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
- [x] 固定主協作工作區名稱、user01 Owner、user02-06 Commenter、user09 Admin；其他 user 不加入，並由 startup／login 同步修復
- [x] 主工作區討論預設、legacy task 正規化與 `task.discussion_started` 單一事件已由 domain 測試覆蓋
- [x] 前端依角色收斂控制，並安全自動連結完整 HTTP(S) URL、保留網址尾端中英文標點
- [x] SIM sweep 固定發現主工作區、排除 policy task、依 target repo 路由，且 main 不占 canonical repo slot
- [x] feature branch 已通過 `npm test`、`npm run build`、`git diff --check` 與 focused `sim/run.test.ts`
- [x] 合併至 `master`、build、restart 與正式服務部署驗證
- [x] 主工作區固定成員政策：1 Owner + 5 Commenter（user02-06）+ 1 Admin（user09）；單一 policy task、legacy task title
- [x] 完整 Commenter／Owner HTTP smoke 與交接流程驗證
- [x] Commenter 可在任何 workspace 修改自己建立 task 的 description；標題、狀態、屬性、附件與他人 task 仍不可修改
- [ ] 經明確人工授權執行 live `npm run sim -- --sweep owner`

> 2026-07-12 rollout：`master` merge `efbeb4b` 後 `npm test`、`npm run build`、health check 全數通過。DB 為 1 Owner + 29 Commenter、唯一規則 task，兩筆 legacy task 已加上 `[討論]`。HTTP smoke 驗證 Commenter 可建討論／留言但改狀態為 403，user01 以單一 `task.discussion_started` 完成 Doing 指派，並建立 canonical task `af06f594-682c-4437-aea5-d71eb354471c`、回寫完整 URL、推進 Review → Done。Live AI sweep 未執行。

> 2026-07-12 description rollout：`master` fast-forward 至 `4794674` 後完整測試、build 與 health check 通過。Commenter 自建 task 描述 PATCH 為 200，標題／狀態為 403，他人描述為 400；user02 在非主工作區仍是 Member，標題與描述 PATCH 均為 200。

> 2026-07-13 主工作區同步收斂為白名單：user01-06 與 user09；startup／login sync 會移除既有但不在白名單內的主工作區成員。

---

## Phase 16 — AI quota 獨立服務整合

- [x] 將 Codex/Claude credentials、usage API、retry 與 cache 搬到 `/home/hom/services/ai-quota`
- [x] `src/quota.ts` 改為唯讀 `~/.local/state/ai-quota/quota.json`，不再發送外部請求
- [x] `/api/quota` 保留摘要欄位並新增五小時、七天 `windows`
- [x] 摘要優先五小時；缺少五小時時 fallback 七天
- [x] Footer hover/focus 顯示雙視窗額度與台灣重置時間
- [x] 缺少、損壞或 stale snapshot 不影響 auth/API server，其餘 provider 仍可顯示
- [x] 安裝/啟用 `ai-quota.timer` 並完成正式 task-tracker HTTP/UI smoke

> 2026-07-13 正式驗收：`ai-quota.timer` active/waiting、Codex/Claude status 均為 `ok`；task-tracker 完整測試與 build 通過，正式 3000 服務健康檢查、登入後 `/api/quota` 與 Playwright footer hover 均通過。Codex 顯示 7 天 fallback，Claude 顯示 5 小時摘要，tooltip 的台灣時間與雙視窗資料符合 API。

## Phase 17 — AGY (Antigravity) provider 整合

- [x] ai-quota 服務新增 agy provider（ai-quota repo `54655a5`：讀 agy CLI token 檔、必要時 refresh access token、`fetchAvailableModels` 取全模型額度、`windows.five_hour` 放 settings.json 目前模型）
- [x] `src/quota.ts` 讀取 snapshot 的 `providers.agy`，移除 `agy-cli-no-local-quota-source` hardcode；快照缺 agy 時 fallback `ai-quota-agy-missing`（舊快照相容）
- [x] `src/quota.test.ts` 新增 agy 摘要/windows、stale、缺席 fallback 案例；`docs/api.md` agy 範例更新
- [x] 前端零改動（footer 已有 AGY 標籤，`seven_day: null` 自然顯示「尚無資料」）

> 2026-07-13 正式驗收：commit `71eb56d` 合入 master，`task-tracker.service` 重啟後 `/api/health` 200；登入 `/api/quota` 回三 provider，agy `remaining=100%`、source 帶 `#model=gemini-3-flash-agent` 註記；Playwright 驗證 footer 顯示 `AGY 5h 100%`、hover tooltip 兩行與台北重置時間正確。緊急停用走 ai-quota unit 檔的 `AI_QUOTA_AGY_DISABLED=1` kill switch。

## Phase 18 — 主工作區固定期限共識收斂 ✅（等待窗口已於 2026-07-29 移除）

> **後續變更**：本 Phase 的「固定 2–7 天回覆窗口」已整套移除 —— `【全員回覆：N天】` marker、`main_discussion_windows` 資料表與 payload 的窗口欄位皆不再存在。原因：21 天內只成功開出 2 個窗口，卻因 prompt／validator 對該 marker 的雙向漂移，讓主討論連續兩週開不出來（2026-07-23 `75e2033` 與 2026-07-29 `3157213` 各斷一次）。自 2026-08-10 起，改由完整 `【OWNER想法】` 的 server `created_at` 固定起算兩天：期限前要四位不同成員 `【同意】` 且含 user09，期限到後才可不依同意票收尾；`【OWNER想法】` 六欄與三種結論 marker 保留。

- [x] 主工作區維持 user01-06 與 user09 的固定成員政策；所有成員都可建立 Todo 討論，新增 task 描述預填 OWNER 評估方向範本
- [x] OWNER 先留下結構化 `【OWNER想法】`，再以 `【全員回覆：N天】` 開啟固定 2–7 天窗口；半天為 12 小時、一天為連續 24 小時，期限不可延長或重開，超過 2 天需說明理由
- [x] 留言與窗口在同一 transaction 保存；通知失敗會完整 rollback，不新增窗口查詢、回覆進度、缺席或期限 UI
- [x] 後端以 `task.main_discussion_concluded` 驗證並記錄實作、不實作、未達共識三種收尾；主工作區只允許 OWNER 在期限後 `Todo -> Done`
- [x] 實作收尾只在原討論記錄目標工作區與 TASK 名稱，不產生 URL；未達共識記錄三項說明後完成，日後另開新的主工作區 task
- [x] OWNER sweep、主工作區政策、API／設計／營運文件與前端看板已同步新流程；一般 workspace 維持原 Todo → Doing → Review → Done
- [x] focused tests、`npm test`、`npm run build`、`git diff --check` 與正式服務 health check 完成

## Phase 19 — 全成員通知巡檢

- [x] `team`／`both` sweep 每 tick 依序檢查 user02–user06 未讀通知，不受一般 TASK claim 派工限制
- [x] 零未讀不啟動 safe discussion；有主工作區未讀才走 bounded safe discussion、留言驗證、禁止自我 mention 與 driver 標已讀規則，一般 workspace 仍 API-only
- [x] 通知巡檢不占用一般 member budget、不建立 worktree、不 commit；失敗成員本 tick 跳過一般工作
- [x] focused tests、完整測試與 build
- [ ] live readback（需另取得人工 live sweep 授權）

## Phase 20 — SIM Owner 派工與通知處理規則

- [x] 每筆 notification 獨立建立 bounded sanitized packet、由 safe discussion 閱讀判斷並獨立 readback；重複內容仍逐筆處理，無效或 no-op 回覆留未讀
- [x] prompt 以 16,000 字元 fail-closed 上限保護，保留完整來源留言並對 context 做明確省略
- [x] managed roster 只同步 canonical task-tracker workspace 與本次新建 SIM workspace；補缺 user02–user06、修正 Viewer/Commenter 為 Member，保留更高角色，不觸碰主協作／歷史 workspace
- [x] Owner 依 profile／負載派工並留下 `【OWNER派工】`；member 只處理自己名下任務
- [x] 無 assignee Todo 嚴格等待，不啟動 member、無 timeout claim/fallback；scheduler `memberBudget=3`
- [x] focused `src/task.test.ts`、`sim/run.test.ts` 與兩份 TypeScript check 通過
- [ ] live readback（需另取得人工 live sweep 授權）

## Phase 21 — 留言不可刪除，只能編輯 ✅

- [x] 移除 `deleteComment`（`src/comment.ts`）與其唯一呼叫者用到的 `deleteNotificationsByComment`（`src/notification.ts`）
- [x] `DELETE /api/comments/:id` 固定回 405（`src/server.ts`），PATCH 編輯邏輯不變
- [x] 前端留言操作區移除「刪除」按鈕，只留「編輯」（`public/js/views/task-detail.js`）
- [x] `src/comment.test.ts` 移除對應刪除測試案例

> 起因：`/home/hom/.gemini/antigravity-cli/brain/.../comment_deletion_plan.md`（Antigravity/Gemini 產出）原規劃用
> `is_latest` 欄位做「只能刪最新一筆、且一旦被更新的留言覆蓋過就永久鎖死不能刪」的規則。審查後發現該規劃有兩個
> 實質錯誤：① `CommentRow` 型別沒加 `is_latest`，但規劃自己的測試對它取值，會讓 `tsc --noEmit` 失敗；②
> migration 把「加欄位」與「一次性回填」包在同一個 try/catch，回填本身出錯會被誤判成「欄位已存在」而吞掉，
> 造成所有既存留言 fail-open 成可刪除。確認需求後改採更簡單方向：留言完全不可刪除、只能編輯，因此零 schema 異動。
>
> 實測：`npx tsc --noEmit`、`npm run build` 與 `npx tsx src/comment.test.ts` 通過；`node --import tsx src/test.ts`
> 目前停在 `frontend.test.ts:603`，原因是該測試仍期待已移除的「刪除」按鈕，尚未同步測試契約。另起 `PORT=3999` 乾淨 server
> 對 `DELETE /api/comments/whatever` 實測回 `405 {"error":"留言不可刪除，只能編輯"}`。commit `5b01859`。

## Phase 22 — Sim 制度修正：ESCALATE 降噪四項（2026-07-17）✅

> 動機：dev.db 777 則留言中 111 則（14%）是 [ESCALATE]，歸因為部署漂移、worktree 落後、重複留言、驗收錯層。
> 計畫：`docs/superpowers/plans/2026-07-17-sim-process-fixes.md`。操作說明：`docs/operations.md`。

- [x] `/api/health` 曝露 `rev`（部署中的 git SHA），供 readback 與 owner live 驗收比對（`src/server.ts`）
- [x] master 自動部署：`sim-autodeploy.path` 監看本地 master ref → build → restart → rev readback；失敗推 Discord 且不部署（`deploy/sim-autodeploy.*`）。已實測 commit 觸發後 health rev 與 master 一致
- [x] ESCALATE 推播：sweep 後 `sim/escalateNotify.ts` 掃新 [ESCALATE] 推 Discord（`sim/notify-human.sh`，openclaw CLI）；state 去重（`~/.local/state/sim-escalate/`）。已實測管道送達（Message ID 1527684541110816821）
- [x] ESCALATE 留言去重：member 與 owner sweep prompt 加「同 task 狀況未變不重複留言」規則 + 契約測試（`sim/run.ts`、`sim/run.test.ts`）
- [x] 派工前置同步：`syncWorktreeWithMaster` 於 sweep 派工前自動 merge master（dirty 跳過、衝突 abort 並在該成員 prompt 注入 merge 指示）+ 真 git 暫存 repo 測試
- [x] 驗收分層：member 完成定義排除 live 驗收；owner sweep 於自動部署完成（health rev 與 master 一致）後才做 live 驗收 + 契約測試

## Phase 23 — 主工作區發想與四人共識（2026-07-30）

> 動機：跑了三週，創意產出是 0——9 則`【OWNER想法】`全是自家看板的 UI 微整形，沒有一個概念來自 repo 以外。
> 計畫：`docs/superpowers/plans/2026-07-30-main-workspace-ideation-consensus.md`。
>
> **原設計（指派成員去外部查證）已放棄**，因為三個前提實測是錯的：① `src/task.ts:178` 對主工作區每一則非規則
> task 強制前置 `[討論]`，所以 `[發想] X` 會被存成 `[討論] [發想] X`，而 `isSweepWorkTask`（`sim/run.ts:383`）
> 排除所有 `[討論]` 開頭 → 永遠不進成員排程；② `src/task.ts:181-183` 把主工作區 task 的 assignee 強制設為
> null（實測 12 則主工作區 task 的 `assignee_id` 全為 null），根本不能指派；③ `sim/run.ts:2091` 的通知巡檢由
> `SIM_NOTIFICATION_GATE` 控制，而它自 07-29 `15e2641` 起沒有設，@mention 叫不醒任何人。
> 改由 owner 自己查證與開題，成員只負責跨模型表態。

- [ ] `【同意】`／`【疑慮】` marker 常數 + `notificationGatePrompt` 主工作區規則改三選一（`sim/run.ts:1253`、`:1280`）
- [ ] `ownerSweepPrompt` 主工作區分支：拿掉「只用 curl/API」自陳、加開題步驟、`【OWNER想法】`補來源、收尾補四人清點（`sim/run.ts:2010-2032`）
- [ ] user02 改走 claude `claude-sonnet-5` 並補 agy fallback，讓表態階段有非 codex 票源（`sim/run.ts:172-173`）
- [ ] 通知巡檢跳過 user06（`sim/run.ts:2092`）
- [ ] 成員通知 login 改用 `describeError` 並對連線層失敗重試（`sim/run.ts:821-826`）——開 gate 前的前置
- [ ] 開啟 `SIM_NOTIFICATION_GATE=1`、重啟兩個 sweep timer、數「略過一般 session」次數確認 gate 沒再吃掉 session
- [ ] 端到端驗收：主工作區是否出現 repo 外主題、`【同意】`是否出現、是否有一則走完四人共識 → 目標工作區開 task → 原 task Done

**驗收標準**：① 至少三個 repo 以外的可追溯出處；② 同意池 user01–user05 + user09 六位中有 4 位同意（owner 走
`【結論】`即算 1 票，所以要在 user02–05 與 user09 這 5 個票源裡數到 ≥3 位）。門檻不寫進 validator，由 owner 清點
——`176b576`（07-14）建共識守門、`75e2033`（07-23）又拆掉，同一道閘門一個月內建了又拆。

**刻意延後、不是遺漏**：無腦按讚（不要求`【同意】`附理由）與來源灌水（不驗證來源品質）這一輪都不處理，先把流程建出來。後續 session 不要順手補回來。

## Phase 24 — 主工作區安全外網查證與成員實質回覆（2026-08-09）

設計與計畫：
[安全討論設計](../superpowers/specs/2026-08-09-safe-main-discussion-member-replies-design.md)、
[實作計畫](../superpowers/plans/2026-08-09-safe-main-discussion-member-replies.md)。

- [x] 移除主工作區 notification 的固定 `已閱讀，目前無補充。` POST；每筆通知改由 safe discussion callback 產生 `【同意】`／`【疑慮】`，exact comment readback 後才標已讀
- [x] task/comment 輸入做 NFC、control/bidi、credential、private URL/IP 消毒，prompt 上限 16,000；無效輸出、runner/tool/post/readback 失敗一律留未讀
- [x] safe route 固定 Claude `claude-sonnet-5`，只宣告 `WebSearch,WebFetch`，使用空白 cwd、filtered environment、PreToolUse egress hook；Codex/AGY 不作 fallback
- [x] 一般 workspace notification 仍 API-only；user02–user06 的一般工作 route、Owner、scheduler、member budget 與共識 validator 不變
- [x] 每筆 discussion telemetry 只記錄 route、latency、tokens、outcome 與 error category，不記 prompt、query、回覆全文或 cookie
- [x] `npx tsx sim/run.test.ts`、`npx tsx sim/notificationTelemetry.test.ts`、兩份 TypeScript check 與 `npm test` baseline 通過
- [ ] service restart、timer 啟用與 live AI/readback（需另取得人工 live sweep 授權）

## Phase 25 — 主工作區兩天／四票收尾 gate（2026-08-10）

- [x] 完整 `【OWNER想法】` 的既有 server `created_at` 固定起算兩個連續 24 小時，不恢復使用者期限 marker、窗口表或期限 UI
- [x] 期限前，`【結論】`、`【結論：不實作】`、`【未達共識】` 三種 outcome 共用四位不同成員 `【同意】` 且含 user09 的後端 gate；OWNER 與重複留言不計票，舊輪票不可沿用
- [x] owner sweep prompt、主工作區政策、API、operations、設計與回歸測試同步；不改一般 workspace 狀態機

## Phase 26 — sim 車隊結構化 trace（2026-08-18）

設計文件：[sim 車隊結構化 trace](../sim-trace.md)。範圍只含 sim 車隊；`src/` 應用層已有 `event_store`（`src/audit.ts:24`），不重複建置。

- [ ] 階段 0：確認 **14** 個事件與出處無誤（出處已於 2026-08-18 逐條實查）。事件語意從既有 SSOT 推導——`task_runs.phase` 的 CHECK（`sim/production/state.ts:37-40`）、`sim/production/coordinator.ts:202-210` 的 outcome union、`action_log.kind` 的實際值；不建立平行的第二套詞彙。`escalation.raised` 已移除（`[ESCALATE]` 是 AI 寫在留言正文的字串，由獨立 CLI `escalateNotify.ts` 事後掃 DB 撈出，不是編排層事件）
- [x] 階段 1（2026-08-19 完成）：新增 `sim/trace.ts`（112 行）與 `sim/trace.test.ts`，已納入 `npm test`。核心是 `TraceArgs` mapped type——寫入端依事件收不同參數（`ci.checked` 等 3 個事件 evidence 不可 null），落盤是單一扁平 `TraceRecord`，`formatTraceRecord` 維持單一函式無 switch。`buildTraceRecord` 純函式 / `formatTraceRecord` 人話 / `defaultSink` 寫出三者分離；`sink` 以 function type 參數注入，不定義 class 階層；export 面積為 `createTracer` / `createFileSink` / `formatTraceRecord` 與型別（後兩者分別供一場一檔與階段 4 fixture 判準使用）。`evidence.kind` 的 `http` 因無事件使用已移出。附一個 `assert` 自檢，以 memory sink 驗證欄位齊全。不做 conditional types（`commit.recorded` 的 refused 路徑無 sha，收 `Evidence | null`）
- [x] 階段 2（2026-08-19 完成）：包了**三個** wrapper（多一個 `endTickAndTrace`）——`checkpointAndTrace`（取代 8 處 `upsertTaskCheckpoint` 直接呼叫，把「先取舊 phase、比對、`from === to` 不送」收在一處，避免四種靜默漏記）與 `withAction`（取代 8 處 `beginAction`/`completeAction`/`failAction` 區塊，連冪等檢查與 try/catch 一起接管；**這是控制流重構，改動面比前者大一個量級**）。再掛 `beginTick`（`:689`）、`sim/production/completion.ts:153` 與 `sim/production/coordinator.ts:544`；session 事件掛 `runAiSession` 內部而非 `:287/:305` 的工廠層（否則拿不到 `logFile`）。編排層為 `production.ts`／`coordinator.ts`／`run.ts` 三個檔案，`state.ts` 與 `policy.ts` 保持純粹（action trace 不放進 `state.ts`，否則 `run_id` 會是 null）。coordinator 側按日切檔
- [x] 階段 3（2026-08-19 程式完成，未實跑 sweep 驗證）：掛 `sim/run.ts` 六處。**先做 `sweep()`（`:3085`）**——它是 `sim-sweep-owner/team.timer` 每天觸發數十次的常態路徑，且目前沒有 run 識別碼，需新發 `sweep-<role>-<ISO>`；`main()`（`:2774`）是手動跑的完整場，隨後補。再掛 `runSessionAttempt`（`:2002`）、`commitMemberWork`（`:2550`）、`verifyBranches`（`:2680`）、`runActorSessionWithNotificationGate`（`:1866`）。此側無 `merge.integrated`——合併由 owner AI session 自己下 `git merge --no-ff`，沒有程式化呼叫可掛
- [ ] 階段 4：既有 `console.log` 改由 `formatTraceRecord` 產生。**驗收方式是 fixture 比對**：固定 `TraceRecord` 進去，斷言輸出與現行模板逐字相同；不可用「跑兩次 sim 再 diff」（`sim/run.ts:85` 的時間戳前綴讓它永遠過不了）
- [ ] 另開 task：`ci_runs` 快取層是死碼——`storeCiRun`／`lookupCiRun`／`ciCacheKey` 與 `ci_runs` 表只有測試碰過，production 流程一次都沒呼叫。本 phase 不處理，但看到該表的人會誤以為 CI 有快取
- [ ] 兩份 TypeScript check 與 `npm test` baseline 通過

不納入本 phase：logging 框架（理由與翻案條件見設計文件附錄）、trace retention（`sim-logs/` 為 gitignored，需要時抄 `sim/notificationTelemetry.ts:191` 那 10 行）、`sim/notificationTelemetry.ts` 的合併或重寫（它有自己的外部 contract）、`sim-logs/*.log` 的檔案格式變更。

施工前先停 `sim-sweep-owner.timer` 與 `sim-sweep-team.timer`；AI 車隊會在讀寫之間改同一批 `sim/` 檔案。
