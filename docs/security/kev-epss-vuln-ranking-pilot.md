# 跨 repo KEV／EPSS 漏洞排序唯讀試點

範圍：task-tracker（本 repo）＋ ai-quota（/home/hom/services/ai-quota）。一次性唯讀樣本，不改正式環境、不新增 CI gate、不自動關閉風險。

盤點時間：2026-08-06。資料來源時間戳：CISA KEV catalogVersion 2026.08.04（dateReleased 2026-08-04T16:45:52Z，共 1660 筆）；FIRST.org EPSS 2026-08-05 快照；NVD CVE API 即時查詢（2026-08-05T16:2x UTC）。

## 1. 實際 runtime／部署證據

| 項目 | task-tracker | ai-quota |
|---|---|---|
| OS | Ubuntu 22.04.5 LTS（kernel 6.8.0-124-generic，`uname -a` 實測） | 同一台主機，同 OS／kernel |
| Node.js | v24.3.0（`node --version` 實測；systemd `ExecStart=/home/hom/.nvm/versions/node/v24.3.0/bin/node dist/server.js`） | 同一顆 v24.3.0（`ai-quota.service` ExecStart 同路徑） |
| 部署單元 | `~/.config/systemd/user/task-tracker.service`，`Restart=always`，長駐監聽 | `~/.config/systemd/user/ai-quota.service`（`Type=oneshot`）＋`ai-quota.timer`（`OnUnitActiveSec=5min`）——**不監聽 port 的 timer/oneshot，本盤點明確納入，不因無 listening port 排除** |
| 對外可達性 | nginx `/etc/nginx/sites-available/default` `location /tracker/` → `proxy_pass http://127.0.0.1:3000`，前端 443/80 有 `allow 192.168.50.0/24; allow 10.6.0.0/24; deny all;`（僅 LAN，非公開 Internet）；Node 本身 `server.listen(3000)` 未綁定 host，理論上 0.0.0.0，但實際對外路徑以 nginx 允許清單為準 | 純出站（呼叫 Claude/Codex/Antigravity API）＋寫 `/var/www/ai-quota-public/quota.json`；nginx 只用 `alias` 靜態讀檔（`location = /quota.json`），無 proxy_pass、無程式碼執行面；systemd 另加 `ProtectSystem=strict`／`NoNewPrivileges`／`ReadOnlyPaths`／`PrivateTmp` |
| 正式相依套件（`dependencies`） | **0 個**（package.json 只有 devDependencies：eslint/tsx/typescript/@types/node） | **0 个**（同上，只有 tsx/typescript/@types/node） |
| dist 執行期 import 證據 | `grep require\|from` on `dist/server.js`：全部是 `node:*` 內建模組＋本地 `./xxx` 模組，無 `node_modules` 第三方套件 | `dist/cli.js` 同樣全部是 `node:*` 內建＋本地模組 |
| devDependency 是否進部署／自動流程 | `deploy/sim-autodeploy.sh`（master 變動觸發）只跑 `npm run build` = `tsc`，**不**跑 `npm test`／`npm run lint`；eslint／brace-expansion 只在人工 `npm test` 才會被載入 | 同構：`npm run verify` 才會跑 devDependency 工具鏈，非自動觸發 |

結論：兩個 repo 的「元件」清單本質上等於「Node.js v24.3.0 runtime + 各自 devDependency 工具鏈（僅建置/測試期）」，沒有正式相依套件攻擊面。這直接影響下面的候選挑選——多數候選來自 Node.js 本體，而非 npm 套件。

## 2. 候選清單（逐筆盤點時間 2026-08-06，EPSS 快照 2026-08-05）

| # | 元件／版本 | CVE | KEV | EPSS（percentile） | CVSS | 可達性 | 業務影響 | 補償控制 | 資料來源 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Node.js v24.3.0（task-tracker＋ai-quota 共用 runtime） | CVE-2026-21710（`__proto__` header → `req.headersDistinct` 未捕捉 TypeError DoS） | 未列 KEV（查 2026.08.04 catalog 無此 CVE） | **26.356%／pctl 97.8%**（全批最高） | 7.5 HIGH（AV:N/AC:L/PR:N/UI:N/A:H） | **不可達**：`grep -r headersDistinct src/` 於 task-tracker、ai-quota 均**無命中**——兩個 repo 程式碼都沒呼叫這個 getter，觸發條件不成立 | 若日後有程式碼開始用 `req.headersDistinct`，即成立即可遠端當機正式服務 | 目前無（不需要，因未使用該 API）；建議：程式碼審查時把 `headersDistinct` 列入不建議使用清單，或升級 Node 後失效 | NVD CVE-2026-21712 API、FIRST EPSS API、`grep` 本機驗證 |
| 2 | Node.js v24.3.0（task-tracker，HTTP 服務端） | CVE-2025-27209（V8 rapidhash HashDoS） | 未列 KEV | 0.771%／pctl 52.2% | 7.5 HIGH（AV:N/AC:L/PR:N/UI:N/A:H） | **可達**：`src/server.ts` `readJson()`（1MB 上限）被所有 POST/PATCH 路由呼叫，含**登入前**的 `POST /api/auth/login`；經 nginx `/tracker/`（LAN allowlist 192.168.50.0/24、10.6.0.0/24）或 Node 直接 bind 3000 都能送達；v24.3.0 早於修補版 24.4.1（現行最新 24.19.0，已落後 15+ 版） | 攻擊者可用單一合法大小內的 JSON payload（≤1MB）讓事件迴圈長時間卡在字串 hash 計算，造成服務對所有使用者無回應（DoS），且**不需帳號**即可觸發 | 1MB body 上限（`readJson` 內建）只擋超大 payload，對演算法複雜度攻擊沒有實質防護 | NVD CVE-2025-27209 API、FIRST EPSS API、`nodejs/security-wg` vuln DB、`grep readJson` 本機驗證 |
| 3 | brace-expansion@1.1.16（task-tracker devDependency，經 eslint→minimatch 引入） | CVE-2026-14257（GHSA-mh99-v99m-4gvg，`maxLength` 前無界累積 OOM） | 未列 KEV | 0.339%／pctl 26.4% | 7.5 HIGH（AV:N/AC:L/PR:N/UI:N/A:H） | **不可達**：只在 `npm run lint`（eslint public/js）或 `npm test` 被載入；`dist/` 編譯產物與 autodeploy 的 `npm run build`（純 `tsc`）都不會載入 eslint／minimatch | 僅影響開發者/CI 本機跑 lint 時的行程，不影響對外服務可用性 | `npm audit --omit=dev` 回報 0 弱點，證實不在正式相依範圍 | `npm audit --json`（task-tracker package-lock）、GitHub Advisory API |
| 4 | brace-expansion@1.1.16（同上） | CVE-2026-69152（GHSA-rgw5-rvv9-x895，繞過 #3 的 `maxLength` 緩解，~25KB 輸入即可 OOM 或卡事件迴圈 2 分鐘+） | 未列 KEV | 0.368%／pctl 29.5% | 7.5 HIGH（同上向量） | 同 #3，**不可達**（同一顆套件、同一個未被正式流程載入的路徑） | 同 #3 | 同 #3 | GitHub Advisory API（`api.github.com/advisories/GHSA-rgw5-rvv9-x895`）、FIRST EPSS API |
| 5 | Node.js v24.3.0 | CVE-2026-21712（`url.format()` 處理不當 IDN 導致 native assertion crash） | 未列 KEV | 0.325%／pctl 24.9% | 5.7 MEDIUM（AV:N/AC:L/**PR:L/UI:R**——需權限＋使用者互動） | **不可達**：`grep -r "url.format(" src/` 於兩個 repo 均無命中，且此 CVE 本身需要 PR:L/UI:R，攻擊前提比典型伺服端 DoS 更嚴苛 | 低（無呼叫路徑＋前提條件嚴苛） | 無需額外控制 | NVD CVE-2026-21712 API |
| 6 | Node.js v24.3.0 | CVE-2026-21713（`crypto_hmac.cc` 內部 memcmp 非常數時間比較，理論上可做 timing oracle） | 未列 KEV | 0.385%／pctl 31.3% | 5.9 MEDIUM（AV:N/**AC:H**/PR:N/UI:N/C:H） | **未見可達路徑**：task-tracker `src/auth.ts` 的 session token 比對明確用 `node:crypto` 的 `timingSafeEqual`（見程式內註解「constant-time 比對，避免 timing attack」），**未**呼叫 `createHmac`；ai-quota `src/` 內 `grep Hmac` 無命中 | 低——分數與可達性都低，兩者一致，**不需要**被拉高優先序（放進表格是為了對照：不是所有中低分項目都該被拉高，這筆就該維持低分） | task-tracker 既有的 timingSafeEqual 已規避同類風險 | NVD CVE-2026-21713 API、`grep createHmac\|timingSafeEqual` 本機驗證 |

### 高分不可達 vs 低分應優先 對照（驗收要求的核心比較）

- **#1 CVE-2026-21710**：本批 EPSS 最高（26.4%／百分位 97.8%）、CVSS 7.5——若只看分數會排第一。但兩個 repo 都**沒有程式碼路徑**會觸發它（沒人呼叫 `req.headersDistinct`），照掃描分數排序會錯誤地把資源優先導向一個目前不成立的風險。
- **#2 CVE-2025-27209**：EPSS 只有 0.771%（百分位 52.2%），遠低於 #1，若純看 EPSS 排序會被排在中段。但它是**唯一在本表中有實際可達攻擊路徑**的項目——task-tracker 每個 JSON request（含未登入的登入端點本身）都會餵字串給受影響的 V8 版本，且服務對外可達（LAN）、未修補版本已用了超過一年。**分數排序與本地情境排序在這裡明確反轉**：#2 的實際優先序應高於 #1。

## 3. 排除／未完成查證項目（唯讀，不以假設補齊）

| 項目 | 狀態 | 理由／後續觸發 |
|---|---|---|
| Ubuntu 22.04.5 kernel 6.8.0-124-generic 及 OS 套件（openssl、glibc 等） | **UNKNOWN，未完成查證** | 需要 `dpkg -l` 版本清單逐一比對 Ubuntu Security Tracker／USN，本次時間範圍內未執行，不以推測填入 CVE／CVSS。重新評估觸發：下次盤點時列入，或收到任何 kernel/glibc CVE 公告時。責任人：Owner／後續維運者。 |
| ai-quota 呼叫的外部 CLI（`claude`、`codex`、`agy` 二進位，經 `execFile` 呼叫，見 `ai-quota.service` 的 `CLAUDE_BIN`／`CODEX_AUTH_PATH`／`AGY_BIN`） | **排除，非本 repo 相依樹** | 這些是各自獨立維運的產品／二進位，不在 ai-quota 的 package.json／lockfile 相依範圍內，非本 task 的「repo 依賴」定義。若要盤點需另開各自產品的 task。 |
| nginx（前端反向代理，兩服務共用） | **排除，不屬 task-tracker／ai-quota repo** | nginx 是主機共用基礎設施，服務多個不同 repo，版本／CVE 盤點超出本 task「task-tracker、ai-quota」範圍；僅在此記錄其作為可達性證據（見第 1 節）。 |

## 4. 建議（僅留建議，不逕行修改正式環境）

1. **task-tracker／ai-quota 的 Node.js 執行環境建議升級**（AV:N/PR:N/UI:N 的 #2 CVE-2025-27209 已有實際可達路徑；同時可一併修掉表中其餘已知 CVE，含 #1/#5/#6 等尚未確認可達但同樣未修補的項目）。目標版本至少 `>=24.14.1`（涵蓋本表全部 Node CVE 的修補基準），或直接採用現行 LTS 24.19.0。
2. brace-expansion（#3/#4）建議之後跑 `npm audit fix`（devDependency，不影響正式產物），非急迫但無副作用。
3. Node.js 升級須先在隔離環境驗證（不在本 task 範圍內執行），驗收後才排 task-tracker.service／ai-quota.service 的正式環境變更；升級後的 readback 定義：`node --version` 回報 `>=24.14.1`、`npm audit --omit=dev` 維持 0 弱點、`task-tracker` 的 `npm test` 全綠。
4. 重新評估時間：下次有新的 Node.js security release（`https://nodejs.org/en/blog/vulnerability/`）公告涵蓋 24.x 時，或距今 90 天（約 2026-11-04），先到者為準。
5. 責任人：本盤點為唯讀試點，實際升級與驗證由 Owner 指派後續維運者執行；本 task 只留下以上建議與驗證命令。

## 5. 重跑驗證命令（皆唯讀，未對正式環境造成副作用）

```bash
# KEV 目錄
curl -s https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json | grep -c CVE-2025-27209  # 預期 0（不在 KEV）

# EPSS
curl -s "https://api.first.org/data/v1/epss?cve=CVE-2025-27209,CVE-2026-21710,CVE-2026-14257,CVE-2026-69152,CVE-2026-21712,CVE-2026-21713"

# NVD CVSS
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2025-27209"

# 正式相依弱點（task-tracker／ai-quota 各自跑）
npm audit --prefix /home/hom/code/task-tracker --omit=dev   # 預期 0 vulnerabilities
npm audit --prefix /home/hom/code/task-tracker              # 預期只有 brace-expansion 1 筆 high（devDependency）
npm audit --prefix /home/hom/services/ai-quota               # 預期 0 vulnerabilities（含 dev）

# 可達性（reachability）grep
grep -rn "headersDistinct" /home/hom/code/task-tracker/src /home/hom/services/ai-quota/src   # 預期無命中
grep -rn "url.format(" /home/hom/code/task-tracker/src /home/hom/services/ai-quota/src        # 預期無命中
grep -rn "createHmac\|timingSafeEqual" /home/hom/code/task-tracker/src /home/hom/services/ai-quota/src

# 部署證據
node --version   # v24.3.0
cat ~/.config/systemd/user/task-tracker.service ~/.config/systemd/user/ai-quota.service ~/.config/systemd/user/ai-quota.timer
```

驗證環境：全程唯讀，未修改 task-tracker／ai-quota／nginx／systemd 任何檔案，未對正式服務發送測試流量，未使用任何正式 credential。
