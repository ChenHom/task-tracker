# Task Tracker

一個從零打造的全功能任務管理系統，採用 **Event Sourcing**、**CQRS** 與 **RBAC** 架構設計 —— 作為後端工程實戰練習，涵蓋真實世界的架構模式與 OWASP 資安實踐。

> **這不是 Jira 或 Trello 的仿製品。** 而是一套刻意設計的系統，用來練習事件驅動設計、狀態機、審計追蹤與角色權限控管。

## ✨ 功能特色

### 核心架構
- **Event Sourcing** — Workspace、Member、Task 聚合根將所有狀態變更儲存為不可變事件
- **CQRS** — 寫入走命令端寫進事件儲存；查詢走讀取模型
- **樂觀鎖** — 資料庫層級的 `(aggregate_id, aggregate_version)` 唯一約束，防止寫入衝突

### 任務管理
- **看板** — 視覺化看板，狀態機為 Todo → Doing → Review → Done（允許一步回退）
- **豐富協作** — `@mention` 提及成員、`#N` 留言引用（平滑捲動）、`::shortId` 跨任務連結
- **專案分類** — 在工作區內將任務分組
- **附件** — 檔案上傳/下載，含路徑穿越防護
- **搜尋** — 工作區範圍內的全文搜尋

### 權限控管（RBAC）
- **五層角色階層**：`Owner > Admin > Member > Commenter > Viewer`
- **工作區範圍權限** — `requirePermission` 是唯一權威來源；前端僅調整 UI 顯示
- **Commenter 角色** — 可建立討論任務與留言、編輯自己建立的任務描述；不可修改他人任務或專案設定

### 資訊安全（OWASP Top 10）
- `scrypt` 密碼雜湊搭配 prepared statements（防 SQL injection）
- Cookie-based session 搭配 `SameSite=Strict` + Origin 檢查（防 CSRF）
- 登入與忘記密碼端點設有 Rate Limiting
- 下載回應帶 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`
- 所有使用者輸入一律透過 `textContent` 渲染（不使用 `innerHTML` 插入使用者資料）
- 靜態檔案與附件的路徑穿越 / symlink 邊界守門
- 審計追蹤記錄 `actor_id`、`ip`、`user_agent`、`request_id`

### AI 模擬測試
- 多模型 AI 車隊（Claude、Codex、Antigravity）模擬真實使用者
- 對系統進行 Dogfooding 測試——自動化任務建立、討論與審查流程

## 🏗️ 架構設計

```
使用者 → 命令 → 權限檢查 → 聚合根 → 事件儲存 → 投影 → 讀取模型
```

| 層級 | 說明 |
|---|---|
| **命令（Command）** | 驗證並套用業務規則 |
| **事件儲存（Event Store）** | 單一 append-only 表格，存放所有聚合根的事件 |
| **投影（Projection）** | 每次事件同步更新讀取模型 |
| **讀取模型（Read Model）** | 扁平化表格，為查詢最佳化 |

### 事件溯源聚合根

| 聚合根 | 事件 |
|---|---|
| **Workspace** | `created`、`renamed`、`archived`、`deleted` |
| **Member** | `invited`、`joined`、`role_changed`、`removed` |
| **Task** | `created`、`title_changed`、`description_changed`、`status_changed`、`priority_changed`、`assignee_changed`、`due_date_changed`、`archived`、`deleted`、`moved`、`main_discussion_concluded` |

## 🛠️ 技術堆疊

| 組件 | 技術 |
|---|---|
| 執行環境 | Node.js（原生 `node:http`、`node:sqlite`） |
| 語言 | TypeScript（strict 模式） |
| 資料庫 | SQLite（嵌入式，零設定） |
| 前端 | 原生 JS SPA，hash routing（無框架） |
| 建構 | `tsc` 型別檢查、`tsx` 開發伺服器 |

**零外部執行期依賴** — 僅有 `devDependencies` 用於 TypeScript 工具鏈。

## 🚀 快速開始

### 前置需求

- **Node.js** ≥ 22.x（使用原生 `node:sqlite`）

### 安裝與啟動

```bash
# 複製專案
git clone https://github.com/ChenHom/task-tracker.git
cd task-tracker

# 安裝開發依賴
npm install

# 建立測試帳號（user01~user30@test.local，密碼：test1234）
npm run seed

# 啟動開發伺服器
npm run dev
```

應用程式將在 `http://localhost:3000` 啟動。

### 登入

使用任一測試帳號：
- **Email**：`user01@test.local` ~ `user30@test.local`
- **密碼**：`test1234`

### 可用指令

| 指令 | 說明 |
|---|---|
| `npm run dev` | 啟動開發伺服器（hot reload） |
| `npm run build` | 編譯 TypeScript |
| `npm start` | 執行編譯後的正式伺服器 |
| `npm run seed` | 建立/重設測試帳號（冪等操作） |
| `npm run typecheck` | 執行 `tsc --noEmit` 檢查所有原始碼 |
| `npm test` | Lint + 型別檢查 + 單元測試 + 模擬測試 |

## 📡 API 參考

### 認證

| 方法 | 端點 | 說明 |
|---|---|---|
| `POST` | `/api/auth/login` | 登入（設定 session cookie） |
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/me` | 取得目前使用者資訊 |
| `POST` | `/api/auth/forgot-password` | 申請密碼重設 |
| `POST` | `/api/auth/reset-password` | 使用 token 重設密碼 |

### 工作區

| 方法 | 端點 | 說明 |
|---|---|---|
| `GET` | `/api/workspaces` | 列出使用者的工作區 |
| `POST` | `/api/workspaces` | 建立工作區 |
| `PATCH` | `/api/workspaces/:id` | 重新命名工作區（Admin+） |
| `POST` | `/api/workspaces/:id/archive` | 封存工作區 |
| `POST` | `/api/workspaces/:id/delete` | 刪除工作區 |

### 成員

| 方法 | 端點 | 說明 |
|---|---|---|
| `GET` | `/api/workspaces/:id/members` | 列出成員 |
| `POST` | `/api/workspaces/:id/members` | 邀請成員（Admin+） |
| `POST` | `/api/workspaces/:id/members/join` | 接受邀請 |
| `PATCH` | `/api/workspaces/:id/members/:userId` | 變更角色（Admin+） |
| `DELETE` | `/api/workspaces/:id/members/:userId` | 移除成員（Admin+） |

### 任務

| 方法 | 端點 | 說明 |
|---|---|---|
| `GET/POST` | `/api/workspaces/:id/tasks` | 列出 / 建立任務 |
| `GET/PATCH/DELETE` | `/api/tasks/:id` | 讀取 / 更新 / 刪除任務 |
| `POST` | `/api/tasks/:id/archive` | 封存任務 |
| `POST` | `/api/tasks/:id/move` | 跨工作區搬移任務 |

### 協作

| 方法 | 端點 | 說明 |
|---|---|---|
| `GET/POST` | `/api/tasks/:id/comments` | 列出 / 建立留言 |
| `PATCH` | `/api/comments/:id` | 編輯自己的留言 |
| `DELETE` | `/api/comments/:id` | ~~刪除~~ → 405（留言不可刪除） |
| `GET/POST` | `/api/tasks/:id/attachments` | 列出 / 上傳附件 |
| `GET/DELETE` | `/api/attachments/:id` | 下載 / 刪除附件 |

### 其他

| 方法 | 端點 | 說明 |
|---|---|---|
| `GET` | `/api/health` | 健康檢查 |
| `GET` | `/api/search?workspace=:id&q=...` | 工作區範圍搜尋 |
| `GET` | `/api/audit?aggregate_id=...` | 審計追蹤（Admin+） |
| `GET` | `/api/quota` | AI 額度儀表板 |
| `GET` | `/api/notifications` | 列出通知 |
| `POST` | `/api/notifications/:id/read` | 標記通知為已讀 |
| `GET` | `/api/users/search?q=...` | 以 email 搜尋使用者 |

## 📁 專案結構

```
task-tracker/
├── src/                    # 後端原始碼（TypeScript）
│   ├── server.ts           # HTTP 伺服器與路由處理
│   ├── eventStore.ts       # 事件溯源核心
│   ├── schema.ts           # SQLite schema 與 migration
│   ├── auth.ts             # 認證與 session 管理
│   ├── workspace.ts        # 工作區聚合根
│   ├── member.ts           # 成員聚合根與 RBAC
│   ├── task.ts             # 任務聚合根與狀態機
│   ├── comment.ts          # 留言 CRUD
│   ├── attachment.ts       # 附件處理
│   ├── notification.ts     # 通知系統
│   ├── search.ts           # 全文搜尋
│   ├── audit.ts            # 審計追蹤查詢
│   ├── mainDiscussion.ts   # 主工作區治理
│   └── *.test.ts           # 共置單元測試
├── public/                 # 前端（原生 JS SPA）
│   ├── index.html          # 單頁應用進入點
│   ├── app.js              # 應用程式初始化
│   ├── js/                 # 模組（路由、狀態、視圖）
│   └── css/                # 樣式表
├── sim/                    # AI 模擬測試
├── deploy/                 # 部署設定（systemd）
├── docs/                   # 設計文件與任務歷史
├── design.md               # 單一設計基準
└── data/                   # SQLite 資料庫（已 gitignore）
```

## 📝 授權

本專案為教學與作品集用途。
