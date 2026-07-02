# Tideholm

A browser-based island empire game in the spirit of the classic early-2000s
German browser strategy games — slow real-time timers, table-driven UI,
alliances-and-raids gameplay. Original name, assets, text and numbers.

Bots play alongside humans using the exact same rules and actions.

Available in **English, German and Czech** — pick a language on the login
screen or in-game; the whole UI, error messages and even battle reports are
rendered in each player's own language (`public/i18n.js` holds the
dictionary; adding a language is one new block there plus a help page).

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
| `WORLD_THEME` | generated | Map backdrop: `generated` (seeded fictional chart) or `aegean` (real coastlines from public-domain Natural Earth data; build other regions with `tools/build-region.js`) |

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
- Conquest is loyalty-based: every island has loyalty 0-100. Each winning
  attack with a surviving Flagship breaks 25-40 of it; at 0 the island is
  captured — buildings, stores and all — and the surviving army garrisons
  it. Loyalty regenerates over time, so conquest takes waves. A fresh
  conquest starts restive at 25. Armies returning to a lost island scatter.
  A player whose last island falls respawns on a fresh one.
- Support: station troops on any inhabited island as defenders (allies, or
  your own islands as transfers), recall them anytime. Stationed troops
  fight and die with the garrison; their owner gets battle reports.
- Scouts spy out garrisons, stores, loyalty and buildings — contested by
  the defender's own scouts (counter-espionage).
- Wall strengthens all defenders and takes damage when the island is
  sacked. Farm caps population: every unit costs pop, bigger armies need
  bigger farms.
- Trade: ship resources to any inhabited island (allies or your own) from
  the Harbor — capacity 250 × 1.5^(level-1) per shipment.
- Quality of life: rename your islands, a battle simulator in the attack
  panel, the map centers on your island, and unicode player names.
- Morale: attacking a much smaller player blunts your attack (down to 30%).
  Optional night defense bonus via `NIGHT_BONUS=22-6`.
- Victory: a player or alliance holding `WIN_SHARE` (default 60%) of all
  islands wins the world — announced to everyone, banner in the UI. Start
  a new season by deleting `data/world.json`.
- Bots wage real war: they scout targets and remember the intel, skip
  fortresses, favor soft targets, and run flagship conquest campaigns
  against empires their own size — never against small humans (<150 pts).
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

Defense counts the garrison plus all stationed support, then the Wall:
`D = (defenders + 15×wall) × (1 + 0.08×wall)`. A sacked island loses one
wall level.

If a Flagship survives a winning attack it breaks 25-40 loyalty; at 0 the
island changes owner: the Flagship is consumed, survivors stay as the
garrison, and the island's buildings and resources transfer. Loyalty
regenerates at 2/h (×speed). An attack that arrives at an island you
already own (e.g. captured by an earlier wave) reinforces it.

## Roadmap

1. ✅ Core loop: login, resources, buildings, queue, map, bots
2. ✅ Units + combat: barracks, troops, attacks with travel time, battle reports
3. ✅ Colonization: harbor, colony ships, uncharted islands, multi-island play
4. ✅ Conquest: flagships, island capture, respawn after elimination
5. ✅ Bot war AI: raids, grudges and retaliation, bot expansion
6. ✅ Alliances, messaging, rankings
7. ✅ War depth: loyalty conquest, support troops, scouts, wall, farm cap
8. ✅ Trade shipments + QoL: renaming, battle simulator, map centering
9. ✅ Bot war college, dominance victory, morale, night bonus

## Running it for real

See `deploy/DEPLOY.md` — a systemd + Caddy recipe for a VPS, or Fly.io.
The server enforces a single instance via a lockfile, keeps rolling world
backups in `data/backups/`, rate-limits registration/login per IP and
actions per player, and logs actions and errors (not polling) to stdout.
Set `TRUST_PROXY=1` behind a reverse proxy so rate limiting sees real
client IPs and session cookies are marked `Secure`.

Run the engine test suite with `node tests.js`. Balance-test a simulated
world with `node playtest.js [days] [bots]`.

Set `ADMIN_TOKEN` to enable the admin panel at `/admin.html`: world stats,
announcements to all players, and season reset (archives the old world to
`data/backups/`, keeps the hall of fame). Without the env var the admin
API is disabled entirely.

## Layout

- `game.js` — pure game engine (formulas, lazy time resolution, actions, persistence)
- `bots.js` — bot spawn + decision tick, built on the same engine actions
- `server.js` — zero-dependency HTTP server, sessions, JSON API, static files,
  rate limiting, lockfile, backups
- `public/` — vanilla JS single-page client (+ `help.html`)
- `tests.js` — engine math and invariant tests
- `deploy/` — systemd unit, Caddyfile, Dockerfile, fly.toml, deploy guide
