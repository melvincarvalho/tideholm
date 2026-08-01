// Tideholm — engine math tests. Run: node tests.js  (exits non-zero on failure)
// Pins the game's formulas and invariants so balance changes are deliberate.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolve against this file, not the working directory, so the suite runs from
// anywhere. game.js already does this; tests.js did not, and reading the map
// fixture broke immediately under `node path/to/tests.js` from elsewhere.
const HERE = path.dirname(fileURLToPath(import.meta.url));

process.env.GAME_SPEED = '1'; // test at classic pace; SPEED-scaling is tested explicitly
process.env.MAX_BUILDING_LEVEL = '14'; // pin it: the cap is read from env at module load
process.env.HALL_FILE = path.join(os.tmpdir(), `tideholm-hall-test-${process.pid}.json`);
const g = await import('./game.js'); // dynamic: after the env above is set
process.on('exit', () => {
  try { fs.rmSync(process.env.HALL_FILE, { force: true }); } catch { /* gone */ }
});

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (detail !== undefined ? ' — ' + detail : ''));
  }
}
function close(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)); }

const t0 = 1_800_000_000_000; // fixed epoch for determinism
const H = 3_600_000;

// ---------------------------------------------------------------- formulas

console.log('formulas');
check('upgrade cost lumberyard →2 = 93/140/16', (() => {
  const c = g.upgradeCost('lumberyard', 2);
  return c.wood === 93 && c.stone === 140 && c.gold === 16;
})());
check('cost growth is 1.55x per level', (() => {
  const c5 = g.upgradeCost('quarry', 5).wood;
  const c6 = g.upgradeCost('quarry', 6).wood;
  return close(c6 / c5, 1.55, 0.02); // ceil() wobble
})());
check('storage capacity 400*1.5^lvl (lvl1=600, lvl2=900, lvl5=3038)',
  g.storageCapacity(1) === 600 && g.storageCapacity(2) === 900 && g.storageCapacity(5) === 3038);
check('production lvl1 = base perHour at speed 1',
  close(g.productionPerHour('lumberyard', 1), 40) && close(g.productionPerHour('goldmine', 1), 18));
check('production lvl4 lumberyard = 40*4*1.12^3 ≈ 224.8',
  close(g.productionPerHour('lumberyard', 4), 40 * 4 * Math.pow(1.12, 3)));
check('level 0 produces nothing', g.productionPerHour('quarry', 0) === 0);
check('hall discounts build time 4% per level above 1', (() => {
  const base = g.upgradeTime('quarry', 5, 1);
  const disc = g.upgradeTime('quarry', 5, 6);
  return close(disc / base, Math.pow(0.96, 5), 0.02);
})());
check('build time never below 5s', g.upgradeTime('lumberyard', 1, 99) >= 5);
check('train time never below 2s', g.trainTime('spearman', 99) >= 2);

// ---------------------------------------------------------------- accrual

console.log('accrual');
function freshWorld() {
  const w = g.createWorld();
  const a = g.createPlayer(w, 'A', 'pw', false).player;
  const b = g.createPlayer(w, 'B', 'pw', false).player;
  // combat tests are about mechanics, not beginner protection — opt out here;
  // the protection tests opt back in explicitly
  a.protectionBroken = true;
  b.protectionBroken = true;
  const ia = g.playerIsland(w, a.id);
  const ib = g.playerIsland(w, b.id);
  ia.x = 0; ia.y = 0; ib.x = 0; ib.y = 5;
  return { w, a, b, ia, ib };
}

{
  const { ia } = freshWorld();
  ia.lastUpdate = t0;
  ia.buildings.storehouse = 10; // cap 23067, no clamping in this test
  ia.resources = { wood: 0, stone: 0, gold: 0 };
  // lumberyard upgrades 1→2 exactly 1h in; resolve 2h in
  ia.queue = [{ building: 'lumberyard', level: 2, finish: t0 + H }];
  g.resolveIsland(ia, t0 + 2 * H);
  const expected = g.productionPerHour('lumberyard', 1) * 1 + g.productionPerHour('lumberyard', 2) * 1;
  check('rate changes exactly at queue completion', close(ia.resources.wood, expected),
    `got ${ia.resources.wood}, want ${expected}`);
  check('building level applied', ia.buildings.lumberyard === 2);
}

{
  const { ia } = freshWorld();
  ia.lastUpdate = t0;
  g.resolveIsland(ia, t0 + 1000 * H); // six weeks
  const cap = g.storageCapacity(ia.buildings.storehouse);
  check('resources clamp exactly at capacity',
    ia.resources.wood === cap && ia.resources.stone === cap && ia.resources.gold === cap);
}

{
  const { w, ia } = freshWorld();
  ia.lastUpdate = t0;
  ia.resources = { wood: 1000, stone: 1000, gold: 1000 };
  ia.buildings.storehouse = 5;
  const before = { ...ia.resources };
  g.tryBuild(w, ia, 'quarry', t0);
  const cost = g.upgradeCost('quarry', 2);
  check('build deducts exact cost',
    close(before.wood - ia.resources.wood, cost.wood) &&
    close(before.stone - ia.resources.stone, cost.stone) &&
    close(before.gold - ia.resources.gold, cost.gold));
  g.tryBuild(w, ia, 'quarry', t0);
  const t1 = g.upgradeTime('quarry', 2, ia.buildings.hall) * 1000;
  const t2 = g.upgradeTime('quarry', 3, ia.buildings.hall) * 1000;
  check('queue items finish sequentially',
    ia.queue[0].finish === t0 + t1 && ia.queue[1].finish === t0 + t1 + t2);
  check('pendingLevel counts the queue', g.pendingLevel(ia, 'quarry') === 3);
}

{
  const { w, ia } = freshWorld();
  ia.lastUpdate = t0;
  ia.buildings.barracks = 2;
  ia.resources = { wood: 5000, stone: 5000, gold: 5000 };
  ia.buildings.storehouse = 8;
  g.tryTrain(w, ia, 'spearman', 7, t0);
  const per = g.trainTime('spearman', 2) * 1000;
  check('train batch finish = now + count*per-unit time', ia.trainQueue[0].finish === t0 + 7 * per);
  g.resolveIsland(ia, t0 + 7 * per);
  check('batch delivers exact count', ia.units.spearman === 7);
}

// ---------------------------------------------------------------- combat invariants

console.log('combat');
{
  // Sweep many matchups; invariants must hold in all of them.
  let holds = { winner: true, conserve: true, loot: true };
  for (let atk = 1; atk <= 40; atk += 3) {
    for (let def = 0; def <= 40; def += 4) {
      const { w, a, ia, ib } = freshWorld();
      ia.units.raider = atk; ia.units.spearman = atk;
      ib.units.sentinel = def;
      ib.resources = { wood: 700, stone: 500, gold: 300 };
      ib.buildings.storehouse = 5;
      const sent = { raider: atk, spearman: atk };
      const A = g.unitPower(sent, 'atk');
      const D = g.unitPower(ib.units, 'def');
      const r = g.sendAttack(w, a, ia, ib, sent, t0);
      // stock at battle time includes production during the voyage
      g.resolveIsland(ib, r.arrive);
      const stockAtBattle = ib.resources.wood + ib.resources.stone + ib.resources.gold;
      g.resolveWorld(w, r.arrive + 1);
      const ret = w.movements.find((m) => m.type === 'return');
      if (A > D) {
        if (!ret) { holds.winner = false; continue; }
        const surv = g.totalUnits(ret.units);
        if (surv < 1 || surv > atk * 2) holds.conserve = false;
        if (g.totalUnits(ib.units) !== 0) holds.conserve = false;
        const lootSum = ret.loot.wood + ret.loot.stone + ret.loot.gold;
        if (lootSum > g.carryCapacity(ret.units)) holds.loot = false;
        if (lootSum > stockAtBattle) holds.loot = false; // can't loot more than the stock
      } else {
        if (ret) holds.winner = false; // attacker wiped, nothing returns
        if (g.totalUnits(ib.units) > def) holds.conserve = false;
      }
    }
  }
  check('winner determined by A > D everywhere (ties defend)', holds.winner);
  check('no units created from nothing; losers wiped', holds.conserve);
  check('loot never exceeds carry capacity or stock', holds.loot);
}

{
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 10;
  const r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  const out = r.arrive - t0;
  check('travel time = dist*speed*60000 (5 fields, raider 6min/field)',
    out === 5 * 6 * 60000);
  g.resolveWorld(w, r.arrive + 1);
  const ret = w.movements.find((m) => m.type === 'return');
  // Guarded for the same reason as the characterisation block below: an
  // unguarded deref here aborts the whole run before those tests execute.
  check('return trip takes as long as the way out',
    !!ret && ret.arrive - ret.depart === out);
}

{
  const { w, a, b, ia, ib } = freshWorld();
  ia.units.raider = 50; ia.units.flagship = 1;
  ib.units.sentinel = 2;
  g.resolveIsland(ib, t0); // sync the clock first, else regen refills the meter
  ib.loyalty = 0;          // loyalty already broken by earlier strikes
  const r = g.sendAttack(w, a, ia, ib, { raider: 50, flagship: 1 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('conquest: surviving flagship flips ownership and is consumed',
    ib.ownerId === a.id && ib.units.flagship === 0 && ib.units.raider > 0);
  check('defeated player respawns on a new island', g.playerIslands(w, b.id).length === 1);
}

// ---------------------------------------------------------------- wall & population

console.log('wall & population');
{
  // 10 raiders (A=240) beat 7 sentinels (D=210) on open ground...
  const w1 = freshWorld();
  w1.ia.units.raider = 10; w1.ib.units.sentinel = 7;
  const r1 = g.sendAttack(w1.w, w1.a, w1.ia, w1.ib, { raider: 10 }, t0);
  g.resolveWorld(w1.w, r1.arrive + 1);
  check('bare island falls to a stronger army', g.totalUnits(w1.ib.units) === 0);

  // ...but a level-3 wall turns the same battle around: (210+45)*1.24 = 316 > 240.
  const w2 = freshWorld();
  w2.ia.units.raider = 10; w2.ib.units.sentinel = 7; w2.ib.buildings.wall = 3;
  const r2 = g.sendAttack(w2.w, w2.a, w2.ia, w2.ib, { raider: 10 }, t0);
  g.resolveWorld(w2.w, r2.arrive + 1);
  check('a wall turns the same battle around', w2.ib.units.sentinel > 0);

  // A sacked island loses a wall level.
  const w3 = freshWorld();
  w3.ia.units.raider = 40; w3.ib.units.sentinel = 2; w3.ib.buildings.wall = 2;
  const r3 = g.sendAttack(w3.w, w3.a, w3.ia, w3.ib, { raider: 40 }, t0);
  g.resolveWorld(w3.w, r3.arrive + 1);
  check('sack damages the wall by one level', w3.ib.buildings.wall === 1);
}
{
  const { w, ia } = freshWorld();
  ia.resources = { wood: 90000, stone: 90000, gold: 90000 };
  ia.buildings.storehouse = 15;
  ia.buildings.barracks = 1;
  check('farm cap: level 1 holds 41 pop', g.popCap(1) === 41);
  const r = g.tryTrain(w, ia, 'spearman', 100, t0);
  check('training past the farm cap is rejected', r.error === 'err.noPop');
  check('training within the cap works', !g.tryTrain(w, ia, 'spearman', 40, t0).error);
  check('queued troops count against population', g.popUsed(ia) === 40);
  check('a second batch is blocked by the queue pop', g.tryTrain(w, ia, 'spearman', 2, t0).error === 'err.noPop');
}

// ---------------------------------------------------------------- loyalty conquest

console.log('loyalty');
{
  const { w, a, b, ia, ib } = freshWorld();
  ia.units.raider = 50; ia.units.flagship = 1;
  ib.units.sentinel = 2;
  const r = g.sendAttack(w, a, ia, ib, { raider: 50, flagship: 1 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('first flagship victory does NOT capture', ib.ownerId === b.id);
  check('loyalty dropped by 25-40', ib.loyalty >= 60 && ib.loyalty <= 75);
  const ret = w.movements.find((m) => m.type === 'return');
  check('flagship survives and returns home', ret && ret.units.flagship === 1);
  check('loyalty line in both reports',
    w.reports.filter((x) => x.lines.some((l) => l.includes('Loyalty of'))).length === 2);

  // Break the rest of the loyalty: nearly gone, and even the regeneration
  // during the flagship's slow voyage can't outrun a 25+ drop.
  // Only reachable if the flagship actually came home — guarded so a change
  // that stops creating return movements reports failures instead of throwing.
  if (ret) {
    g.resolveWorld(w, ret.arrive + 1); // flagship home
    ib.loyalty = 0;
    ib.units.sentinel = 1;
    const r2 = g.sendAttack(w, a, ia, ib, { raider: 40, flagship: 1 }, ret.arrive + 10);
    g.resolveWorld(w, r2.arrive + 1);
    check('capture at 0 loyalty', ib.ownerId === a.id);
    check('captured island starts restive at 25 loyalty', ib.loyalty === 25);
    check('flagship consumed on capture', ib.units.flagship === 0);
  }
}
{
  const { ia } = freshWorld();
  ia.loyalty = 50;
  g.resolveIsland(ia, ia.lastUpdate + 10 * H);
  check('loyalty regenerates 2/h (at speed 1)', close(ia.loyalty, 70));
}

// ---------------------------------------------------------------- support

console.log('support');
{
  const { w, a, b, ia, ib } = freshWorld();
  const c = g.createPlayer(w, 'C', 'pw', false).player;
  c.protectionBroken = true;
  const ic = g.playerIsland(w, c.id);
  ic.x = 0; ic.y = 10;

  // a stations 5 sentinels at b's island
  ia.units.sentinel = 5;
  const rs = g.sendSupport(w, a, ia, ib, { sentinel: 5 }, t0);
  check('support sent', !rs.error);
  g.resolveWorld(w, rs.arrive + 1);
  check('contingent stationed', ib.support.length === 1 && ib.support[0].units.sentinel === 5);
  check('sender got an arrival report',
    w.reports.some((x) => x.ownerId === a.id && x.title.startsWith('Support arrived')));

  // c attacks with less than the combined defense: support holds the island
  ic.units.raider = 5; // A=120 vs support D=150
  const ra = g.sendAttack(w, c, ic, ib, { raider: 5 }, rs.arrive + 10);
  g.resolveWorld(w, ra.arrive + 1);
  check('support holds the island', ib.ownerId === b.id);
  check('contingent bled but survives',
    ib.support.length === 1 && ib.support[0].units.sentinel < 5 && ib.support[0].units.sentinel > 0);
  check('supporter got a battle report',
    w.reports.some((x) => x.ownerId === a.id && x.title.startsWith('Your support fought')));

  // c returns in force: support is wiped, sender told
  ic.units.raider = 30;
  const ra2 = g.sendAttack(w, c, ic, ib, { raider: 30 }, ra.arrive + 200000);
  g.resolveWorld(w, ra2.arrive + 1);
  check('overwhelming attack wipes the support', ib.support.length === 0);
  check('supporter got a wiped report',
    w.reports.some((x) => x.ownerId === a.id && x.title.includes('wiped out')));
}
{
  // withdraw brings the contingent home
  const { w, a, b, ia, ib } = freshWorld();
  ia.units.spearman = 6;
  const rs = g.sendSupport(w, a, ia, ib, { spearman: 6 }, t0);
  g.resolveWorld(w, rs.arrive + 1);
  const rw = g.withdrawSupport(w, a, ib, rs.arrive + 10);
  check('withdraw accepted', !rw.error);
  check('withdraw with nothing stationed rejected',
    g.withdrawSupport(w, a, ib, rs.arrive + 20).error === 'err.nothingToWithdraw');
  g.resolveWorld(w, rs.arrive + 10 + (rs.arrive - t0) + 1);
  check('troops made it home', ia.units.spearman === 6);
}
{
  // supporting your own island is a transfer
  const { w, a, ia, ib } = freshWorld();
  ib.ownerId = a.id;
  ia.units.spearman = 4;
  const rs = g.sendSupport(w, a, ia, ib, { spearman: 4 }, t0);
  g.resolveWorld(w, rs.arrive + 1);
  check('self-support merges into the garrison', ib.units.spearman === 4 && ib.support.length === 0);
}

// ---------------------------------------------------------------- scouts

console.log('scouts');
{
  const { w, a, b, ia, ib } = freshWorld();
  ia.units.scout = 5; ia.units.raider = 2;
  check('scouts cannot join attacks',
    g.sendAttack(w, a, ia, ib, { raider: 1, scout: 1 }, t0).error === 'err.shipsNoAttack');
  check('scouts cannot be sent as support',
    g.sendSupport(w, a, ia, ib, { scout: 1 }, t0).error === 'err.noSupportUnits');

  // equal counter-scouts: mission fails, defender is told
  ib.units.scout = 5;
  const r1 = g.sendScout(w, a, ia, ib, 5, t0);
  g.resolveWorld(w, r1.arrive + 1);
  check('counter-scouts kill the mission', ia.units.scout === 0 &&
    w.reports.some((x) => x.ownerId === a.id && x.title.startsWith('Scouting')));
  check('defender caught them',
    w.reports.some((x) => x.ownerId === b.id && x.title.startsWith('Enemy scouts caught')));
}
{
  const { w, a, b, ia, ib } = freshWorld();
  ia.units.scout = 5;
  ib.units.scout = 1; ib.units.sentinel = 9;
  const r = g.sendScout(w, a, ia, ib, 5, t0);
  g.resolveWorld(w, r.arrive + 1);
  const intel = w.reports.find((x) => x.ownerId === a.id && x.title.startsWith('Scout report'));
  check('intel report delivered', !!intel);
  check('intel lists the garrison', intel.lines.some((l) => l.includes('9 Sentinels')));
  check('intel includes loyalty', intel.lines.some((l) => l.includes('Loyalty: 100/100')));
  check('losses reported', intel.lines.some((l) => l.includes('1 Scouts did not return')));
  check('defender noticed the intrusion',
    w.reports.some((x) => x.ownerId === b.id && x.title.startsWith('Enemy scouts over')));
  const ret = w.movements.find((m) => m.type === 'return');
  check('survivors sail home', ret && ret.units.scout === 4);
}

// ---------------------------------------------------------------- trade & rename

console.log('trade & rename');
{
  const { w, a, b, ia, ib } = freshWorld();
  check('trade capacity: harbor 1 carries 250, harbor 3 carries 563',
    g.tradeCapacity(1) === 250 && g.tradeCapacity(3) === 563 && g.tradeCapacity(0) === 0);

  // no harbor -> rejected
  let r = g.sendTrade(w, a, ia, ib, { wood: 100 }, t0);
  check('trade requires a harbor', r.error === 'err.buildFirst');

  ia.buildings.harbor = 1;
  ia.resources = { wood: 300, stone: 300, gold: 300 };
  check('empty shipment rejected', g.sendTrade(w, a, ia, ib, {}, t0).error === 'err.tradeAmount');
  check('overweight shipment rejected',
    g.sendTrade(w, a, ia, ib, { wood: 200, stone: 100 }, t0).error === 'err.tradeCapacity');
  check('cannot send more than you have',
    g.sendTrade(w, a, ia, ib, { gold: 301 }, t0).error === 'err.noResources');

  r = g.sendTrade(w, a, ia, ib, { wood: 120, gold: 80 }, t0);
  check('valid shipment sails', !r.error);
  check('resources deducted at once', Math.floor(ia.resources.wood) === 180);
  g.resolveIsland(ib, t0);
  ib.resources = { wood: 0, stone: 0, gold: 0 }; // drained stores, room to receive
  g.resolveWorld(w, r.arrive + 1);
  check('shipment delivered', ib.resources.wood >= 120 && ib.resources.gold >= 80);
  // a full store clamps: deliveries can't overflow the storehouse
  const cap = g.storageCapacity(ib.buildings.storehouse);
  check('delivery clamps at storage capacity', ib.resources.wood <= cap);
  check('both sides got reports',
    w.reports.some((x) => x.ownerId === a.id && x.title.startsWith('Shipment delivered')) &&
    w.reports.some((x) => x.ownerId === b.id && x.title.startsWith('Shipment arrived')));
}
{
  const { w, a, ia } = freshWorld();
  check('rename works', !g.renameIsland(w, a, ia, 'Šťastný Ostrov').error &&
    ia.name === 'Šťastný Ostrov');
  check('unicode letters accepted', !g.renameIsland(w, a, ia, 'Über-Insel').error);
  check('too-short name rejected', g.renameIsland(w, a, ia, 'x').error === 'err.badName');
  check('markup rejected', g.renameIsland(w, a, ia, '<script>x</script>').error === 'err.badName');
}

// ---------------------------------------------------------------- beginner protection

console.log('beginner protection');
{
  const { w, a, b, ia, ib } = freshWorld();
  b.protectionBroken = false; // b is genuinely fresh for this test
  Object.assign(ia.buildings, { lumberyard: 8, quarry: 8, goldmine: 6 }); // a is established (>40 pts)
  ia.units.raider = 10;
  // b is a fresh player (5 points < 40): untouchable
  let r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('fresh player cannot be attacked', r.error === 'err.protected');

  // b attacks an (attackable) human -> forfeits protection
  ib.units.spearman = 1;
  r = g.sendAttack(w, b, ib, ia, { spearman: 1 }, t0);
  check('protected player may still attack', !r.error);
  r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('protection lost after attacking a human', !r.error);
}
{
  const { w, a, b, ia, ib } = freshWorld();
  // over 40 points -> attackable regardless of protectionBroken
  b.protectionBroken = false;
  b.joinedAt = 0; // long past the join-grace window (explicit: no wall-clock dependence)
  Object.assign(ib.buildings, { lumberyard: 8, quarry: 8, goldmine: 6 });
  ia.units.raider = 10;
  const r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('protection ends at 40 points', !r.error);
}
{
  const { w, a, b, ia, ib } = freshWorld();
  // join grace: a fresh human above 40 points is still protected for 72h game-time
  b.protectionBroken = false;
  Object.assign(ib.buildings, { lumberyard: 8, quarry: 8, goldmine: 6 }); // >40 pts
  b.joinedAt = t0 - 1000; // joined moments ago
  ia.units.raider = 10;
  let r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('fresh human above 40 pts keeps join grace', r.error === 'err.protected');
  b.joinedAt = t0 - g.PROTECT_GRACE_MS - 1000;
  r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('join grace expires after 72h game-time', !r.error);
  b.joinedAt = t0 - 1000;
  b.protectionBroken = true;
  check('attacking a human forfeits grace too', g.isProtected(w, b, t0) === false);
  const bot = g.createPlayer(w, 'Gracebot', null, true).player;
  check('bots never get join grace', g.isProtected(w, bot, t0) === false);
}
{
  // downward bully guard: a big bot leaves small-but-legal humans alone
  const { w, b, ib } = freshWorld();
  const { botTick } = await import('./bots.js');
  b.protectionBroken = false;
  b.joinedAt = 0; // grace long over
  Object.assign(ib.buildings, { lumberyard: 8, quarry: 8, goldmine: 6 }); // ~45 pts: legal target
  const bot = g.createPlayer(w, 'Bully', null, true).player;
  const bi = g.playerIsland(w, bot.id);
  Object.assign(bi.buildings, { lumberyard: 20, quarry: 20, goldmine: 20, hall: 15, barracks: 10 }); // huge
  bi.x = 10; bi.y = 10; ib.x = 14; ib.y = 10; // in raid range
  bi.units.raider = 60; // plenty of power
  bot.intel = { [ib.id]: { def: 0, time: t0 } }; // fresh intel: soft target
  check('setup: bot is >3x the human', g.playerPoints(w, bot.id) > 3 * g.playerPoints(w, b.id));
  for (let i = 0; i < 300; i++) botTick(w, t0 + i * 15000);
  check('big bot never raids a small human (downward bully guard)',
    !w.movements.some((m) => m.type === 'attack' && m.toId === ib.id));
}
{
  const { w, a, ia } = freshWorld();
  const bot = g.createPlayer(w, 'Reef Rat', null, true).player;
  const bi = g.playerIsland(w, bot.id);
  ia.units.raider = 5; a.protectionBroken = false;
  g.sendAttack(w, a, ia, bi, { raider: 5 }, t0);
  check('raiding a bot does NOT forfeit protection', a.protectionBroken === false);
  check('bots spawn without protection', bot.protectionBroken === true);
}

// ---------------------------------------------------------------- market

console.log('market');
{
  const { w, a, b, ia, ib } = freshWorld();
  check('offer needs a harbor',
    g.createOffer(w, a, ia, { res: 'wood', amount: 100 }, { res: 'gold', amount: 50 }, t0).error === 'err.buildFirst');
  ia.buildings.harbor = 1;
  ib.buildings.harbor = 1;
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 500, stone: 0, gold: 0 };
  check('same-resource offer rejected',
    g.createOffer(w, a, ia, { res: 'wood', amount: 100 }, { res: 'wood', amount: 50 }, t0).error === 'err.badRequest');
  check('unaffordable offer rejected',
    g.createOffer(w, a, ia, { res: 'gold', amount: 10 }, { res: 'wood', amount: 5 }, t0).error === 'err.noResources');

  const r = g.createOffer(w, a, ia, { res: 'wood', amount: 200 }, { res: 'gold', amount: 100 }, t0);
  check('offer posted, goods escrowed', !r.error && Math.floor(ia.resources.wood) === 300);

  // limit
  for (let i = 0; i < 4; i++) {
    g.createOffer(w, a, ia, { res: 'wood', amount: 10 }, { res: 'gold', amount: 5 }, t0);
  }
  check('offer limit enforced',
    g.createOffer(w, a, ia, { res: 'wood', amount: 10 }, { res: 'gold', amount: 5 }, t0).error === 'err.offerLimit');

  // cancel refunds
  const mine = w.offers.filter((o) => o.playerId === a.id);
  const beforeCancel = ia.resources.wood;
  g.cancelOffer(w, a, mine[1].id, t0);
  check('cancel refunds the escrow', ia.resources.wood >= beforeCancel + 9);

  // accept: buyer pays, two shipments cross
  g.resolveIsland(ib, t0);
  ib.resources = { wood: 0, stone: 0, gold: 300 };
  check('cannot accept own offer', g.acceptOffer(w, a, ia, mine[0].id, t0).error === 'err.ownOffer');
  const acc = g.acceptOffer(w, b, ib, mine[0].id, t0);
  check('offer accepted', !acc.error && Math.floor(ib.resources.gold) === 200);
  const legs = w.movements.filter((m) => m.type === 'trade');
  check('two trade legs created', legs.length === 2);
  g.resolveWorld(w, Math.max(...legs.map((m) => m.arrive)) + 1);
  check('buyer received the goods', ib.resources.wood >= 200);
  check('seller received the payment', ia.resources.gold >= 100);
  check('offer removed from the market', !w.offers.some((o) => o.id === mine[0].id));
}

// ---------------------------------------------------------------- max building level
// A ceiling on every building, stored per world so different seasons can
// differ and a restart cannot move it under a season in progress.
//
// 14 rather than 15 because of the two curves that do not self-limit: a
// storehouse holds 400 * 1.5^level, which at 14 is under half the wood in the
// live world and at 15 is over two thirds.
console.log('max building level');

{
  const w = g.createWorld();
  const D = g.MAX_BUILDING_LEVEL_DEFAULT;
  check('a new world carries the cap', w.maxBuildingLevel === D);
  check('the shipped fallback is 14', g.MAX_BUILDING_LEVEL_FALLBACK === 14);
  check('and the env pinned above gives that', D === 14);

  // Every source goes through one parser, because both failure modes are
  // severe and both come from a typo: NaN makes `target > cap` always false
  // and silently disables the cap, while 0 or a negative blocks every upgrade
  // in the game including a level-1 wall.
  for (const [raw, want] of [
    ['abc', 14], ['0', 14], ['-5', 14], ['', 14], [undefined, 14], [null, 14],
    [NaN, 14], [Infinity, 14], ['200', 14], [{}, 14],
    ['20', 20], [20, 20], ['12.9', 12], [1, 1], [100, 100],
  ]) {
    check(`parseMaxLevel(${JSON.stringify(raw)}) = ${want}`, g.parseMaxLevel(raw) === want,
      `got ${g.parseMaxLevel(raw)}`);
  }

  const old = { createdAt: 1, players: [], islands: [], offers: [] };
  g.migrateWorld(old);
  check('an old save is backfilled with the default', old.maxBuildingLevel === D);

  // Applied as a one-off: once a world has a value, later loads leave it be.
  const tuned = g.createWorld();
  tuned.maxBuildingLevel = 20;
  g.migrateWorld(tuned);
  check('migration never overwrites a value already set', tuned.maxBuildingLevel === 20);

  check('a missing field falls back rather than throwing', g.maxBuildingLevel({}) === D);
  check('and so does a nonsense one', g.maxBuildingLevel({ maxBuildingLevel: 'abc' }) === D);
  check('and a corrupt zero does not brick the world', g.maxBuildingLevel({ maxBuildingLevel: 0 }) === D);
}

{
  // The guard itself.
  const { w, ia } = freshWorld();
  w.maxBuildingLevel = 5;
  ia.buildings.storehouse = 12;
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 1e9, stone: 1e9, gold: 1e9 };

  ia.buildings.quarry = 4;
  check('below the cap still builds', !g.tryBuild(w, ia, 'quarry', t0).error);
  ia.queue = [];
  ia.buildings.quarry = 5;
  // Snapshot here, not at the top: the successful build above already spent.
  const woodBefore = ia.resources.wood;
  const r = g.tryBuild(w, ia, 'quarry', t0);
  check('at the cap it refuses', r.error === 'err.maxLevel', JSON.stringify(r));
  check('and names the cap', r.errorParams?.max === 5);
  check('and takes no resources', ia.resources.wood === woodBefore);
  check('and queues nothing', ia.queue.length === 0);

  // Lowering the cap must not delete what exists.
  check('a building already ABOVE the cap is left alone', ia.buildings.storehouse === 12);
  check('it just cannot go higher',
    g.tryBuild(w, ia, 'storehouse', t0).error === 'err.maxLevel');

  // Queued upgrades count, or you could stack past the ceiling.
  ia.buildings.quarry = 3;
  ia.queue = [];
  check('queueing to the cap is allowed', !g.tryBuild(w, ia, 'quarry', t0).error);
  check('and again to the cap', !g.tryBuild(w, ia, 'quarry', t0).error);
  const past = g.tryBuild(w, ia, 'quarry', t0);
  check('but not past it, counting what is queued', past.error === 'err.maxLevel',
    `queue ${JSON.stringify(ia.queue.map((q) => q.level))}`);
}

{
  // The knob.
  const w = g.createWorld();
  check('setting the cap works', g.setMaxBuildingLevel(w, 18).ok && w.maxBuildingLevel === 18);
  for (const bad of [0, -1, NaN, 'abc', null, undefined, 101]) {
    check(`cap ${String(bad)} is refused`,
      g.setMaxBuildingLevel(w, bad).error === 'err.badRequest');
  }
  check('a refused change leaves the old value', w.maxBuildingLevel === 18);
  check('a fractional cap is floored', g.setMaxBuildingLevel(w, 12.9).ok && w.maxBuildingLevel === 12);
}

// ---------------------------------------------------------------- resource pool
// Nothing in the game calls the pool yet (#46). These pin the arithmetic
// before anything can move a player's resources with it.
//
// The invariants matter more than the individual numbers. A market maker that
// can be round-tripped for profit is a resource printer, and one that can be
// drained to zero is a dead feature — so both are asserted directly rather
// than inferred from a worked example.
console.log('resource pool');

{
  // The tuned seed, from a week of the live season: gold is over-produced
  // relative to what it is spent on, so it is worth LESS than wood.
  const seed = () => ({ wood: 4000, stone: 3600, gold: 6800 });

  check('spot price is the reserve ratio', close(g.poolSpot(seed(), 'wood', 'gold'), 4000 / 6800));
  check('spot price of a resource against itself is 1', g.poolSpot(seed(), 'wood', 'wood') === 1);

  // Spot prices around the triangle multiply to 1, so there is no free money
  // sitting in the price table itself.
  const p = seed();
  check('no triangular arbitrage at spot', close(
    g.poolSpot(p, 'wood', 'stone') * g.poolSpot(p, 'stone', 'gold') * g.poolSpot(p, 'gold', 'wood'), 1));

  // x*y=k, worked by hand: dxf = 500*0.997 = 498.5
  //   out = 6800 - (4000*6800)/(4000+498.5) = 6800 - 27_200_000/4498.5 = 754.57...
  const q = g.poolQuote(seed(), 'wood', 'gold', 500);
  check('quote follows x*y=k after fee', close(q.out, 6800 - (4000 * 6800) / (4000 + 500 * 0.997), 1e-9),
    `got ${q.out}`);
  check('effective price is worse than spot', q.effPrice > q.spotPrice);
  check('impact is the gap between them', close(q.impact, q.effPrice / q.spotPrice - 1));
  check('a quote inside the cap is not capped', q.capped === false && q.cappedBy === null);

  // Bigger orders get more out in total but a worse rate each — the whole
  // point of a curve over a fixed exchange rate.
  const small = g.poolQuote(seed(), 'wood', 'gold', 100);
  const big = g.poolQuote(seed(), 'wood', 'gold', 1000);
  check('more in yields more out', big.out > small.out);
  check('more in yields a worse rate', big.effPrice > small.effPrice);
}

{
  // Conservation: a swap moves resources between the pool and the trader and
  // creates none. The fee is not an extra charge, it stays in the reserve.
  const before = { wood: 4000, stone: 3600, gold: 6800 };
  const r = g.poolApplySwap(before, 'wood', 'gold', 500);
  check('input reserve rises by exactly what was used',
    close(r.reserves.wood, before.wood + r.used));
  check('output reserve falls by exactly what was paid out',
    close(r.reserves.gold, before.gold - r.out));
  check('the untouched reserve does not move', r.reserves.stone === before.stone);
  check('applySwap does not mutate its argument', before.wood === 4000 && before.gold === 6800);

  // k grows by the fee and never shrinks — that is what makes a share of the
  // pool worth more after trading than before.
  const kBefore = before.wood * before.gold;
  const kAfter = r.reserves.wood * r.reserves.gold;
  check('k never decreases across a swap', kAfter >= kBefore);
  check('k grows by roughly the fee', kAfter > kBefore);
}

{
  // No free money. Every closed loop must lose, or the pool is a printer.
  const start = { wood: 4000, stone: 3600, gold: 6800 };

  const outbound = g.poolApplySwap(start, 'wood', 'gold', 500);
  const back = g.poolApplySwap(outbound.reserves, 'gold', 'wood', outbound.out);
  check('a there-and-back swap returns less than it sent', back.out < 500, `got ${back.out}`);

  // The triangle too: wood -> stone -> gold -> wood.
  let res = start;
  let held = 500;
  for (const [from, to] of [['wood', 'stone'], ['stone', 'gold'], ['gold', 'wood']]) {
    const leg = g.poolApplySwap(res, from, to, held);
    res = leg.reserves;
    held = leg.out;
  }
  check('a triangular round trip returns less than it sent', held < 500, `got ${held}`);

  // And with the fee switched off it must still lose, to slippage alone.
  const free1 = g.poolApplySwap(start, 'wood', 'gold', 500, { feeBps: 0 });
  const free2 = g.poolApplySwap(free1.reserves, 'gold', 'wood', free1.out, { feeBps: 0 });
  check('round trip loses to slippage even at zero fee', free2.out <= 500 + 1e-9, `got ${free2.out}`);
}

{
  // The per-swap drain cap.
  const seed = { wood: 4000, stone: 3600, gold: 6800 };
  const huge = g.poolQuote(seed, 'wood', 'gold', 1e12);
  check('an oversized order is capped', huge.capped === true && huge.cappedBy === 'cap');
  check('the cap is 30% of the output reserve', close(huge.out, 6800 * 0.30), `got ${huge.out}`);
  check('a capped quote reports the input it actually used', huge.used < 1e12 && huge.used > 0);
  check('using exactly maxIn is not over the cap', g.poolQuote(seed, 'wood', 'gold', huge.maxIn).capped === false);

  // The cap is proportional, so it slows a drain but cannot stop one. This is
  // the finding that made the floor necessary; pin it so it is not mistaken
  // for protection later.
  let res = seed;
  for (let i = 0; i < 40; i++) res = g.poolApplySwap(res, 'gold', 'stone', 1e12).reserves;
  check('the cap alone does NOT stop a sustained drain', res.stone < seed.stone * 0.0001,
    `stone left ${res.stone}`);
}

{
  // The floor does stop it, because it is measured against the seeded amount
  // rather than against whatever is left.
  const seed = { wood: 4000, stone: 3600, gold: 6800 };
  const floor = { wood: 1000, stone: 900, gold: 1700 }; // 25% of seed
  let res = seed;
  for (let i = 0; i < 40; i++) res = g.poolApplySwap(res, 'gold', 'stone', 1e12, { floor }).reserves;
  check('the floor holds under a sustained drain', close(res.stone, 900), `stone left ${res.stone}`);
  check('the floor never lets a reserve go under', res.stone >= 900 - 1e-9);

  const atFloor = g.poolQuote(res, 'gold', 'stone', 1000, { floor });
  check('a reserve sitting on its floor quotes zero', atFloor.out === 0);
  check('and says the floor is why', atFloor.cappedBy === 'floor');

  // A floor below the current reserve still lets the cap bind first.
  const loose = g.poolQuote(seed, 'gold', 'stone', 1e12, { floor: { wood: 1, stone: 1, gold: 1 } });
  check('a slack floor leaves the cap in charge', loose.cappedBy === 'cap');
}

{
  // Liquidity: deposits keep the ratio, withdrawal is proportional, and a
  // round trip with no trading in between must not return more than it put in.
  const seed = { wood: 4000, stone: 3600, gold: 6800 };
  const shares0 = Math.sqrt(seed.wood * seed.stone);

  const add = g.poolAddLiquidity(seed, shares0, { wood: 1000, stone: 1000, gold: 1000 });
  check('deposit keeps every leg on the same ratio',
    close(add.required.wood / seed.wood, add.required.gold / seed.gold));

  // Scaling must follow the TIGHTEST leg, not just the last one looked at.
  // Offer a lot of stone and gold but almost no wood: wood has to bind, and
  // the deposit must never take more of anything than was actually offered.
  const lopsided = { wood: 100, stone: 5000, gold: 5000 };
  const bound = g.poolAddLiquidity(seed, shares0, lopsided);
  check('deposit is limited by the scarcest leg offered',
    close(bound.required.wood, 100), `took ${bound.required.wood} wood of 100 offered`);
  check('a deposit never takes more of any resource than was offered',
    g.RESOURCES.every((r) => bound.required[r] <= lopsided[r] + 1e-9),
    g.RESOURCES.map((r) => `${r} ${bound.required[r].toFixed(1)}/${lopsided[r]}`).join(", "));
  check('the surplus legs are left with the depositor',
    bound.required.gold < lopsided.gold);
  check('deposit preserves the price', close(
    g.poolSpot(add.reserves, 'wood', 'gold'), g.poolSpot(seed, 'wood', 'gold')));
  check('shares minted in proportion to the deposit',
    close(add.minted / add.totalShares, add.required.wood / add.reserves.wood));

  const rm = g.poolRemoveLiquidity(add.reserves, add.totalShares, add.minted);
  check('deposit then withdraw returns what went in',
    close(rm.out.wood, add.required.wood) && close(rm.out.gold, add.required.gold));
  check('and leaves the pool as it was found', close(rm.reserves.wood, seed.wood));
  check('withdrawal cannot return more than was deposited',
    rm.out.wood <= add.required.wood + 1e-9);

  check('burning more shares than exist takes everything, not more',
    close(g.poolRemoveLiquidity(seed, 100, 1e9).reserves.wood, 0));
  check('over-burning cannot drive the share count negative',
    g.poolRemoveLiquidity(seed, 100, 1e9).totalShares === 0);

  check('share value is the pro-rata slice',
    close(g.poolShareValue(seed, 100, 25).wood, 1000));
  check('shares in an empty pool are worth nothing',
    g.poolShareValue(seed, 0, 25).wood === 0);

  // Fees accrue to the reserves, so a share redeems for a better basket after
  // trading than before. Note the measure: adding wood + stone + gold is NOT
  // a value, because a swap trades few of a dear resource for many of a cheap
  // one and the unit count can fall while the pool is worth more. The
  // constant-product invariant per share is the honest one, and it is exactly
  // what fees push up.
  const traded = g.poolApplySwap(seed, 'wood', 'gold', 500).reserves;
  const perShare = (res) => Math.sqrt(res.wood * res.gold) / shares0;
  check('trading makes a share redeem for more', perShare(traded) > perShare(seed),
    `${perShare(seed)} -> ${perShare(traded)}`);
  check('a swap can lower the unit count while raising the value',
    traded.wood + traded.stone + traded.gold < seed.wood + seed.stone + seed.gold);

  // First deposit into an empty pool sets the price rather than matching one.
  const first = g.poolAddLiquidity({ wood: 0, stone: 0, gold: 0 }, 0, { wood: 100, stone: 100, gold: 50 });
  check('the first deposit defines the pool', first.reserves.gold === 50 && first.totalShares > 0);
}

{
  // Malformed input. Nothing calls the pool yet, so these are cheap to pin
  // now and expensive to discover later — each one is a way to print or
  // destroy resources once a real caller is deducting `used` from a player.
  const seed = { wood: 4000, stone: 3600, gold: 6800 };
  const empty = { wood: 0, stone: 0, gold: 0 };

  // A floor protects the reserve being BOUGHT — the `to` leg, the one being
  // paid out. So a floor object carrying only `wood` says nothing about a
  // wood-for-gold swap, and must read as "no floor on gold" rather than NaN.
  // Unguarded it zeroed every quote and blamed the drain cap.
  const partial = g.poolQuote(seed, 'wood', 'gold', 500, { floor: { wood: 1000 } });
  const full = g.poolQuote(seed, 'wood', 'gold', 500);
  check('a floor missing this leg is ignored, not NaN', close(partial.out, full.out),
    `got ${partial.out}`);
  check('and it does not falsely blame the cap', partial.cappedBy === null);
  check('a non-numeric floor entry is ignored too',
    close(g.poolQuote(seed, 'wood', 'gold', 500, { floor: { gold: undefined } }).out, full.out));

  // Negative input is a resource printer: `used` is what a caller deducts
  // from the player, so a negative one credits them while the reserve drops.
  for (const bad of [-1000, NaN, Infinity, undefined, null, 'abc']) {
    const r = g.poolApplySwap(seed, 'wood', 'gold', bad);
    check(`input ${String(bad)} is refused, not honoured`,
      r.used === 0 && r.out === 0, `used ${r.used}, out ${r.out}`);
    check(`input ${String(bad)} leaves every reserve untouched`,
      r.reserves.wood === seed.wood && r.reserves.gold === seed.gold);
  }

  // A first deposit that cannot define a pool must no-op, not mint a share
  // against nothing — that bricked the pool permanently, because reserves
  // stayed at zero and every later deposit then scaled to zero.
  for (const bad of [empty, { wood: 100, stone: 0, gold: 50 }, { wood: -100, stone: 50, gold: 50 }]) {
    const a = g.poolAddLiquidity(empty, 0, bad);
    check(`first deposit ${JSON.stringify(bad)} is refused`,
      a.totalShares === 0 && a.minted === 0);
  }
  // ...and the pool is still openable afterwards.
  const revived = g.poolAddLiquidity(empty, 0, { wood: 100, stone: 100, gold: 50 });
  check('a refused first deposit does not brick the pool',
    revived.totalShares > 0 && revived.reserves.gold === 50);

  const total = (r) => r.wood + r.stone + r.gold;

  // Swapping a resource for itself wrote the same reserve key twice, so the
  // `used` leg was discarded and the trader's payment vanished.
  const same = g.poolApplySwap(seed, 'wood', 'wood', 500);
  check('a resource cannot be swapped for itself',
    same.used === 0 && same.out === 0);
  check('a same-resource swap destroys nothing',
    close(total(same.reserves), total(seed)), `${total(seed)} -> ${total(same.reserves)}`);

  // An unknown key used to write NaN into the reserves, poisoning the pool
  // for every quote after it.
  const alien = g.poolApplySwap(seed, 'wood', 'iron', 500);
  check('an unknown resource is refused', alien.used === 0 && alien.out === 0);
  check('and does not add a NaN reserve',
    g.RESOURCES.every((r) => Number.isFinite(alien.reserves[r])) && alien.reserves.iron === undefined);
  check('spot price of an unknown pair is 0, not NaN', g.poolSpot(seed, 'wood', 'iron') === 0);
  check('an unknown resource against itself has no price either',
    g.poolSpot(seed, 'iron', 'iron') === 0);
  // pool.js validates legs against the reserves object itself (#58). A naive
  // `in` check would accept prototype keys — reserves['toString'] is a
  // function, and arithmetic on it is NaN into the pool.
  check('a prototype key is not a reserve leg', g.poolSpot(seed, 'toString', 'gold') === 0);
  check('nor can one be quoted', g.poolQuote(seed, 'constructor', 'gold', 100).out === 0);

  // Amounts are validated the same way at every entry point, so a numeric
  // string from a request body is refused here as it is everywhere else.
  const strDeposit = g.poolAddLiquidity(seed, 100, { wood: '100', stone: '100', gold: '100' });
  check('a numeric string deposit is refused, not coerced', strDeposit.minted === 0);
  check('and takes nothing from the depositor',
    g.RESOURCES.every((r) => strDeposit.required[r] === 0));

  // Options are season config, so they get clamped rather than trusted.
  const honest = g.poolQuote(seed, 'wood', 'gold', 500).out;
  // A negative fee clamps to zero, which is the range edge — not a fallback
  // to the default. What must hold is that it never becomes a *bonus*:
  // unclamped, feeBps -10000 paid out 1360 against an honest 753.
  const zeroFee = g.poolQuote(seed, 'wood', 'gold', 500, { feeBps: 0 }).out;
  check('a negative fee is never better than no fee at all',
    g.poolQuote(seed, 'wood', 'gold', 500, { feeBps: -10000 }).out <= zeroFee + 1e-9);
  check('and no fee is still worse than the pre-clamp bonus was',
    zeroFee < 1000 && zeroFee > honest, `zero-fee out ${zeroFee}`);
  const negCap = g.poolApplySwap(seed, 'wood', 'gold', 500, { maxOutFrac: -0.5 });
  check('a negative drain cap cannot make `used` negative', negCap.used >= 0,
    `used ${negCap.used}`);
  check('and cannot shrink the reserve being paid into',
    negCap.reserves.wood >= seed.wood);
  check('a non-numeric fee falls back to the default',
    close(g.poolQuote(seed, 'wood', 'gold', 500, { feeBps: 'free' }).out, honest));

  // Burning shares: negative ran the whole thing backwards, growing reserves
  // from nothing; NaN turned every reserve into NaN.
  for (const bad of [-100, NaN, 'abc', undefined]) {
    const rm = g.poolRemoveLiquidity(seed, 100, bad);
    check(`burn ${String(bad)} pays out nothing`,
      rm.out.wood === 0 && rm.out.stone === 0 && rm.out.gold === 0);
    check(`burn ${String(bad)} leaves the reserves exactly as they were`,
      close(total(rm.reserves), total(seed)) && Number.isFinite(rm.reserves.wood),
      `wood ${rm.reserves.wood}`);
  }

  // Share valuation, same family.
  check('a negative share count is worth nothing, not less than nothing',
    g.poolShareValue(seed, 100, -25).wood === 0);
  check('a NaN share count is worth nothing', g.poolShareValue(seed, 100, NaN).wood === 0);
  check('no share count can be worth more than the whole pool',
    g.poolShareValue(seed, 100, 1e9).wood === seed.wood);
}

// ---------------------------------------------------------------- pool state
// world.pool exists but is CLOSED. Nothing reads it yet; these pin the one
// property that matters most before anything does — no code path that merely
// creates or loads a world may conjure resources into the pool.
//
// That is the #36 scar restated: land respawn fired from inside migrateWorld,
// so a client-only release restarted the process and added 30 islands to a
// live season. Seeding is a deliberate act or it is a bug.
console.log('pool state');

{
  const w = g.createWorld();
  check('a new world has a pool', !!w.pool);
  check('and it starts closed', w.pool.open === false);
  check('with nothing in it', g.RESOURCES.every((r) => w.pool.reserves[r] === 0));
  check('and no shares issued', w.pool.totalShares === 0);
  check('config is stored in the world, not read from env',
    w.pool.feeBps === g.POOL_FEE_BPS && w.pool.maxOutFrac === g.POOL_MAX_OUT_FRAC
    && w.pool.floorFrac === g.POOL_FLOOR_FRAC);

  // A closed pool must refuse to trade on its own, without needing a caller
  // to check `open` first.
  const q = g.poolQuote(w.pool.reserves, 'wood', 'gold', 500, g.poolOpts(w.pool));
  check('a closed pool quotes nothing', q.out === 0 && q.used === 0);
}

{
  // Migration backfills, and that is all it does.
  const old = { createdAt: 1, players: [], islands: [], offers: [] };
  g.migrateWorld(old);
  check('migration backfills a missing pool', !!old.pool && old.pool.open === false);
  check('the backfilled pool is empty', g.RESOURCES.every((r) => old.pool.reserves[r] === 0));

  // The one that matters: a live season's pool is never touched.
  const live = g.createWorld();
  live.pool = {
    open: true,
    reserves: { wood: 4000, stone: 3600, gold: 6800 },
    seeded: { wood: 4000, stone: 3600, gold: 6800 },
    totalShares: 3794.7, feeBps: 30, maxOutFrac: 0.30, floorFrac: 0.25,
  };
  // Asserting byte-identity would forbid the one thing migration IS for:
  // adding a field that a later version introduced. The precise property is
  // that it only ever ADDS keys and never rewrites one that is already there.
  // Deep clone, not a spread. A shallow snapshot shares the nested objects,
  // so an in-place `pool.reserves.wood = ...` would compare equal to itself
  // and the assertion would pass — vacuous for exactly the case that matters.
  const snapshot = JSON.parse(JSON.stringify(live.pool));
  g.migrateWorld(live);
  const rewritten = Object.keys(snapshot)
    .filter((k) => JSON.stringify(live.pool[k]) !== JSON.stringify(snapshot[k]));
  check('migration rewrites no existing pool field', rewritten.length === 0, rewritten.join(', '));
  check('migration does NOT reseed a pool that already exists',
    live.pool.reserves.wood === 4000 && live.pool.open === true,
    live.pool.reserves.wood + ' wood');

  // ...and cannot quietly reopen or reprice one that was deliberately closed.
  const shut = g.createWorld();
  shut.pool.open = false;
  shut.pool.feeBps = 100;
  g.migrateWorld(shut);
  check('migration does not reopen a closed pool', shut.pool.open === false);
  check('migration does not overwrite tuned config', shut.pool.feeBps === 100);

  // Idempotent: migrateWorld runs on every load, so twice must equal once.
  const twice = g.createWorld();
  g.migrateWorld(twice);
  const after1 = JSON.stringify(twice.pool);
  g.migrateWorld(twice);
  check('migration is idempotent', JSON.stringify(twice.pool) === after1);

  // A pool object from a future/partial save gets its missing keys only.
  const partial = { createdAt: 1, players: [], islands: [], pool: { open: true, reserves: { wood: 5, stone: 5, gold: 5 } } };
  g.migrateWorld(partial);
  check('a partial pool keeps its own values', partial.pool.reserves.wood === 5 && partial.pool.open === true);
  check('and gains the missing ones', partial.pool.totalShares === 0 && partial.pool.feeBps === g.POOL_FEE_BPS);
}

{
  // Liquidity positions live on the player, alongside questIndex and stats.
  const w = g.createWorld();
  const p = g.createPlayer(w, 'Ada', 'pw', false).player;
  check('a new player starts with no liquidity position', p.lpShares === 0);

  const legacy = { createdAt: 1, players: [{ id: 1, name: 'Old', isBot: false }], islands: [], offers: [] };
  g.migrateWorld(legacy);
  check('migration backfills lpShares on existing players', legacy.players[0].lpShares === 0);
}

{
  // poolOpts turns stored config into the shape the pure functions take. The
  // floor is derived from what was SEEDED, so it survives the reserve being
  // drawn down — the whole reason a percentage cap could not protect one.
  const pool = g.newPool();
  pool.seeded = { wood: 4000, stone: 3600, gold: 6800 };
  pool.reserves = { wood: 4000, stone: 500, gold: 20000 }; // stone drawn below its floor
  const opts = g.poolOpts(pool);
  check('the floor is derived from the seeded amount', close(opts.floor.stone, 3600 * 0.25));
  check('not from what is left', opts.floor.stone > pool.reserves.stone);

  const q = g.poolQuote(pool.reserves, 'gold', 'stone', 1e6, opts);
  check('a reserve already under its floor sells no more', q.out === 0);
  check('and says the floor is why', q.cappedBy === 'floor');

  pool.floorFrac = 0;
  check('floorFrac 0 means no floor at all', g.poolOpts(pool).floor === undefined);
  check('poolOpts survives a missing pool', g.poolOpts(null).feeBps === g.POOL_FEE_BPS);
}

{
  // The world is persisted as JSON, so the pool has to survive a round trip
  // with no live references or lost precision.
  const w = g.createWorld();
  w.pool.open = true;
  w.pool.reserves = { wood: 4000, stone: 3600, gold: 6800 };
  w.pool.seeded = { wood: 4000, stone: 3600, gold: 6800 };
  w.pool.totalShares = Math.sqrt(4000 * 3600);
  const revived = JSON.parse(JSON.stringify(w));
  g.migrateWorld(revived);
  check('the pool survives a save/load round trip',
    JSON.stringify(revived.pool) === JSON.stringify(w.pool));
  check('and still quotes the same price after it',
    close(g.poolSpot(revived.pool.reserves, 'wood', 'gold'), g.poolSpot(w.pool.reserves, 'wood', 'gold')));
}

// ---------------------------------------------------------------- opening the pool
// Seeding mints resources into the world, so it is an admin act and nothing
// automatic may do it (#36). It is also what makes the floor mean anything,
// since the floor is measured against what was seeded.
console.log('pool opening');

{
  const w = g.createWorld();
  check('a fresh world opens closed', w.pool.open === false);

  for (const bad of [null, {}, { wood: 100, stone: 100 }, { wood: 0, stone: 1, gold: 1 },
    { wood: -5, stone: 1, gold: 1 }, { wood: 'a', stone: 1, gold: 1 }]) {
    const r = g.openPool(w, bad, t0);
    check(`seed ${JSON.stringify(bad)} is refused`, r.error === 'err.badRequest', JSON.stringify(r));
  }
  check('a refused seed leaves the pool shut and empty',
    w.pool.open === false && w.pool.reserves.wood === 0 && w.pool.totalShares === 0);

  const r = g.openPool(w, { wood: 4000, stone: 3600, gold: 6800 }, t0);
  check('a valid seed opens the pool', !r.error && w.pool.open === true);
  check('reserves are the seed', w.pool.reserves.wood === 4000 && w.pool.reserves.gold === 6800);
  check('`seeded` records it, so the floor has something to measure against',
    JSON.stringify(w.pool.seeded) === JSON.stringify(w.pool.reserves));
  check('the floor now resolves to a quarter of the seed',
    close(g.poolOpts(w.pool).floor.stone, 900));
  check('shares are minted against the initial reserves',
    close(w.pool.totalShares, Math.sqrt(4000 * 3600)));
  check('and the opening is timestamped', w.pool.openedAt === t0);

  // The seed stake belongs to nobody: no player holds it, so it cannot be
  // withdrawn. That is what makes it a floor under the whole thing.
  const held = w.players.reduce((n, p) => n + (p.lpShares || 0), 0);
  check('no player owns the seed stake', held === 0 && w.pool.totalShares > 0);

  check('opening twice is refused',
    g.openPool(w, { wood: 1, stone: 1, gold: 1 }, t0).error === 'err.poolAlreadyOpen');
  check('and the second attempt did not reprice the pool', w.pool.reserves.wood === 4000);

  // Fractional seeds are floored, as everywhere a quantity is named.
  const w2 = g.createWorld();
  g.openPool(w2, { wood: 100.9, stone: 100.9, gold: 50.9 }, t0);
  check('a fractional seed is floored',
    w2.pool.reserves.wood === 100 && w2.pool.reserves.gold === 50);
}

{
  // Closing is an off switch, not a demolition.
  const w = g.createWorld();
  check('closing a shut pool is refused', g.closePool(w).error === 'err.poolClosed');
  g.openPool(w, { wood: 4000, stone: 3600, gold: 6800 }, t0);
  const before = JSON.stringify(w.pool.reserves);
  check('closing an open pool works', !g.closePool(w).error && w.pool.open === false);
  check('closing destroys nothing', JSON.stringify(w.pool.reserves) === before);
  check('and shares survive', close(w.pool.totalShares, Math.sqrt(4000 * 3600)));
}

{
  // Reopening must RESUME, never reseed. This was a real bug, and the first
  // version of this test hid it behind an `||` that short-circuited on the
  // wrong clause: reseeding reset totalShares while players still held their
  // lpShares, so a holder of half the pool came out claiming 189,737% of it
  // and could drain the lot.
  const w = g.createWorld();
  const lp = g.createPlayer(w, 'Provider', 'pw', false).player;
  g.openPool(w, { wood: 4000, stone: 3600, gold: 6800 }, t0);
  lp.lpShares = w.pool.totalShares * 0.5;
  g.closePool(w);

  const r = g.openPool(w, { wood: 1, stone: 1, gold: 1 }, t0 + H);
  check('reopening reports that it resumed', r.resumed === true, JSON.stringify(r));
  check('reopening does not reseed the reserves',
    w.pool.reserves.wood === 4000 && w.pool.reserves.gold === 6800,
    JSON.stringify(w.pool.reserves));
  check('reopening does not reset the share count',
    close(w.pool.totalShares, Math.sqrt(4000 * 3600)));
  check('an existing position still means what it meant',
    close(lp.lpShares / w.pool.totalShares, 0.5),
    `${(lp.lpShares / w.pool.totalShares * 100).toFixed(0)}%`);
  check('and is still worth half the pool',
    close(g.poolShareValue(w.pool.reserves, w.pool.totalShares, lp.lpShares).gold, 3400));
  check('the pool is open again', w.pool.open === true);
  check('and the original seeding timestamp is kept', w.pool.openedAt === t0);
}

{
  // End to end: open the pool, then actually trade against it. Until now
  // every swap test hand-assembled a pool object.
  const { w, a, ia } = freshWorld();
  ia.buildings.harbor = 5;
  ia.buildings.storehouse = 12;
  ia.buildings.lumberyard = 0; ia.buildings.quarry = 0; ia.buildings.goldmine = 0;
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 5000, stone: 5000, gold: 5000 };

  check('a swap before opening is refused',
    g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0).error === 'err.poolClosed');

  g.openPool(w, { wood: 4000, stone: 3600, gold: 6800 }, t0);
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  check('a swap after opening goes through', !r.error, JSON.stringify(r));
  check('at the tuned rate — gold costs less than wood', r.out > 500,
    `500 wood bought ${r.out && r.out.toFixed(1)} gold`);

  g.resolveWorld(w, r.arrive + 1);
  check('the proceeds land', close(ia.resources.gold, 5000 + r.out, 1e-9));

  // Closing mid-flight must not strand a shipment already paid for.
  const r2 = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, r.arrive + 2);
  g.closePool(w);
  const goldBefore = ia.resources.gold;
  g.resolveWorld(w, r2.arrive + 1);
  check('closing the pool does not strand a shipment in flight',
    close(ia.resources.gold, goldBefore + r2.out, 1e-9),
    `${ia.resources.gold} vs ${goldBefore + r2.out}`);
}

// ---------------------------------------------------------------- pool travel (#76)
// Flat pool travel made the pool a distance-free courier: deposit at A,
// withdraw at B, any distance, one flat hour, no merchant slot. On new worlds
// the market sits at the map centre and goods sail the real distance at
// TRADE_SPEED, floored at the old flat time. Existing worlds are stamped
// flat and stay flat.
console.log('pool travel (#76)');
{
  const FLAT = Math.round((30 * 60000) / 1); // SPEED is 1 here

  const { w, a, ia } = freshWorld();
  check('#76 a new world is stamped for distance travel', w.poolDistance === true);

  const w2 = g.createWorld();
  delete w2.poolDistance;
  g.migrateWorld(w2);
  check('#76 a migrated world keeps flat travel', w2.poolDistance === false);

  // The floor: the fix may only ever slow the pool down. An island at the
  // centre — or within 30/TRADE_SPEED fields of it — keeps the old flat time,
  // so nobody gets a FASTER pool out of the change.
  check('#76 centre island keeps the flat time', g.poolTravelMs(w, { x: 20, y: 20 }) === FLAT);
  check('#76 three fields out is still under the floor',
    g.poolTravelMs(w, { x: 20, y: 23 }) === FLAT);
  const corner = g.poolTravelMs(w, { x: 0, y: 0 });
  check('#76 the far corner pays the real distance',
    corner === Math.round(Math.hypot(20, 20) * 8 * 60000), corner);
  check('#76 farther is never faster',
    g.poolTravelMs(w, { x: 0, y: 0 }) > g.poolTravelMs(w, { x: 10, y: 10 })
    && g.poolTravelMs(w, { x: 10, y: 10 }) > FLAT);
  check('#76 a flat-stamped world ignores position',
    g.poolTravelMs(w2, { x: 0, y: 0 }) === FLAT && g.poolTravelMs(w2, { x: 20, y: 20 }) === FLAT);

  // End to end, because the unit above proves nothing if the send functions
  // never call it: a swap and a withdrawal from the corner island must both
  // arrive at the distance time, not the flat one.
  ia.buildings.harbor = 5;
  ia.buildings.storehouse = 12;
  ia.buildings.lumberyard = 0; ia.buildings.quarry = 0; ia.buildings.goldmine = 0;
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 5000, stone: 5000, gold: 5000 };
  g.openPool(w, { wood: 4000, stone: 3600, gold: 6800 }, t0);

  const swap = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  check('#76 a swap sails the distance', swap.arrive - t0 === g.poolTravelMs(w, ia),
    `${swap.arrive - t0} vs ${g.poolTravelMs(w, ia)}`);
  check('#76 which is farther than flat', swap.arrive - t0 > FLAT);

  const dep = g.sendPoolDeposit(w, a, ia, 200, t0);
  check('#76 deposit still creates no movement (it mints shares, nothing sails)',
    !dep.error && !w.movements.some((m) => m.type === 'trade' && m.depart === t0 && m.id > swap.id),
    JSON.stringify(dep));
  const wd = g.sendPoolWithdraw(w, a, ia, dep.minted, t0);
  check('#76 a withdrawal sails the distance too', wd.arrive - t0 === g.poolTravelMs(w, ia),
    `${wd.arrive - t0} vs ${g.poolTravelMs(w, ia)}`);

  // And the same actions on a flat world still take the flat time.
  const af = g.createPlayer(w2, 'Flat', 'pw', false).player;
  const iaf = g.playerIsland(w2, af.id);
  iaf.x = 0; iaf.y = 0;
  iaf.buildings.harbor = 5;
  iaf.buildings.storehouse = 12;
  iaf.buildings.lumberyard = 0; iaf.buildings.quarry = 0; iaf.buildings.goldmine = 0;
  g.resolveIsland(iaf, t0);
  iaf.resources = { wood: 5000, stone: 5000, gold: 5000 };
  g.openPool(w2, { wood: 4000, stone: 3600, gold: 6800 }, t0);
  const fswap = g.sendPoolSwap(w2, af, iaf, 'wood', 'gold', 500, t0);
  check('#76 the same corner island on a flat world swaps at the flat time',
    fswap.arrive - t0 === FLAT, fswap.arrive - t0);
}

// ---------------------------------------------------------------- liquidity
// Depositing is how the pool gets deep without minting, so the property that
// matters most is that it moves resources without moving the PRICE — and that
// a deposit-then-withdraw round trip never comes back with more than it took.
console.log('pool liquidity');

function lpWorld(reserves = { wood: 10000, stone: 9200, gold: 16000 }) {
  const { w, a, b, ia } = freshWorld();
  // Harbour 10 = 9,611 per shipment. A deposit ships ALL THREE legs, so the
  // total is roughly 3.52x the wood leg — harbour 8 (4,271) could not carry a
  // 2,000-wood deposit at all, which is how the first run failed.
  ia.buildings.harbor = 10;
  ia.buildings.storehouse = 14;
  ia.buildings.lumberyard = 0; ia.buildings.quarry = 0; ia.buildings.goldmine = 0;
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 20000, stone: 20000, gold: 20000 };
  g.openPool(w, reserves, t0);
  return { w, a, b, ia };
}

{
  // The preview and the action must agree, because they are the same code.
  const { w, a, ia } = lpWorld();
  const plan = g.planPoolDeposit(w, ia, 1000);
  check('a plan is returned', !plan.error, JSON.stringify(plan));
  const r = g.sendPoolDeposit(w, a, ia, 1000, t0);
  check('the deposit mints exactly what the plan said', close(r.minted, plan.minted));
  check('and takes exactly what the plan said',
    !r.error && g.RESOURCES.every((x) => close(r.required?.[x], plan.required?.[x])));
  // Purity, properly: snapshot, plan, compare. The old version ran after
  // sendPoolDeposit had already mutated the pool and only asserted
  // totalShares > 0, which could not have caught a mutation inside the
  // planner at all.
  const clean = lpWorld();
  const poolBefore = JSON.stringify(clean.w.pool);
  const islandBefore = JSON.stringify(clean.ia.resources);
  const sharesBefore = clean.a.lpShares;
  g.planPoolDeposit(clean.w, clean.ia, 1000);
  check('planPoolDeposit mutates nothing',
    JSON.stringify(clean.w.pool) === poolBefore
    && JSON.stringify(clean.ia.resources) === islandBefore
    && clean.a.lpShares === sharesBefore);

  const dep2 = g.sendPoolDeposit(clean.w, clean.a, clean.ia, 1000, t0);
  const poolAfterDep = JSON.stringify(clean.w.pool);
  const sharesAfterDep = clean.a.lpShares;
  g.planPoolWithdraw(clean.w, clean.a, clean.ia, dep2.minted);
  check('planPoolWithdraw mutates nothing',
    JSON.stringify(clean.w.pool) === poolAfterDep && clean.a.lpShares === sharesAfterDep);
}

{
  // Price is untouched: a deposit adds size at the same rate, it does not
  // trade. This is the whole reason player liquidity beats minting.
  const { w, a, ia } = lpWorld();
  const before = g.RESOURCES.map((r) => g.poolSpot(w.pool.reserves, 'wood', r));
  const r = g.sendPoolDeposit(w, a, ia, 2000, t0);
  check('a deposit is accepted', !r.error, JSON.stringify(r));
  const after = g.RESOURCES.map((x) => g.poolSpot(w.pool.reserves, 'wood', x));
  check('a deposit does not move any price',
    before.every((p, i) => close(p, after[i], 1e-9)), `${before} -> ${after}`);
  check('the legs follow the pool ratio',
    !r.error && close(r.required.gold / r.required.wood, 16000 / 10000),
    JSON.stringify(r));
  // The ratio alone is not enough: poolAddLiquidity scales to the tightest
  // leg, so a `desired` computed wrongly still comes out proportional, merely
  // smaller. Asking for 2000 wood must cost exactly 2000 wood.
  check('the wood leg is exactly what was asked for',
    !r.error && close(r.required.wood, 2000), `took ${r.required?.wood}`);
  check('the island paid exactly the required legs',
    !r.error && g.RESOURCES.every((x) => close(ia.resources[x], 20000 - r.required[x])));
  check('the depositor holds the minted shares', !r.error && close(a.lpShares, r.minted));
  // The reported share is of the POOL, not of your own deposit — minted/shares
  // is 1 for a first-time depositor and would read as owning all of it.
  check('and the reported share is of the whole pool',
    !r.error && close(r.share, a.lpShares / w.pool.totalShares) && r.share < 0.2,
    `share ${r.share}`);
  check('the pool grew by what was paid in',
    !r.error && close(w.pool.reserves.wood, 10000 + r.required.wood));
}

{
  // No free money. Deposit then immediately withdraw the same shares must not
  // return more than went in.
  const { w, a, ia } = lpWorld();
  const dep = g.sendPoolDeposit(w, a, ia, 1000, t0);
  const wd = g.sendPoolWithdraw(w, a, ia, dep.minted, t0);
  check('withdrawing accepted', !wd.error, JSON.stringify(wd));
  check('a same-instant round trip returns no more than it deposited',
    !wd.error && !dep.error && g.RESOURCES.every((x) => wd.out[x] <= dep.required[x] + 1e-9),
    JSON.stringify({ out: wd.out, paid: dep.required }));
  check('the shares are burned', close(a.lpShares, 0));
  check('the pool is back where it started', close(w.pool.reserves.wood, 10000));
  check('and the seed stake is untouched', close(w.pool.totalShares, Math.sqrt(10000 * 9200)));
}

{
  // Fees earned while you were in the pool are the return.
  const { w, a, b, ia } = lpWorld();
  const dep = g.sendPoolDeposit(w, a, ia, 2000, t0);
  // Someone else trades against it.
  const ib = g.playerIsland(w, b.id);
  ib.buildings.harbor = 10; ib.buildings.storehouse = 14;
  ib.buildings.lumberyard = 0; ib.buildings.quarry = 0; ib.buildings.goldmine = 0;
  g.resolveIsland(ib, t0);
  ib.resources = { wood: 9000, stone: 9000, gold: 9000 };
  for (let i = 0; i < 4; i++) g.sendPoolSwap(w, b, ib, 'wood', 'gold', 1000, t0);
  for (let i = 0; i < 4; i++) g.sendPoolSwap(w, b, ib, 'gold', 'wood', 1000, t0);
  const wd = g.sendPoolWithdraw(w, a, ia, dep.minted, t0);
  const inK = dep.error ? NaN : Math.sqrt(dep.required.wood * dep.required.gold);
  const outK = wd.error ? NaN : Math.sqrt(wd.out.wood * wd.out.gold);
  check('trading while you are in the pool leaves you better off',
    outK > inK, `sqrt(k) in ${inK.toFixed(1)} -> out ${outK.toFixed(1)}`);
}

{
  // Withdrawal ships home, so it is a movement and lands later.
  const { w, a, ia } = lpWorld();
  const dep = g.sendPoolDeposit(w, a, ia, 1000, t0);
  const woodAfterDeposit = ia.resources.wood;
  const wd = g.sendPoolWithdraw(w, a, ia, dep.minted, t0);
  check('nothing is credited at the moment of withdrawal',
    !wd.error && close(ia.resources.wood, woodAfterDeposit), JSON.stringify(wd));
  check('a shipment is created', w.movements.filter((m) => m.type === 'trade').length === 1);
  g.resolveWorld(w, wd.arrive + 1);
  check('the slice arrives', !wd.error && close(ia.resources.wood, woodAfterDeposit + wd.out.wood, 1e-9),
    JSON.stringify(wd));
}

{
  // Refusals.
  const { w, a, ia } = lpWorld();
  const shut = lpWorld(); g.closePool(shut.w);
  check('a closed pool takes no deposits',
    g.sendPoolDeposit(shut.w, shut.a, shut.ia, 100, t0).error === 'err.poolClosed');

  const noHarbor = lpWorld(); noHarbor.ia.buildings.harbor = 0;
  check('depositing needs a harbour',
    g.sendPoolDeposit(noHarbor.w, noHarbor.a, noHarbor.ia, 100, t0).error === 'err.buildFirst');

  for (const bad of [0, -100, NaN, 'abc', null, undefined]) {
    const r = g.sendPoolDeposit(w, a, ia, bad, t0);
    check(`deposit of ${String(bad)} is refused`, r.error === 'err.tradeAmount', JSON.stringify(r));
  }
  check('a deposit beyond the island is refused',
    g.sendPoolDeposit(w, a, ia, 999999, t0).error === 'err.noResources');
  // A deposit ships all three legs, so the total is several times the wood leg
  // typed. The plain "shipment too heavy — carries 563" message read as
  // nonsense next to a request for 200, so the error names the real total and
  // what would fit.
  const heavy = g.sendPoolDeposit(w, a, ia, 5000, t0);
  check('a deposit beyond the harbour is refused',
    heavy.error === 'err.poolDepositCapacity', JSON.stringify(heavy));
  const cap = g.tradeCapacity(ia.buildings.harbor);
  check('and reports the total it would have shipped, not the wood leg',
    heavy.errorParams?.total > 5000, `total ${heavy.errorParams?.total}`);
  check('and the harbour limit', heavy.errorParams?.cap === cap);
  check('and a wood leg that would actually fit',
    heavy.errorParams?.max > 0 && heavy.errorParams.max < 5000,
    `max ${heavy.errorParams?.max}`);
  // On a fresh world: this one succeeds, and this block's premise is that
  // nothing in it moves.
  const fresh = lpWorld();
  fresh.ia.buildings.harbor = ia.buildings.harbor;
  const fits = g.sendPoolDeposit(fresh.w, fresh.a, fresh.ia, heavy.errorParams.max, t0);
  check('and that suggestion really does fit', !fits.error, JSON.stringify(fits));
  check('none of that moved anything', ia.resources.wood === 20000 && a.lpShares === 0);

  check('withdrawing with no stake is refused',
    g.sendPoolWithdraw(w, a, ia, 100, t0).error === 'err.poolNoShares');
  for (const bad of [0, -5, NaN, 'abc']) {
    check(`withdrawing ${String(bad)} shares is refused`,
      g.sendPoolWithdraw(w, a, ia, bad, t0).error === 'err.poolNoShares');
  }
}

{
  // Withdrawal ships home, so it must refuse a slice that would not fit on
  // arrival — same rule as a swap, and nothing was exercising it.
  const { w, a, ia } = lpWorld();
  const dep = g.sendPoolDeposit(w, a, ia, 1000, t0);
  check('deposited for the storehouse test', !dep.error, JSON.stringify(dep));
  ia.buildings.storehouse = 1;            // capacity 600
  ia.resources = { wood: 590, stone: 590, gold: 590 };
  const wd = g.sendPoolWithdraw(w, a, ia, dep.minted, t0);
  check('a withdrawal that would overflow the storehouse is refused',
    wd.error === 'err.poolStorage', JSON.stringify(wd));
  check('and the shares are not burned', close(a.lpShares, dep.minted));
  check('and nothing is shipped', !w.movements.some((m) => m.type === 'trade'));
}

{
  // A shipment already inbound counts against the room, exactly as it does for
  // a swap. Isolated from the resources-alone case: without the inbound leg
  // this withdrawal fits.
  const { w, a, ia } = lpWorld();
  const dep = g.sendPoolDeposit(w, a, ia, 1000, t0);
  ia.buildings.storehouse = 4;                    // capacity 2025
  ia.resources = { wood: 900, stone: 900, gold: 300 };
  const ok = g.sendPoolWithdraw(w, a, ia, dep.minted, t0);
  check('the withdrawal fits with nothing inbound', !ok.error, JSON.stringify(ok));

  const blocked = lpWorld();
  const dep2 = g.sendPoolDeposit(blocked.w, blocked.a, blocked.ia, 1000, t0);
  blocked.ia.buildings.storehouse = 4;
  blocked.ia.resources = { wood: 900, stone: 900, gold: 300 };
  blocked.w.movements.push({
    id: 9101, type: 'trade', ownerId: blocked.a.id,
    fromId: blocked.ia.id, toId: blocked.ia.id, units: g.zeroUnits(),
    loot: { wood: 0, stone: 0, gold: 200 }, depart: t0, arrive: t0 + 60000,
  });
  const no = g.sendPoolWithdraw(blocked.w, blocked.a, blocked.ia, dep2.minted, t0);
  check('but an inbound shipment tips it over the storehouse',
    no.error === 'err.poolStorage', JSON.stringify(no));
  check('and the shares survive the refusal', close(blocked.a.lpShares, dep2.minted));

  // ...but only shipments that land BEFORE ours, and only to THIS island.
  // Both filters need a negative case or they can be deleted unnoticed.
  const late = lpWorld();
  const dep3 = g.sendPoolDeposit(late.w, late.a, late.ia, 1000, t0);
  late.ia.buildings.storehouse = 4;
  late.ia.resources = { wood: 900, stone: 900, gold: 300 };
  late.w.movements.push({
    id: 9102, type: 'trade', ownerId: late.a.id,
    fromId: late.ia.id, toId: late.ia.id, units: g.zeroUnits(),
    loot: { wood: 0, stone: 0, gold: 200 },
    depart: t0, arrive: t0 + 4 * H,          // lands long after ours does
  });
  check('a shipment arriving after ours does not block it',
    !g.sendPoolWithdraw(late.w, late.a, late.ia, dep3.minted, t0).error);

  const elsewhere = lpWorld();
  const dep4 = g.sendPoolDeposit(elsewhere.w, elsewhere.a, elsewhere.ia, 1000, t0);
  elsewhere.ia.buildings.storehouse = 4;
  elsewhere.ia.resources = { wood: 900, stone: 900, gold: 300 };
  const other = g.playerIsland(elsewhere.w, elsewhere.b.id);
  elsewhere.w.movements.push({
    id: 9103, type: 'trade', ownerId: elsewhere.b.id,
    fromId: other.id, toId: other.id, units: g.zeroUnits(),
    loot: { wood: 0, stone: 0, gold: 200 }, depart: t0, arrive: t0 + 60000,
  });
  check('a shipment to someone else does not block it',
    !g.sendPoolWithdraw(elsewhere.w, elsewhere.a, elsewhere.ia, dep4.minted, t0).error);
}

{
  // Over-withdrawal is clamped to what you hold, never more.
  const { w, a, ia } = lpWorld();
  const dep = g.sendPoolDeposit(w, a, ia, 1000, t0);
  const wd = g.sendPoolWithdraw(w, a, ia, 1e9, t0);
  check('asking for more shares than you hold burns only what you hold',
    !wd.error && close(wd.burned, dep.minted) && close(a.lpShares, 0), JSON.stringify(wd));
  check('and never returns more than your slice',
    !wd.error && wd.out.wood <= dep.required.wood + 1e-9);

  // Slippage guard on deposits too.
  const s = lpWorld();
  const plan = g.planPoolDeposit(s.w, s.ia, 1000);
  check('a deposit below minShares is refused',
    g.sendPoolDeposit(s.w, s.a, s.ia, 1000, t0, (plan.minted || 1) * 2).error === 'err.poolSlippage');
  check('an unusable minShares is a bad request',
    g.sendPoolDeposit(s.w, s.a, s.ia, 1000, t0, 'abc').error === 'err.badRequest');
  check('and neither attempt minted anything', s.a.lpShares === 0);
}

// ---------------------------------------------------------------- display of loot
// Pool swaps and withdrawals are the first source of FRACTIONAL loot in the
// game: combat floors it, sendTrade floors it, and market offers are integers.
// So the report text and the movements list had never met a non-integer and
// printed one raw at a player: "Shipment ... with 107.20775939008854 wood".
//
// The stored value stays fractional on purpose. The pool debited exactly
// `out`, so flooring at creation would either destroy the remainder or force
// the quote to floor too, reopening the quote-versus-delivery seam.
console.log('loot display');

{
  const { w, a, ia } = lpWorld();
  const r = g.sendPoolSwap(w, a, ia, 'gold', 'wood', 173, t0);
  check('a pool swap really does produce fractional loot',
    !r.error && r.out % 1 !== 0, `out ${r.out}`);
  const mv = w.movements.find((m) => m.type === 'trade');
  check('and the movement carries it at full precision',
    close(mv.loot.wood, r.out), `${mv.loot.wood} vs ${r.out}`);

  g.resolveWorld(w, r.arrive + 1);
  const rep = w.reports.filter((x) => x.ownerId === a.id).pop();
  const line = (rep.lines || []).join(' ');
  check('but the report text shows a whole number',
    /\b106 wood\b/.test(line) && !/106\.\d/.test(line), line);
  check('the island still receives the exact fractional amount',
    ia.resources.wood % 1 !== 0);
}

// ---------------------------------------------------------------- pool swaps
// The first code that can move a player's resources (#46 step 5). Everything
// before this was inert, so these carry the weight.
//
// Two properties matter more than any individual number. Resources must be
// conserved end to end — what leaves the island equals what enters the pool,
// and what leaves the pool equals what arrives back. And the pool must move
// at SEND time, not on arrival: if the price only moved when goods landed, a
// player could fire a dozen swaps at the same opening rate and strip a
// reserve before any of them arrived.
console.log('pool swaps');

// An island that can actually trade: harbour, deep storehouse, known stock.
// Stock is set AFTER resolveIsland, because accrual clamps to the storehouse
// and would otherwise quietly rewrite the fixture.
function poolWorld(reserves = { wood: 4000, stone: 3600, gold: 6800 }, harbor = 5) {
  const { w, a, ia } = freshWorld();
  ia.buildings.harbor = harbor;  // level 5 carries 1265
  ia.buildings.storehouse = 12;
  // Production off. These tests are about what a swap moves, and an island
  // quietly earning wood mid-flight makes exact conservation unassertable —
  // the arrival check was out by the nine gold the mine produced in transit.
  ia.buildings.lumberyard = 0;
  ia.buildings.quarry = 0;
  ia.buildings.goldmine = 0;
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 5000, stone: 5000, gold: 5000 };
  Object.assign(w.pool, {
    open: true,
    reserves: { ...reserves },
    seeded: { ...reserves },
    totalShares: 1000,
  });
  return { w, a, ia };
}
const poolTotal = (w, ia) =>
  g.RESOURCES.reduce((n, r) => n + w.pool.reserves[r] + ia.resources[r], 0)
  + w.movements.reduce((n, m) => n + g.RESOURCES.reduce((x, r) => x + (m.loot ? m.loot[r] : 0), 0), 0);

{
  // Refusals, in the order a request meets them.
  const { w, a, ia } = poolWorld();
  w.pool.open = false;
  check('a closed pool refuses to trade',
    g.sendPoolSwap(w, a, ia, 'wood', 'gold', 100, t0).error === 'err.poolClosed');
  w.pool.open = true;

  const noHarbor = poolWorld();
  noHarbor.ia.buildings.harbor = 0;
  check('swapping needs a harbour',
    g.sendPoolSwap(noHarbor.w, noHarbor.a, noHarbor.ia, 'wood', 'gold', 100, t0).error === 'err.buildFirst');

  check('cannot swap a resource for itself',
    g.sendPoolSwap(w, a, ia, 'wood', 'wood', 100, t0).error === 'err.badRequest');
  check('cannot swap an unknown resource',
    g.sendPoolSwap(w, a, ia, 'wood', 'iron', 100, t0).error === 'err.badRequest');
  // Call once and reuse. Arguments are evaluated eagerly, so passing the
  // detail as a second call ran the mutating function twice per iteration —
  // harmless while these all return before touching anything, but it would
  // report on a different call than the one asserted the moment they didn't.
  for (const bad of [0, -100, NaN, 'abc', null, undefined]) {
    const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', bad, t0);
    check(`amount ${String(bad)} is refused`, r.error === 'err.tradeAmount', JSON.stringify(r));
  }
  check('cannot swap what the island does not hold',
    g.sendPoolSwap(w, a, ia, 'wood', 'gold', 999999, t0).error === 'err.noResources');
  check('the harbour caps the shipment',
    g.sendPoolSwap(w, a, ia, 'wood', 'gold', 2000, t0).error === 'err.tradeCapacity',
    `cap is ${g.tradeCapacity(5)}`);
  check('nothing above changed the pool',
    w.pool.reserves.wood === 4000 && w.pool.reserves.gold === 6800);
  check('and nothing above created a movement', w.movements.length === 0);
}

{
  // Slippage protection: the quote a player saw may be stale by the time they act.
  const { w, a, ia } = poolWorld();
  const fair = g.poolQuote(w.pool.reserves, 'wood', 'gold', 500, g.poolOpts(w.pool)).out;
  check('a swap below minOut is refused',
    g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0, fair + 1).error === 'err.poolSlippage');
  check('a refused swap leaves the pool untouched', w.pool.reserves.wood === 4000);
  check('a swap meeting minOut goes through',
    !g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0, fair).error);

  // An unusable minOut must be an error, not a silently disabled guard. A
  // caller that asked for protection and got none is worse off than one that
  // knew it had none.
  const fresh = poolWorld();
  for (const bad of [NaN, 'abc', -1, Infinity, {}]) {
    const r = g.sendPoolSwap(fresh.w, fresh.a, fresh.ia, 'wood', 'gold', 500, t0, bad);
    check(`minOut ${String(bad)} is rejected, not ignored`, r.error === 'err.badRequest',
      JSON.stringify(r));
  }
  check('a rejected minOut moved nothing', fresh.ia.resources.wood === 5000);
  // null/undefined still mean "no protection asked for".
  check('omitting minOut is still allowed',
    !g.sendPoolSwap(fresh.w, fresh.a, fresh.ia, 'wood', 'gold', 500, t0, null).error);
}

{
  // The storehouse guard has to look at room on ARRIVAL, not room now. The
  // ship is half an hour out and the store keeps filling while it sails.
  const { w, a, ia } = poolWorld();
  ia.buildings.storehouse = 1;                  // capacity 600
  ia.buildings.goldmine = 10;                   // ~499 gold/h, so ~250 over the crossing
  ia.resources = { wood: 500, stone: 0, gold: 300 };
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 100, t0);
  check('production during the crossing is counted against the room',
    r.error === 'err.poolStorage', JSON.stringify(r));

  // Same island, production off: now there is genuinely room and it passes.
  const idle = poolWorld();
  idle.ia.buildings.storehouse = 1;
  idle.ia.resources = { wood: 500, stone: 0, gold: 300 };
  check('with nothing accruing, the same swap is allowed',
    !g.sendPoolSwap(idle.w, idle.a, idle.ia, 'wood', 'gold', 100, t0).error);
}

{
  // A shipment already inbound counts too — it lands before ours does.
  const { w, a, ia } = poolWorld();
  ia.buildings.storehouse = 1;                  // capacity 600
  ia.resources = { wood: 500, stone: 0, gold: 300 };
  check('with no shipment inbound the swap is fine',
    !g.sendPoolSwap(w, a, ia, 'wood', 'gold', 100, t0).error);

  const blocked = poolWorld();
  blocked.ia.buildings.storehouse = 1;
  blocked.ia.resources = { wood: 500, stone: 0, gold: 300 };
  blocked.w.movements.push({
    id: 9001, type: 'trade', ownerId: blocked.a.id,
    fromId: blocked.ia.id, toId: blocked.ia.id, units: g.zeroUnits(),
    loot: { wood: 0, stone: 0, gold: 290 }, depart: t0, arrive: t0 + 60000,
  });
  const r = g.sendPoolSwap(blocked.w, blocked.a, blocked.ia, 'wood', 'gold', 100, t0);
  check('a shipment already inbound is counted against the room',
    r.error === 'err.poolStorage', JSON.stringify(r));
}

{
  // A full storehouse: refuse rather than deliver into an overflow, because
  // arrival clamps and the paid-for surplus would simply evaporate.
  const { w, a, ia } = poolWorld();
  ia.buildings.storehouse = 1;                 // capacity 600
  ia.resources = { wood: 500, stone: 0, gold: 595 };
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 100, t0);
  check('a swap that would overflow the storehouse is refused', r.error === 'err.poolStorage');
  check('and says how much room is left', r.errorParams?.room === 5, JSON.stringify(r.errorParams));
  check('the island keeps its wood', ia.resources.wood === 500);
}

{
  // Conservation. This is the one that matters.
  const { w, a, ia } = poolWorld();
  const before = poolTotal(w, ia);
  const woodBefore = ia.resources.wood;
  const poolWoodBefore = w.pool.reserves.wood;
  const poolGoldBefore = w.pool.reserves.gold;

  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  check('a swap is accepted', !r.error, JSON.stringify(r));
  check('the island pays exactly what was used', ia.resources.wood === woodBefore - r.used);
  check('the pool gains exactly what was used', w.pool.reserves.wood === poolWoodBefore + r.used);
  check('the pool gives up exactly what was quoted', w.pool.reserves.gold === poolGoldBefore - r.out);
  check('the island is not credited before the ship lands', ia.resources.gold === 5000);
  check('the shipment carries exactly the proceeds',
    w.movements[0].loot.gold === r.out && w.movements[0].loot.wood === 0);
  check('nothing is created or destroyed in flight', close(poolTotal(w, ia), before),
    `${before} -> ${poolTotal(w, ia)}`);

  // ...and across arrival. With production off this is exact, not approximate.
  g.resolveWorld(w, r.arrive + 1);
  check('the proceeds arrive', close(ia.resources.gold, 5000 + r.out, 1e-9),
    `${ia.resources.gold} vs ${5000 + r.out}`);
  check('no movement is left behind', w.movements.length === 0);
  check('nothing is created or destroyed across arrival either',
    close(poolTotal(w, ia), before), `${before} -> ${poolTotal(w, ia)}`);
}

{
  // The anti-exploit property: the price moves when the order is placed.
  const { w, a, ia } = poolWorld();
  const first = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  const second = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  const third = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  check('back-to-back swaps get progressively worse prices',
    first.out > second.out && second.out > third.out,
    `${first.out.toFixed(1)} > ${second.out.toFixed(1)} > ${third.out.toFixed(1)}`);
  check('three swaps in flight at once', w.movements.length === 3);
  check('the pool already reflects all three, before any has landed',
    close(w.pool.reserves.wood, 4000 + first.used + second.used + third.used));
}

{
  // Partial fill: the drain cap bites, and the player is charged only for
  // what actually traded.
  // A thin gold reserve of 100 caps output at 30, but maxIn is still ~1720 —
  // so a harbour that can only carry 1265 never reaches the cap. Needs level 8
  // (4271) to get an order big enough to be clamped by the pool rather than
  // by the docks.
  const { w, a, ia } = poolWorld({ wood: 4000, stone: 3600, gold: 100 }, 8);
  const woodBefore = ia.resources.wood;
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 3000, t0);
  check('an oversized swap fills partially rather than failing',
    !r.error && r.capped === true, JSON.stringify(r));
  check('the cap holds it to 30% of the reserve', close(r.out, 30), `out ${r.out}`);
  check('and the island is charged only for what traded',
    close(ia.resources.wood, woodBefore - r.used) && r.used < 3000,
    `used ${r.used}`);
}

{
  // Fractional amounts are floored, as everywhere else a player names a
  // quantity (sendTrade does the same). Nothing exercised this, so dropping
  // the floor() went unnoticed.
  const { w, a, ia } = poolWorld();
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500.9, t0);
  check('a fractional amount is floored', !r.error && close(r.used, 500), `used ${r.used}`);
  check('and the island is charged the whole number', close(ia.resources.wood, 4500));
}

{
  // A reserve on its floor sells nothing at all, and says so.
  const { w, a, ia } = poolWorld();
  w.pool.reserves.gold = w.pool.seeded.gold * 0.25; // exactly the floor
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  check('a reserve on its floor refuses the swap', r.error === 'err.poolDry');
  check('and the island pays nothing for the refusal', ia.resources.wood === 5000);
}

{
  // Fees accrue to the reserves, so the pool is worth more per share after
  // trading than before — which is the whole return an LP gets.
  const { w, a, ia } = poolWorld();
  const k = (p) => Math.sqrt(p.reserves.wood * p.reserves.gold);
  const kBefore = k(w.pool);
  g.sendPoolSwap(w, a, ia, 'wood', 'gold', 500, t0);
  check('trading grows the pool invariant, so shares appreciate', k(w.pool) > kBefore);
  check('and the share count is untouched by trading', w.pool.totalShares === 1000);
}

// ---------------------------------------------------------------- diplomacy & board

console.log('diplomacy & board');
{
  const { w, a, b } = freshWorld();
  const c = g.createPlayer(w, 'C', 'pw', false).player;
  g.createAlliance(w, a, 'Wolves', 'WOLF');
  g.createAlliance(w, b, 'Bears', 'BEAR');

  check('non-leader cannot set stances', (() => {
    // c joins WOLF as a regular member
    g.inviteToAlliance(w, a, 'C', t0);
    g.acceptInvite(w, c, a.allianceId);
    return g.setStance(w, c, b.allianceId, 'war', t0).error === 'err.notLeader';
  })());

  // mutual ally requires both sides
  g.setStance(w, a, b.allianceId, 'ally', t0);
  check('one-sided ally is not effective',
    g.allianceRelation(w, a.allianceId, b.allianceId) === null);
  g.setStance(w, b, a.allianceId, 'ally', t0);
  check('mutual ally is effective',
    g.allianceRelation(w, a.allianceId, b.allianceId) === 'ally');

  // pact blocks attacks between members
  const ia = g.playerIsland(w, a.id), ib2 = g.playerIsland(w, b.id);
  ia.units.raider = 10;
  check('pact blocks the attack',
    g.sendAttack(w, a, ia, ib2, { raider: 10 }, t0).error === 'err.pact');

  // war is unilateral and overrides, with reports to both sides
  const reportsBefore = w.reports.length;
  g.setStance(w, b, a.allianceId, 'war', t0);
  check('war overrides the old friendship',
    g.allianceRelation(w, a.allianceId, b.allianceId) === 'war');
  check('war declaration notifies both alliances', w.reports.length >= reportsBefore + 3);
  check('attacks flow again in wartime',
    !g.sendAttack(w, a, ia, ib2, { raider: 10 }, t0).error);

  // board
  check('outsiders cannot post', (() => {
    const d = g.createPlayer(w, 'D', 'pw', false).player;
    return g.postBoard(w, d, 'hello', t0).error === 'err.noAlliance';
  })());
  g.postBoard(w, a, 'Muster at dawn.', t0);
  g.postBoard(w, c, 'Aye.', t0 + 1000);
  check('members post to the board', w.boards[a.allianceId].length === 2);
  for (let i = 0; i < 60; i++) g.postBoard(w, a, 'spam ' + i, t0 + 2000 + i);
  check('board capped at 50 posts', w.boards[a.allianceId].length === 50);
}
{
  // human scout intel is captured and shareable
  const { w, a, b, ia, ib } = freshWorld();
  ia.units.scout = 5;
  ib.units.sentinel = 4;
  const r = g.sendScout(w, a, ia, ib, 5, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('human scouts store machine intel',
    a.intel && a.intel[ib.id] && a.intel[ib.id].def >= 4 * 30);
}

// ---------------------------------------------------------------- quests

console.log('quests');
{
  const { w, a, b, ia } = freshWorld();
  g.checkQuests(w, a, t0);
  let q = g.currentQuest(w, a);
  check('new player starts on quest 1/8', q && q.i === 1 && q.n === 8);

  // complete quest 1: lumberyard to 2
  g.resolveIsland(ia, t0);
  ia.resources = { wood: 0, stone: 0, gold: 0 };
  ia.buildings.lumberyard = 2;
  g.checkQuests(w, a, t0);
  check('quest 1 auto-completes and advances', g.currentQuest(w, a).i === 2);
  check('reward delivered', ia.resources.wood >= 50 && ia.resources.gold >= 25);
  check('completion report written',
    w.reports.some((x) => x.ownerId === a.id && x.title.startsWith('Quest complete')));

  // training counter feeds quest 4
  ia.buildings.barracks = 1;
  ia.buildings.storehouse = 2;
  ia.resources = { wood: 800, stone: 800, gold: 800 };
  g.tryTrain(w, ia, 'spearman', 5, t0);
  g.checkQuests(w, a, t0);
  check('state quests chain-clear (store2, barracks1, train5)', g.currentQuest(w, a).i === 5);

  // wins counter feeds quest 6
  ia.buildings.wall = 1;
  g.checkQuests(w, a, t0);
  check('wall quest cleared', g.currentQuest(w, a).i === 6);
  ia.units.raider = 20;
  const r = g.sendAttack(w, a, ia, g.playerIsland(w, b.id), { raider: 20 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  g.checkQuests(w, a, r.arrive + 1);
  check('first victory clears the battle quest', g.currentQuest(w, a).i === 7);

  // harbor + second island finish the chain
  ia.buildings.harbor = 1;
  const free = g.newUnchartedIsland(w);
  free.ownerId = a.id;
  g.checkQuests(w, a, r.arrive + 2);
  check('chain finished — no quest shown', g.currentQuest(w, a) === null);
  check('quest rewards clamp at storehouse capacity',
    ia.resources.wood <= g.storageCapacity(ia.buildings.storehouse));
}
{
  const w = g.createWorld();
  const bot = g.createPlayer(w, 'Reef Rat', null, true).player;
  g.checkQuests(w, bot, t0);
  check('bots have no quests', g.currentQuest(w, bot) === null);
}

// ---------------------------------------------------------------- morale & victory

console.log('morale & victory');
{
  // Equal points: 10 raiders (A=240) crush 7 sentinels (D=210)...
  const w1 = freshWorld();
  w1.ia.units.raider = 10; w1.ib.units.sentinel = 7;
  const r1 = g.sendAttack(w1.w, w1.a, w1.ia, w1.ib, { raider: 10 }, t0);
  g.resolveWorld(w1.w, r1.arrive + 1);
  check('equal-points attack wins at full strength', g.totalUnits(w1.ib.units) === 0);

  // ...but a giant attacking a minnow fights at reduced morale and bounces.
  const w2 = freshWorld();
  Object.assign(w2.ia.buildings, { lumberyard: 12, quarry: 12, goldmine: 12, hall: 8 });
  w2.ia.units.raider = 10; w2.ib.units.sentinel = 7;
  const r2 = g.sendAttack(w2.w, w2.a, w2.ia, w2.ib, { raider: 10 }, t0);
  g.resolveWorld(w2.w, r2.arrive + 1);
  check('morale blunts a giant bullying a minnow', w2.ib.units.sentinel > 0);
  check('morale line in the attacker report',
    w2.w.reports.some((x) => x.ownerId === w2.a.id && x.lines.some((l) => l.includes('morale'))));
}
{
  const { w, a, b } = freshWorld();
  // b holds 1 island; hand a everything else plus enough uncharted claims
  for (let i = 0; i < 8; i++) g.newUnchartedIsland(w);
  for (const island of w.islands) {
    if (island.ownerId == null || island.ownerId === a.id) island.ownerId = a.id;
  }
  // a owns 9 of 10 = 90% >= 60%
  const win = g.checkVictory(w, t0);
  check('dominant player wins the world', !!win && win.name === 'A' && win.share >= 60);
  check('winner recorded on the world', w.winner && w.winner.islands === win.islands);
  check('humans got the announcement',
    w.reports.filter((x) => x.title === 'The world has been won!').length === 2);
  check('victory fires only once', g.checkVictory(w, t0 + 1000) === null);
}

// ---------------------------------------------------------------- bot personalities (#22)

console.log('bot personalities');
{
  const { spawnBots, personaOf, rollPersona } = await import('./bots.js');
  const w = g.createWorld();
  spawnBots(w, 20);
  const kinds = w.players.map((p) => p.persona.kind);
  const count = (k) => kinds.filter((x) => x === k).length;
  check('default mix spawns 15 settlers, 2 warlords, 3 barbarians',
    count('settler') === 15 && count('warlord') === 2 && count('barbarian') === 3);
  check('personas carry a temperament vector',
    w.players.every((p) => p.persona.tempo > 0 && p.persona.prodBias
      && p.persona.trainMix && p.persona.sleepStart >= 0));
  check('legacy bots fall back to the neutral persona',
    personaOf({}).tempo === 1 && personaOf({}).sleepLen === 0 && personaOf({}).kind === 'settler');
}
{
  // Barbarians never aggress — armed to the teeth, provoked, and pacifist.
  const { botTick, rollPersona } = await import('./bots.js');
  const { w, a, ia } = freshWorld();
  const barb = g.createPlayer(w, 'Peaceful Pete', null, true).player;
  barb.persona = { ...rollPersona('barbarian'), tempo: 1, sleepLen: 0 };
  const bi = g.playerIsland(w, barb.id);
  bi.x = 0; bi.y = 3;
  bi.units.raider = 50; bi.units.scout = 10; bi.units.colonyship = 1; bi.units.flagship = 1;
  Object.assign(bi.buildings, { barracks: 3, harbor: 2 });
  barb.grudges = { [a.id]: 9 };
  barb.intel = { [ia.id]: { def: 0, time: t0 } };
  g.newUnchartedIsland(w);
  for (let i = 0; i < 300; i++) botTick(w, t0 + i * 15000);
  check('barbarian never attacks, scouts, colonizes or conquers',
    !w.movements.some((m) => m.ownerId === barb.id));
}
{
  // Warlords hunt above their weight: far outside the band, soft intel, attack.
  const { botTick, rollPersona } = await import('./bots.js');
  const { w, a, ia } = freshWorld();
  Object.assign(ia.buildings, { lumberyard: 20, quarry: 20, goldmine: 20, hall: 15 }); // giant human
  const wolf = g.createPlayer(w, 'Undertow Jr', null, true).player;
  wolf.persona = { ...rollPersona('warlord'), tempo: 1, sleepLen: 0 };
  const wi = g.playerIsland(w, wolf.id);
  wi.x = 0; wi.y = 4; wi.units.raider = 30;
  wolf.intel = { [ia.id]: { def: 10, time: t0 } };
  check('setup: human is far above the band', g.playerPoints(w, a.id) > 3 * g.playerPoints(w, wolf.id));
  let hit = false;
  for (let i = 0; i < 400 && !hit; i++) {
    botTick(w, t0 + i * 15000);
    hit = w.movements.some((m) => m.type === 'attack' && m.ownerId === wolf.id && m.toId === ia.id);
    w.movements = w.movements.filter((m) => m.ownerId !== wolf.id);
    wi.units.raider = 30;
    wolf.intel[ia.id] = { def: 10, time: t0 + i * 15000 };
  }
  check('warlord raids far above the band on soft intel', hit);
}
{
  // Vengeance is rash: a settler with a grudge raids out-of-band and blind.
  const { botTick } = await import('./bots.js');
  const { w, a, ia } = freshWorld();
  Object.assign(ia.buildings, { lumberyard: 20, quarry: 20, goldmine: 20, hall: 15 });
  const bot = g.createPlayer(w, 'Wronged Wilma', null, true).player; // neutral settler
  const bi = g.playerIsland(w, bot.id);
  bi.x = 0; bi.y = 4; bi.units.raider = 30;
  bot.grudges = { [a.id]: 3 };
  let hit = false;
  for (let i = 0; i < 400 && !hit; i++) {
    botTick(w, t0 + i * 15000);
    hit = w.movements.some((m) => m.type === 'attack' && m.ownerId === bot.id && m.toId === ia.id);
    w.movements = w.movements.filter((m) => m.ownerId !== bot.id);
    bi.units.raider = 30;
    bot.grudges = { [a.id]: 3 };
  }
  check('grudge pierces the band with no intel at all', hit);
}
{
  // Sleep windows: same bot, same setup — asleep it does nothing, awake it acts.
  const { botTick, rollPersona, isAsleep } = await import('./bots.js');
  const mk = () => {
    const { w, a, ia } = freshWorld();
    const bot = g.createPlayer(w, 'Dozy Don', null, true).player;
    bot.persona = { ...rollPersona('settler'), tempo: 1, sleepStart: 8, sleepLen: 8 };
    const bi = g.playerIsland(w, bot.id);
    bi.x = 0; bi.y = 3; bi.units.raider = 30;
    bot.intel = { [ia.id]: { def: 0, time: t0 } };
    return { w, bot, bi, ia };
  };
  // t0 is 08:00 UTC — inside the 08-16 window; +10h is 18:00 — awake.
  check('isAsleep matches the window',
    isAsleep({ sleepStart: 8, sleepLen: 8 }, t0) && !isAsleep({ sleepStart: 8, sleepLen: 8 }, t0 + 10 * 3600e3));
  const asleep = mk();
  for (let i = 0; i < 200; i++) botTick(asleep.w, t0 + i * 1000);
  check('a sleeping bot does nothing at all',
    !asleep.w.movements.some((m) => m.ownerId === asleep.bot.id));
  const awake = mk();
  awake.bot.intel = { [awake.ia.id]: { def: 0, time: t0 + 10 * 3600e3 } };
  let acted = false;
  for (let i = 0; i < 400 && !acted; i++) {
    botTick(awake.w, t0 + 10 * 3600e3 + i * 1000);
    acted = awake.w.movements.some((m) => m.ownerId === awake.bot.id);
  }
  check('the same bot acts once awake', acted);
}
{
  // Temperament shapes progression: opposite producer biases diverge.
  const { botTick } = await import('./bots.js');
  const w = g.createWorld();
  const mkBot = (name, bias) => {
    const p = g.createPlayer(w, name, null, true).player;
    p.persona = {
      kind: 'settler', tempo: 1, sleepStart: 0, sleepLen: 0,
      prodBias: bias, storeThresh: 0.99, wallTarget: 1, hallLag: 99,
      trainMix: { sentinel: 1, spearman: 0, raider: 0 }, batch: 1,
    };
    const isl = g.playerIsland(w, p.id);
    Object.assign(isl.buildings, { hall: 30, barracks: 3, harbor: 2, wall: 6, storehouse: 20 });
    return { p, isl };
  };
  const gold = mkBot('Goldie', { lumberyard: 0.7, quarry: 1, goldmine: 1.3 });
  const timber = mkBot('Timber Tim', { lumberyard: 1.3, quarry: 1, goldmine: 0.7 });
  for (let i = 0; i < 200; i++) {
    for (const b of [gold, timber]) b.isl.resources = { wood: 900000, stone: 900000, gold: 900000 };
    botTick(w, t0 + i * 3600e3); // hourly, so queued builds complete
  }
  check('gold-biased bot runs its mine ahead of its lumberyard',
    gold.isl.buildings.goldmine > gold.isl.buildings.lumberyard);
  check('timber-biased bot does the opposite',
    timber.isl.buildings.lumberyard > timber.isl.buildings.goldmine);
}

// ---------------------------------------------------------------- wonder & hall of fame

console.log('wonder & hall of fame');
{
  const { w, a, ia } = freshWorld();
  ia.resources = { wood: 90000, stone: 90000, gold: 90000 };
  ia.buildings.storehouse = 15;
  check('Great Beacon requires Island Hall 10',
    g.tryBuild(w, ia, 'wonder', t0).error === 'err.requiresLevel');
  ia.buildings.hall = 10;
  check('with hall 10 it builds', !g.tryBuild(w, ia, 'wonder', t0).error);

  // level completions are announced to all humans, once each
  ia.queue = [];
  ia.buildings.wonder = 3;
  g.checkVictory(w, t0);
  g.checkVictory(w, t0 + 1000);
  const announcements = w.reports.filter((x) => x.title === 'The Great Beacon rises!');
  check('wonder progress announced once per level (2 humans)', announcements.length === 2);
  check('no winner below level 5', !w.winner);

  // level 5 wins the world
  ia.buildings.wonder = 5;
  const win = g.checkVictory(w, t0 + 2000);
  check('completed Beacon wins the world', !!win && win.via === 'wonder' && win.name === 'A');
  const hall = g.loadHall();
  check('hall of fame entry recorded', hall.length >= 1 &&
    hall[hall.length - 1].name === 'A' && hall[hall.length - 1].via === 'wonder');
}
{
  // the hall survives a world reset
  const before = g.loadHall().length;
  const w2 = g.createWorld(); // fresh world, same hall file
  const a2 = g.createPlayer(w2, 'Dynasty', 'pw', false).player;
  for (let i = 0; i < 3; i++) g.newUnchartedIsland(w2);
  for (const island of w2.islands) island.ownerId = a2.id;
  g.checkVictory(w2, t0);
  const hall = g.loadHall();
  check('hall persists across worlds and numbers seasons',
    hall.length === before + 1 && hall[hall.length - 1].season === before + 1);
  check('dominance entries tagged', hall[hall.length - 1].via === 'dominance');
}

// ---------------------------------------------------------------- bot AI phase 2

console.log('bot war college');
{
  const { botTick } = await import('./bots.js');
  const w = g.createWorld();
  const bot = g.createPlayer(w, 'Warbot', null, true).player;
  const prey = g.createPlayer(w, 'Prey Human', 'pw', false).player;
  prey.protectionBroken = true;
  const bi = g.playerIsland(w, bot.id);
  const pi = g.playerIsland(w, prey.id);
  bi.x = 0; bi.y = 0; pi.x = 0; pi.y = 4;
  // Prey is a real empire (>150 pts), bot is bigger and armed for conquest
  Object.assign(pi.buildings, { lumberyard: 10, quarry: 10, goldmine: 9, storehouse: 6, hall: 4 });
  Object.assign(bi.buildings, { lumberyard: 12, quarry: 12, goldmine: 11, storehouse: 8, hall: 6, barracks: 4, harbor: 2 });
  bi.units.raider = 40; bi.units.spearman = 20; bi.units.scout = 5; bi.units.flagship = 1;
  // conquest and raids require fresh intel now — seed a soft reading
  bot.intel = { [pi.id]: { def: 100, time: t0 } };

  let scouted = false, conquestSent = false;
  for (let i = 0; i < 600 && !(scouted && conquestSent); i++) {
    botTick(w, t0 + i);
    for (const m of w.movements) {
      if (m.type === 'scout' && m.ownerId === bot.id) scouted = true;
      if (m.type === 'attack' && m.ownerId === bot.id && m.units.flagship >= 1) conquestSent = true;
    }
    w.movements = w.movements.filter((m) => m.ownerId !== bot.id);
    bi.units.raider = 40; bi.units.spearman = 20; bi.units.scout = 5; bi.units.flagship = 1;
    bot.intel[pi.id] = { def: 100, time: t0 + i };
  }
  check('bot launches flagship conquest campaigns', conquestSent);
  // scouting targets islands WITHOUT fresh intel — drop the intel and watch
  bot.intel = {};
  for (let i = 0; i < 400 && !scouted; i++) {
    botTick(w, t0 + 1000 + i);
    if (w.movements.some((m) => m.type === 'scout' && m.ownerId === bot.id)) scouted = true;
    w.movements = w.movements.filter((m) => m.ownerId !== bot.id);
    bi.units.scout = 5;
    bot.intel = {}; // keep the target unknown
  }
  check('bot sends scouting missions at unknown targets', scouted);
  check('bot never raids blind (no intel, no attack)', (() => {
    bot.intel = {};
    let blind = false;
    for (let i = 0; i < 300; i++) {
      botTick(w, t0 + 2000 + i);
      if (w.movements.some((m) => m.type === 'attack' && m.ownerId === bot.id)) blind = true;
      w.movements = w.movements.filter((m) => m.ownerId !== bot.id);
      bi.units.raider = 40; bi.units.spearman = 20;
      bi.units.flagship = 0;
      bot.intel = {};
    }
    return !blind;
  })());

  // intel is captured machine-readably when bot scouts succeed
  bi.units.scout = 5;
  const r = g.sendScout(w, bot, bi, pi, 3, t0 + 100000);
  g.resolveWorld(w, r.arrive + 1);
  check('bot stores intel from scouts',
    bot.intel && bot.intel[pi.id] && typeof bot.intel[pi.id].def === 'number');

  // intel steers raids away from fortresses
  bot.intel[pi.id] = { def: 999999, time: t0 + 200000 };
  let raided = false;
  for (let i = 0; i < 400; i++) {
    botTick(w, t0 + 200000 + i);
    if (w.movements.some((m) => m.type === 'attack' && m.ownerId === bot.id && !m.units.flagship)) raided = true;
    w.movements = w.movements.filter((m) => m.ownerId !== bot.id);
    bi.units.raider = 40; bi.units.spearman = 20;
    bi.units.flagship = 0; // no conquest this round, raids only
  }
  check('bot avoids targets its intel calls fortresses', !raided);
}
{
  // small humans are never conquest targets, even when raid-eligible
  const { botTick } = await import('./bots.js');
  const w = g.createWorld();
  const bot = g.createPlayer(w, 'Warbot', null, true).player;
  const small = g.createPlayer(w, 'Small Human', 'pw', false).player;
  small.protectionBroken = true;
  const bi = g.playerIsland(w, bot.id);
  const si = g.playerIsland(w, small.id);
  bi.x = 0; bi.y = 0; si.x = 0; si.y = 3;
  Object.assign(si.buildings, { lumberyard: 6, quarry: 6, goldmine: 5 }); // ~90 pts: raidable, not conquerable
  Object.assign(bi.buildings, { lumberyard: 12, quarry: 12, goldmine: 11, barracks: 4, harbor: 2 });
  bi.units.raider = 40; bi.units.spearman = 20; bi.units.flagship = 1;
  bot.intel = { [si.id]: { def: 10, time: t0 } }; // intel says trivially soft
  let flagshipAtSmall = false;
  for (let i = 0; i < 400; i++) {
    botTick(w, t0 + i);
    if (w.movements.some((m) => m.ownerId === bot.id && m.units.flagship >= 1)) flagshipAtSmall = true;
    w.movements = w.movements.filter((m) => m.ownerId !== bot.id);
    bi.units.raider = 40; bi.units.spearman = 20; bi.units.flagship = 1;
  }
  check('bots never aim flagships at small humans', !flagshipAtSmall);
}

// ---------------------------------------------------------------- speed scaling

console.log('speed scaling');
{
  // SPEED multiplies production and divides times — capacity is fixed by design,
  // which is why very high speeds pin resources at the cap.
  // ESM has no require.cache to bust: a unique query string forces a fresh
  // evaluation of game.js under the changed GAME_SPEED.
  process.env.GAME_SPEED = '5';
  const g5 = await import('./game.js?speed=5');
  check('production scales linearly with speed',
    close(g5.productionPerHour('lumberyard', 4), 5 * 40 * 4 * Math.pow(1.12, 3)));
  check('build time divides by speed (above the 5s floor)',
    close(g5.upgradeTime('harbor', 8, 1), Math.round(300 * Math.pow(1.5, 7) / 5), 0.01));
  check('capacity does NOT scale with speed', g5.storageCapacity(2) === 900);
  process.env.GAME_SPEED = '2000';
  const g2k = await import('./game.js?speed=2000');
  check('user report: lumberyard 4 at speed 2000 → 449,577/h',
    Math.round(g2k.productionPerHour('lumberyard', 4)) === 449577);
  process.env.GAME_SPEED = '1'; // restore for anything after
}

// ---------------------------------------------------------------- map themes

console.log('map themes');
{
  const w = g.createWorld();
  check('new worlds get a theme and a seed',
    w.theme === 'generated' && Number.isInteger(w.mapSeed) && w.mapSeed >= 1);
  delete w.theme;
  delete w.mapSeed;
  g.migrateWorld(w);
  check('migration backfills theme and seed',
    w.theme === 'generated' && Number.isInteger(w.mapSeed) && w.mapSeed >= 1);

  const region = JSON.parse(fs.readFileSync(path.join(HERE, 'public/maps/aegean.json'), 'utf8'));
  const landCells = region.rows.reduce(
    (s, row) => s + [...row].filter((c) => c === '1').length, 0);
  check('aegean land mask is well-formed',
    region.w === 200 && region.h === 200 &&
    region.rows.length === 200 && region.rows.every((r) => r.length === 200));
  check('aegean mask has believable land/sea balance',
    landCells > 5000 && landCells < 30000);
  // Crete: a land run in the southern quarter
  const south = region.rows.slice(150, 175).join('');
  check('the south has islands (Crete lives)', south.includes('11111111'));
}

// ---------------------------------------------------------------- i18n

console.log('i18n');
{
  const { STRINGS, LANGS, t: tr } = await import('./public/i18n.js');
  check('languages available: en, de, cs',
    LANGS.includes('en') && LANGS.includes('de') && LANGS.includes('cs'));

  // Every language must define exactly the keys English does.
  let parity = true;
  const enKeys = Object.keys(STRINGS.en).sort();
  for (const lang of LANGS) {
    const keys = Object.keys(STRINGS[lang]).sort();
    if (keys.length !== enKeys.length || keys.some((k, i) => k !== enKeys[i])) {
      parity = false;
      const missing = enKeys.filter((k) => !STRINGS[lang][k]);
      const extra = keys.filter((k) => !STRINGS.en[k]);
      console.log(`      ${lang}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
    }
  }
  check('all languages define the same keys', parity);

  check('interpolation fills {params}',
    tr('en', 'report.victory.title', { where: 'X (1:2)' }) === 'Victory at X (1:2)');
  check('@-params resolve as keys',
    tr('de', 'err.buildFirst', { building: '@building.barracks.name' }).includes('Kaserne'));
  check('unknown key falls back to the key itself', tr('de', 'no.such.key') === 'no.such.key');
  check('unknown lang falls back to English', tr('xx', 'res.wood') === 'wood');

  // Reports render in each recipient's language.
  const w = g.createWorld();
  const att = g.createPlayer(w, 'Angreifer', 'pw', false, 'de').player;
  const def = g.createPlayer(w, 'Obránce', 'pw', false, 'cs').player;
  att.protectionBroken = def.protectionBroken = true;
  const ia = g.playerIsland(w, att.id), ib = g.playerIsland(w, def.id);
  ia.units.raider = 30; ib.units.sentinel = 2;
  const r = g.sendAttack(w, att, ia, ib, { raider: 30 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  const atkRep = w.reports.find((x) => x.ownerId === att.id);
  const defRep = w.reports.find((x) => x.ownerId === def.id);
  check('attacker report is German', atkRep && atkRep.title.startsWith('Sieg bei'));
  check('defender report is Czech', defRep && defRep.title.includes('vypleněn'));
  check('report lines use recipient language for unit names',
    atkRep && atkRep.lines.some((l) => l.includes('Plünderer')) &&
    defRep && defRep.lines.some((l) => l.includes('Nájezdníci') || l.includes('Nájezdník')));
  check('report lines use recipient language for resources',
    atkRep && atkRep.lines.some((l) => l.includes('Holz')));

  // Generated island names follow the owner's language.
  check('German player home island named in German',
    g.playerIsland(w, att.id).name === 'Insel von Angreifer');
  check('Czech player home island named in Czech',
    g.playerIsland(w, def.id).name === 'Ostrov hráče Obránce');

  // Conquest names: colony in settler's language, refuge in the victim's.
  const free = g.newUnchartedIsland(w);
  free.x = 0; free.y = 1;
  ia.units.colonyship = 1;
  const rc = g.sendColonize(w, att, ia, free, t0 + 500000);
  g.resolveWorld(w, rc.arrive + 1);
  check('colony named in settler language', free.name === 'Kolonie von Angreifer');

  ia.units.raider = 80; ia.units.flagship = 1;
  const islandsBefore = g.playerIslands(w, def.id).map((i) => i.id);
  g.playerIsland(w, def.id).loyalty = 0; // loyalty pre-broken for the capture test
  const rq = g.sendAttack(w, att, ia, g.playerIsland(w, def.id), { raider: 80, flagship: 1 }, t0 + 1000000);
  g.resolveWorld(w, rq.arrive + 1);
  const refuge = g.playerIslands(w, def.id).find((i) => !islandsBefore.includes(i.id));
  check('refuge named in victim language', !!refuge && refuge.name === 'Útočiště hráče Obránce');
  check('conquest report to victim is Czech',
    w.reports.some((x) => x.ownerId === def.id && x.title.includes('padl')));
}

// ---------------------------------------------------------------- combat characterisation
// CHARACTERISATION TESTS. These pin what applyMovement's attack branch does
// TODAY, at exact values, so that adding to it cannot silently change loot,
// survivor counts, wall damage, loyalty or report generation.
//
// applyMovement is ~420 lines and its win branch computes all of the above in
// one place, so a new branch there (e.g. catapult building damage, #1) is the
// realistic way to break combat without noticing. If one of these fails, the
// question is not "fix the test" but "did I mean to change the game?".
//
// Numbers are derived by hand from the documented formulas, not copied from a
// run, so they assert intent rather than current output:
//   A = sum(atk*n) * morale      D = (def + 15*wall) * (1 + 0.08*wall)
//   winner loses (D/A)^1.5 of the army, loser is wiped
//   loot = min(carry, stock), drawn proportionally
console.log('combat characterisation');

{
  // 100 raiders (A = 2400) vs 20 sentinels behind no wall (D = 600).
  // Same-size players, so no morale penalty: A/D = 4, lossFrac = 0.125^... :
  //   (600/2400)^1.5 = 0.25^1.5 = 0.125  -> survivors = round(100*0.875) = 88
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 100;
  ib.units.sentinel = 20;
  // resolveIsland accrues production and then CLAMPS to storehouse capacity
  // (level 1 = 600), so stock must be set after syncing the clock, and the
  // storehouse must be big enough to hold what we are testing against.
  ib.buildings.storehouse = 8; // capacity 10,252
  g.resolveIsland(ib, t0);
  ib.resources.wood = 10_000; ib.resources.stone = 0; ib.resources.gold = 0;
  const before = { ...ib.resources };
  const r = g.sendAttack(w, a, ia, ib, { raider: 100 }, t0);
  g.resolveWorld(w, r.arrive + 1);

  const ret = w.movements.find((m) => m.type === 'return');
  // Assert the return exists BEFORE touching it: if a future change stops
  // creating one, these must report a focused failure rather than throw a
  // TypeError and abort the whole run — which is the entire point of a
  // characterisation suite.
  check('char: a won attack sends the survivors home', !!ret);
  const hauled = ret ? ret.loot.wood + ret.loot.stone + ret.loot.gold : -1;
  check('char: attacker survivors = round(n * (1 - (D/A)^1.5))',
    !!ret && ret.units.raider === 88, `got ${ret && ret.units.raider}`);
  check('char: defender garrison wiped on a loss', g.totalUnits(ib.units) === 0);
  // 88 survivors carry 88*60 = 5280. Loot is drawn PROPORTIONALLY from all
  // three stocks, so no single resource equals the carry — the total does
  // (within a couple of units lost to per-resource flooring).
  check('char: total loot == surviving carry capacity', Math.abs(hauled - 5280) <= 3,
    `hauled ${hauled}`);
  check('char: looted resources leave the defender', ib.resources.wood < before.wood);
  check('char: no wall means no wall damage line', (ib.buildings.wall || 0) === 0);
  check('char: both sides get a report',
    w.reports.some((x) => x.ownerId === a.id) && w.reports.some((x) => x.ownerId === ib.ownerId));
}

{
  // The wall's contribution, pinned: 20 sentinels (600) behind wall 2 ->
  //   D = (600 + 15*2) * (1 + 0.08*2) = 630 * 1.16 = 730.8 -> 731
  // A = 2400, so (731/2400)^1.5 = 0.3046^1.5 = 0.16812 -> round(100*0.83188) = 83
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 100;
  ib.units.sentinel = 20;
  ib.buildings.wall = 2;
  g.resolveIsland(ib, t0);   // sync first: resolveIsland accrues then clamps
  ib.resources.wood = 200; ib.resources.stone = 0; ib.resources.gold = 0;
  const r = g.sendAttack(w, a, ia, ib, { raider: 100 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  const ret = w.movements.find((m) => m.type === 'return');
  check('char: walled win still sends the survivors home', !!ret);
  check('char: wall raises D, costing the attacker more',
    !!ret && ret.units.raider === 83, `got ${ret && ret.units.raider}`);
  check('char: a sack drops the wall exactly one level', ib.buildings.wall === 1);
  // Stock is far below carry (83*60 = 4980), so the raid takes essentially
  // everything: the fraction clamps at 1 and each stock is floored to 0.
  check('char: a raid that outweighs the stock empties the island',
    ib.resources.wood + ib.resources.stone + ib.resources.gold < 5,
    `left ${ib.resources.wood + ib.resources.stone + ib.resources.gold}`);
}

{
  // A losing attack: 10 raiders (A = 240) vs 20 sentinels (D = 600).
  //   defLossFrac = (240/600)^1.5 = 0.4^1.5 = 0.25298
  //   survivors = round(20 * 0.74702) = 15  -> 5 sentinels lost
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 10;
  ib.units.sentinel = 20;
  ib.buildings.wall = 0;
  g.resolveIsland(ib, t0);
  ib.resources.wood = 500;
  const r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  // Snapshot at BATTLE TIME, not at launch. Production accrues during the
  // voyage, so comparing against the launch value would let a wrongful
  // subtraction hide behind the income earned in transit. Resolving to
  // exactly m.arrive makes applyMovement's own resolveIsland a no-op, so
  // any difference afterwards is the battle's doing and nothing else.
  g.resolveIsland(ib, r.arrive);
  const atBattle = { ...ib.resources };
  g.resolveWorld(w, r.arrive + 1);
  check('char: defender loses round(S * (A/D)^1.5) on a repelled attack',
    ib.units.sentinel === 15, `got ${ib.units.sentinel}`);
  check('char: a losing attacker is wiped and nothing returns',
    !w.movements.some((m) => m.type === 'return'));
  check('char: a losing attack loots nothing — exact, at battle time',
    ib.resources.wood === atBattle.wood
    && ib.resources.stone === atBattle.stone
    && ib.resources.gold === atBattle.gold,
    `wood ${ib.resources.wood} vs ${atBattle.wood}`);
  check('char: wall is NOT damaged when the defender holds', (ib.buildings.wall || 0) === 0);
}

{
  // Loyalty: a surviving Flagship takes 25-40 off, and only with a Flagship.
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 100; ia.units.flagship = 1;
  ib.units.sentinel = 2;
  g.resolveIsland(ib, t0);
  ib.loyalty = 100;
  const r = g.sendAttack(w, a, ia, ib, { raider: 100, flagship: 1 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  const drop = 100 - ib.loyalty;
  check('char: surviving Flagship drops loyalty by 25-40', drop >= 25 && drop <= 40, `drop ${drop}`);
  check('char: island does NOT change hands while loyalty > 0', ib.ownerId !== a.id);
}

{
  // No Flagship -> no loyalty movement at all, however crushing the win.
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 200;
  ib.units.sentinel = 1;
  g.resolveIsland(ib, t0);
  ib.loyalty = 100;
  const r = g.sendAttack(w, a, ia, ib, { raider: 200 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('char: no Flagship means loyalty is untouched', ib.loyalty === 100, `loyalty ${ib.loyalty}`);
}

{
  // The victor always brings someone home, even when the maths says zero.
  // 26 raiders (A=624) vs 20 sentinels (D=600): (600/624)^1.5 = 0.9427,
  // round(26*0.0573) = 1 ... push it tighter with a bare win.
  const { w, a, ia, ib } = freshWorld();
  ia.units.raider = 26;
  ib.units.sentinel = 20;
  g.resolveIsland(ib, t0);
  const r = g.sendAttack(w, a, ia, ib, { raider: 26 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  const ret = w.movements.find((m) => m.type === 'return');
  check('char: a bare win still returns at least one survivor',
    !!ret && g.totalUnits(ret.units) >= 1, `returned ${ret && g.totalUnits(ret.units)}`);
}

{
  // Support stationed on the target defends and dies with the garrison.
  const { w, a, b, ia, ib } = freshWorld();
  const c = g.createPlayer(w, 'C', 'pw', false).player;
  c.protectionBroken = true;
  const ic = g.playerIsland(w, c.id);
  ic.x = 0; ic.y = 6;
  ic.units.sentinel = 10;
  const s = g.sendSupport(w, c, ic, ib, { sentinel: 10 }, t0);
  g.resolveWorld(w, s.arrive + 1);
  check('char: support arrives as a contingent, not merged into the garrison',
    ib.support.length === 1 && ib.units.sentinel === 0);
  ia.units.raider = 100;                    // A = 2400 vs D = 10*30 = 300
  const r = g.sendAttack(w, a, ia, ib, { raider: 100 }, s.arrive + 10);
  g.resolveWorld(w, r.arrive + 1);
  check('char: a won attack clears every support contingent', ib.support.length === 0);
  check('char: the support owner is told they lost troops',
    w.reports.some((x) => x.ownerId === c.id));
}

// --- Colony Ship cost growth (#27) ------------------------------------------
// COLONY_COST_GROWTH is read at module load, so these assert the pure cost
// function across a range rather than trying to re-import with a new env.
{
  const w = g.createWorld();
  const r = g.createPlayer(w, 'Settler', 'pw123456');
  const p = r.player || r;
  const isl = g.playerIsland(w, p.id);
  const flat = g.UNITS.colonyship.cost;

  // Default is 1 = flat, so nothing changes for anyone until it is set.
  const one = g.trainCost(w, isl, 'colonyship', 1);
  check('colony cost flat by default', one.wood === flat.wood && one.gold === flat.gold);
  const five = g.trainCost(w, isl, 'colonyship', 5);
  check('colony batch of 5 is 5x flat by default', five.wood === flat.wood * 5);

  // Other units must never escalate.
  const rd = g.trainCost(w, isl, 'raider', 3);
  check('raider cost unaffected', rd.wood === g.UNITS.raider.cost.wood * 3);

  // The escalation itself has to run in a CHILD process: COLONY_COST_GROWTH is
  // read once at module load, so it cannot be varied in-process.
  //
  // This replaces a block that reimplemented the formula in the test and
  // asserted it against itself. That version could not fail: making escalated
  // colony ships cost ZERO passed the entire suite.
  //
  // Expected values are worked by hand from cost x growth^(owned-1), summed
  // per ship across a batch, so they assert the intended formula rather than
  // whatever the code currently returns.
  const probe = `
    const g = await import(${JSON.stringify(new URL('./game.js', import.meta.url).href)});
    // A fresh world per island-count: trimming one world in place got stuck at
    // the smallest count and every later reading came back flat.
    const costsAt = (owned) => {
      const w = g.createWorld();
      const p = g.createPlayer(w, 'S', 'pw123456').player;
      for (let i = 1; i < owned; i++) g.newIsland(w, p.id, 'X' + i);
      const isl = g.playerIsland(w, p.id);
      if (g.playerIslands(w, p.id).length !== owned) throw new Error('owned ' + g.playerIslands(w, p.id).length);
      // Order three singly, letting each land in the garrison, and compare
      // with one order of three. If they differ, splitting dodges the curve.
      let singly = 0;
      const w2 = g.createWorld();
      const p2 = g.createPlayer(w2, 'T', 'pw123456').player;
      for (let i = 1; i < owned; i++) g.newIsland(w2, p2.id, 'Y' + i);
      const isl2 = g.playerIsland(w2, p2.id);
      for (let k = 0; k < 3; k++) {
        singly += g.trainCost(w2, isl2, 'colonyship', 1).wood;
        isl2.units.colonyship = (isl2.units.colonyship || 0) + 1;
      }
      return { owned, one: g.trainCost(w, isl, 'colonyship', 1), three: g.trainCost(w, isl, 'colonyship', 3),
               singly, raider: g.trainCost(w, isl, 'raider', 3),
               posBare: g.colonyPosition(w, p.id),
               posWithShip: (() => { isl.units.colonyship = 1; const n = g.colonyPosition(w, p.id); isl.units.colonyship = 0; return n; })(),
               // A ship still in the training queue is already paid for, so it
               // must count too — otherwise queue three and order a fourth cheap.
               posWithQueued: (() => {
                 isl.trainQueue.push({ unit: 'colonyship', count: 2, finish: Date.now() + 1e6 });
                 const n = g.colonyPosition(w, p.id); isl.trainQueue.pop(); return n;
               })(),
               // And one already sailing to settle: out of the garrison, not
               // yet an island, so neither end would count it.
               posWithFlight: (() => {
                 w.movements.push({ id: 1, type: 'colonize', ownerId: p.id, fromId: isl.id, toId: isl.id,
                   units: { ...g.zeroUnits(), colonyship: 1 }, depart: 0, arrive: Date.now() + 1e6 });
                 const n = g.colonyPosition(w, p.id); w.movements.pop(); return n;
               })() };
    };
    console.log(JSON.stringify({ o1: costsAt(1), o5: costsAt(5), o10: costsAt(10) }));
  `;
  const run = (growth) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, COLONY_COST_GROWTH: String(growth) },
    encoding: 'utf8',
  }).trim().split('\n').pop());

  const on = run(1.3);
  check('growth 1.3: the first island is still flat', on.o1.one.wood === 1200,
    JSON.stringify(on.o1.one));
  check('growth 1.3: the 10th costs 1200 x 1.3^9 = 12725', on.o10.one.wood === 12725,
    JSON.stringify(on.o10.one));
  check('growth 1.3: at 5 owned, one ship costs 1200 x 1.3^4 = 3427',
    on.o5.one.wood === 3427, JSON.stringify(on.o5.one));
  check('growth 1.3: and every resource scales together',
    on.o5.one.gold === 1714 && on.o5.one.stone === 2570, JSON.stringify(on.o5.one));
  check('growth 1.3: a batch of 3 steps per ship, 1.3^4+1.3^5+1.3^6 -> 13675',
    on.o5.three.wood === 13675, JSON.stringify(on.o5.three));
  check('growth 1.3: a batch is dearer than 3x the single price',
    on.o5.three.wood > on.o5.one.wood * 3);
  // The dodge: `owned` does not move until a ship LANDS, so three orders of
  // one used to cost 3 x growth^(n-1) — 10,281 against 13,675 at five
  // islands, a 25% discount for clicking three times. Ships already paid for
  // now count toward the position, which makes the two identical.
  check('growth 1.3: ordering singly costs the same as one batch',
    on.o5.singly === on.o5.three.wood, `singly ${on.o5.singly} vs batch ${on.o5.three.wood}`);
  check('a colony ship in hand counts toward the position',
    on.o5.posWithShip === on.o5.posBare + 1,
    `${on.o5.posBare} -> ${on.o5.posWithShip}`);
  check('and one still in the training queue',
    on.o5.posWithQueued === on.o5.posBare + 2,
    `${on.o5.posBare} -> ${on.o5.posWithQueued} (queued 2)`);
  check('and one already sailing to settle',
    on.o5.posWithFlight === on.o5.posBare + 1,
    `${on.o5.posBare} -> ${on.o5.posWithFlight}`);
  check('growth 1.3: other units are untouched',
    on.o5.raider?.wood === g.UNITS.raider.cost.wood * 3, JSON.stringify(on.o5.raider));

  const off = run(1);
  check('growth 1: nothing escalates at any island count',
    off.o5.one.wood === 1200 && off.o5.three.wood === 3600, JSON.stringify(off.o5));
}

// ------------------------------------------------- support costs home population (#40)

{
  // Stationed troops keep consuming the farm space of the island that raised
  // them, so "train to cap → ship out → train again" no longer repeats forever.
  const { w, a, ia, ib } = freshWorld();
  ia.buildings.farm = 5;
  ia.units.sentinel = 20;
  const cap = g.popCap(ia.buildings.farm);
  const before = g.popUsed(ia);

  const rs = g.sendSupport(w, a, ia, ib, { sentinel: 20 }, t0);
  check('#40 support departs', !rs.error);
  check('#40 the garrison really emptied', g.popUsed(ia) === before - 20);
  check('#40 in-flight support still costs the sender', g.popAbroad(w, ia) === 20);

  g.resolveWorld(w, rs.arrive + 1);
  check('#40 it actually arrived', (ib.support || []).length === 1);
  check('#40 stationed support still costs the sender', g.popAbroad(w, ia) === 20);
  check('#40 the host pays nothing', g.popAbroad(w, ib) === 0 && g.popUsed(ib) === 0);

  // The whole point: the sender's cap did not free up.
  ia.resources = { wood: 9e6, stone: 9e6, gold: 9e6 };
  ia.buildings.storehouse = 20;
  ia.buildings.barracks = 1;
  const room = cap - g.popUsed(ia) - g.popAbroad(w, ia);
  check('#40 there is genuine room left, so the next check means something', room > 1);
  check('#40 training up to the remaining room is allowed',
    !g.tryTrain(w, ia, 'sentinel', room, rs.arrive + 1).error);
  check('#40 training past it is refused',
    g.tryTrain(w, ia, 'sentinel', 1, rs.arrive + 1).error === 'err.noPop');

  const rw = g.withdrawSupport(w, a, ib, rs.arrive + 2);
  check('#40 withdraw accepted', !rw.error);
  check('#40 recall releases the commitment', g.popAbroad(w, ia) === 0);
}

{
  // Two of your islands supporting the SAME host must be charged separately.
  // Contingents used to merge on ownerId alone and keep the first fromId, so
  // one token sentinel from a throwaway island absorbed the cost of every
  // island that sent afterwards — which defeated the whole rule.
  const { w, a, b, ia, ib } = freshWorld();
  const second = JSON.parse(JSON.stringify(ia));
  second.id = w.nextId++; second.x = 0; second.y = 1;
  second.units = g.zeroUnits(); second.support = []; second.trainQueue = []; second.queue = [];
  second.buildings.farm = 8;
  w.islands.push(second);

  ia.buildings.farm = 8; ia.units.sentinel = 10; second.units.sentinel = 40;
  const r1 = g.sendSupport(w, a, ia, ib, { sentinel: 10 }, t0);
  g.resolveWorld(w, r1.arrive + 1);
  const r2 = g.sendSupport(w, a, second, ib, { sentinel: 40 }, r1.arrive + 1);
  g.resolveWorld(w, r2.arrive + 1);

  check('#40 each origin keeps its own contingent', ib.support.length === 2);
  check('#40 the first island is charged only for what it sent',
    g.popAbroad(w, ia) === 10, `got ${g.popAbroad(w, ia)}, want 10`);
  check('#40 the second island is charged for its own',
    g.popAbroad(w, second) === 40, `got ${g.popAbroad(w, second)}, want 40`);

  // The same merge sent troops home to the wrong island on withdrawal.
  g.withdrawSupport(w, a, ib, r2.arrive + 2);
  const homes = w.movements.filter((m) => m.type === 'return');
  check('#40 each contingent sails back to its own origin',
    homes.length === 2
    && homes.some((m) => m.toId === ia.id && m.units.sentinel === 10)
    && homes.some((m) => m.toId === second.id && m.units.sentinel === 40));
}

{
  // Supporting your OWN island is a transfer, not a contingent: the troops
  // join the garrison and cost population there like any other unit. Only
  // another player's island can hold troops that cost their host nothing.
  const { w, a, ia } = freshWorld();
  const mine2 = JSON.parse(JSON.stringify(ia));
  mine2.id = w.nextId++; mine2.x = 0; mine2.y = 2;
  mine2.units = g.zeroUnits(); mine2.support = []; mine2.trainQueue = []; mine2.queue = [];
  mine2.buildings.farm = 8;
  w.islands.push(mine2);
  ia.buildings.farm = 8; ia.units.sentinel = 20;

  const r = g.sendSupport(w, a, ia, mine2, { sentinel: 20 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('#40 own-island support lands in the garrison, not as support',
    mine2.units.sentinel === 20 && mine2.support.length === 0);
  check('#40 and therefore costs population at the destination',
    g.popUsed(mine2) === 20);
  check('#40 so the sender is not also charged', g.popAbroad(w, ia) === 0);
}

{
  // Attacks were always free and stay free — only support was unbounded.
  const { w, a, ia, ib } = freshWorld();
  ia.buildings.farm = 5;
  ia.units.raider = 10;
  const r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('#40 attack departs', !r.error);
  check('#40 an attack in flight costs the sender nothing', g.popAbroad(w, ia) === 0);
}

{
  // `fromId` outlives a change of ownership, so without the ownerId guard a
  // captured island would be charged for its previous owner's troops.
  const { w, a, b, ia, ib } = freshWorld();
  ia.buildings.farm = 5;
  ia.units.sentinel = 6;
  const rs = g.sendSupport(w, a, ia, ib, { sentinel: 6 }, t0);
  g.resolveWorld(w, rs.arrive + 1);
  check('#40 charged to the sender before capture', g.popAbroad(w, ia) === 6);
  ia.ownerId = b.id; // ia changes hands; the contingent is still A's
  check('#40 a captured island is not charged for the old owner', g.popAbroad(w, ia) === 0);
}

{
  // A live season must keep the old rule. migrateWorld backfills the flag OFF
  // precisely so a pm2 restart cannot nerf players mid-season.
  const w = g.createWorld();
  check('#40 new worlds get the rule', g.supportCostsPop(w) === true && w.supportCostsPop === true);

  const old = g.createWorld();
  delete old.supportCostsPop; // a save written before this change
  g.migrateWorld(old);
  check('#40 migrate backfills OFF, not ON', old.supportCostsPop === false);
  check('#40 and so the old rule still applies', g.supportCostsPop(old) === false);

  const set = g.createWorld();
  set.supportCostsPop = true;
  g.migrateWorld(set);
  check('#40 a deliberate ON survives migration', set.supportCostsPop === true);
}

{
  // With the flag off, the loophole is intact — which is what the current
  // season relies on, and proves popAbroad is genuinely gated rather than
  // accidentally inert.
  const { w, a, ia, ib } = freshWorld();
  w.supportCostsPop = false;
  ia.buildings.farm = 5;
  ia.units.sentinel = 20;
  const rs = g.sendSupport(w, a, ia, ib, { sentinel: 20 }, t0);
  g.resolveWorld(w, rs.arrive + 1);
  check('#40 flag off: stationed troops cost nothing', g.popAbroad(w, ia) === 0);
  ia.resources = { wood: 9e6, stone: 9e6, gold: 9e6 };
  ia.buildings.storehouse = 20;
  ia.buildings.barracks = 1;
  check('#40 flag off: the sender can refill to the cap',
    !g.tryTrain(w, ia, 'sentinel', g.popCap(5) - g.popUsed(ia), rs.arrive + 1).error);
}

// ---------------------------------------------------------- merchant slots (#30)

{
  // Harbor level grants slots; a shipment holds one for the round trip.
  const { w, a, ia, ib } = freshWorld();
  ia.buildings.harbor = 2;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  check('#30 harbor 2 grants 2 slots', g.tradeSlotsTotal(w, ia) === 2);
  check('#30 nothing busy to start', g.tradeSlotsBusy(w, ia) === 0);

  const r1 = g.sendTrade(w, a, ia, ib, { wood: 50 }, t0);
  const r2 = g.sendTrade(w, a, ia, ib, { wood: 50 }, t0);
  check('#30 two shipments fit', !r1.error && !r2.error);
  check('#30 both slots busy', g.tradeSlotsBusy(w, ia) === 2 && g.tradeSlotsFree(w, ia) === 0);

  const beforeRefusal = ia.resources.wood;
  const r3 = g.sendTrade(w, a, ia, ib, { wood: 50 }, t0);
  check('#30 a third is refused', r3.error === 'err.noMerchants');
  check('#30 the refusal names the total', r3.errorParams && r3.errorParams.total === 2);
  check('#30 a refused shipment costs nothing', ia.resources.wood === beforeRefusal);

  // Arrival is NOT enough — the merchants must get home.
  g.resolveWorld(w, r1.arrive + 1);
  check('#30 the goods landed', ib.resources.wood > 0);
  check('#30 the slot is still held on the homeward leg', g.tradeSlotsBusy(w, ia) === 2);
  const legs = w.movements.filter((m) => m.type === 'merchant');
  check('#30 two merchant legs are sailing home', legs.length === 2);
  check('#30 they carry nothing', legs.every((m) => !m.loot && g.totalUnits(m.units) === 0));
  check('#30 and head back where they came from', legs.every((m) => m.toId === ia.id));

  const home = Math.max(...legs.map((m) => m.arrive));
  g.resolveWorld(w, home + 1);
  check('#30 the round trip frees the slots', g.tradeSlotsBusy(w, ia) === 0);
  check('#30 and the leg leaves no trace', !w.movements.some((m) => m.type === 'merchant'));
  check('#30 trading is possible again', !g.sendTrade(w, a, ia, ib, { wood: 50 }, home + 1).error);
}

{
  // Distance costs throughput, not just patience: a far shipment holds its
  // slot for twice the travel time. This is the whole point of the round trip.
  const { w, a, ia, ib } = freshWorld();
  ib.x = 0; ib.y = 20;
  ia.buildings.harbor = 1;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  const r = g.sendTrade(w, a, ia, ib, { wood: 50 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  const leg = w.movements.find((m) => m.type === 'merchant');
  check('#30 the homeward leg takes as long as the outbound',
    leg.arrive - leg.depart === r.arrive - t0);
  check('#30 so the slot is held for the full round trip',
    leg.arrive - t0 === 2 * (r.arrive - t0));
}

{
  // The Tidepool is exempt (#30): its shipments are self-addressed and it is
  // the always-available counterparty, not a way to concentrate resources.
  const { w, a, ia } = poolWorld();
  ia.buildings.harbor = 1;
  const before = g.tradeSlotsBusy(w, ia);
  const r = g.sendPoolSwap(w, a, ia, 'wood', 'stone', 100, t0);
  check('#30 a pool swap sails', !r.error);
  check('#30 a pool swap takes no slot', g.tradeSlotsBusy(w, ia) === before);
  g.resolveWorld(w, t0 + 40 * 60 * 1000);
  check('#30 and spawns no merchant leg', !w.movements.some((m) => m.type === 'merchant'));
  check('#30 so an exhausted harbor can still use the pool',
    !g.sendPoolSwap(w, a, ia, 'wood', 'stone', 100, t0 + 40 * 60 * 1000).error);
}

{
  // Both legs of a market trade are charged. Exempting the seller would leave
  // the hole open: post an offer, have an ally take it, move goods for free.
  const { w, a, b, ia, ib } = freshWorld();
  ia.buildings.harbor = 1; ib.buildings.harbor = 1;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  ib.resources = { wood: 9000, stone: 9000, gold: 9000 };
  const mo = g.createOffer(w, a, ia, { res: 'wood', amount: 100 }, { res: 'stone', amount: 100 }, t0);
  check('#30 offer posted', !mo.error);
  check('#30 posting an offer holds no slot', g.tradeSlotsBusy(w, ia) === 0);

  const acc = g.acceptOffer(w, b, ib, w.offers[0].id, t0);
  check('#30 the trade goes through', !acc.error);
  check('#30 the seller pays a slot', g.tradeSlotsBusy(w, ia) === 1);
  check('#30 and the buyer pays a slot', g.tradeSlotsBusy(w, ib) === 1);
}

{
  // A refusal must not consume the escrow. The gate sits before every
  // mutation, so a blocked accept leaves the offer standing and the buyer paid
  // nothing.
  const { w, a, b, ia, ib } = freshWorld();
  ia.buildings.harbor = 1; ib.buildings.harbor = 1;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  ib.resources = { wood: 9000, stone: 9000, gold: 9000 };
  g.createOffer(w, a, ia, { res: 'wood', amount: 100 }, { res: 'stone', amount: 100 }, t0);
  // burn the seller's only slot
  g.sendTrade(w, a, ia, ib, { wood: 50 }, t0);
  check('#30 seller has no slot left', g.tradeSlotsFree(w, ia) === 0);

  g.resolveIsland(ib, t0); // production accrues on resolve; settle it before measuring
  const before = ib.resources.stone;
  const acc = g.acceptOffer(w, b, ib, w.offers[0].id, t0);
  check('#30 accept is refused when the seller has no merchant',
    acc.error === 'err.offerNoMerchants');
  check('#30 the offer survives the refusal', w.offers.length === 1);
  check('#30 the buyer paid nothing', ib.resources.stone === before);
}

{
  // The other side of the same gate: the BUYER out of merchants. Tested
  // separately because one check cannot fail for the other's reason.
  const { w, a, b, ia, ib } = freshWorld();
  ia.buildings.harbor = 2; ib.buildings.harbor = 1;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  ib.resources = { wood: 9000, stone: 9000, gold: 9000 };
  g.createOffer(w, a, ia, { res: 'wood', amount: 100 }, { res: 'stone', amount: 100 }, t0);
  g.sendTrade(w, b, ib, ia, { wood: 50 }, t0); // burn the buyer's only slot
  check('#30 buyer has no slot left, seller still does',
    g.tradeSlotsFree(w, ib) === 0 && g.tradeSlotsFree(w, ia) > 0);

  g.resolveIsland(ib, t0);
  const before = ib.resources.stone;
  const acc = g.acceptOffer(w, b, ib, w.offers[0].id, t0);
  check('#30 accept is refused when the buyer has no merchant',
    acc.error === 'err.noMerchants');
  check('#30 the offer survives a buyer-side refusal', w.offers.length === 1);
  check('#30 and the buyer still paid nothing', ib.resources.stone === before);
}

{
  // The seller's island is resolved before its slots are counted: a Harbor
  // upgrade that finished since lastUpdate must count, or the seller is
  // refused on a slot they already have.
  const { w, a, b, ia, ib } = freshWorld();
  ia.buildings.harbor = 1; ib.buildings.harbor = 2;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  ib.resources = { wood: 9000, stone: 9000, gold: 9000 };
  g.createOffer(w, a, ia, { res: 'wood', amount: 100 }, { res: 'stone', amount: 100 }, t0);
  g.sendTrade(w, a, ia, ib, { wood: 50 }, t0); // seller's only slot, at harbor 1
  check('#30 seller is out of slots at harbor 1', g.tradeSlotsFree(w, ia) === 0);

  // ...but harbor 2 lands before the accept, unresolved on the island.
  ia.queue = [{ building: 'harbor', level: 2, finish: t0 + 1000 }];
  const acc = g.acceptOffer(w, b, ib, w.offers[0].id, t0 + 2000);
  check('#30 a finished Harbor upgrade counts toward the seller\'s slots',
    !acc.error, `got ${acc.error}`);
  check('#30 and the upgrade really was pending', ia.buildings.harbor === 2);
}

{
  // Season gating, same shape as #40: on for new worlds, unlimited for a
  // season that began before the rule existed.
  const w = g.createWorld();
  check('#30 new worlds get slots', g.tradeSlotsPerHarbor(w) === 1);

  const old = g.createWorld();
  delete old.tradeSlots;
  g.migrateWorld(old);
  check('#30 migrate backfills unlimited, not the env default', old.tradeSlots === null);
  check('#30 and unlimited really is unlimited', g.tradeSlotsPerHarbor(old) === null);

  const keep = g.createWorld();
  keep.tradeSlots = 3;
  g.migrateWorld(keep);
  check('#30 a deliberate value survives migration', keep.tradeSlots === 3);
}

{
  // With slots off, trade is unlimited and no merchant legs appear at all —
  // proof the feature is gated rather than accidentally inert.
  const { w, a, ia, ib } = freshWorld();
  w.tradeSlots = null;
  ia.buildings.harbor = 1;
  ia.resources = { wood: 9000, stone: 9000, gold: 9000 };
  check('#30 unlimited: total is Infinity', g.tradeSlotsTotal(w, ia) === Infinity);
  let sent = 0;
  for (let i = 0; i < 6; i++) if (!g.sendTrade(w, a, ia, ib, { wood: 50 }, t0).error) sent++;
  check('#30 unlimited: six concurrent shipments all sail', sent === 6);
  const arrive = Math.max(...w.movements.map((m) => m.arrive));
  g.resolveWorld(w, arrive + 1);
  check('#30 unlimited: no merchant legs are created',
    !w.movements.some((m) => m.type === 'merchant'));
}

{
  // A harbor-less island has no slots, which must not read as "unlimited".
  const { w, ia } = freshWorld();
  ia.buildings.harbor = 0;
  check('#30 no harbor, no slots', g.tradeSlotsTotal(w, ia) === 0);
}

// ------------------------------------------ COLONY_COST_GROWTH is clamped (#61)

{
  // The knob is read at module load, so the band has to be probed in a child.
  const probe = `
    import * as g from './game.js';
    console.log(JSON.stringify({ growth: g.COLONY_COST_GROWTH, max: g.COLONY_COST_GROWTH_MAX }));
  `;
  const at = (v) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, COLONY_COST_GROWTH: String(v) }, encoding: 'utf8', cwd: HERE,
  }).trim().split('\n').pop());

  check('#61 a sane value is kept', at(1.3).growth === 1.3);
  check('#61 the ceiling itself is allowed', at(3).growth === 3);
  check('#61 above the ceiling falls back to flat', at(3.1).growth === 1);
  check('#61 Infinity falls back to flat', at('Infinity').growth === 1);
  // 1000 is finite and correctly typed, and equally unbuildable — a non-finite
  // check alone would not have caught it.
  check('#61 an absurd finite value falls back to flat', at(1000).growth === 1);
  check('#61 junk falls back to flat', at('abc').growth === 1);
  check('#61 zero falls back to flat', at(0).growth === 1);
  check('#61 negative falls back to flat', at(-5).growth === 1);
  check('#61 the ceiling is 3', at(1).max === 3);
}

{
  // Belt and braces: a cost must never be non-finite, because Infinity
  // serialises to null and reaches the player as "not enough resources" for
  // something no wealth can buy.
  //
  // Reachable even inside the clamped band: at the ceiling of 3, a position
  // around 200 with a 500-ship batch overflows a double. Absurd as a game
  // state, but the guard is only worth having if it is exercised.
  const probe = `
    import * as g from './game.js';
    const w = g.createWorld();
    const p = g.createPlayer(w, 'A', 'pw', false).player;
    const i = g.playerIsland(w, p.id);
    i.units.colonyship = 220;              // colonyPosition counts ships in hand
    const raw = 1200 * Array.from({length: 500}, (_, k) =>
      Math.pow(3, g.colonyPosition(w, p.id) - 1 + k)).reduce((a, b) => a + b, 0);
    const cost = g.trainCost(w, i, 'colonyship', 500);
    // The invariant that matters. Falling back to the flat table price on
    // overflow made a batch of 499 cost 598,800 while a batch of 100 cost
    // 2.9e155 — the biggest orders became the cheapest.
    const ladder = [1, 10, 100, 499, 500].map((n) => g.trainCost(w, i, 'colonyship', n).wood);
    const mono = ladder.every((v, k) => k === 0 || v >= ladder[k - 1]);
    console.log(JSON.stringify({ raw, cost, ladder, mono, growth: g.COLONY_COST_GROWTH }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, COLONY_COST_GROWTH: '3' }, encoding: 'utf8', cwd: HERE,
  }).trim().split('\n').pop());

  check('#61 the knob really is at the ceiling for this probe', out.growth === 3);
  check('#61 the price never falls as the batch grows', out.mono,
    JSON.stringify(out.ladder));
  check('#61 the unguarded arithmetic really does overflow', out.raw === null,
    `raw serialised as ${out.raw}`);
  check('#61 but trainCost still returns finite numbers',
    g.RESOURCES.every((r) => Number.isFinite(out.cost[r])), JSON.stringify(out.cost));
  check('#61 so nothing reaches the client as null',
    g.RESOURCES.every((r) => out.cost[r] !== null), JSON.stringify(out.cost));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
process.exit(failures ? 1 : 0);
