// The brain seam — what a bot may know, and how a bot may act.
//
// A brain is a pure function:
//
//     decide({ view, memory, now, rng }) → { actions, memory }
//
// `view` is built here from the world and is the ONLY thing a brain sees.
// It holds what a player at the keyboard could know: the bot's own isles in
// full; every other isle as the map shows it (owner, coordinates, protection);
// the public rankings; the bot's own ships at sea; and its own intel book and
// grudges. Never another player's stores or garrison — if this bot's scouts
// did not bring it home, it is not in the view. The view is plain JSON, so a
// brain can live in another module, another process, or another machine.
//
// `actions` (step two of the seam, applyActions) are requests in the same
// verbs a human has, validated by the same game functions. A brain cannot do
// anything a player cannot.
//
// Nothing calls botView yet: it exists so the boundary can be looked at, and
// tested, before any instinct moves behind it. See the golden log in tests.js.

import {
  playerIslands, playerPoints, islandPoints, isProtected,
  tryBuild, tryTrain, sendAttack, sendScout, sendColonize, sendSupport, withdrawSupport,
} from './game.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

// The map as anyone sees it: who holds an isle and where it is. `protected`
// is the shield the map paints; `points` are the public rankings' number.
function mapIsland(world, isl, now, pointsOf) {
  const owner = isl.ownerId == null ? null : world.players.find((p) => p.id === isl.ownerId) || null;
  return {
    id: isl.id, x: isl.x, y: isl.y, name: isl.name,
    ownerId: isl.ownerId == null ? null : isl.ownerId,
    ownerName: owner ? owner.name : null,
    ownerIsBot: !!(owner && owner.isBot),
    ownerPoints: owner ? pointsOf(owner.id) : 0,
    protected: owner ? isProtected(world, owner, now) : false,
  };
}

// One of the bot's own isles, in full — a captain sees everything at home.
function ownIsland(isl) {
  return {
    id: isl.id, x: isl.x, y: isl.y, name: isl.name,
    buildings: clone(isl.buildings), units: clone(isl.units), resources: clone(isl.resources),
    queue: clone(isl.queue || []), trainQueue: clone(isl.trainQueue || []),
    loyalty: isl.loyalty, points: islandPoints(isl),
    support: (isl.support || []).map((c) => ({ ownerId: c.ownerId, units: clone(c.units) })),
  };
}

export function botView(world, bot, now = Date.now()) {
  const cache = new Map();
  const pointsOf = (id) => { if (!cache.has(id)) cache.set(id, playerPoints(world, id)); return cache.get(id); };
  const mine = playerIslands(world, bot.id);
  const mineIds = new Set(mine.map((i) => i.id));
  return {
    now,
    hourUTC: new Date(now).getUTCHours(),
    me: { id: bot.id, name: bot.name, points: pointsOf(bot.id), persona: clone(bot.persona || {}), islands: mine.length },
    isles: mine.map(ownIsland),
    map: world.islands.filter((i) => !mineIds.has(i.id)).map((i) => mapIsland(world, i, now, pointsOf)),
    rankings: world.players
      .filter((p) => world.islands.some((i) => i.ownerId === p.id))
      .map((p) => ({ id: p.id, name: p.name, isBot: !!p.isBot, points: pointsOf(p.id), islands: playerIslands(world, p.id).length }))
      .sort((a, b) => b.points - a.points),
    moves: (world.movements || []).filter((m) => m.ownerId === bot.id).map((m) => ({
      id: m.id, type: m.type, fromId: m.fromId, toId: m.toId, units: clone(m.units), depart: m.depart, arrive: m.arrive,
    })),
    intel: clone(bot.intel || {}),
    grudges: clone(bot.grudges || {}),
    memory: clone(bot.memory || {}),
  };
}

// ---------------------------------------------------------------- the verbs
//
// An action is a request: { verb, from, to, key, count, units }. Every verb
// routes to the SAME game function a human's request reaches, with the same
// validation, so a brain can do nothing a player cannot. `from` must be one
// of the bot's own isles; `to` any isle id. Results come back one per action,
// in order — { ok } or { error } — and a failure never stops the next action.
// Unknown verbs and malformed requests are errors, not exceptions: a brain is
// a guest, and a guest's mistake must not take the tick down with it.
export const VERBS = ['build', 'train', 'attack', 'scout', 'colonize', 'support', 'withdraw'];

export function applyActions(world, bot, actions, now = Date.now()) {
  const results = [];
  if (!Array.isArray(actions)) return results;
  const mine = new Map(playerIslands(world, bot.id).map((i) => [i.id, i]));
  const isle = (id) => world.islands.find((i) => i.id === id) || null;
  for (const a of actions) {
    try {
      if (!a || typeof a !== 'object' || !VERBS.includes(a.verb)) { results.push({ error: 'err.unknownVerb' }); continue; }
      if (a.verb === 'withdraw') {
        const target = isle(a.to);
        results.push(target ? withdrawSupport(world, bot, target, now) : { error: 'err.noIsland' });
        continue;
      }
      const from = mine.get(a.from);
      if (!from) { results.push({ error: 'err.notYourIsland' }); continue; }
      switch (a.verb) {
        case 'build': results.push(tryBuild(world, from, String(a.key || ''), now)); break;
        case 'train': results.push(tryTrain(world, from, String(a.key || ''), a.count, now)); break;
        case 'attack': { const t = isle(a.to); results.push(t ? sendAttack(world, bot, from, t, a.units || {}, now) : { error: 'err.noIsland' }); break; }
        case 'scout': { const t = isle(a.to); results.push(t ? sendScout(world, bot, from, t, a.count, now) : { error: 'err.noIsland' }); break; }
        case 'colonize': { const t = isle(a.to); results.push(t ? sendColonize(world, bot, from, t, now) : { error: 'err.noIsland' }); break; }
        case 'support': { const t = isle(a.to); results.push(t ? sendSupport(world, bot, from, t, a.units || {}, now) : { error: 'err.noIsland' }); break; }
        default: results.push({ error: 'err.unknownVerb' });
      }
    } catch (err) {
      results.push({ error: 'err.brainFault', detail: String(err && err.message || err) });
    }
  }
  return results;
}
