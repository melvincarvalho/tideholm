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
import { instincts, MAX_BOT_ISLANDS } from '../bots.js';

export const name = 'classic';

// Instincts that have moved onto the view. Each is a pure function of the
// view returning actions; the tick applies them after decide returns, which
// is the same place in the old order (colonize was always last).
const MOVED = new Set(['colonize']);

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
    instincts.legacyTick(escape.world, escape.bot, now, MOVED);
  }
  actions.push(...colonize(view));
  return { actions, memory };
}
