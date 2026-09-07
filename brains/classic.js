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
import { instincts } from '../bots.js';

export const name = 'classic';

export function decide({ view, memory, now, rng }, escape) {
  const actions = [];
  if (escape && escape.world && escape.bot) {
    // — not yet moved: the old path, verbatim, in the old order —
    instincts.legacyTick(escape.world, escape.bot, now);
  }
  return { actions, memory };
}
