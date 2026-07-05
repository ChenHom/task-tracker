# Design v2 需求總覽（草案）

> 接續 [DESIGN.md](DESIGN.md)。後端 ES/CQRS/RBAC/OWASP/狀態機/審計已跑通並測試通過（見 [TASKS.md](TASKS.md)），但三處缺口讓系統實際上還不能被真正操作。這份是討論中的需求草稿，尚未進入細部設計——先把重點攤開，之後逐一挑一塊深入時再寫成正式 spec。

## 現況缺口

1. **建立使用者** — `users` table 沒有任何 INSERT 路徑，除了測試直接塞 db；不需要公開註冊，但需要能產生測試資料
2. **Member 邀請 API** — `inviteMember` / `joinWorkspace` / `changeMemberRole` / `removeMember` 都已實作並測試過，但 server.ts 沒有路由呼叫
3. **前端串接** — 後端已有 40+ 條路由，香草 JS 前端還停在 Phase 0 的 health-check 頁面
4. **忘記密碼（Email 重設連結）** — 登入是 email-based，確認要做，目前完全沒有

---

## 1. 建立使用者 + Seeder

**範圍已定案**：不做公開自助註冊，只需要「建立使用者」的能力 + 一支 seeder 產生 ≥30 位測試使用者。移除了原本註冊流程的 UX 問題（enumeration 取捨、註冊 rate limit）——這些都是「公開給任何人打」才需要考慮的，內部/腳本呼叫不適用。

**為何要做**：Member 邀請、前端登入都需要真實帳號才能端到端測；seeder 直接寫 30 筆到 db，比做完整註冊流程更快讓其他兩塊可測。

**需要涵蓋**：
- `createUser(email, password)` 內部函式（複用既有 `hashPassword`，寫進 `users` table）
- 重複 email 要回乾淨的錯誤（目前 UNIQUE constraint 會直接丟 SQLite 例外，需包裝）
- Seeder 腳本：產生 ≥30 位使用者，用固定測試密碼（例如 `test1234`）方便手動登入測試，email 用可預期的格式（如 `user01@test.local` ~ `user30@test.local`）——這批固定 email 本身就是天然的去重 key

**已定案**：
- Seeder 只建 users，不建 workspace（workspace/角色指派留到 Member 邀請 API 那塊再處理）
- Seeder 要 idempotent——重複執行不會重複建立，`INSERT OR IGNORE`（或先查再跳過）即可，不需要額外的「已 seed 過」標記表

**明確不做**：公開註冊 endpoint、email 驗證信、OAuth 第三方登入

**OWASP 對應**：
- A02 加密：沿用 `scrypt`，不能退化成明碼/弱雜湊
- A03 注入：沿用 `db.prepare` 參數化查詢
- A05 設定錯誤：SQLite 原始錯誤訊息不能直接往外拋（就算是內部函式，錯誤也可能被上層 API 包裝後外洩）
- 原本註冊端的 A04（rate limit）、A07 帳號枚舉取捨——因為不對外開放，**不適用**，範圍縮小

---

## 2. Member 邀請 API

**為何要做**：邏輯全寫好測過了，只差 HTTP 路由；但 `member.invited` 和 `member.joined` 是兩個獨立事件，代表底層設計已預設「邀請」與「加入」是兩步驟，不是邀請=直接生效，這塊有實質設計問題待釐清。

**需要涵蓋**：
- `POST /workspaces/:id/members`（邀請，需 Admin+）
- `GET /workspaces/:id/members`（列出成員+角色）
- `PATCH .../members/:userId`（改角色）、`DELETE .../members/:userId`（移除）

**已定案的設計決策**：
- 邀請對象只能是既有帳號——HTTP 層用 email 查 `users` table 找出 user id，找不到回錯誤，不支援邀請未註冊者
- invited 但未 joined 沒有任何存取權限——**這點其實已經實作好了**（`member.ts` 的 projection 註解：「invited 不投影（未 joined 無權限）；joined 才進 read model」），不需要新開發，只差 HTTP route 讓使用者能真正呼叫 `joinWorkspace`
- Workspace 只能在「只剩 Owner 自己一個成員」時才能關閉（archive/delete）——換句話說，關閉前必須先把其他成員都移除乾淨
- 邏輯延伸：同樣道理，Owner 若不是唯一成員也不能移除/降級自己的角色，否則會出現「有其他成員但沒有 Owner」的狀態，跟關閉規則背後的精神一致（先照這個假設做，之後看使用起來的感覺再調整）

**新增實作點**：`archiveWorkspace` / `deleteWorkspace`（[workspace.ts](src/workspace.ts)）目前完全不查成員數，需要新加「查 `workspace_members_read_model` 的 active 成員數 == 1」的守門，這會讓 workspace.ts 第一次跨模組依賴 member 的 read model

**明確不做**：邀請信通知（無 email 基礎設施）

**OWASP 對應**：
- A01 存取控制錯誤（風險最高）：
  - 權限升級——Admin 能否任命/邀請另一個 Owner？（應擋，只有 Owner 能任命 Owner）
  - IDOR——`PATCH/DELETE .../members/:userId` 要先確認該 `:userId` 真的是該 workspace 成員
  - 業務規則防呆——最後一個 Owner 不能被移除/降級
- A09 日誌：已「免費」滿足——邀請/角色變更/移除都是 event，所以一定進 `event_store`

---

## 3. 前端串接

**為何要做**：後端 40+ 條路由完全沒被消費，系統無法用瀏覽器操作，只能 curl。

**需要涵蓋**（粗略頁面清單）：登入/註冊、workspace 列表與切換、task 列表（含狀態機合法轉換的 UI 限制）、comment、attachment 上傳/下載、search、member 管理（依賴 #2）、audit 檢視

**已定案**：
- 前端採單頁 hash routing，一個 `index.html` + `addEventListener('hashchange', ...)`。只有 ~6-8 個固定畫面，用一個 `{hash 前綴: renderFn}` 查表 + `switch` 分派即可，不需要 pattern-matching 的路由器抽象
- Session 已是 HttpOnly cookie，前端不需管 token，靠 401 判斷登入態

**明確不做**：CSS 排版打磨、拖拉看板、即時更新、任何前端 build 工具鏈

**OWASP 對應**：
- A03 注入（XSS）：task 標題、comment 等使用者輸入渲染到 DOM 一律用 `textContent`，不用 `innerHTML`
- A01：前端只能隱藏/顯示 UI 做體驗優化，權限判斷不能只在前端做（後端維持唯一權威）
- CSRF：後端已用 `SameSite=Strict` + Origin 檢查擋掉，前端 fetch 用預設 `credentials` 行為即可，不用額外處理
- 附件下載：前端開啟使用者上傳檔案要走「下載」而非 `<iframe>` 內嵌渲染，呼應後端既有的 `nosniff`

---

## 4. 忘記密碼（Email 重設連結）

**範圍確認**：登入仍是 email-based，忘記密碼→email 重設連結這個流程確定要做，不是次要項目、不能用「改密碼」代替。

**需要涵蓋**：
- 新增 `password_resets` table：`id / user_id / token_hash / expires_at / used_at`（token 本身不落地存明碼，存 hash，比對時重新雜湊——跟 session token 的處理邏輯一致，不落地明碼是同一個原則）
- `POST /api/auth/forgot-password`（email）→ 查到使用者就產生一次性 token（有效期例如 1 小時）、寄出重設連結；查不到也回同一句成功訊息，不透露 email 是否存在（沿用 login 端已經在用的「不洩漏帳號存在與否」原則）
- `POST /api/auth/reset-password`（token + 新密碼）→ 驗證 token 存在、未過期、未使用過，通過後更新密碼、把 token 標記已使用、**並讓該使用者其他裝置的 session 全部失效**（`sessions` table 目前沒有「依 user_id 批次刪除」操作，需要補一個）

**寄送方式（已定案）**：不接真實 email 服務，重設連結印到 server console/log 當作「已寄出」——維持專案零外部依賴、零 SMTP 設定的原則。Token 產生/驗證/過期/單次使用等核心安全邏輯跟正式版完全一樣，只有「寄送」這個環節是假的。標一個 `ponytail:` 註記，之後要接真的信箱服務時只要換掉這一行呼叫。

**OWASP 對應**：安全性質已內嵌在上面的流程描述中（token hash 化、過期、單次使用、enumeration 防護、session 全面失效），不重複列。

---

## 建議順序

建立使用者 + Seeder → 忘記密碼 → Member 邀請 API → 前端串接

理由：
- 前兩塊都在 Auth 範圍內，一起做完收斂；忘記密碼不依賴 Member/前端，插在這個位置不會被其他工作卡住
- Member 邀請 API 依賴「有真實帳號」才能端到端驗證，RBAC 的角色分級也才不會只停留在單元測試層級
- 前端排最後，因為它是消費前三塊 API 的介面，前三塊的 API 形狀（尤其 Member 邀請的 request/response）沒定案，前端會一直改
