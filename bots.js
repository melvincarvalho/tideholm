// Tideholm — bot players.
// Bots are regular players (isBot: true) driven by a server-side tick.
// They use the exact same game actions as humans, so the rules stay honest.
//
// Personalities (#22): each bot rolls a persona at spawn — an archetype
// (settler / warlord / barbarian) plus a temperament vector (tempo, sleep
// phase, build biases, training mix) — so the pack spreads in speed AND
// shape instead of marching in lockstep. Doctrine in one line: most bots
// are landscape; provoked bots are vengeance; a few bots are wolves.

import { BUILDINGS, UNITS, RESOURCES, QUEUE_MAX, resolveIsland, resolveWorld, tryBuild,
        tryTrain, pendingLevel, upgradeCost, canAfford, storageCapacity,
        popUsed, popCap, unitPower, sendAttack, sendColonize, sendScout,
        createPlayer, playerIsland, playerIslands, playerPoints, islandPoints,
        isProtected, PROTECTED_POINTS, MORALE_FLOOR, BOT_MORALE_FLOOR } from './game.js';

// Tuning knobs for bot aggression.
const RAID_CHANCE = 0.12;        // per bot per tick, once armed (warlords: 2x)
const RAID_RANGE = 15;           // max fields to a raid target
const MIN_RAID_POWER = 150;      // don't sail with a token force
const BULLY_RATIO = Number(process.env.BULLY_RATIO ?? 3); // no punching up OR down past this points ratio
// Bot garrison cap (#7): once an island's standing defensive-unit power
// exceeds its building points × this ratio, the bot stops piling on more
// defence — so bots don't turtle to unbeatable fortresses far above their
// economy. Default Infinity = uncapped (prior behavior); set e.g. 12 to enable.
const BOT_GARRISON_RATIO = Number(process.env.BOT_GARRISON_RATIO ?? Infinity);
const MAX_BOT_ISLANDS = 3;
const SCOUT_CHANCE = 0.25;        // per bot per tick — intel drives everything
const SCOUTS_KEEP = 12;           // standing scout pool per island
const SCOUT_PARTY = 6;            // scouts per mission
const CONQUER_CHANCE = 0.06;      // per bot per tick, once a flagship is ready
const MIN_CONQUER_POWER = 600;    // don't sail a flagship with a token escort
const HUMAN_CONQUER_FLOOR = 150;  // never run conquest campaigns vs small humans
const INTEL_MAX_AGE = 12 * 3600 * 1000; // intel goes stale after 12h
const RAID_EDGE = 1.3;            // required advantage over known defense
const WARLORD_EDGE = 1.0;         // wolves accept a fair fight
const GRUDGE_EDGE = 1.0;          // so does vengeance
// Global tempo multiplier on every bot's act-chance (persona tempo stacks).
const BOT_TEMPO = Number(process.env.BOT_TEMPO ?? 1);
// Archetype mix for a fresh world, e.g. "settler:15,warlord:2,barbarian:3".
const BOT_PERSONAS = String(process.env.BOT_PERSONAS || 'settler:15,warlord:2,barbarian:3');

// Expected morale factor if this bot attacks that owner (mirrors the engine).
// The floor depends on whether the DEFENDER is a bot, exactly as in combat —
// a world running BOT_MORALE_FLOOR=1 must not have its bots plan against 0.3.
function moraleEst(world, bot, ownerId) {
  const mine = playerPoints(world, bot.id);
  const theirs = playerPoints(world, ownerId);
  if (mine > theirs && theirs > 0) {
    const owner = world.players.find((p) => p.id === ownerId);
    const floor = owner && owner.isBot ? BOT_MORALE_FLOOR : MORALE_FLOOR;
    return Math.max(floor, Math.sqrt(theirs / mine));
  }
  return 1;
}

const BOT_NAMES = [
  'Barnacle Bill', 'Coral Kate', 'Driftwood Dan', 'Kelpie', 'Old Wrack',
  'Pearl Diver', 'Reef Rat', 'Saltmarsh Sam', 'Skerry Jack', 'Tide Turner',
  'Gull Cry', 'Mangrove Mo', 'Nautilus Ned', 'Osprey', 'Puffin Pete',
  'Quayside Quinn', 'Rockpool Rosa', 'Seagrass Sue', 'Trawler Tom', 'Undertow',
  'Vela the Vast', 'Wavebreaker', 'Foamborn Finn', 'Lagoon Lena',
];

// ---------------------------------------------------------------- personas

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

// Legacy/neutral persona: exactly the pre-#22 behavior. Bots created outside
// spawnBots (tests, old saves) behave as before via this accessor.
const NEUTRAL = Object.freeze({
  kind: 'settler', tempo: 1, sleepStart: 0, sleepLen: 0,
  prodBias: Object.freeze({ lumberyard: 1, quarry: 1, goldmine: 1 }),
  storeThresh: 0.9, wallTarget: 4, hallLag: 1,
  trainMix: Object.freeze({ sentinel: 45, spearman: 30, raider: 25 }),
  batch: 3,
});

function personaOf(bot) {
  return bot.persona || NEUTRAL;
}

function rollPersona(kind) {
  const jitter = (base) => Math.round(base * rand(0.6, 1.4));
  const common = {
    kind,
    sleepStart: randInt(0, 23),
    prodBias: {
      lumberyard: rand(0.7, 1.3),
      quarry: rand(0.7, 1.3),
      goldmine: rand(0.7, 1.3),
    },
    storeThresh: rand(0.7, 0.95),
    hallLag: randInt(1, 3),
  };
  if (kind === 'warlord') {
    return {
      ...common,
      tempo: rand(0.9, 1.15),
      sleepLen: randInt(5, 7),
      wallTarget: randInt(1, 3),
      trainMix: { sentinel: jitter(20), spearman: jitter(25), raider: jitter(55) },
      batch: randInt(3, 5),
    };
  }
  if (kind === 'barbarian') {
    return {
      ...common,
      tempo: rand(0.3, 0.5),
      sleepLen: randInt(8, 10),
      wallTarget: randInt(1, 2),
      trainMix: { sentinel: 1, spearman: 0, raider: 0 },
      batch: randInt(1, 2),
      hallLag: randInt(2, 3),
    };
  }
  return {
    ...common,
    tempo: rand(0.5, 1.0),
    sleepLen: randInt(7, 9),
    wallTarget: randInt(2, 6),
    trainMix: { sentinel: jitter(45), spearman: jitter(30), raider: jitter(25) },
    batch: randInt(2, 5),
  };
}

// "settler:15,warlord:2,barbarian:3" -> shuffled deck of kinds.
function personaDeck(count) {
  const deck = [];
  for (const part of BOT_PERSONAS.split(',')) {
    const [kind, n] = part.split(':').map((s) => s.trim());
    if (!['settler', 'warlord', 'barbarian'].includes(kind)) continue;
    for (let i = 0; i < (Number(n) || 0); i++) deck.push(kind);
  }
  if (!deck.length) deck.push('settler');
  while (deck.length < count) deck.push('settler');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, count);
}

// A bot sleeps ~a third of the day at its own phase — milestones desync,
// and a raid timed to a sleeping wolf goes unanswered until dawn.
function isAsleep(persona, now) {
  if (!persona.sleepLen) return false;
  const hour = new Date(now).getUTCHours();
  return ((hour - persona.sleepStart + 24) % 24) < persona.sleepLen;
}

function pickFromMix(mix) {
  const entries = Object.entries(mix).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return 'sentinel';
  let roll = Math.random() * total;
  for (const [unit, w] of entries) {
    roll -= w;
    if (roll <= 0) return unit;
  }
  return entries[entries.length - 1][0];
}

function spawnBots(world, count) {
  const deck = personaDeck(count);
  let spawned = 0;
  for (const name of BOT_NAMES) {
    if (spawned >= count) break;
    const res = createPlayer(world, name, null, true);
    if (res.player) {
      res.player.persona = rollPersona(deck[spawned]);
      spawned++;
    }
  }
  return spawned;
}

// ---------------------------------------------------------------- economy

// Pick what a bot wants to upgrade next, using pending levels so the
// queue is taken into account. Temperament shapes every threshold.
function chooseUpgrade(island, persona = NEUTRAL) {
  const lvl = (k) => pendingLevel(island, k);
  const cap = storageCapacity(lvl('storehouse'));

  // Nearly full storage? Expand it (hoarders act early, hand-to-mouth late).
  if (RESOURCES.some((r) => island.resources[r] >= cap * persona.storeThresh)) return 'storehouse';

  // Room to breathe: expand the farm before the population pinches.
  if (popUsed(island) >= popCap(lvl('farm')) * 0.85) return 'farm';

  // Keep the hall within reach of the economy.
  const minProd = Math.min(lvl('lumberyard'), lvl('quarry'), lvl('goldmine'));
  if (lvl('hall') < minProd - persona.hallLag) return 'hall';

  const barbarian = persona.kind === 'barbarian';

  // Once the economy is rolling, get a barracks and grow it slowly.
  // Barbarians keep a token barracks at most — they are farmland, not threats.
  if (lvl('barracks') === 0 && minProd >= 4) return 'barracks';
  if (!barbarian && lvl('barracks') >= 1 && lvl('barracks') < 3 && minProd >= lvl('barracks') + 5) return 'barracks';

  // A wall to taste: some bots fortify, some barely bother.
  if (lvl('barracks') >= 1 && lvl('wall') < persona.wallTarget && minProd >= lvl('wall') + 4) return 'wall';

  // A harbor opens the way to expansion — and level 2 to conquest.
  // Barbarians never take to the sea.
  if (!barbarian && lvl('harbor') === 0 && lvl('barracks') >= 2 && minProd >= 6) return 'harbor';
  if (!barbarian && lvl('harbor') === 1 && lvl('barracks') >= 3 && minProd >= 8) return 'harbor';

  // Otherwise raise the weakest producer, weighted by temperament: a bot
  // with a timber bias runs its lumberyard hot and its quarry lean.
  const producers = ['lumberyard', 'quarry', 'goldmine'];
  producers.sort((a, b) => lvl(a) / persona.prodBias[a] - lvl(b) / persona.prodBias[b]);
  return producers[0];
}

// Bots keep a standing garrison shaped by temperament — and the seafaring
// kinds save for ships when there is room to grow.
function maybeTrain(world, bot, island, now) {
  const persona = personaOf(bot);
  if (island.trainQueue.length) return;
  const seafarer = persona.kind !== 'barbarian';
  if (seafarer && island.buildings.harbor >= 1 &&
      island.units.colonyship === 0 &&
      playerIslands(world, bot.id).length < MAX_BOT_ISLANDS &&
      Math.random() < 0.25) {
    tryTrain(world, island, 'colonyship', 1, now);
    return; // whether or not it could afford one, it's saving up
  }
  if (island.buildings.barracks < 1) return;
  // A capable bot saves for a flagship and dreams of conquest.
  if (seafarer && island.buildings.harbor >= 2 && island.buildings.barracks >= 3 &&
      island.units.flagship === 0 &&
      playerIslands(world, bot.id).length < MAX_BOT_ISLANDS &&
      Math.random() < (persona.kind === 'warlord' ? 0.15 : 0.1)) {
    tryTrain(world, island, 'flagship', 1, now);
    return;
  }
  if (Math.random() > 0.5) return;
  // A standing scout pool for counter-espionage and reconnaissance.
  // Barbarians keep none: they are meant to be scouted and farmed.
  if (seafarer && island.units.scout < SCOUTS_KEEP && Math.random() < 0.35) {
    tryTrain(world, island, 'scout', 3, now);
    return;
  }
  const unit = pickFromMix(persona.trainMix);
  // Garrison cap: don't add defensive units (sentinel/spearman) once this
  // island is already well-defended for its size. Raiders (offensive) are
  // exempt, so a capped bot shifts toward attacking rather than turtling.
  if (unit !== 'raider'
      && unitPower(island.units, 'def') > islandPoints(island) * BOT_GARRISON_RATIO) {
    return;
  }
  tryTrain(world, island, unit, persona.batch, now); // silently skips if unaffordable
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

// mode 'raid': targets the army can beat. mode 'scout': targets we lack
// fresh intel on. The bully band paces UNPROVOKED aggression only — three
// sanctioned exceptions pierce it (#22):
//   - warlords ignore the band entirely (wolves),
//   - a grudge ignores the band AND the intel requirement (vengeance is
//     rash: you hit me, I hit back, whoever you are),
//   - fresh intel showing a beatable island overrides the band (a soft
//     colony is fair game no matter how big its owner).
function pickRaidTarget(world, bot, from, myPower, now, mode) {
  const persona = personaOf(bot);
  const wolf = persona.kind === 'warlord';
  const myPoints = playerPoints(world, bot.id);
  const grudges = bot.grudges || {};
  const intel = bot.intel || {};
  let best = null;
  let bestScore = -Infinity;
  for (const island of world.islands) {
    if (island.ownerId == null || island.ownerId === bot.id) continue;
    const dist = Math.hypot(island.x - from.x, island.y - from.y);
    if (dist > RAID_RANGE) continue;
    const owner = world.players.find((p) => p.id === island.ownerId);
    if (isProtected(world, owner, now)) continue;       // beginners + fresh humans
    const ownerPoints = playerPoints(world, island.ownerId);
    const grudge = grudges[island.ownerId] || 0;
    const known = intel[island.id];
    const fresh = known && now - known.time < INTEL_MAX_AGE;
    const edge = wolf ? WARLORD_EDGE : grudge > 0 ? GRUDGE_EDGE : RAID_EDGE;
    const beatable = fresh && myPower
      && known.def * edge < myPower * moraleEst(world, bot, island.ownerId);
    // The exceptions open the band UPWARD only — wolves hunt above their
    // weight and soft colonies of giants are fair game. Downward, the
    // "don't stomp the small" guard yields to nothing but vengeance.
    const upExempt = wolf || grudge > 0 || (mode === 'raid' && beatable);
    if (!upExempt && ownerPoints > myPoints * BULLY_RATIO) continue; // don't poke giants
    if (grudge <= 0 && ownerPoints * BULLY_RATIO < myPoints) continue; // don't stomp the small
    if (mode === 'raid') {
      // Measured targets must be beatable; unmeasured ones only fall to vengeance.
      if (fresh && !beatable) continue;
      if (!fresh && !grudge) continue;
    } else if (mode === 'scout' && fresh) {
      continue; // already know this one
    }
    // Prefer whoever wronged us, then close and weak.
    let score = grudge * 50 - dist * 2 - ownerPoints / 20;
    if (mode === 'raid' && fresh) score -= known.def / 10; // softest known target
    if (score > bestScore) {
      bestScore = score;
      best = island;
    }
  }
  return best;
}

function maybeRaid(world, bot, now) {
  const persona = personaOf(bot);
  if (persona.kind === 'barbarian') return; // never attacks, never retaliates
  const chance = RAID_CHANCE * (persona.kind === 'warlord' ? 2 : 1);
  if (Math.random() > chance) return;
  const islands = playerIslands(world, bot.id);
  if (!islands.length) return;
  // Stage from the island with the strongest raiding party.
  const from = islands.reduce((a, b) =>
    unitPower(raidArmy(a), 'atk') >= unitPower(raidArmy(b), 'atk') ? a : b);
  const army = raidArmy(from);
  const power = unitPower(army, 'atk');
  if (power < MIN_RAID_POWER) return; // still mustering
  const target = pickRaidTarget(world, bot, from, power, now, 'raid');
  if (!target) return;
  const result = sendAttack(world, bot, from, target, army, now);
  if (!result.error && bot.grudges && bot.grudges[target.ownerId]) {
    bot.grudges[target.ownerId] -= 1; // one raid settles one score
    if (bot.grudges[target.ownerId] <= 0) delete bot.grudges[target.ownerId];
  }
}

// Reconnaissance: send a few scouts at raid-worthy targets to build intel.
function maybeScout(world, bot, now) {
  if (personaOf(bot).kind === 'barbarian') return;
  if (Math.random() > SCOUT_CHANCE) return;
  const islands = playerIslands(world, bot.id);
  const from = islands.find((i) => i.units.scout >= 3);
  if (!from) return;
  const target = pickRaidTarget(world, bot, from, 0, now, 'scout');
  if (!target) return;
  sendScout(world, bot, from, target, Math.min(from.units.scout, SCOUT_PARTY), now);
}

// Conquest campaigns: a flagship, a real escort, and a target it can bully —
// but never a small human's home. The loyalty engine does the rest; repeated
// campaigns wear a target down to capture. Warlords hunt above their weight.
function maybeConquer(world, bot, now) {
  const persona = personaOf(bot);
  if (persona.kind === 'barbarian') return;
  const wolf = persona.kind === 'warlord';
  if (Math.random() > CONQUER_CHANCE * (wolf ? 2 : 1)) return;
  if (playerIslands(world, bot.id).length >= MAX_BOT_ISLANDS) return;
  const from = playerIslands(world, bot.id).find((i) => i.units.flagship >= 1);
  if (!from) return;
  const army = raidArmy(from);
  army.flagship = 1;
  if (unitPower(army, 'atk') < MIN_CONQUER_POWER) return;
  const myPoints = playerPoints(world, bot.id);
  const power = unitPower(army, 'atk');
  const intel = bot.intel || {};
  const edge = wolf ? WARLORD_EDGE : RAID_EDGE;
  let best = null;
  let bestDist = Infinity;
  for (const island of world.islands) {
    if (island.ownerId == null || island.ownerId === bot.id) continue;
    const dist = Math.hypot(island.x - from.x, island.y - from.y);
    if (dist > RAID_RANGE) continue;
    const owner = world.players.find((p) => p.id === island.ownerId);
    if (isProtected(world, owner, now)) continue;        // beginners + fresh humans
    const ownerPoints = playerPoints(world, island.ownerId);
    if (ownerPoints < PROTECTED_POINTS * 2) continue;    // no stomping the small
    if (owner && !owner.isBot && ownerPoints < HUMAN_CONQUER_FLOOR) continue;
    if (!wolf && ownerPoints > myPoints) continue;       // settlers fight downhill
    // Conquest fleets sail only against scouted, beatable defenses.
    const known = intel[island.id];
    if (!known || now - known.time >= INTEL_MAX_AGE) continue;
    if (known.def * edge >= power * moraleEst(world, bot, island.ownerId)) continue;
    if (dist < bestDist) { bestDist = dist; best = island; }
  }
  if (best) sendAttack(world, bot, from, best, army, now);
}

function maybeColonize(world, bot, now) {
  if (personaOf(bot).kind === 'barbarian') return;
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

// One decision pass for every bot. Tempo and sleep phase are per-persona,
// so the pack no longer moves in lockstep.
function botTick(world, now) {
  resolveWorld(world, now);
  for (const player of world.players) {
    if (!player.isBot) continue;
    const persona = personaOf(player);
    if (isAsleep(persona, now)) continue;
    if (Math.random() > 0.4 * BOT_TEMPO * persona.tempo) continue;
    for (const island of playerIslands(world, player.id)) {
      resolveIsland(island, now);
      maybeTrain(world, player, island, now);
      if (island.queue.length >= QUEUE_MAX) continue;
      const key = chooseUpgrade(island, persona);
      const cost = upgradeCost(key, pendingLevel(island, key) + 1);
      if (!canAfford(island, cost)) continue; // save up
      tryBuild(world, island, key, now);
    }
    maybeScout(world, player, now);
    maybeRaid(world, player, now);
    maybeConquer(world, player, now);
    maybeColonize(world, player, now);
  }
}

export { spawnBots, botTick, BOT_NAMES, personaOf, rollPersona, isAsleep };
