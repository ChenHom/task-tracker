# 跨 repo CRA 2026 適用性與 24／72 小時準備度唯讀盤點

> 查證日：2026-08-06。這是工程證據清冊，不是 CRA 適用性、產品分類或法定角色的法律意見；未取得可查證的 Union market 供應證據時，一律標為 `排除候選／需法務確認`，不推定為已排除或合規。

## 結論

- 本輪選定的跨 repo 工程基線（`task-tracker`、`ai-quota`、`tw-day-trading` 與 owner-team report）沒有找到 EU 下載、銷售、授權、設備搭售、商業開源供應，或產品已在 Union market 提供之 remote data processing 的證據。因此沒有可納入的產品，也不做虛構事件桌上演練。
- 依 [Regulation (EU) 2024/2847, Article 71](https://eur-lex.europa.eu/eli/reg/2024/2847/oj?eliuri=eli%3Areg%3A2024%3A2847%3Aoj&locale=en)，Article 14 的通報義務自 **2026-09-11** 適用；本盤點日仍未生效。若日後確認某項產品已在 Union market 提供，manufacturer 必須依 Article 14 的「aware」時點處理 24 小時 early warning 與 72 小時 notification；正式門檻、收件 CSIRT、角色與通報內容交由法務確認。
- CRA 的完整主要義務自 2027-12-11 才適用。這不把 2026-09-11 前後的工程準備，誤寫成目前已確認的法定責任。

## 查證範圍與納入／排除清冊

| Repo／產品候選、版本／查證日 | 可回查的工程／散布與 EU 可得證據 | 暫定角色 | CRA 本輪判定與責任缺口 |
| --- | --- | --- | --- |
| `task-tracker`（`/home/hom/code/task-tracker`），`0.0.1`／2026-08-06 | `package.json` 為 `private: true`；README 定義為教學與作品集用途，啟動位置為 `localhost:3000`；`docs/security/ai-usage-inventory.md` 明載 AI 輸出只在本機／內部工作區流轉、未宣告對外發布地區。頂層沒有 `LICENSE`／`NOTICE`，且未找到 EU 下載、銷售、授權、裝置搭售或 EU market evidence。 | manufacturer／open-source software steward：`UNKNOWN`；沒有 Union market 供應證據，不能只由原始碼判定。 | **排除候選**：不建立 Article 14 runtime gate 或 SRP 流程。產品／市場 owner、公開 GitHub 或下載頁的實際可得性、EU 使用者或客戶、付費／授權模式、security contact 與協調 CSIRT 均為 `UNKNOWN`；法務確認前不得宣稱不在 CRA 範圍。 |
| `ai-quota`（`/home/hom/services/ai-quota`），`0.1.0`／2026-08-06 | 是讀取本機 CLI credential、查詢 provider usage 的 oneshot poller；對外只寫 redacted quota snapshot，供 `dev.hom.localhost` 的 LAN/VPN allowlist 讀取（`README.md`、`AGENTS.md`、`docs/operations.md`）。頂層沒有 `LICENSE`／`NOTICE`。有 remote provider calls，但未找到本身作為產品在 Union market 提供、散布或商業供應的證據。 | manufacturer／open-source software steward：`UNKNOWN`；internal component 與產品角色不可混為一談。 | **排除候選**。provider API 使用與產品供應是不同問題；產品／市場 owner、security contact、協調 CSIRT、未列 consumer 與跨區提供情形均為 `UNKNOWN`，應由業務／法務確認。 |
| `tw-day-trading`（`/home/hom/services/stock/tw-day-trading`），release version `UNKNOWN`／2026-08-06 | README／`AGENTS.md` 定義為台股量化交易 MVP，使用 TWD、XTAI、Asia/Taipei 與台灣行情來源；工程紀錄描述為單人、區網主機、手機經內網查看。沒有找到 EU 銷售、下載、授權、裝置搭售或 EU 客戶／市場證據，也沒有頂層 `LICENSE`／`NOTICE`。 | manufacturer／open-source software steward：`UNKNOWN`；台灣市場與內網證據不能反推 EU 未供應，也不能當作 EU 供應證據。 | **排除候選**。真實使用者、營運／產品 owner、公開網站、付費或 EU 客戶、security contact 與協調 CSIRT 均為 `UNKNOWN`；發生任一項時重新盤點。 |
| owner-team Ollama report（`/home/hom/.openclaw/workspace/owner-team-report`），release version `UNKNOWN`／2026-08-06 | README 明定它是 OpenClaw workspace 的外部運維工具、不是 task-tracker 功能；只讀 sweep log，向區網 Ollama 送摘要，僅 `--send` 才送固定 Discord channel。未找到產品散布或 Union market 供應證據。 | manufacturer／open-source software steward：不適用的**排除判定**，但正式法律角色仍需法務確認。 | **排除**：內部運維工具。若改為對外報表服務、公開下載工具或以客戶資料運作，應另開產品／資料流範圍，指定 owner、security contact 與法律角色，不可沿用本排除。 |

本輪沒有讀取正式 credentials、客戶資料、provider 帳務、production DB 或外部平台資料，也沒有修改服務、DNS、CI、snapshot 或 repository。

## 若出現範圍內產品時的最小 24／72 小時責任矩陣

下表是待法務確認產品已在 Union market 提供後才可啟用的交接模板；不是現行流程，也不向 ENISA SRP 提交資料。

| 時點／資料包 | 工程 owner | 產品／資安 owner | 法務／對外窗口 | 可回查證據與停止條件 |
| --- | --- | --- | --- | --- |
| T0：收到漏洞、incident 或 exploitation 訊號 | 保全原始 timestamp、來源、受影響版本、環境與存取限制；不把未修補細節貼到公開 task。 | 判定是否屬產品、是否已有實際 exploitation／嚴重 incident，以及 aware 的候選時點。 | 確認 manufacturer／steward 等角色、Union market 關聯、CSIRT／SRP 收件與保密限制。 | 任何產品、角色、日期或管道未知時停在 `需法務確認`，不啟動對外通報。 |
| T0 + 24h：early warning 候選 | 提供產品識別、版本、初步影響、發現時間、目前緩解與證據連結。 | 審核事實完整性與影響，不把未驗證 IOC 或客戶資料當結論。 | 決定是否達 Article 14 門檻並負責批准／送出；工程人員不自行送 SRP。 | 保存去識別化時序與核准人；正式資料只留在受限 incident record。 |
| T0 + 72h：notification 候選 | 更新 exploit／vulnerability 概況、受影響產品、修補／緩解與使用者可採取措施。 | 確認產品版本、供應市場與對使用者的實際影響。 | 確認敏感度標示、法定欄位與送件／readback。 | 未能確認產品已在 Union market 提供、manufacturer 或收件端時，不得以工程推測完成通報。 |
| 修補或事件收尾 | 留下修補版、驗證、使用者可採取措施與可重跑 readback。 | 確認 corrective／mitigating measure availability 與使用者通知責任。 | 依適用法定時點決定 final report、使用者通知與保留邊界。 | 不將修補上線、法定通報、客戶通知或資料保存聲稱為已完成，除非有相應核准與 readback。 |

## 重評觸發與最小下一步

| 觸發 | 必要下一步 |
| --- | --- |
| 新增 EU 下載頁、EU 銷售／授權、EU 客戶、裝置搭售、對外託管或可證實在 Union market 提供的 remote data processing | 先指定產品、資安與法務 owner；保存市場可得性與版本 evidence，並由法務完成 CRA 適用性／角色判定。 |
| 確認屬範圍內的產品 | 以合成產品版本與假事件做桌上演練：T0、24h、72h、final report、修補與使用者通知交接；不得用真實未修補弱點、客戶資料、credential 或正式 SRP。 |
| 發生真實 actively exploited vulnerability 或 severe incident | 立即依 incident process 升級至資安／法務；本文件不授權對外送件、公開披露或修改正式服務。 |
| 外部發布、公開文件、EU 使用情境或 AI/remote processing 資料流改變 | 重新查證散布、地區、資料、角色與保留邊界；既有 `排除候選` 不再有效。 |

## 回查路徑

- `README.md`、`package.json`、`docs/security/ai-usage-inventory.md`、`design.md`
- `/home/hom/services/ai-quota/{README.md,AGENTS.md,design.md,docs/operations.md}`
- `/home/hom/services/stock/tw-day-trading/{README.md,AGENTS.md,docs/development/engineering-log.md}`
- `/home/hom/.openclaw/workspace/owner-team-report/README.md`
- [European Commission CRA summary](https://digital-strategy.ec.europa.eu/en/policies/cra-summary) and [CRA reporting obligations](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)
