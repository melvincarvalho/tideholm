// Tideholm — core game engine.
// All game state lives in a single `world` object, persisted as JSON.
// Time is lazy: islands are resolved forward to `now` whenever they are read.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
};

// speed = minutes per map field at game speed 1 (lower is faster).
const UNITS = {
  spearman: {
    name: 'Spearman', plural: 'Spearmen', desc: 'Cheap all-rounder.',
    cost: { wood: 50, stone: 30, gold: 20 }, time: 60,
    atk: 10, def: 14, carry: 25, speed: 8,
  },
  raider: {
    name: 'Raider', desc: 'Hits hard, carries plenty, poor in defense.',
    cost: { wood: 80, stone: 40, gold: 45 }, time: 90,
    atk: 24, def: 7, carry: 60, speed: 6,
  },
  sentinel: {
    name: 'Sentinel', desc: 'Holds the line at home.',
    cost: { wood: 60, stone: 90, gold: 30 }, time: 90,
    atk: 6, def: 30, carry: 10, speed: 10,
  },
  colonyship: {
    name: 'Colony Ship', plural: 'Colony Ships',
    desc: 'Settles an uncharted island. Cannot fight.',
    cost: { wood: 1200, stone: 900, gold: 600 }, time: 600,
    atk: 0, def: 0, carry: 0, speed: 15,
    ship: true, building: 'harbor',
  },
  flagship: {
    name: 'Flagship', plural: 'Flagships',
    desc: 'Joins attacks. If it survives a victory, the island is yours.',
    cost: { wood: 2500, stone: 2000, gold: 1200 }, time: 900,
    atk: 0, def: 10, carry: 0, speed: 20,
    capture: true, building: 'harbor',
  },
};

const TRAIN_DISCOUNT = 0.95; // per barracks level above 1
const TRAIN_QUEUE_MAX = 5;

// Players below this many points cannot be attacked until they attack
// a human themselves. Bots already respect this; this enforces it for everyone.
const PROTECTED_POINTS = 40;

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
  if (!BUILDINGS[key]) return { error: 'Unknown building.' };
  resolveIsland(island, now);
  if (island.queue.length >= QUEUE_MAX) return { error: 'Build queue is full.' };
  const target = pendingLevel(island, key) + 1;
  const cost = upgradeCost(key, target);
  if (!canAfford(island, cost)) return { error: 'Not enough resources.' };
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

function fmtUnits(units) {
  const parts = Object.entries(units)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? UNITS[k].name : UNITS[k].plural || UNITS[k].name + 's'}`);
  return parts.join(', ') || 'no troops';
}

function fmtRes(res) {
  return `${res.wood} wood, ${res.stone} stone, ${res.gold} gold`;
}

// Seconds per unit to train, given the level of the building that trains it.
function trainTime(key, buildingLevel) {
  const t = (UNITS[key].time / SPEED) * Math.pow(TRAIN_DISCOUNT, Math.max(0, buildingLevel - 1));
  return Math.max(2, Math.round(t));
}

function tryTrain(world, island, key, count, now) {
  if (!UNITS[key]) return { error: 'Unknown unit.' };
  count = Math.floor(Number(count));
  if (!(count >= 1 && count <= 500)) return { error: 'Count must be 1-500.' };
  resolveIsland(island, now);
  const need = UNITS[key].building || 'barracks';
  if (island.buildings[need] < 1) return { error: `Build a ${BUILDINGS[need].name} first.` };
  if (island.trainQueue.length >= TRAIN_QUEUE_MAX) return { error: 'Training queue is full.' };
  const cost = {};
  for (const r of RESOURCES) cost[r] = UNITS[key].cost[r] * count;
  if (!canAfford(island, cost)) return { error: 'Not enough resources.' };
  for (const r of RESOURCES) island.resources[r] -= cost[r];
  const start = island.trainQueue.length
    ? island.trainQueue[island.trainQueue.length - 1].finish
    : now;
  island.trainQueue.push({
    unit: key,
    count,
    finish: start + trainTime(key, island.buildings[need]) * 1000 * count,
  });
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
    if (n < 0 || !Number.isFinite(n)) return { error: 'Invalid unit count.' };
    if (n > island.units[k]) return { error: 'Not enough troops at home.' };
    if (n > 0 && UNITS[k].ship) return { error: `${UNITS[k].plural} cannot join attacks.` };
    army[k] = n;
  }
  if (totalUnits(army) < 1) return { error: 'Send at least one unit.' };
  if (target.ownerId == null) return { error: 'That island is uninhabited — colonize it instead.' };
  if (target.ownerId === attacker.id) return { error: 'You cannot attack your own island.' };
  if (target.id === island.id) return { error: 'You cannot attack your own island.' };
  const targetOwner = world.players.find((p) => p.id === target.ownerId);
  if (attacker.allianceId && targetOwner && targetOwner.allianceId === attacker.allianceId) {
    return { error: 'You cannot attack an alliance member.' };
  }
  if (targetOwner && !targetOwner.protectionBroken &&
      playerPoints(world, targetOwner.id) < PROTECTED_POINTS) {
    return { error: 'That player is under beginner protection.' };
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

function sendColonize(world, player, island, target, now) {
  resolveIsland(island, now);
  if (target.ownerId != null) return { error: 'That island is already inhabited.' };
  if (island.units.colonyship < 1) return { error: 'You need a Colony Ship at this island.' };
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
  if (player.allianceId) return { error: 'You are already in an alliance.' };
  if (!/^[\w .'-]{3,30}$/.test(name)) return { error: 'Alliance name must be 3-30 characters.' };
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) return { error: 'Tag must be 2-5 letters or digits.' };
  if (world.alliances.some((a) =>
    a.name.toLowerCase() === name.toLowerCase() || a.tag === tag)) {
    return { error: 'That name or tag is already taken.' };
  }
  const alliance = { id: world.nextId++, name, tag, members: [player.id], invites: [] };
  world.alliances.push(alliance);
  player.allianceId = alliance.id;
  return { alliance };
}

function inviteToAlliance(world, inviter, targetName, now) {
  const alliance = allianceOf(world, inviter.id);
  if (!alliance) return { error: 'You are not in an alliance.' };
  const target = world.players.find(
    (p) => !p.isBot && p.name.toLowerCase() === String(targetName || '').trim().toLowerCase()
  );
  if (!target) return { error: 'No such player.' };
  if (target.allianceId) return { error: 'They are already in an alliance.' };
  if (alliance.invites.includes(target.id)) return { error: 'Already invited.' };
  alliance.invites.push(target.id);
  sendMessage(world, inviter, target.name,
    `You are invited to join [${alliance.tag}] ${alliance.name}. Open the Alliance tab to accept.`, now);
  return { ok: true };
}

function acceptInvite(world, player, allianceId) {
  if (player.allianceId) return { error: 'You are already in an alliance.' };
  const alliance = world.alliances.find((a) => a.id === Number(allianceId));
  if (!alliance || !alliance.invites.includes(player.id)) return { error: 'No such invitation.' };
  alliance.invites = alliance.invites.filter((id) => id !== player.id);
  alliance.members.push(player.id);
  player.allianceId = alliance.id;
  return { ok: true };
}

function declineInvite(world, player, allianceId) {
  const alliance = world.alliances.find((a) => a.id === Number(allianceId));
  if (!alliance) return { error: 'No such alliance.' };
  alliance.invites = alliance.invites.filter((id) => id !== player.id);
  return { ok: true };
}

function leaveAlliance(world, player) {
  const alliance = allianceOf(world, player.id);
  if (!alliance) return { error: 'You are not in an alliance.' };
  alliance.members = alliance.members.filter((id) => id !== player.id);
  player.allianceId = null;
  if (alliance.members.length === 0) {
    world.alliances = world.alliances.filter((a) => a.id !== alliance.id);
  }
  return { ok: true };
}

function sendMessage(world, from, toName, body, now) {
  body = String(body || '').trim();
  if (!body || body.length > 500) return { error: 'Message must be 1-500 characters.' };
  const to = world.players.find(
    (p) => p.name.toLowerCase() === String(toName || '').trim().toLowerCase()
  );
  if (!to) return { error: 'No such player.' };
  if (to.isBot) return { error: 'The islanders there do not answer letters.' };
  if (to.id === from.id) return { error: 'Talking to yourself is free.' };
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

  if (m.type === 'return') {
    // The island may have changed hands while they were away.
    if (dest.ownerId !== m.ownerId) {
      addReport(world, m.ownerId, m.arrive, `Nowhere to return`, [
        `Your ${fmtUnits(m.units)} reached ${dest.name} (${dest.x}:${dest.y}), but the island is no longer yours.`,
        'They scattered to the winds.',
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
    addReport(world, m.ownerId, m.arrive, `Troops returned to ${dest.name}`, [
      `Returned: ${fmtUnits(m.units)}.`,
      m.loot ? `Loot delivered: ${fmtRes(m.loot)}.` : '',
    ].filter(Boolean));
    return;
  }

  if (m.type === 'colonize') {
    const settler = world.players.find((p) => p.id === m.ownerId);
    const coords = `(${dest.x}:${dest.y})`;
    if (dest.ownerId == null && settler) {
      dest.ownerId = settler.id;
      dest.name = `${settler.name}'s Colony`;
      dest.buildings = {
        lumberyard: 1, quarry: 1, goldmine: 1,
        storehouse: 1, hall: 1, barracks: 0, harbor: 0,
      };
      dest.resources = { wood: 150, stone: 150, gold: 80 };
      dest.units = zeroUnits();
      dest.queue = [];
      dest.trainQueue = [];
      dest.lastUpdate = m.arrive;
      addReport(world, m.ownerId, m.arrive, `New colony founded at ${coords}`, [
        `Your settlers landed and founded ${dest.name}.`,
        'The ship was broken up for building material.',
      ]);
    } else {
      world.movements.push({
        id: world.nextId++, type: 'return', ownerId: m.ownerId,
        fromId: m.toId, toId: m.fromId, units: m.units,
        depart: m.arrive, arrive: m.arrive + (m.arrive - m.depart),
      });
      addReport(world, m.ownerId, m.arrive, `Colonization failed at ${coords}`, [
        'Another flag already flies over that island. Your ship is sailing home.',
      ]);
    }
    return;
  }

  // Attack arrives. Everyone stationed at the destination defends.
  const attacker = world.players.find((p) => p.id === m.ownerId);
  const attackerName = attacker ? attacker.name : 'Unknown';
  const originName = origin ? `${origin.name} (${origin.x}:${origin.y})` : 'parts unknown';
  const where = `${dest.name} (${dest.x}:${dest.y})`;

  // If the island became the attacker's own while the army was at sea
  // (e.g. captured by an earlier wave), the army reinforces it instead.
  if (dest.ownerId === m.ownerId) {
    for (const [k, n] of Object.entries(m.units)) dest.units[k] += n;
    addReport(world, m.ownerId, m.arrive, `Army reinforced ${where}`, [
      `${fmtUnits(m.units)} arrived to find the island already yours and joined its garrison.`,
    ]);
    return;
  }

  // Bots hold grudges against whoever attacks them.
  const defOwner = world.players.find((p) => p.id === dest.ownerId);
  if (defOwner && defOwner.isBot && attacker) {
    defOwner.grudges = defOwner.grudges || {};
    defOwner.grudges[attacker.id] = (defOwner.grudges[attacker.id] || 0) + 1;
  }

  const A = unitPower(m.units, 'atk');
  const D = unitPower(dest.units, 'def');

  if (A > D) {
    const lossFrac = D > 0 ? Math.pow(D / A, 1.5) : 0;
    const survivors = scaleUnits(m.units, 1 - lossFrac);
    if (totalUnits(survivors) === 0) {
      // The victor always limps home with someone to tell the tale.
      const biggest = Object.keys(m.units).sort((a, b) => m.units[b] - m.units[a])[0];
      survivors[biggest] = 1;
    }
    const defendersLost = { ...dest.units };
    dest.units = zeroUnits();

    // Conquest: a surviving Flagship claims the island outright.
    if (survivors.flagship >= 1) {
      const oldOwner = world.players.find((p) => p.id === dest.ownerId);
      survivors.flagship -= 1; // the Flagship becomes the seat of power
      dest.ownerId = m.ownerId;
      dest.units = survivors;
      dest.queue = [];
      dest.trainQueue = [];
      addReport(world, m.ownerId, m.arrive, `${where} conquered!`, [
        `Your army from ${originName} took ${where} from ${oldOwner ? oldOwner.name : 'no one'}.`,
        `You sent ${fmtUnits(m.units)}; the survivors now garrison the island.`,
        `Defenders lost: ${fmtUnits(defendersLost)}.`,
        `Its buildings and stores (${fmtRes({
          wood: Math.floor(dest.resources.wood),
          stone: Math.floor(dest.resources.stone),
          gold: Math.floor(dest.resources.gold),
        })}) are yours.`,
      ]);
      if (oldOwner) {
        addReport(world, oldOwner.id, m.arrive, `${where} has fallen`, [
          `${attackerName} attacked from ${originName} with ${fmtUnits(m.units)}.`,
          `Your garrison of ${fmtUnits(defendersLost)} was wiped out and the island was seized.`,
        ]);
        if (playerIslands(world, oldOwner.id).length === 0) {
          const refuge = newIsland(world, oldOwner.id, `${oldOwner.name}'s Refuge`);
          addReport(world, oldOwner.id, m.arrive, 'Your people fled across the sea', [
            `Survivors of your fallen realm settled a new island at (${refuge.x}:${refuge.y}).`,
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

    addReport(world, m.ownerId, m.arrive, `Victory at ${where}`, [
      `Your army from ${originName} attacked ${where}.`,
      `You sent ${fmtUnits(m.units)}; ${fmtUnits(survivors)} survived.`,
      m.units.flagship > 0 ? 'Your Flagship went down in the fighting — the island was not captured.' : '',
      `Defenders lost: ${fmtUnits(defendersLost)}.`,
      `Plundered ${fmtRes(loot)}. The army is heading home.`,
    ].filter(Boolean));
    addReport(world, dest.ownerId, m.arrive, `${where} was raided!`, [
      `${attackerName} attacked from ${originName} with ${fmtUnits(m.units)}.`,
      `Your garrison of ${fmtUnits(defendersLost)} was wiped out.`,
      `They plundered ${fmtRes(loot)}.`,
    ]);
  } else {
    const defLossFrac = D > 0 ? Math.pow(A / D, 1.5) : 0;
    const defendersBefore = { ...dest.units };
    dest.units = scaleUnits(dest.units, 1 - defLossFrac);
    const defendersLost = {};
    for (const k of Object.keys(dest.units)) {
      defendersLost[k] = defendersBefore[k] - dest.units[k];
    }

    addReport(world, m.ownerId, m.arrive, `Defeat at ${where}`, [
      `Your army from ${originName} attacked ${where}.`,
      `All ${fmtUnits(m.units)} were lost.`,
      `The defenders lost ${fmtUnits(defendersLost)}.`,
    ]);
    addReport(world, dest.ownerId, m.arrive, `${where} repelled an attack`, [
      `${attackerName} attacked from ${originName} with ${fmtUnits(m.units)} — all were slain.`,
      `You lost ${fmtUnits(defendersLost)} holding the line.`,
    ]);
  }
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
    buildings: { lumberyard: 1, quarry: 1, goldmine: 1, storehouse: 1, hall: 1, barracks: 0, harbor: 0 },
    units: zeroUnits(),
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
    buildings: { lumberyard: 0, quarry: 0, goldmine: 0, storehouse: 0, hall: 0, barracks: 0, harbor: 0 },
    units: zeroUnits(),
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

function createPlayer(world, name, password, isBot) {
  if (world.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return { error: 'That name is taken.' };
  }
  const player = { id: world.nextId++, name, isBot: !!isBot, protectionBroken: !!isBot };
  if (!isBot) {
    player.salt = crypto.randomBytes(8).toString('hex');
    player.hash = hashPassword(password, player.salt);
  }
  world.players.push(player);
  newIsland(world, player.id, `${name}'s Isle`);
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

function createWorld() {
  return {
    createdAt: Date.now(),
    nextId: 1,
    players: [],
    islands: [],
    movements: [],
    reports: [],
    messages: [],
    alliances: [],
    sessions: {}, // token -> playerId
  };
}

// Backfill fields added by newer increments so old saves keep working.
function migrateWorld(world) {
  if (!world.movements) world.movements = [];
  if (!world.reports) world.reports = [];
  if (!world.messages) world.messages = [];
  if (!world.alliances) world.alliances = [];
  for (const p of world.players) {
    if (p.protectionBroken == null) p.protectionBroken = !!p.isBot;
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
  }
  if (!world.islands.some((i) => i.ownerId == null)) {
    for (let i = 0; i < 30; i++) newUnchartedIsland(world);
  }
  return world;
}

// ---------------------------------------------------------------- persistence

const DATA_DIR = path.join(__dirname, 'data');
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

module.exports = {
  SPEED, MAP_SIZE, QUEUE_MAX, TRAIN_QUEUE_MAX, PROTECTED_POINTS, RESOURCES, BUILDINGS, UNITS,
  upgradeCost, upgradeTime, productionPerHour, storageCapacity,
  islandRates, islandPoints,
  resolveIsland, resolveWorld, pendingLevel, canAfford, tryBuild,
  zeroUnits, totalUnits, unitPower, carryCapacity, trainTime, tryTrain,
  travelDuration, sendAttack, sendColonize,
  createWorld, migrateWorld, createPlayer, checkPassword,
  newIsland, newUnchartedIsland, playerIsland, playerIslands, playerPoints,
  allianceOf, createAlliance, inviteToAlliance, acceptInvite, declineInvite,
  leaveAlliance, sendMessage,
  hashPassword, loadWorld, saveWorld,
};
