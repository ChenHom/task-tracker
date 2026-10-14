# Production coordinator：cutover 閘門已過時（第八輪）

來源：2026-10-14 以 `npx tsx sim/production.ts --once`（唯讀）空跑，production coordinator 回 `run.ended [coordinator fail] cutover_prerequisite_missing`。Claude 已查證：閘門寫死的 7 月 cutover task 全部已結案並封存，`00123ef0` 的 bug 早在 07-22 修好。這是要讓 Goal 流程能「限時試跑、小步切換」的前置修正；本輪**不得**啟用任何 timer、不得執行 `--live`。

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

- [x] **Q1 寫死的 7 月 cutover task 全部結案後，production coordinator 仍永遠回 cutover_prerequisite_missing**
  - 改動檔案：`sim/production/policy.ts`；`sim/production/policy.test.ts`（新增「五筆全 Archived 後改走一般 policy」、「任一筆非終態仍驗證證據鏈」、「activeReview 非終態仍套用固定處置」）；`docs/operations.md`；`docs/superpowers/plans/2026-10-14-production-cutover-settled.md`
  - 問題：`sim/production/policy.ts`（約 :100、:280、:326、:372、:452）、`sim/production/api.ts:541`、`sim/production/git.ts:684`、`sim/production/cutoverTasks.ts` 把 5 個 7 月看板上的 task 寫死成 cutover 的固定處置與前置條件：
    - `00123ef0-81cb-410e-aed1-d6d1fb925ed6`（completedPrerequisite，要求完整完成證據鏈）
    - `938aa035…`（activeReview：user06 進行中）
    - `027c0052…`（等 938 完成後交給 user05）
    - `10e65231…`（主工作區討論，fingerprint／到期才建 Owner action）
    - `6384b6f4…`（待 reconciliation）
  - 實際狀態（Claude 查 DB 與 git 確認）：五個全部是 `Archived`（07-30～08-06 看板清理時封存）。`00123ef0` 在 07-22 走完 Doing→Review→Done：修正 commit `75e2033`（fix: simplify main discussion closure）已在 `b1e49b4` 合入 master，Owner 驗收留言含 `Task-Id: 00123ef0…｜Head: 75e2033…`，之後有【SYSTEM完成】留言；07-30 才封存。
  - 2026-10-14 空跑輸出（節錄）：
    ```
    run.ended [coordinator fail] cutover_prerequisite_missing discovered=4 processed=0 skipped=4 — CutoverPrerequisiteMissing
    938aa035... -> user06／active
    6384b6f4... -> 尚待任務 9 reconciliation（目前：Archived／user06）
    00123ef0... -> CutoverPrerequisiteMissing：完成證據鏈缺漏或不相符
    10e65231... -> 等待任務1前置條件通過
    027c0052... -> 等待 938 Done 後交給 user05
    planned actions this tick: 4
      cutover_prerequisite_missing 00123ef0... — completedPrerequisite 完成證據鏈缺漏或不相符
      owner_review 566da0d9... — task 在 Review，等待 Owner 驗收
      owner_dispatch a457920a... — 未指派的 Todo 等待 Owner 分類與派工
      owner_dispatch e7274ddb... — 未指派的 Todo 等待 Owner 分類與派工
    ```
  - 規格：`docs/superpowers/specs/2026-07-22-production-sim-coordinator-design.md`、`docs/superpowers/specs/2026-07-22-production-sim-coordinator-decision-table.md`（只讀與 cutover 固定處置相關的段落，用 rg 定位）。
  - 修正：新增「cutover 已結案」判定：當所有寫死的 cutover task 都處於終態（`Done` 或 `Archived`），固定處置與 completedPrerequisite 證據鏈閘門一律視為已滿足、不再產生 `cutover_prerequisite_missing`，也不再對這些 task 產生固定處置（例如 938 的 activeReview、027 的轉交）；coordinator 改用一般 policy 處理目前看板（owner_review、owner_dispatch、Goal Task 等）。只要有任何一個寫死的 task 仍是非終態，維持現有行為（包含證據鏈驗證），既有測試不得刪除或放寬。不得改動 `ALLOWED_WORKSPACE_IDS`、`mainPolicy` 排除規則。`--once` 在已結案時，exit code 依 `docs/operations.md`「Exit code 契約」回 ready（0）。同步更新 `docs/operations.md` 的 Production Sim Coordinator 段落，說明已結案判定。
  - 驗收（行為測試，優先放沙盒可跑的 `sim/production/policy.test.ts`；需要整合時才用 `sim/production.test.ts`，並注意它在沙盒內會 listen EPERM）：
    - 五個寫死的 task 全部 `Archived`（含 `00123ef0` 沒有證據鏈資料）→ 規劃結果沒有 `cutover_prerequisite_missing`，也沒有針對這五個 task 的固定處置；看板上的 Review task 產生 `owner_review`、未指派 Todo 產生 `owner_dispatch`。
    - 五個中有一個（例如 `00123ef0`）仍是 `Done` 以外的非終態、且證據鏈缺漏 → 仍產生 `cutover_prerequisite_missing`（既有行為保留）。
    - `938aa035` 仍為 active Review、其餘已封存 → 仍套用 938 的固定處置（既有行為保留）。
  - 來源：Claude 2026-10-14 空跑與 DB／git 查證。

## 執行紀錄

### 2026-10-14 Q1

- RED：`node --import tsx sim/production/policy.test.ts` 失敗原文：
  ```text
  AssertionError [ERR_ASSERTION]: 五筆 cutover task 全部 Archived 時不得再要求舊證據鏈

  true !== false
  ```
- GREEN：以下指令通過：
  - `node --import tsx sim/production/policy.test.ts`
  - `npx tsc --noEmit`
  - `npx tsc -p sim/tsconfig.json`
  - `npm run lint`
  - `npm run typecheck`
  - `git diff --check`
- 沙盒內未執行：`sim/production.test.ts`（依執行規則的既知沙盒限制，失敗段落原文：`listen EPERM`）；未執行任何 live／sweep 指令。
