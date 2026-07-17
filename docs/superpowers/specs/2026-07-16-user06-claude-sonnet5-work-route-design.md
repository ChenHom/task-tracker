> **已取代／歷史紀錄（2026-07-16）**：現行政策見 [user06 Sonnet 5 路由恢復設計](2026-07-16-user06-sonnet5-route-restoration-design.md)。user06 一般工作使用 Claude `claude-sonnet-5`，不設 AGY fallback；notification preflight 使用 Codex `gpt-5.4-mini`。以下內容保留為歷史記錄。

# user06 Claude Sonnet 5 工作路由設計

## 目標

讓 user06（小芸）在一般任務工作階段改用 Claude `claude-sonnet-5`，同時保留已驗證的 Codex notification preflight，避免 AGY 的無副作用成功回應再次阻塞或偽裝成正常工作。

## 範圍與路由

- 只為 user06 新增一般工作路由 override：`claude` / `claude-sonnet-5`。
- user06 的通知 preflight 維持 `codex` / `gpt-5.4-mini`。
- 其他成員維持既有 `runner`、`model` 與 fallback 行為。
- user06 設定一般工作 override 時，不帶入既有的 AGY fallback；Claude 工作失敗、逾時或額度不足都在該次 session 結束，不會轉回 AGY。

## 執行流程

1. team sweep 先以 Codex 做 user06 每筆未讀通知的 preflight，沿用既有的主工作區留言驗證與標已讀規則。
2. preflight 全數成功後，scheduler 對 user06 的 Todo/Doing 任務以 Claude Sonnet 5 啟動一般工作 session。
3. full sprint 的 user06 round 同樣使用 Claude Sonnet 5；不因 sweep/full sprint 入口不同而產生 AGY 回退。
4. 未設定 override 的成員仍以既有設定執行，包含原本的 fallback。

## 實作邊界

- 在 `sim/run.ts` 的成員設定引入明確的工作路由 override 與 resolver；resolver 同時決定 route 與是否可使用 fallback，避免各呼叫點自行拼湊造成 AGY 洩漏。
- 將 full sprint 與 team sweep 的一般 member session 都改接 resolver；通知 resolver 與 gate 語意不變。
- 不擴大 AGY 權限、不改任務資料、角色、通知讀取規則或 timer 排程。

## 驗證與驗收

- focused test 斷言 user06 的通知路由為 Codex、一般工作路由為 Claude Sonnet 5，且一般工作 override 不附帶 AGY fallback；並以 source-level contract 鎖住 full sprint 與 team sweep 的一般 session 都透過該 resolver；user02 保持既有預設。
- 執行 `npx tsc --noEmit`、`npx tsx sim/run.test.ts`、`npm test` 與 `npm run build`。
- 取得本次授權後，先確認 user06 有 eligible 的已指派 Todo/Doing 任務，再執行一次 `npm run sim -- --sweep team`；確認 user06 的 session log 顯示 `claude/claude-sonnet-5`，且實際產生可觀測的任務工作副作用；notification preflight 不得回退到 AGY。
- 若 Claude session 沒有可觀測副作用，保留 task 在原狀並回報 runner 輸出；不得把無副作用的 exit 0 視為成功。
