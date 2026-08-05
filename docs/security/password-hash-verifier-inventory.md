# 跨 repo 密碼雜湊 verifier 唯讀盤點與隔離驗證基線

更新日期：2026-08-06

第一輪、範圍受限的唯讀盤點。目的是找出仍自管密碼雜湊／驗證的 repo，記錄其演算法、
參數、格式版本、needs-rehash、登入節流等邊界，並用隔離 fixture（僅合成帳號，不連
正式 DB／不動正式參數）驗證關鍵行為。不修改任何 repo 的原始碼，不要求不同 runtime
統一演算法。

## 盤點範圍與方法

本 session 的 sandbox 僅允許存取目前 workdir（`/home/hom/code/task-tracker/sim-work/user02`），
`ls /home/hom/code` 或任何跨出此目錄的檔案操作一律被系統擋下（見下方「第二個
verifier／外部 IdP：已證實無法盤點」）。因此本輪只完成 task-tracker 自身的唯讀盤點，
方法為直接讀原始碼（`src/auth.ts`、`src/server.ts`、`src/rateLimit.ts`）。

## task-tracker（唯一可盤點的自管 verifier，`src/auth.ts`）

| 欄位 | 內容 |
| --- | --- |
| Runtime／library | Node.js，`node:crypto` 內建 `scryptSync`（無第三方 hashing library） |
| 演算法／參數 | scrypt；`salt = randomBytes(16)`（隨機、per-user，`hashPassword` 每次呼叫都重新產生）；輸出 hash 長度 64 bytes；`scryptSync(plain, salt, 64)` 未顯式覆寫 N/r/p，等同 Node 內建預設，且未把 cost 參數存進欄位 |
| 儲存格式 | 純字串 `hex(salt):hex(hash)`，存在 `users.password_hash`；無版本前綴 |
| 比對 | `verifyPassword`（`src/auth.ts:13-20`）先檢查長度是否相等，再用 `timingSafeEqual` 做 constant-time 比對；缺分隔符或格式不符一律回 `false`，不丟例外 |
| needs-rehash／rehash-on-login | 不存在——無版本欄位、無 cost-drift 偵測；未來若調高 cost 參數，既有帳號不會自動升級 |
| 強制重設／rollback | `resetPassword`（`src/auth.ts:170-182`）成功後即時 `hashPassword` 新密碼並 `destroySessionsForUser`，讓該使用者所有裝置 session 全部失效；不論失敗原因（token 不存在／過期／已用過）一律回 `false`，不分理由，避免帳號枚舉 |
| 登入節流 | `loginLimiter = createRateLimiter(15*60*1000, 10)`（`src/server.ts:62`），以來源 IP 為 key（`src/server.ts:217-236`），非 per-account／per-email；帳號不存在時 `attemptLogin` 仍對 `DUMMY_HASH` 跑一次 `verifyPassword`（`src/auth.ts:109,136`），讓成功／失敗耗時相近，擋 timing-based 帳號枚舉 |
| 長期未登入帳號覆蓋缺口 | 因無版本欄位／無 needs-rehash，所有帳號（含長期未登入）都在同一升級路徑外——這本身就是缺口，不是只有長期未登入帳號特別缺 |

## 第二個 verifier／外部 IdP：已證實無法盤點（非「不存在」）

上一輪（2026-08-05）留言已記錄此限制；owner review 要求「補齊第二個邊界或可證明的
排除結果」，本輪重新實測並附上系統原始錯誤訊息作為證據：

```
$ ls /home/hom/code
ls in '/home/hom/code' was blocked. For security, Claude Code may only list files in the
allowed working directories for this session: '/home/hom/code/task-tracker/sim-work/user02'.
```

`mkdir` 等操作也回報同樣的 workdir 白名單限制。本 session 的沙盒只允許讀寫
`/home/hom/code/task-tracker/sim-work/user02` 這一個目錄，無法讀取任何其他 repo
（包含可能自管密碼或整合外部 IdP 的 repo）的原始碼，因此無法完成第二個 verifier
的盤點或排除判定。repo 內（本 task-tracker）搜尋 `oauth`／`idp`／`saml`／`sso` 關鍵字
無外部 IdP 整合痕跡，僅能證明「本 repo 不是」，無法代表其他 repo 的情況。

此為環境限制，不是 code 問題；需由具備跨 repo 存取權限的 session（例如 owner／
coordinator session）補做，本盤點對此不重複實測、不臆測其他 repo 的結果。

## 隔離驗證

合成帳號：`synthetic-smoke-user@example.invalid`；獨立記憶體內 SQLite
（`node:sqlite` `DatabaseSync(':memory:')`），不連正式 `data/dev.db`、不讀取／匯出
任何正式 `password_hash`。

Fixture 位置：[`fixtures/password-hash-verifier/verify.mjs`](fixtures/password-hash-verifier/verify.mjs)。

重跑方式：

```bash
npx tsx docs/security/fixtures/password-hash-verifier/verify.mjs
```

驗證結果（2026-08-06 執行）：

| 案例 | 預期 | 實際 |
| --- | --- | --- |
| 單次成功登入（正確帳密） | 回傳 user_id | 通過，~35ms |
| 單次失敗登入（密碼錯，帳號存在） | 回傳 null | 通過，~41ms |
| 帳號不存在 | 回傳 null | 通過，~42ms（與上兩者同量級，DUMMY_HASH 佔位比對確實生效） |
| 缺分隔符／空字串的 stored 值 | 回 false，不丟例外 | 通過 |
| 同密碼兩次雜湊 | salt 不同 → hash 不同 | 通過 |
| 20 次循序登入呼叫 | 全部完成、每次留一筆 `login_event` | 通過，total≈787ms avg≈39ms/次 |

`scryptSync` 為同步阻塞呼叫，單一 Node process 下 20 次呼叫實質是循序排隊、佔用
event loop，並非真正平行——這是量測到的既有限制，非本次變更範圍。目前只有一種
儲存格式（無新舊版本並存），故未測試「舊新格式並存」案例；此點記入下方缺口。

停止條件：全程只用合成 email／密碼，未讀取／匯出任何正式 `password_hash` 或
pepper，未呼叫任何會寫入正式 DB 的路徑（`data/dev.db` 於執行前後內容無變化）。

## 缺口／建議（分開列，不混為一談）

1. **無 stored-format 版本欄位**：無法做 needs-rehash／rehash-on-login／漸進升級；也因此本輪無法量測「舊新格式並存」情境（缺口，非本次驗證疏漏）。
2. **登入節流是 per-IP 非 per-account**：共用 NAT／代理下可能誤傷或漏防。
3. **第二 verifier 盤點未完成**：因 sandbox 限制，見上方「已證實無法盤點」一節；需具跨 repo 存取權限的 session 補做。

升級建議（不在本 task 範圍內執行）：若要調高 scrypt cost 或換演算法，需先加版本前綴
（如 `scrypt1:`）才能安全雙軌並存；屬 repo-specific 遷移，需另開 task 並先定
rollback／容量驗證，本次不動生產參數。

## 驗證環境聲明

全程唯讀，未修改 `src/` 下任何原始碼；隔離 fixture 已持久化於本 repo
（`docs/security/fixtures/password-hash-verifier/`），可重跑，不依賴任何暫存腳本。

## owner 回查路徑

- [`fixtures/password-hash-verifier/verify.mjs`](fixtures/password-hash-verifier/verify.mjs)
- [`fixtures/password-hash-verifier/README.md`](fixtures/password-hash-verifier/README.md)
- task 122106e8-66b1-410c-85a8-d7707f9313dd comments（本次 owner 派工、review 退回與本輪回覆）
