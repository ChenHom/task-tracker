# Operations

## Task Tracker systemd service

This app is managed by a user-level systemd unit:

- Unit source: `deploy/task-tracker.service`
- Installed unit: `/home/hom/.config/systemd/user/task-tracker.service`
- Working directory: `/home/hom/code/task-tracker`
- Process: `node dist/server.js`
- Local upstream: `http://127.0.0.1:3000`
- LAN entrypoint: `http://192.168.50.109/tracker/`

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

## 主協作工作區

- 固定 UUID：`11a82028-fc50-466a-a723-e002032cd9a6`
- 固定名稱：`主協作工作區`
- `user01@test.local` 是唯一 Owner；其他內部使用者同步為 Commenter。
- Commenter 在任何 workspace 都可修改自己建立 task 的 description，但不可修改標題、狀態、其他屬性、附件或他人 task。
- 只有主協作工作區會同步其他內部使用者為 Commenter；其他 workspace 的新成員預設仍為 Member，Owner 可另行調整角色。
- 主協作工作區所有人都可建立 Todo 討論與留言；只有 user01 可改變 task 狀態。
- user01 將 Todo 移至 Doing 時，單一 `task.discussion_started` event 會同時指派 runtime user01。
- 決議後先判斷 target repo，再於 canonical／對應 workspace 建立實作 task，並在原討論回寫完整 task URL；實作 task 不留在主協作工作區。
- `[規則] 主工作區協作與交接` 是政策提示，不是 sweep work。
- Server startup 會修復固定名稱、成員角色、規則 task 與 legacy 討論；成功登入時也會同步該使用者。

### 2026-07-12 rollout 驗收

- `master` merge：`efbeb4b`；`npm test`、`npm run build`、`git diff --check` 通過。
- `task-tracker.service` restart 後 `/api/health` 回 HTTP 200 與 `{"status":"ok","db":true}`。
- DB readback：workspace active、1 Owner + 29 Commenter、唯一 `[規則] 主工作區協作與交接`，兩筆 legacy task 已正規化為 `[討論]`。
- HTTP smoke：discussion `1086ccfd-96f7-485c-b8da-335bb4058269`；Commenter 建立／留言成功、狀態 PATCH 為 403；user01 以單一 `task.discussion_started` 指派自己，建立 canonical task `af06f594-682c-4437-aea5-d71eb354471c`、回寫完整 URL，並完成 Doing → Review → Done。
- Commenter description smoke：自建 task `15b9852a-9190-4868-b9a2-6023ad744c0a` 的描述 PATCH 為 200，標題／狀態為 403，user03 修改其描述為 400；user02 在非主工作區 `79618d0f-2401-41e5-a858-c4d10dedd338` 仍為 Member，task `a48e1048-feab-4214-b1ac-f195fdaf6f9c` 的標題與描述 PATCH 均為 200。
- Live AI sweep 與 SIM timers 未啟用，仍需明確人工授權。

## Sim harness

### Prerequisites

- Run commands from `/home/hom/code/task-tracker`.
- `task-tracker.service` must answer HTTP 200 at `http://localhost:3000/api/health`.
- Run `npm run seed` once so `user01-05@test.local` exist.
- The `claude` and `codex` CLIs must be installed, authenticated, and available in `PATH`.
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
