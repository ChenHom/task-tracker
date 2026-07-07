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
