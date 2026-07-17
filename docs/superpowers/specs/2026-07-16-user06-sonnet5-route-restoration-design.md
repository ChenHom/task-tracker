# user06 Sonnet 5 路由恢復設計

## 目標

AGY 已經實測為無副作用，且 Claude 五小時額度已恢復可用；將 user06 的一般工作恢復為 Claude `claude-sonnet-5`，讓其接續 `Doing` 任務。

## 路由

- user06 一般工作：`claude` / `claude-sonnet-5`。
- 明確 work override 仍回傳 `fallback: undefined`，不得回退 AGY。
- user06 notification preflight：`codex` / `gpt-5.4-mini`，不變。
- 其他 member 不變。

## 驗收

- focused route test 鎖住 Sonnet 5、無 fallback、Codex notification 與兩個 normal-work entry point。
- 完整 TypeScript、test、build 通過。
- 合併後執行一次已授權 team sweep；只以 task/comment/commit 等實際副作用判定 user06 成功。
- 先前 AGY quota 切換設計明確標為已回退的歷史紀錄。
