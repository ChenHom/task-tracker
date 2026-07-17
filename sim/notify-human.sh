#!/usr/bin/env bash
# 用法: notify-human.sh "訊息"。所有「通知人類」走這裡，之後換管道只改此檔。
# 走 owner-team-report/report.ts 同款 openclaw 路徑；失敗由呼叫方決定是否忽略。
set -u
BIN="${OPENCLAW_BIN:-openclaw}"
exec "$BIN" message send --channel discord --target channel:1515967128317071520 --message "$1"
