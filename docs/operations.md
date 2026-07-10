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

### Automatic sweeps

Installed user units and wrapper:

- `~/.config/systemd/user/sim-sweep-owner.timer`: runs at `:00` and `:30` every hour.
- `~/.config/systemd/user/sim-sweep-team.timer`: runs at `:15` every hour.
- `~/.local/bin/sim-sweep-cron.sh`: checks for an existing sim process and verifies `/api/health` before invoking `npm run sim -- --sweep <role>`.

Enable both timers:

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
