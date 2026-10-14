# UI：Kanban header 在桌面寬度被擠壓（第十一輪）

來源：Claude 2026-10-14 用 Playwright 以 branch 程式碼起預覽伺服器（port 3100、正式 DB 副本）實測第十輪 K2。K1（Task 詳情 Project 移到最上方）實測正確；手機 375px 實測正確（無水平溢出，`#project-context` 在「看板：…」下方）。**桌面寬度壞掉**。本輪只改 Kanban header 的版面（CSS 為主），不改 API、資料與文字更新邏輯。

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

- [x] **K3 桌面寬度下 `#project-context` 擠壓 header：標題換兩行、工具列文字被壓成直排**
  - 改動檔案：`public/css/kanban.css`、`docs/superpowers/plans/2026-10-14-ui-project-placement-round11.md`；新增測試：無（本項依驗收規格不新增 Mock DOM 版面量測測試）。
  - 問題：第十輪 K2 把 `#project-context` 放進 `.kanban-title-wrapper`（`public/js/views/kanban.js` header 一帶，樣式在 `public/css/kanban.css`）後，在 1440×900 實測（Playwright，選中 workspace「健壯性強化」、未選 Project 的總覽狀態）：
    - `.kanban-title-wrapper h2`（Kanban Board）高 96px：被擠成兩行。
    - `.kanban-header-bar` 整條高 136px。
    - `#project-context` 寬 328px（單行省略正常）。
    - 工具列控制項被壓縮換行：「顯示已封存 Project」label 寬 73px、高 72px；「新增 Project」按鈕高 57px；「編輯選取 Project」按鈕高 78px；「顯示已歸檔」label 寬 47px、高 120px（一字一行直排）。搜尋框高 21px 正常。
    - 原因：title 區加入可伸縮的 context 後，與右側工具列搶同一列寬度，工具列元件被允許 shrink、文字被允許換行。
  - 修正（只用 `public/css/kanban.css` 既有風格，不新增顏色字型）：
    - 標題 `h2` 不換行（`white-space: nowrap`）。
    - 工具列的 label、button、checkbox 文字不換行、不被壓縮（`white-space: nowrap; flex-shrink: 0` 或等效作法）。
    - 寬度不足時，讓 header 換行：工具列整組移到下一列（`flex-wrap: wrap`），而不是壓縮控制項；`#project-context` 以 `flex: 1 1 auto; min-width: 0` 搭配既有的單行省略，吃剩下的寬度，並設合理的 `max-width`，避免在超寬螢幕拉得過長。
    - 手機（既有 media query 斷點）維持目前已正確的行為，不得退化。
  - 驗收：
    - 沙盒內 Mock DOM 量不到 layout，所以本項不要求寫版面量測測試；改完確保既有 `src/frontend.test.ts` 全過、`npm run lint` 通過。
    - Claude 會在沙盒外用 Playwright 驗證，標準是：1440×900 與 1280×800 下 `h2` 高度為單行（約 48px 以內）、工具列每個 label／button 高度都是單行（不超過 40px）且沒有直排、`#project-context` 單行省略；375×812 下 `document.documentElement.scrollWidth === clientWidth`（無水平溢出）。請以此為目標調整 CSS。
  - 來源：Claude Playwright 實測（第十輪 K2）。

## 執行紀錄

### 2026-10-14 K3

- RED（規格所附 Claude Playwright 實測原文）：`.kanban-title-wrapper h2`（Kanban Board）高 96px：被擠成兩行。`.kanban-header-bar` 整條高 136px。「顯示已封存 Project」label 寬 73px、高 72px；「新增 Project」按鈕高 57px；「編輯選取 Project」按鈕高 78px；「顯示已歸檔」label 寬 47px、高 120px（一字一行直排）。
- GREEN：`node --import tsx src/frontend.test.ts`（`frontend.test.ts OK`）；`npx tsc --noEmit`；`npx tsc -p sim/tsconfig.json`；`npm run lint`；`git diff --check`。
- 沙盒內未執行：Playwright 的 1440×900、1280×800、375×812 實際版面量測（Mock DOM 無法量測 layout，依本項驗收規格交由沙盒外驗證）。沒有未跑完的測試檔或沙盒失敗段落。

- 2026-10-14 Claude 沙盒外 Playwright 驗收（預覽伺服器 port 3100、正式 DB 副本）
  - K3 後 1440／1280 正常，但 769px 出現水平溢出：`.kanban-filters` 寬 809px 超出視窗 56px（769px 以上套桌面規則，工具列不換行且控制項已設不壓縮）。
  - 修正：`public/css/kanban.css` 的 `.kanban-filters` 改為 `flex: 0 1 auto; flex-wrap: wrap; max-width: 100%`。
  - 修正後實測：1440／1280／800／769 的 `h2` 48px（單行）、工具列控制項最高 38px（單行）、無水平溢出；768／375 無水平溢出；選定 Project 時 `#project-context` 單行 39px、以省略號截斷、`title` 為完整文字。
  - 沙盒外 `npm test` exit 0。
