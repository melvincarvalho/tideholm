// Tideholm — core game engine.
// All game state lives in a single `world` object, persisted as JSON.
// Time is lazy: islands are resolved forward to `now` whenever they are read.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { t, LANGS } from './public/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPEED = Number(process.env.GAME_SPEED || 5); // multiplies production and divides build times
const MAP_SIZE = 40;
const QUEUE_MAX = 3;

const RESOURCES = ['wood', 'stone', 'gold'];

const BUILDINGS = {
  lumberyard: {
    name: 'Lumberyard',
    desc: 'Produces wood.',
    base: { wood: 60, stone: 90, gold: 10 },
    time: 90,
    produces: 'wood',
    perHour: 40,
  },
  quarry: {
    name: 'Quarry',
    desc: 'Produces stone.',
    base: { wood: 90, stone: 60, gold: 10 },
    time: 90,
    produces: 'stone',
    perHour: 40,
  },
  goldmine: {
    name: 'Gold Mine',
    desc: 'Produces gold.',
    base: { wood: 110, stone: 110, gold: 0 },
    time: 120,
    produces: 'gold',
    perHour: 18,
  },
  storehouse: {
    name: 'Storehouse',
    desc: 'Raises how much of each resource you can store.',
    base: { wood: 120, stone: 120, gold: 25 },
    time: 150,
  },
  hall: {
    name: 'Island Hall',
    desc: 'Speeds up all construction.',
    base: { wood: 150, stone: 150, gold: 60 },
    time: 180,
  },
  barracks: {
    name: 'Barracks',
    desc: 'Train troops. Higher levels train faster.',
    base: { wood: 200, stone: 150, gold: 80 },
    time: 240,
  },
  harbor: {
    name: 'Harbor',
    desc: 'Build ships to settle uncharted islands.',
    base: { wood: 300, stone: 250, gold: 150 },
    time: 300,
  },
  wall: {
    name: 'Wall',
    desc: 'Strengthens the defenders.',
    base: { wood: 80, stone: 160, gold: 20 },
    time: 150,
  },
  farm: {
    name: 'Farm',
    desc: 'Raises the population cap for troops.',
    base: { wood: 120, stone: 100, gold: 30 },
    time: 150,
  },
  wonder: {
    name: 'Great Beacon',
    desc: 'Complete level 5 and the world is yours.',
    base: { wood: 5000, stone: 5000, gold: 3000 },
    time: 3600,
    requires: { hall: 10 },
  },
};

// Beacon level that wins the world. Raising it stretches the endgame:
// each level costs 1.55x more and takes 1.5x longer, and every completed
// level is announced world-wide — a longer window to march on the builder.
const WONDER_WIN_LEVEL = Math.max(1, Number(process.env.WONDER_WIN_LEVEL || 5));

// speed = minutes per map field at game speed 1 (lower is faster).
// pop = population each unit consumes against the Farm's cap.
const UNITS = {
  spearman: {
    name: 'Spearman', plural: 'Spearmen', desc: 'Cheap all-rounder.',
    cost: { wood: 50, stone: 30, gold: 20 }, time: 60,
    atk: 10, def: 14, carry: 25, speed: 8, pop: 1,
  },
  raider: {
    name: 'Raider', desc: 'Hits hard, carries plenty, poor in defense.',
    cost: { wood: 80, stone: 40, gold: 45 }, time: 90,
    atk: 24, def: 7, carry: 60, speed: 6, pop: 2,
  },
  sentinel: {
    name: 'Sentinel', desc: 'Holds the line at home.',
    cost: { wood: 60, stone: 90, gold: 30 }, time: 90,
    atk: 6, def: 30, carry: 10, speed: 10, pop: 1,
  },
  scout: {
    name: 'Scout', plural: 'Scouts', desc: 'Spies out enemy islands.',
    cost: { wood: 40, stone: 30, gold: 35 }, time: 45,
    atk: 0, def: 2, carry: 5, speed: 3, pop: 1, scout: true,
  },
  colonyship: {
    name: 'Colony Ship', plural: 'Colony Ships',
    desc: 'Settles an uncharted island. Cannot fight.',
    cost: { wood: 1200, stone: 900, gold: 600 }, time: 600,
    atk: 0, def: 0, carry: 0, speed: 15, pop: 6,
    ship: true, building: 'harbor',
  },
  flagship: {
    name: 'Flagship', plural: 'Flagships',
    desc: 'Joins attacks; victories break the island\'s loyalty.',
    cost: { wood: 2500, stone: 2000, gold: 1200 }, time: 900,
    atk: 0, def: 10, carry: 0, speed: 20, pop: 10,
    capture: true, building: 'harbor',
  },
};

const TRAIN_DISCOUNT = 0.95; // per barracks level above 1
const TRAIN_QUEUE_MAX = 5;

// Players below this many points cannot be attacked until they attack
// a human themselves. Bots already respect this; this enforces it for everyone.
const PROTECTED_POINTS = Number(process.env.PROTECTED_POINTS ?? 40);
// New humans additionally get a 72h (game-time) grace window after joining,
// so crossing the points threshold isn't a cliff into twenty bot armies.
// Newcomer shield length (#7). Default is 72 game-hours ÷ speed — which at a
// fast speed is only a few real hours, the newcomer-cliff problem. Set
// PROTECT_GRACE_HOURS to a fixed number of REAL hours (independent of speed)
// to give newcomers a proper runway, e.g. 48 for two real days.
const PROTECT_GRACE_MS = process.env.PROTECT_GRACE_HOURS
  ? Math.round(Number(process.env.PROTECT_GRACE_HOURS) * 3600 * 1000)
  : Math.round(72 * 3600 * 1000 / SPEED);

// Can this player be attacked? Attacking a human forfeits your own
// protection (protectionBroken), whatever your points or age.
function isProtected(world, p, now) {
  if (!p || p.protectionBroken) return false;
  if (playerPoints(world, p.id) < PROTECTED_POINTS) return true;
  if (!p.isBot && now - (p.joinedAt || 0) < PROTECT_GRACE_MS) return true;
  return false;
}

// Loyalty: a victorious Flagship lowers it by 25-40; at 0 the island falls.
// It regenerates over time (scaled by game speed, like production).
const LOYALTY_MAX = 100;
const LOYALTY_REGEN_PER_HOUR = 2; // × SPEED
const LOYALTY_AFTER_CAPTURE = 25;

// Wall: flat defense per level plus a percentage bonus for all defenders.
const WALL_FLAT_DEF = 15;
const WALL_DEF_BONUS = 0.08;

// Morale: attacking a much smaller player weakens the attack, down to 30%.
// Morale: attacking a much smaller defender blunts your force. Configurable
// so a world can be gentler or harsher. BOT_MORALE_FLOOR is a separate floor
// used when the DEFENDER is a bot — set it to 1 to remove the penalty against
// bots entirely, so a dominant player has real PvE to fight while human
// newcomers stay protected by the normal floor. Defaults preserve prior
// behavior (bots penalized the same as humans).
const MORALE_FLOOR = Number(process.env.MORALE_FLOOR ?? 0.3);
const BOT_MORALE_FLOOR = Number(process.env.BOT_MORALE_FLOOR ?? MORALE_FLOOR);

// Optional night defense bonus, e.g. NIGHT_BONUS=22-6 (server-local hours).
const NIGHT = String(process.env.NIGHT_BONUS || '').match(/^(\d{1,2})-(\d{1,2})$/);
function nightFactor(time) {
  if (!NIGHT) return 1;
  const h = new Date(time).getHours();
  const s = Number(NIGHT[1]), e = Number(NIGHT[2]);
  const inNight = s < e ? h >= s && h < e : h >= s || h < e;
  return inNight ? 1.5 : 1;
}

// Dominance victory: one player or alliance holding this share of all islands.
const WIN_SHARE = Number(process.env.WIN_SHARE || 0.6);

const COST_GROWTH = 1.55;
const TIME_GROWTH = 1.5;
const PROD_GROWTH = 1.12;
const HALL_DISCOUNT = 0.96; // per hall level above 1

// ---------------------------------------------------------------- formulas

// Cost to upgrade a building TO `level`.
function upgradeCost(key, level) {
  const b = BUILDINGS[key];
  const f = Math.pow(COST_GROWTH, level - 1);
  const cost = {};
  for (const r of RESOURCES) cost[r] = Math.ceil((b.base[r] || 0) * f);
  return cost;
}

// Seconds to upgrade TO `level`, given the island's hall level.
function upgradeTime(key, level, hallLevel) {
  const b = BUILDINGS[key];
  let t = (b.time * Math.pow(TIME_GROWTH, level - 1)) / SPEED;
  t *= Math.pow(HALL_DISCOUNT, Math.max(0, hallLevel - 1));
  return Math.max(5, Math.round(t));
}

// Resource units per hour produced by a building at `level`.
function productionPerHour(key, level) {
  const b = BUILDINGS[key];
  if (!b.produces || level <= 0) return 0;
  return b.perHour * level * Math.pow(PROD_GROWTH, level - 1) * SPEED;
}

function storageCapacity(storehouseLevel) {
  return Math.round(400 * Math.pow(1.5, storehouseLevel));
}

function popCap(farmLevel) {
  return Math.round(30 * Math.pow(1.35, farmLevel));
}

// Population in use: units at home plus everything still in training.
// Troops abroad don't count — a soft cap, checked at training time.
function popUsed(island) {
  let used = 0;
  for (const [k, n] of Object.entries(island.units)) used += UNITS[k].pop * n;
  for (const item of island.trainQueue) used += UNITS[item.unit].pop * item.count;
  return used;
}

function islandRates(island) {
  const rates = { wood: 0, stone: 0, gold: 0 };
  for (const [key, b] of Object.entries(BUILDINGS)) {
    if (b.produces) rates[b.produces] += productionPerHour(key, island.buildings[key]);
  }
  return rates;
}

function islandPoints(island) {
  let pts = 0;
  for (const lvl of Object.values(island.buildings)) pts += lvl * (lvl + 1) / 2;
  return Math.round(pts);
}

// ---------------------------------------------------------------- resolution

// Accrue resources from t0 to t1 (ms timestamps) at current building levels.
function accrue(island, t0, t1) {
  if (t1 <= t0) return;
  const hours = (t1 - t0) / 3600000;
  const rates = islandRates(island);
  const cap = storageCapacity(island.buildings.storehouse);
  for (const r of RESOURCES) {
    island.resources[r] = Math.min(cap, island.resources[r] + rates[r] * hours);
  }
}

// Advance an island to `now`: finish due queue items, accruing resources
// at the correct rate between each completion.
function resolveIsland(island, now) {
  const hours = Math.max(0, (now - island.lastUpdate) / 3600000);
  let t = island.lastUpdate;
  while (island.queue.length && island.queue[0].finish <= now) {
    const item = island.queue[0];
    accrue(island, t, item.finish);
    island.buildings[item.building] = item.level;
    t = item.finish;
    island.queue.shift();
  }
  accrue(island, t, now);
  island.lastUpdate = now;
  while (island.trainQueue.length && island.trainQueue[0].finish <= now) {
    const item = island.trainQueue.shift();
    island.units[item.unit] += item.count;
  }
  if (island.ownerId != null) {
    island.loyalty = Math.min(LOYALTY_MAX,
      island.loyalty + LOYALTY_REGEN_PER_HOUR * SPEED * hours);
  }
}

// Process every movement due by `now`, in arrival order. Combat may spawn
// return movements that are themselves already due, hence the re-sort loop.
function resolveWorld(world, now) {
  for (;;) {
    world.movements.sort((a, b) => a.arrive - b.arrive);
    if (!world.movements.length || world.movements[0].arrive > now) break;
    applyMovement(world, world.movements.shift());
  }
}

// ---------------------------------------------------------------- actions

// Level a building will reach counting items already in the queue.
function pendingLevel(island, key) {
  let lvl = island.buildings[key];
  for (const item of island.queue) if (item.building === key) lvl = Math.max(lvl, item.level);
  return lvl;
}

function canAfford(island, cost) {
  return RESOURCES.every((r) => island.resources[r] >= cost[r]);
}

// Queue an upgrade. Returns { ok } or { error }.
function tryBuild(world, island, key, now) {
  if (!BUILDINGS[key]) return { error: 'err.unknownBuilding' };
  resolveIsland(island, now);
  if (island.queue.length >= QUEUE_MAX) return { error: 'err.queueFull' };
  const req = BUILDINGS[key].requires;
  if (req) {
    for (const [needKey, needLvl] of Object.entries(req)) {
      if ((island.buildings[needKey] || 0) < needLvl) {
        return {
          error: 'err.requiresLevel',
          errorParams: { building: `@building.${needKey}.name`, n: needLvl },
        };
      }
    }
  }
  const target = pendingLevel(island, key) + 1;
  const cost = upgradeCost(key, target);
  if (!canAfford(island, cost)) return { error: 'err.noResources' };
  for (const r of RESOURCES) island.resources[r] -= cost[r];
  const start = island.queue.length ? island.queue[island.queue.length - 1].finish : now;
  const duration = upgradeTime(key, target, island.buildings.hall) * 1000;
  island.queue.push({ building: key, level: target, finish: start + duration });
  return { ok: true };
}

// ---------------------------------------------------------------- units & combat

function zeroUnits() {
  const out = {};
  for (const k of Object.keys(UNITS)) out[k] = 0;
  return out;
}

function totalUnits(units) {
  return Object.values(units).reduce((a, b) => a + b, 0);
}

function unitPower(units, kind) {
  let p = 0;
  for (const [k, n] of Object.entries(units)) p += UNITS[k][kind] * n;
  return p;
}

function carryCapacity(units) {
  let c = 0;
  for (const [k, n] of Object.entries(units)) c += UNITS[k].carry * n;
  return c;
}

// Round unit counts down through a survival fraction, never below 0.
function scaleUnits(units, frac) {
  const out = {};
  for (const [k, n] of Object.entries(units)) {
    out[k] = Math.max(0, Math.min(n, Math.round(n * frac)));
  }
  return out;
}

// Language a player reads reports and errors in.
function langOf(world, playerId) {
  const p = world.players.find((x) => x.id === playerId);
  return (p && p.lang) || 'en';
}

function fmtUnits(units, lang) {
  const parts = Object.entries(units)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${t(lang, n === 1 ? `unit.${k}.name` : `unit.${k}.plural`)}`);
  return parts.join(', ') || t(lang, 'units.none');
}

function fmtRes(res, lang) {
  return `${res.wood} ${t(lang, 'res.wood')}, ${res.stone} ${t(lang, 'res.stone')}, ${res.gold} ${t(lang, 'res.gold')}`;
}

// Seconds per unit to train, given the level of the building that trains it.
function trainTime(key, buildingLevel) {
  const t = (UNITS[key].time / SPEED) * Math.pow(TRAIN_DISCOUNT, Math.max(0, buildingLevel - 1));
  return Math.max(2, Math.round(t));
}

function tryTrain(world, island, key, count, now) {
  if (!UNITS[key]) return { error: 'err.unknownUnit' };
  count = Math.floor(Number(count));
  if (!(count >= 1 && count <= 500)) return { error: 'err.count' };
  resolveIsland(island, now);
  const need = UNITS[key].building || 'barracks';
  if (island.buildings[need] < 1) {
    return { error: 'err.buildFirst', errorParams: { building: `@building.${need}.name` } };
  }
  if (island.trainQueue.length >= TRAIN_QUEUE_MAX) return { error: 'err.trainQueueFull' };
  if (popUsed(island) + UNITS[key].pop * count > popCap(island.buildings.farm)) {
    return { error: 'err.noPop' };
  }
  const cost = {};
  for (const r of RESOURCES) cost[r] = UNITS[key].cost[r] * count;
  if (!canAfford(island, cost)) return { error: 'err.noResources' };
  for (const r of RESOURCES) island.resources[r] -= cost[r];
  const start = island.trainQueue.length
    ? island.trainQueue[island.trainQueue.length - 1].finish
    : now;
  island.trainQueue.push({
    unit: key,
    count,
    finish: start + trainTime(key, island.buildings[need]) * 1000 * count,
  });
  const owner = world.players.find((p) => p.id === island.ownerId);
  if (owner && !owner.isBot) {
    owner.stats = owner.stats || {};
    owner.stats.trained = (owner.stats.trained || 0) + count;
  }
  return { ok: true };
}

// Travel time is set by the slowest unit in the army.
function travelDuration(from, to, units) {
  const dist = Math.hypot(from.x - to.x, from.y - to.y);
  let slowest = 0;
  for (const [k, n] of Object.entries(units)) {
    if (n > 0) slowest = Math.max(slowest, UNITS[k].speed);
  }
  return Math.max(5000, Math.round((dist * slowest * 60000) / SPEED));
}

function sendAttack(world, attacker, island, target, units, now) {
  resolveIsland(island, now);
  const army = zeroUnits();
  for (const k of Object.keys(UNITS)) {
    const n = Math.floor(Number((units && units[k]) || 0));
    if (n < 0 || !Number.isFinite(n)) return { error: 'err.invalidUnits' };
    if (n > island.units[k]) return { error: 'err.noTroops' };
    if (n > 0 && (UNITS[k].ship || UNITS[k].scout)) {
      return { error: 'err.shipsNoAttack', errorParams: { unit: `@unit.${k}.plural` } };
    }
    army[k] = n;
  }
  if (totalUnits(army) < 1) return { error: 'err.sendSomething' };
  if (target.ownerId == null) return { error: 'err.uninhabited' };
  if (target.ownerId === attacker.id) return { error: 'err.ownIsland' };
  if (target.id === island.id) return { error: 'err.ownIsland' };
  const targetOwner = world.players.find((p) => p.id === target.ownerId);
  if (attacker.allianceId && targetOwner && targetOwner.allianceId === attacker.allianceId) {
    return { error: 'err.ally' };
  }
  if (targetOwner) {
    const rel = allianceRelation(world, attacker.allianceId, targetOwner.allianceId);
    if (rel === 'ally' || rel === 'nap') return { error: 'err.pact' };
  }
  if (targetOwner && isProtected(world, targetOwner, now)) {
    return { error: 'err.protected' };
  }
  // Attacking a human forfeits your own protection.
  if (targetOwner && !targetOwner.isBot) attacker.protectionBroken = true;
  for (const k of Object.keys(army)) island.units[k] -= army[k];
  const arrive = now + travelDuration(island, target, army);
  world.movements.push({
    id: world.nextId++,
    type: 'attack',
    ownerId: attacker.id,
    fromId: island.id,
    toId: target.id,
    units: army,
    depart: now,
    arrive,
  });
  return { ok: true, arrive };
}

// Station defenders at another island (yours or anyone's). Only line troops.
function sendSupport(world, player, island, target, units, now) {
  resolveIsland(island, now);
  const force = zeroUnits();
  for (const k of Object.keys(UNITS)) {
    const n = Math.floor(Number((units && units[k]) || 0));
    if (n < 0 || !Number.isFinite(n)) return { error: 'err.invalidUnits' };
    if (n > island.units[k]) return { error: 'err.noTroops' };
    if (n > 0 && (UNITS[k].ship || UNITS[k].scout || UNITS[k].capture)) {
      return { error: 'err.noSupportUnits' };
    }
    force[k] = n;
  }
  if (totalUnits(force) < 1) return { error: 'err.sendSomething' };
  if (target.ownerId == null) return { error: 'err.uninhabited' };
  if (target.id === island.id) return { error: 'err.ownIsland' };
  for (const k of Object.keys(force)) island.units[k] -= force[k];
  const arrive = now + travelDuration(island, target, force);
  world.movements.push({
    id: world.nextId++, type: 'support', ownerId: player.id,
    fromId: island.id, toId: target.id, units: force, depart: now, arrive,
  });
  return { ok: true, arrive };
}

// Recall all of a player's stationed contingents from an island.
function withdrawSupport(world, player, target, now) {
  resolveIsland(target, now);
  const mine = (target.support || []).filter((c) => c.ownerId === player.id);
  if (!mine.length) return { error: 'err.nothingToWithdraw' };
  target.support = target.support.filter((c) => c.ownerId !== player.id);
  for (const c of mine) {
    const home = world.islands.find((i) => i.id === c.fromId) || target;
    const arrive = now + travelDuration(target, home, c.units);
    world.movements.push({
      id: world.nextId++, type: 'return', ownerId: player.id,
      fromId: target.id, toId: home.id, units: c.units, depart: now, arrive,
    });
  }
  return { ok: true };
}

// Trade shipments sail from the Harbor; heavier harbors carry more.
const TRADE_SPEED = 8; // minutes per field at game speed 1

function tradeCapacity(harborLevel) {
  return harborLevel < 1 ? 0 : Math.round(250 * Math.pow(1.5, harborLevel - 1));
}

function sendTrade(world, player, island, target, resources, now) {
  resolveIsland(island, now);
  if (island.buildings.harbor < 1) {
    return { error: 'err.buildFirst', errorParams: { building: '@building.harbor.name' } };
  }
  const load = {};
  let total = 0;
  for (const r of RESOURCES) {
    const n = Math.floor(Number((resources && resources[r]) || 0));
    if (n < 0 || !Number.isFinite(n)) return { error: 'err.badRequest' };
    if (n > island.resources[r]) return { error: 'err.noResources' };
    load[r] = n;
    total += n;
  }
  if (total < 1) return { error: 'err.tradeAmount' };
  const cap = tradeCapacity(island.buildings.harbor);
  if (total > cap) return { error: 'err.tradeCapacity', errorParams: { cap } };
  if (target.ownerId == null) return { error: 'err.uninhabited' };
  if (target.id === island.id) return { error: 'err.ownIsland' };
  for (const r of RESOURCES) island.resources[r] -= load[r];
  const dist = Math.hypot(island.x - target.x, island.y - target.y);
  const arrive = now + Math.max(5000, Math.round((dist * TRADE_SPEED * 60000) / SPEED));
  world.movements.push({
    id: world.nextId++, type: 'trade', ownerId: player.id,
    fromId: island.id, toId: target.id, units: zeroUnits(), loot: load,
    depart: now, arrive,
  });
  return { ok: true, arrive };
}

// ---------------------------------------------------------------- market

const OFFER_LIMIT = 5;
const OFFER_MAX = 1000;

function fullLoad(res, amount) {
  const load = { wood: 0, stone: 0, gold: 0 };
  load[res] = amount;
  return load;
}

function validSide(side) {
  return side && RESOURCES.includes(side.res) &&
    Number.isInteger(side.amount) && side.amount >= 1 && side.amount <= OFFER_MAX;
}

// Post an offer: goods are escrowed from the island at once.
function createOffer(world, player, island, give, want, now) {
  resolveIsland(island, now);
  if (island.buildings.harbor < 1) {
    return { error: 'err.buildFirst', errorParams: { building: '@building.harbor.name' } };
  }
  if (!validSide(give) || !validSide(want) || give.res === want.res) {
    return { error: 'err.badRequest' };
  }
  if (world.offers.filter((o) => o.playerId === player.id).length >= OFFER_LIMIT) {
    return { error: 'err.offerLimit' };
  }
  if (island.resources[give.res] < give.amount) return { error: 'err.noResources' };
  island.resources[give.res] -= give.amount;
  world.offers.push({
    id: world.nextId++, playerId: player.id, islandId: island.id,
    give: { res: give.res, amount: give.amount },
    want: { res: want.res, amount: want.amount },
    time: now,
  });
  return { ok: true };
}

// Withdraw an offer: escrowed goods return to the island instantly.
function cancelOffer(world, player, offerId, now) {
  const offer = world.offers.find((o) => o.id === Number(offerId));
  if (!offer || offer.playerId !== player.id) return { error: 'err.noOffer' };
  world.offers = world.offers.filter((o) => o.id !== offer.id);
  const home = world.islands.find((i) => i.id === offer.islandId && i.ownerId === player.id)
    || playerIsland(world, player.id);
  if (home) {
    resolveIsland(home, now);
    const cap = storageCapacity(home.buildings.storehouse);
    home.resources[offer.give.res] =
      Math.min(cap, home.resources[offer.give.res] + offer.give.amount);
  }
  return { ok: true };
}

// Accept an offer: pay the asking price, then two shipments cross the sea.
function acceptOffer(world, player, island, offerId, now) {
  const offer = world.offers.find((o) => o.id === Number(offerId));
  if (!offer) return { error: 'err.noOffer' };
  if (offer.playerId === player.id) return { error: 'err.ownOffer' };
  resolveIsland(island, now);
  if (island.buildings.harbor < 1) {
    return { error: 'err.buildFirst', errorParams: { building: '@building.harbor.name' } };
  }
  if (island.resources[offer.want.res] < offer.want.amount) {
    return { error: 'err.noResources' };
  }
  island.resources[offer.want.res] -= offer.want.amount;
  world.offers = world.offers.filter((o) => o.id !== offer.id);

  const origin = world.islands.find((i) => i.id === offer.islandId)
    || playerIsland(world, offer.playerId);
  const ownerHome = (origin && origin.ownerId === offer.playerId)
    ? origin : playerIsland(world, offer.playerId);
  const dist = Math.hypot(origin.x - island.x, origin.y - island.y);
  const duration = Math.max(5000, Math.round((dist * TRADE_SPEED * 60000) / SPEED));
  // The escrowed goods sail to the buyer...
  world.movements.push({
    id: world.nextId++, type: 'trade', ownerId: offer.playerId,
    fromId: origin.id, toId: island.id, units: zeroUnits(),
    loot: fullLoad(offer.give.res, offer.give.amount),
    depart: now, arrive: now + duration,
  });
  // ...and the payment sails to the seller.
  if (ownerHome) {
    const dist2 = Math.hypot(ownerHome.x - island.x, ownerHome.y - island.y);
    const duration2 = Math.max(5000, Math.round((dist2 * TRADE_SPEED * 60000) / SPEED));
    world.movements.push({
      id: world.nextId++, type: 'trade', ownerId: player.id,
      fromId: island.id, toId: ownerHome.id, units: zeroUnits(),
      loot: fullLoad(offer.want.res, offer.want.amount),
      depart: now, arrive: now + duration2,
    });
  }
  return { ok: true };
}

// ---------------------------------------------------------------- diplomacy & board

// Effective relation between two alliances: war is unilateral,
// an alliance needs both sides, a pact needs both sides at nap-or-better.
function allianceRelation(world, aid1, aid2) {
  if (!aid1 || !aid2) return null;
  if (aid1 === aid2) return 'same';
  const a1 = world.alliances.find((a) => a.id === aid1);
  const a2 = world.alliances.find((a) => a.id === aid2);
  if (!a1 || !a2) return null;
  const s1 = (a1.diplomacy || {})[aid2];
  const s2 = (a2.diplomacy || {})[aid1];
  if (s1 === 'war' || s2 === 'war') return 'war';
  if (s1 === 'ally' && s2 === 'ally') return 'ally';
  const pactish = (s) => s === 'nap' || s === 'ally';
  if (pactish(s1) && pactish(s2)) return 'nap';
  return null;
}

function setStance(world, player, targetAllianceId, stance, now) {
  const alliance = allianceOf(world, player.id);
  if (!alliance) return { error: 'err.noAlliance' };
  if (alliance.members[0] !== player.id) return { error: 'err.notLeader' };
  const target = world.alliances.find((a) => a.id === Number(targetAllianceId));
  if (!target || target.id === alliance.id) return { error: 'err.noSuchAlliance' };
  if (!['war', 'nap', 'ally', 'none'].includes(stance)) return { error: 'err.badRequest' };
  alliance.diplomacy = alliance.diplomacy || {};
  const prev = alliance.diplomacy[target.id];
  if (stance === 'none') delete alliance.diplomacy[target.id];
  else alliance.diplomacy[target.id] = stance;
  if (stance === 'war' && prev !== 'war') {
    for (const pid of [...alliance.members, ...target.members]) {
      const L = langOf(world, pid);
      addReport(world, pid, now, t(L, 'report.dip.war.title'), [
        t(L, 'report.dip.war.l1', { a: alliance.tag, b: target.tag }),
      ]);
    }
  }
  return { ok: true };
}

function postBoard(world, player, body, now) {
  const alliance = allianceOf(world, player.id);
  if (!alliance) return { error: 'err.noAlliance' };
  body = String(body || '').trim();
  if (!body || body.length > 500) return { error: 'err.msgLength' };
  world.boards[alliance.id] = world.boards[alliance.id] || [];
  world.boards[alliance.id].push({
    id: world.nextId++, playerId: player.id, time: now, body,
  });
  if (world.boards[alliance.id].length > 50) {
    world.boards[alliance.id] = world.boards[alliance.id].slice(-50);
  }
  return { ok: true };
}

// Rename one of your islands. Unicode letters welcome — this is user text.
function renameIsland(world, player, island, name) {
  name = String(name || '').trim();
  if (!/^[\p{L}\p{N} .,'-]{2,30}$/u.test(name)) return { error: 'err.badName' };
  island.name = name;
  return { ok: true };
}

// Espionage. Scouts fight only enemy scouts; survivors bring intel home.
function sendScout(world, player, island, target, count, now) {
  count = Math.floor(Number(count));
  if (!(count >= 1 && count <= 500)) return { error: 'err.count' };
  resolveIsland(island, now);
  if (island.units.scout < count) return { error: 'err.noTroops' };
  if (target.ownerId == null) return { error: 'err.uninhabited' };
  if (target.ownerId === player.id) return { error: 'err.ownIsland' };
  island.units.scout -= count;
  const fleet = zeroUnits();
  fleet.scout = count;
  const arrive = now + travelDuration(island, target, fleet);
  world.movements.push({
    id: world.nextId++, type: 'scout', ownerId: player.id,
    fromId: island.id, toId: target.id, units: fleet, depart: now, arrive,
  });
  return { ok: true, arrive };
}

function sendColonize(world, player, island, target, now) {
  resolveIsland(island, now);
  if (target.ownerId != null) return { error: 'err.inhabited' };
  if (island.units.colonyship < 1) return { error: 'err.needColonyShip' };
  island.units.colonyship -= 1;
  const fleet = zeroUnits();
  fleet.colonyship = 1;
  const arrive = now + travelDuration(island, target, fleet);
  world.movements.push({
    id: world.nextId++,
    type: 'colonize',
    ownerId: player.id,
    fromId: island.id,
    toId: target.id,
    units: fleet,
    depart: now,
    arrive,
  });
  return { ok: true, arrive };
}

// ---------------------------------------------------------------- alliances & mail

function allianceOf(world, playerId) {
  const p = world.players.find((x) => x.id === playerId);
  if (!p || !p.allianceId) return null;
  return world.alliances.find((a) => a.id === p.allianceId) || null;
}

function createAlliance(world, player, name, tag) {
  name = String(name || '').trim();
  tag = String(tag || '').trim().toUpperCase();
  if (player.allianceId) return { error: 'err.inAlliance' };
  if (!/^[\p{L}\p{N} .'-]{3,30}$/u.test(name)) return { error: 'err.allianceName' };
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) return { error: 'err.allianceTag' };
  if (world.alliances.some((a) =>
    a.name.toLowerCase() === name.toLowerCase() || a.tag === tag)) {
    return { error: 'err.allianceTaken' };
  }
  const alliance = { id: world.nextId++, name, tag, members: [player.id], invites: [] };
  world.alliances.push(alliance);
  player.allianceId = alliance.id;
  return { alliance };
}

function inviteToAlliance(world, inviter, targetName, now) {
  const alliance = allianceOf(world, inviter.id);
  if (!alliance) return { error: 'err.noAlliance' };
  const target = world.players.find(
    (p) => !p.isBot && p.name.toLowerCase() === String(targetName || '').trim().toLowerCase()
  );
  if (!target) return { error: 'err.noPlayer' };
  if (target.allianceId) return { error: 'err.theyInAlliance' };
  if (alliance.invites.includes(target.id)) return { error: 'err.alreadyInvited' };
  alliance.invites.push(target.id);
  sendMessage(world, inviter, target.name,
    t(langOf(world, target.id), 'mail.invite', { tag: alliance.tag, name: alliance.name }), now);
  return { ok: true };
}

function acceptInvite(world, player, allianceId) {
  if (player.allianceId) return { error: 'err.inAlliance' };
  const alliance = world.alliances.find((a) => a.id === Number(allianceId));
  if (!alliance || !alliance.invites.includes(player.id)) return { error: 'err.noInvite' };
  alliance.invites = alliance.invites.filter((id) => id !== player.id);
  alliance.members.push(player.id);
  player.allianceId = alliance.id;
  return { ok: true };
}

function declineInvite(world, player, allianceId) {
  const alliance = world.alliances.find((a) => a.id === Number(allianceId));
  if (!alliance) return { error: 'err.noSuchAlliance' };
  alliance.invites = alliance.invites.filter((id) => id !== player.id);
  return { ok: true };
}

function leaveAlliance(world, player) {
  const alliance = allianceOf(world, player.id);
  if (!alliance) return { error: 'err.noAlliance' };
  alliance.members = alliance.members.filter((id) => id !== player.id);
  player.allianceId = null;
  if (alliance.members.length === 0) {
    world.alliances = world.alliances.filter((a) => a.id !== alliance.id);
  }
  return { ok: true };
}

function sendMessage(world, from, toName, body, now) {
  body = String(body || '').trim();
  if (!body || body.length > 500) return { error: 'err.msgLength' };
  const to = world.players.find(
    (p) => p.name.toLowerCase() === String(toName || '').trim().toLowerCase()
  );
  if (!to) return { error: 'err.noPlayer' };
  if (to.isBot) return { error: 'err.botMail' };
  if (to.id === from.id) return { error: 'err.selfMail' };
  world.messages.push({
    id: world.nextId++, fromId: from.id, toId: to.id, time: now, body, read: false,
  });
  const inbox = world.messages.filter((msg) => msg.toId === to.id);
  if (inbox.length > 100) {
    const drop = new Set(inbox.slice(0, inbox.length - 100).map((msg) => msg.id));
    world.messages = world.messages.filter((msg) => !drop.has(msg.id));
  }
  return { ok: true };
}

function addReport(world, ownerId, time, title, lines) {
  const player = world.players.find((p) => p.id === ownerId);
  if (!player || player.isBot) return; // bots don't read their mail
  world.reports.push({ id: world.nextId++, ownerId, time, title, lines, read: false });
  const mine = world.reports.filter((r) => r.ownerId === ownerId);
  if (mine.length > 100) {
    const drop = new Set(mine.slice(0, mine.length - 100).map((r) => r.id));
    world.reports = world.reports.filter((r) => !drop.has(r.id));
  }
}

function applyMovement(world, m) {
  const dest = world.islands.find((i) => i.id === m.toId);
  const origin = world.islands.find((i) => i.id === m.fromId);
  if (!dest) return;
  resolveIsland(dest, m.arrive);

  const at = (i) => `${i.name} (${i.x}:${i.y})`;
  const originFor = (lang) => (origin ? at(origin) : t(lang, 'origin.unknown'));

  if (m.type === 'return') {
    const L = langOf(world, m.ownerId);
    // The island may have changed hands while they were away.
    if (dest.ownerId !== m.ownerId) {
      addReport(world, m.ownerId, m.arrive, t(L, 'report.disband.title'), [
        t(L, 'report.disband.l1', { units: fmtUnits(m.units, L), island: at(dest) }),
        t(L, 'report.disband.l2'),
      ]);
      return;
    }
    for (const [k, n] of Object.entries(m.units)) dest.units[k] += n;
    if (m.loot) {
      const cap = storageCapacity(dest.buildings.storehouse);
      for (const r of RESOURCES) {
        dest.resources[r] = Math.min(cap, dest.resources[r] + m.loot[r]);
      }
    }
    addReport(world, m.ownerId, m.arrive,
      t(L, 'report.return.title', { island: dest.name }), [
        t(L, 'report.return.units', { units: fmtUnits(m.units, L) }),
        m.loot ? t(L, 'report.return.loot', { loot: fmtRes(m.loot, L) }) : '',
      ].filter(Boolean));
    return;
  }

  if (m.type === 'colonize') {
    const settler = world.players.find((p) => p.id === m.ownerId);
    const coords = `(${dest.x}:${dest.y})`;
    const L = langOf(world, m.ownerId);
    if (dest.ownerId == null && settler) {
      if (world.metrics) world.metrics.colonizations++;
      dest.ownerId = settler.id;
      dest.name = t(L, 'name.colony', { name: settler.name });
      dest.buildings = {
        lumberyard: 1, quarry: 1, goldmine: 1, storehouse: 1, hall: 1,
        barracks: 0, harbor: 0, wall: 0, farm: 1, wonder: 0,
      };
      dest.resources = { wood: 150, stone: 150, gold: 80 };
      dest.units = zeroUnits();
      dest.support = [];
      dest.loyalty = LOYALTY_MAX;
      dest.queue = [];
      dest.trainQueue = [];
      dest.lastUpdate = m.arrive;
      addReport(world, m.ownerId, m.arrive,
        t(L, 'report.colonized.title', { coords }), [
          t(L, 'report.colonized.l1', { island: dest.name }),
          t(L, 'report.colonized.l2'),
        ]);
    } else {
      world.movements.push({
        id: world.nextId++, type: 'return', ownerId: m.ownerId,
        fromId: m.toId, toId: m.fromId, units: m.units,
        depart: m.arrive, arrive: m.arrive + (m.arrive - m.depart),
      });
      addReport(world, m.ownerId, m.arrive,
        t(L, 'report.colonizeFail.title', { coords }), [
          t(L, 'report.colonizeFail.l1'),
        ]);
    }
    return;
  }

  const attacker = world.players.find((p) => p.id === m.ownerId);
  const where = `${dest.name} (${dest.x}:${dest.y})`;
  const atkLang = langOf(world, m.ownerId);
  const defLang = langOf(world, dest.ownerId);
  const attackerNameFor = (lang) => (attacker ? attacker.name : t(lang, 'player.unknown'));

  if (m.type === 'trade') {
    const cap = storageCapacity(dest.buildings.storehouse);
    for (const r of RESOURCES) {
      dest.resources[r] = Math.min(cap, dest.resources[r] + m.loot[r]);
    }
    addReport(world, m.ownerId, m.arrive,
      t(atkLang, 'report.trade.sent.title', { where }), [
        t(atkLang, 'report.trade.sent.l1', { res: fmtRes(m.loot, atkLang) }),
      ]);
    if (dest.ownerId !== m.ownerId) {
      addReport(world, dest.ownerId, m.arrive,
        t(defLang, 'report.trade.recv.title', { where }), [
          t(defLang, 'report.trade.recv.l1', {
            from: attackerNameFor(defLang), res: fmtRes(m.loot, defLang),
          }),
        ]);
    }
    return;
  }

  if (m.type === 'support') {
    if (dest.ownerId === m.ownerId) {
      // Supporting your own island is a troop transfer.
      for (const [k, n] of Object.entries(m.units)) dest.units[k] += n;
    } else {
      dest.support = dest.support || [];
      const mine = dest.support.find((c) => c.ownerId === m.ownerId);
      if (mine) {
        for (const [k, n] of Object.entries(m.units)) mine.units[k] = (mine.units[k] || 0) + n;
      } else {
        dest.support.push({ ownerId: m.ownerId, fromId: m.fromId, units: { ...m.units } });
      }
    }
    addReport(world, m.ownerId, m.arrive,
      t(atkLang, 'report.support.arrived.title', { where }), [
        t(atkLang, 'report.support.arrived.l1', { units: fmtUnits(m.units, atkLang) }),
      ]);
    return;
  }

  if (m.type === 'scout') {
    const n = m.units.scout;
    const defScouts = dest.units.scout;
    if (defScouts >= n) {
      // Counter-espionage wins: nobody comes home.
      addReport(world, m.ownerId, m.arrive,
        t(atkLang, 'report.scoutFail.title', { where }), [
          t(atkLang, 'report.scoutFail.l1', { n }),
        ]);
      addReport(world, dest.ownerId, m.arrive,
        t(defLang, 'report.scoutCaught.title', { where }), [
          t(defLang, 'report.scoutCaught.l1', { attacker: attackerNameFor(defLang), where }),
        ]);
      return;
    }
    const survivorsHome = n - defScouts;
    const supportTotal = zeroUnits();
    for (const c of dest.support || []) {
      for (const [k, v] of Object.entries(c.units)) supportTotal[k] += v;
    }
    const stores = {
      wood: Math.floor(dest.resources.wood),
      stone: Math.floor(dest.resources.stone),
      gold: Math.floor(dest.resources.gold),
    };
    const buildingList = Object.entries(dest.buildings)
      .filter(([, lvl]) => lvl > 0)
      .map(([k, lvl]) => `${t(atkLang, `building.${k}.name`)} ${lvl}`)
      .join(', ');
    // Everyone keeps machine-readable intel from their scouts; humans share
    // it with alliance-mates on the map.
    if (attacker) {
      let dPow = unitPower(dest.units, 'def');
      for (const c of dest.support || []) dPow += unitPower(c.units, 'def');
      const wl = dest.buildings.wall || 0;
      attacker.intel = attacker.intel || {};
      attacker.intel[dest.id] = {
        def: Math.round((dPow + WALL_FLAT_DEF * wl) * (1 + WALL_DEF_BONUS * wl)),
        time: m.arrive,
      };
    }
    addReport(world, m.ownerId, m.arrive,
      t(atkLang, 'report.scout.title', { where }), [
        t(atkLang, 'report.scout.garrison', { units: fmtUnits(dest.units, atkLang) }),
        totalUnits(supportTotal) > 0
          ? t(atkLang, 'report.scout.support', { units: fmtUnits(supportTotal, atkLang) }) : '',
        t(atkLang, 'report.scout.stores', { res: fmtRes(stores, atkLang) }),
        t(atkLang, 'report.scout.loyalty', { n: Math.round(dest.loyalty) }),
        t(atkLang, 'report.scout.buildings', { list: buildingList }),
        defScouts > 0 ? t(atkLang, 'report.scout.losses', { n: defScouts }) : '',
      ].filter(Boolean));
    if (defScouts > 0) {
      addReport(world, dest.ownerId, m.arrive,
        t(defLang, 'report.scoutSeen.title', { where }), [
          t(defLang, 'report.scoutSeen.l1', { attacker: attackerNameFor(defLang), where }),
        ]);
    }
    const fleet = zeroUnits();
    fleet.scout = survivorsHome;
    world.movements.push({
      id: world.nextId++, type: 'return', ownerId: m.ownerId,
      fromId: m.toId, toId: m.fromId, units: fleet,
      depart: m.arrive, arrive: m.arrive + (m.arrive - m.depart),
    });
    return;
  }

  // Attack arrives. Everyone stationed at the destination defends.

  // If the island became the attacker's own while the army was at sea
  // (e.g. captured by an earlier wave), the army reinforces it instead.
  if (dest.ownerId === m.ownerId) {
    for (const [k, n] of Object.entries(m.units)) dest.units[k] += n;
    addReport(world, m.ownerId, m.arrive,
      t(atkLang, 'report.reinforced.title', { where }), [
        t(atkLang, 'report.reinforced.l1', { units: fmtUnits(m.units, atkLang) }),
      ]);
    return;
  }

  // Bots hold grudges against whoever attacks them.
  const defOwner = world.players.find((p) => p.id === dest.ownerId);
  if (defOwner && defOwner.isBot && attacker) {
    defOwner.grudges = defOwner.grudges || {};
    defOwner.grudges[attacker.id] = (defOwner.grudges[attacker.id] || 0) + 1;
  }

  // Morale: bullying much smaller players blunts the attack.
  let morale = 1;
  if (attacker && defOwner) {
    const ap = playerPoints(world, attacker.id);
    const dp = playerPoints(world, defOwner.id);
    if (ap > dp && dp > 0) {
      const floor = defOwner.isBot ? BOT_MORALE_FLOOR : MORALE_FLOOR;
      morale = Math.max(floor, Math.sqrt(dp / ap));
    }
  }
  const A = unitPower(m.units, 'atk') * morale;
  dest.support = dest.support || [];
  let defPower = unitPower(dest.units, 'def');
  for (const c of dest.support) defPower += unitPower(c.units, 'def');
  const wallBefore = dest.buildings.wall || 0;
  const D = Math.round((defPower + WALL_FLAT_DEF * wallBefore)
    * (1 + WALL_DEF_BONUS * wallBefore) * nightFactor(m.arrive));
  const moraleLine = (lang) => (morale < 0.995
    ? t(lang, 'report.morale.line', { pct: Math.round(morale * 100) }) : '');

  // A battle report line for each support sender, in their own language.
  const notifySupportLosses = (contingent, lost, wiped) => {
    if (totalUnits(lost) === 0) return;
    const sLang = langOf(world, contingent.ownerId);
    addReport(world, contingent.ownerId, m.arrive,
      t(sLang, wiped ? 'report.support.wiped.title' : 'report.support.battle.title', { where }), [
        t(sLang, wiped ? 'report.support.wiped.l1' : 'report.support.battle.l1', {
          units: fmtUnits(lost, sLang),
        }),
      ]);
  };

  // Optional playtest metrics (world.metrics is absent in normal play).
  const M = world.metrics;
  if (M) {
    M.battles++;
    if (A > D) M.attackerWins++;
    if (wallBefore > 0) {
      M.walledBattles++;
      if (A <= D) M.walledHolds++;
    }
  }

  if (A > D) {
    if (attacker && !attacker.isBot) {
      attacker.stats = attacker.stats || {};
      attacker.stats.wins = (attacker.stats.wins || 0) + 1;
    }
    const lossFrac = D > 0 ? Math.pow(D / A, 1.5) : 0;
    const survivors = scaleUnits(m.units, 1 - lossFrac);
    if (totalUnits(survivors) === 0) {
      // The victor always limps home with someone to tell the tale.
      const biggest = Object.keys(m.units).sort((a, b) => m.units[b] - m.units[a])[0];
      survivors[biggest] = 1;
    }
    // The whole defense falls: garrison and every stationed contingent.
    const defendersLost = { ...dest.units };
    for (const c of dest.support) {
      for (const [k, n] of Object.entries(c.units)) defendersLost[k] += n;
      notifySupportLosses(c, c.units, true);
    }
    dest.units = zeroUnits();
    dest.support = [];

    // The wall takes damage in a sack.
    let wallLine = '';
    if (wallBefore > 0) {
      dest.buildings.wall = wallBefore - 1;
      wallLine = { from: wallBefore, to: wallBefore - 1 };
    }

    // A surviving Flagship breaks loyalty; at zero the island falls.
    let loyaltyLine = null;
    if (survivors.flagship >= 1) {
      const before = Math.round(dest.loyalty);
      const drop = 25 + Math.floor(Math.random() * 16);
      dest.loyalty = before - drop;
      loyaltyLine = { from: before, to: Math.max(0, Math.round(dest.loyalty)) };
    }

    if (M && loyaltyLine) M.loyaltyStrikes++;

    // Conquest only when loyalty is fully broken.
    if (survivors.flagship >= 1 && dest.loyalty <= 0) {
      if (M) M.conquests++;
      const oldOwner = world.players.find((p) => p.id === dest.ownerId);
      survivors.flagship -= 1; // the Flagship becomes the seat of power
      dest.ownerId = m.ownerId;
      dest.units = survivors;
      dest.queue = [];
      dest.trainQueue = [];
      dest.loyalty = LOYALTY_AFTER_CAPTURE; // a fresh conquest is restive
      const stores = {
        wood: Math.floor(dest.resources.wood),
        stone: Math.floor(dest.resources.stone),
        gold: Math.floor(dest.resources.gold),
      };
      addReport(world, m.ownerId, m.arrive,
        t(atkLang, 'report.conquered.title', { where }), [
          t(atkLang, 'report.conquered.l1', {
            origin: originFor(atkLang), where, owner: oldOwner ? oldOwner.name : '?',
          }),
          t(atkLang, 'report.conquered.l2', { sent: fmtUnits(m.units, atkLang) }),
          t(atkLang, 'report.conquered.l3', { defLost: fmtUnits(defendersLost, atkLang) }),
          t(atkLang, 'report.conquered.l4', { res: fmtRes(stores, atkLang) }),
        ]);
      if (oldOwner) {
        addReport(world, oldOwner.id, m.arrive,
          t(defLang, 'report.fallen.title', { where }), [
            t(defLang, 'report.fallen.l1', {
              attacker: attackerNameFor(defLang), origin: originFor(defLang), sent: fmtUnits(m.units, defLang),
            }),
            t(defLang, 'report.fallen.l2', { defLost: fmtUnits(defendersLost, defLang) }),
          ]);
        if (playerIslands(world, oldOwner.id).length === 0) {
          if (M) M.respawns++;
          const refuge = newIsland(world, oldOwner.id, t(defLang, 'name.refuge', { name: oldOwner.name }));
          addReport(world, oldOwner.id, m.arrive,
            t(defLang, 'report.refuge.title'), [
              t(defLang, 'report.refuge.l1', { coords: `(${refuge.x}:${refuge.y})` }),
            ]);
        }
      }
      return;
    }

    const capacity = carryCapacity(survivors);
    const stock = RESOURCES.reduce((s, r) => s + dest.resources[r], 0);
    const f = stock > 0 ? Math.min(1, capacity / stock) : 0;
    const loot = {};
    for (const r of RESOURCES) {
      loot[r] = Math.floor(dest.resources[r] * f);
      dest.resources[r] -= loot[r];
    }

    if (M) {
      M.lootHauled += loot.wood + loot.stone + loot.gold;
      M.atkUnitsLost += totalUnits(m.units) - totalUnits(survivors);
      M.defUnitsLost += totalUnits(defendersLost);
    }

    const duration = m.arrive - m.depart;
    world.movements.push({
      id: world.nextId++,
      type: 'return',
      ownerId: m.ownerId,
      fromId: m.toId,
      toId: m.fromId,
      units: survivors,
      loot,
      depart: m.arrive,
      arrive: m.arrive + duration,
    });

    addReport(world, m.ownerId, m.arrive,
      t(atkLang, 'report.victory.title', { where }), [
        t(atkLang, 'report.victory.l1', { origin: originFor(atkLang), where }),
        moraleLine(atkLang),
        t(atkLang, 'report.victory.l2', {
          sent: fmtUnits(m.units, atkLang), survivors: fmtUnits(survivors, atkLang),
        }),
        m.units.flagship > 0 && !survivors.flagship && !loyaltyLine
          ? t(atkLang, 'report.victory.flagshipLost') : '',
        loyaltyLine ? t(atkLang, 'report.loyalty.line',
          { where, from: loyaltyLine.from, to: loyaltyLine.to }) : '',
        wallLine ? t(atkLang, 'report.wall.line', wallLine) : '',
        t(atkLang, 'report.victory.l3', { defLost: fmtUnits(defendersLost, atkLang) }),
        t(atkLang, 'report.victory.l4', { loot: fmtRes(loot, atkLang) }),
      ].filter(Boolean));
    addReport(world, dest.ownerId, m.arrive,
      t(defLang, 'report.raided.title', { where }), [
        t(defLang, 'report.raided.l1', {
          attacker: attackerNameFor(defLang), origin: originFor(defLang), sent: fmtUnits(m.units, defLang),
        }),
        t(defLang, 'report.raided.l2', { defLost: fmtUnits(defendersLost, defLang) }),
        loyaltyLine ? t(defLang, 'report.loyalty.line',
          { where, from: loyaltyLine.from, to: loyaltyLine.to }) : '',
        wallLine ? t(defLang, 'report.wall.line', wallLine) : '',
        t(defLang, 'report.raided.l3', { loot: fmtRes(loot, defLang) }),
      ].filter(Boolean));
  } else {
    if (M) M.atkUnitsLost += totalUnits(m.units);
    const defLossFrac = D > 0 ? Math.pow(A / D, 1.5) : 0;
    const defendersBefore = { ...dest.units };
    dest.units = scaleUnits(dest.units, 1 - defLossFrac);
    const defendersLost = {};
    for (const k of Object.keys(dest.units)) {
      defendersLost[k] = defendersBefore[k] - dest.units[k];
    }
    // Support contingents bleed at the same rate as the garrison.
    for (const c of dest.support) {
      const before = { ...c.units };
      c.units = scaleUnits(c.units, 1 - defLossFrac);
      const lost = {};
      for (const k of Object.keys(c.units)) {
        lost[k] = before[k] - c.units[k];
        defendersLost[k] = (defendersLost[k] || 0) + lost[k];
      }
      notifySupportLosses(c, lost, false);
    }
    dest.support = dest.support.filter((c) => totalUnits(c.units) > 0);

    addReport(world, m.ownerId, m.arrive,
      t(atkLang, 'report.defeat.title', { where }), [
        t(atkLang, 'report.defeat.l1', { origin: originFor(atkLang), where }),
        moraleLine(atkLang),
        t(atkLang, 'report.defeat.l2', { sent: fmtUnits(m.units, atkLang) }),
        t(atkLang, 'report.defeat.l3', { defLost: fmtUnits(defendersLost, atkLang) }),
      ].filter(Boolean));
    addReport(world, dest.ownerId, m.arrive,
      t(defLang, 'report.repelled.title', { where }), [
        t(defLang, 'report.repelled.l1', {
          attacker: attackerNameFor(defLang), origin: originFor(defLang), sent: fmtUnits(m.units, defLang),
        }),
        t(defLang, 'report.repelled.l2', { defLost: fmtUnits(defendersLost, defLang) }),
      ]);
  }
}

// ---------------------------------------------------------------- quests

// A linear tutorial chain, checked server-side. Rewards land on the first
// island; a veteran whose empire already satisfies later steps chain-clears.
const QUESTS = [
  { id: 'lumber2', reward: { wood: 50, stone: 50, gold: 25 },
    done: (world, p) => playerIslands(world, p.id).some((i) => i.buildings.lumberyard >= 2) },
  { id: 'store2', reward: { wood: 80, stone: 80, gold: 40 },
    done: (world, p) => playerIslands(world, p.id).some((i) => i.buildings.storehouse >= 2) },
  { id: 'barracks1', reward: { wood: 100, stone: 80, gold: 50 },
    done: (world, p) => playerIslands(world, p.id).some((i) => i.buildings.barracks >= 1) },
  { id: 'train5', reward: { wood: 120, stone: 100, gold: 60 },
    done: (world, p) => (p.stats && p.stats.trained || 0) >= 5 },
  { id: 'wall1', reward: { wood: 100, stone: 150, gold: 50 },
    done: (world, p) => playerIslands(world, p.id).some((i) => i.buildings.wall >= 1) },
  { id: 'win1', reward: { wood: 150, stone: 120, gold: 80 },
    done: (world, p) => (p.stats && p.stats.wins || 0) >= 1 },
  { id: 'harbor1', reward: { wood: 250, stone: 200, gold: 120 },
    done: (world, p) => playerIslands(world, p.id).some((i) => i.buildings.harbor >= 1) },
  { id: 'expand2', reward: { wood: 400, stone: 400, gold: 200 },
    done: (world, p) => playerIslands(world, p.id).length >= 2 },
];

function checkQuests(world, player, now) {
  if (player.isBot) return;
  if (player.questIndex == null) player.questIndex = 0;
  const L = player.lang || 'en';
  while (player.questIndex < QUESTS.length) {
    const quest = QUESTS[player.questIndex];
    if (!quest.done(world, player)) break;
    const home = playerIsland(world, player.id);
    if (home) {
      resolveIsland(home, now);
      const cap = storageCapacity(home.buildings.storehouse);
      for (const r of RESOURCES) {
        home.resources[r] = Math.min(cap, home.resources[r] + quest.reward[r]);
      }
      addReport(world, player.id, now,
        t(L, 'report.quest.title', { quest: t(L, `quest.${quest.id}.name`) }), [
          t(L, 'report.quest.l1', { island: home.name, res: fmtRes(quest.reward, L) }),
        ]);
    }
    player.questIndex++;
  }
}

// The current quest, localized, or null when the chain is finished.
function currentQuest(world, player) {
  const idx = player.questIndex || 0;
  if (player.isBot || idx >= QUESTS.length) return null;
  const L = player.lang || 'en';
  const quest = QUESTS[idx];
  return {
    i: idx + 1,
    n: QUESTS.length,
    name: t(L, `quest.${quest.id}.name`),
    desc: t(L, `quest.${quest.id}.desc`),
    reward: quest.reward,
  };
}

// ---------------------------------------------------------------- victory

// The hall of fame lives in its own file so it survives world resets.
const HALL_FILE = process.env.HALL_FILE
  || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'hall-of-fame.json');

function loadHall() {
  try { return JSON.parse(fs.readFileSync(HALL_FILE, 'utf8')); } catch { return []; }
}

function appendHall(entry) {
  const hall = loadHall();
  hall.push({ season: hall.length + 1, ...entry });
  fs.mkdirSync(path.dirname(HALL_FILE), { recursive: true });
  fs.writeFileSync(HALL_FILE, JSON.stringify(hall, null, 2));
  return hall;
}

function crownWinner(world, winner, now) {
  world.winner = { ...winner, time: now };
  appendHall(world.winner);
  for (const p of world.players) {
    if (p.isBot) continue;
    const L = p.lang || 'en';
    addReport(world, p.id, now, t(L, 'report.worldWon.title'), [
      t(L, 'report.worldWon.l1', {
        name: winner.name, n: winner.islands, total: winner.total,
      }),
    ]);
  }
  return world.winner;
}

// A player or alliance holding WIN_SHARE of all islands wins the world —
// or anyone completing the Great Beacon. Wonder progress is announced to all.
function checkVictory(world, now) {
  // Wonder announcements fire even after a win (bragging rights).
  world.wonderAnnounced = world.wonderAnnounced || {};
  for (const island of world.islands) {
    const lvl = island.buildings.wonder || 0;
    if (lvl > (world.wonderAnnounced[island.id] || 0)) {
      world.wonderAnnounced[island.id] = lvl;
      const owner = world.players.find((p) => p.id === island.ownerId);
      for (const p of world.players) {
        if (p.isBot) continue;
        const L = p.lang || 'en';
        addReport(world, p.id, now, t(L, 'report.wonder.title'), [
          t(L, 'report.wonder.l1', {
            name: owner ? owner.name : '?',
            island: `${island.name} (${island.x}:${island.y})`,
            lvl,
            max: WONDER_WIN_LEVEL,
          }),
        ]);
      }
    }
  }
  if (world.winner) return null;
  const total = world.islands.length;

  // Wonder victory
  for (const island of world.islands) {
    if ((island.buildings.wonder || 0) >= WONDER_WIN_LEVEL && island.ownerId != null) {
      const owner = world.players.find((p) => p.id === island.ownerId);
      const islands = world.islands.filter((i) => i.ownerId === island.ownerId).length;
      return crownWinner(world, {
        name: owner ? owner.name : '?',
        islands,
        total,
        share: Math.round((100 * islands) / total),
        via: 'wonder',
      }, now);
    }
  }
  const byPlayer = new Map();
  for (const island of world.islands) {
    if (island.ownerId == null) continue;
    byPlayer.set(island.ownerId, (byPlayer.get(island.ownerId) || 0) + 1);
  }
  const byAlliance = new Map();
  for (const [pid, n] of byPlayer) {
    const p = world.players.find((x) => x.id === pid);
    if (p && p.allianceId) {
      byAlliance.set(p.allianceId, (byAlliance.get(p.allianceId) || 0) + n);
    }
  }
  let winner = null;
  for (const [pid, n] of byPlayer) {
    if (n / total >= WIN_SHARE) {
      const p = world.players.find((x) => x.id === pid);
      winner = { name: p ? p.name : '?', islands: n };
    }
  }
  for (const [aid, n] of byAlliance) {
    if (n / total >= WIN_SHARE && (!winner || n > winner.islands)) {
      const a = world.alliances.find((x) => x.id === aid);
      winner = { name: a ? `[${a.tag}] ${a.name}` : '?', islands: n };
    }
  }
  if (!winner) return null;
  return crownWinner(world, {
    ...winner,
    total,
    share: Math.round((100 * winner.islands) / total),
    via: 'dominance',
  }, now);
}

// ---------------------------------------------------------------- world

function randomFreeSpot(world) {
  const taken = new Set(world.islands.map((i) => `${i.x},${i.y}`));
  for (let tries = 0; tries < 5000; tries++) {
    const x = crypto.randomInt(0, MAP_SIZE);
    const y = crypto.randomInt(0, MAP_SIZE);
    if (!taken.has(`${x},${y}`)) return { x, y };
  }
  throw new Error('Map is full.');
}

function newIsland(world, ownerId, name) {
  const { x, y } = randomFreeSpot(world);
  const island = {
    id: world.nextId++,
    ownerId,
    name,
    x,
    y,
    resources: { wood: 250, stone: 250, gold: 120 },
    buildings: {
      lumberyard: 1, quarry: 1, goldmine: 1, storehouse: 1, hall: 1,
      barracks: 0, harbor: 0, wall: 0, farm: 1, wonder: 0,
    },
    units: zeroUnits(),
    support: [],
    loyalty: LOYALTY_MAX,
    queue: [],
    trainQueue: [],
    lastUpdate: Date.now(),
  };
  world.islands.push(island);
  return island;
}

// Empty islands waiting to be settled by a Colony Ship.
function newUnchartedIsland(world) {
  const { x, y } = randomFreeSpot(world);
  const island = {
    id: world.nextId++,
    ownerId: null,
    name: 'Uncharted Isle',
    x,
    y,
    resources: { wood: 0, stone: 0, gold: 0 },
    buildings: {
      lumberyard: 0, quarry: 0, goldmine: 0, storehouse: 0, hall: 0,
      barracks: 0, harbor: 0, wall: 0, farm: 0, wonder: 0,
    },
    units: zeroUnits(),
    support: [],
    loyalty: LOYALTY_MAX,
    queue: [],
    trainQueue: [],
    lastUpdate: Date.now(),
  };
  world.islands.push(island);
  return island;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function createPlayer(world, name, password, isBot, lang) {
  if (world.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return { error: 'err.nameTaken' };
  }
  lang = LANGS.includes(lang) ? lang : 'en';
  // Register during the pregame and your clock starts at launch, not now —
  // so grace and production begin for everyone together (#8).
  const start = Math.max(Date.now(), world.startAt || 0);
  const player = {
    id: world.nextId++, name, isBot: !!isBot, protectionBroken: !!isBot, lang,
    questIndex: 0, stats: {}, joinedAt: start,
  };
  if (!isBot) {
    player.salt = crypto.randomBytes(8).toString('hex');
    player.hash = hashPassword(password, player.salt);
  }
  world.players.push(player);
  const island = newIsland(world, player.id, t(lang, 'name.isle', { name }));
  island.lastUpdate = start; // no production accrues before launch
  return { player };
}

function checkPassword(player, password) {
  if (!player.salt) return false;
  const hash = Buffer.from(hashPassword(password, player.salt));
  const stored = Buffer.from(player.hash);
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

function playerIsland(world, playerId) {
  return world.islands.find((i) => i.ownerId === playerId);
}

function playerIslands(world, playerId) {
  return world.islands.filter((i) => i.ownerId === playerId);
}

function playerPoints(world, playerId) {
  return playerIslands(world, playerId).reduce((s, i) => s + islandPoints(i), 0);
}

const MAP_THEMES = ['generated', 'aegean'];

// Scheduled season start (#8). Until `startAt`, the world is frozen — no
// production, training, combat, or bot activity — but registration is open
// and the client shows a countdown, so everyone begins together and no
// established player exists to swarm newcomers. WORLD_START accepts an epoch
// (ms) or an ISO date; default is now (immediate launch, backward compatible).
function parseStart() {
  const raw = (process.env.WORLD_START || '').trim();
  if (!raw) return Date.now();
  const asNum = Number(raw);
  const t = Number.isFinite(asNum) && raw !== '' && !/[a-zA-Z:-]/.test(raw) ? asNum : Date.parse(raw);
  return Number.isFinite(t) ? t : Date.now();
}

// 'pregame' before launch, 'live' after, 'ended' once a winner is crowned.
function worldPhase(world, now) {
  if (world.winner) return 'ended';
  if (world.startAt && now < world.startAt) return 'pregame';
  return 'live';
}

function createWorld() {
  return {
    createdAt: Date.now(),
    startAt: parseStart(),
    theme: MAP_THEMES.includes(process.env.WORLD_THEME) ? process.env.WORLD_THEME : 'generated',
    mapSeed: crypto.randomInt(1, 2147483647),
    nextId: 1,
    players: [],
    islands: [],
    movements: [],
    reports: [],
    messages: [],
    alliances: [],
    offers: [],
    boards: {},
    sessions: {}, // token -> playerId
  };
}

// Backfill fields added by newer increments so old saves keep working.
function migrateWorld(world) {
  if (!world.movements) world.movements = [];
  if (!world.reports) world.reports = [];
  if (!world.messages) world.messages = [];
  if (!world.alliances) world.alliances = [];
  if (!world.offers) world.offers = [];
  if (!world.boards) world.boards = {};
  if (!world.theme) world.theme = 'generated';
  if (!world.mapSeed) world.mapSeed = (world.createdAt % 2147483645) + 1;
  if (world.startAt == null) world.startAt = world.createdAt || 0; // old saves: already live
  for (const a of world.alliances) {
    if (!a.diplomacy) a.diplomacy = {};
  }
  for (const p of world.players) {
    if (p.protectionBroken == null) p.protectionBroken = !!p.isBot;
    if (p.joinedAt == null) p.joinedAt = world.createdAt || 0;
    if (p.questIndex == null) p.questIndex = 0;
    if (!p.stats) p.stats = {};
  }
  for (const island of world.islands) {
    for (const key of Object.keys(BUILDINGS)) {
      if (island.buildings[key] == null) island.buildings[key] = 0;
    }
    if (!island.units) island.units = zeroUnits();
    for (const key of Object.keys(UNITS)) {
      if (island.units[key] == null) island.units[key] = 0;
    }
    if (!island.trainQueue) island.trainQueue = [];
    if (!island.support) island.support = [];
    if (island.loyalty == null) island.loyalty = LOYALTY_MAX;
    // Pre-farm islands get a farm big enough for their standing army.
    if (island.ownerId != null && island.buildings.farm === 0) {
      let lvl = 1;
      while (popCap(lvl) < popUsed(island)) lvl++;
      island.buildings.farm = lvl;
    }
  }
  if (!world.islands.some((i) => i.ownerId == null)) {
    for (let i = 0; i < 30; i++) newUnchartedIsland(world);
  }
  return world;
}

// ---------------------------------------------------------------- persistence

// Overridable so tests and embedding hosts (e.g. a JSS plugin) can point the
// world at their own storage instead of the repo's data/.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');

function loadWorld() {
  if (fs.existsSync(WORLD_FILE)) {
    return JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
  }
  return null;
}

function saveWorld(world) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = WORLD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(world));
  fs.renameSync(tmp, WORLD_FILE);
}

export {
  SPEED, MAP_SIZE, QUEUE_MAX, TRAIN_QUEUE_MAX, PROTECTED_POINTS, PROTECT_GRACE_MS, isProtected, RESOURCES, BUILDINGS, UNITS,
  LANGS, langOf,
  upgradeCost, upgradeTime, productionPerHour, storageCapacity,
  islandRates, islandPoints,
  resolveIsland, resolveWorld, pendingLevel, canAfford, tryBuild,
  zeroUnits, totalUnits, unitPower, carryCapacity, trainTime, tryTrain,
  popCap, popUsed, LOYALTY_MAX, WALL_FLAT_DEF, WALL_DEF_BONUS,
  MORALE_FLOOR, BOT_MORALE_FLOOR, worldPhase,
  travelDuration, sendAttack, sendColonize, sendSupport, withdrawSupport, sendScout,
  tradeCapacity, sendTrade, renameIsland, checkVictory, checkQuests, currentQuest,
  loadHall, WONDER_WIN_LEVEL,
  createWorld, migrateWorld, createPlayer, checkPassword,
  newIsland, newUnchartedIsland, playerIsland, playerIslands, playerPoints,
  allianceOf, createAlliance, inviteToAlliance, acceptInvite, declineInvite,
  leaveAlliance, sendMessage,
  createOffer, cancelOffer, acceptOffer,
  allianceRelation, setStance, postBoard,
  hashPassword, loadWorld, saveWorld,
};
