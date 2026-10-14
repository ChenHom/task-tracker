# UI：Project 資訊的擺放位置（第十輪）

來源：使用者 2026-10-14 以截圖回報兩個畫面的 Project 擺放問題，要求「project 的位置移到上面，或 project 的訊息移到外層，且元件要符合現有的設計規範」。本輪只改前端版面，不改 API 與資料。

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

- [x] **K1 Task 詳情：Project 區塊移到左欄最上方**
  - 改動檔案：`public/js/views/task-detail.js`（Project 區塊改為左欄第一區）；`src/frontend.test.ts`（新增 `assertProjectSectionFirst`，驗證可編輯與唯讀 Task detail 的 Project／任務名稱區塊順序）
  - 問題：`public/js/views/task-detail.js:373-394` 的 Project 區塊（`projectSec`，`detail-section sketch-box`，含 `aria-label="Task Project"` 的 select）在內容區塊（`contentSec`：任務名稱、任務詳細描述、儲存）之後才 `leftEl.appendChild`，畫面上排在任務名稱與描述下面、留言板上面。使用者要求移到上面。
  - 修正：讓 Project 區塊成為左欄第一個區塊（在任務名稱／描述區塊之前）。只調整順序，沿用既有的 `detail-section sketch-box` 樣式、label 與 select；可編輯與唯讀兩種情況（`canManageTask` 為 true／false）都要移。不得改動 select 的行為（PATCH `projectId`、錯誤處理）。
  - 驗收（`src/frontend.test.ts`，用既有 Mock DOM 的行為測試）：render task 詳情後，左欄第一個 `detail-section` 是 Project 區塊（含 label `Project`），其次才是任務名稱區塊；`canManageTask` 為 false 時同樣成立。既有 Project select 的測試照樣通過。
  - 來源：使用者截圖 1。

- [x] **K2 Kanban：Project 資訊列移到標題旁的空白處**
  - 改動檔案：`public/js/views/kanban.js`、`public/css/kanban.css`、`src/frontend.test.ts`（新增測試「K2: Project context belongs to the Kanban title area and remains accessible as filters change」）、`docs/superpowers/plans/2026-10-14-ui-project-placement.md`
  - 問題：`public/js/views/kanban.js:125` 的 `#project-context`（`section.sketch-box`，`aria-live="polite"`）在 header 下方獨立佔一整列，內容是「目前為總覽；選擇 Project 後顯示描述、repo 與 active Goal。」或選定 Project 後的「名稱 · 描述 · repo · 進度 · Active Goal」（`kanban.js:358-368` 更新文字）。同時 header 左側 `.kanban-title-wrapper`（`kanban.js:94-101`，含 `h2.red-pen-underline` 標題與 `#kanban-workspace-name-el`）右邊有一大塊空白，使用者要求把 Project 資訊移到那裡。
  - 修正：
    - 把 `#project-context` 移進 header 的標題區（`.kanban-title-wrapper` 內或緊鄰標題的位置），不再獨立佔一整列。保留 `id="project-context"` 與 `aria-live="polite"`，文字更新邏輯（`kanban.js:358-368`）不變。
    - 樣式必須沿用現有設計規範：使用 `public/css/global.css`、`public/css/kanban.css` 既有的 class 與 CSS 變數（例如 `.sketch-box`、`.badge`、`var(--pencil-color)` 等手繪風格元件），不得新增顏色、字型或與現有風格不一致的元件。新增的 CSS 放在 `public/css/kanban.css`。
    - 文字過長時單行省略（ellipsis），並把完整文字放在 `title` 屬性，避免把 header 撐高。
    - 手機寬度（沿用 repo 既有的 `desktop-text`／`mobile-text` 與 media query 斷點）時可以換到標題下方，但不得造成水平捲動。
  - 驗收（`src/frontend.test.ts`，Mock DOM 行為測試）：render Kanban 後，`#project-context` 位於 header 標題區內（是 `.kanban-title-wrapper` 的後代，或與標題同一個 header 容器），不再是 header 之後的獨立 section；未選 Project 時文字為總覽說明，選定 Project 後文字含名稱與 repo，`title` 屬性與文字一致；`aria-live` 仍為 `polite`。既有 Kanban 測試照樣通過。
  - 來源：使用者截圖 2。

## 執行紀錄

### 2026-10-14 K1

- RED：`node --import tsx src/frontend.test.ts`
  - 失敗原文：
    ```text
    frontend.test.ts FAILED: AssertionError [ERR_ASSERTION]: 可編輯 Task detail 左欄第一區應為 Project
    + actual - expected

    + '任務名稱 *'
    - 'Project'
    ```
- GREEN：
  - `node --import tsx src/frontend.test.ts`（`frontend.test.ts OK`）
  - `npx tsc --noEmit`
  - `npx tsc -p sim/tsconfig.json`
  - `npm run lint`
- 沙盒內未執行的測試：無；本項直接相關測試與指定檢查均已跑完。

### 2026-10-14 K2

- RED：`node --import tsx src/frontend.test.ts`
  - 失敗原文：
    ```text
    frontend.test.ts FAILED: AssertionError [ERR_ASSERTION]: Project context 應位於 header 標題區內
    ```
- GREEN：
  - `node --import tsx src/frontend.test.ts`（`frontend.test.ts OK`）
  - `npx tsc --noEmit`
  - `npx tsc -p sim/tsconfig.json`
  - `npm run lint`
- 沙盒內未執行的測試：無；本項直接相關測試與指定檢查均已跑完。
