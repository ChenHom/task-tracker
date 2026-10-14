# Goal 協作第七輪修正

來源：GitHub PR #1 上 Codex review bot 的三則行內意見（commit `6b3224a`），Claude 已對照程式碼確認都成立。

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

- [x] **T1 Agent 帳號可以啟動人類 Goal**
  - 改動檔案：`src/server.ts`；`src/goalHttp.test.ts`（新增「Agent start 被拒且不改變 Queued Goal／不新增 heartbeat；人類 Member start 成功」行為測試）；`docs/superpowers/plans/2026-10-14-goal-agent-collaboration-fixes-round7.md`
  - 問題：`src/server.ts:1035` 的 `if (action !== 'start' && !requireHumanGoalActor(userId, res)) return;` 把 `start` 排除在人類限定之外。Agent 帳號只要有 Workspace Member 以上權限，就能對 Queued 的人類 Goal 呼叫 `POST /api/goals/:id/start`，寫入 owner_scoping heartbeat，coordinator timer 啟用後就會開始付費的 AI 執行。同一個帳號的建立、修改、暫停、恢復、取消都已被拒絕。sim 與 production 都沒有透過 HTTP 呼叫 start（Claude 已 grep 確認）。
  - 規格：L430（人類可建立、暫停、恢復、取消 Goal）、L438（寫入權限邊界）。
  - 修正：拿掉 `action !== 'start' &&` 例外，start 也只允許人類帳號。
  - 驗收：`src/goalHttp.test.ts`（in-process `handle()`）：Agent（Workspace Member）對 Queued 人類 Goal 呼叫 start → 403，Goal 仍為 Queued、沒有新增 heartbeat；人類 Member 呼叫 start → 200。
  - 來源：PR #1 review comment 4266078911（P1）。

- [x] **T2 建立 Goal 時沒有檢查 Owner Agent 在該 Workspace 是否有 coordinator 需要的權限**
  - 問題：`src/goal.ts:328` 只檢查 `getAgent(ownerAgentId)?.role === 'owner'`（全域角色）。人類 Member 可以在 user01 不在、或只是 Member 的 Workspace 建立 Goal。production 的 `performDiscovery()` 以 user01 登入，看不到不在其中的 Workspace；Run、worktree、delivery evidence 的端點又要求 Admin。這種 Goal 看起來正常，實際上永遠不會被處理。
  - 規格：L438（寫入權限邊界）；屬實作缺陷。
  - 修正：`createGoal` 驗證 Owner Agent 對應的 user 是該 Workspace 的 active member，而且角色至少是 coordinator 需要的等級（照 `src/server.ts` 中 run／worktree／delivery evidence 端點實際使用的 `requirePermission` 角色，不要自己猜）；不符合時丟 `CommandError`，訊息寫清楚原因（例如「Owner Agent 不是此 Workspace 的 Admin，coordinator 無法處理」）。`startGoal` 也做同樣檢查（建立後成員可能被移除）。
  - 驗收：`src/goal.test.ts`：user01 不在 Workspace → 建立被拒；user01 只是 Member → 被拒；user01 是 Admin/Owner → 成功；建立後把 user01 移出 Workspace → start 被拒且 Goal 狀態不變。若既有測試的 fixture 沒把 user01 設成 Admin 而因此失敗，補 fixture（不得放寬斷言）；記得 `src/server.test.ts`、`sim/goal.integration.test.ts` 在沙盒內跑不完，先確認它們的 fixture 有建立 user01 的 Admin membership。
  - 來源：PR #1 review comment 4266078915（P1）。
  - 改動檔案：`src/goal.ts`、`src/goal.test.ts`、`src/goalHttp.test.ts`、`sim/goalPatrol.test.ts`、`docs/superpowers/plans/2026-10-14-goal-agent-collaboration-fixes-round7.md`。新增測試：「Owner Agent user 不在 Workspace 時應拒絕建立 Goal」、「Owner Agent user 只是 Member 時應拒絕建立 Goal」、「Owner Agent user 是 Admin 時應成功建立 Goal」、「建立後 Owner Agent user 被移出 Workspace 時應拒絕開始 Goal／狀態維持 Queued」。

- [x] **T3 點開只帶 Goal 的通知時沒有先切到 Goal 所屬 Workspace**
  - 改動檔案：`public/js/views/notifications.js`、`src/frontend.test.ts`、`docs/superpowers/plans/2026-10-14-goal-agent-collaboration-fixes-round7.md`。新增測試：「Goal-only 通知先切換至 Goal 所屬 Workspace、導頁並標為已讀」、「Goal API 回 404 時不導頁、保留通知卡片並顯示原因」。
  - 問題：`public/js/views/notifications.js:173-177` 在 `n.source_goal_id && !n.source_task_id` 時直接 `navigate('#/goals/:id')`，沒有像 task 通知那條路一樣先解析並設定所屬 Workspace。剛登入時 Goals 頁因為沒選 Workspace 而拒絕顯示；從別的 Workspace 點進來，則會載入那個 Workspace 的 projects、members、agents。
  - 規格：屬實作缺陷。
  - 修正：仿照同函式中 task 通知的處理方式：先 `api('/api/goals/:id')` 取得 `workspace_id`，設定目前 Workspace（用 task 路徑設定 Workspace 的同一套方式），成功後才 navigate；403/404 時保留通知卡片並顯示原因、不導頁（與 task 路徑一致）。
  - 驗收：`src/frontend.test.ts` 或對應的通知前端測試（用既有 Mock DOM，行為測試）：目前 Workspace 是 A，點開 Workspace B 的 Goal 通知 → 目前 Workspace 變成 B、導向 `#/goals/:id`、通知標為已讀；Goal API 回 404 → 不導頁、卡片仍在。
  - 來源：PR #1 review comment 4266078920（P2）。

## 執行紀錄

### 2026-10-14 — T1

- RED：`goalHttp.test.ts FAILED: AssertionError [ERR_ASSERTION]: Agent start 應回 403`；`200 !== 403`。
- GREEN：`node --import tsx src/goalHttp.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`。
- 沙盒內未執行的測試：無。

### 2026-10-14 — T2

- RED：`AssertionError [ERR_ASSERTION]: Missing expected exception: Owner Agent user 不在 Workspace 時應拒絕建立 Goal`。
- GREEN：`node --import tsx src/goal.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`。
- 沙盒內未執行的測試：`src/server.test.ts`、`sim/goal.integration.test.ts`；依執行規則不執行，已確認 fixture 的 user01 在目標 Workspace 為 Admin／Owner 且 Agent 資料會建立。規則所列中止原文：`spawnSync … EPERM` 或 `listen EPERM`。

### 2026-10-14 — T3

- RED：`frontend.test.ts FAILED: AssertionError [ERR_ASSERTION]: 點開 Goal 通知應切到 Goal 所屬 Workspace`；actual `workspace-a`、expected `workspace-b`。
- GREEN：`node --import tsx src/frontend.test.ts`、`npx tsc --noEmit`、`npx tsc -p sim/tsconfig.json`、`npm run lint`。
- 沙盒內未執行的測試：無。

### 2026-10-14 — T2 npm test fixture 補正

- 失敗原文：`goalHttp.test.ts FAILED: CommandError: Owner Agent 不是此 Workspace 的 Admin，coordinator 無法處理`；`at requireCoordinatorOwnerAgent (src/goal.ts:119:11)`；`at createGoal (src/goal.ts:338:3)`；`at src/goalHttp.test.ts:79:20`。
- 根因：T2 的 production 驗證正確拒絕沒有 Workspace Admin 權限的 Owner Agent；`src/goalHttp.test.ts` fixture 雖建立 `owner-agent-user` 帳號與 Owner Agent 資料，卻漏建該 user 在 `ws` 的 Admin membership。後續檢查亦發現 `sim/goalPatrol.test.ts` 的 `ws` 與 `live-ws` 有相同 fixture 缺口。
- 改動檔案：`src/goalHttp.test.ts`（補 `owner-agent-user` 的 Admin membership）、`sim/goalPatrol.test.ts`（補一般巡檢與 live discovery Owner Agent 的 Owner membership）、`docs/superpowers/plans/2026-10-14-goal-agent-collaboration-fixes-round7.md`（T2 維持 `[x]` 並補齊改動檔案與本紀錄）。
