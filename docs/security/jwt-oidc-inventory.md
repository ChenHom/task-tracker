# 跨 repo JWT／OIDC 接收端唯讀盤點與隔離驗證基線

更新日期：2026-08-05

第一輪、範圍受限的唯讀盤點。目的是找出實際「接收」JWT／OIDC token 並據以做認證決策的
repo／服務，記錄其驗證邊界，並用隔離 fixture（假金鑰、假 JWKS，不連正式服務）驗證關鍵行為。
不建立跨用途共用 middleware，不對任何 repo 做程式碼修改。

## 盤點範圍與方法

以關鍵字（`jsonwebtoken` / `jose` / `jwks` / `openid` / `oidc` / `jwt`）與依賴掃描，逐一核對
下列 repo 的原始碼：plinko-game、openclaw-clone、tw-stock-research-platform、RSSHub、
job-risk-radar、file-exchange-station、_ops、104-resume-automation、ai-quota、brain、
task-tracker（本 repo）。另核對三個曾出現過的別名：line-stock-bot（不存在）、game1
（→ pinball-bounce-v1，無關）、tw-day-trading（→ tw-swing-trading-mvp，Python，無 HTTP
認證層）。

## 查找命令

```bash
rg -n "jsonwebtoken|jose|jwks|openid|oidc|jwt" plinko-game openclaw-clone tw-stock-research-platform RSSHub job-risk-radar file-exchange-station _ops 104-resume-automation ai-quota brain task-tracker
rg -n "verifyGoogleChatRequest|monitor-webhook|systemIdToken" openclaw-clone/extensions/googlechat
rg -n "LINE webhook|HMAC-SHA256|verifyLineSignature" file-exchange-station
```

## 排除清單（已查證，非接收端）

| Repo | 排除理由 |
| --- | --- |
| task-tracker（本 repo） | 無 `jsonwebtoken`／`jose`／`jwks`／`openid`／`oidc` 相關依賴或程式碼 |
| plinko-game | 無 JWT/OIDC 依賴或程式碼 |
| tw-stock-research-platform | 無 JWT/OIDC 依賴或程式碼 |
| RSSHub | 19 筆 `jwt` 命中為陸校教務處路由英文縮寫，非 JSON Web Token |
| job-risk-radar | 無 JWT/OIDC 依賴或程式碼 |
| _ops | 無 JWT/OIDC 依賴或程式碼 |
| 104-resume-automation | 無 JWT/OIDC 依賴或程式碼 |
| brain | 無 JWT/OIDC 依賴或程式碼 |
| file-exchange-station | LINE webhook 用 HMAC-SHA256 簽章比對（`line-service.ts` `verifyLineSignature`），非 JWT |
| ai-quota | 有 `Authorization: Bearer` 呼叫 Codex/Anthropic API，但角色是客戶端使用他人核發的 token，不是驗證端 |
| line-stock-bot（別名） | repo 不存在 |
| game1（別名） | 實際為 pinball-bounce-v1，與 JWT/OIDC 無關 |
| tw-day-trading（別名） | 實際為 tw-swing-trading-mvp，Python，無 HTTP 認證層 |

## 唯一接收端：openclaw-clone Google Chat webhook

`openclaw-clone/extensions/googlechat/src/auth.ts` 的 `verifyGoogleChatRequest`，被
`monitor-webhook.ts` 的 Google Chat webhook handler 呼叫，用來驗證 Authorization header
或 Workspace Add-on 的 `systemIdToken`。

| 欄位 | 內容 |
| --- | --- |
| 用途 | 驗證 Google Chat／Workspace Add-on 送來的 Bearer ID Token 確實由 Google 簽發 |
| 驗證分支 1（`audienceType=app-url`） | `OAuth2Client.verifyIdToken()`，走 `google-auth-library` 內建 OIDC 流程（動態抓 Google 官方憑證），額外自訂檢查 `payload.email_verified` 且 `email` 需等於 `chat@system.gserviceaccount.com` 或符合 Workspace Add-on service account regex |
| 驗證分支 2（`audienceType=project-number`） | 自訂 `fetchChatCerts()` 打 `https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com` 取得 kid→x509 對照表，10 分鐘記憶體快取，交給 `verifyClient.verifySignedJwtWithCertsAsync` 驗證 |
| issuer | 固定字串 `chat@system.gserviceaccount.com`（project-number 分支）；app-url 分支另外自訂比對 `email` claim |
| algorithms | 程式碼本身無 alg allowlist；簽章驗證固定用 RSA-SHA256（`google-auth-library` 內部寫死，ES256 只做簽章格式轉換仍走同一 verify） |
| typ | 完全未檢查（fixture 已證實，見下） |
| audience | 由呼叫端 `target.audience` 傳入比對，空值直接拒絕（`missing audience`） |
| 必要 claims | `iat`、`exp` 必要（缺一即拋錯），`iss` 需在允許清單內；project-number 分支未見 `nonce`／`jti`／`scope` 檢查 |
| exp/nbf/iat 與 clock skew | 無獨立 `nbf`；clock skew 為 `google-auth-library` 常數 `CLOCK_SKEW_SECS_=300` 秒；`exp` 不可超過 `now+86400` 秒（`DEFAULT_MAX_TOKEN_LIFETIME_SECS_`） |
| key cache／rotation | project-number 分支的 10 分鐘快取只在到期後才重抓，未知 kid 不會觸發提前失效重抓（fixture 已驗證）；app-url 分支快取交給函式庫內部處理，未查 |
| 未知 kid | 查無 pem 直接拋錯「No pem found for envelope」，正確拒絕 |
| 撤銷／introspection | 無主動 revocation／introspection，只靠短快取＋憑證自然輪替 |
| 拒絕原因 readback | `verifyGoogleChatRequest` 回傳 `{ok:false, reason}` 供內部 `isMatch` 判斷，但 `monitor-webhook.ts` 沒有把個別 reason 寫回 HTTP response（一律回 401 "unauthorized"），reason 字串目前未落地到任何 log |

## 隔離驗證

受限於 openclaw-clone 是 pnpm workspace，`extensions/googlechat` 無獨立 `node_modules`，
一般 Node 解析找不到其 `google-auth-library`。改用同版本（`google-auth-library@10.6.1`，
與 `auth.ts` 實際 import 完全一致）的 `OAuth2Client#verifySignedJwtWithCertsAsync` 直接測試——
這正是 `auth.ts` project-number 分支唯一委派的簽章／claims 驗證函式本體，`auth.ts` 自身只是
`fetchChatCerts` 的薄封裝，判定證據等效。

Fixture 位置：[`fixtures/google-chat-jwt/`](fixtures/google-chat-jwt/)（獨立 `package.json`／
lockfile，不影響 task-tracker 主專案相依性；`node_modules` 已被主 repo `.gitignore` 排除）。

重跑方式：

```bash
cd docs/security/fixtures/google-chat-jwt
npm install
npx tsx verify.mjs
```

驗證結果（2026-08-05 執行，全程只用本機生成的 RSA 假金鑰＋mock JWKS，未連線任何正式服務、
未用真實 token）：

| 案例 | 預期 | 實際 |
| --- | --- | --- |
| 合法 token（正確 iss/aud/exp、已知 kid） | 接受 | 接受 |
| 錯 issuer | 拒絕 | 拒絕（`Invalid issuer...`） |
| 錯 audience | 拒絕 | 拒絕（`Wrong recipient...`） |
| 過期 token | 拒絕 | 拒絕（`Token used too late...`） |
| 未知 kid | 拒絕 | 拒絕（`No pem found for envelope...`） |
| typ 造假（設成 `NOT-A-JWT`） | — | 仍接受，證實 typ 完全未被檢查 |
| alg:none 偽造＋空簽章 | 拒絕 | 拒絕（`Invalid token signature...`），因驗證不依賴 alg 宣告，不受經典 alg=none 繞過影響 |
| 模擬金鑰輪替（provider 已換 kid2，驗證端快取仍只有 kid1） | 拒絕 | 拒絕（`No pem found for envelope`），證實 10 分鐘快取視窗內無法識別新 kid，屬可用性缺口非安全漏洞 |

全部 8 個案例與現場盤點結論一致。

## 缺口／建議（僅記錄，不逕行修改 openclaw-clone）

1. **typ 未檢查**：現行風險低（缺乏其他可利用的 confusion 情境），但屬明確驗證缺口。
2. **無 nonce／jti／scope**：webhook 場景本無重放語意需求（每次事件內容不同、且有其他去重機制），暫不建議新增。
3. **拒絕 reason 未回寫／未落 log**：建議之後在 `monitor-webhook.ts` 401 分支補一行 debug log 帶 reason，方便事後排查。
4. **10 分鐘快取輪替視窗**：已知可用性缺口，非本次授權範圍（不得修改正式程式碼），留給 openclaw-clone 團隊評估是否要在收到未知 kid 時提前失效快取重抓一次。

## 驗證環境聲明

全程唯讀，未修改 openclaw-clone 或 task-tracker 任何原始碼；隔離 fixture 已持久化於本
repo（`docs/security/fixtures/google-chat-jwt/`），可重跑，不依賴任何暫存腳本。

## owner 回查路徑

- [`fixtures/google-chat-jwt/verify.mjs`](fixtures/google-chat-jwt/verify.mjs)
- [`fixtures/google-chat-jwt/README.md`](fixtures/google-chat-jwt/README.md)
- task 2c5e6f89-7d91-4c6c-9c68-c7288a0e8821 comments（目前這份 webhook receiver 盤點的 owner 派工與回查入口）
- task cff77860-6627-4dea-8f63-44324b7366b3 comments（盤點過程與 owner 派工紀錄）
