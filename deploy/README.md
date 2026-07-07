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

See `docs/operations.md` for verification and troubleshooting.
