# Deploying Tideholm

The whole game is one Node process and one JSON file. That means: **exactly
one instance**, ever. The server enforces this with a lockfile, and it keeps
rolling backups in `data/backups/` (every 15 min, last 24 kept).

Pick one of the two recipes.

## Option A — your own VPS (recommended)

Any $5 box (Debian/Ubuntu) with a domain pointed at it.

```sh
# on the server
sudo adduser --system --group --home /opt/tideholm tideholm
sudo apt install -y nodejs caddy       # node >= 18
sudo -u tideholm git clone <your-repo> /opt/tideholm

sudo cp /opt/tideholm/deploy/tideholm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tideholm

# edit the domain in deploy/Caddyfile, then:
sudo cp /opt/tideholm/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

That's it: Caddy fetches the TLS certificate automatically and proxies to
the game. `TRUST_PROXY=1` (set in the unit) makes the game read the real
client IP for rate limiting and mark session cookies `Secure`.

Updating: `cd /opt/tideholm && sudo -u tideholm git pull && sudo systemctl restart tideholm`.
The world file survives restarts; `migrateWorld` upgrades old saves in place.

## Option B — Fly.io (no server to manage)

```sh
fly launch --copy-config --no-deploy
fly volumes create tideholm_data --size 1
fly deploy
```

See `deploy/fly.toml`. Keep `min_machines_running = 1` and never scale
beyond one machine — the world is a single file on the volume.

## Choosing a game speed

`GAME_SPEED` scales production and divides build times (storage capacity is
fixed by design):

| Speed | Feel |
|---|---|
| 1 | Classic: multi-day buildings, log in twice a day |
| 2 | Recommended for a public world |
| 5 | Fast world: hours instead of days |
| 100+ | Testing only — storage pins at cap and the economy degenerates |

Changing speed on an existing world is safe (already-queued timers keep
their old finish times).

## Operations

- **Backups**: `data/backups/` rolls automatically. To restore: stop the
  server, copy a backup over `data/world.json`, start.
- **Fresh world**: stop, delete `data/world.json`, start.
- **Logs**: `journalctl -u tideholm -f` (POST actions and errors only;
  polling is not logged).
- **Health**: `curl -s localhost:3000/ -o /dev/null -w '%{http_code}'` → 200.
