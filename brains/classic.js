// The classic brain — the instincts Tideholm's bots have had since #22,
// behind the brain contract:
//
//     decide({ view, memory, now, rng }, escape) → { actions, memory }
//
// MIGRATION SHIM. Today every instinct still reads the world directly, so the
// tick hands this brain an `escape` — { world, bot } — for exactly as long as
// it takes to move the instincts onto the view one at a time (colonize first,
// then scout, train, build, raid, conquer). An instinct that has moved uses
// only `view` and returns actions; one that has not is called through the
// escape and acts on the world itself, returning nothing. The golden log in
// tests.js must not move a byte at any point. When the last instinct has
// moved, `escape` goes, and this file is a brain like any other.
import { instincts, MAX_BOT_ISLANDS, TUNING as T } from '../bots.js';
import { applyActions } from '../brain.js';
import { unitPower, PROTECTED_POINTS } from '../game.js';

export const name = 'classic';

// Instincts that have moved onto the view. Each is a pure function of the
// view (and the dice) returning actions. During migration the old tick calls
// a moved instinct through a hook at its old slot, so every die is rolled in
// the old order and every action lands where it used to; colonize, always
// last, is simply appended after.
const MOVED = new Set(['colonize', 'scout', 'raid', 'conquer']);

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
// a raid that lands settles one score with that owner — the caller applies
// that on success, since a brain does not see results until the next tick.
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
  const target = pickTarget(view, from, 0, now, 'scout');
  if (!target) return [];
  return [{ verb: 'scout', from: from.id, to: target.id, count: Math.min(from.units.scout, T.SCOUT_PARTY) }];
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

export function decide({ view, memory, now, rng }, escape) {
  const actions = [];
  if (escape && escape.world && escape.bot) {
    // — not yet moved: the old path, verbatim, in the old order, minus what has moved —
    const hooks = {
      scout: () => applyActions(escape.world, escape.bot, scout(view, rng, now), now),
      conquer: () => applyActions(escape.world, escape.bot, conquer(view, rng, now), now),
      raid: () => {
        const acts = raid(view, rng, now);
        const res = applyActions(escape.world, escape.bot, acts, now);
        // one raid that lands settles one score (the old code read the result too)
        const a = acts[0], r = res[0], g = escape.bot.grudges;
        if (a && r && !r.error && g && g[a.grudgeOn]) { g[a.grudgeOn] -= 1; if (g[a.grudgeOn] <= 0) delete g[a.grudgeOn]; }
      },
    };
    instincts.legacyTick(escape.world, escape.bot, now, MOVED, hooks);
  }
  actions.push(...colonize(view));
  return { actions, memory };
}
