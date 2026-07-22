# 正式環境 Sim 協調器設計

## 目標

以單一、可安全重啟的正式環境協調器取代不可靠的 Owner／Team sweep，解決「exit 0 卻沒有實際進展」「同一 branch 混雜多個 task」「主討論結案卡在自然語句判斷」「未指派 Todo 無人可執行」等既有失敗模式，讓 task-tracker 已完成的工作能可靠地規劃、分派、驗證、部署、復原並回報，不再卡關數日。

## 範圍

**本期包含：**

- 只服務兩個固定 workspace：主協作工作區 `11a82028-fc50-466a-a723-e002032cd9a6` 與 task-tracker canonical workspace `d9da9945-ce5f-400f-806e-1d75e95e313a`。
- 每 15 分鐘一次的 coordinator tick：規劃、分派、Git 隔離、驗證、部署、復原、完成通知。
- 五筆既有卡關 task 的固定 cutover disposition、兩筆 canonical exclusion 與冪等 reconciliation。
- 主協作工作區結案政策改為固定 24 小時窗口，移除自然語句 confirmation 判斷。

**本期不包含（明確排除）：**

- `sim/run.ts` 的 deep／fast／scenario 模式——保留為實驗 harness，永遠不進入正式環境工作佇列。
- 兩個固定 UUID 以外的任何 workspace。
- Member 自行認領 task；分類與指派永遠由 Owner 決定。
- 未經明確人工授權的 live AI 呼叫或 timer 啟用。

## 架構總覽

| 模組 | 責任 |
| --- | --- |
| `sim/production.ts` | CLI 進入點：`--once`（dry-run）／`--once --live`／`--status`。 |
| `sim/production/types.ts` | `WorkPhase`、`TaskRun`、action／decision／CI／completion 共用型別。 |
| `sim/production/state.ts` | SQLite：`task_runs`、`action_log`、`ci_runs`、`completion_outbox`、`ticks`、`coordinator_meta`。 |
| `sim/production/api.ts` | 短生命週期 HTTP client：cookie auth、安全重試、mutation readback。 |
| `sim/production/policy.ts` | 純函式：分類驗證、evidence fingerprint、WIP1 排程、卡關規則。 |
| `sim/production/git.ts` | Per-task worktree／branch、安全 stage、CI cache、整合 merge、revert。 |
| `sim/production/agent.ts` | 有界限 Owner／member session invocation；不做機械式狀態轉移。 |
| `sim/production/completion.ts` | 完成留言、user09 notification readback、Done 轉移、Discord outbox。 |
| `sim/production/coordinator.ts` | 單次 tick orchestration 與錯誤彙整。 |
| `sim/production/migrate.ts` | 唯讀 manifest 與既有卡關 task 的冪等 reconciliation（cutover 專用）。 |
| `deploy/sim-coordinator.service` / `.timer` | One-shot live coordinator，15 分鐘 timer，安裝後保持 disabled。 |
| `sim-autodeploy.path` / `.service` | 既有 master ref watcher 是 merge／revert 的唯一部署觸發來源；coordinator 只等待並驗證該輪 invocation。 |

模組間依賴方向單一：`policy.ts` 與 `types.ts` 是純函式／型別，不碰 I/O；`api.ts`、`git.ts`、`state.ts` 是各自獨立的 side-effect adapter；`agent.ts`、`completion.ts` 組合前述 adapter 產生副作用；`coordinator.ts` 是唯一的 orchestration 層；`migrate.ts` 只在 cutover 期間執行，其餘時間不參與 tick。

## 核心資料流

```text
tick start (heartbeat 記錄 start)
  -> 讀取兩個 allowlisted workspace 的 task／comment／notification 快照
  -> policy.selectCoordinatorActions(snapshot, now)
       - 固定 cutover disposition 優先於一般 Review/Doing/Todo 排序
       - 每位 member 最多一個非 blocked WIP task
       - queued task 不產生 action
  -> 逐一 action：
       Owner 分類/指派 -> 建立 task worktree/branch -> member session
         -> 驗證 diff/commit/verification PASS/Review readback
         -> 有進展：checkpoint 前進
         -> 連續兩次無進展：enqueue Owner intervention
         -> 介入後再一次無進展：human_blocked，留言 @user09，停止 AI call
  -> Review 通過的 task 進入固定 acceptance sequence（branch CI -> 整合 -> merge -> deploy -> health -> live acceptance）
       -> 失敗：git revert + 重新部署 + health readback，task 留在 Review
  -> 部署 readback 成功 -> completion.ts 留言/notification readback -> PATCH Done
  -> tick 結束：新完成 task 合併為一個 batch，嘗試一次 Discord 摘要（失敗於後兩個 tick 各重試一次，第三次失敗即 notify_failed）
  -> heartbeat 記錄 end/outcome；partial failure 彙整後才以非零碼結束
```

同一 task 永遠使用自己的 `sim/task/<taskId>` branch 與 `sim-work/tasks/<taskId>` worktree；不再使用 `sim/user06` 之類的共享 branch，避免多 task 混在同一次 CI 結果裡。

## 主協作工作區結案政策（任務 1）

現行結案依賴會拒絕 user09 有效表達的自然語句 confirmation regex。新設計：

- 討論窗口固定為開啟後連續 24 小時（`FIXED_WAIT_HALF_DAYS = 2` 對應既有 `wait_half_days` 欄位語意），不再是可變的 2～7 天。
- 期限前不可結案；期限後即使沒有 `【確認結論】` 也可成功；成員缺席或零回覆不阻擋；`【未達共識】` 直接 Done 且不建立 target task。
- Server 只解析由 Owner 控制的 audit marker（`【結論】`、`【結論：不實作】`、`【未達共識】`、`【實作任務】`），不再把一般 member／user09 文字解讀成核准——移除自然語句 confirmation parsing。
- `confirmationCommentId` 固定為 `null`；沿用舊的 singular handoff 欄位維持歷史 audit reader 相容，`implementationTasks` 承載多筆 handoff。
- SQLite constraint 放寬為 `wait_half_days BETWEEN 2 AND 14`，以冪等 migration 重建 schema，不改變既有資料列的歷史 due date。

新建窗口與歷史收尾使用兩條刻意分離的 parser 路徑：`parseNewWaitHalfDays()` 與 `parseStoredWaitHalfDays()`。新建窗口只接受 `【全員回覆：24小時】`，遇到舊 `【全員回覆：N天】` 直接回報「全員回覆期限固定為 24 小時」，不得再建立或重開可變期限窗口。收尾既有窗口時，request comment ID、Owner actor 與 DB `wait_half_days` 仍須相符，但另以唯讀 legacy parser 接受原本合法的 `N天` marker（包含 2～7 天、0.5 天遞增與較長期限理由規則）；這條相容路徑不能被建立窗口的 command 使用。如此 `10e65231...` 的歷史 request comment 可被機械式驗證，而不是改寫歷史留言或忽略既有證據。

此任務唯一對應看板 task `00123ef0-81cb-410e-aed1-d6d1fb925ed6`。任務 1 不由尚未完成的 coordinator 或舊 `sim/run.ts` 執行；取得明確 board mutation 授權的計畫執行者是一次性 bootstrap driver，使用既有 HTTP API、Git、測試與部署命令完成機械式副作用，並在 Git 已忽略的 `sim-logs/task1-bootstrap/<run-id>/evidence.json` 保存授權時間、Owner／user03 ID、baseline／assignment audit、branch／head、acceptance、merge／live rev、完成留言與 notification readback。user03 是看板上唯一 assignee；本階段不宣稱或要求 production member runner 已存在。Owner acceptance 必須由 operator 審查 exact head 後，以 canonical Owner 身分留下結構化 record。bootstrap merge 同樣只等待既有 `sim-autodeploy.path` 自動觸發的下一個 invocation，不主動 start／restart 第二輪。所有不確定 response 都先 readback；不得用一次性腳本或手工紀錄取代 API／Git 的權威證據。

這條完成證據鏈（assignment audit event -> task branch -> accepted head -> Owner acceptance -> merge -> live rev -> 完成留言 -> user09 notification）是任務 9／11 cutover 的硬性前置條件，細節見「Cutover reconciliation」一節。

## 持久化狀態與冪等（任務 2）

SQLite 是 coordinator 唯一的權威 checkpoint 來源，`workerId` 只代表 coordinator 當次執行者，看板的 status／assignee／version 永遠留在 API `TaskSnapshot`，不混入 `TaskRun`，避免本地 cache 與看板真相分裂。

- `task_runs`：`task_id` 為 key，欄位含 `phase`、`workerId`、`branch`、`baseSha`/`headSha`、`evidenceFingerprint`、`noProgressCount`、`ownerIntervened`、`leaseUntil`。Lease 只能被 claim 一次，過期後才可重新 claim。
- `action_log`：deterministic `action_key` 防止同一 mutation 重送。
- `ci_runs`：以 `base_sha + head_sha + commands_hash` 為 key，只 cache 成功結果。
- `completion_outbox`：`completion_id = task_id + ':' + accepted_head_sha`，attempt 上限 3 次。
- `ticks`：記錄每次 tick 的 start／end／outcome／counts／error，供 `--status` 判斷 heartbeat 是否新鮮。
- `coordinator_meta`：schema version 與 cutover generation，供 `migrate.ts` 的 generation-bound preflight 使用。

`queued` 是 coordinator metadata 而非看板狀態：queued task 持久化 `workerId=null`、`branch=null`，重新開啟 DB 後仍不得取得 lease 或建立 AI action，只能被固定 release condition 或新的人工決策轉出。

## 可復原 API client 與排程政策（任務 3）

`TaskTrackerClient` 以 `node:http.request` 建立，`agent: false`、明確 timeout、cookie jar；health／login／GET 對暫時性 socket／timeout／5xx 失敗可重試，comment／PATCH 使用穩定 action key，response 不確定時先 readback 再決定是否重送，避免重複留言或重複 mutation。單一 workspace 的失敗不阻擋另一個 workspace 的 action。

`policy.ts` 全為純函式，輸入 `CoordinatorSnapshot` 與 `now`，輸出 `CoordinatorAction[]`：

- `validateOwnerClassification`：task 無法明確證明是「恢復既有文件行為」「不影響使用者的維護」或「引用已核准 discussion／user09 決策」時，分類預設為 `new-feature`（保守 fail-safe，避免未核准功能被當成 bug/maintenance 繞過 24 小時討論窗口）。
- `taskEvidenceFingerprint`：把 task 的可驗證狀態（version、assignee、audit event、branch head 等）壓成單一 fingerprint，供 cutover generation 比對與冪等判斷用。
- `selectCoordinatorActions`：已指派 Doing 優先於 Todo；Review 驗收優先於新派工；每位 member 只取得一個非 blocked WIP task；fixed cutover disposition 優先於一般排序，且不受同狀態 task 的 `updated_at` 影響。
- `recordMemberAttempt` / `shouldResumeHumanBlocked`：Provider／network failure 永遠不增加 `noProgressCount`，避免暫時性錯誤被誤判為「無進展」而提前觸發 escalation。

Discovery 永遠排除 `[規則] 主工作區協作與交接`（`CUTOVER_TASKS.mainPolicy`）與 canonical `[討論] 方向與下一步`（`CUTOVER_TASKS.legacyCanonicalDiscussion`）。`mainDiscussionNeedsOwner(status)` 造成「未變更 Todo 也消耗 Owner」的失敗模式在本任務的 policy 解決：只有 evidence fingerprint／期限事件／新留言產生可執行變化時才建立 Owner action，不能只因 status 是 Todo 就排程。

## Git worktree 隔離（任務 4）

每個 task 對應固定的 `taskBranchName(taskId)` 與 `taskWorktreePath(repoRoot, taskId)`，新 worktree 的初始 diff 必須為空。`commitTaskChanges` 只呼叫 `git add -- <validated paths>` 加 `git diff --cached --check`，永遠不使用 `git add -A`，並拒絕 `.jar-*`、`.tmp-*`、`data/`、`node_modules`、宣告 scope 以外的檔案與未被明確允許的新 symlink。

Member verification command 限定在固定 allowlist（`tsc --noEmit`、`tsx *.test.ts`、`npm test`、`npm run build`、`git diff --check`），CI 結果以 `base+head+commands` 為 key 快取，只快取成功結果。舊 `sim/user02` 至 `sim/user06` branch／worktree／SHA 只允許出現在 cutover manifest 裡，不可作為新 branch 的 base、來源或 member prompt context——這是避免「同一 branch 混雜多 task 導致 CI PASS 無法代表單一 task 可接受」這個既有失敗模式的核心設計。

## Owner／Member session 與副作用驗證（任務 5）

Prompt 永遠只給一個 task ID、對應 acceptance criteria、相關 comments、已宣告的 file scope 與 verification allowlist，禁止另選 task；Owner prompt 為 read-only，API mutation／Git merge／部署／留言一律交給 driver 執行，不讓 AI 直接操作副作用。

Session 是否 `progressed` 由 driver 事後檢查決定，而非 process exit code：

- Member 成功需要「通過驗證的 task commit」+「focused verification PASS」+「driver 建立的摘要留言」+「driver 對 Doing -> Review 的 readback」四項證據同時存在。
- Owner acceptance 必須是引用已審查 head SHA 的結構化決策；exit 0 但沒有 diff／comment／status 變更、產生 diff 後 exit 1、有 commit 卻沒有 Review transition、重複 blocker 文字、Owner 嘗試編輯程式碼，都不算 `progressed`。

卡關轉移：連續兩次完整 member attempt 都沒有可驗證進展 -> enqueue 一次 Owner intervention；介入後只再允許一次 attempt，仍無變化則持久化 `human_blocked`、留下唯一且去重的 `@user09` 留言、保留 task status／assignee 不變、停止後續 AI call，直到出現新的 user09 comment 或未記錄的人工 task mutation。`human_blocked` 是 automation metadata，不計入自動化 WIP、不改變看板狀態。

## 整合、部署 readback 與自動 revert（任務 6）

固定 acceptance sequence：

```text
task branch CI -> 暫存整合 worktree -> npm test -> npm run build -> git diff --check
  -> task-specific acceptance -> merge --no-ff
  -> wait for the path-triggered sim-autodeploy.service invocation -> GET /api/health
  -> 要求 HTTP 200 / status=ok / db=true / rev=master HEAD
  -> task live acceptance
```

部署 revision 通過 readback 前不得變更任何 task status 或 completion comment——避免「Build 完成」被誤當成「已交付」。任一階段失敗：確認 `master HEAD === mergeSha` 且該 invocation 已結束後，執行 `git revert -m 1 --no-edit <mergeSha>`、等待 revert ref change 觸發的下一個 path invocation，並要求 invocation result、`deployed_rev` 與 health rev 都等於 revert commit；task 維持 Review，留下去重的 rollback comment。若連 rollback health 都失敗，記錄 fatal coordinator error 並拒絕後續所有 AI／mutation action（寧可停擺也不在未知健康狀態下繼續動作）。永遠不 reset Git 歷史，只用 revert 前進式修復。

`sim-autodeploy.path` 監看 master ref／packed refs，merge 與 revert 本身就是觸發。每次改動 master 前，coordinator 先要求 path unit active、service inactive，並擷取目前 `InvocationID`／`ExecMainStartTimestampMonotonic`；改動後只等待一個新的已完成 invocation，不再主動 `systemctl start` 製造第二輪。成功必須同時符合：新 invocation `Result=success`／`ExecMainStatus=0`、`deployed_rev` 等於目標 SHA、health rev 等於目標 SHA。新 invocation 明確失敗就是該 merge／revert generation 的部署失敗，不得用第二次 start 掩蓋；revert 沿用相同 generation readback。

等待逾時固定 35 分鐘，必須大於 `sim-autodeploy.sh` 自身最長 30 分鐘的 `pgrep sim/run.ts` 等待，否則一次正常但緩慢的部署會被誤判成失敗。逾時不等於失敗，改以最終狀態決議：兩個 rev 都等於目標 SHA 視為成功並標記 `deployObservedOutOfBand=true`；rev 不符但 service 仍 active 回傳 `DeploymentIndeterminate`，該 tick 零 revert／零 status change／零 completion comment，留待下一個 tick 以同一 target SHA 重新 readback；rev 不符且 service 已 inactive 才判定該 generation 部署失敗並進入 revert。Rollback 只在 invocation 明確失敗，或 `DeploymentIndeterminate` 連續兩個 tick 未收斂時，才升級為 fatal coordinator error。

`.path` 觸發遺漏是已知殘餘風險：inotify 對 ref rename 與密集 merge／revert 的事件合併不保證每次送達。設計上不讓 coordinator 主動 start service（那會破壞 generation 歸因），改以人工逃生口涵蓋：operator 可手動 `systemctl --user start sim-autodeploy.service`，而 `sim-autodeploy.sh` 的 `[ "$HEAD" = "$DEPLOYED" ] && exit 0` 讓手動啟動冪等。coordinator 下一個 tick 只比對 `deployed_rev` 與 health rev，不要求該輪 invocation 由自己觀察到，人工介入因此不會讓 checkpoint 卡死。

實作期的 commit 走另一條路：任務 2 至 12 的 commit 直接落在 master，每一筆都會觸發一次 build + restart，這是預期行為而非 acceptance sequence。只有任務 1 的看板 task 走完整 acceptance／deploy／completion 鏈；其餘 commit 只需 `npm run build` 可過，且不得在同一筆 commit 同時修改 `src/` 與 `sim/production/`，以免半成品 coordinator 與伺服器行為一起上線。

既有 `deploy/sim-autodeploy.sh` 對 `pgrep tsx sim/run.ts` 的 wait 在 cutover 與 post-cutover cleanup 期間都保留。它仍能避免舊 timer 或人工 lab run 的 in-flight session 被 task-tracker restart 打斷；production coordinator 不以 `pgrep sim/production.ts` 守衛，避免 coordinator 等部署、部署又等待 coordinator 的循環等待。

## 完成通知與 Discord outbox（任務 7）

Completion comment 使用固定樣板（TASK／功能修改／驗證／Commit／部署版本／執行識別），`completion_id = task_id + ':' + accepted_head_sha` 保證同一 accepted head 只產生一次 completion 記錄。發文後 GET 留言 readback，接著以 user09 登入讀取 notifications 確認存在對應 row（但不代替 user09 標已讀），此 readback 必須早於 Review -> Done 的 PATCH。

每個 tick 把新完成 task 合併為一個 `batch_id`，只嘗試一次 Discord 摘要；失敗則在接下來兩個 tick 各重試一次（總計三次），第三次仍失敗設為 `notify_failed`，不再自動重試、不重貼留言、不重跑部署、不變更已 Done 的狀態——Discord 是通知管道，不是 correctness gate。

## CLI、heartbeat 與 systemd timer（任務 8）

三種安全模式：`--once`（唯讀 discovery，只列 planned action，不呼叫 AI／mutation）、`--once --live`（允許 AI／mutation，只供明確人工授權或 systemd 使用）、`--status`（列印最後一個 tick；30 分鐘內無成功 heartbeat 且無有效 active lease時以非零碼結束，供外部監控用）。

`--once` 雖然不 mutation，仍是 live discovery：必須先確認 `task-tracker.service` active、`GET /api/health` 為 HTTP 200，並能以 seeded canonical Owner（`user01@test.local` 與現有 local seed credential）登入後讀取兩個 allowlisted workspace。Exit code 固定為：`0` 表示 discovery 完整且 cutover prerequisite 可用；`2` 表示 discovery 完成但回報 `CutoverPrerequisiteMissing`；`3` 表示 service／health／login／required workspace readback 不可用；`1` 保留給未分類的程式錯誤。Exit `2`／`3` 都必須是零 mutation、零 AI。測試／build 可在沒有 live server 時執行，但文件中的最終 `--once` gate 不能被描述成純本地測試。

每個 tick 記錄 scheduled／start／end、app rev、各 workspace 的 discovered／processed／skipped／error 數、AI call、task transition、deploy result、notification result 與 aggregate outcome；獨立 task 的錯誤彼此彙整，不因單一 task 失敗中斷其他可安全完成的 action，但只要有 partial failure，service 就以非零碼結束（供 systemd/監控辨識異常 tick）。

`sim-coordinator.service`／`.timer` 安裝後固定保持 `disabled`：build 與安裝從不代表已授權 live AI，啟用 timer 前必須另外取得明確人工授權（見「Runtime cutover」）。

## 卡關 Task 協調與 Cutover reconciliation（任務 9）

五筆既有卡關 task 的固定 cutover disposition，加上兩筆永遠排除的 canonical task：

| 別名 | Task ID | Disposition |
| --- | --- | --- |
| `activeReview` | `938aa035-5f96-4908-b28b-876fa4735061` | user06 唯一 active WIP（Review -> Doing，重置乾淨 branch） |
| `queuedReview` | `6384b6f4-f92f-45a2-a5e1-133f04f76372` | 先清 assignee 保持 queued；`activeReview` Done 後才指派 user06 |
| `completedPrerequisite` | `00123ef0-81cb-410e-aed1-d6d1fb925ed6` | 任務 1 唯一對應 task；cutover 只驗證完成證據，零 mutation |
| `deferredAssignment` | `027c0052-46d5-4da7-90fa-dd8efb2219fc` | 先維持 Todo/unassigned；`activeReview` Done 後固定指派 user05 |
| `mainDiscussion` | `10e65231-a4b2-4bdb-aab4-9f3c5fb0e916` | 前置條件通過後機械式結案一次 |
| `mainPolicy` | `27ec8d7e-8605-468c-9f2c-13a80bef2a5a` | 永遠排除，不建立 coordinator action |
| `legacyCanonicalDiscussion` | `8be538bc-ffc6-4122-9757-026a54ba813f` | 永遠排除，不建立 coordinator action |

`migrate.ts` 預設只寫入 Git 已忽略的 manifest（`sim-logs/cutover-<timestamp>/manifest.json`），內容含每筆 task 的 version／status／branch state／`00123ef0...` 完整證據鏈欄位、cutover generation 與 `readyForApply`。四個階段的冪等語意：

1. 初次 apply：`10e65231...` 機械式結案一次 -> 啟動 `938aa035...`；`6384b6f4...` 只清 assignee，不建立 branch/lease/AI action。
2. 狀態未變時重跑：不重複任何 comment/PATCH/branch/action key；`10e65231...` 不二次結案。
3. `938aa035...` Done 且 master 已含其 merge 後重跑：`6384b6f4...` 恰好一次指派 user06、`027c0052...` 恰好一次指派 user05，兩條新 branch 都以新 master 為 base。
4. `938aa035...` 為 `human_blocked`／失敗／Doing／Review 時，兩筆 dependent task 繼續 queued。

`00123ef0...` 的 cutover 前置條件驗證整條證據鏈（Task 1 授權時間 -> canonical Owner 產生的 assignment audit event -> 固定 task branch 上含 `Task-Id` trailer 的 accepted head -> 具 ID 的 Owner acceptance -> 保留該 head 為 ancestor 的 merge -> 等於或後代於該 merge 的 live rev -> 引用同一組證據的完成留言 -> source comment／recipient 相符的 user09 notification）；任一環節缺漏都回傳 `CutoverPrerequisiteMissing`，且 task／Git／AI mutation 全部為零。`--preflight --live --expect-generation <generation>` 提供 drain 前的最後一次唯讀確認，generation 或 fingerprint 有任何漂移就整批拒絕 mutation。

舊 `sim/user02` 至 `sim/user06` 的 commit、dirty diff、檔案只允許寫入 manifest，不得被 merge／cherry-pick／format-patch／apply／複製進任何新 branch 或 member prompt——避免 cutover 直接沿用未經過新驗證流程的舊成果。

## Cutover 文件與操作準備（任務 10）

先更新操作文件與 regression gate，但保留 `sim/run.ts` 的舊 Owner／Team production sweep scheduling、notification-gate code 與 autodeploy `pgrep` 守衛，讓 runtime cutover 在 preflight／apply／首兩個 tick 任一步失敗時仍可安全恢復舊 timers。此任務不改變現有 sweep flag 行為。

## Runtime Cutover 程序（任務 11）

```text
no-live gate（全部 test/build PASS，dry-run 印出五筆 fixed disposition 與兩筆 excluded task，無 mutation）
  -> 安裝 service/timer，保持 disabled，停在此處等明確 live 授權
  -> 取得授權 -> migrate.ts 產生 manifest，確認 readyForApply=true
  -> migrate.ts --preflight --live --expect-generation <gen>（唯讀，generation/fingerprint 對得上才過）
  -> disable 舊 sim-sweep-owner/team timer，等最多 35 分鐘讓舊 service 與共用 run lock 釋放（不得砍 in-flight AI）
  -> migrate.ts --apply --live --expect-generation <gen>（失敗即零 mutation 或需人工續跑，絕不新舊並行）
  -> apply 後重新產生唯讀 manifest 驗證 readback
  -> systemctl start sim-coordinator.service（oneshot，成功後回到 inactive(dead) 是正常）
  -> 確認 Result=success / ExecMainStatus=0 / --status 顯示健康 heartbeat
  -> enable --now sim-coordinator.timer
  -> 驗證前兩個 live tick（health/heartbeat/無重複副作用/五筆 fixed disposition 與兩筆 excluded task 正確）
```

任何一步失敗都停在原地並執行對應復原（drain 前失敗保留舊 timer；apply 失敗依 mutation 是否已開始選擇零 mutation 復原或人工續跑；live tick 後失敗則 disable 新 timer、等 service 與 lock 釋放後才重新 enable 舊 timer），永遠不允許新舊 coordinator 同時運行。

## 退役舊正式環境 Sweep 路徑（任務 12）

只有任務 11 的兩個成功 live tick 與 fixed disposition readback 都通過後，才從 `sim/run.ts` 移除 Owner／Team production sweep scheduling 與 notification-gate code；deep／fast／scenario 的 lab 行為保留。`npm run sim -- --sweep ...` 之後以明確訊息結束並指引改用 `sim:production --once`，不呼叫 AI。`deploy/sim-autodeploy.sh` 的既有 `pgrep sim/run.ts` 守衛不在本次退役範圍，避免 cleanup commit 本身或人工 lab run 遭 restart 打斷。

## 錯誤處理與可觀測性

- 所有 mutation 使用 deterministic action key，unclear response 一律先 readback 再決定是否重送，不盲目重送。
- Exit 0 但缺少預期 readback（diff/comment/status transition）只能記為 `no_change` 或 `retryable_failure`，絕不算 `progressed`。
- Provider／network failure 不計入 `noProgressCount`，避免暫時性錯誤誤觸發 escalation。
- 每個 tick 的 partial failure 在所有可安全完成的獨立 action 結束後才讓 service 以非零碼結束；獨立 task 的錯誤互相隔離彙整。
- Coordinator restart 從 SQLite checkpoint 接續，不重放已完成的副作用。

## 驗證

**單元／整合測試（無需 live AI）：**

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json --noEmit
npx tsx src/mainDiscussion.test.ts
npx tsx src/task.test.ts
npx tsx src/mainWorkspace.test.ts
npx tsx sim/run.test.ts
npx tsx sim/production.test.ts
npx tsx sim/production.integration.test.ts
npm test
npm run build
git diff --check
npx tsx sim/production.ts --once
```

`sim/production.integration.test.ts` 使用暫存 SQLite、fake HTTP server、fake agent adapter 與暫存 Git repo，跑一個完整 tick（Todo -> Review -> 模擬部署／completion），並證明重新開啟 state 後第二個 tick 不會重複副作用。`sim/production.test.ts` 涵蓋 state／API／policy／git／agent／completion／migrate 各模組的 fixture 測試，包含本文各節列出的冪等與 fail-closed 情境。

最後一個 dry-run command 需要 active live server 與 canonical Owner credentials，必須逐筆列出五筆 fixed disposition 及兩筆 excluded task 的目前狀態，且不建立任何 comment／task change／branch／AI call／deploy；`00123ef0...` 證據不完整時必須明確回報 `CutoverPrerequisiteMissing`、exit `2` 與零個 planned mutation。server／health／login／required workspace readback 不可用時必須回報 `DiscoveryUnavailable`、exit `3` 與零個 planned mutation。

**Live 驗收：** 需另行取得明確人工授權，依「Runtime Cutover 程序」執行，並在前兩個 live tick 驗證 health、heartbeat、五筆 fixed disposition、兩筆 excluded task、無重複副作用、無舊 branch 成果被沿用。

## 文件同步

實作時同步更新：

- `docs/operations.md`：固定 workspace allowlist、15 分鐘 coordinator、dry-run／live 邊界、`--status`、WIP1、discussion 固定 24 小時政策、human-blocked 行為、task branch 慣例、path-triggered autodeploy generation readback、acceptance／deploy／revert sequence、completion digest、安裝後保持 disabled、rollback procedure、五筆 fixed disposition、兩筆 excluded task、queued 不占 WIP／不觸發 acceptance。
- `docs/owner-sweep-guide.md`：退役舊 sweep flag 的指引文字。
- `docs/tasks/current.md`：cutover 後的最新狀態。
- `docs/api.md`：主討論固定 24 小時窗口的使用者可見契約（移除 2～7 天與 confirmation 要求敘述）。
- `design.md`：正式環境協調器架構總覽。
