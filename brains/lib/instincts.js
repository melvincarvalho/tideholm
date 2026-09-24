// The classic instincts — what Tideholm's bots have done since #22 — as a
// library every bot brain is built from:
//
//     makeBrain(overrides) → { decide({ view, memory, now, rng }) → { actions, memory } }
//
// The classic brain is makeBrain() with nothing overridden; each bot's own
// brain in brains/bots/ starts the same and overrides only what makes that
// bot different. Brains see only the view and return actions, which the tick
// applies with the same checks a player's clicks get. Everything here comes
// through ./rules.js, the one door into the game, so the library can leave
// the repo with the brains. The golden log has not moved a byte since the
// instincts first went behind the brain seam.
import {
  MAX_BOT_ISLANDS, TUNING as T, garrisonCap,
  unitPower, PROTECTED_POINTS, RESOURCES, UNITS, QUEUE_MAX, TRAIN_QUEUE_MAX,
  pendingLevel, upgradeCost, canAfford, storageCapacity, popUsed, popCap, islandPoints, trainCostAt,
} from './rules.js';

// A bot without a rolled persona (old saves, tests) thinks like the neutral one.
const personaOf = (view) => (view.me.persona && Object.keys(view.me.persona).length ? view.me.persona : T.NEUTRAL);

// ------------------------------------------------------------ the home front
// What to raise next on an isle: storage before it overflows, farm before the
// population pinches, hall within reach of the economy, then barracks, wall,
// harbour, and otherwise the weakest producer weighted by temperament.
// Never past the season's building cap (`maxLevel`, from view.rules): a pick
// at the cap falls through to the next rule, where it used to be returned and
// refused every turn — a maxed storehouse froze the whole isle (five live bot
// isles found stuck so, 2026-09-22). Below the cap every choice is as before.
// An isle whose economy is maxed raises the farm, the hall, the barracks and,
// for seafarers, the harbour; never the wall past its temperament's target,
// so no bot hardens and the barbarians' wells stay soft. Nothing left: null.
export function chooseUpgrade(isle, persona = T.NEUTRAL, maxLevel = Infinity) {
  const lvl = (k) => pendingLevel(isle, k);
  const open = (k) => lvl(k) < maxLevel;
  const pick = (k) => (open(k) ? k : null);
  const barbarian = persona.kind === 'barbarian';
  const rules = [
    () => RESOURCES.some((r) => isle.resources[r] >= storageCapacity(lvl('storehouse')) * persona.storeThresh) && 'storehouse',
    () => popUsed(isle) >= popCap(lvl('farm')) * 0.85 && 'farm',
  ];
  const minProd = Math.min(lvl('lumberyard'), lvl('quarry'), lvl('goldmine'));
  rules.push(
    () => lvl('hall') < minProd - persona.hallLag && 'hall',
    () => lvl('barracks') === 0 && minProd >= 4 && 'barracks',
    () => !barbarian && lvl('barracks') >= 1 && lvl('barracks') < 3 && minProd >= lvl('barracks') + 5 && 'barracks',
    () => lvl('barracks') >= 1 && lvl('wall') < persona.wallTarget && minProd >= lvl('wall') + 4 && 'wall',
    () => !barbarian && lvl('harbor') === 0 && lvl('barracks') >= 2 && minProd >= 6 && 'harbor',
    () => !barbarian && lvl('harbor') === 1 && lvl('barracks') >= 3 && minProd >= 8 && 'harbor',
  );
  for (const rule of rules) { const k = rule(); if (k && pick(k)) return k; }
  const producers = ['lumberyard', 'quarry', 'goldmine'].filter(open);
  producers.sort((a, b) => lvl(a) / persona.prodBias[a] - lvl(b) / persona.prodBias[b]);
  if (producers.length) return producers[0];
  const rest = ['farm', 'hall', 'barracks', ...(barbarian ? [] : ['harbor'])];
  return rest.find(open) || null;
}

function pickFromMix(mix, rng) {
  const entries = Object.entries(mix).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return 'sentinel';
  let roll = rng() * total;
  for (const [unit, w] of entries) { roll -= w; if (roll <= 0) return unit; }
  return entries[entries.length - 1][0];
}

// What an isle would train this tick, by temperament: a ship when there is
// room to grow, a flagship once the yard allows, scouts to keep the pool,
// else the garrison mix up to the garrison cap. Dice in the old order.
export function trainOrder(view, isle, persona, rng) {
  if (isle.trainQueue.length) return null;
  const seafarer = persona.kind !== 'barbarian';
  const room = view.isles.length < T.MAX_BOT_ISLANDS;
  if (seafarer && isle.buildings.harbor >= 1 && isle.units.colonyship === 0 && room && rng() < 0.25) return { key: 'colonyship', count: 1 };
  if (isle.buildings.barracks < 1) return null;
  if (seafarer && isle.buildings.harbor >= 2 && isle.buildings.barracks >= 3 && isle.units.flagship === 0 && room
      && rng() < (persona.kind === 'warlord' ? 0.15 : 0.1)) return { key: 'flagship', count: 1 };
  if (rng() > 0.5) return null;
  if (seafarer && isle.units.scout < scoutsWanted(view) && rng() < 0.35) return { key: 'scout', count: 3 };
  const unit = pickFromMix(persona.trainMix, rng);
  // the garrison cap, per temperament (settlers and warlords are armed for
  // season 6; barbarians keep their effective 6, so wells stay soft)
  if (unit !== 'raider' && unitPower(isle.units, 'def') > garrisonCap(isle, persona)) return null;
  return { key: unit, count: persona.batch };
}

// Would the yard take this order? The same checks tryTrain makes, on the
// view, so the brain can price its own turn: a training order that lands
// changes what the isle can afford to build a moment later. Returns the cost
// on yes, null on no.
export function trainable(view, isle, key, count) {
  const unit = UNITS[key];
  if (!unit || !(count >= 1 && count <= 500)) return null;
  if ((isle.buildings[unit.building || 'barracks'] || 0) < 1) return null;
  if (isle.trainQueue.length >= TRAIN_QUEUE_MAX) return null;
  if (popUsed(isle) + (isle.popAbroad || 0) + unit.pop * count > popCap(isle.buildings.farm)) return null;
  const pos = (view.me.position || {})[key];
  const cost = trainCostAt(pos == null ? null : pos, isle, key, count);
  return canAfford(isle, cost) ? cost : null;
}

// One pass over the bot's isles, in order: train, then build with what is
// left. Works on a copy of each isle so the build sees the training order's
// bill, exactly as the old instincts saw the world after tryTrain.
export function homeFront(view, rng) {
  const persona = personaOf(view);
  const actions = [];
  for (const orig of view.isles) {
    const isle = JSON.parse(JSON.stringify(orig));
    const order = trainOrder(view, isle, persona, rng);
    if (order) {
      actions.push({ verb: 'train', from: isle.id, key: order.key, count: order.count });
      const cost = trainable(view, isle, order.key, order.count);
      if (cost) { for (const r of RESOURCES) isle.resources[r] -= cost[r]; isle.trainQueue.push({ unit: order.key, count: order.count }); }
    }
    if (isle.queue.length >= QUEUE_MAX) continue;
    const key = chooseUpgrade(isle, persona, (view.rules && view.rules.maxBuildingLevel) || Infinity);
    if (!key) continue; // everything worth raising is at the cap
    const cost = upgradeCost(key, pendingLevel(isle, key) + 1);
    if (!canAfford(isle, cost)) continue; // save up
    actions.push({ verb: 'build', from: isle.id, key });
  }
  return actions;
}

// ------------------------------------------------------------ targets
// Morale the bot expects against an owner: bullying the small blunts you.
function moraleEst(view, ownerPoints) {
  const mine = view.me.points;
  if (mine > ownerPoints && ownerPoints > 0) return Math.max(0.3, Math.sqrt(ownerPoints / mine));
  return 1;
}
// The one target picker the war instincts share, on the view. Grudges pull,
// distance and size push; a raid needs fresh intel showing a beatable isle,
// a scouting party goes where the book is blank. The bully band paces
// UNPROVOKED aggression: no punching up or down past BULLY_RATIO in points —
// except for wolves, grudges, and a raid at a target already known to be soft.
export function pickTarget(view, from, myPower, now, mode) {
  const persona = view.me.persona || {};
  const wolf = persona.kind === 'warlord';
  const myPoints = view.me.points;
  let best = null, bestScore = -Infinity;
  for (const island of view.map) {
    if (island.ownerId == null) continue;
    const dist = Math.hypot(island.x - from.x, island.y - from.y);
    if (dist > T.RAID_RANGE) continue;
    if (island.protected) continue;                      // beginners + fresh humans
    const ownerPoints = island.ownerPoints;
    const grudge = view.grudges[island.ownerId] || 0;
    const known = view.intel[island.id];
    const fresh = known && now - known.time < T.INTEL_MAX_AGE;
    const edge = wolf ? T.WARLORD_EDGE : grudge > 0 ? T.GRUDGE_EDGE : T.RAID_EDGE;
    const beatable = fresh && myPower && known.def * edge < myPower * moraleEst(view, ownerPoints);
    const upExempt = wolf || grudge > 0 || (mode === 'raid' && beatable);
    if (!upExempt && ownerPoints > myPoints * T.BULLY_RATIO) continue; // don't poke giants
    if (grudge <= 0 && ownerPoints * T.BULLY_RATIO < myPoints) continue; // don't stomp the small
    if (mode === 'raid') {
      if (fresh && !beatable) continue;
      if (!fresh && !grudge) continue;
    } else if (mode === 'scout' && fresh) {
      continue; // already know this one
    }
    let score = grudge * 50 - dist * 2 - ownerPoints / 20;
    if (mode === 'raid' && fresh) score -= known.def / 10; // softest known target
    if (score > bestScore) { bestScore = score; best = island; }
  }
  return best;
}

// The raiding party an isle can field: raiders and half the spearmen.
// Sentinels always stay home.
export function raidArmy(isle) {
  return { raider: isle.units.raider || 0, spearman: Math.floor((isle.units.spearman || 0) / 2) };
}

// A raid: from the isle with the strongest party, at the softest beatable
// known target (or a grudge, intel or no intel). One die: RAID_CHANCE, twice
// that for warlords. Barbarians never attack. The action carries `grudgeOn`:
// the owner it was aimed at, so the brain can settle one score when it sails.
export function raid(view, rng, now) {
  const persona = view.me.persona || {};
  if (persona.kind === 'barbarian') return [];
  const chance = T.RAID_CHANCE * (persona.kind === 'warlord' ? 2 : 1);
  if (rng() > chance) return [];
  if (!view.isles.length) return [];
  const from = view.isles.reduce((a, b) => unitPower(raidArmy(a), 'atk') >= unitPower(raidArmy(b), 'atk') ? a : b);
  const army = raidArmy(from);
  const power = unitPower(army, 'atk');
  if (power < T.MIN_RAID_POWER) return []; // still mustering
  const target = pickTarget(view, from, power, now, 'raid');
  if (!target) return [];
  return [{ verb: 'attack', from: from.id, to: target.id, units: army, grudgeOn: target.ownerId }];
}

// A conquest campaign: a flagship, a real escort, and a target it can bully —
// but never a small human's home. The loyalty engine does the rest; repeated
// campaigns wear a target down to capture. Warlords hunt above their weight;
// settlers only fight downhill. Fresh intel is required: nobody sails a
// flagship blind. One die: CONQUER_CHANCE, twice that for warlords.
export function conquer(view, rng, now) {
  const persona = view.me.persona || {};
  if (persona.kind === 'barbarian') return [];
  const wolf = persona.kind === 'warlord';
  if (rng() > T.CONQUER_CHANCE * (wolf ? 2 : 1)) return [];
  if (view.isles.length >= T.MAX_BOT_ISLANDS) return [];
  const from = view.isles.find((i) => (i.units.flagship || 0) >= 1);
  if (!from) return [];
  const army = { ...raidArmy(from), flagship: 1 };
  const power = unitPower(army, 'atk');
  if (power < T.MIN_CONQUER_POWER) return [];
  const myPoints = view.me.points;
  const edge = wolf ? T.WARLORD_EDGE : T.RAID_EDGE;
  let best = null, bestDist = Infinity;
  for (const island of view.map) {
    if (island.ownerId == null) continue;
    const dist = Math.hypot(island.x - from.x, island.y - from.y);
    if (dist > T.RAID_RANGE) continue;
    if (island.protected) continue;                                   // beginners + fresh humans
    const ownerPoints = island.ownerPoints;
    if (ownerPoints < PROTECTED_POINTS * 2) continue;                 // no stomping the small
    if (!island.ownerIsBot && ownerPoints < T.HUMAN_CONQUER_FLOOR) continue;
    if (!wolf && ownerPoints > myPoints) continue;                    // settlers fight downhill
    const known = view.intel[island.id];
    if (!known || now - known.time >= T.INTEL_MAX_AGE) continue;
    if (known.def * edge >= power * moraleEst(view, ownerPoints)) continue;
    if (dist < bestDist) { bestDist = dist; best = island; }
  }
  return best ? [{ verb: 'attack', from: from.id, to: best.id, units: army }] : [];
}

// Reconnaissance: a few scouts at a raid-worthy isle the book is blank on.
// One die: SCOUT_CHANCE. Barbarians keep no scouts and send none.
export function scout(view, rng, now) {
  if ((view.me.persona || {}).kind === 'barbarian') return [];
  if (rng() > T.SCOUT_CHANCE) return [];
  const from = view.isles.find((i) => i.units.scout >= 3);
  if (!from) return [];
  // a screen that caught even the biggest party is let be for a day
  const open = { ...view, map: view.map.filter((i) => !((screenFor(view, i.id) || {}).until > now)) };
  const target = pickTarget(open, from, 0, now, 'scout');
  if (!target) return [];
  const screen = screenFor(view, target.id);
  if (screen && from.units.scout < screen.size) return []; // raising a bigger party first
  return [{ verb: 'scout', from: from.id, to: target.id, count: screen ? screen.size : Math.min(from.units.scout, T.SCOUT_PARTY) }];
}

// A seafaring bot with a colony ship in stock and room to grow sends it to
// the nearest uncharted isle. No dice: the first isle with a ship sails.
export function colonize(view) {
  if ((view.me.persona || {}).kind === 'barbarian') return [];
  if (view.isles.length >= MAX_BOT_ISLANDS) return [];
  for (const isle of view.isles) {
    if (!(isle.units.colonyship >= 1)) continue;
    let best = null, bestDist = Infinity;
    for (const target of view.map) {
      if (target.ownerId != null) continue;
      const dist = Math.hypot(target.x - isle.x, target.y - isle.y);
      if (dist < bestDist) { bestDist = dist; best = target; }
    }
    return best ? [{ verb: 'colonize', from: isle.id, to: best.id }] : [];
  }
  return [];
}

// ------------------------------------------------------------ grudges
// A grudge is this brain's own memory (#185). The view says who attacked us,
// each landing numbered; every one not yet seen is a score against the
// attacker. A raid launched at a grudge settles one score — counted when it
// sails, since a brain does not see whether it arrived.
export function remember(view, memory = {}) {
  const grudges = { ...(memory.grudges || {}) };
  let attackSeen = memory.attackSeen || 0;
  for (const f of view.attacked || []) {
    if (f.seq <= attackSeen) continue;
    grudges[f.by] = (grudges[f.by] || 0) + 1;
    attackSeen = f.seq;
  }
  return { ...memory, grudges, attackSeen, ...rememberScreens(view, memory) };
}

// Scout screens. The engine catches every scout when the defender keeps as
// many on guard, and a caught party brings no news — so a bot that sent six
// into a screen of twelve (or twenty) sent six more next turn, forever: Coral
// Kate spent some 1,700 scouts a day on philloster's screen. Now a party that
// lands without fresh intel marks a screen, and the next party to that isle is
// twice the size (6, 12, 24, up to SCOUT_PARTY_MAX); the scout pool is raised
// to match; a screen that catches even that is let be for a day.
const SCOUT_PARTY_MAX = 48;
const SCREEN_GIVE_UP = 24 * 3600e3;
const SCREEN_FORGET = 48 * 3600e3;
function rememberScreens(view, memory) {
  const now = view.now;
  const scouting = { ...(memory.scouting || {}) };
  const screens = { ...(memory.screens || {}) };
  const atSea = new Set((view.moves || []).map((m) => m.id));
  for (const m of view.moves || []) {
    if (m.type === 'scout' && !scouting[m.id]) scouting[m.id] = { to: m.toId, arrive: m.arrive, sent: m.units.scout || 0 };
  }
  for (const [id, o] of Object.entries(scouting)) {
    if (atSea.has(Number(id)) || now < o.arrive) continue;
    delete scouting[id];
    const k = view.intel[o.to];
    if (k && k.time >= o.arrive - 1000) continue; // got through
    screens[o.to] = o.sent >= SCOUT_PARTY_MAX
      ? { size: SCOUT_PARTY_MAX, at: o.arrive, until: o.arrive + SCREEN_GIVE_UP }
      : { size: Math.min(SCOUT_PARTY_MAX, Math.max(2 * o.sent, T.SCOUT_PARTY)), at: o.arrive };
  }
  for (const [id, sc] of Object.entries(screens)) if (now - sc.at > SCREEN_FORGET) delete screens[id];
  return { scouting, screens };
}
const screenFor = (view, isleId) => (view.screens || {})[isleId];
// The biggest party a live screen calls for: the scout pool is kept that deep.
const scoutsWanted = (view) => Math.max(T.SCOUTS_KEEP,
  ...Object.values(view.screens || {}).filter((sc) => !(sc.until > view.now)).map((sc) => sc.size));
export function settle(memory, ownerId) {
  const g = memory.grudges;
  if (ownerId == null || !g || !g[ownerId]) return;
  g[ownerId] -= 1;
  if (g[ownerId] <= 0) delete g[ownerId];
}

// One turn. Every instinct reasons from the same view, taken before any of
// them acts, and the dice are rolled in a fixed order: the home front, then
// scouting, raiding, conquest and colonising. The tick applies the actions in
// that order too, so a raid that takes the raiders leaves conquest to find
// out the way a player would — the send fails, and the next action still runs.
// A brain from the instincts. `overrides` replaces any of the five turn
// instincts — homeFront, scout, raid, conquer, colonize — each with the same
// signature; the turn keeps its order, so the dice fall as they always have.
const TURN = { homeFront, scout, raid, conquer, colonize };
export function makeBrain(overrides = {}) {
  for (const k of Object.keys(overrides)) {
    if (!(k in TURN)) throw new Error(`makeBrain: no instinct called "${k}"`);
  }
  const I = { ...TURN, ...overrides };
  return {
    decide({ view, memory, now, rng }) {
      const mem = remember(view, memory);
      const seen = { ...view, grudges: mem.grudges, screens: mem.screens }; // what the instincts reason from
      const actions = [];
      actions.push(...I.homeFront(seen, rng));
      actions.push(...I.scout(seen, rng, now));
      const raids = I.raid(seen, rng, now);
      if (raids[0]) settle(mem, raids[0].grudgeOn);
      actions.push(...raids);
      actions.push(...I.conquer(seen, rng, now));
      actions.push(...I.colonize(seen));
      return { actions, memory: mem };
    },
  };
}
