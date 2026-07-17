# Sweep 最低二十分鐘 Timeout 設計

## 目標

避免定時 team sweep 在 user06 等正常任務剛開始修改時，以七分鐘中止 session；owner 與 team sweep 的每個一般工作 session 都至少允許二十分鐘。

## 範圍

- `SWEEP_MEMBER_TIMEOUT` 改為 20 分鐘。
- `SWEEP_OWNER_TIMEOUT` 基準改為 20 分鐘，保留既有每次 timeout 加 6 分鐘、最高 30 分鐘的 adaptive 行為。
- full sprint 的 `MEMBER_TIMEOUT` 與 `OWNER_TIMEOUT` 不在此次修改範圍。
- 既有逾時安全語意不變：不自動 commit、不清除 dirty worktree、下個 tick 可在同一 worktree 繼續。

## 驗證

- focused test 鎖住 team/owner sweep 的 20 分鐘基準與 owner 30 分鐘上限。
- 執行 TypeScript、focused sim test、完整測試與 build。
- 合併後不 reset `sim-work/user06` 的 `public/js/views/kanban.js` dirty diff；執行一次已授權的 team sweep，確認 user06 以目前設定的工作 route 從現有 worktree 繼續，並以實際 task/comment/commit 副作用驗收。
