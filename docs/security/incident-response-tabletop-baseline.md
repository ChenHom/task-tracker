# 跨 repo 資安事件應變盤點與隔離桌上演練基線

> 查證與演練日：2026-08-06。候選範圍限於 task-tracker session 冒用、ai-quota
> 私有 state／供應商憑證外洩，以及 tw-day-trading 主機／整合憑證外洩。
> 本文件是工程盤點與合成桌上演練紀錄，不是正式 incident policy、法律結論，
> 也不構成對供應商或券商的通報。`UNKNOWN` 表示本輪未從原始碼、部署 unit 或
> 已隔離的測試取得證據，不能解讀成無風險或不存在。

## 結論與安全邊界

- 本輪唯一可安全演練的情境是 **task-tracker 的 session 疑似外洩**。`src/auth.test.ts`
  全程使用 `DatabaseSync(':memory:')` 的合成 user／session；它可讀回單一 session
  刪除、過期清理，以及密碼重設後刪除同一 user 全部 sessions 的行為。實測輸出為
  `auth.test.ts OK`，沒有開啟 `data/dev.db`、建立真實 cookie 或呼叫外部服務。
- **ai-quota 不選為本輪演練標的**：它讀取 Codex、Claude 與 Antigravity CLI credential
  檔，並對供應商 API 發出帶 Bearer token 的請求。雖有 Antigravity polling kill switch，
  但停 poll 不是憑證撤銷；實際 revoke／重新登入需要帳號權限與外部 provider 操作。
- **tw-day-trading 不選為本輪演練標的**：程式啟動會要求 `SHIOAJI_API_KEY` 與
  `SHIOAJI_SECRET_KEY`，而實際 host 或券商憑證失竊的 containment 需主機與 provider
  權限。雖然目前交易 engine 的 execution path 使用 `FakeBroker`，不能據此假設真正
  的憑證撤銷或主機隔離已被驗證。
- 本輪沒有讀取真實 cookie、token、credential、private quota snapshot、交易帳務或外部
  日誌；沒有修改 nginx、systemd、資料庫、state path、provider 或券商設定。

## 候選服務唯讀比較

| 候選 | 已查證的受影響面與證據 | 偵測／證據位置 | 可隔離 containment／復原邊界 | 角色、聯絡與是否可安全演練 |
| --- | --- | --- | --- | --- |
| task-tracker session 冒用 | `src/auth.ts` 以隨機 32-byte token 建 `sessions` row，TTL 為 7 天；cookie 是 `HttpOnly; SameSite=Strict`，可由 `COOKIE_SECURE=1` 加上 `Secure`。`src/schema.ts` 的 `login_events` 保存 email、user、成功與否、IP、user-agent 與時間，但沒有 session id。2026-08-06 的 `systemctl --user show`：`task-tracker.service` 為 `active/running`，unit 為 `~/.config/systemd/user/task-tracker.service`。 | `login_events`、task／member 變更的 `event_store` audit metadata、`journalctl --user -u task-tracker.service`。session 建立與 login event 沒有共同的 session id，故不能僅憑現有 DB 證明「某個特定 cookie」來自哪次登入；DB backup、session export、監控告警與保留期皆為 `UNKNOWN`。 | 單一已知 token 可由 `destroySession()` 作 server-side revoke；logout 會刪當前 token 並回 `Max-Age=0`，但 server 無法清 browser／API client cookie jar。`resetPassword()` 會刪除該 user 全部 sessions；這是唯一已查證的 all-device revoke 路徑，真實使用時會改密碼，必須由授權的 account owner 執行。服務 restart 是可用性手段，不是 token revoke。 | 工程角色可由此 task 的 Owner／assignee 暫代 Incident Commander／技術記錄者；實際 auth、DB backup、對外溝通 primary 與 alternate contact 沒有可回查指定，均為 `UNKNOWN`。可用記憶體測試作 75 分鐘桌上演練。 |
| ai-quota private state／供應商 credential 外洩 | `src/credentials.ts` 讀 CLI-owned `~/.codex/auth.json`、`~/.claude/.credentials.json` 與 Antigravity token path；`src/clients.ts` 以 Bearer token 呼叫 usage API。`src/store.ts` 對 private state 採 `0700` directory、`0600` file、temporary file + atomic rename；public projection 是 redacted 的另一份檔案。2026-08-06：`ai-quota.timer` 為 `active/waiting`，`ai-quota.service` 是正常 oneshot 結束的 `inactive/dead`、`Result=success`。 | `journalctl --user -u ai-quota.service` 的 token-free error、snapshot provider status（`auth_failed`、`stale` 等）與 timer/service status。不可把 snapshot `auth_failed` 當作 credential 已撤銷；它只表示 poll 未能成功取得用量。private／public state backup、provider audit trail、credential owner 與 incident contact 均為 `UNKNOWN`。 | `AI_QUOTA_AGY_DISABLED=1` 只會停止 Antigravity polling，不能撤銷已外洩 token；Codex／Claude 文件明定 credential refresh 由 CLI 負責。要驗證 revoke、再登入、cache 清理與 consumer fallback，會涉及真實 provider、credential 或 live unit，超出本輪安全範圍。 | state／credential／provider account 的 primary、alternate、宣告門檻與復原授權皆為 `UNKNOWN`。未取得可拋棄 provider 帳號、fixture credential 與明確不觸網 runner 前，不做模擬。 |
| tw-day-trading 主機／整合憑證外洩 | `src/config.py` 以環境變數要求 `SHIOAJI_API_KEY` 與 `SHIOAJI_SECRET_KEY`；不讀取其值即可確認此整合邊界。`deploy/trading-web.service` 將唯讀 Web dashboard 綁在 `127.0.0.1:8800`，有 `NoNewPrivileges=true` 與 `PrivateTmp=true`。2026-08-06：系統 `trading-web.service` 為 `active/running`，unit 在 `/etc/systemd/system/trading-web.service`。`src/application/execution/engine.py` 的目前 execution path 使用 `FakeBroker`，因此不能用這個 repo 宣稱對真券商下單或 revoke 流程已存在。 | `journalctl -u trading-web.service`、daily runbook 所列 `logs/shadow_cron.log` 與 `artifacts/reports/daily/` 是可回查位置；供應商登入／撤銷 audit、host EDR、backup、nginx access log retention、真實交易帳號 owner 與外部聯絡人均為 `UNKNOWN`。 | 關閉或隔離 host、撤銷券商／Discord credential、重建機器與對帳都會改變正式服務或需供應商授權；不可由 `FakeBroker` 測試取代。唯讀 dashboard 也不等於整個主機或整合已隔離。 | host owner、券商／Discord credential custodian、primary／alternate contact、可接受停機與復原核准權都是 `UNKNOWN`。需有隔離 VM、假 provider credential 和經授權的 network sandbox 後才可演練。 |

## 選定情境：task-tracker 合成 session 冒用桌上演練

**目的：** 驗證工程團隊能區分「發現可疑登入」與「確認某 token 已外洩」，保留不含
秘密的時間線，並在必要時選擇已被程式測試過的 server-side revoke path。

**安全輸入：** 虛構使用者 `exercise-user-20260806`、虛構事件編號
`IRX-20260806-SESSION`，以及 `src/auth.test.ts` 的記憶體 SQLite fixtures。不得建立或
複製 production session、不得查詢 `data/dev.db` 的 sessions、不得發送 reset link、不得
登入 localhost 或重啟服務。

| 時間 | 合成演練步驟 | 預期記錄／決策 | 實際結果或限制 |
| --- | --- | --- | --- |
| T+00–10 分 | Incident Commander 宣告「疑似 session 冒用、尚未確認」；技術記錄者建立去識別化時間線與證據清單。 | 角色：IC、技術、溝通各一人；外部溝通先保持草稿，避免把 cookie、帳號或未修補細節貼到 task。 | 可由 task Owner 指定；實際 primary／alternate contact 未定義，列為缺口。 |
| T+10–20 分 | 在合成 DB 檢視 `login_events` 可提供的 email、IP、user-agent、時間與成功結果；比對 `sessions` schema。 | 明確記下：沒有 session id 關聯欄位，不能以 login event 證明某個特定 cookie 的來源；需要另行補證據或升級事件處理。 | 程式碼與 schema 已確認此限制；未讀 production login event。 |
| T+20–35 分 | 紙上決策 containment 分支：已知單一 token 時選 `destroySession()`；若影響範圍是同一 user 的所有裝置，授權後採密碼重設的 all-device revoke。 | 記錄「restart 不是 revoke」；client cookie jar 的清除需由 client 接收 logout header，不能宣稱 server 已遠端刪除。 | `src/server.ts` 與 `src/auth.ts` 支持此區分；實際 password reset 會改密碼，未執行。 |
| T+35–50 分 | 以記憶體測試驗證 containment readback：建立／刪除／過期 session，並驗證密碼重設後舊 session 不再可用。 | 測試輸出須是 `auth.test.ts OK`；若測試開啟 `data/dev.db`、要求外部 credential，或刪除後 token 仍通過 auth，立刻停止並不推進。 | `npx tsx src/auth.test.ts` 實測為 `auth.test.ts OK`；測試使用 `DatabaseSync(':memory:')`。 |
| T+50–65 分 | 擬定不外送的狀態更新與復原 gate：受影響帳號何時重新登入、何時可結案、需保存哪些去識別化證據。 | 只有完成 scope、server-side revoke readback、帳號 owner 通知與監控期 owner 已指定才可提結案；backup／client jar／第三方副本不能被宣稱已清除。 | 程式只證明 primary `sessions` row revoke；其他副本仍為 `UNKNOWN`。 |
| T+65–75 分 | 回顧缺口與下一步，停止演練。 | 不向外發送通知、不變更 account、service 或 database。輸出責任人與重演觸發。 | 本輪未產生正式環境副作用。 |

### 去識別化狀態更新樣本（本輪沒有送出）

```text
[T+00] IRX-20260806-SESSION：收到疑似 session 冒用訊號，尚未確認。IC 已建立時間線；禁止在一般留言貼 cookie、token、帳號或 IP。
[T+20] 已確認目前 login audit 沒有 session-id 對應，不能將單一 cookie 與登入事件直接關聯。Containment 僅保留為授權後決策，尚未操作正式帳號。
[T+50] 隔離測試證明 session delete 與 password-reset all-session revoke 的 server-side readback；browser/API cookie、backup 與第三方副本未被測試，仍待 owner 指定。
[T+75] 演練停止：沒有正式副作用。後續需先補 auth/DB backup owner、primary/alternate contact、告警與授權的 revoke runbook。
```

## 驗證與回查

本輪在 task-tracker worktree 執行，兩者 exit code 均為 0：

```bash
npx tsc --noEmit
npx tsx src/auth.test.ts
```

第二個命令的實際輸出為 `auth.test.ts OK`（Node 對 `node:sqlite` 的 ExperimentalWarning
不影響 test result）。它覆蓋的 readback 是過期 session 自動清除、`destroySession()` 後
無法取得 user，以及 `resetPassword()` 後先前 session 無效；沒有覆蓋 production DB backup、
browser cookie jar、provider token 或任何外部服務。

回查路徑：

- task-tracker：`src/auth.ts`、`src/auth.test.ts`、`src/schema.ts`、`src/server.ts`、
  `deploy/task-tracker.service`、`docs/operations.md`
- ai-quota：`/home/hom/services/ai-quota/src/{credentials,clients,store}.ts`、
  `/home/hom/services/ai-quota/deploy/ai-quota.{service,timer}`、
  `/home/hom/services/ai-quota/docs/operations.md`
- tw-day-trading：`/home/hom/services/stock/tw-day-trading/src/config.py`、
  `src/application/execution/engine.py`、`deploy/trading-web.service`、
  `docs/operations/daily_runbook.md`

## 最小後續與重評條件

| 缺口 | 最小下一步 | 重評觸發 |
| --- | --- | --- |
| task-tracker 無可將 session id 與 login event 關聯的 incident evidence，且沒有 auth／backup 的 runbook owner。 | 另開 task，先定義可揭露的 correlation key、保存期、存取權限與無 secret 的 incident query，再由 auth 與 DB backup owner 確認單一／全帳號 revoke 授權。 | 懷疑 cookie 外洩、新 session store、多 instance、DB backup／export、外部 auth 或法定保留需求。 |
| ai-quota credential revocation 尚無可用的合成 provider 演練面。 | 取得 disposable provider account、fixture credential、token-free log assertion 和 consumer fallback fixture；在隔離 state path 執行，不能碰 CLI-owned credential。 | 新 provider、public state path、credential rotation、`auth_failed` 事故或要接通外部通報時。 |
| tw-day-trading 缺少可演練的 host isolation／provider revoke／外部聯絡與帳務復原責任。 | 先由 service／broker／notification owner 指定角色與停機授權；在無真實券商、帳戶、Discord token 的隔離 VM 用 fake provider 練習 revocation、重新部署與對帳 readback。 | 真實 broker integration、新 host、要從 shadow 進正式交易、credential 事故或 provider 通知時。 |

## 本輪限制

- 未讀取或輸出真實 session、credential、quota snapshot、交易帳務、provider response 或 log payload。
- 未對 localhost API、正式 service、systemd、nginx、state path、provider、券商或 Discord 產生寫入或網路副作用。
- 沒有把「poll 停止」「服務 restart」「FakeBroker 測試」「client clear-cookie header」誤報成真實 credential revoke、host isolation、券商撤銷或所有副本已清除。
