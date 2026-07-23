# 正式環境 Sim 協調器實作計畫

> **給執行代理：** 必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans` 子技能，依序逐項實作本計畫。所有步驟以核取方塊（`- [ ]`）追蹤。

**目標：** 以單一、可安全重啟的正式環境協調器，取代不可靠的 Owner／Team sweep。新協調器必須能規劃、分派、驗證、部署、復原並回報 task-tracker 已完成工作，避免任務再度卡住數日。

**架構：** 保留 `sim/run.ts` 的 deep／fast／scenario 流程作為實驗用 harness，另建只服務主協作工作區與 task-tracker canonical workspace 的正式環境協調器。協調器每 15 分鐘執行一次，以 SQLite 保存 checkpoint 與冪等紀錄，將一個明確 task 與一條 task 專屬 branch 交給成員，並以經驗證的 API／Git／測試／部署副作用判斷成功，而不是只看 process exit。

**技術棧：** TypeScript、Node 24（`node:http`、`node:sqlite`、`child_process`）、既有 cookie 驗證 HTTP API、Git worktree、使用者層級 systemd、既有 `task-tracker.service` 與 Discord `notify-human.sh` 通知路徑。

---

## 已確認的產品決策

- 正式環境範圍固定為：
  - 主協作工作區：`11a82028-fc50-466a-a723-e002032cd9a6`。
  - task-tracker canonical workspace：`d9da9945-ce5f-400f-806e-1d75e95e313a`。
- `deep`、`fast` 與其他 scenario 模式保留為實驗工具，永遠不進入正式環境工作佇列。
- Bug、維護工作，以及能引用已核准決策的工作，可由 Owner 直接規劃與分派。
- 新增使用者可見功能必須在主協作工作區完整討論 24 小時。不可提前結案；缺席成員不阻擋結案。
- user02 至 user06 對每項新功能各有一次 bounded discussion；user09 只接收通知，sim 不會代替 user09 執行或標示已讀。
- Owner 負責規劃、分派、診斷、審查與決策。Owner 不編輯程式、不解決 conflict，也不建立修復 commit。
- 成員只實作被明確指派的一個 task。每位成員最多只有一個自動化 WIP task。
- `queued` 是 coordinator metadata，不是看板狀態。Queued task 不占自動化 WIP、不建立 branch／worktree、不取得執行 lease，也不呼叫 Owner／member 模型；直到固定依賴完成或 user09／人工 task mutation 改變決策後才可解除。
- 現有卡關 task 採固定 cutover disposition：`938aa035-5f96-4908-b28b-876fa4735061` 是 user06 唯一 active WIP；`6384b6f4-f92f-45a2-a5e1-133f04f76372` 保持 queued 且清除 assignee；`00123ef0-81cb-410e-aed1-d6d1fb925ed6` 是任務 1 唯一對應的看板實作 task，由 Owner 在任務 1 開始時只指派一次 user03，完成實作、驗證、部署與通知後轉為 Done，cutover 不得再次指派或執行；`027c0052-46d5-4da7-90fa-dd8efb2219fc` 等 `938aa035...` Done readback 後固定交給 user05；`10e65231-a4b2-4bdb-aab4-9f3c5fb0e916` 只有在 cutover 驗證 `00123ef0...` 完成證據後才機械式結案。
- 成員連續兩次完整嘗試都沒有可驗證進展時，強制由 Owner 介入。介入後再有一次無進展嘗試，就轉為 `human_blocked`、留下唯一且去重的 `@user09` 留言，並停止模型呼叫。
- `human_blocked` 是自動化 metadata，不是新的 task 狀態。看板狀態與 assignee 維持不變；卡關工作不列入自動化 WIP 計算。
- 每個 task 使用自己的 branch 與 worktree。正式環境不再使用 `sim/user06` 這類共享 branch。
- task 只有在 branch 驗證、整合驗證、merge、部署、live health/readback，以及能建立 user09 notification 的系統完成留言都成功後，才能進入 Done。
- 每個 coordinator tick 最多產生一則 Discord 摘要。初次傳送失敗後再重送兩次，總計三次；Discord 失敗不會重開已 Done 的 task。
- 部署失敗時建立可追溯的 `git revert` commit，並恢復上一個正常服務 revision。永遠不 reset Git 歷史。
- Build 與安裝不代表已授權 live AI。啟用或手動執行 live coordinator 前，必須另取得明確人工授權。
- 既有 `sim-autodeploy.path` 是 master merge／revert 的唯一部署觸發來源；coordinator 等待並驗證 path 觸發的同一輪 service invocation，不再主動 start 第二輪。
- 舊 sweep 程式碼只在 runtime cutover 完成兩個成功 live tick 後退役；`deploy/sim-autodeploy.sh` 的既有 `pgrep sim/run.ts` 守衛本次保留。
- 任務 1 的 bootstrap driver 是一個具備 board mutation 授權的互動式 Claude Code session。該 session 同時負責實作與機械式 API／Git／部署操作；因為是互動環境，git 與 systemd 寫入可即時取得人工核可，不得改在非互動 cron 環境執行。
- 任務 2 至 10 在單一 feature branch `feature/production-coordinator` 上實作，過程中的 commit 不觸碰 master，因此不觸發 `sim-autodeploy`。任務 10 結束後一次合併進 master，只產生一次 build + restart。任務 12 另開 `feature/retire-legacy-sweep` 並同樣以單次 merge 收尾。
- 只有任務 1 的看板 task 走完整 acceptance／deploy／completion 鏈。feature branch 的 merge 走簡化 gate：merge 前完整 test／build 通過，merge 後等待 path-triggered invocation 並驗證 health rev，但不產生 completion comment 或 task 狀態變更。
- Lease TTL 固定為 45 分鐘（`LEASE_TTL_MS`），必須嚴格大於 `DEPLOY_WAIT_TIMEOUT_MS`（35 分鐘）。一個 tick 合法可跑超過 35 分鐘，若 lease 先過期，`--status` 會誤報不健康，且過期 lease 可被重新 claim，導致兩個 coordinator 同時處理同一 task。
- Exit `1`（未分類程式錯誤）**不保證零 mutation**。它是唯一沒有副作用契約的結束路徑：下一個 tick 必須以 `action_log` 與權威 readback 重新對帳，不得假設任何 planned mutation 已完成或未完成。
- `queued` task 的看板狀態必須是 Todo／unassigned，不得停留在 Review。Review 沒有直接到 Todo 的合法轉換（`src/task.ts` 的 `TRANSITIONS`），且 Review -> Doing 要求 assignee 非 null，因此順序固定為 Review -> Doing -> Todo -> 清除 assignee，先清 assignee 會永久卡在 Review。
- 部署等待的逾時固定為 35 分鐘，涵蓋 `sim-autodeploy.sh` 最長 30 分鐘的 `pgrep sim/run.ts` 等待。逾時本身不等於部署失敗：必須先比對 `deployed_rev` 與 `/api/health` rev 是否已等於 target SHA，再判定成功、失敗或 `DeploymentIndeterminate`。
- `.path` 觸發遺漏是已知殘餘風險。coordinator 永遠不主動 start service，但 operator 可手動 `systemctl --user start sim-autodeploy.service`；`sim-autodeploy.sh` 的 `[ "$HEAD" = "$DEPLOYED" ] && exit 0` 讓手動啟動冪等。coordinator 下一個 tick 以 `deployed_rev`／health rev 認回該狀態，不要求該輪 invocation 由自己觀察到。

## 本計畫要消除的已確認失敗模式

- `mainDiscussionNeedsOwner(status)` 目前把主協作工作區的每個 Todo 都視為 Owner 工作，即使留言與期限事件完全沒變。
- Target Owner session 在 branch CI／登入後反覆失敗，但舊 sweep 仍消耗 Owner budget，最後以成功狀態結束。
- 未指派的 Todo 無法執行；過時的 task 文字卻又要求 Owner 因為「認領制」而不要指派。
- Team selector 只接受已指派的 Todo／Doing；Review task 完全依賴 Owner。
- 同一 member branch 可能同時包含多個 task、暫存檔與無關修改，因此 CI PASS 無法證明單一 task 可接受。
- 同一成員的兩個 Review 若在 cutover 同時退回 Doing，會立即違反 WIP1；只能啟動一筆，其餘必須以持久化 `queued` checkpoint 保持靜默。
- 一般 session 通常只信任 CLI exit status，沒有驗證預期留言、狀態轉移、commit、merge 或部署是否真的發生。
- 主討論結案以自然語句 confirmation regex 判斷，會拒絕 user09 的有效表達。
- 新建窗口改成 `【全員回覆：24小時】` 後，若收尾 parser 不保留舊 `【全員回覆：N天】` 的唯讀相容，既有 `10e65231...` 會因歷史 request comment 無法解析而永遠不能結案。
- `sim-autodeploy.path` 已監看 master ref；merge／revert 後再主動 start service 會形成無法歸因的第二次部署 invocation。
- 任務 1 發生在 coordinator 建立前，不能把尚未存在的 `action_log`、production driver 或舊 sweep 當成 bootstrap 執行者。
- user09 沒有可靠的完成摘要可確認修改內容、驗證方式與目前 live revision。

## 目標檔案結構

| 路徑 | 責任 |
| --- | --- |
| `sim/production.ts` | 安全的 CLI 進入點：預設 dry-run；授權後使用 `--once --live` 執行 tick；以 `--status` 檢查 heartbeat。 |
| `sim/production/types.ts` | 共用 coordinator、task run、action、decision、CI 與 completion 型別。 |
| `sim/production/state.ts` | SQLite schema、lease、checkpoint、action 冪等、CI cache、tick heartbeat 與 completion outbox。 |
| `sim/production/api.ts` | Cookie auth、短生命週期 HTTP request、安全操作重試、mutation readback 與穩定 comment ID。 |
| `sim/production/policy.ts` | Workspace allowlist、task 分類驗證、WIP1、變更 fingerprint、queue 優先序與卡關規則。 |
| `sim/production/git.ts` | 每個 task 的 worktree、安全 stage、scope 驗證、CI cache key、整合 merge 與 revert。 |
| `sim/production/agent.ts` | 有界限的 Owner／member prompt 與 runner invocation；不執行機械式狀態轉移。 |
| `sim/production/completion.ts` | 完成留言、user09 notification readback、Done 轉移、Discord 摘要與重試狀態。 |
| `sim/production/coordinator.ts` | 單次 tick orchestration 與錯誤彙整。 |
| `sim/production/migrate.ts` | 唯讀 cutover manifest 與現有卡關 task 的冪等 reconciliation。 |
| `sim/production.test.ts` | 所有正式環境模組的純單元測試與 fixture 測試。 |
| `sim/production.integration.test.ts` | 使用暫存 DB、HTTP server 與 Git repository 的 no-AI end-to-end 測試。 |
| `deploy/sim-coordinator.service` | One-shot live coordinator service；安裝後保持 disabled。 |
| `deploy/sim-coordinator.timer` | 非 persistent 的 15 分鐘 timer。 |

## 任務 1：讓主協作工作區結案符合已核准政策

**檔案：**
- 修改：`src/mainDiscussion.ts`
- 修改：`src/schema.ts`
- 修改：`src/mainWorkspacePolicy.ts`
- 修改：`src/mainDiscussion.test.ts`
- 修改：`src/task.test.ts`
- 修改：`src/mainWorkspace.test.ts`
- 修改：`docs/api.md`

**唯一執行綁定與 bootstrap driver：** 本任務只對應既有看板 task `00123ef0-81cb-410e-aed1-d6d1fb925ed6`，不得另建重複 task。任務 1 的 driver 是**一個具備 board mutation 授權的互動式 Claude Code session**，不是尚未完成的 production coordinator，也不是舊 `sim/run.ts`。該 session 一人分飾三角，但角色邊界必須在 transcript 中分開記錄：

- **實作者（掛在 user03 名下）**：在固定 task branch/worktree 內完成程式修改、測試與 commit。user03 是這筆 task 在看板上的唯一 accountable assignee。
- **Driver（機械式操作）**：執行單欄位 PATCH、readback、Git merge、等待部署、發完成留言。所有副作用由此角色執行，且每一步都要 readback。
- **Owner（canonical `user01@test.local`）**：審查 exact head 後留下結構化 acceptance record。不得在實作完成前預先寫好 acceptance。

因為是互動式 session，git 與 systemd 寫入可即時取得人工核可，這正是選它而非 cron 的原因；**不得**把本任務改在非互動環境執行，否則 `git merge`／`systemctl` 會卡在無人可核可的提示上。session 中斷後以 `evidence.json` 與權威 readback 續跑，不得從頭重做已完成的副作用。

由於 coordinator `action_log` 要到任務 2 才建立，本任務不得假設已有 action-key 冪等能力，也不得臨時新增另一套權威 ledger。取得授權後，bootstrap driver 建立 Git 已忽略的 `sim-logs/task1-bootstrap/<run-id>/evidence.json` 作為操作 transcript；權威仍是 API audit/comment/notification、Git ancestry 與 live health readback。紀錄至少包含：`task1AuthorizedAt`、task ID、canonical Owner ID、user03 canonical ID、task aggregate baseline version、assignment event ID／version、branch／base SHA、accepted head、Owner acceptance ID、merge SHA、live rev、completion comment ID 與 user09 notification ID。任何 response 不確定時先查權威 readback，再更新 transcript，不得靠 transcript 推定副作用已成功。

Owner 先 GET task 與 audit，並解析 `user03@test.local` 的 canonical user ID。若 task 是 Todo／unassigned，只送出一次 assignee PATCH；response 不確定時先重新 GET task／audit，不得盲目重送。若 task 已是 Todo／user03，只有在造成目前 projection 的 `task.assignee_changed` event 是本次 `task1AuthorizedAt` 之後由 canonical Owner 產生時才可沿用且不再 PATCH；授權前的舊 event 不得採納。兩種路徑都必須 read back 唯一 assignment event，驗證 actor ID 是 canonical Owner、payload 是 user03 canonical ID、aggregate version 與 baseline 可追溯，並保存 event ID／version；若為其他 assignee／status、event 缺漏／重複，或 readback 不一致，立即停止並交由人工判斷。完成上述證據後，才以另一個單欄位 PATCH 執行 Todo -> Doing 並 read back。

bootstrap driver 以 user03 accountable assignee 的執行身分，只能在從當時 master 建立、初始 diff 為空的 `sim/task/00123ef0-81cb-410e-aed1-d6d1fb925ed6` branch 與 `sim-work/tasks/00123ef0-81cb-410e-aed1-d6d1fb925ed6` worktree 實作；不得帶入任何 legacy branch、commit、dirty diff 或檔案。後續 cutover 只接受這條執行鏈留下的完成證據，不得再次指派 user03、建立 branch 或呼叫 Owner／member AI。

- [x] **步驟 1：把可變討論期限測試改為固定 24 小時。**

加入涵蓋以下契約的斷言：

```ts
const ONE_DAY_REQUEST = `【全員回覆：24小時】
@user02 @user03 @user04 @user05 @user06 @user09
請在固定期限內提出意見。`;

assert.deepStrictEqual(opened, {
  taskId: 'task-1',
  ownerThoughtCommentId: 'task-1-thought',
  requestCommentId: 'task-1-request',
  openedAt: OPENED_AT,
  waitHalfDays: 2,
  dueAt: '2026-07-15T08:00:00.000Z',
});
```

同時證明：期限前結案必須失敗；期限後即使沒有 `【確認結論】` 也能成功；缺席或零回覆不阻擋；`【未達共識】` 會直接 Done 且不建立 target task；implement outcome 必須在決議後至少有一筆 Owner handoff。`src/mainWorkspace.test.ts` 必須同步斷言政策文字只描述固定 24 小時，不再出現 2 至 7 天或 confirmation 要求。

再加入兩條 parser boundary fixture：

```ts
const LEGACY_REQUEST = `【全員回覆：2天】
@user02 @user03 @user04 @user05 @user06 @user09
請在期限內提出意見。`;
```

- 既有 window 的 DB row 為 `waitHalfDays: 4` 且 request comment 是上述舊 marker 時，到期後仍可完成收尾；這是 `10e65231...` 的唯讀相容回歸測試。
- 嘗試用同一舊 marker 建立新 window 時必須失敗，錯誤為 `全員回覆期限固定為 24 小時`；唯讀相容不得重新開放可變期限。

- [x] **步驟 2：執行 focused test，確認舊行為會失敗。**

執行：`npx tsx src/mainDiscussion.test.ts`

預期：FAIL，因為目前建立 parser 不接受 `24小時`，而且仍要求 confirmation 證據；實作若只把舊 regex 直接換掉，legacy closure fixture 也會失敗。

- [x] **步驟 3：實作固定期限，移除自然語句 confirmation parsing。**

使用以下 constant 與 outcome 結構：

```ts
const FIXED_WAIT_HALF_DAYS = 2;
const FIXED_WAIT_MS = 24 * 60 * 60 * 1000;

export interface MainDiscussionImplementationTask {
  workspaceName: string;
  taskName: string;
}

export interface MainDiscussionConcludedPayload {
  status: 'Done';
  outcome: MainDiscussionOutcome;
  windowOpenedAt: string;
  windowDueAt: string;
  ownerThoughtCommentId: string;
  requestCommentId: string;
  decisionCommentId: string;
  confirmationCommentId: null;
  handoffCommentId: string | null;
  implementationWorkspaceName: string | null;
  implementationTaskName: string | null;
  implementationTasks: MainDiscussionImplementationTask[];
}
```

Server 可以解析由 Owner 控制的 `【結論】`、`【結論：不實作】`、`【未達共識】` 與 `【實作任務】` audit marker，但不得把一般 member／user09 文字解讀成核准。以第一筆 handoff 保留舊的 singular handoff 欄位，使歷史 audit reader 維持相容。

Request marker 必須分成兩個不共用 command path 的 parser：

```ts
const FIXED_REQUEST_MARKER = /^【全員回覆：24小時】(?:\r?\n|$)/u;
const LEGACY_REQUEST_MARKER = /^【全員回覆：(\d+(?:\.5)?)天】(?:\r?\n|$)/u;

function parseNewWaitHalfDays(content: string): number | null;
function parseStoredWaitHalfDays(content: string): number | null;
```

`recordMainDiscussionWindowForComment()` 只能呼叫 `parseNewWaitHalfDays()`：fixed marker 回傳 `2`；遇到 legacy marker 拋 `CommandError('全員回覆期限固定為 24 小時')`；其他留言回傳 `null`。`resolveMainDiscussionConclusion()` line 295 的 request readback 改呼叫 `parseStoredWaitHalfDays()`，接受 fixed marker `2` 或歷史 legacy marker；legacy 數值仍驗證 2～7 天、0.5 天遞增，超過 2 天仍要求 `較長期限理由`，並保留原本 `全員回覆期限必須是 2 到 7 天，並以 0.5 天遞增`／`超過 2 天必須填寫較長期限理由` 錯誤。收尾必須繼續比較解析值與 DB `window.waitHalfDays`，不能只信 DB、也不能修改歷史 comment。

同步更新 `src/mainWorkspacePolicy.ts` 與 `docs/api.md` 的使用者可見契約：窗口固定為連續 24 小時、不可提前結案、缺席不阻擋、到期後不要求 `【確認結論】`。不得保留會讓 Owner 或使用者繼續採用舊 2 至 7 天流程的說明。

- [x] **步驟 4：遷移 SQLite constraint，不改變歷史 due date。**

將新表驗證改為允許 `wait_half_days BETWEEN 2 AND 14`。新增冪等 schema migration：只有在既有資料表的 `sqlite_master.sql` 仍含 `BETWEEN 4 AND 14` 時才重建，並原樣複製所有既有資料列。

- [x] **步驟 5：執行 focused 與 domain tests。**

執行：

```bash
npx tsx src/mainDiscussion.test.ts
npx tsx src/task.test.ts
npx tsx src/mainWorkspace.test.ts
npx tsc --noEmit
```

預期：全部 PASS。

- [x] **步驟 6：提交、驗收、部署並完成唯一的看板 task。**

```bash
git add src/mainDiscussion.ts src/schema.ts src/mainWorkspacePolicy.ts src/mainDiscussion.test.ts src/task.test.ts src/mainWorkspace.test.ts docs/api.md
git commit -m "fix: simplify main discussion closure" -m "Task-Id: 00123ef0-81cb-410e-aed1-d6d1fb925ed6"
```

bootstrap driver 在固定 task branch 產生 head SHA 後，必須再次執行步驟 5 的 focused／domain tests，並確認 commit trailer、file scope、乾淨 worktree 與初始空白 diff 證據都只屬於 `00123ef0...`。通過後，driver 先以單欄位 PATCH 執行 Doing -> Review 並 read back；Owner 只能針對該 task branch 的 exact head SHA 作出結構化 acceptance。driver 以 task ID／head SHA 組成穩定 marker，將 acceptance 持久化為可 read back 的 comment／record；response 不確定時先查 marker，並保存 acceptance ID 與內容 readback。

驗收通過後，先要求 `sim-autodeploy.path` active、`sim-autodeploy.service` inactive，並用 `systemctl --user show sim-autodeploy.service --property=InvocationID --property=ExecMainStartTimestampMonotonic --property=Result --property=ExecMainStatus` 保存 invocation baseline。再依 `docs/operations.md` 以保留 accepted head 為 ancestor 的 merge 合併至 master；merge ref change 會自動觸發 deploy，bootstrap driver 只能等待 start timestamp 增加的那一輪 service 結束，不得另行 `start`／`restart sim-autodeploy.service` 或直接 restart `task-tracker.service`。只有該輪 `Result=success`、`ExecMainStatus=0`，且 `/api/health` 回 HTTP 200、`status=ok`、`db=true`、live rev 等於該 merge 或包含該 merge 的後代，才算部署 readback 成功。

部署 readback 成功後，driver 以 `Task-Id`、assignment audit event ID 與 accepted head 組成穩定 completion marker；POST 前與 response 不確定時都先列出 comments，只有 marker 不存在時才能送出 `【SYSTEM完成】 @user09` 留言。留言內容列出功能修改、驗證命令、Task 1 授權時間／canonical Owner ID、assignment audit event ID、task branch、accepted head、Owner acceptance ID、merge SHA 與 live rev；確認對應 notification 的 source comment ID 指向該留言、recipient 是 user09，且不得代替 user09 標示已讀。最後才以單欄位 PATCH 執行 Review -> Done 並 read back。任一證據缺漏或無法串成同一條證據鏈時，`00123ef0...` 保持目前狀態，不得視為任務 1 完成，也不得進入 cutover。

## 任務 2：新增協調器型別與可持久化 SQLite 狀態

**前置：** 任務 2 至 10 全部在 `feature/production-coordinator` 上進行。開工前先確認 master 已含任務 1 的 accepted merge，再建立分支：

```bash
git checkout master
git pull --ff-only 2>/dev/null || true
git checkout -b feature/production-coordinator
```

分支上的 commit 不改動 master ref，因此不觸發 `sim-autodeploy`；在任務 10 合併前，線上服務始終停在任務 1 的版本。

**檔案：**
- 新增：`sim/production/types.ts`
- 新增：`sim/production/state.ts`
- 新增：`sim/production.test.ts`

- [x] **步驟 1：撰寫會失敗的 state tests。**

測試 `LEASE_TTL_MS`（45 分鐘）嚴格大於 `DEPLOY_WAIT_TIMEOUT_MS`（35 分鐘）——這條斷言必須直接比較兩個常數，避免日後單獨調高 deploy 逾時而悄悄製造雙 coordinator。另測試 task lease 只能被 claim 一次、過期 lease 可重新 claim、重複 action key 會被拒絕、成功 checkpoint 在重新開啟資料庫後仍存在、CI 結果以 base／head／command hash 作為 key，而且 completion attempt 最多三次。另驗證 `queued` task 可持久化 `workerId=null`、`branch=null`；重新開啟 DB 後仍不得取得執行 lease 或建立 AI action，且只能由固定 release condition 或新的人工決策轉出 queued。

- [x] **步驟 2：執行 focused test，確認 import 失敗。**

執行：`npx tsx sim/production.test.ts`

預期：FAIL，因為 `sim/production/state.ts` 尚不存在。

- [x] **步驟 3：定義穩定的內部型別。**

```ts
export type WorkPhase =
  | 'queued'
  | 'assigned'
  | 'doing'
  | 'review'
  | 'integrating'
  | 'deployed'
  | 'done'
  | 'human_blocked';

export type ActionOutcome =
  | 'progressed'
  | 'no_change'
  | 'retryable_failure'
  | 'human_blocked';

export interface TaskRun {
  taskId: string;
  workspaceId: string;
  phase: WorkPhase;
  workerId: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  evidenceFingerprint: string;
  noProgressCount: number;
  ownerIntervened: boolean;
  leaseUntil: string | null;
  updatedAt: string;
}
```

- [x] **步驟 4：建立 coordinator schema。**

`openCoordinatorState(path)` 必須在 transaction 中建立以下資料表：

- `task_runs`：以 `task_id` 為 key。
- `action_log`：以 deterministic `action_key` 為 key。
- `ci_runs`：以 `base_sha + head_sha + commands_hash` 為 key。
- `completion_outbox`：以 `completion_id` 為 key。
- `ticks`：以 `tick_id` 為 key，保存 start／end／outcome／counts／error。
- `coordinator_meta`：保存 schema version 與 cutover generation。

`workerId` 只表示 coordinator 當次執行者；看板的 status／assignee／version 必須保留在 API `TaskSnapshot` 與 cutover manifest，不得混入 `TaskRun`。提供具型別的函式，處理 lease claim／release、task checkpoint upsert、action begin／complete／fail、CI lookup／store、completion enqueue／attempt，以及 tick begin／end。

- [x] **步驟 5：執行測試與 typecheck。**

執行：

```bash
npx tsx sim/production.test.ts
npx tsc -p sim/tsconfig.json --noEmit
```

預期：PASS；重新開啟暫存 DB 後，所有已 commit 資料列仍存在。

- [x] **步驟 6：提交 state foundation。**

```bash
git add sim/production/types.ts sim/production/state.ts sim/production.test.ts
git commit -m "feat(sim): add durable coordinator state"
```

## 任務 3：新增具復原能力的 API client 與純 scheduling policy

**檔案：**
- 新增：`sim/production/api.ts`
- 新增：`sim/production/policy.ts`
- 修改：`sim/production.test.ts`

- [x] **步驟 1：新增會失敗的 HTTP 與 policy tests。**

使用暫存 `node:http` server，在第一次 login 時主動中斷 socket，第二次 request 才成功。驗證安全 request 會重試、`error.cause` 會保留、mutation 結果不確定時會先 readback 而非盲目重送，而且單一 workspace 失敗不會阻擋另一個 workspace 的 action。

Policy fixture 必須證明：

- 只會發現兩個已鎖定的 workspace UUID。
- 排除 `[規則] 主工作區協作與交接` 與 canonical `[討論] 方向與下一步`。
- 已指派 Doing 優先於 Todo；Review 驗收優先於新派工。
- 每位 member 只取得一個非 blocked WIP task。
- Fixed cutover disposition 優先於一般 Review／Doing／Todo 排序；不受同狀態 task 的 `updated_at` 影響。
- `938aa035-5f96-4908-b28b-876fa4735061` 是 user06 唯一可執行 action。
- `6384b6f4-f92f-45a2-a5e1-133f04f76372` 在 cutover 後為 Todo／unassigned，checkpoint 是 queued，不建立 Review、member、branch 或 Owner action；即使排程看到它是 Todo，也不得因「未指派可執行 Todo」而觸發 Owner 派工。
- `00123ef0-81cb-410e-aed1-d6d1fb925ed6` 只接受任務 1 的同一條完成證據鏈：assignment audit event 必須在本次 Task 1 授權後由 canonical Owner 產生，且 payload 是 user03 canonical ID；accepted head 位於固定 task branch 且含 `Task-Id` trailer；具可 read back ID 的 Owner acceptance 引用該 exact head；accepted merge 保留該 head 為 ancestor；live rev 等於 accepted merge 或其後代；`【SYSTEM完成】` 留言引用同一組授權／assignment event／acceptance／head／merge／live rev；user09 notification 的 source comment ID 指向該留言。狀態還必須為 Done。全部符合時不產生任何 action；任一環節缺漏或不相符時回傳 `CutoverPrerequisiteMissing`，且整批 task／Git／AI cutover mutation 必須為零。
- `027c0052-46d5-4da7-90fa-dd8efb2219fc` 在 `938aa035...` 尚未 Done 時保持 queued／unassigned；Done readback 後只產生指派 user05 的 action。
- 上述結果在 coordinator restart 後不變，且任何 member 都不超過 WIP1。
- 尚未到期且沒有變更的主討論，不會建立 Owner action。

- [x] **步驟 2：執行 focused test，確認失敗。**

執行：`npx tsx sim/production.test.ts`

預期：FAIL，因為 API 與 policy module 尚不存在。

- [x] **步驟 3：實作短生命週期 HTTP request。**

以 `node:http.request` 建立 `TaskTrackerClient`，設定 `agent: false`、明確 timeout、cookie jar 與 JSON／status 驗證。Health、login 與 GET 遇到暫時性 socket／timeout／5xx 失敗時可重試。Comment 與 PATCH request 必須使用穩定 action key；response 不確定時先讀取 resource，再決定是否重試。

必要 method：

```ts
health(): Promise<{ status: string; db: boolean; rev: string }>;
login(email: string, password: string): Promise<void>;
getTask(taskId: string): Promise<TaskSnapshot>;
listWorkspaceTasks(workspaceId: string): Promise<TaskSnapshot[]>;
listComments(taskId: string): Promise<CommentSnapshot[]>;
postCommentOnce(taskId: string, content: string, actionKey: string): Promise<string>;
patchTaskField(taskId: string, field: 'status' | 'assignee', value: unknown): Promise<TaskSnapshot>;
listNotifications(): Promise<NotificationSnapshot[]>;
```

- [x] **步驟 4：實作 deterministic policy functions。**

匯出以下 pure functions：

```ts
validateOwnerClassification(input: OwnerClassification): WorkClass;
taskEvidenceFingerprint(input: TaskEvidence): string;
selectCoordinatorActions(snapshot: CoordinatorSnapshot, now: Date): CoordinatorAction[];
recordMemberAttempt(run: TaskRun, evidenceChanged: boolean): TaskRun;
shouldResumeHumanBlocked(run: TaskRun, snapshot: TaskEvidence): boolean;
```

若 task 無法明確證明是在恢復既有文件行為、進行不影響使用者的維護，或引用已核准 discussion／user09 決策，classification 預設為 `new-feature`。Provider／network failure 永遠不增加 `noProgressCount`。

Discovery 必須以 ID／canonical title 雙重規則排除 `CUTOVER_TASKS.mainPolicy`（`[規則] 主工作區協作與交接`）與 `CUTOVER_TASKS.legacyCanonicalDiscussion`（canonical `[討論] 方向與下一步`），這兩筆永遠不產生 Owner／member／branch action。`mainDiscussionNeedsOwner(status)` 不得再作為 production policy：只有 evidence fingerprint、期限事件或新留言使 snapshot 發生可執行變化時才建立主討論 Owner action；未變更的 Todo 必須保持零 action。

- [x] **步驟 5：執行 focused tests 與 typecheck。**

```bash
npx tsx sim/production.test.ts
npx tsc -p sim/tsconfig.json --noEmit
```

預期：PASS。

- [x] **步驟 6：提交 API 與 scheduling policy。**

```bash
git add sim/production/api.ts sim/production/policy.ts sim/production.test.ts
git commit -m "feat(sim): add resilient API scheduling"
```

## 任務 4：將每個 Task 隔離在自己的 Git Worktree

**檔案：**
- 新增：`sim/production/git.ts`
- 修改：`sim/production.test.ts`

- [x] **步驟 1：新增會失敗的暫存 repository tests。**

證明 active task `938aa035-5f96-4908-b28b-876fa4735061` 會對應到 branch `sim/task/938aa035-5f96-4908-b28b-876fa4735061` 與 worktree `sim-work/tasks/938aa035-5f96-4908-b28b-876fa4735061`。驗證 queued 的 `6384b6f4-f92f-45a2-a5e1-133f04f76372` 在解除依賴前不得建立 branch／worktree；解除後必須以包含 `938aa035...` accepted merge 的新 master 為 base，且不能共用第一個 task 的 branch。暫存檔與 `node_modules` symlink 必須被拒絕，而且只 stage 已通過驗證的路徑。`sim/user02` 至 `sim/user06` 的舊 branch／worktree／SHA 只能進 manifest，不能作為 base、source、Git command 參數或 member prompt context；新 worktree 的初始 diff 必須為空。

- [x] **步驟 2：執行 focused test，確認失敗。**

執行：`npx tsx sim/production.test.ts`

預期：FAIL，因為 `sim/production/git.ts` 尚不存在。

- [x] **步驟 3：實作 task branch 與安全變更 helper。**

匯出：

```ts
taskBranchName(taskId: string): string;
taskWorktreePath(repoRoot: string, taskId: string): string;
ensureTaskWorktree(repoRoot: string, taskId: string, baseSha: string): Promise<TaskWorktree>;
collectTaskChanges(worktree: string): Promise<ChangedPath[]>;
validateTaskChanges(changes: ChangedPath[], allowedPrefixes: string[]): void;
commitTaskChanges(worktree: string, taskId: string, title: string, paths: string[]): Promise<string>;
ciCacheKey(baseSha: string, headSha: string, commands: string[]): string;
```

`commitTaskChanges` 必須呼叫 `git add -- <validated paths>` 與 `git diff --cached --check`，且永遠不得呼叫 `git add -A`。拒絕 `.jar-*`、`.tmp-*`、`data/`、`node_modules`、宣告 scope 以外的檔案，以及未被 task 明確允許該精確路徑的任何新 symlink。

- [x] **步驟 4：新增 command allowlist 與 CI cache 行為。**

Member verification command 只允許以下形式：

- `npx tsc --noEmit`
- `npx tsc -p sim/tsconfig.json --noEmit`
- `npx tsx src/<name>.test.ts`
- `npx tsx sim/<name>.test.ts`
- `npm test`
- `npm run build`
- `git diff --check`

只 cache 成功結果，並把完整 command list 納入 key。

- [x] **步驟 5：執行測試與 typecheck。**

```bash
npx tsx sim/production.test.ts
npx tsc -p sim/tsconfig.json --noEmit
```

預期：PASS。

- [x] **步驟 6：提交 Git 隔離功能。**

```bash
git add sim/production/git.ts sim/production.test.ts
git commit -m "feat(sim): isolate work by task"
```

## 任務 5：新增有界限的 Owner／Member Session 與副作用驗證

**檔案：**
- 新增：`sim/production/agent.ts`
- 修改：`sim/production/coordinator.ts`
- 修改：`sim/production.test.ts`

- [x] **步驟 1：新增 false-success session 的失敗測試。**

Fixture 必須涵蓋：exit 0 但沒有 diff／comment／status 變更；產生有效 diff 後 exit 1；member 有 commit 卻沒有 Review transition；重複 blocker 文字；以及試圖編輯程式的 Owner output。只有完整具備預期證據時才能回傳 `progressed`。

- [x] **步驟 2：執行 focused test，確認失敗。**

執行：`npx tsx sim/production.test.ts`

預期：FAIL，因為 agent／coordinator module 尚未完成。

- [x] **步驟 3：定義結構化 session output。**

```ts
export interface MemberSessionOutput {
  summary: string;
  changedPaths: string[];
  verificationCommands: string[];
  blocker: string | null;
}

export interface OwnerDecision {
  action: 'classify' | 'dispatch' | 'intervene' | 'accept' | 'reject' | 'conclude-discussion';
  rationale: string;
  evidenceCommentIds: string[];
  classification?: 'bug' | 'maintenance' | 'approved' | 'new-feature';
  outcome?: 'implement' | 'no_implementation' | 'no_consensus';
}
```

Prompt 只提供一個 task ID、其 acceptance criteria、相關 comments、已宣告 file scope、verification command allowlist 與 task worktree，並禁止另選 task。Owner prompt 為 read-only，且明確把 API mutation、Git merge、部署與留言交給 driver。

- [x] **步驟 4：實作 session 後證據檢查。**

Member 成功必須具備通過驗證的 task commit、focused verification PASS、由 driver 建立的摘要留言，以及 driver 對 Doing -> Review 的 readback。Owner acceptance 必須是引用已審查 head SHA 的結構化決策；process exit 只供診斷。

- [x] **步驟 5：實作卡關轉移。**

兩次完整 member attempt 都沒有進展後，enqueue 一次 Owner intervention。介入後只再允許一次 member attempt；若證據仍無變化，持久化 `human_blocked`、留下唯一含 action key 的 `@user09` 留言、保留 task status／assignee，並停止後續 AI action，直到出現新的 user09 comment 或尚未記錄的人工 task mutation。

- [x] **步驟 6：執行測試並提交。**

```bash
npx tsx sim/production.test.ts
npx tsc -p sim/tsconfig.json --noEmit
git add sim/production/agent.ts sim/production/coordinator.ts sim/production.test.ts
git commit -m "feat(sim): verify agent side effects"
```

## 任務 6：新增整合、部署 Readback 與自動 Revert

**檔案：**
- 修改：`sim/production/git.ts`
- 修改：`sim/production/coordinator.ts`
- 修改：`sim/production.test.ts`

- [ ] **步驟 1：以注入的 command result 新增會失敗的 integration／deployment tests。**

涵蓋：branch CI failure、integration conflict、full test failure、merge 前 build failure、`sim-autodeploy.path` inactive、merge 前 service 尚 active、merge 後沒有新 invocation、path-triggered invocation failure、health rev mismatch、成功 revert 並由另一個新 invocation 恢復 health，以及 revert 部署失敗後停止全部後續 live action。測試要證明 coordinator 從不呼叫 `systemctl start sim-autodeploy.service`，而且不能把先前 invocation 或第二次重試誤認為目前 generation 的成功。

逾時分支另需三筆 fixture：invocation 因 `pgrep sim/run.ts` 等待而在 34 分鐘後才成功時不得逾時；逾時且 `deployedRev`／health rev 都等於 target SHA 時視為成功並標記 `deployObservedOutOfBand=true`；逾時且 `deployedRev` 不符但 service 仍 active 時回傳 `DeploymentIndeterminate`，該 tick 零 revert、零 status change、零 completion comment，下一個 tick 以同一 target SHA 重新 readback 後可成功收斂。

- [ ] **步驟 2：執行 focused test，確認失敗。**

執行：`npx tsx sim/production.test.ts`

預期：FAIL，因為 acceptance／deploy functions 尚不存在。

- [ ] **步驟 3：實作固定 acceptance sequence。**

```text
task branch CI
  -> temporary integration worktree
  -> npm test
  -> npm run build
  -> git diff --check
  -> task-specific acceptance
  -> require sim-autodeploy.path active and sim-autodeploy.service inactive
  -> snapshot InvocationID / ExecMainStartTimestampMonotonic
  -> merge --no-ff
  -> wait <= 35 min for exactly one newer path-triggered invocation to finish
     (timeout -> resolve by deployed_rev/health rev, see 步驟 5)
  -> GET /api/health
  -> require invocation Result=success / ExecMainStatus=0,
     deployed_rev=master HEAD, HTTP 200, status=ok, db=true, rev=master HEAD
  -> task live acceptance
```

部署 revision 通過 readback 前，不得變更任何 task status 或 completion comment。

- [ ] **步驟 4：實作失敗復原。**

若 merge 後失敗，必須先確認 `master HEAD === mergeSha`、等待失敗 invocation 已結束，再擷取新的 invocation baseline，執行 `git revert -m 1 --no-edit <mergeSha>`，並等待 revert ref change 觸發的下一個且唯一的新 invocation；要求該 invocation 成功、`deployed_rev` 與 health rev 都等於 revert commit。Revert 的等待沿用步驟 5 的 35 分鐘逾時與同一套逾時決議：逾時且兩個 rev 都已等於 revert commit 視為 rollback 成功；逾時且 service 仍 active 回傳 `DeploymentIndeterminate`，該 tick 不升級為 fatal，下一個 tick 以同一 revert SHA 重新 readback。Task 維持 Review，並留下去重的 deployment-rollback comment。只有在 rollback invocation 明確失敗，或 `DeploymentIndeterminate` 連續兩個 tick 仍未收斂時，才記錄 fatal coordinator error 並拒絕後續所有 AI／mutation action。

- [ ] **步驟 5：以 path invocation generation 實作唯一部署 readback。**

在 `sim/production/git.ts` 定義可注入的 systemd readback adapter，至少回傳 `pathActive`、`serviceActiveState`、`invocationId`、`execMainStartTimestampMonotonic`、`result`、`execMainStatus` 與 `deployedRev`。merge／revert 前都先要求 path active 且 service inactive，再保存 baseline；ref 變更後輪詢直到看到 start timestamp 增加且該 invocation 結束。`Result != success`／`ExecMainStatus != 0` 立即回傳該 target SHA 的 deployment failure。不得主動 start service，也不得在失敗後補跑第二輪來掩蓋 path invocation 的結果。

等待逾時固定為 35 分鐘（`DEPLOY_WAIT_TIMEOUT_MS = 35 * 60 * 1000`），必須大於 `sim-autodeploy.sh` 最長 30 分鐘的 `pgrep sim/run.ts` 等待，否則正常部署會被誤判失敗。逾時後不得直接判為 deployment failure，必須改以最終狀態決議：

- `deployedRev === targetSha` 且 health rev `=== targetSha`：視為成功（invocation 由遺漏觸發後的人工 start 或延遲 readback 完成），記錄 `deployObservedOutOfBand=true`。
- `deployedRev !== targetSha` 且 service 仍 active：回傳 `DeploymentIndeterminate`，不 revert、不改 task status、不留 completion comment，等下一個 tick 以同一 target SHA 重新 readback。
- `deployedRev !== targetSha` 且 service 已 inactive：確認 `.path` 觸發遺漏，回傳該 target SHA 的 deployment failure，進入步驟 4 的 revert 流程。

`.path` 觸發遺漏是已知殘餘風險，因為 inotify 對 ref rename 與密集 merge／revert 的合併行為不保證每次都送出事件。coordinator 永遠不主動 start service；operator 可手動 `systemctl --user start sim-autodeploy.service`，`sim-autodeploy.sh` 的 `[ "$HEAD" = "$DEPLOYED" ] && exit 0` 讓手動啟動冪等。coordinator 下一個 tick 只比對 `deployed_rev` 與 health rev，不要求該輪 invocation 由自己觀察到，因此人工介入不會讓 checkpoint 卡死。

本任務不修改 `deploy/sim-autodeploy.sh`，並保留 line 13～17 對 `tsx sim/run.ts` 的 wait。共用 run lock 只防 sim process 彼此重疊，不能保護 in-flight 舊 sweep 不被 task-tracker restart 打斷；production coordinator 也不能加入 `pgrep sim/production.ts`，否則會和自己等待的 deploy 形成循環等待。

- [ ] **步驟 6：執行測試並提交。**

```bash
npx tsx sim/production.test.ts
npm test
npm run build
git diff --check
git add sim/production/git.ts sim/production/coordinator.ts sim/production.test.ts
git commit -m "feat(sim): gate completion on live deploy"
```

## 任務 7：新增完成通知與 Discord Outbox

**檔案：**
- 新增：`sim/production/completion.ts`
- 修改：`sim/production/state.ts`
- 修改：`sim/production/coordinator.ts`
- 修改：`sim/production.test.ts`

- [ ] **步驟 1：新增會失敗的 completion-order tests。**

證明：notification 前 completion row 已持久化；不確定的 comment response 可透過 action key 找回；user09 notification readback 早於 Done；status failure 不會重複留言；同一 tick 的所有新 completion 形成單一 batch；Discord 最多嘗試三次；最後 Discord 仍失敗時 task 保持 Done。

- [ ] **步驟 2：執行 focused test，確認失敗。**

執行：`npx tsx sim/production.test.ts`

預期：FAIL，因為 completion module 尚不存在。

- [ ] **步驟 3：實作 completion comment contract。**

```text
【SYSTEM完成】 @user09
TASK：<task title>（<task id>）
功能／修改：<owner-approved summary>
驗證：<focused tests + integration + live acceptance>
Commit：<accepted head/merge sha>
部署版本：<health rev>
執行識別：<completion id>
```

使用 `completion_id = task_id + ':' + accepted_head_sha`。以 user01 發文後 GET comment readback，再以 user09 登入並讀取 notifications，但不標記任何項目為已讀；確認存在相符 notification row 後，才能 PATCH Review -> Done。

- [ ] **步驟 4：實作摘要重試語意。**

Tick 結束時，只把新完成 task 合併到一個穩定 `batch_id`。該 tick 嘗試傳送 Discord 一次；失敗時，在接下來兩個 coordinator tick 各重試一次。第三次失敗後設為 `notify_failed`；不得再自動重試、重貼 system comment、重跑 deploy 或變更 Done。

- [ ] **步驟 5：執行測試並提交。**

```bash
npx tsx sim/production.test.ts
npx tsc -p sim/tsconfig.json --noEmit
git add sim/production/completion.ts sim/production/state.ts sim/production/coordinator.ts sim/production.test.ts
git commit -m "feat(sim): report verified completions"
```

## 任務 8：新增安全 CLI、Heartbeat 與單一 15 分鐘 Timer

**檔案：**
- 新增：`sim/production.ts`
- 新增：`deploy/sim-coordinator.service`
- 新增：`deploy/sim-coordinator.timer`
- 新增：`sim/production.integration.test.ts`
- 修改：`package.json`

- [ ] **步驟 1：新增 no-AI integration test。**

使用暫存 SQLite app DB、fake task-tracker HTTP server、fake agent adapter 與暫存 Git repo。執行一個 tick，從 Todo assignment 走到 Review 及模擬 deployment／completion；重新開啟 state 後，證明第二個 tick 不會建立重複副作用。

- [ ] **步驟 2：執行 integration test，確認失敗。**

執行：`npx tsx sim/production.integration.test.ts`

預期：FAIL，因為 production entry point 尚不存在。

- [ ] **步驟 3：實作安全 CLI 模式。**

- `npx tsx sim/production.ts --once` 執行唯讀 discovery 並列印 planned action；不可呼叫 AI 或 mutation。
- `npx tsx sim/production.ts --once --live` 允許 AI 與 mutation，只供明確人工授權或 systemd 使用。
- `npx tsx sim/production.ts --status` 列印最後一個 tick；若 30 分鐘內沒有成功 heartbeat 且不存在有效 active lease，則以非零碼結束。因為 `LEASE_TTL_MS` 大於 deploy 逾時，一個正在等待部署的長 tick 必定仍持有有效 lease，不會被誤判為不健康。

`--once` 是 read-only live discovery，不是離線 fixture：先要求 `task-tracker.service` active、`GET http://localhost:3000/api/health` 為 HTTP 200，並以 canonical Owner `user01@test.local` 與現有 local seed credential 登入，成功 GET 主協作工作區與 task-tracker canonical workspace 後才可計算 disposition。不得把 owner password 寫入 log、manifest 或 error。Exit code 契約固定為：

- `0`：完整 discovery，且 cutover prerequisite ready。
- `2`：完整 discovery，但 `CutoverPrerequisiteMissing`；零 mutation、零 AI。
- `3`：`DiscoveryUnavailable`，包含 service inactive、health 非 200、login 失敗或任一 required workspace GET 失敗；零 mutation、零 AI。
- `1`：未分類程式錯誤。**不保證零 mutation**；下一個 tick 必須以 `action_log` 與權威 readback 重新對帳，不得假設任何 planned mutation 的完成狀態。

每個 tick 記錄 scheduled／start／end 時間、app rev、各 workspace 的 discovered／processed／skipped／error 數、AI call、task transition、deploy result、notification result 與 aggregate outcome。獨立 task error 會被彙整；任何 partial failure 都會在所有可安全完成的獨立 action 結束後，使 service 以非零碼結束。

- [ ] **步驟 4：新增 systemd unit，安裝後保持 disabled。**

`deploy/sim-coordinator.service`:

```ini
[Unit]
Description=Task Tracker production sim coordinator
After=task-tracker.service
Requires=task-tracker.service

[Service]
Type=oneshot
WorkingDirectory=/home/hom/code/task-tracker
ExecStart=/home/hom/.nvm/versions/node/v24.3.0/bin/npx tsx sim/production.ts --once --live
Environment=PATH=/home/hom/.nvm/versions/node/v24.3.0/bin:/usr/local/bin:/usr/bin:/bin
```

`deploy/sim-coordinator.timer`:

```ini
[Unit]
Description=Run production sim coordinator every 15 minutes

[Timer]
OnCalendar=*-*-* *:00/15:00
Persistent=false
Unit=sim-coordinator.service

[Install]
WantedBy=timers.target
```

- [ ] **步驟 5：新增 package script 並執行 no-AI 驗證。**

為 CLI 新增 `sim:production`。不得 enable 或 start timer。

```bash
npx tsx sim/production.integration.test.ts
systemctl --user is-active task-tracker.service
curl -fsS http://localhost:3000/api/health
npx tsx sim/production.ts --once
npx tsc -p sim/tsconfig.json --noEmit
```

預期：integration PASS；service 為 active、health HTTP 200；dry-run 必須逐筆列出 `938aa035... -> user06／active`、`6384b6f4... -> queued／unassigned`、`00123ef0... -> 任務 1 已完成前置條件／cutover 無 action`、`10e65231... -> 前置條件通過後機械式結案`、`027c0052... -> 等待 938 Done 後交給 user05`，另列 `mainPolicy`／`legacyCanonicalDiscussion` 為 excluded，但不得建立 comment、task change、branch、AI call 或 deploy。若 `00123ef0...` 的任一完成證據缺漏，dry-run 必須明確回報 `CutoverPrerequisiteMissing`、exit `2` 與零個 planned mutation；server／health／owner login／required workspace readback 不可用時回報 `DiscoveryUnavailable`、exit `3` 與零個 planned mutation。

- [ ] **步驟 6：提交 production entry point。**

```bash
git add sim/production.ts sim/production.integration.test.ts deploy/sim-coordinator.service deploy/sim-coordinator.timer package.json
git commit -m "feat(sim): add production coordinator service"
```

## 任務 9：協調現有卡關 Task，且不重用混雜成果

**檔案：**
- 新增：`sim/production/migrate.ts`
- 修改：`sim/production.test.ts`

- [ ] **步驟 1：新增會失敗的 manifest 與 reconciliation tests。**

Manifest 必須包含 task ID／version／status／assignee、branch head／dirty／ahead state、目前 notification cursor、outbox cursor、舊 timer state、cutover generation、planned disposition、固定 assignee email、coordinator phase、release dependency，以及 `00123ef0...` 的 Task 1 授權時間、canonical Owner ID、assignment baseline version、user03 canonical ID、assignment audit event ID／aggregate version／actor ID、task branch、accepted head／merge SHA、Owner acceptance ID、live rev、`【SYSTEM完成】` comment ID、user09 notification ID、完整證據 fingerprint 與 `readyForApply`。以下四個階段都以 `00123ef0...` 的任務 1 完成證據已通過為前置條件：

1. 初次 apply 先把 `10e65231...` 恰好機械式結案一次，再只啟動 `938aa035...`；`6384b6f4...` 以 Review -> Doing -> Todo -> 清除 assignee 三步退回 Todo／unassigned／queued，沒有 branch、lease 或 AI action，且三步的 action key 各恰好使用一次。
2. 狀態未變時重跑，不能重複 comment、PATCH、branch、assignment、closure 或 action key；`10e65231...` 保持 Done 且不產生第二次 closure。
3. `938aa035...` Done 且 master 已包含其 accepted merge 後重跑，`6384b6f4...` 恰好一次取得 user06、Todo -> Doing，`027c0052...` 恰好一次取得 user05、Todo -> Doing；兩條新 branch 都以當時的新 master 為 base。
4. `938aa035...` 為 `human_blocked`、失敗、Doing 或 Review 時，兩筆 dependent task 都繼續 queued。

另測試 cutover 前置條件：`00123ef0...` 為 Todo／Doing／Review、assignment event 缺漏／重複／早於 Task 1 授權、actor 不是 canonical Owner、payload 不是 user03 canonical ID、aggregate version 無法連回 baseline、task branch 與 accepted head 不符、`Task-Id` trailer 缺漏、Owner acceptance ID 缺漏或引用不同 head、accepted merge 不含該 head、live rev 不含 accepted merge、完成留言引用不同證據、留言缺漏，或 notification 的 recipient／source comment 不符時，必須回傳 `CutoverPrerequisiteMissing`、`readyForApply=false`，而且 task mutation adapter、Git adapter 與 AI adapter 的呼叫數都為零，`10e65231...` 也完全不變。證據完整時，cutover 對 `00123ef0...` 的 assignment、status、comment、branch 與 AI action 也都必須為零；重跑不得重複任務 1 已完成的任何副作用。

Generation-bound preflight fixture 必須再證明：manifest generation 不符、task version／audit cursor／notification cursor／live rev 任一漂移，或 prerequisite fingerprint 改變時 exit 非零，且所有 mutation adapter 呼叫數為零；只有完全相符時才回傳可進入 systemd drain 的明確結果。

Task-specific fixture 必須再證明：

- `938aa035...` 驗收涵蓋冷啟動／重新整理 task URL、目前選到其他 workspace 時仍切到正確 workspace、task modal 與 comment anchor、403／404、既有 `#/tasks` 回歸，以及正式瀏覽器 smoke。
- `6384b6f4...` 的 branch base 已包含 `938aa035...` merge；手機 menu toggle 後 badge 節點仍存在、hidden tab 不執行 60 秒 polling、來源 task／comment 真正開啟成功後才標已讀，並涵蓋 0／1／多筆、403／404、手動已讀與桌機／手機 smoke。
- Fake Git／agent adapter 的 command、diff 與 prompt 不得含 `933b974`、`f94b69e`、`sim/user02` 或 `sim/user06`，證明舊 commit、dirty diff 與檔案沒有被重用。
- `mainPolicy` 與 `legacyCanonicalDiscussion` 都出現在 manifest 的 excluded readback 中，但永遠不建立 checkpoint、lease、Owner／member action、branch 或 mutation。

- [ ] **步驟 2：編碼固定 migration set。**

```ts
export const CUTOVER_TASKS = {
  mainDiscussion: '10e65231-a4b2-4bdb-aab4-9f3c5fb0e916',
  mainPolicy: '27ec8d7e-8605-468c-9f2c-13a80bef2a5a',
  legacyCanonicalDiscussion: '8be538bc-ffc6-4122-9757-026a54ba813f',
  activeReview: {
    taskId: '938aa035-5f96-4908-b28b-876fa4735061',
    assigneeEmail: 'user06@test.local',
    classification: 'bug',
  },
  queuedReview: {
    taskId: '6384b6f4-f92f-45a2-a5e1-133f04f76372',
    assigneeEmail: null,
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  },
  completedPrerequisite: {
    taskId: '00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    implementedByPlanTask: 1,
    implementerEmail: 'user03@test.local',
    taskBranch: 'sim/task/00123ef0-81cb-410e-aed1-d6d1fb925ed6',
    requiredStatus: 'Done',
  },
  deferredAssignment: {
    taskId: '027c0052-46d5-4da7-90fa-dd8efb2219fc',
    assigneeEmail: 'user05@test.local',
    classification: 'approved',
    afterTaskId: '938aa035-5f96-4908-b28b-876fa4735061',
  },
} as const;
```

- [ ] **步驟 3：實作唯讀 manifest 模式。**

預設 invocation 只寫入 Git 已忽略的 `sim-logs/cutover-<timestamp>/manifest.json`。它必須沿同一證據鏈 read back 並計算 `00123ef0...` 的 prerequisite fingerprint、cutover generation 與 `readyForApply`；證據不完整時記錄 `CutoverPrerequisiteMissing`，不得列出任何 task／Git／AI planned mutation。另提供唯讀的 `--preflight --live --expect-generation <generation>`：重新計算 fingerprint，只有 generation 與全部證據仍相符時才 exit 0，否則不得呼叫任何 mutation adapter。不得 reset、remove、clean、commit 或改變舊 worktree。保留 user02 dirty files 與所有舊 branch。

- [ ] **步驟 4：實作經授權且冪等的 reconciliation。**

只有使用 `--apply --live` 時才執行：

- 從 production discovery 排除主協作政策 task 與 legacy canonical discussion。
- 在任何 task、comment、PATCH、checkpoint、branch、Git 或 AI mutation 前，重新 read back `00123ef0...` 的 Done 狀態與完整 fingerprint，逐段驗證 Task 1 授權時間／canonical Owner ID -> 授權後由該 Owner 產生且指向 user03 的 assignment audit event -> 固定 task branch／含 `Task-Id` trailer 的 accepted head -> 具 ID 且引用 exact head 的 Owner acceptance -> 保留 accepted head 為 ancestor 的 merge -> 等於該 merge 或其後代的 live health rev -> 引用同一組授權／ID／SHA 的 `【SYSTEM完成】` 留言 -> source comment 與 recipient 都相符的 user09 notification。cutover 不得變更 `00123ef0...` 的 assignee／status、建立 branch／task／comment，或呼叫 Owner／member AI；任一證據缺漏或 fingerprint 已變即回傳 `CutoverPrerequisiteMissing`，並以零 task／Git／AI mutation 結束。
- 前置條件通過後，以 `10e65231...` 既有的已到期 window、Owner conclusion 與 handoff 完成一次機械式結案，不建立新的 Owner AI action。
- `938aa035...` 保留或恢復 user06 assignee，留一則具固定 action key 的 reset 說明，再以單欄位 PATCH 執行 Review -> Doing；checkpoint 設為 doing，`noProgressCount=0`，並從當時 master 建立乾淨的 per-task branch。
- `6384b6f4...` 退回 Todo／unassigned，避免看板長期停在「Review 但沒有負責人」這種無法解讀的狀態。順序被 domain 鎖死，必須是三次單欄位 PATCH：**(1) Review -> Doing（此時 assignee 仍是 user06，滿足 `src/task.ts:247` 的守衛）→ (2) Doing -> Todo → (3) 清除 assignee**。`Review -> Todo` 不是合法轉換，且一旦先清 assignee 就再也回不到 Doing，會永久卡在 Review。三步各有固定 action key，每步都要 read back；中斷後依 action key 續跑，不得重頭再跑一次。完成後 checkpoint 設為 queued、`workerId=null`、`branch=null`，不得取得 lease、建立 branch 或呼叫 Owner／member AI。中間短暫經過 Doing 期間 coordinator 尚未啟動，不會被排程選中。只有 `938aa035...` Done 且 master 包含其 accepted merge 後，下一個 tick 才依一般流程指派 user06、PATCH Todo -> Doing，並從該新版 master 建立 branch。
- `027c0052...` 固定分類為 approved；在 `938aa035...` 尚未 Done 時維持 Todo、unassigned、queued，不建立 branch 或呼叫 AI。依賴解除後，下一個 tick 依序以單欄位 PATCH 指派 user05、執行 Todo -> Doing，並從包含 `938aa035...` accepted merge 的 master 建立乾淨 branch。
- 不得 merge、cherry-pick、format-patch、apply、copy 或以其他方式帶入任何舊 `sim/user02` 至 `sim/user06` commit、dirty diff 或檔案；舊 branch／worktree／SHA 只寫入 manifest，不得放進 member prompt。每個新 worktree 的初始 diff 必須為空。
- 每個 comment／PATCH／checkpoint／branch action 都使用固定 action key，且任何 mutation 後都必須 read back。
- 不得將任何既有 user09 notification 標示已讀。

- [ ] **步驟 5：執行測試並提交。**

```bash
npx tsx sim/production.test.ts
npx tsc -p sim/tsconfig.json --noEmit
git add sim/production/migrate.ts sim/production.test.ts
git commit -m "feat(sim): add idempotent cutover reconciliation"
```

## 任務 10：更新操作文件並準備 Runtime Cutover

**檔案：**
- 修改：`docs/operations.md`
- 修改：`docs/owner-sweep-guide.md`
- 修改：`design.md`

- [ ] **步驟 1：更新 cutover 前操作文件。**

記錄固定 workspace allowlist、15 分鐘 coordinator、dry-run／live 邊界、live server／canonical Owner credential 前置條件、exit `2`／`3`、ledger／status command、WIP1、discussion policy、human-blocked 行為、task branch、path-triggered autodeploy generation readback、acceptance／deploy／revert sequence、completion digest、安裝後保持 disabled 的規則，以及 rollback procedure。文件必須同時記錄五筆 fixed cutover disposition、兩筆 excluded task、queued 不占 WIP、queued Review 不會觸發 acceptance，以及 `027c0052...`／`6384b6f4...` 只有在 `938aa035...` Done readback 後才解除依賴。另記錄 queued task 的看板狀態一律是 Todo／unassigned（含 `6384b6f4...` 退回 Todo 的固定三步順序）、`LEASE_TTL_MS` 與 `DEPLOY_WAIT_TIMEOUT_MS` 的大小關係，以及 exit `1` 不保證零 mutation 的對帳規則。

- [ ] **步驟 2：明訂舊 sweep 仍是可復原路徑。**

本任務不得修改 `sim/run.ts`、`sim/run.test.ts` 或 `deploy/sim-autodeploy.sh`。Runtime cutover 完成前，舊 Owner／Team scheduling、notification gate、sweep flag 與 `pgrep sim/run.ts` 守衛都要保持可用，否則任務 11 失敗時重新 enable 舊 timers 只會啟動一條已被拆除的路徑。

- [ ] **步驟 3：執行文件與既有 regression gate。**

```bash
npx tsx sim/run.test.ts
npx tsx sim/production.test.ts
npx tsx sim/production.integration.test.ts
npm test
npm run build
git diff --check
```

預期：全部 PASS。

- [ ] **步驟 4：提交 cutover 文件。**

```bash
git add docs/operations.md docs/owner-sweep-guide.md design.md
git commit -m "docs(sim): prepare production coordinator cutover"
```

- [ ] **步驟 5：把 feature branch 合併回 master 並驗證單次部署。**

任務 11 的 systemd unit 指向主 worktree 的 master，因此 coordinator 程式碼必須先進 master。合併前確認步驟 3 的完整 gate 已 PASS、worktree 乾淨，且本次變更只動 `sim/`、`deploy/` 與 `docs/`，沒有夾帶 `src/`。

合併前先擷取 autodeploy invocation baseline：

```bash
systemctl --user is-active sim-autodeploy.path
systemctl --user show sim-autodeploy.service --property=ActiveState --property=InvocationID --property=ExecMainStartTimestampMonotonic
```

要求 path active 且 service inactive，再合併：

```bash
git checkout master
git merge --no-ff feature/production-coordinator -m "feat(sim): add production coordinator"
```

merge 會觸發**唯一一次** path invocation。依任務 6 步驟 5 的同一套 generation readback 等待該輪結束（逾時 35 分鐘、逾時後改以 `deployed_rev`／health rev 決議），要求 `Result=success`、`ExecMainStatus=0`、`deployed_rev` 與 `/api/health` rev 都等於 merge SHA。不得主動 `start` 第二輪。本次 merge 不產生 completion comment、不改任何 task 狀態——它交付的是 coordinator 程式碼，不是看板工作。

若該輪 invocation 失敗（例如 merge 後 `npm run build` 掛掉），依任務 6 步驟 4 的 revert 流程處理，並在修好前不得進入任務 11。

## 任務 11：最終驗證與具前置檢查、復原能力的 Runtime Cutover

**檔案：**
- 預期不修改 source；本任務只驗證與操作已核准 build。

- [ ] **步驟 1：執行完整 no-live gate。**

```bash
npx tsc --noEmit
npx tsc -p sim/tsconfig.json --noEmit
npx tsx src/mainDiscussion.test.ts
npx tsx src/task.test.ts
npx tsx src/mainWorkspace.test.ts
npx tsx sim/run.test.ts
npx tsx sim/production.test.ts
npx tsx sim/production.integration.test.ts
npm test
npm run build
git diff --check
systemctl --user is-active task-tracker.service
curl -fsS http://localhost:3000/api/health
npx tsx sim/production.ts --once
```

預期：所有 test／build PASS；live `task-tracker.service` active、health HTTP 200。最後一個 command 使用 canonical Owner credentials 做 read-only discovery、回報沒有 mutation／AI，並逐筆列出：`938aa035...` 是 user06 唯一 active WIP、`6384b6f4...` queued／unassigned、`00123ef0...` 是任務 1 已完成前置條件且 cutover 無 action、`10e65231...` 等待前置條件通過後機械式結案、`027c0052...` 等待 `938aa035...` Done 後固定 user05，另列 `mainPolicy`／`legacyCanonicalDiscussion` 為 excluded。若 `00123ef0...` 尚未 Done 或完成證據不完整，本 gate 必須以 `CutoverPrerequisiteMissing`、exit `2` 失敗；service／health／login／required workspace readback 不可用時以 `DiscoveryUnavailable`、exit `3` 失敗。兩者都不得進入安裝或 live 步驟，且 task／Git／AI mutation 為零。

- [ ] **步驟 2：安裝新 unit，但不啟用。**

```bash
install -D -m644 deploy/sim-coordinator.service "$HOME/.config/systemd/user/sim-coordinator.service"
install -D -m644 deploy/sim-coordinator.timer "$HOME/.config/systemd/user/sim-coordinator.timer"
systemctl --user daemon-reload
systemctl --user is-enabled sim-coordinator.timer
```

預期：`disabled`。除非人工明確授權 live AI 與 board mutation，否則在此停止。

- [ ] **步驟 3：取得明確 live 授權後，擷取 manifest 並等待舊 service 排空。**

```bash
systemctl --user is-active sim-autodeploy.path
systemctl --user show sim-autodeploy.service --property=ActiveState --property=SubState --property=InvocationID --property=ExecMainStartTimestampMonotonic --property=Result --property=ExecMainStatus
npx tsx sim/production/migrate.ts
```

`sim-autodeploy.path` 必須是 active；service 若正在執行，先等待它結束，不得帶著既有 deployment invocation 進入 cutover。必須先讀取 manifest，保存 cutover generation／prerequisite fingerprint，並確認 `readyForApply=true` 且 `00123ef0...` 的整條完成證據可追溯；否則停在此處，不得停用舊 timer。緊接在任何 systemd mutation 前，再執行一次 generation-bound 唯讀檢查：

```bash
npx tsx sim/production/migrate.ts --preflight --live --expect-generation <cutover-generation>
```

只有 preflight exit 0 才能執行下一個 command block；任何失敗或 fingerprint 漂移都必須停下，且 systemd、task、Git 與 AI mutation 均為零。

```bash
systemctl --user disable --now sim-sweep-owner.timer sim-sweep-team.timer
systemctl --user is-active sim-sweep-owner.service sim-sweep-team.service
```

最多等待 35 分鐘，直到兩個舊 service 與共用 run lock 都不再 active。不得終止 in-flight AI process。若任一仍 active，取消 cutover 並重新啟用舊 timers。

- [ ] **步驟 4：套用 reconciliation；readback 成功後才啟動新 coordinator。**

```bash
npx tsx sim/production/migrate.ts --apply --live --expect-generation <cutover-generation>
```

apply 會先重新驗證同一 generation／fingerprint。若因 `CutoverPrerequisiteMissing` 或 fingerprint 漂移失敗，task／Git／AI mutation 必須為零，且要立即執行步驟 6 的復原命令重新啟用舊 timers。其他 apply 失敗也不得啟動新 service／timer；保留 manifest 與 checkpoint，依 reconciliation ledger 判斷是零 mutation 可直接復原，或已開始 mutation 而必須先冪等續跑／人工復原，絕不能同時執行新舊 coordinator。

apply exit 0 後，先重新產生唯讀 manifest：

```bash
npx tsx sim/production/migrate.ts
```

readback 必須證明 `00123ef0...` 仍為完整前置條件、`10e65231...` 恰好結案一次、其他 fixed disposition 與 committed action key 全部符合。未通過時不得啟動新 coordinator，並依上一段復原。只有 readback 通過才依序執行：

```bash
systemctl --user start sim-coordinator.service
```

`sim-coordinator.service` 是 oneshot，成功後回到 `inactive (dead)` 是正常結果，不能用 `is-active` 當成功 gate。只有 start exit 0，且以下 readback 顯示 `Result=success`、`ExecMainStatus=0` 與健康 heartbeat 時，才執行 timer enable：

```bash
systemctl --user show sim-coordinator.service --property=Result --property=ExecMainStatus
npx tsx sim/production.ts --status
```

```bash
systemctl --user enable --now sim-coordinator.timer
```

- [ ] **步驟 5：驗證前兩個 live tick。**

每個 tick 都要驗證：

- `task-tracker.service` 為 active。
- `/api/health` 回傳 HTTP 200、`status=ok`、`db=true` 與目前 master rev。
- `sim:production --status` 回報成功或目前 active 的 heartbeat。
- 兩個 allowlisted workspace 都有明確的 discovered／processed／skipped／error 數量。
- 不存在重複 comment、task transition、branch、completion row 或 Discord batch。
- `10e65231...` 只結案一次，不建立新的 Owner AI action。
- `10e65231...` 的歷史 `【全員回覆：N天】` request 由唯讀 legacy parser 與既有 DB `wait_half_days` 配對成功；不得改寫 comment 或建立新 window。
- user06 唯一 active WIP 是 `938aa035...`，且其 branch 不含任何 legacy diff。
- `6384b6f4...` 在依賴解除前保持 Todo／unassigned、沒有 branch／lease／AI action，checkpoint 是 queued，且未被當成可派工的 Todo。
- `00123ef0...` 維持任務 1 已完成的 Done 狀態；cutover／live tick 不得新增 assignment、status transition、comment、branch、task 或 AI action。
- `027c0052...` 在 `938aa035...` Done 前保持 Todo／unassigned／queued；解除依賴後 assignee 只能是 user05。
- 不存在 merge、cherry-pick、patch、copy 或 prompt reuse 任何舊 `sim/user02` 至 `sim/user06` 成果。
- 每個 merge／revert 只對應一個 path-triggered autodeploy invocation；coordinator 沒有主動 start 第二輪，invocation result、`deployed_rev` 與 health rev 都指向同一 target SHA。

- [ ] **步驟 6：任一 tick 發生操作失敗時，回復 coordinator activation。**

```bash
systemctl --user disable --now sim-coordinator.timer
systemctl --user is-active sim-coordinator.service
```

oneshot 尚為 active 或共用 run lock 尚未釋放時，只能等待，不得終止 in-flight AI，也不得啟用舊 timers。確認 service 已 inactive 且 lock 已釋放後才執行：

```bash
systemctl --user enable --now sim-sweep-owner.timer sim-sweep-team.timer
```

不得同時執行新舊 timer。保留 coordinator DB、log、manifest、branch 與 comment 供診斷。

## 任務 12：兩個成功 Live Tick 後退役舊正式環境 Sweep 路徑

**檔案：**
- 修改：`sim/run.ts`
- 修改：`sim/run.test.ts`
- 修改：`docs/operations.md`
- 修改：`docs/owner-sweep-guide.md`
- 修改：`docs/tasks/current.md`

**分支：** 本任務在 `feature/retire-legacy-sweep` 上進行，完成後單次 merge 回 master，理由與任務 2 至 10 相同：避免退役過程中的中間狀態被 autodeploy 帶上線。

**硬性前置條件：** 任務 11 步驟 5 的兩個 live tick、五筆 fixed disposition、兩筆 excluded task、heartbeat、health 與無重複副作用 readback 全部通過。任一證據缺漏就停止；不得修改 legacy path，因為任務 11 的回復仍需要它。

- [ ] **步驟 1：保留 lab 行為，拒絕退役的 sweep flag。**

從 `sim/run.ts` 移除 Owner／Team production sweep scheduling 與 notification-gate code，保留 deep／fast／scenario CLI 行為。`npm run sim -- --sweep ...` 必須以清楚訊息結束，指引 operator 改用 `npm run sim:production -- --once`，而且不得呼叫 AI 或 mutation。不得修改 `deploy/sim-autodeploy.sh`；`pgrep sim/run.ts` 守衛保留，讓人工 lab run 或 cleanup commit 的 in-flight process 不會被 restart 打斷。

- [ ] **步驟 2：更新 regression tests。**

證明 lab mode 仍可選用、已退役 sweep flag 無法 mutation，而且沒有任何 production module 會從歷史 `report.json` 發現 workspace。另以 source assertion 證明 `deploy/sim-autodeploy.sh` 仍保留 `pgrep -f '\.bin/tsx sim/run\.ts'`。

- [ ] **步驟 3：更新 post-cutover 文件。**

`docs/operations.md` 與 `docs/owner-sweep-guide.md` 改以 production coordinator 為唯一正式路徑；`docs/tasks/current.md` 記錄兩個 live tick、legacy timers disabled、sweep flag 已退役與保留 autodeploy guard 的 readback。移除「失敗時直接重新 enable 舊 timers」的日常指引；post-cleanup 若需回退，必須先 revert 本 cleanup commit、驗證舊 sweep tests／service，再依任務 11 的互斥 drain 流程切回，不能啟動已退役程式碼。

- [ ] **步驟 4：執行 focused 與完整測試。**

```bash
npx tsx sim/run.test.ts
npx tsx sim/production.test.ts
npx tsx sim/production.integration.test.ts
npm test
npm run build
git diff --check
```

預期：全部 PASS。

- [ ] **步驟 5：提交退役變更並驗證部署 generation。**

```bash
git add sim/run.ts sim/run.test.ts docs/operations.md docs/owner-sweep-guide.md docs/tasks/current.md
git commit -m "refactor(sim): retire legacy production sweeps"
git checkout master
git merge --no-ff feature/retire-legacy-sweep -m "refactor(sim): retire legacy production sweeps"
```

merge 到 master 前先擷取 autodeploy invocation baseline；merge 後只等待 path-triggered 的下一輪 invocation，要求 `Result=success`、`ExecMainStatus=0`、`deployed_rev` 與 `/api/health` rev 都等於 cleanup merge SHA。不得主動 start 第二輪。最後確認舊 timers 仍 disabled、新 coordinator timer active，且 `npm run sim -- --sweep owner` 只輸出退役指引、零 AI／mutation。

## 驗收條件

- 沒有變更的主協作工作區 Todo 不會消耗 Owner AI call。
- 每個 production AI session 只會指定一個 discussion 或 implementation task。
- 未指派但可執行的 task 由 Owner 分類並指派；member 永遠不自行認領。
- 每位 member 不得同時持有超過一個非 blocked 的自動化 WIP task。
- `938aa035...` 未 Done 前，`6384b6f4...` 與 `027c0052...` 永遠維持 queued；queued task 不得取得 lease、branch 或 AI action。
- Cutover 後 user06 的唯一 active WIP 是 `938aa035...`；之後 `6384b6f4...` 只能從包含該 accepted merge 的 master 重新開始。
- `00123ef0...` 只在任務 1 開始且取得授權後由 canonical Owner 指派一次 user03，並由該 task branch 完成至 Done；cutover 不得重新指派或再次執行。Drain 前未通過 preflight 時，`CutoverPrerequisiteMissing` 必須讓 systemd／task／Git／AI mutation 全部為零；drain 後若 fingerprint 漂移，task／Git／AI mutation 仍為零，唯一允許的 systemd mutation 是依步驟 6 復原舊 timers。`027c0052...` 解除依賴後固定交給 user05；任何其他自動選人結果都視為 policy failure。
- Review acceptance 綁定單一 task branch／head SHA，不能包含其他 task 的 diff。
- 任何 cutover Review 都不能沿用 legacy branch、commit、dirty diff、檔案或既有 CI 留言作為實作或 acceptance evidence。
- Exit 0 但缺少預期 readback 時，只能記為無進展或可重試失敗，絕不算成功。
- 兩次 member 無進展嘗試會觸發 Owner intervention；再一次無進展只觸發一筆 human-blocked notification，之後保持安靜。
- Live deployment health 與 user09 notification readback 完成前，task 不得進入 Done。
- Merge 後部署失敗會產生 revert commit，並恢復健康 revision。
- 部署等待逾時固定 35 分鐘且大於 autodeploy 自身的 30 分鐘 sweep 等待；逾時後只依 `deployed_rev`／health rev 決議成功、`DeploymentIndeterminate` 或失敗，絕不因逾時本身直接 revert。
- Coordinator 從不主動 start `sim-autodeploy.service`；operator 手動啟動後，下一個 tick 必須能以 `deployed_rev`／health rev 認回該部署，不需自己觀察過那輪 invocation。
- 任務 2 至 10 在 `feature/production-coordinator` 上實作，過程中不觸發任何部署；任務 10 結束後單次 merge 進 master 只產生一次 build + restart。只有任務 1 的看板 task 走完整 acceptance／deploy／completion 鏈。
- 任務 1 由具備 board mutation 授權的互動式 Claude Code session 執行，實作者／driver／Owner 三個角色的操作在 transcript 中分開記錄。
- `6384b6f4...` 在依賴解除前為 Todo／unassigned／queued，且不得被當成可派工的未指派 Todo；退回 Todo 必須依 Review -> Doing -> Todo -> 清除 assignee 的固定順序。
- `LEASE_TTL_MS` 嚴格大於 `DEPLOY_WAIT_TIMEOUT_MS`，且有直接比較兩個常數的斷言。
- Discord 只收到一則去重摘要，delivery attempt 不超過三次。
- Coordinator restart 會從 checkpoint 接續，不重複已完成副作用。
- Production coordinator 永遠不接觸兩個明確 UUID 以外的 workspace。
- 未另行取得明確人工授權前，不得執行 live AI 或啟用 timer。
