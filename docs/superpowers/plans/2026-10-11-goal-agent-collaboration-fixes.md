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
   - `src/test.ts` 遇到第一個失敗就會中止，所以不要用 `npm test` 當驗收。改跑 `npm run lint`、`npm run typecheck`，再用 `node --import tsx <file>` 逐支跑其他測試檔。
8. 結束前：
   1. 跑完第 7 點的檢查。
   2. 把結果寫進文末「執行紀錄」：每支測試檔的通過／失敗，以及失敗段落原文。

## A. 阻斷級（合併前必修）

- [ ] **A1 驗收失敗後 Goal 卡死**
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

- [ ] **A2 等 lease 的 Goal 被打成 Blocked**
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

- [ ] **A3 持 lease 的 Goal 暫停不了**
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

- [ ] **A4 Blocked 恢復後死循環，恢復狀態也不對**
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

- [ ] **A5 legacy sweep 擋不住別的 workspace 持有的 lease**
  - 問題：`sim/run.ts:3311-3314` 的 lease 檢查 JOIN 了「本 workspace 的 Project」。多個情境共用同一個 repo（`sim/run.ts:393,399` 都是 `ROOT`），別的 workspace 的 Goal 持有 lease 時，這個 workspace 照樣 sweep、照樣 merge。
  - 規格：L344。
  - 修正：直接以 `repo_leases.target_repo` 比對 `scenario.repoRoot`，比對前兩邊都轉成 canonical realpath。
  - 驗收：在 `sim/run.test.ts` 加測試：workspace X 的 Goal 持有 ROOT 的 lease 時，workspace Y（repoRoot 同為 ROOT）的 sweep 會被略過。

- [ ] **A6 Project 畫面合併後無法使用**
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

- [ ] **A7 Goal 不會自己往前走，heartbeat 佇列會餓死**
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

- [ ] **B1 Agent 帳號可以做人類專屬的 Goal 操作**
  - 問題：`src/server.ts:826-938` 只要求 Member。user01–06 可以建立 `source=human` 的 Goal（藉此繞過單一自治 Goal 限制），也能取消 Goal 或解除 Blocked。
  - 規格：L169、L186、L189、L205。
  - 修正：使用者有 Agent resource 時，以下操作一律回 403：建立 `source=human` 的 Goal、cancel、從 Blocked resume、修改成功條件。
  - 驗收：`server.test.ts` 以 user01 與 user02 各打一次，都回 403；人類成員則成功。

- [ ] **B2 任一 workspace Admin 都能改全域的 Agent route**
  - 問題：`src/server.ts:957-972`。Agent 是全域資源，但只要某個 workspace 的 Admin 與該 Agent 同在一個 workspace，就能改它的 route 和狀態。
  - 規格：L106。
  - 修正：改 Agent 只限主協作工作區 `11a82028-fc50-466a-a723-e002032cd9a6` 的人類 Admin 或 Owner。
  - 驗收：其他 workspace 的 Admin 回 403。

- [ ] **B3 取消 Goal 時繞過封存檢查**
  - 問題：`src/goal.ts:354-360` 直接 append `task.archived`，繞過 `archiveTask` 的權限與 `loadEditableTask` 檢查。
  - 規格：L201。
  - 修正：改走既有的 archive command。執行者固定為 Owner Agent（user01），主工作區的規則照常適用。
  - 驗收：取消後未完成的 Task 為 Archived，event 經 archive command 產生。

- [ ] **B4 Owner Agent 仍可以建立 Workspace**
  - 問題：`src/server.ts:373-385` 的 `POST /api/workspaces` 只要有登入就能用。
  - 規格：L207、L395。
  - 修正：`role=owner` 的 Agent 帳號回 403。
  - 驗收：`server.test.ts` 以 user01 打一次回 403，以人類打回 201。

- [ ] **B5 Goal Task 被搬家後關聯錯亂**
  - 問題：
    - `src/task.ts:450-454`：Task 搬到其他 Workspace 時沒有清掉 `goal_id`。
    - `:310-315` 的 `changeTaskProject` 允許把 Goal Task 改到別的 Project。
  - 規格：L437-438。
  - 修正：有 `goal_id` 的 Task 不准搬 Workspace，也不准換 Project，一律回 400。
  - 驗收：兩種操作各一個測試。

- [ ] **B6 選人不是原子操作**
  - 問題：`src/goalOrchestrator.ts:56-64`。名單中只要有一位不合格，前面的 Participation 與 heartbeat 已經寫入，重送時會撞「Participation 已存在」。
  - 規格：L209。
  - 修正：整批放進同一個 transaction；同一 revision 用同一份名單重送時是冪等的。
  - 驗收：含一位不合格者的名單 → 不留任何 Participation；同一份名單重送兩次 → 成功，資料不重複。

- [ ] **B7 follow-up Goal 繞過檢查**
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

- [ ] **B8 `createGoal` 沒有完整驗證輸入**
  - 問題：
    - `src/goal.ts:201` 接受任意 `ownerAgentId`，沒檢查必須是 `role=owner`。
    - `src/goal.ts:193-197` 只檢查 `target_repo` 非 null，沒有重新確認它仍在 registry 裡。
    - `src/goal.ts:339-348` 允許 Queued → Blocked，但規格的轉移表沒有這一列。
  - 規格：L108、L183、L348。
  - 修正：補上前兩項驗證；拿掉 Queued → Blocked。
  - 驗收：三個負向測試。

## C. 規格要求但未實作

- [ ] **C1 人類 Goal 插隊**
  - 問題：全 repo 沒有插隊相關邏輯，lease 是先到先得。
  - 規格：L179-182、L383-385。
  - 修正：同一 target repo 建立人類 Goal 時：
    - 尚未取得 lease 的自治 Goal 回到 Queued。
    - 持有 lease 的自治 Goal 在下一個安全 checkpoint 進 Paused（沿用 A3 的暫停請求機制），並釋放 lease。
    - 插隊的人類 Goal 進入 Done、Cancelled 或 Blocked 時，被暫停的自治 Goal 依轉移表恢復。
    - 持有 lease 的 Blocked Goal 不得被插隊搶走。
  - 驗收：四種情境各一個測試。

- [ ] **C2 修改成功條件或資料範圍、產生新 revision**
  - 問題：沒有呼叫 `reviseGoal` 的 API 或 UI；「資料範圍」欄位沒有建模。
  - 規格：L70-89、L185、L420。
  - 修正：
    - Goal 加資料範圍欄位。
    - 新增 `PATCH /api/goals/:id`，一次只改一個欄位，符合 AGENTS.md。限人類操作，見 B1。
    - Executing／Verifying 修改後回到 `owner_synthesis`，revision +1，lease 不釋放。
  - 驗收：domain 與 server 測試。

- [ ] **C3 Task 卡住時 Goal 沒有反應，也沒有通知**
  - 問題：
    - 找不到任何 `task.blocked` 處理。Task 卡住時，Goal 永遠停在等待 Task 的狀態。
    - 進入 Blocked 時不通知人類。
  - 規格：L184、L318、L359。
  - 修正：
    - coordinator 收到 `task.blocked` 時，觸發 Owner reconciliation：可以改派、拆分，或將 Goal 轉 Blocked。
    - Goal 進入 Blocked 時，用既有通知機制通知該 Workspace 的人類 Admin。
  - 驗收：用 fake Owner 測兩條路徑（改派成功、轉 Blocked），並斷言通知已建立。

- [ ] **C4 交付證據只回送一部分**
  - 問題：
    - `sim/production.ts:1493-1503` 與 `src/deliveryEvidence.ts:5` 只在部署成功後回送證據。
    - `task.execution_started`、`commit.recorded`、`task.blocked` 都沒有回送；CI 失敗不留任何證據。
  - 規格：L359。
  - 修正：在對應的 checkpoint 回送；CI 失敗時以失敗結果記錄 `ci.checked`。
  - 驗收：`sim/production.test.ts` 斷言各事件依序寫入。

- [ ] **C5 用量紀錄缺漏**
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

- [ ] **C6 Adapter 契約沒有接上 production**
  - 問題：
    - `sim/goalAdapters.ts` 只有測試在用，違反規格 L515「不得預先加入未使用的 abstraction」。
    - production 的 fallback 判斷是自寫的 git fingerprint（`sim/production.ts:1305-1323`）。
    - AGY 輸出空白（soft-denial）只變成「無 JSON」錯誤，沒有分類成 permission（`sim/production/runner.ts:316-330`）。
    - fallback 沒擋住「AGY 換另一個 AGY 模型重試」。
    - `AgentRunResult` 缺 exit status 欄位。
  - 規格：L267-301、L320。
  - 修正：production 實作階段的 runner 改用 `goalAdapters` 的 `classifyAdapterResult` 與 `executeWithSingleFallback`，並補上 preflight 與 exit status。接完後確認沒有剩下未使用的 export。
  - 驗收：Claude、Codex、AGY 三種 adapter 的 fixture 涵蓋 command 與 cwd、timeout、quota、stderr、soft-denial 的分類。

- [ ] **C7 選人過濾不完整**
  - 問題：
    - `src/goalOrchestrator.ts:52-54`、`src/agent.ts:136` 只過濾成員資格與 active。
    - 沒有排除缺 repo 權限、`skill_profile` 不符、已有不可並行工作的 Agent。
    - Agent 沒有「可存取 repo」欄位；`selectedLoad` 由呼叫端傳入，不是系統計算。
  - 規格：L98、L209。
  - 修正：補上可存取 repo 欄位與三種排除；`selectedLoad` 改由系統依進行中的 Participation 與 Task 計算。
  - 驗收：三種排除各一個測試。

- [ ] **C8 Owner 與討論的 context 不完整也不安全**
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

- [ ] **C9 巡檢判斷有誤**
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

- [ ] **C10 reconciliation 沒有要求調整**
  - 問題：`src/goalOrchestrator.ts:160-169`、`sim/goalCoordinator.ts:131-141` 用同一份 prompt 重跑 owner_scoping，沒有要求也沒有驗證人選或面向必須改變。
  - 規格：L221、L318。
  - 修正：reconciliation 的 prompt 帶入上一輪的失敗原因；結果與上一輪完全相同時直接進 Blocked。
  - 驗收：fake Owner 回傳相同名單 → Blocked。

- [ ] **C11 production 覆寫了 Owner 的指派**
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

- [ ] **C12 規格的資料欄位尚未補齊**
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

- [ ] **D1 Goal 詳情頁**
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

- [ ] **D2 Agents 頁**
  - 問題：`public/js/views/agents.js:99-138`、`src/agent.ts:111-133`。
    - 缺最近的 preflight 與 Run、fallback 次數、未知 usage 次數。
    - 只列出目前 workspace 成員中的 Agent。
  - 規格：L432-435。
  - 修正：補上缺的欄位，固定列出 user01–06 這六位 Agent。
  - 驗收：前端與 server 測試。

- [ ] **D3 Project context 與建立 Task**
  - 問題：Project context 沒有進度（`kanban.js:350-356`）；建立 Task 的表單沒有顯示 Project，只隱含使用目前的篩選值（`:240-256`）。
  - 規格：L415、L420。
  - 修正：兩點都補上。
  - 驗收：前端測試。

## E. 測試補齊

- [ ] **E1** `sim/production.test.ts` 加進 `npm test`。
- [ ] **E2** `sim/goal.integration.test.ts` 改成走 production coordinator，搭配 fake runner 與 CI fixture，不再直接用 SQL 把 Task 設成 Done。逐個 checkpoint 模擬崩潰並重跑（規格 L478-488）。
- [ ] **E3** 規格 L449-469 中只做了一部分的 Domain 測試：
  - Project 已封存時 domain 會隱藏它。
  - 修改 Task 為跨 Workspace 的 Project 時被拒絕。
  - 從 Executing 暫停後，其他 Goal 可以取得 lease。
  - trigger_ref 的 patrol 與 followup 不會互相吞掉。
  - legacy sweep 不會在 lease 被持有的 repo 執行 merge。
  - `@Owner` 的測試改用 user09 本人。

## 人工步驟（不由執行者處理）

- **H1** 建立 repo registry JSON（格式見 `docs/operations.md`「Goal-driven collaboration」）。正式的 `task-tracker.service` 是 system unit，自動部署不會重裝它，所以要用 sudo 補上 `TASK_TRACKER_REPO_REGISTRY_PATH` 與 `EnvironmentFile`，然後 daemon-reload。
- **H2** 建立 `~/.config/task-tracker/coordinator.env`（內容為 `TASK_TRACKER_COORDINATOR_TOKEN`）。
- **H3** Claude review 工作目錄裡未 commit 的改動，人類確認後才 commit。merge 到 master 是另一個獨立步驟，merge 就會觸發自動部署。
- **H4** 合併並觀察一段時間後，再決定是否安裝 `goal-coordinator.timer` 與 `goal-discovery.timer`。

## 執行紀錄

（執行者在這裡填寫：開始與結束時間、各項結果、最後一次 `npm test` 的結果）
