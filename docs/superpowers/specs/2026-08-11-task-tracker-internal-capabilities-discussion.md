# task-tracker 內部能力與 safe discussion 討論紀錄

日期：2026-08-11（Asia/Taipei）

狀態：討論紀錄；文件已於 `c4b3fae` 提交，後續實作已完成並通過驗證。

## 目前確認的問題根因

2026-08-09 新增 `safe discussion` 後，主工作區通知不再固定送出「已閱讀，目前無補充。」；`processNotificationGate()` 改要求主工作區呼叫端提供 `runDiscussion`。

Member session 與 Team sweep 已接上 safe runner，但 Owner sweep 漏接。當 notification gate 開啟且 Owner 有未讀主工作區通知時，就會在 `sim/run.ts` 的主工作區分支以「主工作區 safe discussion runner 未提供」 fail-closed。

這是新安全流程接到舊 Owner sweep 時的整合遺漏，不是原本的 keep-alive socket 或 Owner cookie 重用問題。先前沒有暴露，是因為舊流程使用固定 no-op 回覆，或 gate 沒有遇到需要 safe runner 的未讀主工作區通知。

這次討論期間曾提出一個直接修正，但已完整 revert；目前沒有因該修正留下的程式變更。

## safe discussion 的定位

`safe discussion` 是主工作區通知的隔離查證路徑，目的是讓不可信的 task／留言內容不能直接取得：

- task-tracker session cookie
- task-tracker API
- shell、檔案與 Git
- repo 或本機環境
- 任意私有網路目的地

它只使用受限的公開 WebSearch／WebFetch，並驗證模型是否產生具體的 `【同意】` 或 `【疑慮】` 回覆。

## 「私有 URL」的定義

這裡的私有 URL 是指指向本機、內網或特殊保留網段的目的地，不是泛指「需要登入的網站」。目前規則涵蓋：

- `localhost`、`127.0.0.1`、`::1`
- `10.x.x.x`、`172.16.x.x`–`172.31.x.x`、`192.168.x.x`
- `169.254.x.x` metadata／link-local 位址
- `*.local`、IPv6 ULA／link-local 位址
- task-tracker 的 `http://localhost:3000/api/...`

因此 task-tracker 自己的 API 確實屬於私有目的地，但本次需求是要對 internal route 開放它，不代表要對公開 WebFetch 全面解除私有網路限制。

另有兩種獨立的拒絕規則：

- `https://user:password@example.com`：URL userinfo，含帳密。
- `https://example.com:8443`：非標準 port。

## 需求共識

Owner 與 Team 的 task-tracker internal route 都需要能操作：

- task-tracker 自己的 API
- 同 repo 內的檔案
- 同 repo 需要的命令
- 目前 actor 自己的 task-tracker cookie
- 同 repo 的 Git

這不等於開放所有私有網路或整台主機的所有權限。

## Owner／Team 原能力與新能力比較

| 能力 | Owner 原能力 | Owner 新能力 | Team 原能力 | Team 新能力 |
|---|---|---|---|---|
| task-tracker API | 主要靠 `curl`；主工作區 Owner 只有 curl 工具 | 正式使用 task-tracker API，包含讀取、留言、狀態與必要寫入 | 一般實作已可用 `curl` + 自己 cookie | 保留，但限制只到 task-tracker API |
| Cookie | Owner session cookie 可由 driver 使用 | 只注入目前 Owner 的暫時 cookie | 成員自己的 session jar | 只注入目前 Team member 的暫時 cookie |
| Repo 檔案 | 主工作區 Owner session 不能直接讀寫檔案 | 可操作 `/home/hom/code/task-tracker` repo root | 可操作自己的 `sim-work` worktree | 保留，明確限制在自己的 worktree |
| 命令 | 主工作區主要只有 `curl`；其他 Owner route 工具較寬 | 允許必要的 repo 命令、測試與 API 操作，不開任意 shell | 已有 `curl`、`npm`、`npx`、Read/Write/Edit 等 | 大致保留，但改成正式 capability profile |
| Git | 主工作區 Owner 不直接做一般 Git 實作 | 可做受控 Git，例如 status、diff、add、commit、merge | 已可做 status、diff、merge、add、commit | 保留；禁止 reset、force 等危險操作 |
| 工作目錄 | Owner 依 scenario；主工作區是 repo root | 固定限制在 task-tracker repo root | 自己的 member worktree | 固定限制在自己的 member worktree |
| 主工作區討論 | safe discussion 隔離；Owner 目前漏接 runner | 討論仍可隔離；需要內部操作時切到 Owner internal route | safe discussion 只能 WebSearch／WebFetch | 可選擇由 driver 提供 read-only internal context，必要時再進 Team internal route |
| 公開外網 | safe route 可 WebSearch／WebFetch | 保留在 research route，不與內部 API 混用 | safe route 可 WebSearch／WebFetch | 同樣保留 |
| 私有網路 | safe route 阻擋 localhost／內網 | 只對 task-tracker 自己的 API 開例外 | safe route 阻擋 localhost／內網 | 只對 task-tracker 自己的 API 開例外 |

## 目前建議的方向

不建議把 safe discussion 的所有隔離一次取消。較好的方式是分成兩階段：

1. **討論／查證階段**：保持 safe runner 隔離；必要的 task-tracker 內部資訊由 driver 以 read-only、bounded context 提供，不直接交出 cookie 或 shell。
2. **執行／實作階段**：討論結果通過後，才啟動 Owner 或 Team internal runner，使用各自的 API、repo、命令、cookie 與 Git 邊界。

因此 Team 一般實作目前已有大部分能力，真正需要重新設計的是主工作區通知那條路徑；Owner 則需要額外的受控 internal execution route。

## 尚未決定的項目

- 命令採明確 allowlist，或允許所有 shell 但限制 cwd／路徑；目前傾向 allowlist。
- Owner／Team 可寫入的 API endpoint 與操作範圍。
- cookie 是否只能使用目前 actor、僅暫存且禁止落盤；目前傾向如此。
- Git 是否只允許 status、diff、add、commit、merge，並明確禁止 reset／force。
- repo 範圍是否包含 `sim-work/*` 與 `data/dev.db`。
- internal route 是否保留公開 WebSearch／WebFetch，或將查證與內部操作完全分開。

## 相關程式與文件

- `sim/run.ts`
- `sim/notificationSecurity.ts`
- `sim/notification-egress-hook.ts`
- `docs/superpowers/specs/2026-08-09-safe-main-discussion-member-replies-design.md`
- `docs/superpowers/plans/2026-08-09-safe-main-discussion-member-replies.md`
- 根因相關 commit：`4aa6e56`、`c853a7b`

## 實作結果（2026-08-11）

已依本紀錄採用「safe research route」與「internal execution route」分離的方式：

- `safeDiscussion` 維持 `WebSearch,WebFetch`、暫存工作目錄、egress policy 與私有目的地阻擋；沒有 cookie、task-tracker API、shell、檔案或 Git。
- 新增 `safeDiscussion`、`ownerInternal`、`memberInternal` capability profiles。Owner internal session 的 cwd 是目前 active scenario repo root；Team internal session 的 root 是目前 scenario 的 `sim-work`，cwd 限制在該 member worktree（profile 的預設根仍是 task-tracker repo）。
- internal route 可使用明確 allowlist：`curl`、`npm`、`npx`、Read/Write/Edit/Glob/Grep，以及 `git status/diff/log/show/merge/add/commit`；沒有 `git reset`、rebase 或 force 操作。
- Owner／Team 的 internal discussion session 只把目前 actor 的 `session` cookie 寫成 mode `0600` 的暫時 Netscape cookie jar；session 結束後在 `finally` 移除，prompt 與 telemetry 不寫入 raw cookie。
- internal prompt 只允許對 `http://localhost:3000/api/` 使用該 jar，並禁止 session 自己執行通知回覆 POST、標記已讀與最後 readback；driver 仍負責回覆驗證、寫入與 readback。
- safe 與 internal packet 使用顯式 `discussionMode`，避免 internal session 收到 safe route 的互斥「不可使用 API／檔案」指令。Team 一般工作與 Owner sweep 已接上 internal callback；Team 的獨立 notification preflight 仍保留 safe runner。

驗證：`node --import tsx sim/agentCapabilities.test.ts`、`node --import tsx sim/run.test.ts`、`npx tsc --noEmit`、`npm test` 均通過；沒有執行 live `npm run sim` 或 `--sweep`。
