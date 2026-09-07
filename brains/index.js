// The brain registry: a name on the persona → a module with `decide`.
// Built-in brains live here; external ones (a later step) are imported at
// boot by path and registered under their name. Unknown names fall back to
// classic so a typo in a persona never silences a bot.
import * as classic from './classic.js';

const brains = new Map([[classic.name, classic]]);

export function registerBrain(name, mod) {
  if (!mod || typeof mod.decide !== 'function') throw new Error(`brain "${name}" has no decide()`);
  brains.set(name, mod);
}
export function brainFor(persona) {
  const want = persona && persona.brain;
  return brains.get(want) || classic;
}
export function brainNames() { return [...brains.keys()]; }
