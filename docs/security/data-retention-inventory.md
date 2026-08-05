# 跨 repo 資料保留與可驗證刪除唯讀盤點

> 查證日：2026-08-06。範圍限於 `task-tracker` sweep session、`ai-quota` 的
> `quota.json`，以及 `owner-team-ollama-report` 到 Ollama／Discord 的資料流。
> 這是工程盤點，不是保留政策或法律合規結論。`UNKNOWN` 代表沒有從原始碼、unit
> 或可重跑隔離測試取得證據，不能推定為沒有副本或沒有風險。

## 結論與邊界

- `task-tracker` session 的主要資料是 SQLite `sessions` row；登出、過期查詢、
  密碼重設與刪除 user 都有明確刪除路徑。瀏覽器或 API client 的 cookie jar 是服務
  無法直接抹除的另一份副本；logout 只能回送 `Max-Age=0` 指示 client 清除。
- `ai-quota` 的 private snapshot 與 public projection 都是可重建的最新狀態檔，而非
  帳務主檔。每次 poll 會以 temporary file + atomic rename 取代舊檔；沒有觀測到舊
  snapshot 的期限刪除或 poll 停止後的 stale-file removal。
- `owner-team-ollama-report` 不在本 repo 落地報表，但讀取的 sweep log、Ollama request、
  Discord message 與 systemd journal 都可能形成副本。外部服務的實際保留／刪除能力
  沒有本輪可查證證據。

本輪沒有修改正式資料、cookie、state path、systemd、Discord、Ollama 或外部 repo。
資料／保留／例外的正式 owner 尚未由可回查來源指定；本 task 的 assignee 不是這些
資料的營運 owner。

## 資料流清冊

| 流程 | 資料與敏感度／目的 | source of truth 與已知副本 | 起算與現有保留／刪除語意 | 責任與缺口 |
| --- | --- | --- | --- | --- |
| task-tracker sweep session | 隨機 32-byte session id，屬可用於登入的高敏感認證資料；用途是 cookie-based auth。登入嘗試另記 email、IP、user-agent、成功與否，屬 audit 資料但沒有 session id。 | primary：`data/dev.db` 的 `sessions`；server 以 `Set-Cookie` 發送 `HttpOnly; SameSite=Strict` cookie。client/browser 或 API cookie jar 是另一份副本；sweep 內 cookie 只作本次 request 的記憶體值。`login_events` 是衍生 audit row，不含 session token。backup、匯出、附件與第三方副本均為 `UNKNOWN`。 | row 建立時起算，TTL 為 7 天。logout 會刪 row；過期 row 於被查到、server 啟動或 SIGHUP reload 時刪除；密碼重設刪除該 user 全部 session；刪 user 以 FK cascade 刪 session。client 收到 logout 的 `Max-Age=0` 才會清 cookie；服務不能直接 sanitise client jar。沒有在原始碼找到 session DB backup expiry、archive 或 media sanitization。 | 資料 owner、audit／incident exception、備份保存與安全抹除責任均為 `UNKNOWN`。下一個需要保留政策的 task 必須先指定 auth 與 DB backup owner，並區分 server-side revoke 與 client-side cookie 清除。 |
| ai-quota → quota.json | private snapshot 含 provider status、用量視窗、時間與可選 `raw`／error；`raw` 可能含供應商回應，按 private state 處理。目的為 task-tracker footer／quota API 的使用額度顯示。public projection 只保留 allowlist 後的 provider、status、source、lastSuccessAt、windows。 | private primary：`/home/hom/.local/state/ai-quota/quota.json`（dir `0700`、file `0600`）；derived public copy：`/var/www/ai-quota-public/quota.json`（`0755`／`0644`）。已知 consumer 是 task-tracker `src/quota.ts`，只讀 private path 後輸出 mapped fields；其他 consumer、CDN／web-server cache、backup、export 與 provider-side copies 均為 `UNKNOWN`。 | `ai-quota.service` 是 oneshot，timer 每五分鐘 poll；每次以 temp file + rename 原子覆寫最新 snapshot。這是 cache overwrite／replacement，不是 logical delete、archive 或可驗證 secure erase。poll 停止時未觀測自動刪除，舊檔可持續存在；consumer 遇缺檔／不合法檔只回 unavailable，沒有替它清理。 | service／state／public projection owner、可接受 stale period、backup expiry、公開檔 cache purge 與 incident exception 為 `UNKNOWN`。schema 或 required field 變更前，必須先補 consumer 清冊、private/public copy 的 rollback gate 與 owner。 |
| owner-team report → Ollama／Discord | sweep log 先被縮為 time、member、result、error、commit；原始 prompt、cookie、token、command line 與長 raw log 不進 Ollama prompt。Ollama summary 與 Discord message 屬衍生輸出；workspace name lookup 是 task-tracker DB 的唯讀資料。 | primary input：`/home/hom/code/task-tracker/sim-logs/sweep-(owner|team)-cron-*.log`；報表程式唯讀查 `data/dev.db` workspace name。report process 本身只輸出 stdout，只有 `--send` 才透過 OpenClaw 發 Discord。Ollama request、Discord message、systemd journal 與兩端服務的 cache／backup 是外部或 system-level 副本；保留與刪除能力均為 `UNKNOWN`。 | report 預設處理最近完整 60 分鐘；installed oneshot service 帶 `--send`，timer 每 65 分鐘執行。程式碼沒有 archive、log rotation、deletion、third-party deletion request 或 media sanitization。`sim/notificationTelemetry.ts` 的 14／90 天 pruning 不套用到這些 cron sweep logs，不能當成 report retention 證據。 | sweep-log owner、Ollama operator、Discord workspace retention admin、incident／audit exception 與外部刪除聯絡人皆為 `UNKNOWN`。在任何含個資、外部交付或刪除要求前，需先指定這些角色與可查證的 provider deletion path。 |

## 刪除層次與不可替代關係

| 層次 | session | quota snapshot | report flow |
| --- | --- | --- | --- |
| logical delete／revoke | 刪 `sessions` row 會立即使 token 不可用。 | 不適用；state 是最新 cache。 | 不適用；不應把 Discord 刪訊息當成原始 log 已刪。 |
| client/cache overwrite | logout header 要 client 清 cookie；server 無法讀／刪 browser jar。 | atomic rename 以新 snapshot 取代檔名上的舊 snapshot；不是安全抹除。 | Ollama prompt 與 report summary 只在當次 process 中組裝；其餘 cache 未查證。 |
| archive／log rotation | 沒有找到 session archive；`login_events` 是獨立 audit 資料，無保留期限證據。 | 沒有歷史版本或 archive runner。 | cron sweep log 的 rotation／archive 沒有本輪證據。 |
| backup expiry／media sanitization | `UNKNOWN`；主 DB row 刪除不等於備份已過期或媒體已抹除。 | `UNKNOWN`；覆寫 state path 不等於任一 backup 或 public cache 已清。 | `UNKNOWN`；Discord／Ollama／journal 各自可能保留。 |
| third-party deletion | 不適用於 server-side session；client cookie 由 client 控制。 | provider side、web server/CDN 均未查證。 | Ollama／Discord 的 API、權限、保留與 legal hold 均未查證。 |

## 受限驗證：隔離 session 刪除 readback

選擇 `task-tracker` session 作為本輪可重建驗證：它有明確的 production deletion
function，且 `src/auth.test.ts` 使用 `DatabaseSync(':memory:')` 的合成 user／session，
不會開啟 `data/dev.db`、不需要 cookie、外部服務或真實 credential。

執行命令：

```bash
npx tsx src/auth.test.ts
```

本輪實際結果：`auth.test.ts OK`（2026-08-06，cwd：
`/home/hom/code/task-tracker/sim-work/user03`）。該測試的可回查 readback 如下：

| 合成輸入與步驟 | 實際 readback | 覆蓋的刪除邊界 |
| --- | --- | --- |
| 建立 memory-only user `u1` 與 session，再插入已過期 session。 | `getSessionUser('expired')` 回 `null`；同一 SQLite DB 的 `SELECT 1 FROM sessions WHERE id = 'expired'` 找不到 row。 | primary session row 在過期讀取時刪除；primary-key lookup 沒有殘留。 |
| 對有效 session 呼叫 `destroySession()`。 | 再次 `getSessionUser()` 回 `null`。 | logout/revoke 的 server-side primary deletion。 |
| 為 user 建 session 後刪除 user。 | `SELECT count(*) FROM sessions` 為 `0`。 | FK cascade 的 primary deletion。 |
| 產生 clear-cookie header。 | header 含 `Max-Age=0`。 | client-side copy 的清除指示；不代表任何 browser 或 curl jar 已被服務端實際刪除。 |

此 flow 沒有獨立 application session cache；每次 auth 都查 `sessions`，而 `login_events`
schema 沒有 session id。故本次不應虛構「cache、index、衍生輸出已刪」的證據：SQLite
primary-key lookup 是唯一已驗證的 index/readback；client jar、DB backup、filesystem
free-space、journal 與任何匯出仍是 `UNKNOWN`，也沒有被此隔離測試觸及。

停止條件是測試讀回任何 session row、刪除後 token 仍通過 auth，或測試意外改到
`data/dev.db`。本輪均未發生。回復方式是停止進一步 policy／cleanup rollout；測試使用
記憶體 DB，程序結束即消失，沒有需要還原的正式或 shared 資料。

## 最小後續與重新評估觸發

| 缺口 | 最小下一步 | 重新評估觸發 |
| --- | --- | --- |
| 沒有三條 flow 的資料／保留／backup／exception owner。 | 由各 service 維運方在對應 repo task 指定 data owner、執行者、監看者與刪除核准者。 | 任何正式刪除、DSAR／incident、外部發布或 retention 設定變更。 |
| session 的 audit、backup 與 client cookie jar 缺乏 end-to-end deletion evidence。 | 在隔離 DB backup／測試 browser profile 設計驗證，分開量測 revoke、backup expiry 與 client clear-cookie acknowledgement。 | 引入新 session store、多 instance、session export 或法律保留要求。 |
| quota 的 stale file、private/public cache 與其他 consumer 未被完整盤點。 | 先以暫存 state path 建 consumer 清冊與 private/public snapshot replacement／rollback fixture；不得碰正式 path。 | schemaVersion、required field、public path、web server/CDN 或 poll frequency 改變。 |
| report flow 沒有 log rotation 或 Ollama／Discord delete readback。 | 在不含敏感資料的 synthetic report 演練前，取得 log owner、Ollama operator、Discord admin 的保留與可刪除能力書面證據。 | 要送入個資、客戶資料、外部摘要，或收到刪除／legal-hold 要求。 |

## 回查路徑

- `src/auth.ts`、`src/auth.test.ts`、`src/schema.ts`、`src/server.ts`
- `src/quota.ts`、`/home/hom/services/ai-quota/src/store.ts`、
  `/home/hom/services/ai-quota/deploy/ai-quota.{service,timer}`
- `/home/hom/.openclaw/workspace/owner-team-report/{README.md,report.ts,report-lib.ts}`、
  `/home/hom/.config/systemd/user/owner-team-ollama-report.{service,timer}`
- `sim/notificationTelemetry.ts`（僅用來排除它對 cron sweep log 的不適用性）

## 本輪限制

- 未讀取真實 cookie、token、provider raw response、Discord message 或外部 service data。
- 未對 production DB、quota state、systemd、Ollama 或 Discord 產生副作用。
- 未把 logical revoke、file overwrite、archive、backup expiry、third-party deletion 或
  media sanitization 混為同一件事。
