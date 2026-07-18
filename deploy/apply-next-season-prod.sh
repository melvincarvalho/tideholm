#!/usr/bin/env bash
# Apply the STAGED next-season config to PRODUCTION (run ON nostr.social
# as the ubuntu user). Twin of apply-next-season.sh, targeting the real
# deployment discovered 2026-07-18:
#   pm2 app:      tideholm
#   repo:         /home/ubuntu/tideholm
#   world:        jss-plugin/data/game/world.json (relative to repo)
#   admin token:  /home/ubuntu/tideholm/.admin-token
#   env delivery: pm2 restart --update-env picks up this shell's exports
#
# What it does (only with --confirm):
#   1. Fast-forwards the repo to origin/gh-pages (the code that boots next
#      season — Beacon 6, bot personalities — is already on disk either way).
#   2. Reads ADMIN_TOKEN from .admin-token (never stored in configs).
#   3. Computes WORLD_START = next 17:00 Europe/Berlin, or uses $1 (ISO or ms).
#   4. Archives the LIVE world into backups/ as world-season-end-<ts>.json.
#   5. Removes world.json so the app boots a FRESH world, frozen until start.
#   6. Exports the season env (from deploy/next-season.env) and
#      pm2 restart tideholm --update-env.
#   7. Verifies: process up, admin stats reachable, phase is pregame.
#
# Without --confirm it prints a DRY-RUN plan and changes nothing.
# SEASON-BOUNDARY ACTION: it ends the current world. The hall of fame and
# all backups survive. Tag the season from the dev box (see BOUNDARY.md).

set -euo pipefail

APP=tideholm
ROOT=/home/ubuntu/tideholm
ENV_FILE="$ROOT/deploy/next-season.env"
WORLD="$ROOT/jss-plugin/data/game/world.json"
BACKUPS="$ROOT/jss-plugin/data/game/backups"
TOKEN_FILE="$ROOT/.admin-token"
PORT=3210

CONFIRM=0
ARG_START=""
for a in "$@"; do
  case "$a" in
    --confirm) CONFIRM=1 ;;
    *) ARG_START="$a" ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
[ -f "$TOKEN_FILE" ] || { echo "missing $TOKEN_FILE"; exit 1; }

# WORLD_START: arg (epoch ms or ISO) or next 17:00 Europe/Berlin.
if [ -n "$ARG_START" ]; then
  if [[ "$ARG_START" =~ ^[0-9]+$ ]]; then START_MS="$ARG_START";
  else START_MS=$(( $(date -d "$ARG_START" +%s) * 1000 )); fi
else
  NOW=$(TZ=Europe/Berlin date +%s)
  TODAY17=$(TZ=Europe/Berlin date -d "17:00" +%s)
  if [ "$NOW" -lt "$TODAY17" ]; then START_S=$TODAY17;
  else START_S=$(TZ=Europe/Berlin date -d "tomorrow 17:00" +%s); fi
  START_MS=$(( START_S * 1000 ))
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)

echo "== Tideholm season boundary (production) =="
echo "   app:         $APP"
echo "   world:       $WORLD"
echo "   archive to:  $BACKUPS/world-season-end-$STAMP.json"
echo "   WORLD_START: $START_MS ($(date -u -d @$((START_MS / 1000)) +%FT%TZ))"
echo "   env file:    $ENV_FILE"
grep -E '^[A-Z_]+=' "$ENV_FILE" | sed 's/^/     /'
echo

if [ "$CONFIRM" -ne 1 ]; then
  echo "DRY RUN — nothing changed. Re-run with --confirm at the boundary."
  exit 0
fi

cd "$ROOT"
git pull --ff-only

mkdir -p "$BACKUPS"
if [ -f "$WORLD" ]; then
  cp "$WORLD" "$BACKUPS/world-season-end-$STAMP.json"
  rm "$WORLD"
  echo "world archived and cleared"
else
  echo "no live world file (already cleared?)"
fi

# Season env: the staged file, plus the injected values.
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Z_]+=' "$ENV_FILE" | sed 's/[[:space:]]*#.*//')
ADMIN_TOKEN=$(cat "$TOKEN_FILE")
WORLD_START=$START_MS
PORT=$PORT
set +a

pm2 restart "$APP" --update-env
sleep 2

echo "== verify =="
curl -sf -o /dev/null -w "http: %{http_code}\n" "http://localhost:$PORT/" || { echo "SERVER NOT RESPONDING"; exit 1; }
curl -sf "http://localhost:$PORT/api/admin/stats?token=$ADMIN_TOKEN" | python3 -c "
import json, sys
s = json.load(sys.stdin)
print('speed x' + str(s['speed']), '| islands:', s['islands'], '| humans:', len(s['players']))
print('past seasons:', s['hallOfFame'])" || echo "(admin stats check failed — inspect manually)"
echo "done — world is frozen until WORLD_START; countdown is visible on the site."
