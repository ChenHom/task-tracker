# Owner / Team 排程巡檢（2026-07-12）

- 巡檢時間：2026-07-12 16:30–16:35（Asia/Taipei, UTC+8）
- 範圍：`sim-sweep-owner.service`、`sim-sweep-team.service`、兩個 timer、2026-07-12 sim logs、owner state、主協作與 canonical 看板。
- 初始 git 狀態：`master` 無 tracked diff；既有未追蹤 `.sweep-disc.json`、`.sweep-tasks.json`。本次未讀寫回存、未覆蓋、未回復這兩檔，也未做 destructive git 操作。

## Timer / service 證據

- `sim-sweep-owner.timer`：`enabled`、`active`，排程仍為每小時 `:00/:30`；16:30:11 觸發，下一次 17:00。
- `sim-sweep-team.timer`：`enabled`、`active`，排程仍為每小時 `:15`；16:15:34 觸發，下一次 17:15。
- owner service：16:30:11–16:30:16，systemd `Result=success`、`ExecMainStatus=0`。應用 log 顯示 Claude quota probe 失敗，因此本 tick 主動略過 owner，並非完成看板處理。
- team service：16:15:34–16:20:21，systemd `Result=success`、`ExecMainStatus=0`。阿凱（Codex）完成驗證；小美（Claude）因 session limit 失敗，wrapper 隔離該 member 後正常收尾。
- 今日 journal 另確認 owner 15:00、15:30、16:00 與 team 15:15 均由 timer 啟動並由 systemd 正常結束；timer 未停用、未改頻率、未手動重啟。

## 執行、timeout 與錯誤

- 15:15 team：阿凱完成 `跨 workspace 搬移 task` 並由 driver 代 commit `48005a7`；小美超過 7 分鐘硬時限遭 SIGKILL，session 未成功，未提交 diff 保留在 `sim/user02` worktree。
- 15:30 owner：canonical workspace 嘗試合併 `sim/user03` 時，`src/server.ts`、`src/task.test.ts` 衝突，owner 正確 `git merge --abort` 並把 task 退回 Doing。brain workspace 當輪另回報 sandbox 阻擋寫入；當時沒有 Review/Doing task，未造成 merge 損壞。
- 16:00 owner：canonical workspace 完成巡檢；brain workspace owner session 遇 Claude session limit（訊息：16:50 Asia/Taipei reset）。
- 16:15 team：小美立即遇同一 Claude session limit；阿凱重跑 tsc、task/src 整合測試與 HTTP smoke 後把 task 轉回 Review，但 branch 仍是 `48005a7`、落後 master 6 commits，原 merge conflict 未消失。
- 16:30 owner：quota probe 判定 Claude 不可用，略過 owner。未人工重試，避免在 16:50 reset 前製造已知失敗；交由 17:00/17:15 原排程接續。
- owner state `sim-logs/.sweep-owner-state.json`：`{"streak":0,"timedOutWs":[]}`。今日 owner session 沒有 harness timeout；quota error 不會被誤記為 timeout streak。

## 看板與 worktree 狀態

- canonical workspace `d9da9945`：
  - Review / High：`11983af5` 跨 workspace 搬移 task；驗證證據完整，但 branch 尚未吸收 master，等待修正後的 owner/team 衝突交接流程。
  - Doing / High：`bf7f2b57` workspace archive/delete HTTP route；`sim/user02` 仍為 0 ahead，未提交 diff 與另一題混在同一 worktree，且 Claude quota 阻塞本輪整理。
  - Doing / Low：`5fcaee28` Commenter own description smoke；同受 `sim/user02` 混合 dirty diff 與 quota 阻塞。
  - Todo：`af06f594` 主協作交接 smoke、`ffcfa23d` @mention 通知、`8be538bc` 方向討論。
- 主協作 workspace `11a82028`：只有 `[規則] 主工作區協作與交接` 維持 Todo；兩則實際討論已在 15:00 owner tick 完成 handoff 並 Done。
- `sim/user02`：6 個 tracked 檔 dirty，加一個未追蹤 smoke script；均為既有 team work，本次未修改。
- `sim/user03`：worktree clean，branch `48005a7`，相對 master 為 `6 behind / 1 ahead`。

## 根因修正與驗證

- 根因：owner prompt 在 merge conflict 後要求成員 `rebase`，member prompt 卻禁止所有 git，工具白名單也沒有 git；因此成員只能重驗舊 branch，無法消除衝突，形成 Doing/Review 迴圈。
- 最小修正：owner 的兩種 prompt 改要求成員在自己的 branch `merge master`；member 只在 owner 明確指出 merge conflict 時可使用窄範圍 `git status/diff/merge/add/commit`，仍禁止 `rebase/reset/checkout`，正常工作仍由 driver 代 commit。
- TDD：先新增矛盾回歸檢查並確認 `node --import tsx sim/run.test.ts` 因缺少 merge 權限而失敗；實作後該測試通過。
- 完整驗證：`npm test` 通過（lint、app/sim typecheck、全部 src tests、frontend test、sim/run.test）。

## 剩餘 blocker

1. 外部 Claude session quota 至 16:50 才 reset；無法由 repo/config 安全修正，也不應猜憑證或切換帳號。
2. `sim/user03` 的既有 branch 衝突仍需下一輪 owner 退回後，由 team 依新流程 merge master 並解衝突；本次未直接改寫成員 branch。
3. `sim/user02` 保留兩題混合 dirty diff，需小美 session 恢復後拆分、驗證並交由 driver commit；本次為保護既有工作未介入。
4. `[討論] 方向與下一步` 仍等待真人老闆決定是否將 @mention 通知列為下一主線；不代猜產品決策。
5. brain workspace 曾出現 session sandbox 寫入限制；若下一輪有實際 code task 且可重現，需依該 repo/sandbox 權限另行處理，本次不擴大權限。
