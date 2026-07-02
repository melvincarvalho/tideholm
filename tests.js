// Tideholm — engine math tests. Run: node tests.js  (exits non-zero on failure)
// Pins the game's formulas and invariants so balance changes are deliberate.

'use strict';

process.env.GAME_SPEED = '1'; // test at classic pace; SPEED-scaling is tested explicitly
const g = require('./game');

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
  const r = g.sendAttack(w, a, ia, ib, { raider: 50, flagship: 1 }, t0);
  g.resolveWorld(w, r.arrive + 1);
  check('conquest: surviving flagship flips ownership and is consumed',
    ib.ownerId === a.id && ib.units.flagship === 0 && ib.units.raider > 0);
  check('defeated player respawns on a new island', g.playerIslands(w, b.id).length === 1);
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
  Object.assign(ib.buildings, { lumberyard: 8, quarry: 8, goldmine: 6 });
  ia.units.raider = 10;
  const r = g.sendAttack(w, a, ia, ib, { raider: 10 }, t0);
  check('protection ends at 40 points', !r.error);
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

// ---------------------------------------------------------------- speed scaling

console.log('speed scaling');
{
  // SPEED multiplies production and divides times — capacity is fixed by design,
  // which is why very high speeds pin resources at the cap.
  delete require.cache[require.resolve('./game')];
  process.env.GAME_SPEED = '5';
  const g5 = require('./game');
  check('production scales linearly with speed',
    close(g5.productionPerHour('lumberyard', 4), 5 * 40 * 4 * Math.pow(1.12, 3)));
  check('build time divides by speed (above the 5s floor)',
    close(g5.upgradeTime('harbor', 8, 1), Math.round(300 * Math.pow(1.5, 7) / 5), 0.01));
  check('capacity does NOT scale with speed', g5.storageCapacity(2) === 900);
  check('user report: lumberyard 4 at speed 2000 → 449,577/h', (() => {
    delete require.cache[require.resolve('./game')];
    process.env.GAME_SPEED = '2000';
    const g2k = require('./game');
    return Math.round(g2k.productionPerHour('lumberyard', 4)) === 449577;
  })());
}

// ---------------------------------------------------------------- i18n

console.log('i18n');
{
  const { STRINGS, LANGS, t: tr } = require('./public/i18n.js');
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
  const rq = g.sendAttack(w, att, ia, g.playerIsland(w, def.id), { raider: 80, flagship: 1 }, t0 + 1000000);
  g.resolveWorld(w, rq.arrive + 1);
  const refuge = g.playerIslands(w, def.id).find((i) => !islandsBefore.includes(i.id));
  check('refuge named in victim language', !!refuge && refuge.name === 'Útočiště hráče Obránce');
  check('conquest report to victim is Czech',
    w.reports.some((x) => x.ownerId === def.id && x.title.includes('padl')));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
process.exit(failures ? 1 : 0);
