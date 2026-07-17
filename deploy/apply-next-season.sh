#!/usr/bin/env bash
# Apply the STAGED next-season config to the pm2 'tideholm-jss' instance.
#
# What it does (only with --confirm):
#   1. Reads ADMIN_TOKEN from the running process (secret never touches a file).
#   2. Computes WORLD_START = next 17:00 Europe/Berlin, or uses $1 (ISO or epoch ms).
#   3. Archives the LIVE world (jss-plugin/data/game/world.json) into backups/.
#   4. Removes it so the app boots a FRESH world, frozen until WORLD_START.
#   5. pm2 restart tideholm-jss --update-env  (loads HEAD code + the new env).
#   6. Verifies the new world is frozen and running at speed 1.
#
# Without --confirm it prints a DRY-RUN plan and changes nothing.
# This is a SEASON-BOUNDARY action: it ends the current world. Do NOT run it
# while a season you care about is in progress.

set -euo pipefail

APP=tideholm-jss
ROOT=/home/melvin/ideas/inselkampf
ENV_FILE="$ROOT/deploy/next-season.env"
WORLD="$ROOT/jss-plugin/data/game/world.json"
BACKUPS="$ROOT/jss-plugin/data/game/backups"

CONFIRM=0
ARG_START=""
for a in "$@"; do
  case "$a" in
    --confirm) CONFIRM=1 ;;
    *) ARG_START="$a" ;;
  esac
done

# --- resolve the launch time --------------------------------------------------
if [ -n "$ARG_START" ]; then
  WORLD_START="$ARG_START"
else
  # Next 17:00 in Europe/Berlin (handles CET/CEST automatically). Parse the
  # wall-clock time IN Berlin to an epoch, then render that instant in UTC —
  # do NOT use `date -u -d "17:00"` (that would read 17:00 as UTC).
  now=$(TZ=Europe/Berlin date +%H%M)
  if [ "$now" -lt 1700 ]; then day=$(TZ=Europe/Berlin date +%Y-%m-%d)
  else day=$(TZ=Europe/Berlin date -d tomorrow +%Y-%m-%d); fi
  epoch=$(TZ=Europe/Berlin date -d "$day 17:00" +%s)
  WORLD_START=$(date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ)
fi

# --- preserve the admin token from the live process ---------------------------
PID=$(pm2 pid "$APP" 2>/dev/null | tr -d '[:space:]')
ADMIN_TOKEN=""
if [ -n "$PID" ] && [ -r "/proc/$PID/environ" ]; then
  ADMIN_TOKEN=$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^ADMIN_TOKEN=//p')
fi

echo "=== next-season plan ==="
echo "app          : $APP (pid ${PID:-<not running>})"
echo "env file     : $ENV_FILE"
echo "GAME_SPEED   : 1  (from env file)"
echo "WORLD_START  : $WORLD_START  ($(TZ=Europe/Berlin date -d "$WORLD_START" '+%a %d %b %H:%M %Z'))"
echo "balance      : PROTECT_GRACE_HOURS=48 BOT_GARRISON_RATIO=12 BOT_MORALE_FLOOR=1"
echo "ADMIN_TOKEN  : $([ -n "$ADMIN_TOKEN" ] && echo 'preserved from live process' || echo 'NOT FOUND — set it before applying')"
echo "live world   : $WORLD"
echo "will archive : $BACKUPS/world-season-end-<stamp>.json  then start FRESH"
echo

if [ "$CONFIRM" -ne 1 ]; then
  echo "DRY RUN — nothing changed. Re-run with --confirm to apply at the season boundary."
  exit 0
fi

if [ -z "$ADMIN_TOKEN" ]; then
  echo "ERROR: ADMIN_TOKEN not found on the live process; refusing to drop the admin panel." >&2
  echo "       export ADMIN_TOKEN=... and re-run." >&2
  exit 1
fi

# --- archive + fresh world ----------------------------------------------------
mkdir -p "$BACKUPS"
if [ -f "$WORLD" ]; then
  stamp=$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
  cp "$WORLD" "$BACKUPS/world-season-end-$stamp.json"
  rm "$WORLD"
  echo "archived prior season -> $BACKUPS/world-season-end-$stamp.json (fresh world will be created)"
fi

# --- load env + restart -------------------------------------------------------
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
export ADMIN_TOKEN WORLD_START
set +a

pm2 restart "$APP" --update-env >/dev/null
echo "restarted $APP onto HEAD with the next-season env."

# --- verify -------------------------------------------------------------------
sleep 3
echo "=== verify ==="
curl -s "localhost:${PORT:-3210}/tideholm/api/state" \
  -H "Authorization: Bearer $ADMIN_TOKEN" 2>/dev/null \
  | grep -oE '"(speed|startAt|phase)":[^,}]+' | head || true
echo "done — new world is frozen until $WORLD_START, then runs at speed 1."
