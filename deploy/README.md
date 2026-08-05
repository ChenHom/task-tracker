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
