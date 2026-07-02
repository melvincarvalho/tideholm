# Tideholm

A browser-based island empire game in the spirit of the classic early-2000s
German browser strategy games — slow real-time timers, table-driven UI,
alliances-and-raids gameplay. Original name, assets, text and numbers.

Bots play alongside humans using the exact same rules and actions.

## Run

```sh
node server.js
```

Then open http://localhost:3000 and register with any name + password.

No dependencies. State is saved to `data/world.json` every 30 seconds and on
shutdown. Delete that file to start a fresh world.

### Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | 3000 | HTTP port |
| `GAME_SPEED` | 5 | Multiplies production, divides build times. 1 ≈ classic pace (hours), 5 = minutes. |
| `BOTS` | 20 | Bots spawned when a new world is created |
| `FREE_ISLES` | 30 | Uncharted (colonizable) islands on a new world |

## Gameplay

- One island per player on a 40×40 ocean grid.
- Three resources — wood 🪵, stone 🪨, gold 🪙 — produced in real time by the
  Lumberyard, Quarry and Gold Mine.
- Storehouse caps how much you can hold; Island Hall speeds up construction.
- Sequential build queue (max 3), costs rise ~1.55× per level.
- Build a Barracks to train troops: Spearman (all-rounder), Raider
  (offense + big carry), Sentinel (defense).
- Click any island on the map to attack it. Travel time depends on distance
  and your slowest unit; the battle resolves on arrival, the winner loots
  proportionally to surviving carry capacity, and survivors march home.
- Battle reports for both sides; incoming attacks show origin and ETA.
- Build a Harbor to launch Colony Ships, then click an uncharted (gray)
  island to settle it. First ship to land claims it; latecomers sail home.
  Switch between your islands with the dropdown in the header.
- Conquest: send a Flagship with your attack. If it survives a victory the
  island is captured — buildings, stores and all — and the surviving army
  garrisons it. Armies returning to a lost island scatter. A player whose
  last island falls respawns on a fresh one.
- Rankings tab: every player by total points. Mail tab: write to any human
  player. Alliance tab: found an alliance (name + tag), invite players,
  accept or decline invitations. Allies cannot attack each other, and
  alliance tags show on the map and rankings.
- Bots play for real: they grow their economy, keep garrisons, raid nearby
  islands for loot, hold grudges and strike back at whoever attacks them,
  and expand to uncharted islands (up to 3 each) — all through the same
  game actions humans use. Beginner protection: bots ignore players under
  40 points and won't attack anyone more than 3× their size.

## Combat model

Attack power A vs defense power D (home garrison defends). If A > D the
attacker wins and loses fraction `(D/A)^1.5` of the army; the defender's
garrison is wiped. Otherwise the attacker is wiped and the defender loses
`(A/D)^1.5`. Loot is capped by the survivors' carry capacity, drawn
proportionally from the target's stocks.

If a Flagship survives a winning attack, the island changes owner instead of
being looted: the Flagship is consumed, survivors stay as the garrison, and
the island's buildings and resources transfer. An attack that arrives at an
island you already own (e.g. captured by an earlier wave) reinforces it.

## Roadmap

1. ✅ Core loop: login, resources, buildings, queue, map, bots
2. ✅ Units + combat: barracks, troops, attacks with travel time, battle reports
3. ✅ Colonization: harbor, colony ships, uncharted islands, multi-island play
4. ✅ Conquest: flagships, island capture, respawn after elimination
5. ✅ Bot war AI: raids, grudges and retaliation, bot expansion
6. ✅ Alliances, messaging, rankings

## Running it for real

See `deploy/DEPLOY.md` — a systemd + Caddy recipe for a VPS, or Fly.io.
The server enforces a single instance via a lockfile, keeps rolling world
backups in `data/backups/`, rate-limits registration/login per IP and
actions per player, and logs actions and errors (not polling) to stdout.
Set `TRUST_PROXY=1` behind a reverse proxy so rate limiting sees real
client IPs and session cookies are marked `Secure`.

Run the engine test suite with `node tests.js`.

## Layout

- `game.js` — pure game engine (formulas, lazy time resolution, actions, persistence)
- `bots.js` — bot spawn + decision tick, built on the same engine actions
- `server.js` — zero-dependency HTTP server, sessions, JSON API, static files,
  rate limiting, lockfile, backups
- `public/` — vanilla JS single-page client (+ `help.html`)
- `tests.js` — engine math and invariant tests
- `deploy/` — systemd unit, Caddyfile, Dockerfile, fly.toml, deploy guide
