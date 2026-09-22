// The brain registry: a name on the persona → a module with `decide`.
// Built-in brains live here; external ones are imported at boot from
// BOT_BRAINS and registered under their name. Unknown names fall back to
// classic so a typo in a persona never silences a bot.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
// Built in and trusted: the classic brain runs without a time budget, which
// also keeps a seeded run exact on a slow machine.
export function isBuiltIn(mod) { return mod === classic; }

// External brains (brain seam, step 10): BOT_BRAINS="wolf=./wolves/wolf.js,
// owl=/abs/owl.js", paths relative to `base`. A module exports `decide` (or a
// default export that has one). A brain that fails to load is reported and
// skipped — the game never falls over for a guest — and no guest may take
// the classic name.
export async function loadBrains(spec, base = process.cwd()) {
  const loaded = [], failed = [];
  for (const entry of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq).trim() : '';
    const file = eq > 0 ? entry.slice(eq + 1).trim() : '';
    if (!name || !file) { failed.push({ entry, error: 'expected name=path' }); continue; }
    if (name === classic.name) { failed.push({ entry, error: 'the classic brain is built in' }); continue; }
    try {
      const mod = await import(pathToFileURL(path.resolve(base, file)).href);
      registerBrain(name, typeof mod.decide === 'function' ? mod : mod.default);
      loaded.push(name);
    } catch (err) {
      failed.push({ entry, error: err.message });
    }
  }
  return { loaded, failed };
}
