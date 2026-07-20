// Tideholm — season chronicle generator.
// Usage: node tools/chronicle.js seasons/archive/season-2.json 2 > public/seasons/season-2.html
//
// Reads a SANITIZED season-end archive (no sessions, credentials, mail or
// boards — see seasons/archive/) and emits a self-contained parchment page:
// masthead, final map (drawn client-side from embedded JSON by the same
// noise painter the game uses), standings, superlatives, dispatches from
// the surviving battle reports, and the grudge ledger. English by design —
// these are historical documents.

import fs from 'node:fs';

const [archivePath, seasonNo] = process.argv.slice(2);
if (!archivePath || !seasonNo) {
  console.error('usage: node tools/chronicle.js <archive.json> <seasonNumber>');
  process.exit(1);
}
const w = JSON.parse(fs.readFileSync(archivePath, 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const byId = (id) => w.players.find((p) => p.id === id);
const nameOf = (id) => (byId(id) || { name: '?' }).name;
const islandPoints = (i) => Object.values(i.buildings).reduce((s, l) => s + l * (l + 1) / 2, 0);
const owned = (pid) => w.islands.filter((i) => i.ownerId === pid);
const playerPoints = (pid) => Math.round(owned(pid).reduce((s, i) => s + islandPoints(i), 0));

const start = w.createdAt;
const end = (w.winner && w.winner.time) || start;
const days = Math.max(1, Math.round((end - start) / 86400000));
const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

// standings
const humans = w.players.filter((p) => !p.isBot)
  .map((p) => ({ p, pts: playerPoints(p.id), isl: owned(p.id).length }))
  .sort((a, b) => b.pts - a.pts);
const bots = w.players.filter((p) => p.isBot)
  .map((p) => ({ p, pts: playerPoints(p.id), isl: owned(p.id).length }))
  .sort((a, b) => b.pts - a.pts);

// superlatives
const beacon = w.islands.filter((i) => (i.buildings.wonder || 0) > 0)
  .sort((a, b) => b.buildings.wonder - a.buildings.wonder)[0];
const wallIsle = [...w.islands].sort((a, b) => (b.buildings.wall || 0) - (a.buildings.wall || 0))[0];
const hoard = [...w.islands].filter((i) => i.ownerId != null)
  .sort((a, b) => (b.resources.wood + b.resources.stone + b.resources.gold)
                - (a.resources.wood + a.resources.stone + a.resources.gold))[0];
const arrivals = humans
  .filter((h) => h.p.joinedAt && h.p.joinedAt > start + 3600000)
  .map((h) => `${esc(h.p.name)} landed on day ${Math.max(1, Math.ceil((h.p.joinedAt - start) / 86400000))}`);

// dispatches: the last surviving human reports. Broadcasts land as one
// copy per recipient — dedupe by content, keep the first copy's owner.
const seen = new Set();
const dispatches = [];
for (const r of (w.reports || []).sort((a, b) => b.time - a.time)) {
  const owner = byId(r.ownerId);
  if (!owner || owner.isBot) continue;
  const line = (r.lines || [])[0] || '';
  const key = r.title + '\n' + line;
  if (seen.has(key)) continue;
  seen.add(key);
  dispatches.push({ who: owner.name, time: r.time, title: r.title, line });
  if (dispatches.length >= 6) break;
}

// grudge ledger: bots that ended the world still angry at humans
const grudges = [];
for (const b of bots) {
  for (const [pid, n] of Object.entries(b.p.grudges || {})) {
    const target = byId(Number(pid));
    if (target && !target.isBot && n > 0) {
      grudges.push(`${esc(b.p.name)} still held ${n} grudge${n > 1 ? 's' : ''} against ${esc(target.name)}`);
    }
  }
}

// map data for the client-side painter
const mapData = {
  seed: w.mapSeed || 1,
  size: 40,
  wonderId: beacon ? beacon.id : null,
  islands: w.islands.map((i) => ({
    x: i.x, y: i.y, id: i.id,
    k: i.ownerId == null ? 'free'
      : i.ownerId === (w.winner && w.players.find((p) => p.name === w.winner.name) || {}).id ? 'win'
      : !byId(i.ownerId).isBot ? 'human' : 'bot',
    n: i.name, o: i.ownerId == null ? null : nameOf(i.ownerId),
  })),
};

const winnerLine = w.winner
  ? `Won by <b>${esc(w.winner.name)}</b> ${w.winner.via === 'wonder' ? 'by the Great Beacon' : 'by dominance'} — ${w.winner.islands} of ${w.winner.total} islands (${w.winner.share}%).`
  : 'This world ended without a victor.';

const rows = (list, offset = 0) => list.map((h, i) =>
  `<tr><td>${offset + i + 1}</td><td>${esc(h.p.name)}${h.p.isBot ? ' <small>[bot]</small>' : ''}</td><td class="num">${h.isl}</td><td class="num">${h.pts}</td></tr>`).join('\n');

// Only claim what the archive attests — season-2 stats are sparse
// (conquests didn't bump `wins` in that engine), so zeros would lie.
const recordLine = (h) => {
  const st = h.p.stats || {};
  const bits = [`held ${h.isl} island${h.isl === 1 ? '' : 's'} at the end`];
  if (st.wins) bits.push(`won ${st.wins} battle${st.wins === 1 ? '' : 's'}`);
  if (st.trained) bits.push(`trained ${st.trained} units`);
  return `<b>${esc(h.p.name)}</b>: ${bits.join(', ')}`;
};

console.log(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tideholm — Season ${esc(seasonNo)} Chronicle</title>
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #0e2a3f; font-family: Georgia, serif; color: #3a2c17; }
.sheet { max-width: 780px; margin: 26px auto; padding: 28px 34px;
  background: radial-gradient(ellipse at 50% 0%, rgba(255,248,225,.5), transparent 60%),
    linear-gradient(180deg, #e8d9b0, #d8c493);
  border: 2px solid #55401d; outline: 6px solid #241708; border-radius: 6px;
  box-shadow: 0 14px 34px rgba(0,0,0,.6), inset 0 0 55px rgba(120,90,40,.25); }
h1 { font-weight: normal; margin: 0; letter-spacing: .5px; }
h2 { font-weight: normal; border-bottom: 1px solid rgba(124,95,50,.45); padding-bottom: 4px; }
.mast { color: #6b5535; font-style: italic; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 9px; border-bottom: 1px solid rgba(124,95,50,.32); }
th { background: rgba(160,128,70,.22); font-weight: normal; }
.num { text-align: right; }
tr:nth-child(odd) { background: rgba(255,246,220,.28); }
#map { display: block; width: 100%; max-width: 560px; margin: 10px auto;
  border: 2px solid #241708; border-radius: 4px; image-rendering: auto; }
.dispatch { border-left: 3px solid #8a6a24; padding: 4px 12px; margin: 10px 0;
  background: rgba(255,246,220,.4); }
.dispatch small { color: #6b5535; }
.quiet { color: #6b5535; }
a { color: #55401d; }
footer { margin-top: 22px; font-size: 12.5px; color: #6b5535; }
</style>
</head>
<body>
<div class="sheet">
  <h1>🏝️ Tideholm — Chronicle of Season ${esc(seasonNo)}</h1>
  <p class="mast">${fmtDate(start)} — ${fmtDate(end)} · ${days} day${days > 1 ? 's' : ''} · ${winnerLine}</p>

  <h2>The world at its end</h2>
  <canvas id="map" width="560" height="560"></canvas>
  ${beacon ? `<p class="quiet">🗼 The Great Beacon stood at level ${beacon.buildings.wonder} on <b>${esc(beacon.name)}</b> (${beacon.x}:${beacon.y}).</p>` : ''}

  <h2>Final standings</h2>
  <table><tr><th>#</th><th>Player</th><th class="num">Islands</th><th class="num">Points</th></tr>
${rows(humans)}
${rows(bots.slice(0, 5), humans.length)}
  </table>

  <h2>The record</h2>
  <ul>
${humans.map((h) => `    <li>${recordLine(h)}</li>`).join('\n')}
    <li>Tallest wall: level ${wallIsle.buildings.wall || 0} on <b>${esc(wallIsle.name)}</b>${wallIsle.ownerId != null ? ` (${esc(nameOf(wallIsle.ownerId))})` : ''}</li>
    <li>Richest hoard at the end: <b>${esc(hoard.name)}</b> with ${Math.floor(hoard.resources.wood + hoard.resources.stone + hoard.resources.gold)} resources in store</li>
${arrivals.map((a) => `    <li>${a}</li>`).join('\n')}
  </ul>

  <h2>Dispatches from the last days</h2>
${dispatches.map((d) => `  <div class="dispatch"><b>${esc(d.title)}</b> <small>— ${fmtDate(d.time)}, from the log of ${esc(d.who)}</small><br>${esc(d.line)}</div>`).join('\n')}

  ${grudges.length ? `<h2>The grudge ledger</h2>\n  <p class="quiet">${grudges.map(esc => esc).join('; ')}.</p>` : ''}

  <footer>Ruleset of the age: classic pace (speed 1), 72-hour newcomer shield, the 3× band, Beacon victory at level ${beacon ? Math.max(5, beacon.buildings.wonder) : 5}.
  · <a href="../">Return to the living world</a></footer>
</div>

<script>
// The season's final map, from the same seeded painter the game uses.
const M = ${JSON.stringify(mapData)};
function hash2(x, y, seed) {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const sm = (t) => t * t * (3 - 2 * t);
  const tx = sm(x - xi), ty = sm(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
function fbm(x, y, seed) {
  return 0.55 * valueNoise(x, y, seed) + 0.3 * valueNoise(x * 2.1, y * 2.1, seed ^ 99991)
    + 0.15 * valueNoise(x * 4.3, y * 4.3, seed ^ 31337);
}
const P = 14, RES = M.size * P;
const cv = document.getElementById('map');
cv.width = RES; cv.height = RES;
const ctx = cv.getContext('2d');
const land = new Uint8Array(RES * RES);
for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++)
  land[y * RES + x] = fbm(x / (6.8 * P), y / (6.8 * P), M.seed) > 0.60 ? 1 : 0;
for (const isl of M.islands) {
  const cx = (isl.x + 0.5) * P, cy = (isl.y + 0.5) * P, r = P * 1.4;
  for (let y = Math.max(0, cy - r | 0); y < Math.min(RES, cy + r); y++)
    for (let x = Math.max(0, cx - r | 0); x < Math.min(RES, cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) land[y * RES + x] = 0;
}
const img = ctx.createImageData(RES, RES);
const isLand = (x, y) => x >= 0 && y >= 0 && x < RES && y < RES && land[y * RES + x] === 1;
for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
  const i = y * RES + x, n = hash2(x, y, M.seed ^ 7) * 12 - 6;
  let r, g, b;
  if (land[i]) {
    const coast = !isLand(x-1,y) || !isLand(x+1,y) || !isLand(x,y-1) || !isLand(x,y+1);
    [r, g, b] = coast ? [143+n, 124+n, 82+n] : [201+n, 185+n, 138+n];
  } else {
    let sh = false;
    for (let dy = -2; dy <= 2 && !sh; dy++) for (let dx = -2; dx <= 2 && !sh; dx++)
      if (isLand(x+dx, y+dy)) sh = true;
    [r, g, b] = sh ? [29+n, 90+n, 116+n] : [18+n, 52+n, 76+n];
  }
  img.data[i*4] = r; img.data[i*4+1] = g; img.data[i*4+2] = b; img.data[i*4+3] = 255;
}
ctx.putImageData(img, 0, 0);
const COLORS = { win: '#c9a24b', human: '#3b7dd8', bot: '#c06a28', free: '#a9b0b8' };
for (const isl of M.islands) {
  const cx = (isl.x + 0.5) * P, cy = (isl.y + 0.5) * P;
  ctx.beginPath();
  ctx.arc(cx, cy, P * 0.42, 0, 7);
  ctx.fillStyle = COLORS[isl.k];
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.5)';
  ctx.stroke();
  if (isl.id === M.wonderId) {
    ctx.strokeStyle = '#ffe9b0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, P * 0.75, 0, 7);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
</script>
</body>
</html>`);
