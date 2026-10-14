# Goal 協作第六輪修正

來源：codex 對第五輪的審查（`~/.local/state/goal-fix-codex/review-2026-10-14-goal-agent-collaboration-fixes-round5-20261014-094914.md`）。V1 新增的 rollback 測試有效，但它把原本的「checkpoint commit 後崩潰」測試整段換掉，違反「不得刪除既有測試」。本輪只把原測試加回來，**不改產品碼、不動 V1 的新測試**。

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

- [x] **U1 還原被 V1 取代的「checkpoint commit 後崩潰」測試，與 V1 的 rollback 測試並存**
  - 改動檔案：`sim/goalCoordinator.test.ts`（新增 checkpoint commit 後崩潰重跑不重複建立 child Goal 測試）；`docs/superpowers/plans/2026-10-14-goal-agent-collaboration-fixes-round6.md`（U1 狀態與執行紀錄）
  - 問題：`sim/goalCoordinator.test.ts` 約 :712-750 原本有一段測試：child Goal 與 checkpoint 都已 commit 之後，透過 `output.action` getter 丟錯，驗證呼叫端看到例外而重跑時，已成功的 heartbeat 不會再建立 child，最後只有一個 child Goal。V1 把它整段換成 `BEFORE UPDATE ... goal_heartbeats` trigger 的 rollback 測試，只測「commit 前失敗」。「已 commit、函式回傳前崩潰」這個窗口因此沒有測試了。
  - 規格：L322（崩潰恢復）、L387（只建立一個 child Goal）、L487（每個 checkpoint 崩潰不得重複建立 child Goal）。
  - 修正：把下方原測試區塊加回 `sim/goalCoordinator.test.ts`，放在 V1 的 rollback 測試旁邊、作為獨立的 `{ ... }` 區塊。兩段都必須保留。若兩段共用同一個 `targetRepo` 會互相干擾，只能改原區塊的 `targetRepo` 字串（例如改成 `'/checkpoint/followup-after-commit'`），不得修改其斷言。
  - 驗收：`node --import tsx sim/goalCoordinator.test.ts` 通過；`grep -c 'crash after createFollowupGoal' sim/goalCoordinator.test.ts` 至少為 1；V1 的 rollback 斷言（`checkpoint 失敗必須 rollback follow-up Goal`）仍在；產品碼與本輪開始前一致（`git diff --stat -- sim/goalCoordinator.ts src/` 與開始前相同）。
  - 原測試區塊（第四輪 pipeline log 保存的快照，照原樣還原）：

```ts
  {
    const targetRepo = '/checkpoint/followup';
    const { database, createGoal } = createSchedulingFixture(targetRepo);
    try {
      const repos: RepoRegistry = new Map([[targetRepo, { targetRepo, checks: ['npm test'], deployment: 'not_required' }]]);
      const goalId = prepareExecutingGoal(database, createGoal, 'follow-up crash recovery');
      const taskId = (database.prepare('SELECT task_id FROM tasks_read_model WHERE goal_id = ?').get(goalId) as { task_id: string }).task_id;
      database.prepare("UPDATE tasks_read_model SET status = 'Done' WHERE task_id = ?").run(taskId);
      recordDeliveryEvidence(taskId, { kind: 'ci.checked', ref: 'ci:passed', detail: 'passed' }, database);
      recordDeliveryEvidence(taskId, { kind: 'merge.integrated', ref: 'merge:main' }, database);
      recordDeliveryEvidence(taskId, { kind: 'deployment_not_required', ref: 'deployment:none' }, database);
      const deps = {
        database, repoRegistry: repos, quotaSnapshot: async () => '{}', readRepoSources: () => [],
        invokeJson: async ({ phase }: { phase: string }) => {
          if (phase === 'verifying') return { passed: true, evidenceRefs: ['verification:passed'] };
          let crashPending = true;
          const output = {
            objective: 'child objective', successCriteria: 'new child criteria', reason: 'new evidence', evidenceRefs: ['followup:new'],
          } as Record<string, unknown>;
          Object.defineProperty(output, 'action', {
            enumerable: true,
            get: () => {
              const childExists = database.prepare('SELECT 1 FROM goals_read_model WHERE parent_goal_id = ?').get(goalId);
              if (crashPending && childExists) {
                crashPending = false;
                throw new Error('crash after createFollowupGoal');
              }
              return 'create';
            },
          });
          return output;
        },
      };
      assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'done');
      await assert.rejects(runGoalCoordinatorOnce(goalId, deps), /crash after createFollowupGoal/);
      assert.strictEqual(await runGoalCoordinatorOnce(goalId, deps), 'Done');
      assert.strictEqual((database.prepare('SELECT COUNT(*) AS n FROM goals_read_model WHERE parent_goal_id = ?').get(goalId) as { n: number }).n, 1);
    } finally {
      database.close();
    }
  }
```
  - 來源：codex review-round5 重要 1（對應 V1）。

## 執行紀錄

### 2026-10-14 — U1

- RED：`AssertionError: expected at least 1 occurrence of crash after createFollowupGoal, got 0`
- GREEN：`node --import tsx sim/goalCoordinator.test.ts`；`npx tsc --noEmit`；`npx tsc -p sim/tsconfig.json`；`npm run lint`；`npm run typecheck`
- 驗收：`grep -c 'crash after createFollowupGoal' sim/goalCoordinator.test.ts` 為 2；V1 斷言 `checkpoint 失敗必須 rollback follow-up Goal` 仍在；`git diff --stat -- sim/goalCoordinator.ts src/` 與開始前相同。
- 沙盒內未執行的測試：無。
