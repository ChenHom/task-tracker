# Production coordinator：cutover 已結案時的 CLI 報表（第九輪）

來源：codex 對第八輪 Q1 的審查（`~/.local/state/goal-fix-codex/review-2026-10-14-production-cutover-settled-20261014-114941.md`）。Q1 的 policy 判斷已正確（不再產生 `cutover_prerequisite_missing` action），但 `--once` 的報表路徑仍印出舊的固定處置訊息。本輪**不得**啟用任何 timer、不得執行 `--live`。

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

- [x] **Q2 cutover 已結案時，`--once` 報表仍列出 CutoverPrerequisiteMissing 與舊的等待訊息**
  - 改動檔案：`sim/production.ts`、`sim/production/policy.ts`、`sim/production.once.test.ts`（新增 `testSettledCutoverReportUsesGenericActions`、`testUnsettledCutoverStillReportsMissingEvidence`）、`package.json`、`docs/superpowers/plans/2026-10-14-production-cutover-settled-round9.md`；另含 `docs/operations.md`（已結案報表契約）與 `sim/production/policy.test.ts`（Q1／Q2 共用的 policy 行為測試）——2026-10-14 Claude 依審查補列。
  - 修正：讓 Q1 的「cutover 已結案」判定同時控制證據鏈驗證與固定處置的報表輸出（`sim/production.ts:854-857` 一帶）。已結案時，報表不得再出現 `CutoverPrerequisiteMissing`、`等待任務1前置條件通過`、`尚待任務 9 reconciliation`、`等待 938 Done 後交給 user05`、`user06／active` 這類 7 月固定處置訊息；可以改成一行說明「cutover 固定處置已結案」。只要有任何寫死的 cutover task 仍非終態，報表維持現有行為。
  - 驗收：新增行為測試，呼叫 `runOnce({ live: false })`（或 `--once` 實際使用的同一個進入點），fixture 讓五個寫死的 task 全部 `Archived` 且 `00123ef0` 沒有證據鏈：斷言 exit code 為 0（ready）、整份輸出不含上面列出的任何舊訊息、planned actions 仍包含一般的 `owner_review`／`owner_dispatch`。再加一案：`00123ef0` 非終態且證據缺漏時，輸出仍含 `CutoverPrerequisiteMissing`（既有行為保留）。若測試需要寫入 DB，使用暫存 DB（不得寫 `data/dev.db`）；若放在沙盒內跑不完的檔案，先確認 fixture 正確，並把新測試檔加進 `package.json` 的 test script。
  - 審查原文：
    1. **已結案 cutover 仍被報告為缺少前置證據，且新增測試完全繞過這條 CLI 路徑**  
       檔案：[sim/production.ts:854](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/production.ts:854)、[sim/production.ts:857](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/production.ts:857)、[sim/production.ts:563](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/production.ts:563)、[sim/production/policy.test.ts:65](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/sim/production/policy.test.ts:65)  
       對應計畫：Q1 修正與驗收，[計畫:68](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/docs/superpowers/plans/2026-10-14-production-cutover-settled.md:68)、[計畫:70](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/docs/superpowers/plans/2026-10-14-production-cutover-settled.md:70)  
       對應規格：[規格:52](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/docs/superpowers/specs/2026-10-11-goal-agent-collaboration-design.md:52)、[規格:340](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/docs/superpowers/specs/2026-10-11-goal-agent-collaboration-design.md:340)
    
       具體失敗情境：五筆固定 task 全為 `Archived`，`00123ef0` 沒有完整 evidence。`selectCoordinatorActions()` 現在會正確產生一般 `owner_review`／`owner_dispatch`，且 `runOnce()` 因找不到 missing action 而回 exit 0；但它仍無條件執行 `validatePrerequisiteEvidence()`，接著輸出：
    
       - `00123ef0... -> CutoverPrerequisiteMissing`
       - `10e65231... -> 等待任務1前置條件通過`
       - `6384b6f4... -> 尚待任務 9 reconciliation`
       - `027c0052... -> 等待 938 Done 後交給 user05`
    
       這直接違反 operations 文件所寫「不再驗證歷史證據鏈」及「不會產生 `CutoverPrerequisiteMissing`」的契約：[docs/operations.md:503](/home/hom/code/task-tracker/.worktrees/goal-agent-collaboration/docs/operations.md:503)。自動化若看 exit code 會認為 ready，人類若看輸出則會認為仍被阻擋。
    
       新測試只直接呼叫 `selectCoordinatorActions()`，因此舊報表路徑即使仍錯也全綠。現有 `sim/production.integration.test.ts` 沒有全部 Archived 的案例，而且未列入 `npm test`。
    
       最小修正應讓結案判定同時控制 evidence 驗證與 disposition 報表，並新增 `runOnce({live:false})` 行為測試，斷言 exit 0 且整份輸出不含 `CutoverPrerequisiteMissing` 或舊等待訊息。
    
       **未驗證**：受唯讀沙盒限制，直接 import `sim/production.ts` 在執行函式前即因 DB migration 回報 `attempt to write a readonly database`，因此未實跑完整 `runOnce()`；上述結果由確定的控制流與字串分支得出。
    
  - 來源：codex review（第八輪）重要 1。

## 執行紀錄

### 2026-10-14 Q2

- RED：`node --import tsx sim/production.once.test.ts` 失敗，原文：`AssertionError [ERR_ASSERTION]: cutover 已結案時不得再輸出：CutoverPrerequisiteMissing`。實際輸出同時包含 `user06／active`、`尚待任務 9 reconciliation`、`等待任務1前置條件通過`、`等待 938 Done 後交給 user05`。
- GREEN：以下指令通過：
  - `node --import tsx sim/production.once.test.ts`
  - `node --import tsx sim/production/policy.test.ts`
  - `npx tsc --noEmit`
  - `npx tsc -p sim/tsconfig.json`
  - `npm run lint`
  - `git diff --check`
- 沙盒內未跑完：
  - `sim/production.test.ts`：`Error: listen EPERM: operation not permitted 127.0.0.1`（在前段中止，未進入後段斷言）。
  - `sim/production.integration.test.ts`：`Error: spawnSync git EPERM`，`code: 'EPERM'`，`syscall: 'spawnSync git'`，`spawnargs: [ 'init', '-q', '-b', 'master' ]`（在前段中止，未進入後段斷言）。
