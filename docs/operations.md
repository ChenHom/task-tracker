# Operations

## Task Tracker systemd service

This app is managed by a user-level systemd unit:

- Unit source: `deploy/task-tracker.service`
- Installed unit: `/home/hom/.config/systemd/user/task-tracker.service`
- Working directory: `/home/hom/code/task-tracker`
- Process: `node dist/server.js`
- Local upstream: `http://127.0.0.1:3000`
- LAN entrypoint: `http://192.168.50.109/tracker/`
- AI quota snapshot: `/home/hom/.local/state/ai-quota/quota.json`

## Install or update the unit

Run from the repo root:

```bash
npm run build
install -D -m 664 deploy/task-tracker.service /home/hom/.config/systemd/user/task-tracker.service
systemctl --user daemon-reload
systemctl --user enable task-tracker.service
systemctl --user restart task-tracker.service
```

## Common commands

```bash
systemctl --user start task-tracker.service
systemctl --user stop task-tracker.service
systemctl --user restart task-tracker.service
systemctl --user reload task-tracker.service
systemctl --user status task-tracker.service
```

`reload` sends `SIGHUP` to the Node process. The app handles it by rerunning expired-session cleanup and logging `task-tracker reloaded`; it does not restart the process.

The unit uses `Restart=always` so unexpected exits and external `SIGTERM` restarts are handled by systemd. A manual `systemctl --user stop task-tracker.service` still leaves the service stopped.

## Verify

```bash
systemctl --user is-active task-tracker.service
curl -sS http://127.0.0.1:3000/api/health
curl -sS -o /tmp/task-tracker-health.txt -w '%{http_code}\n' http://192.168.50.109/tracker/api/health
```

Expected:

- service state: `active`
- upstream health: `{"status":"ok","db":true}`
- LAN health HTTP status: `200`

## Logs

```bash
journalctl --user -u task-tracker.service -n 80 --no-pager
tail -n 80 /var/log/nginx/error.log
```

If `/tracker/` returns `502`, first check whether `task-tracker.service` is active and whether port 3000 answers `/api/health`.

## Autodeploy（master 自動部署）

`sim-autodeploy.path` 監看本地 `refs/heads/master`（含 `packed-refs`），變動即觸發 `deploy/sim-autodeploy.sh`：等待進行中的 sim sweep（最多 30 分）→ `npm run build` → 重啟 `task-tracker.service` → 以 `/api/health` 的 `rev` 欄位 readback 確認與 `git rev-parse master` 一致。build 失敗或 readback 不符時**不會**留下新版（服務續跑舊版），並經 `sim/notify-human.sh` 推 Discord。

```bash
systemctl --user status sim-autodeploy.path        # 監看是否啟用
journalctl --user -u sim-autodeploy.service -n 40  # 部署執行紀錄
tail ~/.local/state/sim-autodeploy/deploy.log      # 部署結果（deployed OK / BUILD FAILED / READBACK MISMATCH）
cat ~/.local/state/sim-autodeploy/deployed_rev     # 目前已部署的 rev
systemctl --user disable --now sim-autodeploy.path # 停用自動部署
```

安裝與初始化見 `deploy/README.md`（state 初始化：`git rev-parse master > ~/.local/state/sim-autodeploy/deployed_rev`，避免啟用當下重複部署）。

## ESCALATE 推播

每輪 sweep 結束後 `sim-sweep-cron.sh` 會跑 `node --import tsx sim/escalateNotify.ts`：掃 `data/dev.db` 中 state 記錄點之後的新 `[ESCALATE]` 留言，逐則經 `sim/notify-human.sh`（openclaw CLI）推到 Discord。state 檔為 `~/.local/state/sim-escalate/state.json`（記錄已掃過的最大 comment rowid）。

```bash
node --import tsx sim/escalateNotify.ts   # 手動掃一次（輸出 escalate-notify: N new）
sim/notify-human.sh "測試訊息"            # 驗證 Discord 管道
```

首次啟用（或 state 遺失重建）前先把 state 初始化到目前最大 rowid，避免歷史 ESCALATE 灌爆頻道：見 `docs/superpowers/plans/2026-07-17-sim-process-fixes.md` Task 3 Step 8 的初始化指令。

## AI quota dependency

Quota provider polling belongs to the separate `/home/hom/services/ai-quota` repo. Its `ai-quota.timer` runs a one-shot poll every five minutes and writes the shared snapshot; task-tracker only validates and reads that file.

```bash
systemctl --user status ai-quota.timer ai-quota.service
systemctl --user list-timers --all ai-quota.timer
journalctl --user -u ai-quota.service -n 80 --no-pager
```

If the footer shows `N/A`, inspect the snapshot and timer before changing task-tracker. Stale provider data remains visible with a marker. Reset timestamps stay UTC in JSON/API and are rendered in `Asia/Taipei` by the footer.

## 主協作工作區

Owner 每次啟動或巡檢時的看板治理、驗收、阻塞、想法與封存守則，請見 [Owner 啟動與巡檢守則](owner-sweep-guide.md)。本節保留主工作區政策與系統操作限制。

- 固定 UUID：`11a82028-fc50-466a-a723-e002032cd9a6`
- 固定名稱：`主協作工作區`
- `user01@test.local` 是唯一 Owner；只有 user02-06 與 user09 同步為 Commenter，其他 user 不會加入。
- Commenter 在任何 workspace 都可修改自己建立 task 的 description，但不可修改標題、狀態、其他屬性、附件或他人 task。
- 留言只能由原作者透過 PATCH 編輯，`DELETE /api/comments/:id` 固定回 405；不提供留言刪除或由刪除觸發的 notification 清理流程。
- 只有主協作工作區會同步 user02-06 與 user09 為 Commenter；其他 workspace 的新成員預設仍為 Member，Owner 可另行調整角色。
- 主協作工作區所有人都可建立 Todo 討論與留言；user01 先留下 `【OWNER想法】`，再通知 user02-06 與 user09。
- 討論沒有等待期限，成員隨時可以回覆；主工作區留言沒有任何格式閘門。
- 只有 user01 能以 `【結論】`/`【結論：不實作】`/`【未達共識】` 的完整證據將主工作區 task 由 Todo 直接移到 Done；收尾前必須有 user01 留下的完整六欄 `【OWNER想法】`。未達共識需留下分歧、缺少資訊與下次建議，三種收尾都不要求任何確認留言。
- 有共識且要實作時，在目標工作區另建 TASK；原討論只記 `【實作任務】工作區：...｜TASK：...`，不產生或儲存 URL。主工作區不使用 Doing、Review，也不追蹤缺席名單或提供期限/回覆 UI。
- `[規則] 主工作區協作與交接` 是政策提示，不是 sweep work。
- Server startup 會修復固定名稱、成員角色、規則 task 與 legacy 討論；成功登入時也會同步該使用者。既有 legacy `task.discussion_started` 事件只供歷史 replay，新的主工作區收尾使用 `task.main_discussion_concluded`。

討論收尾 readback（UTC）可用：

```bash
sqlite3 data/dev.db "SELECT aggregate_id, occurred_at, json_extract(payload_json, '\$.outcome') AS outcome FROM event_store WHERE event_type = 'task.main_discussion_concluded' ORDER BY occurred_at DESC LIMIT 20;"
```

### 2026-07-12 rollout 驗收

- `master` merge：`efbeb4b`；`npm test`、`npm run build`、`git diff --check` 通過。
- `task-tracker.service` restart 後 `/api/health` 回 HTTP 200 與 `{"status":"ok","db":true}`。
- DB readback：workspace active、1 Owner + 29 Commenter、唯一 `[規則] 主工作區協作與交接`，兩筆 legacy task 已正規化為 `[討論]`。
- HTTP smoke：discussion `1086ccfd-96f7-485c-b8da-335bb4058269`；Commenter 建立／留言成功、狀態 PATCH 為 403；user01 以單一 `task.discussion_started` 指派自己，建立 canonical task `af06f594-682c-4437-aea5-d71eb354471c`、回寫完整 URL，並完成 Doing → Review → Done。
- Commenter description smoke：自建 task `15b9852a-9190-4868-b9a2-6023ad744c0a` 的描述 PATCH 為 200，標題／狀態為 403，user03 修改其描述為 400；user02 在非主工作區 `79618d0f-2401-41e5-a858-c4d10dedd338` 仍為 Member，task `a48e1048-feab-4214-b1ac-f195fdaf6f9c` 的標題與描述 PATCH 均為 200。
- Live AI sweep 與 SIM timers 未啟用，仍需明確人工授權。

## Sim harness

### Notification preflight（目前停用）

SIM notification preflight 目前預設停用：Owner／member 不會為通知額外登入、讀取、留言或標記已讀，且 notification 失敗不再阻斷一般工作 session。這只影響 `sim/run.ts` 的自動巡檢；網站的 notification API 與前端不受影響。要明確恢復舊行為，才在執行命令前設定 `SIM_NOTIFICATION_GATE=1`；已安裝的 timer wrapper 未設定此值，因此維持停用。

啟用時，每個自動 Owner 與已設定 member session（`user01`、`user02`–`user06`）會先 snapshot 自己未讀的 `GET /api/notifications` rows。driver 會讀取來源 task/comment，並在一般看板工作前執行專用 API-only notification session。

Main-workspace sources require a new post-snapshot comment by that actor; when there is no addition the required text is `已閱讀，目前無補充。`. The driver, not the AI session, marks a notification read after this verification. Normal-workspace sources may be read without a compulsory reply. A `403`/`404` or deleted source is logged and marked read; malformed data, network/5xx failures, a failed preflight, or missing/invalid main reply stay unread and skip that actor's ordinary session for this run.

The snapshot is bounded to login time. Notifications received later wait for the next actor session. The runner never creates a self-mention in notification handling. `user09` is not currently a sim runner, so this automation does not consume that account's notifications. This is not a frontend inbox and does not authorize running a live sweep.

每筆未讀 notification 都是獨立處理單位：同一 task 的三筆通知會各自建立 bounded prompt、各自呼叫 AI、各自驗證留言並 read back。內容重複時，後續通知仍須由 AI 閱讀判斷，但可只留下固定的 `已閱讀，目前無補充。`（或等價的無補充訊息）；不得把多筆通知合成一筆。每個 prompt 上限 16,000 字元，超長留言會保留來源留言並明確省略其餘 context，固定規則與來源仍超限時 fail closed 並保留未讀。

#### 全成員通知巡檢（啟用時）

設定 `SIM_NOTIFICATION_GATE=1` 時，`--sweep team` 與 `--sweep both` 每個 tick 會依序巡檢目前設定的 user02–user06，與成員是否有 Todo/Doing 任務無關。每位成員都會登入並 snapshot 自己的未讀通知；零未讀只寫入 `notification-sweep` 結束紀錄，不啟動 AI。若有未讀，才啟動 dedicated API-only notification session，沿用上方來源讀取、主工作區回覆驗證、不得 @自己與 driver 標已讀規則。

通知巡檢不建立 worktree、不 commit，也不占用一般 member task budget。登入、API、preflight 或主工作區留言驗證失敗時，該成員的未讀保留，且本 tick 跳過該成員的一般工作；其他成員照常繼續。`--sweep owner` 不啟動 user02–user06 通知巡檢；user01 仍由 owner session 的既有 gate 處理，user09 目前不在 sim runner 範圍。

#### SIM managed roster 與派工

自動成員同步只套用在 `CANONICAL_WORKSPACE_BY_REPOROOT` 登記的 task-tracker canonical workspace，以及本次 bootstrap 新建的 SIM workspace；不會回填主協作工作區、歷史 workspace 或其他既有一般 workspace。同步會補缺少的 user02–user06、把 Viewer/Commenter 升為 Member，保留既有 Member/Admin/Owner；局部 invite/join 失敗時該帳號不進 eligible roster，其他已就緒成員仍可運作。主協作工作區的 user06 仍維持 Commenter。

Owner 依成員 profile 與目前 Todo/Doing 負載直接 PATCH `assignee_id`，並在每次派工留下 `【OWNER派工】`（負責人、專長理由、下一個可驗收成果）。Scheduler 只啟動 eligible runner 名下的 Todo/Doing；依 Doing 優先、同狀態最舊 `updated_at`、email tie-break 選最多 3 位 member（`memberBudget=3`）。無 assignee 的 Todo 採嚴格模式：不啟動任何 member、沒有 timeout 自行認領或 fallback；沒有合適 runner 時由 Owner 留 `[ESCALATE]`。

### Prerequisites

- Run commands from `/home/hom/code/task-tracker`.
- `task-tracker.service` must answer HTTP 200 at `http://localhost:3000/api/health`.
- Run `npm run seed` once so `user01-06@test.local` and `user09@test.local` exist.
- The `claude`, `codex`, and `agy` CLIs must be installed, authenticated, and available in `PATH`.
- Claude's five-hour quota has recovered, so user06 ordinary work uses Claude `claude-sonnet-5` with no AGY fallback; its notification preflight remains Codex `gpt-5.4-mini`. No current route uses or authorizes `--dangerously-skip-permissions`.
- Historical evidence only: the following AGY curl capability probe was invoked once on 2026-07-16:

  ```bash
  agy --print --model 'Gemini 3.5 Flash (High)' --mode accept-edits --dangerously-skip-permissions 'Use curl to GET http://localhost:3000/api/health. Output the HTTP status and JSON body only. Do not modify any file or call a POST, PATCH, PUT, or DELETE endpoint.'
  ```

  Its exact result was `exit 1: socket: operation not permitted`, before curl, so no curl or board mutation occurred and it did not output HTTP 200 or the health JSON. This no-side-effect AGY trial is historical; user06 ordinary work has been restored to Claude. Available main-workspace sources require a verified actor comment before being marked read, and preflight failures remain unread; the documented `403`/`404` unavailable-source handling still logs and marks the item read. Do not add shared `--dangerously-skip-permissions`.
- A new sprint requires the selected scenario repo to be on `master` with a clean main worktree.

### Manual start

```bash
# Deep self-directed sprint: owner open -> r1 -> mid review -> r2/r3 -> merge/repair
npm run sim

# Shorter sprint
npm run sim -- --fast --scenario self-directed

# Pipeline check; still calls two real AI member sessions
npm run sim -- --smoke

# Other scenarios
npm run sim -- --scenario product-ideation
npm run sim -- --scenario brain

# One sweep tick
npm run sim -- --sweep owner
npm run sim -- --sweep team
npm run sim -- --sweep
```

`npm run sim` executes `tsx sim/run.ts`. The entrypoint acquires the run lock and then selects either the full sprint flow or the requested sweep role. Omitting a scenario uses `self-directed`; omitting a sweep role runs `owner + team`.

### Operator-controlled sweeps

SIM timers 只由操作人員控制，部署或啟動 Task Tracker 時不得自動 enable。Live sweep 會呼叫真實 AI 並修改看板，只有取得明確人工授權後才執行 `npm run sim -- --sweep owner` 或啟用 timer。

Installed user units and wrapper:

- `~/.config/systemd/user/sim-sweep-owner.timer`: runs at `:00` and `:30` every hour.
- `~/.config/systemd/user/sim-sweep-team.timer`: runs at `:15` every hour.
- `~/.local/bin/sim-sweep-cron.sh`: checks for an existing sim process and verifies `/api/health` before invoking `npm run sim -- --sweep <role>`.

Explicitly enable both timers when authorized:

```bash
systemctl --user daemon-reload
systemctl --user enable --now sim-sweep-owner.timer sim-sweep-team.timer
```

Inspect or trigger them:

```bash
systemctl --user list-timers --all 'sim-sweep-*'
systemctl --user status sim-sweep-owner.timer sim-sweep-team.timer
systemctl --user start sim-sweep-owner.service
systemctl --user start sim-sweep-team.service
```

Stop automatic sweeps without affecting manual runs:

```bash
systemctl --user disable --now sim-sweep-owner.timer sim-sweep-team.timer
```

Timer output is written to `sim-logs/sweep-owner-cron-*.log` and `sim-logs/sweep-team-cron-*.log`. Session prompts, review packets, command output, and sprint reports are also stored under `sim-logs/`.

### Concurrency and recovery

The driver holds `sim-logs/.run.lock` for the complete run. Manual runs and owner/team timers therefore cannot mutate the shared board or Git worktrees concurrently. A sweep that sees a live PID exits and lets the next timer retry; a lock whose PID no longer exists is recovered automatically. Do not delete a lock owned by a live process.

Member sessions edit and verify files but do not commit. After a successful, non-timeout session, the driver verifies the expected Git top-level/worktree branch, stages the isolated worktree, runs `git diff --cached --check`, and commits. A failed or timed-out session remains uncommitted; its dirty worktree is reported as CI `FAIL` so the Owner returns the task to `Doing` instead of treating the work as lost.

### Review results

Review statuses are:

- `PASS`: command ran successfully; only `tsc PASS + test PASS` is automatically green.
- `FAIL`: command failed or the worktree contains an incomplete uncommitted diff; do not merge.
- `SKIP`: no suitable tooling, or a brain change spans multiple independently verifiable subprojects; the Owner must inspect the diff and task evidence before deciding.

### Permission boundary

The Claude member tool allowlist blocks direct Git commands, and Codex keeps its `workspace-write` sandbox. This is cooperative-agent protection, not hostile-code isolation: driver CI executes branch code on the host. Run the harness and CI inside a container or VM before accepting untrusted code or prompts.

## Production Sim Coordinator（cutover 準備中）

`sim/production.ts`（加上 `sim/production/{types,state,api,policy,git,agent,coordinator,completion,cutoverTasks,migrate}.ts`）是取代 `sim/run.ts` Owner／Team sweep 的正式環境協調器。**尚未啟用**：`feature/production-coordinator` 合併進 master 只交付程式碼，不代表已授權 live AI 或看板 mutation；啟用程序見計畫任務 11，本節只記錄啟用前必須知道的契約。**任務 11 完成 runtime cutover 之前，本節下方「Legacy sweep 仍是復原路徑」所描述的舊路徑必須維持可用**——它是任務 11 失敗時的唯一回退目標。

### 固定 workspace allowlist

Coordinator 只服務兩個固定 workspace（`sim/production/policy.ts` 的 `ALLOWED_WORKSPACE_IDS`）：

- 主協作工作區：`11a82028-fc50-466a-a723-e002032cd9a6`
- task-tracker canonical workspace：`d9da9945-ce5f-400f-806e-1d75e95e313a`

`--scenario`／`--fast`／`--smoke` 等 `sim/run.ts` 的實驗模式永遠不進入這個佇列。

### 15 分鐘 timer，安裝後保持 disabled

- `deploy/sim-coordinator.service`：oneshot，`ExecStart=... npx tsx sim/production.ts --once --live`。
- `deploy/sim-coordinator.timer`：`OnCalendar=*-*-* *:00/15:00`、`Persistent=false`——每 15 分鐘觸發一次 oneshot service，不補跑錯過的排程。
- 安裝（任務 11 步驟 2）只 `daemon-reload`，**不** enable／start：

  ```bash
  install -D -m644 deploy/sim-coordinator.service "$HOME/.config/systemd/user/sim-coordinator.service"
  install -D -m644 deploy/sim-coordinator.timer "$HOME/.config/systemd/user/sim-coordinator.timer"
  systemctl --user daemon-reload
  systemctl --user is-enabled sim-coordinator.timer   # 必須是 disabled
  ```

  只有取得明確人工 live 授權，才執行任務 11 步驟 3-4 的 drain／apply／`enable --now` 程序。`sim-coordinator.service` 是 oneshot：成功後回到 `inactive (dead)` 是正常結果，不能拿 `is-active` 當成功 gate，必須讀 `Result=success`／`ExecMainStatus=0` 與 `--status` heartbeat。

### dry-run／live 邊界與前置條件

```bash
npx tsx sim/production.ts --once          # 唯讀 discovery：印出 planned action，零 AI、零 mutation
npx tsx sim/production.ts --once --live   # 授權 tick：允許 AI 與 mutation（只供人工授權或 systemd）
npx tsx sim/production.ts --status        # 印出最後一個 tick 的 heartbeat／健康狀態
```

`--once` 是唯讀 live discovery，不是離線 fixture：依序要求 `task-tracker.service` active、`GET /api/health` 為 HTTP 200 且 body `status === 'ok'`、以 canonical Owner `user01@test.local`（既有 seed 密碼）登入成功、GET 兩個 allowlisted workspace 都成功、以 `user09@test.local` 登入成功（供 completion notification readback）。任一步失敗就是 `DiscoveryUnavailable`；密碼永遠不寫入 log／manifest／error。

### Exit code 契約

| Command | Exit | 意義 |
| --- | --- | --- |
| `--once` / `--once --live` | `0` | 完整 discovery，且 cutover prerequisite ready |
| `--once` / `--once --live` | `2` | 完整 discovery，但 `CutoverPrerequisiteMissing`；本次 tick 零 mutation、零 AI |
| `--once` / `--once --live` | `3` | `DiscoveryUnavailable`（service 未 active／health 非 200／login 失敗／required workspace GET 失敗）；零 mutation、零 AI |
| `--once` / `--once --live` | `1` | 未分類程式錯誤。**不保證零 mutation**——這是唯一沒有副作用契約的結束路徑，下一個 tick 必須以 `action_log`（見下）與權威 readback 重新對帳，不得假設任何 planned mutation 已完成或未完成 |
| `--status` | `0` | healthy：30 分鐘內有心跳，或存在有效 active lease |
| `--status` | `1` | unhealthy：心跳過期且無 active lease |

### Ledger／status command

State 存在 `sim-logs/production-coordinator.db`（gitignored）。主要表格：`task_runs`（每個 task 的 checkpoint：phase／branch／lease／noProgressCount／evidenceFingerprint）、`action_log`（deterministic `action_key` 防止同一 mutation 重送，PK 直接擋重複 insert）、`ticks`（每次 tick 的 heartbeat）、`completion_outbox`（完成通知 batch／重試）、`coordinator_meta`（`cutover_generation`）。`--status` 讀最後一列 `ticks` 加上目前 `lease_until > now()` 的數量判斷健不健康。

### WIP1

每位 assignee 在同一次 tick 最多只取得一個非 blocked action（`selectCoordinatorActions` 用 `reservedAssignees` 集合去重）。`queued` 與尚未可恢復的 `human_blocked` task 完全不參與這個計算——它們既不佔用、也不釋放任何 assignee 的 WIP1 名額。同一次 live tick 的迭代內，`owner_dispatch`／`assign_member` 另外用 `claimedAssigneesThisIteration` 防止同一輪指派兩個 unassigned Todo 給同一個人。

> **⛔ 2026-07-29：production coordinator 目前無法上線。** `sim/production.ts:762` 在 `--live`
> 模式會直接 throw —— CLI 組裝層從未提供 `runOwnerSession`/`runMemberSession`，AI 呼叫仍是
> 刻意保留的整合點。實測步驟 1–4 全部 exit 0（零 mutation），但 `sim-coordinator.service`
> 以 `ExecMainStatus=1` 失敗。legacy sweep 路徑仍是唯一可用的正式路徑，`sim-coordinator.timer`
> 維持 disabled。詳見 `docs/superpowers/plans/2026-07-22-production-sim-coordinator.md` 任務 11。

### Discussion policy（主討論 `10e65231...`）

討論收尾條件由 `src/mainDiscussion.ts` 管理，**已無等待窗口**（`【全員回覆：N天】` 與 `main_discussion_windows` 於 2026-07-29 移除）；production coordinator 這一層只在 evidence fingerprint（留言／狀態）自上次 checkpoint 後已變化時才產生 Owner action。狀態沒變化的巡檢不會重複觸發 AI。

### Human-blocked 行為

連續兩次「完整嘗試但沒有可驗證進展」（`OWNER_INTERVENTION_THRESHOLD = 2`）先標記 `ownerIntervened`；已介入後再一次無進展，轉為 `human_blocked` 並貼出唯一、去重的 `@user09` 留言（action key = `human_blocked_notice:<taskId>:<noProgressCount>`）。看板 status／assignee 維持不變；`human_blocked` 是 coordinator metadata，不是新的看板狀態，也不列入 WIP1。只有目前證據 fingerprint 與卡關當下不同（新留言、期限事件，或人工 task mutation）才會恢復嘗試。Provider／network failure（登入失敗、逾時等與「有沒有做出進展」無關的失敗）永遠不計入 noProgressCount。

### Task branch 慣例

每個 task 有自己的 branch `sim/task/<taskId>` 與 linked worktree `sim-work/tasks/<taskId>`（`sim/production/git.ts`）。正式環境不再使用 `sim/user02`～`sim/user06` 這類共享 branch；`ensureTaskWorktree` 冪等（worktree 已存在就重用，並驗證傳入的 `baseSha` 真的是既有 head 的祖先）。

### Path-triggered autodeploy generation readback

Coordinator 永遠不主動 `systemctl start` 任何 unit；`sim-autodeploy.path` 監看 master ref 是唯一觸發來源。等待邏輯（`waitForDeployment`，`sim/production/git.ts`）：

1. merge／revert 前先 snapshot baseline（`invocationId` + `execMainStartTimestampMonotonic`）。
2. 每輪 poll `systemctl --user show sim-autodeploy.path/.service`；只有 `invocationId` 改變**且** `execMainStartTimestampMonotonic` 前進**且** `serviceActiveState !== 'active'` 三者同時成立，才判定「新一輪已結束」。
3. 新一輪結束後檢查它自己的 `Result=success`／`ExecMainStatus=0`，再核對 `deployed_rev` 與 `/api/health` rev 是否等於 target SHA；任一不符即 `deployment_failure`。
4. 逾時 `DEPLOY_WAIT_TIMEOUT_MS`（35 分鐘）後三路決議：`deployed_rev`／health rev 已收斂 -> 成功（`deployObservedOutOfBand=true`）；仍未收斂但 `.service` 仍 active -> `deployment_indeterminate`（下一個 tick 用同一 target SHA 重新 readback，不重跑整個 sequence）；`.service` 已 inactive -> `deployment_failure`（`.path` 觸發遺漏）。

`LEASE_TTL_MS`（45 分鐘，`sim/production/state.ts`）必須嚴格大於 `DEPLOY_WAIT_TIMEOUT_MS`（35 分鐘，`sim/production/git.ts`）：一個等待部署的 tick 合法可跑超過 35 分鐘，若 lease 先過期，`--status` 會誤報不健康，且過期 lease 可能被重新 claim，導致兩個 coordinator 同時處理同一 task。這個大小關係由 `sim/production.test.ts` 直接斷言。

### Acceptance／deploy／revert sequence

Owner accept 之後（`sim/production/coordinator.ts` 的 `runDeployAcceptance`），固定順序：

```
task branch CI -> 暫時 integration worktree（merge --no-ff --no-commit 偵測衝突）
  -> npm test -> npm run build -> git diff --check -> task-specific acceptance
  -> 要求 .path active／.service inactive -> snapshot baseline -> merge --no-ff 進 master
  -> waitForDeployment -> task live acceptance -> deployed
```

任何一步失敗立刻回傳對應失敗 kind、不繼續往下走；下一個 tick 從失敗點重試（`deploy_indeterminate` 除外，見上一節）。Post-merge 部署失敗（`deploy_failed_post_merge`）觸發復原：`performMasterRevert`（確認 `.path` active／`.service` inactive、`git revert -m 1 --no-edit`）→ `resolveRollbackWait`（用同一個 `waitForDeployment` 等 revert 觸發的下一輪 invocation）。Rollback 成功貼出去重的 `deployment-rollback` 留言、task 維持 Review 待人工檢視；`rollback_indeterminate` 下一個 tick 用同一 revertSha 重試一次；明確失敗或連續兩個 tick 都 indeterminate 則記錄 `FatalCoordinatorError`——`assertNoFatalCoordinatorError` 之後會擋下該 task 的所有後續 AI／mutation action，直到人工清除。

### Completion digest

Task 進 Done 前，`sim/production/completion.ts` 依固定順序（persist outbox row -> 留言 -> user09 notification readback -> Review->Done PATCH）貼出這個逐字模板：

```
【SYSTEM完成】 @user09
TASK：<title>（<taskId>）
功能／修改：<owner-approved 摘要>
驗證：<focused tests + integration + live acceptance>
Commit：<accepted head/merge sha>
部署版本：<health rev>
執行識別：<completion_id>
```

`completion_id = taskId + ':' + acceptedHeadSha`；`執行識別` 該行同時是 readback 用的去重 marker。留言與 Review->Done PATCH 都是 readback-first、可安全重試；user09 notification 讀不到會直接 throw（資料完整性問題，不是可重試的預期失敗）。每個 tick 最多合併成一則 Discord 摘要，失敗後在接下來兩個 tick 各重試一次（總計 3 次），第 3 次失敗後標記 `notify_failed`，不再自動重試、不影響已確認的 Done。

### Rollback procedure（切回 legacy sweep）

任一 live tick 發生操作失敗時（任務 11 步驟 6）：

```bash
systemctl --user disable --now sim-coordinator.timer
systemctl --user is-active sim-coordinator.service   # 等到 inactive、run lock 釋放才繼續；不得砍 in-flight AI
systemctl --user enable --now sim-sweep-owner.timer sim-sweep-team.timer
```

不得同時啟用新舊 timer。保留 coordinator DB、log、manifest、branch 與 comment 供診斷；不清除、不 reset。

## Legacy sweep 仍是可復原路徑（runtime cutover 完成前）

本任務（計畫任務 10）**不修改** `sim/run.ts`、`sim/run.test.ts` 或 `deploy/sim-autodeploy.sh`。在 runtime cutover（計畫任務 11）成功完成兩個 live tick 之前，上方「Sim harness」章節描述的舊 Owner／Team scheduling、notification gate、`--sweep` flag 與 `deploy/sim-autodeploy.sh` 既有的 `pgrep sim/run.ts` 守衛都必須維持可用——任務 11 若失敗，回復流程就是重新 `enable --now sim-sweep-owner.timer sim-sweep-team.timer`，這條路徑一旦被拆除或改壞，任務 11 失敗時就沒有可以切回去的正式環境排程了。舊路徑要到計畫任務 12（兩個成功 live tick 後、另開 `feature/retire-legacy-sweep`）才會退役。

## Cutover reconciliation（`sim/production/migrate.ts`）

五筆既有卡關 task 的固定 cutover disposition（`sim/production/cutoverTasks.ts` 的 `CUTOVER_TASKS`，唯一權威定義）：

| Task | 固定 disposition |
| --- | --- |
| `938aa035-5f96-4908-b28b-876fa4735061`（activeReview） | user06 唯一 active WIP；`00123ef0...` 前置條件通過後恢復/保留 assignee，PATCH Review -> Doing，從當時 master 建立乾淨 branch |
| `6384b6f4-f92f-45a2-a5e1-133f04f76372`（queuedReview） | 依賴 `938aa035...`；解除前退回 Todo／unassigned／`queued`checkpoint |
| `00123ef0-81cb-410e-aed1-d6d1fb925ed6`（completedPrerequisite） | 任務 1 唯一實作 task，Done 後 cutover 永遠不再指派或執行，只驗證完成證據鏈 |
| `10e65231-a4b2-4bdb-aab4-9f3c5fb0e916`（mainDiscussion） | `00123ef0...` 前置條件通過後機械式結案一次，不建立新 Owner AI action |
| `027c0052-46d5-4da7-90fa-dd8efb2219fc`（deferredAssignment） | 依賴 `938aa035...`；解除前維持 Todo／unassigned／`queued`；解除後固定指派 user05 |

另有兩筆永遠排除（`isExcludedTask`，ID 為主、canonical title 為輔的雙重規則）：`27ec8d7e-8605-468c-9f2c-13a80bef2a5a`（`[規則] 主工作區協作與交接`，mainPolicy）與 `8be538bc-ffc6-4122-9757-026a54ba813f`（`[討論] 方向與下一步`，legacyCanonicalDiscussion）——两者只出現在 manifest 的 excluded 清單，永遠不建立 checkpoint、lease、action 或 mutation。

`027c0052...`／`6384b6f4...` 的依賴解除條件是 `isActiveReviewGateOpen`：`938aa035...` 的看板 status 必須是 **Done**（不是 Doing／Review），**且**它的 accepted head（coordinator 自己 `task_runs` checkpoint 記錄的 `headSha`）必須驗證是目前 master 的祖先——這是「Done readback」，不是單看狀態欄位。gate 未開啟前兩者的 coordinator checkpoint 都固定寫成 `queued`。

`queued` 是 coordinator metadata，不是看板狀態：

- **不占 WIP**：`isBlockedTask` 在 generic 排程階段直接排除 `queued` task，它們既不佔用、也不會被算進任何 assignee 的 WIP1 名額。
- **不會觸發 acceptance**：即使看板 status 暫時仍是 `Review`（例如三步退回序列途中），只要 coordinator checkpoint 的 phase 是 `queued`，`selectCoordinatorActions` 就不會為它產生 `owner_review` action。
- **看板狀態一律是 Todo／unassigned**：`6384b6f4...` 退回 baseline 用固定三步、各自獨立 action key 的單欄位 PATCH（`Review -> Todo` 不是合法轉換，且一旦先清 assignee 就永久卡在 Review，因此順序鎖死）：
  1. `Review -> Doing`（此時 assignee 仍是 user06，滿足 `src/task.ts` 對 Review -> Doing 的 assignee 非空守衛）
  2. `Doing -> Todo`
  3. 清除 assignee
  中斷後依已完成的 action key 續跑，不從頭重做。

CLI（`sim/production/migrate.ts`）三種模式：

```bash
npx tsx sim/production/migrate.ts
# 唯讀 manifest：寫入 sim-logs/cutover-<timestamp>/manifest.json（gitignored）。
# exit 0 = readyForApply；2 = CutoverPrerequisiteMissing；3 = DiscoveryUnavailable。

npx tsx sim/production/migrate.ts --preflight --live --expect-generation <n>
# 唯讀：重新計算 fingerprint，只有 generation 與全部證據仍相符才 exit 0；
# 不符或 CutoverPrerequisiteMissing 則 exit 1；DiscoveryUnavailable 則 exit 3。
# 不呼叫任何 task／Git／AI mutation adapter。

npx tsx sim/production/migrate.ts --apply --live --expect-generation <n>
# 唯一會真正 mutate 的模式：先重跑一次上面的 generation 檢查（不符 exit 1），
# 通過後才執行 reconciliation。exit 0 = applied；2 = CutoverPrerequisiteMissing；3 = DiscoveryUnavailable。
```

全程零 AI：這個模組沒有任何函式簽名帶 AI runner 參數，「AI 呼叫數為零」是結構性保證。
