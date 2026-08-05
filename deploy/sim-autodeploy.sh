#!/usr/bin/env bash
# master 變動時自動 build + restart task-tracker.service，並以 /api/health 的 rev 做 readback。
# 由 sim-autodeploy.path 觸發；gate 只做 build（測試屬合併階段的責任，e2e 與 port 3000 正式服務會互踩）。
set -euo pipefail
REPO="${SIM_AUTODEPLOY_REPO:-/home/hom/code/task-tracker}"
STATE="${SIM_AUTODEPLOY_STATE_DIR:-/home/hom/.local/state/sim-autodeploy}"
TARGET_SERVICE="${SIM_AUTODEPLOY_TARGET_SERVICE:-task-tracker.service}"
HEALTH_URL="${SIM_AUTODEPLOY_HEALTH_URL:-http://localhost:3000/api/health}"
LOG="$STATE/deploy.log"
mkdir -p "$STATE"
cd "$REPO"
HEAD=$(git rev-parse master)
DEPLOYED=$(cat "$STATE/deployed_rev" 2>/dev/null || echo none)
[ "$HEAD" = "$DEPLOYED" ] && exit 0
# ponytail: sweep 進行中就等（最多 30 分），避免重啟打斷 in-flight session
for _ in $(seq 60); do
  pgrep -f '\.bin/tsx sim/run\.ts' >/dev/null || break
  sleep 30
done
echo "[$(date -Is)] deploying $HEAD (was $DEPLOYED)" >>"$LOG"
if ! npm run build >>"$LOG" 2>&1; then
  echo "[$(date -Is)] BUILD FAILED, not restarting" >>"$LOG"
  "$REPO/sim/notify-human.sh" "⚠️ autodeploy build FAILED at $HEAD（服務仍跑舊版 $DEPLOYED）" || true
  exit 1
fi
if [ "${SIM_AUTODEPLOY_SKIP_RESTART:-0}" = 1 ]; then
  if [ "${SIM_AUTODEPLOY_SKIP_BUS_CHECK:-0}" = 1 ]; then
    ACTIVE_STATE=skipped
    SUB_STATE=skipped
  else
    ACTIVE_STATE=$(systemctl --user show "$TARGET_SERVICE" --property=ActiveState --value)
    SUB_STATE=$(systemctl --user show "$TARGET_SERVICE" --property=SubState --value)
  fi
  REV=$(curl -sf --max-time 10 "$HEALTH_URL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).rev))" || echo readback-failed)
  echo "[$(date -Is)] PILOT DRY RUN active=$ACTIVE_STATE/$SUB_STATE health_rev=$REV" >>"$LOG"
  exit 0
fi
systemctl --user restart "$TARGET_SERVICE"
sleep 3
REV=$(curl -sf --max-time 10 "$HEALTH_URL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).rev))" || echo readback-failed)
if [ "$REV" = "$HEAD" ]; then
  echo "$HEAD" >"$STATE/deployed_rev"
  echo "[$(date -Is)] deployed OK rev=$REV" >>"$LOG"
else
  echo "[$(date -Is)] READBACK MISMATCH rev=$REV head=$HEAD" >>"$LOG"
  "$REPO/sim/notify-human.sh" "⚠️ autodeploy readback 不符：health rev=$REV, master=$HEAD" || true
  exit 1
fi
