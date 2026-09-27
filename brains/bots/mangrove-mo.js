// Mangrove Mo's brain. Classic, except that he never raids blind. A classic
// grudge lets a bot raid with no fresh intel at all, so it can throw a party
// into walls it could never break. Mo's raids only pick targets his scouts
// have seen in the last 12 hours and found beatable; a grudge still pulls
// him toward an owner, and his scouts go there first. Same dice as classic.
import { makeBrain, raid } from '../lib/instincts.js';
import { TUNING as T } from '../lib/rules.js';

export const name = 'mangrove-mo';
export const diverged = true; // no longer identical to classic

export const seenOnly = (view, now) => ({
  ...view,
  map: view.map.filter((i) => { const k = view.intel[i.id]; return k && now - k.time < T.INTEL_MAX_AGE; }),
});

export const { decide } = makeBrain({
  raid: (view, rng, now) => raid(seenOnly(view, now), rng, now),
});
