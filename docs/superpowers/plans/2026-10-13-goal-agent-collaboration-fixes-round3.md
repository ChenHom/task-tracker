# Goal 協作第三輪修正

來源：codex 對第二輪改動的對抗審查（`~/.local/state/goal-fix-codex/review-round2-20261013-133856.md`），Claude 已讀碼確認 Z2 與 Z1 的控制流。基準：第一、二輪未 commit 的改動。Z1 與 Z3 同一根因：heartbeat 在 domain 動作完成前就變成終態。

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

- [x] **Z1 Owner output 先把 heartbeat 標成 succeeded，之後崩潰會讓 Goal 永遠不再被選到、lease 洩漏**
  改動檔案：`src/goalRun.ts`、`sim/goalCoordinator.ts`、`sim/goalCoordinator.test.ts`；新增／加嚴測試：`testGoalCheckpointCrashRecovery` 的 materialize checkpoint 崩潰後 selector 重跑、output 重用、Task 去重與 lease 保留斷言。
  - 問題：`src/goalRun.ts:255` 的 `finishRun` 在 `ownerJsonRun` 保存 output 時就把 heartbeat 改成 `succeeded`；`sim/goalCoordinator.ts:442-461` 之後才 `storeGoalSynthesis`、`materializeGoalTasks`。情境：Goal 持有 lease 在 `owner_synthesis`，output 已保存、heartbeat 已 succeeded，接著在 materialize 前後崩潰或 SQLite 寫入失敗 → Goal 停在 `owner_synthesis` 並持有 lease，但 `selectPendingGoalId()` 只選 pending heartbeat，timer 永遠不再選到它；同 repo 其他 Goal 永久 `awaiting_lease`。`sim/goalCoordinator.ts:595` 的其他 owner 階段同樣有此順序問題，一併檢查。
  - 規格：L193-200（lease 生命週期）、L322（崩潰後重新領取）、L385（等待 lease 不得阻塞持有者）、L487（每個 checkpoint 崩潰重跑）。
  - 修正：heartbeat 不得在該階段的 domain checkpoint（storeGoalSynthesis＋materializeGoalTasks 等）完成前變成終態；或保存「output 已完成、domain 動作待套用」的 durable 狀態，讓 selector 仍會選回這個 Goal，重跑時沿用已保存的 output，不重呼叫 AI、不重複建立 Task。
  - 驗收：`sim/goalCoordinator.test.ts`：讓 materialize 第一次丟錯（模擬崩潰）後，先斷言 `selectPendingGoalId(database) === goalId`，再用 selector 選出的 id 重跑，斷言 Task 數量不重複、AI invoke 次數不增加、Goal 前進到下一階段、lease 仍由該 Goal 持有直到正常釋放。同時把 `sim/goalCoordinator.test.ts:692-696` 既有崩潰測試改成經由 `selectPendingGoalId` 重跑（這是加嚴，不是放寬）。
  - 來源：codex review-round2 阻斷 1（對應 X4、Y21）。

- [x] **Z2 Agent 可用 DELETE 刪除 Goal Task，繞過 Y5 的封存防線與交付證據**
  改動檔案：`src/task.ts`、`src/task.test.ts`、`src/goalHttp.test.ts`；新增測試：domain 層 Goal Task DELETE 拒絕且不寫入 event、HTTP 層 Agent／人類 DELETE Goal Task 皆回 400 且 Task 保留、非 Goal Task DELETE 回歸案例。
  - 問題：`src/server.ts` 的 `DELETE /api/tasks/:id`（約 :636-650）只檢查 `requirePermission(mutateTask)`，沒有 `requireHumanGoalActor`；`src/task.ts:385` 的 `deleteTask` 沒有 Goal Task 守門，projection 直接從 `tasks_read_model` 刪除。情境：Agent（Workspace Member）刪光 Goal Task → coordinator 與交付證據驗證迭代空陣列 → Owner 回 `passed:true` 加任意 evidenceRefs，Goal 就完成。
  - 規格：L201（Cancelled 走 archive）、L361-363（必要 Task 與交付證據）、L438（寫入權限邊界）、L445（archive 優先並保留歷史與 evidence）。
  - 修正：在 domain 層 `deleteTask` 拒絕 Goal Task（`task.goal_id` 非 null 時丟 `CommandError('Goal Task 不可刪除，請改用封存')`，對所有帳號一律適用；HTTP 回 400）。Goal Task 只能走正式 archive 流程。
  - 驗收：`src/goalHttp.test.ts`（in-process `handle()`）：Agent 與人類各對 Goal Task 呼叫 `DELETE /api/tasks/:id` → 400，Task 仍存在於 `tasks_read_model`；對非 Goal Task 的 DELETE 行為不變（沿用既有斷言）。`src/task.test.ts` 加 domain 測試：`deleteTask` 對 Goal Task 丟錯且沒有寫入 event。
  - 來源：codex review-round2 阻斷 2（對應 Y5）。

## 重要

- [x] **Z3 task.blocked 的 Owner 回覆指定不合法 assignee 時，blocker 被永久標成已處理，Goal 再度卡死**
  改動檔案：`sim/goalCoordinator.ts`、`sim/goalCoordinator.test.ts`；新增測試：`testBlockedReassignmentInvalidOutputRecovery` 的不合法 assignee／不屬於 Goal 的 taskId 拒絕、Task 未提前改派、原 trigger heartbeat 未 succeeded、selector 仍選回 Goal、合法 retry 改派與 heartbeat succeeded 斷言。
  - 問題：`sim/goalCoordinator.ts:321-332` 的 output validator 只確認 `assigneeId` 是字串；`ownerJsonRun` 先把 heartbeat 標成 succeeded，之後 `changeTaskAssignee`（`src/task.ts:305`）才檢查 active membership 並丟錯。情境：production 寫入 `task.blocked` evidence → Owner 回 `{"action":"reassign","taskId":"…","assigneeId":"已離開或拼錯的帳號"}` → heartbeat 已 succeeded、改派失敗 → 同一 trigger 已有 succeeded heartbeat，不再處理；Task 未改派、Goal 仍為 Executing，也沒有 pending heartbeat。
  - 規格：L184（blocked reconciliation）、L322（崩潰或不確定結果處理）、L361（權威 task.blocked 事件）。
  - 修正：保存 output 前，validator 就驗證 `assigneeId` 是該 Workspace 的 active member 且 `taskId` 屬於此 Goal；不合法時走 X6 已建立的 invalid output 處理（可重試、超過次數 Blocked 並通知），不得讓 heartbeat 變成 succeeded。並沿用 Z1 的作法，讓 heartbeat 終態與改派落在同一 checkpoint。
  - 驗收：`sim/goalCoordinator.test.ts`：Owner 第一次回不合法 assignee → 斷言 Task assignee 未變、該 trigger 的 heartbeat 不是 succeeded、`selectPendingGoalId` 仍會選到這個 Goal；第二次回合法 assignee → Task 改派成功、heartbeat succeeded。另加一案：不合法 taskId 同樣被拒。
  - 來源：codex review-round2 重要 3（對應 Y11、Y21）。

## 執行紀錄

### 2026-10-13 Z1

- RED：`AssertionError [ERR_ASSERTION]: domain checkpoint 失敗後 selector 必須重新選到同一 Goal`；`actual: undefined`，`expected: 'fb0dc5bd-0ec4-4422-a215-bc4b716201e7'`。
- GREEN：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`node --import tsx sim/goalCoordinator.test.ts`、`node --import tsx src/goalRun.test.ts`、`git diff --check -- src/goalRun.ts sim/goalCoordinator.ts sim/goalCoordinator.test.ts` 均通過。
- 沙盒內未執行／未跑完：無；本項直接相關測試均在沙盒內跑完。

### 2026-10-13 Z2

- RED：`AssertionError [ERR_ASSERTION]: Missing expected exception (CommandError).`；HTTP 層為 `AssertionError [ERR_ASSERTION]: Agent 刪除 Goal Task 應回 400`，`200 !== 400`。
- GREEN：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`node --import tsx src/task.test.ts`、`node --import tsx src/goalHttp.test.ts` 均通過。
- 沙盒內未執行／未跑完：無；本項直接相關測試均在沙盒內跑完。

### 2026-10-13 Z3

- RED：`CommandError: assignee 必須是 workspace active member`；堆疊停在 `changeTaskAssignee`，證明不合法 assignee 通過 output validator 後才失敗。
- GREEN：`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`、`node --import tsx sim/goalCoordinator.test.ts`、`git diff --check -- sim/goalCoordinator.ts sim/goalCoordinator.test.ts` 均通過。
- 沙盒內未執行／未跑完：無；本項直接相關測試均在沙盒內跑完。
