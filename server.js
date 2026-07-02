// Tideholm — HTTP server. Zero dependencies: node server.js
// Env: PORT (default 3000), GAME_SPEED (default 5), BOTS (default 20)

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const game = require('./game');
const { spawnBots, botTick } = require('./bots');
const { t } = require('./public/i18n.js');

const PORT = Number(process.env.PORT || 3000);
const BOT_COUNT = Number(process.env.BOTS || 20);
const FREE_ISLES = Number(process.env.FREE_ISLES || 30);
const TRUST_PROXY = !!process.env.TRUST_PROXY; // set when behind Caddy/nginx (TLS terminated there)
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 24;

// ---------------------------------------------------------------- single-writer lock

// Two servers sharing one world file would corrupt it. Refuse to start if
// another live process holds the lock.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  const holder = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
  if (holder && holder !== process.pid && pidAlive(holder)) {
    console.error(`Another server (pid ${holder}) already owns ${LOCK_FILE}. Refusing to start.`);
    process.exit(1);
  }
} catch { /* no lock file — fine */ }
fs.writeFileSync(LOCK_FILE, String(process.pid));
function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch { /* already gone */ }
}

// ---------------------------------------------------------------- world

let world = game.loadWorld();
if (!world) {
  world = game.createWorld();
  const n = spawnBots(world, BOT_COUNT);
  for (let i = 0; i < FREE_ISLES; i++) game.newUnchartedIsland(world);
  console.log(`New world created with ${n} bots and ${FREE_ISLES} uncharted isles (speed x${game.SPEED}).`);
  game.saveWorld(world);
} else {
  game.migrateWorld(world);
  console.log(`World loaded: ${world.players.length} players, ${world.islands.length} islands.`);
}

setInterval(() => botTick(world, Date.now()), 15000);
setInterval(() => game.resolveWorld(world, Date.now()), 5000); // battles land on time
setInterval(() => game.checkVictory(world, Date.now()), 60000);
setInterval(() => game.saveWorld(world), 30000);

// Rolling world backups: every 15 minutes, keep the last BACKUP_KEEP.
function backupWorld() {
  try {
    const src = path.join(DATA_DIR, 'world.json');
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(src, path.join(BACKUP_DIR, `world-${stamp}.json`));
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('world-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
      fs.rmSync(path.join(BACKUP_DIR, f));
    }
  } catch (err) {
    console.error('backup failed:', err.message);
  }
}
setInterval(backupWorld, 15 * 60 * 1000);
backupWorld();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { game.saveWorld(world); releaseLock(); process.exit(0); });
}
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
  try { game.saveWorld(world); } catch { /* best effort */ }
  releaseLock();
  process.exit(1);
});

// ---------------------------------------------------------------- rate limiting

const buckets = new Map(); // key -> array of timestamps
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, arr] of buckets) {
    if (!arr.length || arr[arr.length - 1] < cutoff) buckets.delete(k);
  }
}, 600_000);

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}

// ---------------------------------------------------------------- helpers

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Error responses: translate a key (from the engine or our own) for the reader.
function sendErr(res, status, lang, key, params) {
  return sendJson(res, status, { error: t(lang, key, params) });
}

// Translate a game-engine {error, errorParams} result.
function gameErr(res, lang, result) {
  return sendErr(res, 400, lang, result.error, result.errorParams);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
  });
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function sessionPlayer(req) {
  const token = getCookie(req, 'session');
  if (!token) return null;
  const playerId = world.sessions[token];
  if (playerId == null) return null;
  return world.players.find((p) => p.id === playerId) || null;
}

function startSession(res, playerId) {
  const token = crypto.randomBytes(24).toString('hex');
  world.sessions[token] = playerId;
  const secure = TRUST_PROXY ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
}

// ---------------------------------------------------------------- api

function buildingCatalog(island, lang) {
  const out = {};
  for (const key of Object.keys(game.BUILDINGS)) {
    const target = game.pendingLevel(island, key) + 1;
    const cost = game.upgradeCost(key, target);
    out[key] = {
      name: t(lang, `building.${key}.name`),
      desc: t(lang, `building.${key}.desc`),
      level: island.buildings[key],
      nextLevel: target,
      cost,
      time: game.upgradeTime(key, target, island.buildings.hall),
      affordable: game.canAfford(island, cost),
    };
  }
  return out;
}

function unitCatalog(island, lang) {
  const out = {};
  for (const [key, u] of Object.entries(game.UNITS)) {
    const need = u.building || 'barracks';
    out[key] = {
      name: t(lang, `unit.${key}.name`),
      desc: t(lang, `unit.${key}.desc`),
      cost: u.cost,
      atk: u.atk,
      def: u.def,
      carry: u.carry,
      speed: u.speed,
      ship: !!u.ship,
      requires: t(lang, `building.${need}.name`),
      available: island.buildings[need] >= 1,
      time: game.trainTime(key, island.buildings[need]),
      count: island.units[key],
    };
  }
  return out;
}

function movementsFor(world, player) {
  const lang = player.lang || 'en';
  // Uncharted islands keep a canonical stored name; show it in the viewer's language.
  const shownName = (i) => (i.ownerId == null ? t(lang, 'name.uncharted') : i.name);
  const mine = new Set(game.playerIslands(world, player.id).map((i) => i.id));
  const outgoing = [];
  const incoming = [];
  for (const m of world.movements) {
    if (m.ownerId === player.id) {
      const dest = world.islands.find((i) => i.id === m.toId);
      outgoing.push({
        type: m.type,
        target: dest ? `${shownName(dest)} (${dest.x}:${dest.y})` : '?',
        units: m.units,
        loot: m.loot || null,
        arrive: m.arrive,
      });
    } else if (m.type === 'attack' && mine.has(m.toId)) {
      const from = world.islands.find((i) => i.id === m.fromId);
      const target = world.islands.find((i) => i.id === m.toId);
      const owner = world.players.find((p) => p.id === m.ownerId);
      incoming.push({
        from: from ? `${from.name} (${from.x}:${from.y})` : '?',
        target: target ? `${target.name} (${target.x}:${target.y})` : '?',
        attacker: owner ? owner.name : '?',
        arrive: m.arrive,
      });
    }
  }
  return { outgoing, incoming };
}

// The island this request operates on: the requested one if the player owns
// it, otherwise their first.
function myIsland(player, islandId) {
  const mine = game.playerIslands(world, player.id);
  return mine.find((i) => i.id === Number(islandId)) || mine[0];
}

function stateFor(player, islandId) {
  const now = Date.now();
  const lang = player.lang || 'en';
  game.checkQuests(world, player, now);
  const mine = game.playerIslands(world, player.id);
  const island = myIsland(player, islandId);
  game.resolveIsland(island, now);
  return {
    serverNow: now,
    speed: game.SPEED,
    lang,
    player: { name: player.name },
    islands: mine.map((i) => ({ id: i.id, name: i.name, x: i.x, y: i.y })),
    island: {
      id: island.id,
      name: island.name,
      x: island.x,
      y: island.y,
      resources: {
        wood: Math.floor(island.resources.wood),
        stone: Math.floor(island.resources.stone),
        gold: Math.floor(island.resources.gold),
      },
      capacity: game.storageCapacity(island.buildings.storehouse),
      rates: game.islandRates(island),
      points: game.islandPoints(island),
      queue: island.queue.map((q) => ({
        building: t(lang, `building.${q.building}.name`),
        level: q.level,
        finish: q.finish,
      })),
      queueMax: game.QUEUE_MAX,
      loyalty: Math.round(island.loyalty),
      loyaltyMax: game.LOYALTY_MAX,
      tradeCap: game.tradeCapacity(island.buildings.harbor),
      popUsed: game.popUsed(island),
      popCap: game.popCap(island.buildings.farm),
      support: (island.support || []).map((c) => {
        const owner = world.players.find((p) => p.id === c.ownerId);
        return { owner: owner ? owner.name : '?', units: c.units };
      }),
      units: island.units,
      trainQueue: island.trainQueue.map((q) => ({
        unit: t(lang, `unit.${q.unit}.name`),
        count: q.count,
        finish: q.finish,
      })),
      trainQueueMax: game.TRAIN_QUEUE_MAX,
    },
    buildings: buildingCatalog(island, lang),
    unitTypes: unitCatalog(island, lang),
    movements: movementsFor(world, player),
    // Everywhere my support is stationed (on islands I don't own).
    abroad: world.islands
      .filter((i) => (i.support || []).some((c) => c.ownerId === player.id))
      .map((i) => {
        const mine = i.support.filter((c) => c.ownerId === player.id);
        const units = game.zeroUnits();
        for (const c of mine) {
          for (const [k, n] of Object.entries(c.units)) units[k] += n;
        }
        return { name: i.name, x: i.x, y: i.y, units };
      }),
    unreadReports: world.reports.filter((r) => r.ownerId === player.id && !r.read).length,
    unreadMessages: world.messages.filter((msg) => msg.toId === player.id && !msg.read).length,
    winner: world.winner || null,
    quest: game.currentQuest(world, player),
  };
}

async function handleApi(req, res, pathname, query) {
  if (req.method === 'POST' && pathname === '/api/register') {
    const body = await readBody(req);
    const lang = body && game.LANGS.includes(body.lang) ? body.lang : 'en';
    if (!rateLimit('reg:' + clientIp(req), 5, 3_600_000)) {
      return sendErr(res, 429, lang, 'err.tooManyReg');
    }
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!/^[\p{L}\p{N} .'-]{2,24}$/u.test(name)) {
      return sendErr(res, 400, lang, 'err.nameFormat');
    }
    if (password.length < 3) return sendErr(res, 400, lang, 'err.passwordShort');
    const result = game.createPlayer(world, name, password, false, lang);
    if (result.error) return gameErr(res, lang, result);
    startSession(res, result.player.id);
    game.saveWorld(world);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    const lang = body && game.LANGS.includes(body.lang) ? body.lang : 'en';
    if (!rateLimit('login:' + clientIp(req), 20, 900_000)) {
      return sendErr(res, 429, lang, 'err.tooManyLogin');
    }
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const player = world.players.find(
      (p) => !p.isBot && p.name.toLowerCase() === String(body.name || '').trim().toLowerCase()
    );
    if (!player || !game.checkPassword(player, String(body.password || ''))) {
      return sendErr(res, 401, lang, 'err.wrongLogin');
    }
    startSession(res, player.id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = getCookie(req, 'session');
    if (token) delete world.sessions[token];
    res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  // Everything below requires a session.
  const player = sessionPlayer(req);
  if (!player) return sendErr(res, 401, 'en', 'err.notLoggedIn');
  const lang = player.lang || 'en';

  // Generous for a polling client, hostile to scripts hammering actions.
  const limit = req.method === 'POST' ? ['act:', 20, 10_000] : ['read:', 60, 10_000];
  if (!rateLimit(limit[0] + player.id, limit[1], limit[2])) {
    return sendErr(res, 429, lang, 'err.slowDown');
  }

  if (req.method === 'POST' && pathname === '/api/lang') {
    const body = await readBody(req);
    if (!body || !game.LANGS.includes(body.lang)) return sendErr(res, 400, lang, 'err.badRequest');
    player.lang = body.lang;
    return sendJson(res, 200, { ok: true });
  }

  // Land any battles/returns due before this request reads or mutates state.
  game.resolveWorld(world, Date.now());

  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, stateFor(player, query.get('island')));
  }

  if (req.method === 'POST' && pathname === '/api/build') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const result = game.tryBuild(world, island, String(body.building || ''), Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/train') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const result = game.tryTrain(world, island, String(body.unit || ''), body.count, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/attack') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const target = world.islands.find(
      (i) => i.x === Number(body.x) && i.y === Number(body.y)
    );
    if (!target) return sendErr(res, 400, lang, 'err.noIslandThere');
    const result = game.sendAttack(world, player, island, target, body.units, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/support') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const target = world.islands.find(
      (i) => i.x === Number(body.x) && i.y === Number(body.y)
    );
    if (!target) return sendErr(res, 400, lang, 'err.noIslandThere');
    const result = game.sendSupport(world, player, island, target, body.units, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/withdraw') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const target = world.islands.find(
      (i) => i.x === Number(body.x) && i.y === Number(body.y)
    );
    if (!target) return sendErr(res, 400, lang, 'err.noIslandThere');
    const result = game.withdrawSupport(world, player, target, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, body.islandId));
  }

  if (req.method === 'POST' && pathname === '/api/scout') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const target = world.islands.find(
      (i) => i.x === Number(body.x) && i.y === Number(body.y)
    );
    if (!target) return sendErr(res, 400, lang, 'err.noIslandThere');
    const result = game.sendScout(world, player, island, target, body.count, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/trade') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const target = world.islands.find(
      (i) => i.x === Number(body.x) && i.y === Number(body.y)
    );
    if (!target) return sendErr(res, 400, lang, 'err.noIslandThere');
    const result = game.sendTrade(world, player, island, target, body.resources, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/rename') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const result = game.renameIsland(world, player, island, body.name);
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'POST' && pathname === '/api/colonize') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const target = world.islands.find(
      (i) => i.x === Number(body.x) && i.y === Number(body.y)
    );
    if (!target) return sendErr(res, 400, lang, 'err.noIslandThere');
    const result = game.sendColonize(world, player, island, target, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, stateFor(player, island.id));
  }

  if (req.method === 'GET' && pathname === '/api/rankings') {
    const rows = world.players
      .map((p) => {
        const alliance = game.allianceOf(world, p.id);
        return {
          name: p.name,
          isBot: !!p.isBot,
          isYou: p.id === player.id,
          alliance: alliance ? alliance.tag : null,
          islands: game.playerIslands(world, p.id).length,
          points: game.playerPoints(world, p.id),
        };
      })
      .sort((a, b) => b.points - a.points);
    const wonders = world.islands
      .filter((i) => (i.buildings.wonder || 0) > 0)
      .map((i) => {
        const owner = world.players.find((p) => p.id === i.ownerId);
        return {
          name: owner ? owner.name : '?',
          island: `${i.name} (${i.x}:${i.y})`,
          level: i.buildings.wonder,
          max: game.WONDER_WIN_LEVEL,
        };
      })
      .sort((a, b) => b.level - a.level);
    return sendJson(res, 200, { rankings: rows, wonders, hallOfFame: game.loadHall() });
  }

  if (req.method === 'GET' && pathname === '/api/messages') {
    const inbox = world.messages
      .filter((msg) => msg.toId === player.id)
      .sort((a, b) => b.time - a.time)
      .slice(0, 50);
    const payload = inbox.map((msg) => {
      const from = world.players.find((p) => p.id === msg.fromId);
      return { id: msg.id, from: from ? from.name : '?', time: msg.time, body: msg.body, read: msg.read };
    });
    for (const msg of inbox) msg.read = true;
    return sendJson(res, 200, { messages: payload });
  }

  if (req.method === 'POST' && pathname === '/api/message') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.sendMessage(world, player, body.to, body.body, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/alliance') {
    const alliance = game.allianceOf(world, player.id);
    const invites = world.alliances
      .filter((a) => a.invites.includes(player.id))
      .map((a) => ({ id: a.id, tag: a.tag, name: a.name, members: a.members.length }));
    return sendJson(res, 200, {
      alliance: alliance ? {
        id: alliance.id,
        tag: alliance.tag,
        name: alliance.name,
        isLeader: alliance.members[0] === player.id,
        members: alliance.members.map((id) => {
          const p = world.players.find((x) => x.id === id);
          return {
            name: p ? p.name : '?',
            points: game.playerPoints(world, id),
            islands: game.playerIslands(world, id).length,
          };
        }).sort((a, b) => b.points - a.points),
        board: (world.boards[alliance.id] || []).slice(-30).reverse().map((post) => {
          const p = world.players.find((x) => x.id === post.playerId);
          return { from: p ? p.name : '?', time: post.time, body: post.body };
        }),
        diplomacy: world.alliances
          .filter((a) => a.id !== alliance.id)
          .map((a) => ({
            id: a.id,
            tag: a.tag,
            name: a.name,
            stance: (alliance.diplomacy || {})[a.id] || 'none',
            relation: game.allianceRelation(world, alliance.id, a.id),
          })),
      } : null,
      invites,
    });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/stance') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.setStance(world, player, body.allianceId, String(body.stance || ''), Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/post') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.postBoard(world, player, body.body, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/market') {
    const offers = world.offers.map((o) => {
      const owner = world.players.find((p) => p.id === o.playerId);
      const origin = world.islands.find((i) => i.id === o.islandId);
      return {
        id: o.id,
        by: owner ? owner.name : '?',
        isMine: o.playerId === player.id,
        give: o.give,
        want: o.want,
        x: origin ? origin.x : 0,
        y: origin ? origin.y : 0,
      };
    });
    return sendJson(res, 200, { offers });
  }

  if (req.method === 'POST' && pathname === '/api/market/create') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const result = game.createOffer(world, player, island, body.give, body.want, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/market/accept') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const island = myIsland(player, body.islandId);
    const result = game.acceptOffer(world, player, island, body.id, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/market/cancel') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.cancelOffer(world, player, body.id, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/create') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.createAlliance(world, player, body.name, body.tag);
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/invite') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.inviteToAlliance(world, player, body.name, Date.now());
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/accept') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.acceptInvite(world, player, body.allianceId);
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/decline') {
    const body = await readBody(req);
    if (!body) return sendErr(res, 400, lang, 'err.badRequest');
    const result = game.declineInvite(world, player, body.allianceId);
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/alliance/leave') {
    const result = game.leaveAlliance(world, player);
    if (result.error) return gameErr(res, lang, result);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/reports') {
    const mine = world.reports
      .filter((r) => r.ownerId === player.id)
      .sort((a, b) => b.time - a.time)
      .slice(0, 50);
    const payload = mine.map((r) => ({
      id: r.id, time: r.time, title: r.title, lines: r.lines, read: r.read,
    }));
    for (const r of mine) r.read = true;
    return sendJson(res, 200, { reports: payload });
  }

  if (req.method === 'GET' && pathname === '/api/map') {
    const now = Date.now();
    // Intel pool: mine plus my alliance-mates', freshest wins, 24h shelf life.
    const myAlliance = game.allianceOf(world, player.id);
    const intelSources = myAlliance
      ? myAlliance.members.map((id) => world.players.find((p) => p.id === id)).filter(Boolean)
      : [player];
    const islands = world.islands.map((i) => {
      game.resolveIsland(i, now);
      const owner = world.players.find((p) => p.id === i.ownerId);
      const alliance = owner ? game.allianceOf(world, owner.id) : null;
      const relation = alliance && myAlliance
        ? game.allianceRelation(world, myAlliance.id, alliance.id) : null;
      let intel = null;
      for (const src of intelSources) {
        const known = src.intel && src.intel[i.id];
        if (known && now - known.time < 24 * 3600 * 1000 &&
            (!intel || known.time > intel.time)) {
          intel = known;
        }
      }
      return {
        x: i.x,
        y: i.y,
        name: i.ownerId == null ? t(lang, 'name.uncharted') : i.name,
        owner: owner ? owner.name : null,
        alliance: alliance ? alliance.tag : null,
        relation,
        intel: intel && i.ownerId !== player.id
          ? { def: intel.def, hours: Math.round((now - intel.time) / 3600000) } : null,
        unowned: i.ownerId == null,
        isBot: owner ? !!owner.isBot : false,
        isYou: i.ownerId === player.id,
        points: game.islandPoints(i),
      };
    });
    return sendJson(res, 200, { size: game.MAP_SIZE, islands });
  }

  return sendErr(res, 404, lang, 'err.notFound');
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const started = Date.now();
  res.on('finish', () => {
    // Log actions and problems; stay quiet about routine polling.
    if (req.method !== 'GET' || res.statusCode >= 400) {
      console.log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url.searchParams);
    return serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    return sendErr(res, 500, 'en', 'err.serverError');
  }
});

// If the port is taken, hop to the next one (up to 20 tries).
let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) {
    console.log(`Port ${port} is in use, trying ${port + 1}...`);
    port++;
    setTimeout(() => server.listen(port), 100);
  } else {
    throw err;
  }
});

server.listen(port, () => {
  console.log(`Tideholm listening on http://localhost:${port}`);
});
