// Tideholm — application core: world lifecycle, JSON API, static files.
// Transport-agnostic and zero-dependency. server.js mounts `handle` on a raw
// node http server; an embedding host (e.g. a JSS plugin, see the RFC on
// JavaScriptSolidServer#206) can mount the same handler under a URL prefix,
// supply its own identity (WebID → player) via `identify`, and drive the
// world lifecycle through start()/stop().
//
// Options (all optional):
//   botCount, freeIsles   world creation knobs (default: env BOTS/FREE_ISLES)
//   adminToken            admin API token (default: env ADMIN_TOKEN; '' = off)
//   trustProxy            honor x-forwarded-for + Secure cookies (env TRUST_PROXY)
//   basePath              mount prefix, e.g. '/tideholm' (default: '')
//   identify(req)         async → { id, name, lang? } | null. When set, the
//                         host owns authentication: players are auto-created
//                         per external id and password endpoints are disabled.
//   log                   console-like (default: console)
//
// Storage lives in env DATA_DIR (default: ./data) — game.js resolves the
// same way, so set DATA_DIR before requiring this module.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as game from './game.js';
import { spawnBots, botTick } from './bots.js';
import { t } from './public/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_KEEP = 24;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export function createApp(opts = {}) {
  const log = opts.log || console;
  const botCount = opts.botCount ?? Number(process.env.BOTS || 20);
  const freeIsles = opts.freeIsles ?? Number(process.env.FREE_ISLES || 30);
  const trustProxy = opts.trustProxy ?? !!process.env.TRUST_PROXY;
  const adminToken = opts.adminToken ?? (process.env.ADMIN_TOKEN || '');
  const identify = opts.identify || null;
  const podLoginUrl = opts.podLoginUrl || '/idp/credentials';
  const base = (opts.basePath || '').replace(/\/+$/, '');
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const lockFile = path.join(dataDir, 'server.lock');
  const backupDir = path.join(dataDir, 'backups');

  // ---------------------------------------------------------------- lock
  // Two worlds sharing one file would corrupt it. Same-process instances
  // (tests, a host mounting several) are fine — the pid check allows them.

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  let lockHolder = 0;
  try { lockHolder = Number(fs.readFileSync(lockFile, 'utf8')); } catch { /* no lock file — fine */ }
  if (lockHolder && lockHolder !== process.pid && pidAlive(lockHolder)) {
    throw new Error(`Another server (pid ${lockHolder}) already owns ${lockFile}. Refusing to start.`);
  }
  fs.writeFileSync(lockFile, String(process.pid));

  function releaseLock() {
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) {
        fs.rmSync(lockFile, { force: true });
      }
    } catch { /* already gone */ }
  }

  // ---------------------------------------------------------------- world

  let world = game.loadWorld();
  if (!world) {
    world = game.createWorld();
    const n = spawnBots(world, botCount);
    for (let i = 0; i < freeIsles; i++) game.newUnchartedIsland(world);
    log.log(`New world created with ${n} bots and ${freeIsles} uncharted isles (speed x${game.SPEED}).`);
    game.saveWorld(world);
  } else {
    game.migrateWorld(world);
    log.log(`World loaded: ${world.players.length} players, ${world.islands.length} islands.`);
  }

  // Rolling world backups: every 15 minutes, keep the last BACKUP_KEEP.
  function backupWorld() {
    try {
      const src = path.join(dataDir, 'world.json');
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(src, path.join(backupDir, `world-${stamp}.json`));
      const old = fs.readdirSync(backupDir).filter((f) => f.startsWith('world-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
        fs.rmSync(path.join(backupDir, f));
      }
    } catch (err) {
      log.error('backup failed:', err.message);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  let timers = [];
  function start() {
    if (timers.length) return; // already running
    timers = [
      setInterval(() => botTick(world, Date.now()), 15000),
      setInterval(() => game.resolveWorld(world, Date.now()), 5000), // battles land on time
      setInterval(() => game.checkVictory(world, Date.now()), 60000),
      setInterval(() => game.saveWorld(world), 30000),
      setInterval(backupWorld, 15 * 60 * 1000),
      setInterval(() => {
        const cutoff = Date.now() - 3_600_000;
        for (const [k, arr] of buckets) {
          if (!arr.length || arr[arr.length - 1] < cutoff) buckets.delete(k);
        }
      }, 600_000),
    ];
    backupWorld();
  }

  function stop() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    game.saveWorld(world);
    releaseLock();
  }

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

  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) {
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
    const secure = trustProxy ? '; Secure' : '';
    res.setHeader('Set-Cookie',
      `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
  }

  // External identity (host-authenticated, e.g. WebID) → player. First visit
  // auto-provisions an account; the external id is the durable key.
  function playerForIdentity(ident) {
    let p = world.players.find((x) => x.extId === ident.id);
    if (p) return p;
    const lang = game.LANGS.includes(ident.lang) ? ident.lang : 'en';
    const base_ = String(ident.name || 'Voyager').trim().slice(0, 24) || 'Voyager';
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? base_ : `${base_} ${i}`;
      const r = game.createPlayer(world, name, crypto.randomBytes(18).toString('hex'), false, lang);
      if (!r.error) {
        r.player.extId = ident.id;
        game.saveWorld(world);
        log.log(`provisioned player "${name}" for external identity ${ident.id}`);
        return r.player;
      }
    }
    return null;
  }

  // Who is making this request? Host identity wins when configured, and a
  // verified host identity also mints the game's own session cookie — so
  // play survives the host token's expiry (JSS /idp/credentials tokens die
  // after 3600s with no refresh flow). Cookie is the fallback, not the
  // authority: a live host token always names the player.
  async function requestPlayer(req, res) {
    if (identify) {
      const ident = await identify(req);
      if (ident && ident.id) {
        const player = playerForIdentity(ident);
        if (player && res) {
          const existing = sessionPlayer(req);
          if (!existing || existing.id !== player.id) startSession(res, player.id);
        }
        return player;
      }
      return sessionPlayer(req); // token absent/expired: our own session
    }
    return sessionPlayer(req);
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
      player: { name: player.name, points: game.playerPoints(world, player.id) },
      // Morale floors so the battle simulator matches the server's combat,
      // including a separate floor when the defender is a bot (#config).
      moraleFloor: game.MORALE_FLOOR,
      botMoraleFloor: game.BOT_MORALE_FLOOR,
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
    // Who runs identity here? Lets the client pick its login UI: Tideholm's
    // own password form, or the host's pod credentials flow.
    if (req.method === 'GET' && pathname === '/api/meta') {
      return sendJson(res, 200, {
        mode: identify ? 'pod' : 'password',
        podLoginUrl: identify ? podLoginUrl : null,
        speed: game.SPEED,
      });
    }

    // Password auth is Tideholm's own; a host with `identify` owns identity
    // and these endpoints go dark.
    if (req.method === 'POST' && pathname === '/api/register') {
      if (identify) return sendErr(res, 404, 'en', 'err.notFound');
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
      if (identify) return sendErr(res, 404, 'en', 'err.notFound');
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
      // Clear the game session either way — in host-identity mode this is
      // the bridge cookie; the host token is the client's to discard.
      const token = getCookie(req, 'session');
      if (token) delete world.sessions[token];
      res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    // ---------------- admin (token-gated, disabled unless a token is set)
    if (pathname.startsWith('/api/admin/')) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const token = req.headers['x-admin-token'] || query.get('token') || (body && body.token);
      if (!adminToken || token !== adminToken) {
        return sendErr(res, 403, 'en', 'err.notFound'); // don't advertise the admin API
      }

      if (req.method === 'GET' && pathname === '/api/admin/stats') {
        const humans = world.players.filter((p) => !p.isBot);
        return sendJson(res, 200, {
          speed: game.SPEED,
          uptimeSec: Math.round(process.uptime()),
          players: humans.map((p) => ({
            name: p.name,
            lang: p.lang,
            points: game.playerPoints(world, p.id),
            islands: game.playerIslands(world, p.id).length,
            alliance: (game.allianceOf(world, p.id) || {}).tag || null,
          })),
          bots: world.players.filter((p) => p.isBot).length,
          islands: {
            total: world.islands.length,
            owned: world.islands.filter((i) => i.ownerId != null).length,
            uncharted: world.islands.filter((i) => i.ownerId == null).length,
          },
          movements: world.movements.length,
          offers: world.offers.length,
          alliances: world.alliances.map((a) => ({ tag: a.tag, members: a.members.length })),
          winner: world.winner || null,
          hallOfFame: game.loadHall().length,
          worldBytes: fs.existsSync(path.join(dataDir, 'world.json'))
            ? fs.statSync(path.join(dataDir, 'world.json')).size : 0,
        });
      }

      if (req.method === 'POST' && pathname === '/api/admin/announce') {
        const text = String((body && body.body) || '').trim().slice(0, 500);
        if (!text) return sendErr(res, 400, 'en', 'err.badRequest');
        const now = Date.now();
        for (const p of world.players) {
          if (p.isBot) continue;
          game.resolveWorld(world, now);
          const L = p.lang || 'en';
          // addReport is engine-internal; go through the world's report list shape
          world.reports.push({
            id: world.nextId++, ownerId: p.id, time: now,
            title: t(L, 'report.admin.title'), lines: [text], read: false,
          });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/api/admin/reset') {
        // Archive the old world, then start a fresh season in place.
        backupWorld();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const src = path.join(dataDir, 'world.json');
        if (fs.existsSync(src)) {
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(src, path.join(backupDir, `world-season-end-${stamp}.json`));
        }
        world = game.createWorld();
        spawnBots(world, botCount);
        for (let i = 0; i < freeIsles; i++) game.newUnchartedIsland(world);
        game.saveWorld(world);
        log.log(`ADMIN: world reset (${stamp})`);
        return sendJson(res, 200, { ok: true, archived: `world-season-end-${stamp}.json` });
      }

      return sendErr(res, 404, 'en', 'err.notFound');
    }

    // Everything below requires a session (or host identity).
    const player = await requestPlayer(req, res);
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
          // Owner's TOTAL points — the battle simulator needs this to apply
          // the same morale multiplier the server does (#9).
          ownerPoints: i.ownerId != null ? game.playerPoints(world, i.ownerId) : null,
        };
      });
      return sendJson(res, 200, {
        size: game.MAP_SIZE,
        theme: world.theme || 'generated',
        seed: world.mapSeed || 1,
        islands,
      });
    }

    return sendErr(res, 404, lang, 'err.notFound');
  }

  // ---------------------------------------------------------------- static

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

  // ---------------------------------------------------------------- handler

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;
    if (base) {
      if (pathname === base) { // /tideholm -> /tideholm/ so relative URLs resolve
        res.writeHead(302, { Location: base + '/' });
        return res.end();
      }
      if (!pathname.startsWith(base + '/')) {
        res.writeHead(404);
        return res.end('Not found');
      }
      pathname = pathname.slice(base.length);
    }
    const started = Date.now();
    res.on('finish', () => {
      // Log actions and problems; stay quiet about routine polling.
      if (req.method !== 'GET' || res.statusCode >= 400) {
        log.log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, url.searchParams);
      return serveStatic(res, pathname);
    } catch (err) {
      log.error(err);
      return sendErr(res, 500, 'en', 'err.serverError');
    }
  };

  return {
    handle,
    start,
    stop,
    backupWorld,
    get world() { return world; },
  };
}
