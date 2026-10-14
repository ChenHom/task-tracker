# Goal 協作第五輪修正

來源：codex 對第四輪的審查（`~/.local/state/goal-fix-codex/review-2026-10-13-goal-agent-collaboration-fixes-round4-20261013-183800.md`）。W2 已確認完成；W1 產品碼正確（`createFollowupGoal()` 已在 `commitOwnerCheckpoint()` callback 內），只缺能讓回歸變紅的測試。本輪只補測試，**不改產品碼**，除非新測試揭露真的 bug。

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
## 重要

- [x] **V1 補上 follow-up Goal 在 checkpoint commit 前失敗的 rollback 行為測試**
  改動檔案：`sim/goalCoordinator.test.ts`（擴充 `testGoalCheckpointCrashRecovery` 的 follow-up checkpoint rollback／selector retry 行為測試）、`docs/superpowers/plans/2026-10-14-goal-agent-collaboration-fixes-round5.md`（V1 狀態與執行紀錄）
  - 問題：`sim/goalCoordinator.test.ts:722`、`:744` 的現有測試，是在 child Goal 已存在、整個 `commitOwnerCheckpoint()` 已完成後才丟錯，測到的是「commit 後崩潰」。若將來 `createFollowupGoal()` 被移到 checkpoint transaction 外（`sim/goalCoordinator.ts:625` 附近），child Goal 先 commit、heartbeat 未完成時崩潰，重跑會重複建立 child 或丟 `ConflictError` 並留下 pending heartbeat，而現有測試仍會通過。
  - 規格：L322（崩潰恢復）、L387（只建立一個 child Goal）、L487（每個 checkpoint 模擬崩潰）。
  - 修正：只補測試。
  - 驗收（`sim/goalCoordinator.test.ts`，行為測試）：讓失敗發生在「`createFollowupGoal()` 已在 transaction 內建立 child 之後、`commitOwnerCheckpoint()` commit 之前」（例如讓 checkpoint 內 heartbeat／Run 終態寫入第一次丟錯，或在 callback 最後丟錯），斷言：
    - transaction 整個 rollback：child Goal 不存在、parent 的 heartbeat 仍為 pending、Run 不是 succeeded。
    - 經由 `selectPendingGoalId` 選出並重跑：AI invoke 次數不增加（沿用已保存的 output）、最後只有一個 child Goal、heartbeat 為 succeeded、之後 selector 不再選到 parent。
    - 自我檢查（寫在執行紀錄，不留在程式碼）：暫時把 `createFollowupGoal()` 移到 transaction 外，確認新測試會失敗；確認後還原產品碼，並用 `git diff` 確認產品碼與修改前一致。
  - 來源：codex review-round4 重要 1（對應 W1）。

## 執行紀錄

### 2026-10-14 V1

- RED：暫時將 `createFollowupGoal()` 移到 `commitOwnerCheckpoint()` transaction 外後，`node --import tsx sim/goalCoordinator.test.ts` 失敗：`AssertionError [ERR_ASSERTION]: checkpoint 失敗必須 rollback follow-up Goal`；`1 !== 0`（actual `1`、expected `0`）。
- GREEN：還原產品碼後，`node --import tsx sim/goalCoordinator.test.ts` 通過（`goalCoordinator.test.ts OK`）；`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint` 均以 exit code 0 通過。
- 自我檢查：暫時錯置 `createFollowupGoal()` 時新測試會失敗；還原後檢查 `git diff -- sim/goalCoordinator.ts`，並確認修改前後 SHA-256 均為 `b9757312678c94829b3c9f4d2054234371f8afef816fa87f1a350180eddaadac`，產品碼未留下 V1 暫時改動。
- 沙盒內未執行的測試：無；V1 只修改可在沙盒內完整執行的 `sim/goalCoordinator.test.ts`。
