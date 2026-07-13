# Git Pre-commit 與暫存快照清理設計

## 目標

移除 repo 根目錄中不屬於產品程式的 API 快照檔，並讓 Git commit 自動執行既有的 `npm run lint`。

## 設計

- 刪除 `.disc_comments.json`、`.doc_comments.json`、`.owner_tasks.json`、`.quota_comments.json`、`.sweep-disc.json`、`.sweep-tasks.json`；這些是未追蹤的巡檢快照，不被 repo 程式引用。
- 新增可版本控制的 `.githooks/pre-commit`，從 repo root 執行 `npm run lint`，沿用既有 lint script，不引入 Husky 或其他依賴。
- 設定目前 checkout 的 `core.hooksPath` 為 `.githooks`，讓 hook 立即生效；hook 本身納入 Git，其他 checkout 可依同一設定啟用。

## 驗證

- 直接執行 hook 時，應得到與 `npm run lint` 相同的結果與 exit code。
- 目前已知 `public/js/views/kanban.js:385` 有既有 lint 錯誤，因此 hook 應先以失敗驗證「會阻止 commit」；修正該錯誤後再以成功結果驗證放行。
- `git status` 不應再列出 6 個快照檔。
