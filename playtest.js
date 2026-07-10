// Tideholm — headless balance playtest. Run: node playtest.js [days] [bots]
// Simulates a bots-only world on a virtual clock at classic pace (speed 1)
// and reports pacing, economy waste, combat balance and inequality.

process.env.GAME_SPEED = process.env.GAME_SPEED || '1';
import os from 'node:os';
import path from 'node:path';

process.env.HALL_FILE = path.join(
  os.tmpdir(), `tideholm-playtest-hall-${process.pid}.json`);

const g = await import('./game.js'); // dynamic: after the env above is set
const { spawnBots, botTick } = await import('./bots.js');

const DAYS = Number(process.argv[2] || 45);
const BOTS = Number(process.argv[3] || 20);
const STEP = 60 * 1000;          // one simulated minute per tick
const DAY = 24 * 3600 * 1000;

const world = g.createWorld();
spawnBots(world, BOTS);
for (let i = 0; i < 30; i++) g.newUnchartedIsland(world);
const t0 = 1_800_000_000_000;
for (const island of world.islands) island.lastUpdate = t0;

world.metrics = {
  battles: 0, attackerWins: 0, walledBattles: 0, walledHolds: 0,
  lootHauled: 0, atkUnitsLost: 0, defUnitsLost: 0,
  loyaltyStrikes: 0, conquests: 0, respawns: 0, colonizations: 0,
};

function snapshot(now, day) {
  for (const island of world.islands) g.resolveIsland(island, now);
  const bots = world.players.filter((p) => p.isBot);
  const points = bots.map((p) => g.playerPoints(world, p.id)).sort((a, b) => a - b);
  const median = points[Math.floor(points.length / 2)];
  const owned = world.islands.filter((i) => i.ownerId != null);
  let atCap = 0;
  let wallSum = 0;
  let garrison = 0;
  for (const island of owned) {
    const cap = g.storageCapacity(island.buildings.storehouse);
    if (island.resources.wood >= cap - 1 && island.resources.stone >= cap - 1) atCap++;
    wallSum += island.buildings.wall;
    garrison += g.totalUnits(island.units);
  }
  const maxShare = Math.max(...bots.map((p) => g.playerIslands(world, p.id).length));
  return {
    day,
    medianPts: median,
    maxPts: points[points.length - 1],
    inequality: median ? +(points[points.length - 1] / median).toFixed(2) : 0,
    islandsOwned: owned.length,
    uncharted: world.islands.length - owned.length,
    maxIslands: maxShare,
    pctAtCap: Math.round((100 * atCap) / owned.length),
    avgWall: +(wallSum / owned.length).toFixed(1),
    troops: garrison,
    ...JSON.parse(JSON.stringify(world.metrics)),
    winner: world.winner ? world.winner.name : '',
  };
}

console.error(`Simulating ${DAYS} days, ${BOTS} bots, speed ${process.env.GAME_SPEED}...`);
const snaps = [];
let now = t0;
const start = Date.now();
for (let day = 1; day <= DAYS; day++) {
  const dayEnd = t0 + day * DAY;
  while (now < dayEnd) {
    botTick(world, now);
    now += STEP;
  }
  g.checkVictory(world, now);
  snaps.push(snapshot(now, day));
  if (day % 5 === 0) console.error(`  day ${day} (${Math.round((Date.now() - start) / 1000)}s)`);
}

// ------------------------------------------------------------------ report

const last = snaps[snaps.length - 1];
const rows = snaps.filter((s) => s.day % 5 === 0 || s.day === 1);
console.log('\nday | medPts | maxPts | ineq | isl(max) | free | cap% | wall | troops | battles | conq | colon');
for (const s of rows) {
  console.log(
    String(s.day).padStart(3) + ' |' +
    String(s.medianPts).padStart(7) + ' |' +
    String(s.maxPts).padStart(7) + ' |' +
    String(s.inequality).padStart(5) + ' |' +
    String(s.islandsOwned + '(' + s.maxIslands + ')').padStart(9) + ' |' +
    String(s.uncharted).padStart(5) + ' |' +
    String(s.pctAtCap).padStart(5) + ' |' +
    String(s.avgWall).padStart(5) + ' |' +
    String(s.troops).padStart(7) + ' |' +
    String(s.battles).padStart(8) + ' |' +
    String(s.conquests).padStart(5) + ' |' +
    String(s.colonizations).padStart(6)
  );
}

console.log('\nsummary after ' + DAYS + ' days:');
console.log('  battles: ' + last.battles +
  ' | attacker win rate: ' + Math.round((100 * last.attackerWins) / Math.max(1, last.battles)) + '%');
console.log('  walled battles: ' + last.walledBattles +
  ' | wall held: ' + Math.round((100 * last.walledHolds) / Math.max(1, last.walledBattles)) + '%');
console.log('  loot hauled: ' + last.lootHauled +
  ' | attacker units lost: ' + last.atkUnitsLost +
  ' | defender units lost: ' + last.defUnitsLost);
console.log('  loot per attacker unit lost: ' +
  Math.round(last.lootHauled / Math.max(1, last.atkUnitsLost)));
console.log('  loyalty strikes: ' + last.loyaltyStrikes +
  ' | conquests: ' + last.conquests + ' | respawns: ' + last.respawns +
  ' | colonizations: ' + last.colonizations);
console.log('  winner: ' + (last.winner || 'none') +
  ' | storage-cap idle: ' + last.pctAtCap + '% of islands');
