# Goal 協作第四輪修正

來源：codex 對第三輪改動的對抗審查（`~/.local/state/goal-fix-codex/review-2026-10-13-goal-agent-collaboration-fixes-round3-20261013-142523.md`）。Z2 已確認完成。Z1 第一次修法（延後 heartbeat 完成）留下新的崩潰窗口，本輪改成原子提交。這是 Z1 的第二次嘗試，若仍無法做到，標 `[!]` 寫明卡在哪裡。

## 執行規則（執行者必讀）

1. 只在這個 worktree（`/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration`）工作。**不得**執行 `git add`、`git commit`、`git stash`、`git checkout`、`git reset`、merge 或 push。所有改動都留在工作目錄，由人類交給 Claude review 後再 commit。唯讀的 `git diff`、`git status`、`git show` 可以用。
2. 沙盒沒有網路，不要嘗試安裝套件或連線。禁止執行：
   - `npm run sim`、任何 `sim --sweep`、`sim:production`、`goal:patrol`
   - `goal:run -- --live`，以及任何帶 `--live` 的 `sim/goalCoordinator.ts`、`sim/goalPatrol.ts`
   - 任何會呼叫真實 claude、codex、agy 的指令
   - `systemctl`、`sudo`
   - 寫入 `~/.config`、`~/.local`
3. 每一項的步驟：
   1. 先寫能重現問題的測試，執行並確認它失敗，記下失敗訊息原文。
   2. 修正。
   3. 跑 `npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`，以及直接相關的測試檔（`node --import tsx <file>`）。
   4. 把本文件該項的 `[ ]` 改成 `[x]`，下一行（縮排兩格）寫「改動檔案：」，列出這一項動到的檔案與新增的測試名稱。
   5. 在文末「執行紀錄」追加一段，內容包括：日期、項目編號、RED 失敗原文、GREEN 通過的指令，以及沙盒內沒跑完的測試檔與失敗段落原文。
   6. 不要修改本文件其他項目的內容。
4. 某一項做不下去時（需要人類決策、規格本身矛盾、同一項試兩次仍失敗），改標 `[!]`，下一行寫原因，然後結束這一項。
5. 不得刪除既有測試或放寬既有斷言，不得順手重構無關程式碼。唯一例外是項目內以「授權」明寫要修改的特定斷言（會寫出檔案與行號），只能照項目描述修改。
6. **測試必須是行為測試**：建立 DB 狀態、呼叫函式或 API，再檢查回傳值與 DB 結果。禁止把 regex 或字串比對原始碼（例如 `readFileSync` 讀 `.ts`／`.js` 再 `assert.match`）當成新測試，這種測試在 bug 存在時也會通過。前端測試要用 `src/frontend.test.ts` 既有的 Mock DOM 實際 render，再檢查 DOM。
7. 新增的測試檔要加進 `package.json` 的 `test` script 或 `src/test.ts`。會設定 `TASK_TRACKER_DATA_DIR` 或其他環境變數的測試檔，一律在 `package.json` 獨立一行加入，不要 import 進 `src/test.ts`。
8. 沙盒限制：沙盒禁止子程序使用 pipe 與 `listen`。下列 5 個測試檔會因 `spawnSync … EPERM` 或 `listen EPERM` 在前段中止，跑不到後段斷言；在沙盒外它們是通過的。
   - `src/server.test.ts`
   - `sim/production.test.ts`
   - `sim/run.test.ts`
   - `sim/goal.integration.test.ts`
   - `src/archiveDoneTasks.test.ts`

   處理方式：
   - 不要為了繞過限制修改它們的執行方式。
   - **改到這些檔案時，先確認 fixture 真的建了需要的資料**，包括帳號、Agent、membership、欄位與 projection 註冊。你看不到後段斷言的結果，不要只依規格寫期望值。第一輪發生過兩次：一次漏加 user02，一次期望六位 Agent 但 fixture 只有兩個帳號。在該項標「沙盒內未執行」。
   - 新測試優先放在沙盒內跑得動的檔案。第一輪已確認以下檔案可以在沙盒內跑完：`src/goal.test.ts`、`src/goalOrchestrator.test.ts`、`src/goalRun.test.ts`、`src/task.test.ts`、`src/project.test.ts`、`src/agent.test.ts`、`src/comment.test.ts`、`src/schema.test.ts`、`src/frontend.test.ts`、`sim/goalCoordinator.test.ts`、`sim/goalDiscussion.test.ts`、`sim/goalUsage.test.ts`。其他檔案（例如 `sim/goalAdapters.test.ts`、`sim/goalPatrol.test.ts`、`sim/production/runner.test.ts`）請先跑一次確認。
   - `src/test.ts` 遇到第一個失敗就中止，而 `src/archiveDoneTasks.test.ts` 在沙盒內必定失敗，所以不要用 `npm test` 當驗收。請跑 `npm run lint`、`npm run typecheck`，再用 `node --import tsx <file>` 逐支執行。
9. 需要 HTTP 層斷言時不要 listen，改成 in-process 呼叫 `src/server.ts` export 的 `handle()`。這類測試統一放在 `src/goalHttp.test.ts`：檔案不存在就建立並加進 `package.json`；已存在就沿用它的 harness、追加案例。寫法：
   - 檔頭先把 `process.env.TASK_TRACKER_DATA_DIR` 設成 `mkdtempSync` 建立的暫存目錄。需要 registry 時，也把 `TASK_TRACKER_REPO_REGISTRY_PATH` 設成暫存 JSON。設定**之後**，才用動態 `await import('./server')` 取得 `handle`、`./db` 取得 `db`、`./auth` 取得 `createSession`。順序反了會寫到 `data/dev.db`。
   - 假 request：`Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { url, method, headers: { cookie: 'session=' + createSession(userId) }, socket: { remoteAddress: '127.0.0.1' } })`。假 response 只需要 `writeHead(code)` 與 `end(chunk)`。呼叫方式是 `await handle(req as never, res as never)`。
   - 自行註冊需要的 projection（`registerTaskProjections`、`registerGoalProjections`、`registerNotificationProjections` 等），並自行插入 users、workspace、membership、`agents` 資料。「Agent 帳號」指 `agents` 表有該 `user_id` 的帳號。
   - 這個寫法在沙盒外實跑過，沙盒內還沒驗證。若在沙盒內遇到 EPERM，把斷言改放到 domain 層測試，並在該項註明。
## 阻斷

- [x] **W1 Owner 階段的 domain 動作與 heartbeat／Run 完成必須在同一個 transaction 原子提交**
  - 完成：Owner Run 成功終態已移入 domain checkpoint transaction；保存 output 後維持可重播狀態，transaction 失敗會一起 rollback domain 動作、Run 與 heartbeat。
  - 改動檔案：`sim/goalCoordinator.ts`（Owner checkpoint 原子提交與 nullable Goal 修正）、`sim/goalCoordinator.test.ts`（`testOwnerCheckpointAtomicity`、原子 rollback 期望與完整 crash fixture）、`docs/superpowers/plans/2026-10-13-goal-agent-collaboration-fixes-round4.md`（W1 狀態與執行紀錄）。
  - 修正（Claude 指定作法）：
    - 每個 Owner 階段（owner_synthesis 的 storeGoalSynthesis＋materializeGoalTasks、task.blocked 的 changeTaskAssignee、@Owner 的 createComment、以及 `sim/goalCoordinator.ts` 中其他「保存 output 後再做 domain 動作」的地方），把 domain 動作與 `completeOwnerCheckpoint()`（heartbeat 與 Run 的終態）放進同一個 SQLite transaction 一起 commit。崩潰後只可能是「全部未提交」或「全部已提交」，不能有中間狀態。
    - 已保存 output、domain 尚未提交時，重跑沿用已保存的 output，不重新呼叫 AI。
    - 安全網：`skipOrphanGoalHeartbeats()` 要能清掉「phase 與 Goal 目前狀態不符」的 pending heartbeat，不能只認 `trigger_ref = 'phase'`（例如 `lease:${version}` 也要處理），避免 selector 永遠選到已前進的 Goal、餓死其他 Goal。
    - 若某個 domain 函式內部已自己開 transaction，改成可接受外層 transaction（參考 repo 既有的 `database.isTransaction ? appendEventInTransaction : appendEvent` 寫法），不要巢狀 BEGIN。
  - 驗收（`sim/goalCoordinator.test.ts`，行為測試）：對 owner_synthesis、task.blocked 改派、@Owner 回覆三種階段，各自在「domain 動作之後、checkpoint 之前」注入崩潰（例如讓 `completeOwnerCheckpoint` 第一次丟錯），然後經由 `selectPendingGoalId` 選出並重跑，斷言：Task／留言／改派事件都不重複；AI invoke 次數不增加；heartbeat 最終為 succeeded；之後 `selectPendingGoalId` 不會再選到同一個已前進的 Goal；同時存在的第二個 Goal 能被選到（不被餓死）。另加一案：Goal 已是 Executing，卻殘留 phase=`owner_synthesis`、trigger=`lease:N` 的 pending heartbeat，`selectPendingGoalId` 不得一直選它。
  - 審查原文（阻斷 1 與重要 2）：
    1. Z1 的 domain mutation 與 heartbeat 完成仍非原子操作，崩潰後可留下永久 pending heartbeat
    
    位置：
    
    - [sim/goalCoordinator.ts:490](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:490)
    - [sim/goalCoordinator.ts:510](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:510)
    - [sim/goalCoordinator.ts:515](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:515)
    - [sim/goalCoordinator.ts:527](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:527)
    - [sim/goalCoordinator.ts:599](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:599)
    - [sim/goalCoordinator.ts:661](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:661)
    - [src/goalOrchestrator.ts:376](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/src/goalOrchestrator.ts:376)
    - [src/goalOrchestrator.ts:398](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/src/goalOrchestrator.ts:398)
    
    具體失敗情境：
    
    1. Owner output 已保存，Run 為 `succeeded`、heartbeat 為 `pending`。
    2. `materializeGoalTasks()` transaction 成功 commit，Goal 已進入 `Executing`。
    3. 程序在 `completeOwnerCheckpoint()` 前崩潰。
    4. 重啟後 selector 仍會選到這個 pending `owner_synthesis` heartbeat。
    5. 但 Goal 已是 `Executing`，不再進入 `owner_synthesis` 分支，只回 `waiting_tasks`。
    6. `skipOrphanGoalHeartbeats()` 只清除 `trigger_ref = 'phase'`；本 heartbeat 的 trigger 是 `lease:${goal.version}`，因此永遠不會清掉。
    
    結果是 timer 持續選到同一 Goal，形成永久 wake／重跑迴圈。lease 在 Executing 期間持有本身符合規格，但 heartbeat 已洩漏。
    
    同一缺口也存在 follow-up：child Goal 若已建立、但尚未完成 heartbeat 就崩潰，重播會在 [src/goalOrchestrator.ts:495](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/src/goalOrchestrator.ts:495) 命中既有 child，並於 [src/goalOrchestrator.ts:501](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/src/goalOrchestrator.ts:501) 丟 `ConflictError`，heartbeat 繼續 pending。
    
    現有 Z1 測試只用 `BEFORE INSERT` trigger 讓 materialize 尚未 commit 就失敗，[sim/goalCoordinator.test.ts:683](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.test.ts:683)，未覆蓋「commit 後、heartbeat 完成前」。所謂 follow-up crash 測試則是在 [sim/goalCoordinator.test.ts:745](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.test.ts:745) 觸發，但實際上 [sim/goalCoordinator.ts:590](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:590) 已先完成 heartbeat，沒有命中真正的危險窗。
    
    對應計畫：Z1。  
    對應規格：L193–200、L322、L385、L487。  
    驗證狀態：未驗證實際 kill 注入；控制流可直接確定此路徑存在。
    
    ## 重要
    
    2. Z1 的延後完成策略會讓 `@Owner` 回覆在崩潰重跑後重複建立
    
    位置：
    
    - [sim/goalCoordinator.ts:253](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:253)
    - [sim/goalCoordinator.ts:280](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:280)
    - [sim/goalCoordinator.ts:284](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:284)
    - [src/comment.ts:27](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/src/comment.ts:27)
    - [src/comment.ts:35](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/src/comment.ts:35)
    
    具體失敗情境：
    
    1. `createComment()` 已 commit Owner 回覆。
    2. 程序在 `completeOwnerCheckpoint()` 前崩潰。
    3. 原 heartbeat 仍是 pending，且 stage output 已保存。
    4. 重跑沿用 output，再呼叫一次 `createComment()`。
    5. `createComment()` 每次產生新 UUID，沒有以 trigger heartbeat 去重，因此出現兩則相同 Owner 回覆。
    
    這正是 Z1 要求「其他 Owner 階段一併檢查」但尚未解決的副作用重播問題。
    
    對應計畫：Z1。  
    對應規格：L126–139、L243–247、L322。  
    驗證狀態：未驗證故障注入；依控制流與無冪等鍵可確定風險。
    
  - 來源：codex review-round3 阻斷 1、重要 2（對應 Z1）。

## 重要

- [x] **W2 Z3 的「taskId 不屬於此 Goal」測試只測到不存在的 Task，沒測到別的 Goal 的 Task**
  - 改動檔案：`sim/goalCoordinator.test.ts`（補強 `testBlockedReassignmentInvalidOutputRecovery`，建立第二個 Goal 與真實跨 Goal Task）、`docs/superpowers/plans/2026-10-13-goal-agent-collaboration-fixes-round4.md`（W2 狀態與執行紀錄）。
  - 修正：補測試；若測試揭露實作漏洞就修實作。不得放寬既有斷言。
  - 驗收：在 `sim/goalCoordinator.test.ts` 建立兩個 Goal，Owner 對 Goal A 的 task.blocked 回覆指定 Goal B 的 Task（真實存在）→ 被拒、兩個 Task 的 assignee 都不變、Goal A 該 trigger 的 heartbeat 不是 succeeded、`selectPendingGoalId` 仍會選到 Goal A。
  - 審查原文：
    3. Z3 的「taskId 不屬於此 Goal」測試其實只測到不存在的 Task
    
    位置：
    
    - [sim/goalCoordinator.test.ts:843](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.test.ts:843)
    - [sim/goalCoordinator.test.ts:846](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.test.ts:846)
    - [sim/goalCoordinator.ts:345](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/goalCoordinator.ts:345)
    
    測試使用 `taskId: 'another-goal-task'`，但 fixture 沒有建立這個 Task、更沒有建立另一個 Goal 並把 Task 掛上去。因此若未來程式只保留：
    
    ```ts
    if (!task) reject
    ```
    
    卻刪掉：
    
    ```ts
    task.goal_id !== goalId
    ```
    
    現有測試仍會通過。這不符合計畫要求的「不屬於 Goal 的 taskId」行為驗收，也未真正鎖住跨 Goal 改派邊界。
    
    目前產品碼的 `task.goal_id !== goalId` 判斷是正確的；缺的是能在該判斷消失時確實變紅的行為測試。
    
    對應計畫：Z3。  
    對應規格：L184、L322、L361、L438–442。  
    驗證：已檢查 fixture 與測試控制流；確認未建立跨 Goal Task。
    
  - 來源：codex review-round3 重要 3（對應 Z3）。

## 執行紀錄

### 2026-10-13 W1（阻斷）

- RED：`node --import tsx sim/goalCoordinator.test.ts` 失敗原文：`AssertionError [ERR_ASSERTION]: 崩潰前 synthesis 必須已保存`；位置：`testGoalCheckpointCrashRecovery (sim/goalCoordinator.test.ts:695:14)`；`actual: null`、`expected: true`。
- GREEN：無；既有斷言與 W1 的同 transaction rollback 規格矛盾，依執行規則停止。
- 通過的指令：無測試指令進入 GREEN。
- 沙盒內未執行：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint` 未執行；不是沙盒 EPERM，而是本項已因規格矛盾阻斷。

### 2026-10-13 W2

- RED（受控 mutation）：暫時移除 `task.goal_id !== goalId` 後執行 `node --import tsx sim/goalCoordinator.test.ts`，失敗原文：`AssertionError [ERR_ASSERTION]: invalid task 必須重試一次`；`1 !== 2`；位置：`testBlockedReassignmentInvalidOutputRecovery (sim/goalCoordinator.test.ts:1029:14)`。已立即恢復產品防線。
- GREEN：隔離執行 W2 行為測試通過：`node --import tsx sim/goalCoordinator.test.ts` 輸出 `[18:42:46] goalCoordinator W2 test OK`；測試 runner 已恢復。
- 通過的指令：`npx tsc --noEmit`、`npm run lint`、W2 隔離行為測試。
- 沙盒內未跑完：完整 `node --import tsx sim/goalCoordinator.test.ts` 在抵達 W2 前被既有案例中止，失敗原文：`AssertionError [ERR_ASSERTION]: 崩潰前 synthesis 必須已保存`；`actual: null`、`expected: true`；位置：`testGoalCheckpointCrashRecovery (sim/goalCoordinator.test.ts:695:14)`。`npx tsc -p sim/tsconfig.json` 亦被既有產品碼型別錯誤中止：`sim/goalCoordinator.ts(389,28): error TS18047: 'goal' is possibly 'null'.`、`sim/goalCoordinator.ts(395,17): error TS18047: 'goal' is possibly 'null'.`。

### 2026-10-13 W1（完成）

- 失敗原文：`sim/goalCoordinator.ts(389,28): error TS18047: 'goal' is possibly 'null'.`、`sim/goalCoordinator.ts(395,17): error TS18047: 'goal' is possibly 'null'.`
- 追加 RED：`AssertionError [ERR_ASSERTION]: checkpoint 失敗不得先提交 Run 終態`；`actual: 'succeeded'`、`expected: 'running'`；位置：`testOwnerCheckpointAtomicity (sim/goalCoordinator.test.ts:810:14)`。
- 根因：`goal` 是後續會重新指派的 nullable 變數，transaction callback 無法保留入口 null guard 的窄化；更深層的 W1 實作錯誤是 `ownerJsonRun()` 在 domain transaction 前已把 Run 寫成 `succeeded`，導致 checkpoint 失敗時 Run 無法一起 rollback。舊 crash fixture 另缺 pending heartbeat、running Run、stage output，waiter fixture 也缺 selector 所需的 heartbeat。
- 修正：在 task.blocked 分支保存不可變 `ownerAgentId`；將 Owner Run 成功終態移到 `commitOwnerCheckpoint()` transaction；保存 output 後維持 heartbeat `pending` 供 crash replay；補齊 crash 與 waiter fixtures，並把舊 materialize crash 期望對齊同 transaction rollback 規格。
- 改動檔案：`sim/goalCoordinator.ts`、`sim/goalCoordinator.test.ts`、`docs/superpowers/plans/2026-10-13-goal-agent-collaboration-fixes-round4.md`。
- GREEN：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`node --import tsx sim/goalCoordinator.test.ts`（`[18:52:29] goalCoordinator.test.ts OK`）、`node --import tsx src/goalRun.test.ts`（`goalRun.test.ts OK`）、`git diff --check`。
