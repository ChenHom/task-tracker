# Deploy

`task-tracker.service` is the user-level systemd unit for the local Task Tracker deployment.

Install/update:

```bash
npm run build
install -D -m 664 deploy/task-tracker.service /home/hom/.config/systemd/user/task-tracker.service
systemctl --user daemon-reload
systemctl --user enable task-tracker.service
systemctl --user restart task-tracker.service
```

Operate:

```bash
systemctl --user start task-tracker.service
systemctl --user stop task-tracker.service
systemctl --user restart task-tracker.service
systemctl --user reload task-tracker.service
```

## Autodeploy

`sim-autodeploy.path` watches the local `master` ref; on change it runs `sim-autodeploy.sh`
(waits for any in-flight sim sweep, re-reads the target revision, `npm run build`, restarts
the service, then verifies `/api/health` `rev` matches that target). If `master` advances
during build or restart, it retries up to three times. Build failure, persistent revision
churn, or readback mismatch notifies Discord via `sim/notify-human.sh` and leaves the old
version running.

Pilot copy:

`deploy/sim-autodeploy-pilot.service` is a dry-run sandbox copy. It keeps the same repo
build path, but writes to `~/.local/state/sim-autodeploy-pilot` and sets
`SIM_AUTODEPLOY_SKIP_RESTART=1`, so it can exercise the build, user-bus read-only check,
and local health readback without restarting the live `task-tracker.service`.
Treat it as manual-start only; do not enable it alongside the live autodeploy path.

Install/update:

```bash
chmod +x deploy/sim-autodeploy.sh
install -D -m644 deploy/sim-autodeploy.path deploy/sim-autodeploy.service -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sim-autodeploy.path
# initialize state so the currently deployed rev is not re-deployed
mkdir -p ~/.local/state/sim-autodeploy
git rev-parse master > ~/.local/state/sim-autodeploy/deployed_rev
```

Disable: `systemctl --user disable --now sim-autodeploy.path`
Logs/state: `~/.local/state/sim-autodeploy/deploy.log`, `deployed_rev`; `journalctl --user -u sim-autodeploy.service`

See `docs/operations.md` for verification and troubleshooting.

Goal 交付證據與 worktree 狀態只允許 production coordinator 寫入。在啟用 coordinator 前，
建立 mode `0600` 的 `~/.config/task-tracker/coordinator.env`，並設定一個高強度隨機值：

```bash
TASK_TRACKER_COORDINATOR_TOKEN=<random secret>
TASK_TRACKER_REPO_REGISTRY_PATH=/absolute/path/to/repo-registry.json
```

`task-tracker.service` 與 `sim-coordinator.service` 會讀取同一個檔案；未設定時兩個寫入 API 皆 fail closed 為 403。

## Goal discovery timer（預設停用）

`goal-discovery.timer` 每 12 小時建立一次機械巡檢 heartbeat。安裝單元不代表啟用；先建立
`~/.config/task-tracker/goal-discovery.env`，內含 `GOAL_PATROL_WORKSPACE_ID=<workspace UUID>` 與
`TASK_TRACKER_REPO_REGISTRY_PATH=/absolute/path/to/repo-registry.json`，再以
`systemd-analyze verify` 與手動不帶 `--live` 的 dry-run 確認。unit 含 `--live`：通過機械 gate 時
會呼叫 Claude safe discovery；Owner 永遠不建立 Workspace，但沒有合適 Project 時可在同一 Workspace
為 registry 已登記的 repo 建立 Project。

```bash
install -D -m644 deploy/goal-discovery.service deploy/goal-discovery.timer -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemd-analyze verify deploy/goal-discovery.service deploy/goal-discovery.timer
```

需另經人工核准才可執行 `systemctl --user enable --now goal-discovery.timer`。

## Goal coordinator timer（預設停用）

```bash
install -D -m644 deploy/goal-coordinator.service deploy/goal-coordinator.timer -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemd-analyze verify deploy/goal-coordinator.service deploy/goal-coordinator.timer
```

此 timer 每分鐘處理一個 pending Goal heartbeat；只有人工核准後才可執行
`systemctl --user enable --now goal-coordinator.timer`。
