# Goal 協作實作修正步驟

- 分支：`feature/goal-agent-collaboration`（worktree `.worktrees/goal-agent-collaboration`），起點 `192e9fc`
- 規格：`docs/superpowers/specs/2026-10-11-goal-agent-collaboration-design.md`（下稱「規格」，`L` 為行號）
- 原計畫：`docs/superpowers/plans/2026-10-11-goal-agent-collaboration-implementation.md`
- 來源：2026-10-11 對照規格的三路審查。下列行號以 `192e9fc` 為準，修改後會位移，以描述為主。

## 執行規則（執行者必讀）

1. 只在這個 worktree 工作。**不得**執行 `git add`、`git commit`、`git stash`、`git checkout`、`git reset`、merge 或 push。所有改動都留在工作目錄，由人類交給 Claude review 後再 commit。
2. 沙盒沒有網路，不要嘗試安裝套件或連線。禁止執行：
   - `npm run sim`、任何 `sim --sweep`、`sim:production`、`goal:patrol`
   - `goal:run -- --live`
   - 任何會呼叫真實 claude、codex、agy 的指令
   - `systemctl`、`sudo`
   - 寫入 `~/.config`、`~/.local`
3. 依編號順序處理。每一項的步驟：
   1. 先寫能重現問題的測試，確認它失敗。
   2. 修正。
   3. 跑 `npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`，以及直接相關的 `npx tsx <file>.test.ts`。
   4. 把本文件該項的 `[ ]` 改成 `[x]`，下一行寫「改動檔案：」列出這一項動到的檔案，以及新增的測試名稱。
4. 某一項做不下去時（需要人類決策、規格本身矛盾、同一項試兩次仍失敗），改標 `[!]`，寫一行原因，然後跳到下一項。
5. 不得刪除既有測試或放寬既有斷言。不得順手重構無關程式碼。
6. 新增測試檔要加進 `package.json` 的 `test` script 或 `src/test.ts`。
7. 沙盒限制（2026-10-11 實測）：沙盒禁止子程序使用 pipe，下列 4 個測試檔會因 `spawnSync ... EPERM` 失敗。它們在沙盒外是通過的。
   - `src/archiveDoneTasks.test.ts`
   - `sim/goal.integration.test.ts`
   - `sim/run.test.ts`
   - `sim/production.test.ts`

   處理方式：
   - **不要為了繞過這個限制修改它們的執行方式。**
   - 需要加測試的項目（如 A5、C4、C11、E1、E2）照樣把測試寫進去，在該項標「沙盒內未執行」，由 Claude review 時在沙盒外執行。
   - `src/server.test.ts`、`sim/production.test.ts` 在沙盒內會在前段中止，跑不到後面的 assertion。改這兩檔的期望值時，先確認測試 fixture 真的建了對應資料（帳號、Agent、membership），不要只依規格寫期望值。已發生兩次：A 區漏加 user02、D2 期望六位 Agent 但 fixture 只有兩個帳號。
   - `src/test.ts` 遇到第一個失敗就會中止，所以不要用 `npm test` 當驗收。改跑 `npm run lint`、`npm run typecheck`，再用 `node --import tsx <file>` 逐支跑其他測試檔。
8. 結束前：
   1. 跑完第 7 點的檢查。
   2. 把結果寫進文末「執行紀錄」：每支測試檔的通過／失敗，以及失敗段落原文。

## A. 阻斷級（合併前必修）

- [x] **A1 驗收失敗後 Goal 卡死**
  - 改動檔案：`sim/goalCoordinator.ts`、`src/goalOrchestrator.ts`、`sim/goalCoordinator.test.ts`、`package.json`、本計畫；新增測試名稱：`goalCoordinator.test.ts — 驗收失敗修正／Blocked／lease／synthesis 與 invalid-output retry crash recovery／CLI terminal error classification／連續兩次 invalid 後 Blocked 且不第三次 invoke／部分與全部 Archived／空 evidence retry／人工解除後重算／真實 Run failure 不誤判`。
  - 問題：
    - `reviseGoal`（`src/goal.ts:366-376`）把 Goal 帶到 Discussing／`owner_synthesis`。
    - `runGoalCoordinatorOnce`（`sim/goalCoordinator.ts:126-198`）沒有處理這個 phase，之後永遠回傳 `'Discussing'`。修正 Task 不會建立，lease 也不會釋放。
    - `storeGoalSynthesis` 與 `materializeGoalTasks` 之間崩潰時，也會卡在同一處。
  - 規格：L187、L193、L366-368。
  - 修正：
    - coordinator 處理持 lease 的 `owner_synthesis`：Owner 以目前 Task 狀態與失敗證據產出修正或 rollback Task，經 materialize 回到 Executing。
    - 該 revision 已有 synthesis 但沒有 Task 時，直接 materialize，不再呼叫 Owner。
  - 同時修以下三點：
    - 驗收失敗次數改成「最近一次人工解除 Blocked 之後」才開始累計（`src/goalOrchestrator.ts:273`，規格 L187）。
    - 已 Archived 的 Task 不計入「必要 Task 未完成」（目前判斷式是 `status !== 'Done'`）。
    - Owner 判 fail 但 `evidenceRefs` 為空時，視為 Owner 輸出無效、走重試，不要直接 throw 後被 CLI 打成 Blocked。
  - 驗收：用 fake `invokeJson` 的測試必須**經過 `runGoalCoordinatorOnce`**，不能繞過它。需涵蓋：
    - 第一次驗收失敗後建立修正 Task 並進 Executing。
    - 第二次失敗後進 Blocked。
    - 全程 lease 持有者不變。

- [x] **A2 等 lease 的 Goal 被打成 Blocked**
  - 改動檔案：`sim/goalCoordinator.ts`、`src/goalOrchestrator.ts`、`sim/goalCoordinator.test.ts`、本計畫；新增測試名稱：`goalCoordinator.test.ts — 同 repo lease 等待者不呼叫 Owner、不 Blocked，holder Done 後只以 post-lease fresh repo snapshot 完成 synthesis；CLI 只將起始即 awaiting 的 contention 分類為 exit 1；preflight source read 失敗不取得 lease；post-acquire reread 與 held-lease recovery source failure terminal Blocked 且保留 lease；初次與 correction malformed synthesis 皆 terminal Blocked、不留 stage output、不重複 invoke；table-driven long-title／unknown-assignee 在 persist 前拒絕；prevalidate 後 membership race 由 materialize 再驗並 terminal Blocked`。
  - 問題：
    - `awaiting_lease` 分支（`sim/goalCoordinator.ts:161-168`）先呼叫 Owner，才在 `storeGoalSynthesis` 取 lease。
    - lease 被別的 Goal 持有時拋 `ConflictError`，CLI 的 catch（`:230-232`）把 Goal `blockGoal`。
    - 「已在執行」的錯誤也會被同一個 catch 打成 Blocked。
  - 規格：L193、L237、L385。Goal 應留在 `awaiting_lease`，取得 lease 後才依當下 repo 狀態做 synthesis。
  - 修正：
    - 先取得 lease，取不到就不呼叫 Owner、不改狀態，回傳 `awaiting_lease`。
    - 取得 lease 前的舊 `goal_stage_outputs` 不得沿用。
    - CLI catch 只對「Owner 討論 Run 失敗」這類錯誤做 block；lease 衝突與並行執行衝突只回非零 exit，不改 Goal 狀態。
  - 驗收：同一 repo 兩個 Goal，A 持有 lease 時對 B 跑 coordinator，要符合：
    - Owner 被呼叫 0 次。
    - B 仍是 Discussing／`awaiting_lease`。
    - A Done 之後，B 取得 lease 並完成 synthesis。

- [x] **A3 持 lease 的 Goal 暫停不了**
  - 改動檔案：`src/schema.ts`、`src/goal.ts`、`src/server.ts`、`sim/goalCoordinator.ts`、`public/js/views/goals.js`、`src/goal.test.ts`、`sim/goalCoordinator.test.ts`、`src/server.test.ts`、`src/frontend.test.ts`、本計畫；新增測試名稱：`goal.test.ts — Executing 安全立即暫停／worktree 與 action_log 不安全時排定`、`goalCoordinator.test.ts — worktree 整合後套用排定暫停`、`server.test.ts — pause 202 排定／200 套用`、`frontend.test.ts — 排定狀態與 action error 顯示`。
  - 問題：
    - `src/server.ts:936` 呼叫 `pauseGoal` 時把 `safeCheckpoint` 寫死成 `false`，`owner_synthesis`、Executing、Verifying 一律 400。
    - UI（`public/js/views/goals.js:54-59`）的 onclick 沒有 catch，錯誤不會顯示。
  - 規格：L179、L196-199。
  - 修正：
    - 依實際狀態計算安全 checkpoint：沒有未合併 worktree、沒有進行中的 merge 或部署。資料來源用 `goal_worktrees` 與 production 的 `action_log`，執行者自行查證。
    - 目前不安全時記錄「暫停請求」，回 202，由 coordinator 在下一個安全 checkpoint 套用。
    - Discussing 中暫停：不再發新 heartbeat，等執行中的 Run 跑完才進 Paused。
    - UI 顯示錯誤，以及「暫停請求已排定」的狀態。
  - 驗收：
    - Executing 且無未合併 worktree → 立即 Paused，lease 釋放。
    - 有未合併 worktree → 請求排定、狀態不變；worktree 合併後，coordinator 套用 Paused。

- [x] **A4 Blocked 恢復後死循環，恢復狀態也不對**
  - 改動檔案：`src/goal.ts`、`src/goalOrchestrator.ts`、`src/server.ts`、`public/js/views/goals.js`、`src/goal.test.ts`、`src/goalOrchestrator.test.ts`、`sim/goalCoordinator.test.ts`、`src/server.test.ts`、`src/frontend.test.ts`、本計畫；新增測試名稱：`goal.test.ts — Discussing／Executing Blocked 恢復與必填變更說明`、`goalOrchestrator.test.ts — reconciliation 依 revision 重算`、`goalCoordinator.test.ts — Verifying Blocked 恢復與驗收 retry reset`、`server.test.ts — Blocked resume 缺少變更說明回 400`、`frontend.test.ts — Blocked resume 變更說明 prompt`。
  - 問題：
    - 從 round_1 進 Blocked 的 Goal 恢復後 revision +1，但新 revision 沒有 Participation；reconciliation 次數又不分 revision，於是立刻再 Blocked（`src/goal.ts:331`、`src/goalOrchestrator.ts:147,161`）。
    - 卡住前是 Executing／Verifying 的 Goal，恢復後被送到 `awaiting_lease`（`src/goal.ts:328-331`）。
    - 恢復時沒有記錄「實質變更」。
  - 規格：L186、L194。
  - 修正：
    - 從 Blocked 恢復時必須帶人類填寫的變更說明（必填，存進 event）。
    - 卡住前在 Discussing 的，以新 revision 從 `owner_scoping` 重新選人。
    - 卡住前在 Executing／Verifying 的（lease 仍持有），回到原狀態。
    - reconciliation 與驗收重試次數都改成以 revision 計算。
  - 驗收：
    - round_1 Blocked → 恢復 → 新 revision 可正常完成 round_1。
    - Executing Blocked → 恢復 → 回到 Executing，lease 不變。
    - 沒帶變更說明時回 400。

- [x] **A5 legacy sweep 擋不住別的 workspace 持有的 lease**
  - 改動檔案：`sim/run.ts`、`sim/run.test.ts`、本計畫；新增測試名稱：`run.test.ts — 跨 workspace symlink canonical repo lease 阻擋 legacy sweep`。
  - 問題：`sim/run.ts:3311-3314` 的 lease 檢查 JOIN 了「本 workspace 的 Project」。多個情境共用同一個 repo（`sim/run.ts:393,399` 都是 `ROOT`），別的 workspace 的 Goal 持有 lease 時，這個 workspace 照樣 sweep、照樣 merge。
  - 規格：L344。
  - 修正：直接以 `repo_leases.target_repo` 比對 `scenario.repoRoot`，比對前兩邊都轉成 canonical realpath。
  - 驗收：在 `sim/run.test.ts` 加測試：workspace X 的 Goal 持有 ROOT 的 lease 時，workspace Y（repoRoot 同為 ROOT）的 sweep 會被略過。

- [x] **A6 Project 畫面合併後無法使用**
  - 改動檔案：`public/js/views/kanban.js`、`public/js/views/task-detail.js`、`src/frontend.test.ts`、本計畫；新增測試名稱：`frontend.test.ts — Project repo 選填／空 registry 提示／null 保留／archived Project 選項`。
  - 問題：
    - `public/js/views/kanban.js:131` 的 repo 下拉選單是 `required`。
    - 正式 service 沒有設定 `TASK_TRACKER_REPO_REGISTRY_PATH`，清單為空，結果無法建立或編輯任何 Project；舊的建立方式已被刪掉。
    - `:727` 編輯 `target_repo=null` 的舊 Project 時，會默默填入第一個已登記的 repo。
  - 規格：L58-68、L348、L416-421。
  - 修正：
    - repo 選單改成選填，加一個「不設定（此 Project 無法啟動 Goal）」選項。
    - 編輯時保留原值，`null` 就維持 `null`。
    - registry 為空時顯示提示，指向 `docs/operations.md`「Goal-driven collaboration」。
    - 一起修：`public/js/views/task-detail.js:378` 的 Task 屬於 archived Project 時，下拉選單要顯示該 Project，不能顯示成「無專案」。
  - 驗收：
    - 前端測試涵蓋三點：選單非必填、空 registry 時可以建立 Project、編輯舊 Project 送出的 `targetRepo` 仍是 `null`。
    - server 端在 registry 為空時建立 `targetRepo=null` 的 Project 回 201。

- [x] **A7 Goal 不會自己往前走，heartbeat 佇列會餓死**
  - 改動檔案：`src/comment.ts`、`src/goal.ts`、`src/server.ts`、`sim/goalCoordinator.ts`、`sim/goalPatrol.ts`、`src/comment.test.ts`、`sim/goalCoordinator.test.ts`、`deploy/goal-coordinator.service`、`deploy/goal-coordinator.timer`、`deploy/goal-discovery.service`、`deploy/README.md`、`docs/operations.md`、本計畫；新增測試名稱：`comment.test.ts — 終態 Goal 留言不建 owner_comment heartbeat`、`goalCoordinator.test.ts — owner_comment 回覆並防自我喚醒／--pending 跳過 Done 舊 heartbeat`。
  - 問題：
    - `@Owner` 建立的 `owner_comment` heartbeat（`src/comment.ts:55`）沒有任何消費者。
    - `--pending`（`sim/goalCoordinator.ts:210-214`）依 rowid 挑最舊的 pending heartbeat，所以永遠選中同一個 Goal（包括 Done 的），其他 Goal 輪不到。
    - `sim/goalPatrol.ts:138` 與 `src/server.ts:625` 用的 trigger_ref 是 `'start'`、`'tasks_done'`，coordinator 只認 `'phase'`，留下孤兒 heartbeat。
    - `@Owner` 對已 Cancelled 或 Done 的 Goal 仍會建 heartbeat（`src/comment.ts:49-60`）。
    - 沒有任何 unit 定期跑 coordinator，所以 `goal.completed` 之後的 follow-up 也不會發生。
  - 規格：L116-156、L243、L387。
  - 修正：
    - 階段推進統一用 `trigger_ref='phase'`。
    - Goal 進入 Done 或 Cancelled 時，把該 Goal 未消化的 heartbeat 標成 skipped。
    - `--pending` 跳過 Paused、Blocked 與終態 Goal。
    - coordinator 實作 `owner_comment` 的消費：Owner 讀該留言與 Goal context，決定回覆或不回覆；回覆經既有留言 API，不能喚醒自己。
    - `@Owner` 只對非終態 Goal 建 heartbeat。
    - 新增 `deploy/goal-coordinator.service`、`deploy/goal-coordinator.timer`，以及 `docs/operations.md` 的安裝說明。**只新增檔案，不安裝也不啟用。**
    - 順手修 `deploy/goal-discovery.service`：改用與其他 unit 相同的 nvm node 路徑，目前用的是 `/usr/bin/npm`。
  - 驗收：
    - 兩個 Goal 各有 pending heartbeat，其中一個已 Done → `--pending` 選到另一個。
    - `owner_comment` heartbeat 被消化後標為 succeeded。
    - 對 Cancelled Goal 留 `@Owner` 不建 heartbeat。

## B. 權限與資料一致性

- [x] **B1 Agent 帳號可以做人類專屬的 Goal 操作**
  - 改動檔案：`src/server.ts`、`src/server.test.ts`、本計畫；新增測試名稱：`server.test.ts — user01/user02 建立 human Goal 回 403／Agent Blocked resume 與 cancel 回 403／人類成員成功`。
  - 問題：`src/server.ts:826-938` 只要求 Member。user01–06 可以建立 `source=human` 的 Goal（藉此繞過單一自治 Goal 限制），也能取消 Goal 或解除 Blocked。
  - 規格：L169、L186、L189、L205。
  - 修正：使用者有 Agent resource 時，以下操作一律回 403：建立 `source=human` 的 Goal、cancel、從 Blocked resume、修改成功條件。
  - 驗收：`server.test.ts` 以 user01 與 user02 各打一次，都回 403；人類成員則成功。

- [x] **B2 任一 workspace Admin 都能改全域的 Agent route**
  - 改動檔案：`src/server.ts`、`src/server.test.ts`、本計畫；新增測試名稱：`server.test.ts — 其他 Workspace 人類 Admin 改 Agent 回 403／主協作工作區人類 Admin 成功`。
  - 問題：`src/server.ts:957-972`。Agent 是全域資源，但只要某個 workspace 的 Admin 與該 Agent 同在一個 workspace，就能改它的 route 和狀態。
  - 規格：L106。
  - 修正：改 Agent 只限主協作工作區 `11a82028-fc50-466a-a723-e002032cd9a6` 的人類 Admin 或 Owner。
  - 驗收：其他 workspace 的 Admin 回 403。

- [x] **B3 取消 Goal 時繞過封存檢查**
  - 改動檔案：`src/goal.ts`、`src/task.ts`、`src/goal.test.ts`、本計畫；新增測試名稱：`goal.test.ts — cancel 由 Owner Agent 經 archive command 封存未完成 Task`。
  - 問題：`src/goal.ts:354-360` 直接 append `task.archived`，繞過 `archiveTask` 的權限與 `loadEditableTask` 檢查。
  - 規格：L201。
  - 修正：改走既有的 archive command。執行者固定為 Owner Agent（user01），主工作區的規則照常適用。
  - 驗收：取消後未完成的 Task 為 Archived，event 經 archive command 產生。

- [x] **B4 Owner Agent 仍可以建立 Workspace**
  - 改動檔案：`src/server.ts`、`src/server.test.ts`、本計畫；新增測試名稱：`server.test.ts — user01 Owner Agent 建立 Workspace 回 403／人類帳號回 201`。
  - 問題：`src/server.ts:373-385` 的 `POST /api/workspaces` 只要有登入就能用。
  - 規格：L207、L395。
  - 修正：`role=owner` 的 Agent 帳號回 403。
  - 驗收：`server.test.ts` 以 user01 打一次回 403，以人類打回 201。

- [x] **B5 Goal Task 被搬家後關聯錯亂**
  - 改動檔案：`src/task.ts`、`src/task.test.ts`、本計畫；新增測試名稱：`task.test.ts — Goal Task 不可搬 Workspace／不可變更 Project`。
  - 問題：
    - `src/task.ts:450-454`：Task 搬到其他 Workspace 時沒有清掉 `goal_id`。
    - `:310-315` 的 `changeTaskProject` 允許把 Goal Task 改到別的 Project。
  - 規格：L437-438。
  - 修正：有 `goal_id` 的 Task 不准搬 Workspace，也不准換 Project，一律回 400。
  - 驗收：兩種操作各一個測試。

- [x] **B6 選人不是原子操作**
  - 改動檔案：`src/goalOrchestrator.ts`、`src/goalOrchestrator.test.ts`、`src/goal.ts`、`sim/goalCoordinator.test.ts`、本計畫；新增測試名稱：`goalOrchestrator.test.ts — 不合格整批零 Participation/heartbeat／同 revision 同名單重送冪等`。
  - 問題：`src/goalOrchestrator.ts:56-64`。名單中只要有一位不合格，前面的 Participation 與 heartbeat 已經寫入，重送時會撞「Participation 已存在」。
  - 規格：L209。
  - 修正：整批放進同一個 transaction；同一 revision 用同一份名單重送時是冪等的。
  - 驗收：含一位不合格者的名單 → 不留任何 Participation；同一份名單重送兩次 → 成功，資料不重複。

- [x] **B7 follow-up Goal 繞過檢查**
  - 改動檔案：`src/schema.ts`、`src/goal.ts`、`src/goalOrchestrator.ts`、`sim/goalCoordinator.ts`、`src/goalOrchestrator.test.ts`、`sim/goalCoordinator.test.ts`、本計畫；新增測試名稱：`goalOrchestrator.test.ts — 保存候選不建 Goal／child 走 createGoal active 檢查／Workspace+Project+成功條件+證據指紋重複拒絕`、`goalCoordinator.test.ts — follow-up end／save 三態中的結束與保存候選`。
  - 問題：`src/goalOrchestrator.ts:304` 的 `createFollowupGoal` 直接 append `goal.created`。
    - 繞過 `createGoal` 的「同一 Workspace 只能有一個 active 自治 Goal」檢查（`src/goal.ts:209-215`）。
    - 去重 key 只用 `parent_goal_id`。
    - 沒有「保存候選」選項。
  - 規格：L381、L387。
  - 修正：
    - 改走 `createGoal` 的檢查。
    - 去重 key 改為 Workspace + Project + 成功條件 + 證據指紋。
    - 新增「保存候選」結果：只記錄，不建 Goal。
  - 驗收：三種結果（結束、保存候選、建立 child）各一個測試；重複指紋第二次被拒。

- [x] **B8 `createGoal` 沒有完整驗證輸入**
  - 改動檔案：`src/goal.ts`、`src/goalOrchestrator.ts`、`sim/goalCoordinator.ts`、`sim/goalPatrol.ts`、`src/goal.test.ts`、`src/goalOrchestrator.test.ts`、`sim/goalCoordinator.test.ts`、`sim/goalPatrol.test.ts`、`sim/goal.integration.test.ts`、本計畫；新增測試名稱：`goal.test.ts — 非 Owner Agent 拒絕／target repo 已移出 registry 拒絕／Queued 不可 Blocked`。
  - 問題：
    - `src/goal.ts:201` 接受任意 `ownerAgentId`，沒檢查必須是 `role=owner`。
    - `src/goal.ts:193-197` 只檢查 `target_repo` 非 null，沒有重新確認它仍在 registry 裡。
    - `src/goal.ts:339-348` 允許 Queued → Blocked，但規格的轉移表沒有這一列。
  - 規格：L108、L183、L348。
  - 修正：補上前兩項驗證；拿掉 Queued → Blocked。
  - 驗收：三個負向測試。

## C. 規格要求但未實作

- [x] **C1 人類 Goal 插隊**
  - 改動檔案：`src/schema.ts`、`src/goal.ts`、`src/goal.test.ts`、本計畫；新增測試名稱：`goal.test.ts — 未持 lease 自治 Goal 讓位 Queued／持 lease 排定暫停並在 Cancelled 後恢復／Blocked 自治 lease 不被搖走／人類 Blocked 觸發恢復邏輯`。
  - 問題：全 repo 沒有插隊相關邏輯，lease 是先到先得。
  - 規格：L179-182、L383-385。
  - 修正：同一 target repo 建立人類 Goal 時：
    - 尚未取得 lease 的自治 Goal 回到 Queued。
    - 持有 lease 的自治 Goal 在下一個安全 checkpoint 進 Paused（沿用 A3 的暫停請求機制），並釋放 lease。
    - 插隊的人類 Goal 進入 Done、Cancelled 或 Blocked 時，被暫停的自治 Goal 依轉移表恢復。
    - 持有 lease 的 Blocked Goal 不得被插隊搶走。
  - 驗收：四種情境各一個測試。

- [x] **C2 修改成功條件或資料範圍、產生新 revision**
  - 改動檔案：`src/schema.ts`、`src/goal.ts`、`src/server.ts`、`sim/goalCoordinator.ts`、`public/js/views/goals.js`、`src/goal.test.ts`、`src/server.test.ts`、`src/frontend.test.ts`、本計畫；新增測試名稱：`goal.test.ts — data scope 建立與 revision 歷史／Executing 修改後 owner_synthesis 且 lease 不釋放`、`server.test.ts — Goal 單欄 PATCH／Agent 403／多欄 400`、`frontend.test.ts — data scope 表單與 PATCH 控制`。
  - 問題：沒有呼叫 `reviseGoal` 的 API 或 UI；「資料範圍」欄位沒有建模。
  - 規格：L70-89、L185、L420。
  - 修正：
    - Goal 加資料範圍欄位。
    - 新增 `PATCH /api/goals/:id`，一次只改一個欄位，符合 AGENTS.md。限人類操作，見 B1。
    - Executing／Verifying 修改後回到 `owner_synthesis`，revision +1，lease 不釋放。
  - 驗收：domain 與 server 測試。

- [x] **C3 Task 卡住時 Goal 沒有反應，也沒有通知**
  - 改動檔案：`sim/goalCoordinator.ts`、`src/notification.ts`、`sim/goalCoordinator.test.ts`、本計畫；新增測試名稱：`goalCoordinator.test.ts — task.blocked Owner 改派成功／Owner 轉 Goal Blocked 並通知人類 Admin`。
  - 問題：
    - 找不到任何 `task.blocked` 處理。Task 卡住時，Goal 永遠停在等待 Task 的狀態。
    - 進入 Blocked 時不通知人類。
  - 規格：L184、L318、L359。
  - 修正：
    - coordinator 收到 `task.blocked` 時，觸發 Owner reconciliation：可以改派、拆分，或將 Goal 轉 Blocked。
    - Goal 進入 Blocked 時，用既有通知機制通知該 Workspace 的人類 Admin。
  - 驗收：用 fake Owner 測兩條路徑（改派成功、轉 Blocked），並斷言通知已建立。

- [x] **C4 交付證據只回送一部分**
  - 改動檔案：`src/deliveryEvidence.ts`、`sim/production.ts`、`sim/production.test.ts`、本計畫；新增測試名稱：`production.test.ts — execution/commit/blocked/CI/merge/deployment 回送存在且 CI 失敗寫入失敗結果`。
  - 問題：
    - `sim/production.ts:1493-1503` 與 `src/deliveryEvidence.ts:5` 只在部署成功後回送證據。
    - `task.execution_started`、`commit.recorded`、`task.blocked` 都沒有回送；CI 失敗不留任何證據。
  - 規格：L359。
  - 修正：在對應的 checkpoint 回送；CI 失敗時以失敗結果記錄 `ci.checked`。
  - 驗收：`sim/production.test.ts` 斷言各事件依序寫入。

- [x] **C5 用量紀錄缺漏**
  - 改動檔案：`src/schema.ts`、`src/goalRun.ts`、`src/agent.ts`、`src/safeDiscussionRoute.ts`、`src/goalOrchestrator.ts`、`src/server.ts`、`sim/goalCoordinator.ts`、`sim/production.ts`、`sim/production/api.ts`、`sim/production/agent.ts`、`sim/production/runner.ts`、`sim/goalUsage.ts`、`sim/goalUsage.test.ts`、`src/goalRun.test.ts`、`src/schema.test.ts`、`sim/goalCoordinator.test.ts`、`sim/production.test.ts`、`package.json`、本計畫；新增測試名稱：`goalUsage.test.ts — quota/estimate/prepare/invoke/finish 順序、actual usage 與失敗終結、primary/fallback attempt`、`goalCoordinator.test.ts — Owner discussion tokenTotal 保存`、`goalRun.test.ts — actual_total_tokens 保存`、`production.test.ts — production primary/fallback Run tracking 接線`。
  - 問題：
    - 實作階段（`sim/production.ts:1306-1321`、`:1426-1439`）完全不寫 `goal_runs`：沒有估算、quota snapshot、actual usage，primary 與 fallback 也沒分成兩筆 Run。
    - `sim/goalCoordinator.ts:201-204` 丟掉了 `tokenTotal`，討論的 actual usage 永遠是 null。
    - `src/goalOrchestrator.ts:109` 記錄的模型是 `claude-sonnet-5-5`，實際用的是 `SAFE_DISCUSSION_ROUTE` 的 `claude-sonnet-5`（`sim/run.ts:1801`）。
  - 規格：L304、L326-334。
  - 修正：
    - 實作階段的 Run 寫進 `goal_runs`，fallback 另記一筆。
    - 保存 `tokenTotal`。
    - Run 記錄實際呼叫的模型；直接從 `SAFE_DISCUSSION_ROUTE` 讀，不要另寫常數。
  - 驗收：
    - fake runner 測試斷言欄位都已寫入。
    - Agent 頁的累積 token 不再恆為 0。

- [x] **C6 Adapter 契約沒有接上 production**
  - 改動檔案：`sim/goalAdapters.ts`、`sim/goalAdapters.test.ts`、`sim/production.ts`、`sim/production/runner.ts`、`sim/production.test.ts`、本計畫；新增測試名稱：`goalAdapters.test.ts — Claude/Codex/AGY command 與 cwd、timeout/quota/permission/stderr/soft-denial 分類、exit status、同 adapter AGY permission 不 fallback`、`production.test.ts — production 使用共用 classify/execute fallback 契約`。
  - 問題：
    - `sim/goalAdapters.ts` 只有測試在用，違反規格 L515「不得預先加入未使用的 abstraction」。
    - production 的 fallback 判斷是自寫的 git fingerprint（`sim/production.ts:1305-1323`）。
    - AGY 輸出空白（soft-denial）只變成「無 JSON」錯誤，沒有分類成 permission（`sim/production/runner.ts:316-330`）。
    - fallback 沒擋住「AGY 換另一個 AGY 模型重試」。
    - `AgentRunResult` 缺 exit status 欄位。
  - 規格：L267-301、L320。
  - 修正：production 實作階段的 runner 改用 `goalAdapters` 的 `classifyAdapterResult` 與 `executeWithSingleFallback`，並補上 preflight 與 exit status。接完後確認沒有剩下未使用的 export。
  - 驗收：Claude、Codex、AGY 三種 adapter 的 fixture 涵蓋 command 與 cwd、timeout、quota、stderr、soft-denial 的分類。

- [x] **C7 選人過濾不完整**
  - 改動檔案：`src/schema.ts`、`src/agent.ts`、`src/goalOrchestrator.ts`、`sim/goalCoordinator.ts`、`src/schema.test.ts`、`src/goalOrchestrator.test.ts`、本計畫；新增測試名稱：`goalOrchestrator.test.ts — 缺 repo access／skill_profile 完全不符／已有不可並行 Participation 排除，selectedLoad 忽略 Owner output 由系統計算`、`schema.test.ts — Agent repo_access_json migration`。
  - 問題：
    - `src/goalOrchestrator.ts:52-54`、`src/agent.ts:136` 只過濾成員資格與 active。
    - 沒有排除缺 repo 權限、`skill_profile` 不符、已有不可並行工作的 Agent。
    - Agent 沒有「可存取 repo」欄位；`selectedLoad` 由呼叫端傳入，不是系統計算。
  - 規格：L98、L209。
  - 修正：補上可存取 repo 欄位與三種排除；`selectedLoad` 改由系統依進行中的 Participation 與 Task 計算。
  - 驗收：三種排除各一個測試。

- [x] **C8 Owner 與討論的 context 不完整也不安全**
  - 改動檔案：`src/schema.ts`、`src/goalRun.ts`、`src/goalOrchestrator.ts`、`sim/goalDiscussion.ts`、`sim/goalCoordinator.ts`、`src/goalRun.test.ts`、`sim/goalDiscussion.test.ts`、`sim/goalCoordinator.test.ts`、本計畫；新增測試名稱：`goalDiscussion.test.ts — 兩份 900 字 peer 各自保留／惡意留言只在 UNTRUSTED 區塊`、`goalCoordinator.test.ts — Owner comment bounded UNTRUSTED prompt 與 sourceRefs 保存`、`goalRun.test.ts — source_refs_json 保存`。
  - 問題：
    - owner_scoping、owner_synthesis 的 prompt 不含 target repo 內容（`sim/goalCoordinator.ts:137,165`），也不含留言（`:35-38,148-152`）。
    - Owner 與 discovery 的 prompt 直接 `JSON.stringify`，沒經過 `sanitizeUntrustedText`，也沒有長度上限（`:137,165,178,189`、`sim/goalPatrol.ts:87`）。
    - Round 2 的同儕內容塞在受信任的 ASSIGNMENT 區段，整份被截到 2000 字（`:150`、`sim/goalDiscussion.ts:47`）。
    - `packet.sourceRefs` 沒有存進資料庫（`sim/goalDiscussion.ts:54`）。
  - 規格：L215、L237、L245-249、L251-266。
  - 修正：
    - 加入 repo 摘要與相關留言。
    - 不受信任的內容一律清理後放進 UNTRUSTED 區塊，並設每份與總長的上限。
    - 同儕內容每份分開截斷，不和 ASSIGNMENT 共用額度。
    - Run 保存 `sourceRefs`。
  - 驗收：
    - 兩份各 900 字的同儕內容都完整出現在 prompt。
    - 含指令字樣的留言出現在 UNTRUSTED 區塊內。

- [x] **C9 巡檢判斷有誤**
  - 改動檔案：`src/schema.ts`、`sim/goalPatrol.ts`、`sim/goalPatrol.test.ts`、本計畫；新增測試名稱：`goalPatrol.test.ts — dry-run 後 live 仍 eligible／live 成功才寫 fingerprint／持 lease 人類 Goal 阻擋／skip reason 保存／BUG+CI failure+deployment anomaly fingerprint／缺 Project 建立且去重／prepareRun 前失敗清 pending heartbeat`。
  - 問題：
    - `sim/goalPatrol.ts:42-47` 在判定 eligible 時就寫入 fingerprint。dry-run 或 live 失敗後，下一次 live 會被誤判成「證據沒變」而略過。
    - `:39` 的「人類 Goal 正在執行」只看 Executing。
    - `:49-52` 的 skip 原因沒有保存；fingerprint 不含 BUG、部署異常、測試失敗。
    - discovery 不會在沒有合適 Project 時建立 Project（`:124-125`）。
    - discovery 在 `prepareRun` 前失敗時，會留下 pending heartbeat，之後每次都被判成 `discovery_running`。
  - 規格：L207、L372-379。
  - 修正：
    - fingerprint 只在 live discovery 成功後寫入。
    - 「人類 Goal 正在執行」改看是否持有 lease（`owner_synthesis`、Executing、Verifying、Blocked）。
    - 保存 skip 原因；fingerprint 補上述三類證據。
    - 實作「沒有合適 Project 才在同一 Workspace 建立」，並比對重複 Project。
    - 失敗時清掉 pending heartbeat。
  - 驗收：dry-run 之後的 live 不被略過；每一項各一個測試。

- [x] **C10 reconciliation 沒有要求調整**
  - 改動檔案：`src/goalOrchestrator.ts`、`sim/goalCoordinator.ts`、`src/goalOrchestrator.test.ts`、本計畫；新增測試名稱：`goalOrchestrator.test.ts — reconciliation 完全相同人選與 assignment 直接 Blocked`。
  - 問題：`src/goalOrchestrator.ts:160-169`、`sim/goalCoordinator.ts:131-141` 用同一份 prompt 重跑 owner_scoping，沒有要求也沒有驗證人選或面向必須改變。
  - 規格：L221、L318。
  - 修正：reconciliation 的 prompt 帶入上一輪的失敗原因；結果與上一輪完全相同時直接進 Blocked。
  - 驗收：fake Owner 回傳相同名單 → Blocked。

- [x] **C11 production 覆寫了 Owner 的指派**
  - 改動檔案：`sim/production/policy.ts`、`sim/production.ts`、`sim/production.test.ts`、本計畫；新增測試名稱：`production.test.ts — 已指派 Goal Todo 保留 assignee 走 assign_member／人類 assignee 不進 member_work／未登記 repo 不 throw 且只標記該 Task`。
  - 問題：
    - `sim/production/policy.ts:403`、`sim/production.ts:1117-1125`：Goal Task 仍走 owner_dispatch，Owner 指定的負責人會被 `resolveDispatchAssignee` 覆寫。
    - 指派給非 Agent 成員時，`member_work` 每個 tick 都 throw。
    - `sim/production.ts:246`：任何一個 Goal Task（包括 Done 的）的 repo 未登記，整個 tick 都 throw，連 legacy Task 也一起失敗。
  - 規格：L338-361。
  - 修正：
    - 已指派的 Goal Task 跳過 owner_dispatch。
    - 指派給非 Agent 的 Task 交給人類，不進 `member_work`。
    - repo 未登記時只略過該 Task 並記一筆警告；Done 或 Archived 的 Task 不檢查。
  - 驗收：`sim/production.test.ts` 涵蓋上述三種情況。

- [x] **C12 規格的資料欄位尚未補齊**
  - 改動檔案：`src/schema.ts`、`src/goalRun.ts`、`src/goalOrchestrator.ts`、`src/task.ts`、`src/project.ts`、`src/server.ts`、`sim/goalUsage.ts`、`sim/goalDiscussion.ts`、`sim/goalCoordinator.ts`、`sim/production.ts`、`sim/production/agent.ts`、`sim/production/api.ts`、`sim/production/policy.ts`、`sim/production/runner.ts`、`src/goalRun.test.ts`、`src/goalOrchestrator.test.ts`、`src/project.test.ts`、`src/task.test.ts`、`sim/goalUsage.test.ts`、`sim/goalDiscussion.test.ts`、`sim/goalCoordinator.test.ts`、`sim/goal.integration.test.ts`、`sim/production.test.ts`、本計畫；新增測試名稱：`goalRun.test.ts — concern/correction 必須有 evidence／Run session ID`、`goalOrchestrator.test.ts — synthesis 完整欄位與 dependsOn／Task 級 deployment／Round 1 平行與獨立 quota`、`project.test.ts — worktree dirty 1/0`、`task.test.ts — active Goal Project 拒絕 legacy createTask`、`goalDiscussion.test.ts — correction 空 evidence 拒絕`、`production.test.ts — member session 前標記 worktree dirty`。
  - 問題與規格：
    - Contribution 的 concern／correction 不要求證據引用，`evidenceRefs` 可以是空陣列（`src/goalRun.ts:290-305`，規格 L225-231）。
    - synthesis 缺採納／拒絕理由、修改範圍、不確定性，`dependsOn` 被丟掉（`src/goalOrchestrator.ts:26-30,227-231`，規格 L237）。
    - `deployment_not_required` 只有 repo 層級，規格要的是 Task 層級標示（`src/repoRegistry.ts:5`，規格 L363）。
    - `goal_worktrees.dirty` 從來不會被設成 1（`src/project.ts:167-176`，規格 L408）。
    - Run 沒有 session ID 欄位（`src/schema.ts` 的 goal_runs，規格 L147）。
    - Round 1 是循序 await，不是平行，而且共用同一份 quota snapshot（`src/goalOrchestrator.ts:150`，規格 L219）。
    - legacy createTask 沒擋 active Goal 的 Project（`src/task.ts:184-186`，規格 L344）。只擋 legacy sweep 路徑，人類手動建立不擋。
  - 修正：逐點補齊。每一點是獨立的 commit，可以分開標記。
  - 驗收：每一點至少一個測試。

## D. UI

- [x] **D1 Goal 詳情頁**
  - 改動檔案：`public/js/views/goals.js`、`public/css/goals.css`、`src/server.ts`、`src/frontend.test.ts`、本計畫；新增測試名稱：`frontend.test.ts — Goal 詳情 route／參與者／Contribution／synthesis／Task／Run usage／交付證據／parent-child／@Owner／Blocked actions／成功條件／mobile overflow`。
  - 問題：`public/js/views/goals.js:40-62` 只顯示數量；Blocked 的 Goal 沒有任何操作按鈕（`:54-56`）。
  - 規格：L426-431。
  - 修正：新增詳情頁，內容包括：
    - 參與 Agent 與選人理由
    - 各輪 Contribution
    - Owner synthesis
    - Task 列表
    - Run 與用量
    - commit、CI、merge、deploy 證據
    - parent／child 關係
    - `@Owner` 留言入口
    - Blocked 的取消與恢復（恢復要填變更說明，見 A4）
    - 修改成功條件（見 C2）
  - 驗收：前端測試；行動版寬度不能出現水平捲動。

- [x] **D2 Agents 頁**
  - 改動檔案：`src/agent.ts`、`public/js/views/agents.js`、`src/agent.test.ts`、`src/server.test.ts`、`src/frontend.test.ts`、本計畫；新增測試名稱：`agent.test.ts — 固定六位 Agent／最近 preflight 與 Run／fallback 與未知 usage 次數`、`server.test.ts — Agents API 固定六位且回傳統計欄位`、`frontend.test.ts — Agents 統計欄位顯示`。
  - 問題：`public/js/views/agents.js:99-138`、`src/agent.ts:111-133`。
    - 缺最近的 preflight 與 Run、fallback 次數、未知 usage 次數。
    - 只列出目前 workspace 成員中的 Agent。
  - 規格：L432-435。
  - 修正：補上缺的欄位，固定列出 user01–06 這六位 Agent。
  - 驗收：前端與 server 測試。

- [x] **D3 Project context 與建立 Task**
  - 改動檔案：`public/js/views/kanban.js`、`src/frontend.test.ts`、本計畫；新增測試名稱：`frontend.test.ts — Project context Task 完成進度／建立 Task 明示 Project`。
  - 問題：Project context 沒有進度（`kanban.js:350-356`）；建立 Task 的表單沒有顯示 Project，只隱含使用目前的篩選值（`:240-256`）。
  - 規格：L415、L420。
  - 修正：兩點都補上。
  - 驗收：前端測試。

## E. 測試補齊

- [x] **E1** `sim/production.test.ts` 加進 `npm test`。
  - 改動檔案：`package.json`、`docs/superpowers/plans/2026-10-11-goal-agent-collaboration-fixes.md`；新增測試名稱：`npm test includes sim/production.test.ts` 設定斷言。
- [x] **E2** `sim/goal.integration.test.ts` 改成走 production coordinator，搭配 fake runner 與 CI fixture，不再直接用 SQL 把 Task 設成 Done。逐個 checkpoint 模擬崩潰並重跑（規格 L478-488）。
  - 改動檔案：`sim/goal.integration.test.ts`、`docs/superpowers/plans/2026-10-11-goal-agent-collaboration-fixes.md`；新增測試名稱：Goal production coordinator checkpoint crash/restart integration。
- [x] **E3** 規格 L449-469 中只做了一部分的 Domain 測試：
  - Project 已封存時 domain 會隱藏它。
  - 修改 Task 為跨 Workspace 的 Project 時被拒絕。
  - 從 Executing 暫停後，其他 Goal 可以取得 lease。
  - trigger_ref 的 patrol 與 followup 不會互相吞掉。
  - legacy sweep 不會在 lease 被持有的 repo 執行 merge。
  - `@Owner` 的測試改用 user09 本人。
  - 改動檔案：`src/project.ts`、`src/project.test.ts`、`src/task.test.ts`、`src/goal.test.ts`、`src/goalRun.test.ts`、`src/comment.test.ts`；新增／修正測試：archived Project domain list 隱藏、跨 Workspace Project PATCH 拒絕、Executing 暫停後 lease 轉移、patrol/followup trigger_ref 隔離、`@Owner` user09 真人 fixture。

## 人工步驟（不由執行者處理）

- **H1** 建立 repo registry JSON（格式見 `docs/operations.md`「Goal-driven collaboration」）。正式的 `task-tracker.service` 是 system unit，自動部署不會重裝它，所以要用 sudo 補上 `TASK_TRACKER_REPO_REGISTRY_PATH` 與 `EnvironmentFile`，然後 daemon-reload。
- **H2** 建立 `~/.config/task-tracker/coordinator.env`（內容為 `TASK_TRACKER_COORDINATOR_TOKEN`）。
- **H3** Claude review 工作目錄裡未 commit 的改動，人類確認後才 commit。merge 到 master 是另一個獨立步驟，merge 就會觸發自動部署。
- **H4** 合併並觀察一段時間後，再決定是否安裝 `goal-coordinator.timer` 與 `goal-discovery.timer`。

## 執行紀錄

（執行者在這裡填寫：開始與結束時間、各項結果、最後一次 `npm test` 的結果）

- 2026-10-12 C12（未執行 D1；未宣稱全計畫完成）
  - RED：`src/goalRun.test.ts` session ID actual `null`；`src/project.test.ts` 原文 `TypeError: setGoalWorktreeDirty is not a function`；`src/task.test.ts` 原文 `Missing expected exception: active Goal 的 Project 不可手動建立 legacy Task`；`src/goalOrchestrator.test.ts` async quota 被舊同步介面傳入，原文 `CommandError: quotaSnapshotJson 不可為空`。
  - GREEN：concern/correction 必須附 evidence；synthesis 保存採納／拒絕理由、修改範圍、不確定性、dependsOn；Task 自帶 deployment_not_required 並依此驗收；production 在 member session 前設 dirty=1、完成後以 git status readback；Run 保存 session ID；Round 1 `Promise.all` 且每位 Agent 獨立取 quota；active Goal Project 阻擋 legacy `createTask`。
  - 通過：`node --import tsx src/goalRun.test.ts`、`node --import tsx sim/goalUsage.test.ts`、`node --import tsx sim/goalDiscussion.test.ts`、`node --import tsx src/project.test.ts`、`node --import tsx src/task.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/schema.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未完整執行：`node --import tsx sim/production.test.ts` 已通過 C12 source assertion，後於既有 HTTP fixture 失敗；原文 `Error: listen EPERM: operation not permitted 127.0.0.1`，未修改測試執行方式。

- 2026-10-12 D1（未執行 D2；未宣稱全計畫完成）
  - RED：`node --import tsx src/frontend.test.ts` exit 1，原文 `Goals route 必須支援獨立詳情頁`。
  - GREEN：`#/goals/:id` 顯示參與理由、各輪 Contribution、Owner synthesis、Task、Run/session/usage、delivery evidence、parent/child；Member 可送出 `@Owner` Task 留言，Blocked 可填變更說明恢復或取消，也可修改成功條件。mobile CSS 使用 `min-width:0`、`max-width:100%` 與 `overflow-wrap:anywhere`。
  - 通過：`node --import tsx src/frontend.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 D2（未執行 D3；未宣稱全計畫完成）
  - RED：`src/agent.test.ts` actual 1、expected 6；`src/frontend.test.ts` 原文 `Agents 頁必須顯示最近 preflight、Run、fallback 與未知 usage`。
  - GREEN：Agents summary 固定由全域 user01–06 計算，新增最近 Run、最近 preflight、fallback 次數與 usage 未知次數；UI 顯示上述欄位。
  - 通過：`node --import tsx src/agent.test.ts`、`node --import tsx src/frontend.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行到新增 HTTP assertions：`node --import tsx src/server.test.ts` 在既有 health 基線先失敗，原文 `AssertionError: health 必須帶 git rev`，actual `unknown`；未修改測試執行方式。

- 2026-10-12 D3（未執行 E1；未宣稱全計畫完成）
  - RED：`node --import tsx src/frontend.test.ts` exit 1，原文 `建立 Task 表單必須明示 Project 並以選取值送出`。
  - GREEN：Project context 顯示未封存 Task 的 Done/total 與百分比；Member 建立 Task 時顯示 active Project 選單，預選目前 Project filter 並以明示值送出。
  - 通過：`node --import tsx src/frontend.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-11 A1（未執行 A2；未宣稱全計畫完成）
  - 紀錄開始時間：23:04:37 CST（最早保留的可驗證測試活動時間，不代表實際開工瞬間）；紀錄結束時間：23:22:14 CST（完成品質複審測試補強驗證後執行 `date`）。
  - RED：`node --import tsx sim/goalCoordinator.test.ts` exit 1，預期失敗原文：`CommandError: Goal 驗收缺少 evidence`（`src/goalOrchestrator.ts:253`）。
  - GREEN：`node --import tsx sim/goalCoordinator.test.ts` exit 0，`goalCoordinator.test.ts OK`。
  - 直接相關 regression：`node --import tsx src/goalOrchestrator.test.ts` exit 0，`goalOrchestrator.test.ts OK`；`node --import tsx src/goal.test.ts` exit 0，`goal.test.ts OK`。
  - TypeScript：`npx tsc --noEmit` exit 0；`npx tsc -p sim/tsconfig.json` exit 0。
  - Lint：`npm run lint` exit 0。
  - 沙盒內未執行成功：`node --import tsx sim/goal.integration.test.ts` exit 1。失敗段落原文：`Error: spawnSync git EPERM`，首個受限呼叫為 `git init -b master`；依本計畫既知沙盒限制，未修改測試執行方式。
  - 規格審查修補紀錄開始時間：23:11:06 CST（本次最早保留的可驗證測試活動時間，不代表實際開工瞬間）；紀錄結束時間：23:12:13 CST（完成全部驗證後執行 `date`）。
  - 審查修補 RED 1：invalid output 後、retry 前模擬中斷，再進入 `runGoalCoordinatorOnce`，exit 1：`CommandError: verifying 已有終態 Run`。
  - 審查修補 RED 2：全部 Task Archived 經 `runGoalCoordinatorOnce`，exit 1：`actual 'waiting_tasks'`、`expected 'done'`。
  - 審查修補 RED 3：fake runner 丟出相同文字的真實 `CommandError`，exit 1：`真正 Run failure 不得因錯誤文字相同而被誤認成 invalid-output retry`，`2 !== 1`。
  - 審查修補 GREEN：`node --import tsx sim/goalCoordinator.test.ts` exit 0（23:12:04 CST），`goalCoordinator.test.ts OK`；`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx src/goal.test.ts` exit 0。
  - 審查修補 gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 審查修補 sandbox integration：`node --import tsx sim/goal.integration.test.ts` exit 1，仍為既知 `Error: spawnSync git EPERM`（`git init -b master`），未修改測試執行方式。
  - 品質審查修補紀錄開始時間：23:18:30 CST（本次最早保留的可驗證測試時間戳，不代表實際開工瞬間）；紀錄結束時間：23:18:59 CST（完成全部指定驗證後執行 `date`）。
  - 品質審查 RED：invalid-output retry 的 quota 準備中斷交給 CLI 共用 error handler 後，exit 1：`CLI error handler 不得把 invalid-output retry 準備中斷標成 Blocked`，actual 與 expected 均為 `Blocked`。
  - 品質審查 GREEN：`node --import tsx sim/goalCoordinator.test.ts` exit 0（23:18:53 CST），涵蓋暫時錯誤不 Blocked 與 terminal Owner Run failure 仍 Blocked；`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx src/goal.test.ts` exit 0。
  - 品質審查 gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 品質複審測試補強紀錄開始時間：23:21:48 CST（本次最早保留的可驗證測試時間戳，不代表實際開工瞬間）；紀錄結束時間：23:22:14 CST（完成全部指定驗證後執行 `date`）。
  - 新測試現況基準：連續兩次 `{passed:false,evidenceRefs:[]}` 時 `node --import tsx sim/goalCoordinator.test.ts` 立即 exit 0（23:21:48 CST）；invoke 恰為 2 次、CLI handler 回 `true`、Goal 為 Blocked，重跑 coordinator 不會第三次 invoke。
  - 人工破壞 RED：以 `apply_patch` 暫時移除「第二次 invalid → `TerminalOwnerDiscussionRunError`」後，同一測試 exit 1：`第二次 invalid output 是 terminal Owner failure`，`false !== true`；隨即以 `apply_patch` 恢復原行。
  - 恢復 GREEN：`node --import tsx sim/goalCoordinator.test.ts` exit 0（23:22:02、最終 gate 23:22:09 CST）；`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx src/goal.test.ts` exit 0。
  - 品質複審 gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-11 A2（未執行 A3；未宣稱全計畫完成）
  - 紀錄開始時間：23:23:51 CST；紀錄結束時間：23:27:00 CST。
  - RED：`node --import tsx sim/goalCoordinator.test.ts` exit 1，預期失敗原文：`ConflictError: repo execution lease 已被其他 Goal 持有`，stack 指向 `storeGoalSynthesis`；證明舊流程在 Owner output 後才取 lease。
  - GREEN：`node --import tsx sim/goalCoordinator.test.ts` exit 0，`goalCoordinator.test.ts OK`；直接斷言等待時 Owner 0 次、B 保持 Discussing／`awaiting_lease`、holder 仍為 A，A Done 後 B 取得 lease，synthesis 與 Task 都使用 `fresh-after-lease` 而非 pre-lease output。
  - CLI error classification：直接斷言 lease `ConflictError` 與 `owner_synthesis 已在執行` 的 `CommandError` 均讓 `handleGoalCoordinatorError` 回 `false`，B 不變成 Blocked。
  - 直接相關 regression：`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx src/goal.test.ts` 全部 exit 0。
  - Gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行成功：`node --import tsx sim/goal.integration.test.ts` exit 1；失敗段落原文：`Error: spawnSync git EPERM`，首個受限呼叫為 `git init -b master`，屬本計畫已知沙盒限制，未修改測試執行方式。
  - 品質審查修補紀錄開始時間：23:32:11 CST；紀錄結束時間：23:36:07 CST。
  - CLI exit RED：`node --import tsx sim/goalCoordinator.test.ts` exit 1，`TypeError: goalCoordinatorCliExitCode is not a function`。GREEN 直接斷言起始即 `awaiting_lease` 且仍等待為 exit 1，本次才由 round 轉入等待為 exit 0；helper 已由 live CLI success path 實際呼叫。
  - Source ordering RED：同測試 exit 1，`source read 失敗前不得取得 lease`，actual holder 為 missing-repo Goal。GREEN 將 deterministic repo source read 移到 acquisition 前；ENOENT 走非零錯誤、handler 不 Block、Goal 保持 Discussing／`awaiting_lease` 且無 lease。
  - Synthesis validation RED 1：同測試 exit 1，`malformed initial synthesis 應是 terminal Owner output failure`，`false !== true`。RED 2 收緊為 `taskPlans: [{}]` 後 exit 1，實際延遲到 `CommandError: Task title 不可為空`。RED 3 加上 storage 斷言後 exit 1，`malformed initial synthesis 不得留下 stage output`，`1 !== 0`。
  - Synthesis validation GREEN：初次與 A1 correction synthesis 都在 Run 成功及 stage-output 寫入前驗證完整必填 shape；malformed output 只 invoke 1 次、CLI handler 標 Blocked、保留 lease、不建立 domain synthesis、不留 stage output，重跑不再 invoke；verification invalid-output retry 順序未更動。
  - 品質審查 GREEN／gates：`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx src/goal.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 規格複審修補紀錄開始時間：23:38:15 CST；紀錄結束時間：23:39:52 CST。
  - Fresh snapshot RED：可控 reader 讓等待 invocation 與 acquisition invocation 的 preflight 回 `stale-preflight`，post-acquire reread 回 `fresh-post-lease`；`node --import tsx sim/goalCoordinator.test.ts` exit 1，Owner 實際 `sourceTexts` 為 `[]`，預期為 `['fresh-post-lease']`。
  - Fresh snapshot GREEN：`GoalCoordinatorDeps.readRepoSources` 為最小 optional injection，production 預設仍使用 `repoSources`；流程固定為 readability preflight → acquire → reread，只有第二次 snapshot 傳入 Owner。直接斷言三次 read 與 Owner 僅見 fresh content。
  - Source failure tests：post-acquire reread 失敗與 crash-recovery `owner_synthesis` 已持 lease時 preflight 失敗，均 Owner 0 次、CLI handler terminal Blocked、lease holder 不變。Mutation proof 暫時移除兩處 terminal wrapper 後，同測試 exit 1：`post-lease reread failure 應 terminal Blocked`，`false !== true`；隨即恢復並 GREEN。
  - Deterministic validation 複審開始時間：23:42:18 CST；結束時間：23:44:34 CST。
  - RED：table-driven `long-title`／`unknown-assignee` 中第一案 exit 1：`long-title 不得留下 stage output`，`1 !== 0`；證明既有 coordinator shape validator 未涵蓋 materialize 的 deterministic constraints。
  - GREEN：新增 shared `validateGoalSynthesis`，由 coordinator pre-Run-success、`storeGoalSynthesis`、`materializeGoalTasks` 共用；涵蓋非空 taskPlans、title ≤200、description ≤5000、非空 acceptanceCriteria／rollbackCondition／assignee，以及 assignee 當下為 Workspace member。兩個 table cases 均無 stage output／synthesis／tasks，terminal Blocked、保留 lease且 invoke 恰一次。
  - Membership race：SQLite test trigger 在 synthesis persist 後移除 member，materialize transaction 內以同一 validator 再驗；結果 tasks 0、terminal Blocked、lease 保留、invoke 恰一次。Mutation proof 暫時移除 residual-error wrapper 後 exit 1：`prevalidate 後 membership 變動應 terminal Blocked`，`false !== true`；隨即恢復並 GREEN。
  - 2026-10-12 residual concurrency 修補紀錄開始時間：04:09:00 CST（本次最早可驗證工作時間）；紀錄結束時間：04:11:29 CST。
  - RED：SQLite `BEFORE INSERT` trigger 模擬 synthesis persist busy，`node --import tsx sim/goalCoordinator.test.ts` exit 1：`residual concurrency 不得被分類為 terminal Owner failure`，`true !== false`。
  - GREEN：新增 `InvalidGoalSynthesisError`；只有 deterministic synthesis validation 會轉 terminal。`ConflictError`／SQLite busy 原樣上拋，handler 回 `false`，Goal 保持 Discussing／`owner_synthesis` 且 lease 不變。
  - 最終 gates：`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx src/goal.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 A3（未執行 A4；未宣稱全計畫完成）
  - 紀錄開始時間：04:12:00 CST（本次最早可驗證工作時間）；紀錄結束時間：04:17:52 CST。
  - Domain RED：`node --import tsx src/goal.test.ts` exit 1，`TypeError: isGoalSafeCheckpoint is not a function`。
  - Coordinator RED：排定暫停未被辨識，流程進入驗收後以 `TerminalOwnerDiscussionRunError: Owner 驗收 fail 缺少 evidence` 失敗。
  - UI RED：`node --import tsx src/frontend.test.ts` exit 1，缺少 `/pause_requested[\\s\\S]*暫停請求已排定/`。
  - GREEN：安全 Executing Goal 立即 Paused 並釋放 lease；未合併／dirty worktree 或 production `action_log` pending merge/deploy 時寫 `goal.pause_requested`；coordinator 在整合後套用 Paused；Discussing 有 running Run 時維持排定且不再推進；UI 顯示排定狀態與 action 錯誤。API 對排定回 202、立即套用回 200。
  - 通過：`node --import tsx src/goal.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/frontend.test.ts`、`node --import tsx src/schema.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行成功：`node --import tsx src/server.test.ts` 在既有 health 基線先失敗，原文 `AssertionError: health 必須帶 git rev`；根因為 Node `spawnSync git EPERM`，尚未進入新增 pause assertions，未修改測試執行方式。

- 2026-10-12 A4（未執行 A5；未宣稱全計畫完成）
  - 紀錄開始時間：04:18:00 CST（本次最早可驗證工作時間）；紀錄結束時間：04:22:28 CST。
  - RED：`node --import tsx src/goal.test.ts` exit 1，原文 `CommandError: goal 不存在`；證明舊 `resumeGoal` 將新增的變更說明參數誤當 database。
  - 中間 RED：reconciliation 查詢只加 revision 後，`goalOrchestrator.test.ts` actual `reconciled`、expected `blocked`；根因是 reconciliation event 先產生新 revision，但紀錄仍寫舊 revision。修正為紀錄歸屬新 revision，同 revision 第二次失敗才 Blocked。
  - GREEN：Blocked 恢復必填變更說明並存入 event；Discussing 回新 revision／`owner_scoping`；Executing／Verifying 回原狀態且 lease 不變；API 缺說明回 400；UI 提供 Blocked resume／cancel 並提示變更說明。
  - 通過：`node --import tsx src/goal.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/frontend.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行成功：`node --import tsx src/server.test.ts` 在既有 health 基線先失敗，原文 `AssertionError: health 必須帶 git rev`，actual `unknown`；尚未進入新增 resume assertions，未修改測試執行方式。

- 2026-10-12 A5（未執行 A6；未宣稱全計畫完成）
  - RED（mutation proof）：暫時只比較原始 lease path 與 canonical scenario path，`node --import tsx sim/run.test.ts` exit 1，原文 `別的 workspace 透過 symlink canonical path 持有同 repo lease 時必須略過 legacy sweep`、`false !== true`；隨即恢復 canonical 比較。
  - GREEN：legacy sweep 不再 JOIN 當前 workspace Project，而是讀取所有 `repo_leases.target_repo`，將 lease 與 scenario repo 兩側 `realpathSync` 後比較，因此其他 workspace 的同 repo lease 也會阻擋。
  - Gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未完整執行：修正後 `node --import tsx sim/run.test.ts` 已通過新增 assertion，之後在既有 attachment egress hook 測試因 `spawnSync ... node EPERM` exit 1；依計畫未修改執行方式。

- 2026-10-12 A6（未執行 A7；未宣稱全計畫完成）
  - RED：`node --import tsx src/frontend.test.ts` exit 1，原文 `Project target repo 必須選填`；來源仍含 `id="project-target-repo" required`。
  - GREEN：repo 選單新增「不設定」且送出 `null`，編輯舊 Project 不再自動選第一個 repo；空 registry 顯示 `docs/operations.md` 提示；Task 目前所屬 archived Project 保留在選單。
  - 通過：`node --import tsx src/frontend.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 A7（未執行 B1；未宣稱全計畫完成）
  - RED 1：`node --import tsx src/comment.test.ts` exit 1，原文：`終態 Goal 留言不得建立 owner_comment heartbeat`，`2 !== 1`。
  - RED 2：`node --import tsx sim/goalCoordinator.test.ts` exit 1，原文：actual `waiting_tasks`、expected `owner_comment_replied`。
  - GREEN：`node --import tsx src/comment.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx sim/goalPatrol.test.ts`、`node --import tsx src/goal.test.ts`、`node --import tsx src/goalOrchestrator.test.ts` 全部 exit 0。
  - Gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 只新增 systemd unit 與安裝文件，未安裝、未啟用，也未執行任何 live AI 指令。

- 2026-10-12 B1（未執行 B2；未宣稱全計畫完成）
  - 測試已先加入 `src/server.test.ts`：user01/user02 建立 human Goal、Agent 解除 Blocked 與 cancel 均預期 403，既有人類成員成功路徑保留。
  - 沙盒內未執行到新 HTTP assertions：`node --import tsx src/server.test.ts` exit 1，在既有 health 基線先失敗，原文 `AssertionError: health 必須帶 git rev`，actual `unknown`；根因為 `spawnSync git EPERM`，未修改測試執行方式。
  - 通過：`node --import tsx src/goal.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B2（未執行 B3；未宣稱全計畫完成）
  - 測試已加入 `src/server.test.ts`：其他 Workspace 的人類 Admin 預期 403，主協作工作區的人類 Admin 預期 200。
  - 沙盒內未執行到新 HTTP assertions：`node --import tsx src/server.test.ts` exit 1，在既有 health 基線先失敗，原文 `AssertionError: health 必須帶 git rev`，actual `unknown`；未修改測試執行方式。
  - Gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B3（未執行 B4；未宣稱全計畫完成）
  - RED：`node --import tsx src/goal.test.ts` exit 1，原文：`Goal cancel 必須固定由 Owner Agent 經 archive command 封存 Task`，actual `human-1`、expected `owner-user`。
  - GREEN：`cancelGoal` 保留單一 transaction，改由 user01 的 user id 呼叫既有 `archiveTask`；`archiveTask` 在既有 transaction 內改用 `appendEventInTransaction`。
  - 通過：`node --import tsx src/goal.test.ts`、`node --import tsx src/task.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B4（未執行 B5；未宣稱全計畫完成）
  - 測試已加入 `src/server.test.ts`：user01 Owner Agent 建立 Workspace 預期 403，人類帳號預期 201。
  - 沙盒內未執行到新 HTTP assertions：`node --import tsx src/server.test.ts` exit 1，在既有 health 基線先失敗，原文 `AssertionError: health 必須帶 git rev`，actual `unknown`；未修改測試執行方式。
  - 通過：`node --import tsx src/workspace.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B5（未執行 B6；未宣稱全計畫完成）
  - RED：`node --import tsx src/task.test.ts` exit 1，原文 `Missing expected exception`，首個未阻擋路徑為 Goal Task 搬 Workspace。
  - GREEN：`changeTaskProject` 與 `moveTask` 在任何寫入前統一檢查 `goal_id`，分別回 `Goal Task 不可變更 Project`與 `Goal Task 不可搬移 Workspace`。
  - 通過：`node --import tsx src/task.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B6（未執行 B7；未宣稱全計畫完成）
  - RED：`node --import tsx src/goalOrchestrator.test.ts` exit 1，原文 `整批名單有一人不合格時不得留下 Participation`，`1 !== 0`。
  - GREEN：全部名單先驗證，Participation、round_1 heartbeat 與 phase event 放入同一 `BEGIN IMMEDIATE`；同 revision 已進 round_1 且完整欄位相同時直接回傳。
  - 通過：`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/goalRun.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B7（未執行 B8；未宣稱全計畫完成）
  - RED：`node --import tsx src/goalOrchestrator.test.ts` exit 1，原文 `TypeError: saveFollowupCandidate is not a function`。
  - GREEN：follow-up create 在同一 transaction 內呼叫 `createGoal`，因此套用 active 自治 Goal 與 parent/project 檢查；去重改為 Workspace + Project + success criteria + evidence fingerprint，重複改回 409 語意；新增只持久化、不建 Goal 的 candidate table 與 `save` action。
  - 通過：`node --import tsx src/schema.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 B8（未執行 C1；未宣稱全計畫完成）
  - RED：`node --import tsx src/goal.test.ts` exit 1，原文 `Missing expected exception`，首個未阻擋路徑為非 Owner Agent 的 `ownerAgentId`。
  - GREEN：`createGoal` 現在驗證 Owner Agent resource 的 role，並在建立當下重讀 repo registry；registry 以 optional dependency 注入供 deterministic tests 與 coordinator/patrol 共用。`blockGoal` 明確拒絕 Queued。
  - 通過：`node --import tsx src/goal.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx sim/goalPatrol.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行成功：`node --import tsx sim/goal.integration.test.ts` exit 1，原文 `Error: spawnSync git EPERM`，首個受限呼叫為 `git init -b master`；未修改測試執行方式。

- 2026-10-12 C1（未執行 C2；未宣稱全計畫完成）
  - RED：`node --import tsx src/goal.test.ts` exit 1，原文 `未持 lease 的自治 Goal 應讓位回 Queued`，actual `Discussing`、expected `Queued`。
  - GREEN：新增 `goal_preemptions` 記錄人類/自治 Goal 關係；同 repo 未持 lease 自治 Goal 以 event 回 Queued 並 skip 舊 heartbeat，持 lease 者寫 pause request，Blocked holder 不動。人類 Goal Done/Cancelled/Blocked 時以 event 恢復或重開 pending heartbeat。
  - 通過：`node --import tsx src/schema.test.ts`、`node --import tsx src/goal.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx sim/goalPatrol.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 C2（未執行 C3；未宣稱全計畫完成）
  - RED：`node --import tsx src/goal.test.ts` exit 1，原文：actual `undefined`、expected `A files`，證明 Goal read model 未建模資料範圍。
  - GREEN：Goal 新增 `data_scope`；`goal.revised` 每次同時保留當下成功條件與資料範圍。新增單欄 `PATCH /api/goals/:id`、Agent 403 守門與 UI 建立/修改入口；持 lease 時修改回 `owner_synthesis`、revision +1。
  - 通過：`node --import tsx src/schema.test.ts`、`node --import tsx src/goal.test.ts`、`node --import tsx src/frontend.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行到新 HTTP assertions：`node --import tsx src/server.test.ts` exit 1，原文 `AssertionError: health 必須帶 git rev`，actual `unknown`；未修改測試執行方式。

- 2026-10-12 C3（未執行 C4；未宣稱全計畫完成）
  - RED：`node --import tsx sim/goalCoordinator.test.ts` exit 1，原文：actual `waiting_tasks`、expected `task_reassigned`。
  - GREEN：coordinator 以 event id 當 `task_blocked` heartbeat trigger，Owner 可選擇改派或 Block Goal；改派走既有 Task command，Blocked 後用既有 notification event/projection 通知 Workspace 中非 Agent 的 Admin/Owner。
  - 通過：`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/notification.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 C4（未執行 C5；未宣稱全計畫完成）
  - RED：`sim/production.test.ts` 新增的 source assertion 先失敗，原文 `production 必須回送 deployment.verified`；已改為同時支援 ternary kind 的字面值斷言。
  - GREEN：Goal Task 在 worktree 啟動、commit、human blocked、CI（含失敗）、merge、deployment checkpoints 回送證據；新 kind 加入 domain allowlist，既有 unique key 保持重跑冪等。
  - Gates：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未完整執行：`node --import tsx sim/production.test.ts` 已通過新增 source assertions，後於既有 HTTP fixture 失敗；原文 `Error: listen EPERM: operation not permitted 127.0.0.1`，未修改測試執行方式。

- 2026-10-12 C5（未執行 C6；未宣稱全計畫完成）
  - RED：`node --import tsx sim/goalUsage.test.ts` exit 1，原文 `Error: Cannot find module './goalUsage'`。
  - GREEN：production 的 Goal member/Owner primary 與 fallback 各自先保存 estimate、quota snapshot 與 Run，完成後補 actual input/output 或 adapter 提供的 `tokenTotal`；discussion 同樣保存 `tokenTotal`。討論模型由共用 `SAFE_DISCUSSION_ROUTE` 讀取，不再維護漂移常數；Agent 累積 token 在只有 total usage 時仍可顯示非零。
  - 通過：`node --import tsx sim/goalUsage.test.ts`、`node --import tsx src/goalRun.test.ts`、`node --import tsx src/schema.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/agent.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未完整執行：`node --import tsx sim/production.test.ts` 已通過 C5 source assertions，後於既有 HTTP fixture 失敗；原文 `Error: listen EPERM: operation not permitted 127.0.0.1`，未修改測試執行方式。

- 2026-10-12 C6（未執行 C7；未宣稱全計畫完成）
  - RED：`node --import tsx sim/goalAdapters.test.ts` exit 1，timeout fixture actual 為 `errorCategory: runner` 且缺 `exitStatus`，預期 `timeout`／`124`。
  - GREEN：production member execution 改由 `executeWithSingleFallback` 與 `classifyAdapterResult` 決定 fallback／錯誤分類；preflight 檢查 capability cwd 與 live CLI；timeout 為 uncertain、quota/permission 無副作用才可 fallback；AGY permission 不得換另一個 AGY model。`AgentRunResult` 補 exit status，production runner 的 AGY exit 0 空 stdout + `no output produced` 在 JSON parse 前即分類 permission。
  - 通過：`node --import tsx sim/goalAdapters.test.ts`、`node --import tsx sim/production/runner.test.ts`、`node --import tsx sim/goalUsage.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未完整執行：`node --import tsx sim/production.test.ts` 已通過 C6 source assertions，後於既有 HTTP fixture失敗；原文 `Error: listen EPERM: operation not permitted 127.0.0.1`，未修改測試執行方式。

- 2026-10-12 C7（未執行 C8；未宣稱全計畫完成）
  - RED：`node --import tsx src/goalOrchestrator.test.ts` exit 1，原文 `Error: no such column: repo_access_json`。
  - GREEN：Agent resource 新增 `repo_access_json` 與可比對的 skills；候選名單先排除非 active member、非 Workspace member、無 target repo access、明確 skill 不符，以及在其他 active Goal Participation 或 Doing/Review Task 中忙碌者。Participation 的 `selected_load` 一律由系統查詢重算，不採信 Owner output；coordinator prompt 使用同一份候選與負載結果。
  - 通過：`node --import tsx src/schema.test.ts`、`node --import tsx src/agent.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 C8（未執行 C9；未宣稱全計畫完成）
  - RED：`node --import tsx sim/goalDiscussion.test.ts` exit 1，原文 `第一份 900 字 peer contribution 不可被共用 assignment 上限截掉`。
  - GREEN：discussion 將 objective／criteria／assignment／每份 peer／留言分欄消毒與截斷，repo 與 Goal context 都明示為 UNTRUSTED；Owner 所有 phase 使用同一 bounded prompt builder，帶入取得 lease 後的 fresh repo 摘要與最近 Goal Task 留言。Run 新增 `source_refs_json`，保存實際 repo path 與 comment reference，不複製整份來源進 DB。
  - 通過：`node --import tsx sim/goalDiscussion.test.ts`、`node --import tsx src/goalRun.test.ts`、`node --import tsx src/schema.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/goalOrchestrator.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 C9（未執行 C10；未宣稱全計畫完成）
  - RED：`node --import tsx sim/goalPatrol.test.ts` exit 1，原文 `dry-run 不得先寫 fingerprint 阻擋下一次 live`，actual `skipped`、expected `eligible`。
  - GREEN：patrol check 與成功 fingerprint 分表保存；只有 live discovery 成功才更新 evidence fingerprint。人類 Goal 以 repo lease 判斷阻擋，skip reason 持久化；fingerprint 納入 Task BUG 文字與 CI/deployment evidence；無合適 Project 時從 registry 建同 Workspace Project並避開相同 repo；任何 discovery 失敗都將 pending heartbeat 標 failed。
  - 通過：`node --import tsx sim/goalPatrol.test.ts`、`node --import tsx src/schema.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 C10（未執行 C11；未宣稱全計畫完成）
  - RED：`node --import tsx src/goalOrchestrator.test.ts` 在第二次相同選人時未回 `blocked`（舊實作會照常進 round_1）。
  - GREEN：reconciliation scoping prompt 帶入上一 revision 的失敗原因、選人與「必須改變」要求；domain 在任何寫入前比較 agentId + assignment，完全相同時直接 Blocked，coordinator 回傳 `Blocked`。
  - 通過：`node --import tsx src/goalOrchestrator.test.ts`、`node --import tsx sim/goalCoordinator.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。

- 2026-10-12 C11（未執行 C12；未宣稱全計畫完成）
  - RED：`sim/production.test.ts` 新增 policy/source assertions，舊 policy 對已指派 Goal Todo 仍回 `owner_dispatch`，且 source 含未登記 repo 的整 tick throw。
  - GREEN：已指派 Agent 的 Goal Todo 改走 `assign_member` 保留 Owner assignee；人類 assignee 的 Todo/Doing 留給人類、不啟動 member AI。gather 對 Done/Archived 不查 repo，active Goal Task 未登記時設 `repoUnavailable`、寫 warning 並只略過該 Task；其他 legacy/Goal Task 繼續排程。
  - 通過：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未完整執行：`node --import tsx sim/production.test.ts` 已通過 C11 policy/source assertions，後於既有 HTTP fixture失敗；原文 `Error: listen EPERM: operation not permitted 127.0.0.1`，未修改測試執行方式。

- 2026-10-12 Claude 沙盒外驗證修正（A1–D3 之後）
  - `src/server.test.ts:375` Agents API 期望值少了 user02（fixture 已把 user02 加進 wsA）→ 補上。
  - D2 改成固定列出六位 Agent 後，fixture 只建 user01、user02，`syncAgents` 不為不存在的帳號建 Agent → `src/server.test.ts:169` 補建 user03–06。
  - 修正後沙盒外 `npm test` exit 0（47 個測試檔 OK）、`node --import tsx sim/production.test.ts` exit 0。

- 2026-10-12 E1（14:17:32 CST 結束；未執行 E2；未宣稱全計畫完成）
  - RED：`npm test includes sim/production.test.ts` 設定斷言 exit 1；原文 `Error: npm test does not include sim/production.test.ts`。
  - GREEN：`package.json` 的 `test` script 已加入 `node --import tsx sim/production.test.ts`；相同設定斷言 exit 0。
  - 通過：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行：`node --import tsx sim/production.test.ts`（已知會因 `spawnSync ... EPERM` 失敗）；依執行規則未跑 `npm test`，避免在該測試中止。

- 2026-10-12 E2（14:26:40 CST 結束；未執行 E3；未宣稱全計畫完成）
  - RED：`node --import tsx sim/goal.integration.test.ts` exit 1；原文 `AssertionError [ERR_ASSERTION]: Goal integration 必須由 production coordinator 完成 Task，不可直接 SQL 設 Done`。
  - GREEN：整合測試改由實際 HTTP app 與 production `runOnce()` 驅動 Goal Task；member／Owner runner、verification、CI 與 acceptance 全部使用 fixture。以 commit 後 runner crash、CI checkpoint crash、completion checkpoint crash、Done 重跑分段重啟 coordinator，驗證 Contribution、Task、task commit、merge 與 child Goal 不重複。
  - 通過：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行成功：`node --import tsx sim/goal.integration.test.ts` exit 1，原文 `Error: spawnSync git EPERM`，首個受限呼叫為 `git init -b master`；未修改測試執行方式。依執行規則未跑 `npm test`。

- 2026-10-12 E3（14:34:07 CST 結束；未執行下一項；未宣稱全計畫完成）
  - RED：`npx tsx src/project.test.ts` exit 1；原文 `AssertionError [ERR_ASSERTION]: 已封存 Project 不可出現在 domain list`，actual `true`、expected `false`。
  - GREEN：`listProjects` 只回傳 active Project；補齊跨 Workspace Project PATCH 拒絕、Executing 暫停後其他 Goal 取得 lease、patrol/followup trigger_ref 隔離與 user09 本人 `@Owner` fixture。legacy sweep 繼續由已有 `repoHasGoalLease` domain 測試鎖定持 lease 時跳過。
  - 通過：`npx tsx src/project.test.ts`、`npx tsx src/task.test.ts`、`npx tsx src/goal.test.ts`、`npx tsx src/goalRun.test.ts`、`npx tsx src/comment.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`npm run typecheck`、`git diff --check` 全部 exit 0。
  - 沙盒內未執行：`node --import tsx sim/run.test.ts`（已知會因 `spawnSync ... EPERM` 失敗）；依執行規則未修改測試執行方式，也未跑 `npm test`。

- 2026-10-12 Claude 沙盒外驗證修正（E1–E3 之後）
  - E2 改寫的 `sim/goal.integration.test.ts:88` fixture 寫入 `workspaces_read_model` 不存在的 `archived_at` 欄位 → 移除該欄位。
  - 修正後沙盒外 `npm test` exit 0（48 個測試檔 OK，含新加入的 `sim/production.test.ts`）。
