// Tideholm — bot players.
// Bots are regular players (isBot: true) driven by a server-side tick.
// They use the exact same game actions as humans, so the rules stay honest.
//
// Personalities (#22): each bot rolls a persona at spawn — an archetype
// (settler / warlord / barbarian) plus a temperament vector (tempo, sleep
// phase, build biases, training mix) — so the pack spreads in speed AND
// shape instead of marching in lockstep. Doctrine in one line: most bots
// are landscape; provoked bots are vengeance; a few bots are wolves.

import { resolveIsland, resolveWorld, createPlayer, playerIslands, islandPoints } from './game.js';
import { botView, applyActions } from './brain.js';
import { brainFor } from './brains/index.js';

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
// …and per temperament, so one kind can be armed without arming the rest.
// Each defaults to the base ratio, so a world that sets only the base (every
// test, and the golden log) behaves exactly as it did. Season 6 runs the
// settlers and warlords at 18 and leaves the barbarians on 12 — which their
// persona's defenseRatio of 0.5 halves to an effective 6, unchanged, so the
// wells stay farmable. The cap still exempts raiders: a capped bot turns to
// attacking rather than turtling.
const BOT_GARRISON_BY_KIND = Object.freeze({
  settler: Number(process.env.BOT_GARRISON_SETTLER ?? BOT_GARRISON_RATIO),
  warlord: Number(process.env.BOT_GARRISON_WARLORD ?? BOT_GARRISON_RATIO),
  barbarian: Number(process.env.BOT_GARRISON_BARBARIAN ?? BOT_GARRISON_RATIO),
});
// The defence a bot will hold on this island before it stops adding more.
function garrisonCap(island, persona) {
  const ratio = BOT_GARRISON_BY_KIND[persona && persona.kind] ?? BOT_GARRISON_RATIO;
  return islandPoints(island) * ratio * ((persona && persona.defenseRatio) || 1);
}
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

const BOT_NAMES = [
  'Barnacle Bill', 'Coral Kate', 'Driftwood Dan', 'Kelpie', 'Old Wrack',
  'Pearl Diver', 'Reef Rat', 'Saltmarsh Sam', 'Skerry Jack', 'Tide Turner',
  'Gull Cry', 'Mangrove Mo', 'Nautilus Ned', 'Osprey', 'Puffin Pete',
  'Quayside Quinn', 'Rockpool Rosa', 'Seagrass Sue', 'Trawler Tom', 'Undertow',
  'Vela the Vast', 'Wavebreaker', 'Foamborn Finn', 'Lagoon Lena',
];

// ---------------------------------------------------------------- personas

// The dice. Live play rolls Math.random; a test (or a replay) hands the tick a
// seeded generator so 300 ticks give one exact action log — the tripwire for
// moving the instincts behind the brain seam without changing how bots play.
let RNG = Math.random;
function withRng(rng, fn) {
  const prev = RNG;
  if (typeof rng === 'function') RNG = rng;
  try { return fn(); } finally { RNG = prev; }
}
const rand = (lo, hi) => lo + RNG() * (hi - lo);
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
      // #39: the promised "safe farm loop", not the hardest island in the
      // world. All-sentinel training packs the most defence per point of any
      // mix, so barbarians fill only half the garrison cap other bots get.
      defenseRatio: 0.5,
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
    const j = Math.floor(RNG() * (i + 1));
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

function spawnBots(world, count, rng) {
  return withRng(rng, () => spawnBotsNow(world, count));
}
function spawnBotsNow(world, count) {
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

// One decision pass for every bot. Tempo and sleep phase are per-persona,
// so the pack no longer moves in lockstep.
function botTick(world, now, rng) {
  return withRng(rng, () => botTickNow(world, now));
}
// The numbers the classic brain is tuned with; the env knobs live here.
const TUNING = Object.freeze({ RAID_CHANCE, RAID_RANGE, MIN_RAID_POWER, BULLY_RATIO, SCOUT_CHANCE, SCOUTS_KEEP, SCOUT_PARTY,
  CONQUER_CHANCE, MIN_CONQUER_POWER, HUMAN_CONQUER_FLOOR, INTEL_MAX_AGE, RAID_EDGE, WARLORD_EDGE, GRUDGE_EDGE, MAX_BOT_ISLANDS,
  BOT_GARRISON_RATIO, BOT_GARRISON_BY_KIND, NEUTRAL });

// One decision pass for every bot: awake → tempo roll → view → decide → apply.
// The brain sees the view; what it returns goes through the same verbs a
// human has. Persona (who the bot is) stays here; thinking lives in brains/.
function botTickNow(world, now) {
  resolveWorld(world, now);
  for (const player of world.players) {
    if (!player.isBot) continue;
    const persona = personaOf(player);
    if (isAsleep(persona, now)) continue;
    if (RNG() > 0.4 * BOT_TEMPO * persona.tempo) continue;
    const brain = brainFor(persona);
    // Settle the bot's own isles first — production accrued, orders that have
    // finished delivered — so the view is as fresh as the old instincts' own
    // resolveIsland made it (a ship completing this very tick sails this tick).
    for (const island of playerIslands(world, player.id)) resolveIsland(island, now);
    const view = botView(world, player, now);
    let out;
    try {
      out = brain.decide({ view, memory: player.memory || {}, now, rng: RNG });
    } catch (err) {
      continue; // a brain's fault is its own; the tick goes on
    }
    if (out && Array.isArray(out.actions) && out.actions.length) applyActions(world, player, out.actions, now);
    if (out && out.memory && typeof out.memory === 'object') player.memory = out.memory;
  }
}

export { spawnBots, botTick, BOT_NAMES, personaOf, rollPersona, isAsleep, garrisonCap, MAX_BOT_ISLANDS, TUNING };
