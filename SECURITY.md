# 安全政策（Security Policy）

## 專案性質

本專案（[ChenHom/task-tracker](https://github.com/ChenHom/task-tracker)）為公開的教學／作品集用途程式庫，用來練習 Event Sourcing、CQRS 與 RBAC 架構。目前沒有對外公開部署或網域，實際運行僅限本機／模擬測試環境（`localhost:3000`），不屬於 Internet-facing 系統，因此不發布 `security.txt`。以下政策僅涵蓋本 GitHub 程式庫本身（原始碼、相依套件、CI/CD 設定）。

## 支援版本

本專案沒有正式的版本化發行（release/tag 皆為內部模擬用途，非語意化版本），僅 `master` 分支的最新版本受安全支援。請勿假設任何舊版 commit 或 fork 會收到修補。

## 回報漏洞（Reporting a Vulnerability）

若你認為在本程式庫中發現安全漏洞，請透過 GitHub 的 **Private Vulnerability Reporting** 私下回報：

👉 <https://github.com/ChenHom/task-tracker/security/advisories/new>

**請勿**透過公開 GitHub Issue、Discussion 或 Pull Request 揭露漏洞細節，以避免在修補前公開曝光。

若上述入口暫時無法使用（例如尚未啟用），請改以 repo owner（[@ChenHom](https://github.com/ChenHom)）的 GitHub 帳號私訊或既有聯絡管道回報，並在訊息中註明是安全性回報。

### 回報請包含

- 漏洞描述與潛在影響
- 重現步驟（reproduction steps）或概念驗證（PoC）
- 受影響的檔案／端點／commit（若已知）

### 我們的處理方式

- 我們會盡力在合理時間內確認收到回報，但**不承諾固定的確認或修復時限**——本專案為兼職維護的教學專案。
- 確認後會視嚴重度分級處理，修復完成並發佈後才會協調公開揭露（coordinated disclosure）。
- 我們感謝負責任揭露（responsible disclosure），但目前沒有 bug bounty 計畫。

## 範圍界定（Scope）

- **適用範圍內**：本 GitHub 程式庫的原始碼、相依套件與 CI/CD 設定。
- **不適用範圍**：`localhost:3000` 或任何本機／模擬執行環境——這些不是對外服務，請勿對其進行未授權測試。
- 本政策**不授予**任何形式的滲透測試或主動攻擊授權；回報應基於程式碼閱讀、靜態分析或在你自行架設的本機環境中重現，而非對他人執行的實體進行未授權測試。

## 聯絡資訊維護

本檔案與 GitHub private vulnerability reporting 設定會隨專案維護一併複核，若長期無人監看或聯絡方式已失效，請以 Issue 或 repo owner 既有聯絡管道反映。
