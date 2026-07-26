// Tideholm — engine math tests. Run: node tests.js  (exits non-zero on failure)
// Pins the game's formulas and invariants so balance changes are deliberate.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.GAME_SPEED = '1'; // test at classic pace; SPEED-scaling is tested explicitly
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
  check('return trip takes as long as the way out', ret.arrive - ret.depart === out);
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
  g.resolveWorld(w, ret.arrive + 1); // flagship home
  ib.loyalty = 0;
  ib.units.sentinel = 1;
  const r2 = g.sendAttack(w, a, ia, ib, { raider: 40, flagship: 1 }, ret.arrive + 10);
  g.resolveWorld(w, r2.arrive + 1);
  check('capture at 0 loyalty', ib.ownerId === a.id);
  check('captured island starts restive at 25 loyalty', ib.loyalty === 25);
  check('flagship consumed on capture', ib.units.flagship === 0);
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

  const region = JSON.parse(fs.readFileSync('./public/maps/aegean.json', 'utf8'));
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
  const hauled = ret.loot.wood + ret.loot.stone + ret.loot.gold;
  check('char: attacker survivors = round(n * (1 - (D/A)^1.5))', ret.units.raider === 88,
    `got ${ret && ret.units.raider}`);
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
  check('char: wall raises D, costing the attacker more', ret.units.raider === 83,
    `got ${ret && ret.units.raider}`);
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
  const woodBefore = ib.resources.wood;
  const r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('char: defender loses round(S * (A/D)^1.5) on a repelled attack',
    ib.units.sentinel === 15, `got ${ib.units.sentinel}`);
  check('char: a losing attacker is wiped and nothing returns',
    !w.movements.some((m) => m.type === 'return'));
  // Production keeps accruing during the voyage, so the defender's stock can
  // only be >= what it was; a loss must never subtract.
  check('char: a losing attack loots nothing', ib.resources.wood >= woodBefore);
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
process.exit(failures ? 1 : 0);
