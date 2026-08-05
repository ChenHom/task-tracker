# 跨 repo 公開網域與 DNS 唯讀清冊及受限回退演練基線

> 查證日：2026-08-06。執行人：大熊（user05）。對應 task：`492d2101-18e0-4d17-97b1-5edad4da53e6`。
>
> 本文件是一次性唯讀盤點。`UNKNOWN` 表示目前沒有可回查證據，不能推定為沒有風險；本輪未修改 DNS、registrar、nginx、systemd、服務、憑證或 credentials，也未對正式流量做演練。

## 結論

本輪在以下 repo、部署檔與主機 nginx vhost 中，沒有找到可證明屬於正式服務的公開註冊網域、公開 DNS zone 或安全測試子網域：

- `task-tracker`：`/tracker/` 由 nginx 反代至 `127.0.0.1:3000`。
- `game1`：`/game/pinball/` 由 nginx 反代至 `127.0.0.1:8080`。
- `tw-day-trading`：`/trading/` 由 nginx 反代至 `127.0.0.1:8800`。
- `ai-quota`：`/quota.json` 是 nginx 讀取本機檔案的 LAN/VPN 受限路徑。
- `cloudflare-tunnel`：只找到未帶 hostname、credential 或 ingress 設定的範例 compose，沒有部署證據。

目前實際 vhost 名稱是 `dev.hom.localhost`、`localhost` 與 `192.168.50.109`。`dev.hom.localhost` 在本機解析到 loopback；向 `1.1.1.1` 與 `8.8.8.8` 查詢則均為 `NXDOMAIN`。這些標的不是可交給 registrar 或公開 DNS provider 管理的網域，故本輪沒有進行 DNS 變更或回退演練。

## 查證範圍與證據

| 對象 | 查證內容 | 證據位置／結果 |
| --- | --- | --- |
| task-tracker | 服務入口、健康檢查、nginx 路徑 | `/home/hom/code/task-tracker/docs/operations.md:7-13,58-70`；`/etc/nginx/sites-available/default:78-92` |
| game1 | nginx 路徑與 user systemd 服務 | `/etc/nginx/sites-available/default:94-108`；`/home/hom/.config/systemd/user/pinball-bounce.service` |
| tw-day-trading | upstream 綁定位址與 root path | `/home/hom/services/stock/tw-day-trading/deploy/trading-web.service:10-15`；`/etc/nginx/sites-available/default:68-76` |
| ai-quota | 公開 snapshot 的實際 host／存取限制 | `/home/hom/services/ai-quota/AGENTS.md:34-39`；`/home/hom/services/ai-quota/docs/operations.md:74-114`；`/etc/nginx/sites-available/default:24-26,58-62` |
| Cloudflare Tunnel | 是否有實際 public hostname／ingress | `/home/hom/services/cloudflare-tunnel/docker-compose.yml:1-18`；只有 `tunnel --url http://web-service:80` 範例，沒有 hostname、zone、token 或 active unit |
| nginx vhost | 對外監聽、名稱、TLS、來源網段 | `/etc/nginx/sites-available/default:5-26`；HTTP/HTTPS 均列 `dev.hom.localhost 192.168.50.109 localhost`，HTTPS 只允許 `192.168.50.0/24`、`10.6.0.0/24` |

查找排除 `node_modules`、`.git`、`data`、`dist`、sim logs 與 pytest cache，避免把依賴、歷史產物或測試文字誤當成部署控制面。

## 網域與服務清冊

| 網域／入口 | 類型與實際用途 | A/AAAA／解析證據 | registrar／權威 DNS／到期／auto-renew／lock | DNSSEC／DS／CAA | owner、監控、下游依賴 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| `dev.hom.localhost` | 本機開發／LAN vhost；共用 `/tracker/`、`/trading/`、`/game/pinball/`、`/quota.json` | 本機 `dig`：A `127.0.0.1`、AAAA `::1`；`1.1.1.1` 與 `8.8.8.8`：`NXDOMAIN` | registrar：N/A（`.localhost` 本機保留名稱）；權威 DNS、到期、auto-renew、registrar lock：N/A | 本機 resolver 未回 NS/SOA/CAA；公開 resolver 為 NXDOMAIN；DNSSEC/DS：N/A | 服務 runtime user 是 `hom`，但產品／DNS owner、DNS 監控與復原聯絡：`UNKNOWN`；下游是本機 nginx 與四個子路徑 | **排除公開 DNS；不演練** |
| `192.168.50.109` | LAN 私有 IP，非網域 | RFC1918 私有位址；無 A/AAAA zone 可查 | registrar／權威 DNS／到期／auto-renew／lock：N/A | DNSSEC/DS/CAA：N/A | nginx allowlist 允許 LAN；監控與 IP 變更責任：`UNKNOWN` | **排除公開 DNS；不演練** |
| `localhost` | loopback 別名 | 本機 resolver 解析至 loopback；非公開服務名稱 | registrar／DNS lifecycle：N/A | N/A | 只供本機連線；無公開下游 | **排除公開 DNS；不演練** |
| 公開服務網域／測試子網域 | 在查證範圍內未發現候選 | 沒有可回查的 hostname、zone 或 certificate evidence | registrar、provider、期限、lock、MFA、recovery、owner：`UNKNOWN`（尚未有 domain 可供核對） | DNSSEC/DS/CAA：`UNKNOWN`（尚未有 domain 可供核對） | DNS／證書監控與負責人：`UNKNOWN` | **沒有標的；不得假設不存在風險** |

`dev.hom.localhost` 的本機憑證唯讀摘要如下：

- SAN：`dev.hom.localhost`、`localhost`、`127.0.0.1`、`::1`、`192.168.50.109`。
- issuer：`mkcert hom@hom` 的本機 CA。
- validity：2026-07-09 12:05:42 UTC 至 2028-10-09 12:05:42 UTC。
- 這是本機開發憑證，不是公開 CA 憑證；不能當作公開網域或公開 TLS 入口證據。

## 依賴與控制面盤點

目前看到的服務鏈是：

```text
LAN/VPN client
    -> nginx (dev.hom.localhost / 192.168.50.109, allowlist)
       -> /tracker/       -> 127.0.0.1:3000 task-tracker
       -> /trading/       -> 127.0.0.1:8800 tw-day-trading
       -> /game/pinball/  -> 127.0.0.1:8080 game1
       -> /quota.json     -> /var/www/ai-quota-public/quota.json
```

- registrar 帳號、DNS provider 帳號、MFA、recovery contact、registrar lock、DNSSEC key／DS 維運責任：`UNKNOWN`；本輪沒有讀取或嘗試登入任何帳號。
- DNS 變更監控、外部 resolver 監控、certificate expiry 告警、DNS drift 告警：`UNKNOWN`；repo／unit 證據只足以確認 nginx、服務健康檢查與部分服務 log，不能推定有 DNS 監控。
- nginx 的來源限制是網路存取控制，不是 registrar 或 DNS provider 的替代品；它也不能證明存在公開網域。
- GitHub repository URL 是原始碼來源，不是此清冊中的服務入口，沒有把它列為產品 DNS 標的。

## 唯讀命令與實際結果

以下命令只讀取設定、DNS 回應或本機憑證，沒有 mutation：

```bash
rg -n -i 'server_name|listen 443|ssl_certificate|proxy_pass|domain|dns|hostname' \
  /etc/nginx /home/hom/code/task-tracker /home/hom/code/game/game1 \
  /home/hom/services/stock/tw-day-trading /home/hom/services/ai-quota \
  /home/hom/services/cloudflare-tunnel

dig dev.hom.localhost A +noall +answer
# dev.hom.localhost.  0  IN  A     127.0.0.1

dig dev.hom.localhost AAAA +noall +answer
# dev.hom.localhost.  0  IN  AAAA  ::1

dig @1.1.1.1 +time=2 +tries=1 dev.hom.localhost A +noall +answer +authority +comments
# status: NXDOMAIN, ANSWER: 0

dig @8.8.8.8 +time=2 +tries=1 dev.hom.localhost A +noall +answer +authority +comments
# status: NXDOMAIN, ANSWER: 0

openssl x509 -in /home/hom/.local/share/mkcert/certs/dev.hom.localhost+lan.pem \
  -noout -subject -issuer -dates -ext subjectAltName
# issuer: mkcert hom@hom；SAN 僅含本機名稱、loopback 與 192.168.50.109
```

本機 resolver 對 `NS`、`SOA`、`CAA` 沒有回應；公共 resolver 的 `NXDOMAIN` 只證明該名稱不是公開 DNS 標的，不代表任意未發現的真實網域不存在。

## 受限回退演練基線

### 本輪決定

本輪 **不執行** DNS 回退演練，原因是沒有同時滿足下列條件的標的：

1. 有明確 registrar／權威 DNS provider 與可回查的 owner。
2. 有隔離、無使用者流量的測試子網域或 provider sandbox。
3. 有變更前 zone／DS／CAA／TTL snapshot、核准的停止條件與可復原 credential 邊界。
4. 能以至少一個外部 resolver 做變更後與回退後 readback。

因此沒有建立假想的正式 zone，也沒有把 `dev.hom.localhost`、`192.168.50.109` 或 Cloudflare compose 範例誤當成測試標的。

### 未來具備標的後的最小演練步驟

取得明確 owner／維運授權且找到安全測試子網域後，才可在隔離標的執行一次：

1. 唯讀保存 zone／record、nameserver、DS、CAA、TTL、certificate、目前解析與依賴清單；記錄 snapshot 時間與 hash，不保存 token 或 recovery code。
2. 只改一筆低風險測試 record，保留原值與變更 ID；停止條件包括 owner 不在場、權威回應與 snapshot 不符、TTL／propagation 超出核定窗口或出現非預期 downstream。
3. 以權威 server、兩個外部 resolver 及服務端到端的唯讀 readback 確認預期值；不將快取尚未過期誤判為成功。
4. 立即依變更 ID 還原原 record，等待同一組 resolver readback 恢復；若恢復失敗，停止後續變更並由 owner 依 provider rollback／support 流程處理。
5. 保存變更前後、停止／還原時間、resolver 結果、TTL、certificate／下游影響與未解缺口；不把演練結果宣稱為正式 RTO/RPO 或 DNS SLA。

### 重新評估觸發

下列任一事件發生時，應重開本清冊並先做唯讀核對：

- nginx `server_name`、Cloudflare ingress、DNS zone 或公開 CA certificate 出現新的非 `.localhost` hostname。
- 服務從 LAN/VPN allowlist 轉成 Internet-facing，或新增公開使用者流量。
- 取得 registrar／DNS provider 的唯讀證據、owner、MFA／recovery 與 lock／DNSSEC／CAA 管理責任。
- 有明確的無流量測試子網域與回退授權，且需要驗證 TTL、DNSSEC、CAA 或下游切換。
- nginx／服務搬遷、IP 變更或新增依賴導致現有 `192.168.50.109` 入口不再是唯一入口。

## 本輪限制與交付狀態

- 未讀取 registrar、DNS provider、Cloudflare 或任何真實憑證／token 帳號；因此相關欄位保留 `UNKNOWN`。
- 未修改跨 repo 原始碼；跨 repo 內容以 repo 文件、systemd unit、nginx vhost、compose 範例與唯讀 DNS／憑證 probes 交叉核對。
- 未對 `localhost:3000` 或正式服務做 live 驗收；這份交付只需要靜態與 DNS 唯讀證據。
- 沒有可安全演練的公開標的，故以「不演練＋具備標的後的最小基線＋重新評估觸發」完成本輪驗收，不以假設填補 registrar、provider、owner、監控或 DNSSEC 結論。
