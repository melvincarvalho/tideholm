// Gull Cry's brain. Classic, except that she digs in when she is being
// farmed: an isle that has taken SIEGE_HITS landings in the last day trains
// only sentinels, in double batches, and raises its wall SIEGE_WALL levels
// past her usual target. Still under her garrison cap and the season's
// building cap, and the dice fall exactly as classic's; an isle left alone
// for a day goes back to her usual mix.
import { makeBrain, homeFront } from '../lib/instincts.js';

export const name = 'gull-cry';
export const diverged = true; // no longer identical to classic

export const SIEGE_HITS = 3;
export const SIEGE_WINDOW = 24 * 3600e3;
export const SIEGE_WALL = 3;

export function underSiege(view, isleId) {
  const now = view.now;
  return (view.attacked || []).filter((f) => f.isle === isleId && now - f.at < SIEGE_WINDOW).length >= SIEGE_HITS;
}

export const dugIn = (persona) => ({
  ...persona,
  trainMix: { sentinel: 1 },
  batch: (persona.batch || 1) * 2,
  wallTarget: (persona.wallTarget || 0) + SIEGE_WALL,
});

export const { decide } = makeBrain({
  homeFront: (view, rng) => homeFront(view, rng, (isle, persona) => (underSiege(view, isle.id) ? dugIn(persona) : persona)),
});
