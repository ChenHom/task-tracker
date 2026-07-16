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
- 合法 `【全員回覆：N天】` 會從通知留言時間開啟固定窗口，`N` 為 2–7 天、以半天（12 小時）遞增；預設盡量使用 2 天，超過 2 天需在同一留言說明較長期限理由。窗口到期前不移動 task，開啟後不延長、不重開。
- 到期後只有 user01 能以 `【結論】`/`【結論：不實作】`/`【未達共識】` 的完整證據將主工作區 task 由 Todo 直接移到 Done；未達共識需留下分歧、缺少資訊與下次建議，不要求建立者再確認。
- 有共識且要實作時，在目標工作區另建 TASK；原討論只記 `【實作任務】工作區：...｜TASK：...`，不產生或儲存 URL。主工作區不使用 Doing、Review，也不追蹤缺席名單或提供期限/回覆 UI。
- `[規則] 主工作區協作與交接` 是政策提示，不是 sweep work。
- Server startup 會修復固定名稱、成員角色、規則 task 與 legacy 討論；成功登入時也會同步該使用者。既有 legacy `task.discussion_started` 事件只供歷史 replay，新的主工作區收尾使用 `task.main_discussion_concluded`。

窗口 readback（UTC）可用：

```bash
sqlite3 data/dev.db "SELECT task_id, opened_at, wait_half_days, due_at FROM main_discussion_windows ORDER BY opened_at DESC LIMIT 20;"
```

### 2026-07-12 rollout 驗收

- `master` merge：`efbeb4b`；`npm test`、`npm run build`、`git diff --check` 通過。
- `task-tracker.service` restart 後 `/api/health` 回 HTTP 200 與 `{"status":"ok","db":true}`。
- DB readback：workspace active、1 Owner + 29 Commenter、唯一 `[規則] 主工作區協作與交接`，兩筆 legacy task 已正規化為 `[討論]`。
- HTTP smoke：discussion `1086ccfd-96f7-485c-b8da-335bb4058269`；Commenter 建立／留言成功、狀態 PATCH 為 403；user01 以單一 `task.discussion_started` 指派自己，建立 canonical task `af06f594-682c-4437-aea5-d71eb354471c`、回寫完整 URL，並完成 Doing → Review → Done。
- Commenter description smoke：自建 task `15b9852a-9190-4868-b9a2-6023ad744c0a` 的描述 PATCH 為 200，標題／狀態為 403，user03 修改其描述為 400；user02 在非主工作區 `79618d0f-2401-41e5-a858-c4d10dedd338` 仍為 Member，task `a48e1048-feab-4214-b1ac-f195fdaf6f9c` 的標題與描述 PATCH 均為 200。
- Live AI sweep 與 SIM timers 未啟用，仍需明確人工授權。

## Sim harness

### Notification preflight

Every automated Owner and configured member session (`user01`, `user02`–`user06`) first snapshots its own unread `GET /api/notifications` rows. The driver reads the source task/comment and runs a dedicated API-only notification session before ordinary board work.

Main-workspace sources require a new post-snapshot comment by that actor; when there is no addition the required text is `已閱讀，目前無補充。`. The driver, not the AI session, marks a notification read after this verification. Normal-workspace sources may be read without a compulsory reply. A `403`/`404` or deleted source is logged and marked read; malformed data, network/5xx failures, a failed preflight, or missing/invalid main reply stay unread and skip that actor's ordinary session for this run.

The snapshot is bounded to login time. Notifications received later wait for the next actor session. The runner never creates a self-mention in notification handling. `user09` is not currently a sim runner, so this automation does not consume that account's notifications. This is not a frontend inbox and does not authorize running a live sweep.

每筆未讀 notification 都是獨立處理單位：同一 task 的三筆通知會各自建立 bounded prompt、各自呼叫 AI、各自驗證留言並 read back。內容重複時，後續通知仍須由 AI 閱讀判斷，但可只留下固定的 `已閱讀，目前無補充。`（或等價的無補充訊息）；不得把多筆通知合成一筆。每個 prompt 上限 16,000 字元，超長留言會保留來源留言並明確省略其餘 context，固定規則與來源仍超限時 fail closed 並保留未讀。

#### 全成員通知巡檢

`--sweep team` 與 `--sweep both` 每個 tick 會依序巡檢目前設定的 user02–user06，與成員是否有 Todo/Doing 任務無關。每位成員都會登入並 snapshot 自己的未讀通知；零未讀只寫入 `notification-sweep` 結束紀錄，不啟動 AI。若有未讀，才啟動 dedicated API-only notification session，沿用上方來源讀取、主工作區回覆驗證、不得 @自己與 driver 標已讀規則。

通知巡檢不建立 worktree、不 commit，也不占用一般 member task budget。登入、API、preflight 或主工作區留言驗證失敗時，該成員的未讀保留，且本 tick 跳過該成員的一般工作；其他成員照常繼續。`--sweep owner` 不啟動 user02–user06 通知巡檢；user01 仍由 owner session 的既有 gate 處理，user09 目前不在 sim runner 範圍。

#### SIM managed roster 與派工

自動成員同步只套用在 `CANONICAL_WORKSPACE_BY_REPOROOT` 登記的 task-tracker canonical workspace，以及本次 bootstrap 新建的 SIM workspace；不會回填主協作工作區、歷史 workspace 或其他既有一般 workspace。同步會補缺少的 user02–user06、把 Viewer/Commenter 升為 Member，保留既有 Member/Admin/Owner；局部 invite/join 失敗時該帳號不進 eligible roster，其他已就緒成員仍可運作。主協作工作區的 user06 仍維持 Commenter。

Owner 依成員 profile 與目前 Todo/Doing 負載直接 PATCH `assignee_id`，並在每次派工留下 `【OWNER派工】`（負責人、專長理由、下一個可驗收成果）。Scheduler 只啟動 eligible runner 名下的 Todo/Doing；依 Doing 優先、同狀態最舊 `updated_at`、email tie-break 選最多 3 位 member（`memberBudget=3`）。無 assignee 的 Todo 採嚴格模式：不啟動任何 member、沒有 timeout 自行認領或 fallback；沒有合適 runner 時由 Owner 留 `[ESCALATE]`。

### Prerequisites

- Run commands from `/home/hom/code/task-tracker`.
- `task-tracker.service` must answer HTTP 200 at `http://localhost:3000/api/health`.
- Run `npm run seed` once so `user01-06@test.local` and `user09@test.local` exist.
- The `claude` and `codex` CLIs must be installed, authenticated, and available in `PATH`.
- user06 ordinary work uses Claude `claude-sonnet-5` with no AGY fallback; its notification preflight uses Codex `gpt-5.4-mini`.
- Historical evidence only: the following AGY curl capability probe was invoked once on 2026-07-16:

  ```bash
  agy --print --model 'Gemini 3.5 Flash (High)' --mode accept-edits --dangerously-skip-permissions 'Use curl to GET http://localhost:3000/api/health. Output the HTTP status and JSON body only. Do not modify any file or call a POST, PATCH, PUT, or DELETE endpoint.'
  ```

  Its exact result was `exit 1: socket: operation not permitted`, before curl, so no curl or board mutation occurred and it did not output HTTP 200 or the health JSON. This does not authorize or require AGY for current user06 work. Available main-workspace sources require a verified actor comment before being marked read, and preflight failures remain unread; the documented `403`/`404` unavailable-source handling still logs and marks the item read. Do not add shared `--dangerously-skip-permissions`.
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
