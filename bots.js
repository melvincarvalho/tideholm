// Tideholm — bot players.
// Bots are regular players (isBot: true) driven by a server-side tick.
// They use the exact same game actions as humans, so the rules stay honest.

'use strict';

const { BUILDINGS, UNITS, RESOURCES, QUEUE_MAX, resolveIsland, resolveWorld, tryBuild,
        tryTrain, pendingLevel, upgradeCost, canAfford, storageCapacity,
        popUsed, popCap, unitPower, sendAttack, sendColonize,
        createPlayer, playerIsland, playerIslands, playerPoints } = require('./game');

// Tuning knobs for bot aggression.
const RAID_CHANCE = 0.12;        // per bot per tick, once armed
const RAID_RANGE = 15;           // max fields to a raid target
const MIN_RAID_POWER = 150;      // don't sail with a token force
const SAFE_POINTS = 40;          // beginner protection: owners below this are left alone
const BULLY_RATIO = 3;           // don't attack owners more than 3x your points
const MAX_BOT_ISLANDS = 3;

const BOT_NAMES = [
  'Barnacle Bill', 'Coral Kate', 'Driftwood Dan', 'Kelpie', 'Old Wrack',
  'Pearl Diver', 'Reef Rat', 'Saltmarsh Sam', 'Skerry Jack', 'Tide Turner',
  'Gull Cry', 'Mangrove Mo', 'Nautilus Ned', 'Osprey', 'Puffin Pete',
  'Quayside Quinn', 'Rockpool Rosa', 'Seagrass Sue', 'Trawler Tom', 'Undertow',
  'Vela the Vast', 'Wavebreaker', 'Foamborn Finn', 'Lagoon Lena',
];

function spawnBots(world, count) {
  let spawned = 0;
  for (const name of BOT_NAMES) {
    if (spawned >= count) break;
    const res = createPlayer(world, name, null, true);
    if (res.player) spawned++;
  }
  return spawned;
}

// Pick what a bot wants to upgrade next, using pending levels so the
// queue is taken into account.
function chooseUpgrade(island) {
  const lvl = (k) => pendingLevel(island, k);
  const cap = storageCapacity(lvl('storehouse'));

  // Nearly full storage? Expand it.
  if (RESOURCES.some((r) => island.resources[r] >= cap * 0.9)) return 'storehouse';

  // Room to breathe: expand the farm before the population pinches.
  if (popUsed(island) >= popCap(lvl('farm')) * 0.85) return 'farm';

  // Keep the hall within reach of the economy.
  const minProd = Math.min(lvl('lumberyard'), lvl('quarry'), lvl('goldmine'));
  if (lvl('hall') < minProd - 1) return 'hall';

  // Once the economy is rolling, get a barracks and grow it slowly.
  if (lvl('barracks') === 0 && minProd >= 4) return 'barracks';
  if (lvl('barracks') >= 1 && lvl('barracks') < 3 && minProd >= lvl('barracks') + 5) return 'barracks';

  // A wall keeps the raiders honest.
  if (lvl('barracks') >= 1 && lvl('wall') < 4 && minProd >= lvl('wall') + 4) return 'wall';

  // A harbor opens the way to expansion.
  if (lvl('harbor') === 0 && lvl('barracks') >= 2 && minProd >= 6) return 'harbor';

  // Otherwise raise the lowest producer.
  const producers = ['lumberyard', 'quarry', 'goldmine'];
  producers.sort((a, b) => lvl(a) - lvl(b));
  return producers[0];
}

// Bots keep a standing garrison, weighted toward defense — and once they
// have a harbor and room to grow, they save for a colony ship.
function maybeTrain(world, bot, island, now) {
  if (island.trainQueue.length) return;
  if (island.buildings.harbor >= 1 &&
      island.units.colonyship === 0 &&
      playerIslands(world, bot.id).length < MAX_BOT_ISLANDS &&
      Math.random() < 0.25) {
    tryTrain(world, island, 'colonyship', 1, now);
    return; // whether or not it could afford one, it's saving up
  }
  if (island.buildings.barracks < 1) return;
  if (Math.random() > 0.5) return;
  // A few scouts for counter-espionage, then a defense-weighted garrison.
  if (island.units.scout < 5 && Math.random() < 0.3) {
    tryTrain(world, island, 'scout', 2, now);
    return;
  }
  const roll = Math.random();
  const unit = roll < 0.45 ? 'sentinel' : roll < 0.75 ? 'spearman' : 'raider';
  tryTrain(world, island, unit, 3, now); // silently skips if unaffordable
}

// ---------------------------------------------------------------- war

// The raiding party an island can field: raiders and half the spearmen.
// Sentinels always stay home.
function raidArmy(island) {
  return {
    raider: island.units.raider,
    spearman: Math.floor(island.units.spearman / 2),
  };
}

function pickRaidTarget(world, bot, from) {
  const myPoints = playerPoints(world, bot.id);
  const grudges = bot.grudges || {};
  let best = null;
  let bestScore = -Infinity;
  for (const island of world.islands) {
    if (island.ownerId == null || island.ownerId === bot.id) continue;
    const dist = Math.hypot(island.x - from.x, island.y - from.y);
    if (dist > RAID_RANGE) continue;
    const ownerPoints = playerPoints(world, island.ownerId);
    if (ownerPoints < SAFE_POINTS) continue;           // leave beginners alone
    if (ownerPoints > myPoints * BULLY_RATIO) continue; // don't poke giants
    // Prefer whoever wronged us, then close and weak.
    const grudge = grudges[island.ownerId] || 0;
    const score = grudge * 50 - dist * 2 - ownerPoints / 20;
    if (score > bestScore) {
      bestScore = score;
      best = island;
    }
  }
  return best;
}

function maybeRaid(world, bot, now) {
  if (Math.random() > RAID_CHANCE) return;
  const islands = playerIslands(world, bot.id);
  if (!islands.length) return;
  // Stage from the island with the strongest raiding party.
  const from = islands.reduce((a, b) =>
    unitPower(raidArmy(a), 'atk') >= unitPower(raidArmy(b), 'atk') ? a : b);
  const army = raidArmy(from);
  if (unitPower(army, 'atk') < MIN_RAID_POWER) return; // still mustering
  const target = pickRaidTarget(world, bot, from);
  if (!target) return;
  const result = sendAttack(world, bot, from, target, army, now);
  if (!result.error && bot.grudges && bot.grudges[target.ownerId]) {
    bot.grudges[target.ownerId] -= 1; // one raid settles one score
    if (bot.grudges[target.ownerId] <= 0) delete bot.grudges[target.ownerId];
  }
}

function maybeColonize(world, bot, now) {
  if (playerIslands(world, bot.id).length >= MAX_BOT_ISLANDS) return;
  for (const island of playerIslands(world, bot.id)) {
    if (island.units.colonyship < 1) continue;
    let best = null;
    let bestDist = Infinity;
    for (const target of world.islands) {
      if (target.ownerId != null) continue;
      const dist = Math.hypot(target.x - island.x, target.y - island.y);
      if (dist < bestDist) { bestDist = dist; best = target; }
    }
    if (best) sendColonize(world, bot, island, best, now);
    return;
  }
}

// One decision pass for every bot. Bots act with some probability per tick
// so they don't all move in lockstep.
function botTick(world, now) {
  resolveWorld(world, now);
  for (const player of world.players) {
    if (!player.isBot) continue;
    if (Math.random() > 0.4) continue;
    for (const island of playerIslands(world, player.id)) {
      resolveIsland(island, now);
      maybeTrain(world, player, island, now);
      if (island.queue.length >= QUEUE_MAX) continue;
      const key = chooseUpgrade(island);
      const cost = upgradeCost(key, pendingLevel(island, key) + 1);
      if (!canAfford(island, cost)) continue; // save up
      tryBuild(world, island, key, now);
    }
    maybeRaid(world, player, now);
    maybeColonize(world, player, now);
  }
}

module.exports = { spawnBots, botTick, BOT_NAMES };
