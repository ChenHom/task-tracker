> **已取代／歷史紀錄（2026-07-16）**：AGY 試行未產生 task、comment 或 commit 副作用，Claude 額度恢復後已回復 user06 一般工作路由。現行決策見 [user06 Sonnet 5 路由恢復設計](2026-07-16-user06-sonnet5-route-restoration-design.md)。

# user06 AGY 額度切換設計

## 目標

在 Claude 五小時額度耗盡期間，讓 user06 的一般工作暫時以 AGY 執行，同時保留已可靠的 Codex notification preflight 與可觀測副作用驗收。

## 路由與安全邊界

- user06 一般工作路由暫時設為 `agy` / `Gemini 3.5 Flash (High)`。
- 這個明確 work override 的 fallback 必須是 `undefined`；AGY 不會轉往任何其他模型。
- user06 notification preflight 維持 `codex` / `gpt-5.4-mini`，不使用 AGY。
- 其他成員的 route 與 fallback 不變。

## 驗收

- focused test 鎖住 user06 的 AGY 一般工作 route、無 fallback、Codex notification route，以及 full sprint/team sweep 仍使用同一 resolver。
- 執行 TypeScript、focused sim test、完整測試與 build。
- 合併後以一次已授權的 team sweep 驗證。只有 user06 實際建立 task/comment、改變 task 狀態/內容、或由 driver 建立 worktree commit 時才算完成；無副作用的 exit 0、self-introduction、失敗或 timeout 都保持 task 在原狀並回報。

## 非目標

- 不放寬 AGY 權限、不新增 `--dangerously-skip-permissions`。
- 不改 notification gate、任務角色、timer 排程或其他 member 的 runner。
