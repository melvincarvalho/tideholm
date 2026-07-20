# Season boundary checklist

The flip that ends one season and opens the next. Rehearsed 2026-07-18;
season-3 balance validated by simulation the same day (attacker win rate
82%, walls hold 42%, loot 126/unit lost, no runaway winner — with
BOT_GARRISON_RATIO=12 and BOT_MORALE_FLOOR=1 active).

The restart is also the moment the on-disk code goes live: whatever landed
on `gh-pages` since the last restart (this cycle: Beacon 6, bot
personalities/wolves/barbarians, vengeance doctrine) starts with the new
world. Never restart production mid-season unless you mean to activate it.

## Before the boundary (dev box, any time)

1. Land anything that must ship with the season; `node tests.js` green.
2. Review `deploy/next-season.env` — it IS the season's ruleset record.
3. Push `gh-pages`.

## At the boundary

**Dev box — tag the closing season:**

    git tag -a season-2-end -m "Season 2 ends; ruleset: defaults at speed 1"
    git push origin --tags

**Production (ssh ubuntu@nostr.social):**

    cd ~/tideholm
    ./deploy/apply-next-season-prod.sh              # dry run — read it
    ./deploy/apply-next-season-prod.sh --confirm    # the flip
    # optional explicit start time instead of next 17:00 Berlin:
    #   ./deploy/apply-next-season-prod.sh 2026-07-20T18:00:00Z --confirm

The script: ffwd-pulls, archives the world to
`jss-plugin/data/game/backups/world-season-end-<ts>.json`, clears it,
exports the staged env + ADMIN_TOKEN (from `.admin-token`) + WORLD_START,
`pm2 restart tideholm --update-env`, then verifies the server answers and
prints admin stats. The hall of fame survives by design.

## Just after

- **Write the chronicle** (dev box). Fetch the season-end archive the flip
  just made, sanitize it ON THE SERVER before it travels (drop sessions,
  messages, boards, offers, and every player's salt/hash — mail and boards
  are private and must never enter git), then generate the page:

      ssh ubuntu@nostr.social "python3 - <<'EOF'
      import json
      w = json.load(open(sorted(__import__('glob').glob('/home/ubuntu/tideholm/jss-plugin/data/game/backups/world-season-end-*.json'))[-1]))
      for k in ('sessions','messages','boards','offers'): w.pop(k, None)
      for p in w['players']: p.pop('salt', None); p.pop('hash', None)
      print(json.dumps(w))
      EOF" > seasons/archive/season-N.json
      node tools/chronicle.js seasons/archive/season-N.json N > public/seasons/season-N.html

  Commit both, push, pull on prod. The Hall of Fame links to
  `seasons/season-N.html` automatically.
- Open the site: the pregame countdown banner should show the start time.
- Register/log in works; world is frozen (no production, no bot moves).
- Announce via `/admin.html` if the previous season's players should hear
  where the new world is and when it opens.

## First hours of the new season

- Watch `pm2 logs tideholm` for anything unusual.
- Expect: bots act from launch (personas rolled at spawn — a couple of
  wolves, a few map-marked barbarians); loyalty meter on every island;
  Beacon now wins at level 6.
- If anything is wrong, the archived world can be restored: stop, copy the
  season-end archive back to `world.json`, restart with the OLD env.
