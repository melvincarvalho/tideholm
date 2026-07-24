// Tideholm — client. Vanilla JS: polls /api/state, renders island + map,
// runs local countdowns between polls.

'use strict';

const $ = (id) => document.getElementById(id);

let state = null;         // last /api/state payload
let clockSkew = 0;        // serverNow - Date.now()
let pollTimer = null;
let activeIslandId = null; // which of my islands the island view shows

// ---------------------------------------------------------------- language

const LANG_LABELS = { en: 'English', de: 'Deutsch', cs: 'Čeština' };

let LANG = localStorage.getItem('lang');
if (!I18N.LANGS.includes(LANG)) {
  const nav = (navigator.language || 'en').slice(0, 2);
  LANG = I18N.LANGS.includes(nav) ? nav : 'en';
}

function T(key, params) { return I18N.t(LANG, key, params); }

const HELP_PAGES = { en: '/help.html', de: '/help.de.html', cs: '/help.cs.html' };

function applyStatic() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = T(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = T(el.dataset.i18nPh);
  }
  $('auth-help').href = HELP_PAGES[LANG] || '/help.html';
  $('game-help').href = HELP_PAGES[LANG] || '/help.html';
}

function fillLangSelect(sel) {
  sel.innerHTML = '';
  for (const l of I18N.LANGS) {
    const opt = document.createElement('option');
    opt.value = l;
    opt.textContent = LANG_LABELS[l] || l;
    opt.selected = l === LANG;
    sel.appendChild(opt);
  }
}

async function switchLang(lang) {
  LANG = lang;
  localStorage.setItem('lang', lang);
  fillLangSelect($('auth-lang'));
  fillLangSelect($('game-lang'));
  applyStatic();
  if (state) {
    try { await api('/api/lang', { lang }); } catch { /* offline is fine */ }
    refresh();
  }
}

fillLangSelect($('auth-lang'));
fillLangSelect($('game-lang'));
$('auth-lang').addEventListener('change', () => switchLang($('auth-lang').value));
$('game-lang').addEventListener('change', () => switchLang($('game-lang').value));
applyStatic();

// ---------------------------------------------------------------- theme
// Opt-in parchment theme: purely presentational, per-player, remembered in
// localStorage. All theme CSS is scoped under html[data-theme=parchment],
// so clearing the attribute is a complete revert. ?theme=parchment in the
// URL forces it on (handy for trying/sharing).

function applyTheme(name) {
  // Parchment is the default; 'retro' is the explicit opt-out.
  if (name === 'retro') {
    delete document.documentElement.dataset.theme;
    localStorage.setItem('ui-theme', 'retro');
  } else {
    document.documentElement.dataset.theme = 'parchment';
    localStorage.setItem('ui-theme', 'parchment');
  }
}
{
  const fromUrl = new URLSearchParams(location.search).get('theme');
  applyTheme(fromUrl !== null ? fromUrl : localStorage.getItem('ui-theme') || 'parchment');
}
$('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'parchment' ? 'retro' : 'parchment');
});

// ---------------------------------------------------------------- api

async function api(path, body) {
  // Relative fetch: works when the game is served at / or mounted under a
  // prefix (e.g. /tideholm/ inside a host server).
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const token = localStorage.getItem('tideholm-token');
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path.replace(/^\//, ''), {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Expired/revoked pod token: forget it so the login screen comes back.
    if (res.status === 401 && token) localStorage.removeItem('tideholm-token');
    throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  }
  return data;
}

// Host metadata: who owns identity (password mode vs pod mode)?
let META = { mode: 'password', podLoginUrl: null };

// ---------------------------------------------------------------- auth

$('auth-form').addEventListener('submit', (e) => e.preventDefault());

for (const btn of document.querySelectorAll('.auth-buttons button')) {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const mode = btn.dataset.mode;
    $('auth-error').textContent = '';
    try {
      if (META.mode === 'pod') {
        // The host (e.g. a Solid pod server) owns identity: trade pod
        // credentials for a Bearer token at the host's endpoint (absolute
        // path — it lives at the host root, not under the game's prefix).
        const res = await fetch(META.podLoginUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: $('auth-name').value,
            password: $('auth-pass').value,
          }),
        });
        const cred = await res.json().catch(() => ({}));
        if (!res.ok || !cred.access_token) {
          throw new Error(cred.error_description || cred.error || res.statusText);
        }
        localStorage.setItem('tideholm-token', cred.access_token);
        await api('/api/lang', { lang: LANG }).catch(() => {});
        enterGame();
        return;
      }
      await api(`/api/${mode}`, {
        name: $('auth-name').value,
        password: $('auth-pass').value,
        lang: LANG,
      });
      enterGame();
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  });
}

$('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  localStorage.removeItem('tideholm-token');
  clearInterval(pollTimer);
  state = null;
  $('game').classList.add('hidden');
  $('auth').classList.remove('hidden');
});

// ---------------------------------------------------------------- tabs

$('tab-island').addEventListener('click', () => showTab('island'));
$('tab-map').addEventListener('click', () => { showTab('map'); loadMap(); });
$('tab-reports').addEventListener('click', () => { showTab('reports'); loadReports(); });
$('tab-rankings').addEventListener('click', () => { showTab('rankings'); loadRankings(); });
$('tab-market').addEventListener('click', () => { showTab('market'); loadMarket(); });
$('tab-alliance').addEventListener('click', () => { showTab('alliance'); loadAlliance(); });
$('tab-messages').addEventListener('click', () => { showTab('messages'); loadMessages(); });

function showTab(which) {
  for (const t of ['island', 'map', 'reports', 'rankings', 'market', 'alliance', 'messages']) {
    $(`view-${t}`).classList.toggle('hidden', t !== which);
    $(`tab-${t}`).classList.toggle('active', t === which);
  }
}

// ---------------------------------------------------------------- rendering

function fmtNum(n) {
  n = Math.floor(n);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtTime(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Pregame countdown (#8): show time-to-launch while the world is frozen —
// on both the login screen (from /api/meta) and in-game (from state).
function updatePregameBanner() {
  const phase = (state && state.phase) || META.phase;
  const startAt = (state && state.startAt) || META.startAt;
  const pregame = phase === 'pregame' && !!startAt;
  const left = pregame ? Math.max(0, Math.round((startAt - Date.now()) / 1000)) : 0;
  const text = left > 0
    ? `⏳ ${T('ui.pregame.title')} ${fmtTime(left)}\n${T('ui.pregame.hint')}`
    : T('ui.pregame.go');
  for (const id of ['pregame-banner', 'auth-pregame']) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('hidden', !pregame);
    if (pregame) el.textContent = text;
  }
}
setInterval(updatePregameBanner, 1000);

function renderState() {
  if (!state) return;
  const isl = state.island;
  activeIslandId = isl.id;

  // The server knows the account's language; follow it.
  if (state.lang && state.lang !== LANG && I18N.LANGS.includes(state.lang)) {
    LANG = state.lang;
    localStorage.setItem('lang', LANG);
    fillLangSelect($('auth-lang'));
    fillLangSelect($('game-lang'));
    applyStatic();
  }

  updatePregameBanner();

  const banner = $('winner-banner');
  banner.classList.toggle('hidden', !state.winner);
  if (state.winner) {
    banner.textContent = T('ui.winner', {
      name: state.winner.name,
      n: state.winner.islands,
      total: state.winner.total,
      share: state.winner.share,
    });
  }

  $('who').textContent = state.player.name;
  $('island-title').textContent =
    `${isl.name} (${isl.x}:${isl.y}) — ${isl.points} ${T('ui.points')}` +
    ` · ⚜️ ${T('ui.loyalty')} ${isl.loyalty}/${isl.loyaltyMax}` +
    ` · 👥 ${T('ui.pop')} ${isl.popUsed}/${isl.popCap}`;

  // Island switcher (visible once you hold more than one island)
  const sel = $('island-select');
  sel.classList.toggle('hidden', state.islands.length < 2);
  sel.innerHTML = '';
  for (const i of state.islands) {
    const opt = document.createElement('option');
    opt.value = i.id;
    opt.textContent = `${i.name} (${i.x}:${i.y})`;
    opt.selected = i.id === isl.id;
    sel.appendChild(opt);
  }

  // Unread badges
  const badge = $('report-badge');
  badge.classList.toggle('hidden', !state.unreadReports);
  badge.textContent = state.unreadReports || '';
  const mailBadge = $('mail-badge');
  mailBadge.classList.toggle('hidden', !state.unreadMessages);
  mailBadge.textContent = state.unreadMessages || '';

  // Tutorial quest
  const qbox = $('quest-box');
  qbox.classList.toggle('hidden', !state.quest);
  if (state.quest) {
    const q = state.quest;
    qbox.innerHTML = `<b>${T('ui.quest.progress', { i: q.i, n: q.n })} ${q.name}</b><br>
      <span>${q.desc}</span><br>
      <small>${T('ui.quest.reward')} 🪵${q.reward.wood} 🪨${q.reward.stone} 🪙${q.reward.gold}</small>`;
  }

  renderMovements();

  $('res-cap').textContent = fmtNum(isl.capacity);
  for (const r of ['wood', 'stone', 'gold']) {
    $(`rate-${r}`).textContent = `+${fmtNum(isl.rates[r])}/h`;
  }

  // Queue
  const qbody = $('queue').querySelector('tbody');
  qbody.innerHTML = '';
  if (!isl.queue.length) {
    qbody.innerHTML = `<tr><td colspan="3"><i>${T('ui.queue.empty')}</i></td></tr>`;
  }
  for (const item of isl.queue) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${item.building}</td><td>${T('ui.queue.level', { n: item.level })}</td>
      <td class="countdown" data-finish="${item.finish}"></td>`;
    qbody.appendChild(tr);
  }

  // Buildings
  const bbody = $('buildings').querySelector('tbody');
  bbody.innerHTML = '';
  for (const [key, b] of Object.entries(state.buildings)) {
    const tr = document.createElement('tr');
    const queueFull = isl.queue.length >= isl.queueMax;
    tr.innerHTML = `
      <td><b>${b.name}</b><br><small>${b.desc}</small></td>
      <td>${b.level}</td>
      <td class="cost">🪵 ${b.cost.wood} 🪨 ${b.cost.stone} 🪙 ${b.cost.gold}</td>
      <td>${fmtTime(b.time)}</td>
      <td><button data-build="${key}" ${b.affordable && !queueFull ? '' : 'disabled'}>
        → ${b.nextLevel}</button></td>`;
    bbody.appendChild(tr);
  }
  for (const btn of bbody.querySelectorAll('button[data-build]')) {
    btn.addEventListener('click', () => build(btn.dataset.build));
  }

  renderTroops();

  // Fill the countdown cells this render just created. Deliberately ignores
  // the "finished" result: refresh() is what called us, and re-entering it
  // from here would loop on any item whose finish time has already passed.
  paintCountdowns(Date.now() + clockSkew);
}

function renderMovements() {
  const isl = state.island;
  const box = $('movements');
  box.innerHTML = '';
  for (const inc of state.movements.incoming) {
    const div = document.createElement('div');
    div.className = 'movement incoming';
    div.innerHTML = `${T('ui.move.incoming', { target: inc.target, attacker: inc.attacker, from: inc.from })}
      <span class="countdown" data-finish="${inc.arrive}"></span>`;
    box.appendChild(div);
  }
  for (const out of state.movements.outgoing) {
    const div = document.createElement('div');
    div.className = 'movement outgoing';
    const what = out.type === 'attack' ? T('ui.move.attack', { target: out.target })
      : out.type === 'colonize' ? T('ui.move.colonize', { target: out.target })
      : out.type === 'support' ? T('ui.move.support', { target: out.target })
      : out.type === 'scout' ? T('ui.move.scout', { target: out.target })
      : T('ui.move.return', { target: out.target }) +
        (out.loot ? ` ${T('ui.move.withLoot')} 🪵${out.loot.wood} 🪨${out.loot.stone} 🪙${out.loot.gold}` : '');
    div.innerHTML = `${what} — <span class="countdown" data-finish="${out.arrive}"></span>`;
    box.appendChild(div);
  }
}

function renderTroops() {
  const isl = state.island;
  const ubody = $('units').querySelector('tbody');
  ubody.innerHTML = '';
  for (const [key, u] of Object.entries(state.unitTypes)) {
    const tr = document.createElement('tr');
    const trainCell = u.available
      ? `<input type="number" min="1" max="500" value="${u.ship ? 1 : 5}" id="train-n-${key}">
         <button data-train="${key}">${T('ui.train.button', { t: fmtTime(u.time) })}</button>`
      : `<small class="hint">${T('ui.needs', { building: u.requires })}</small>`;
    tr.innerHTML = `
      <td><b>${u.name}</b><br><small>${u.desc}</small></td>
      <td>${u.count}</td><td>${u.atk}</td><td>${u.def}</td><td>${u.carry}</td>
      <td class="cost">🪵${u.cost.wood} 🪨${u.cost.stone} 🪙${u.cost.gold}</td>
      <td class="train-cell">${trainCell}</td>`;
    ubody.appendChild(tr);
  }
  for (const btn of ubody.querySelectorAll('button[data-train]')) {
    btn.addEventListener('click', () => train(btn.dataset.train));
  }

  const tbody = $('train-queue').querySelector('tbody');
  tbody.innerHTML = '';
  for (const item of isl.trainQueue) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${T('ui.training', { n: item.count, unit: item.unit })}</td>
      <td class="countdown" data-finish="${item.finish}"></td>`;
    tbody.appendChild(tr);
  }

  renderSupport();
}

function unitListText(units) {
  return Object.entries(units)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${state.unitTypes[k] ? state.unitTypes[k].name : k}`)
    .join(', ');
}

function renderSupport() {
  const isl = state.island;

  $('support-here-box').classList.toggle('hidden', !isl.support.length);
  const here = $('support-here');
  here.innerHTML = '';
  for (const c of isl.support) {
    const div = document.createElement('div');
    div.className = 'movement';
    div.textContent = `🛡️ ${c.owner}: ${unitListText(c.units)}`;
    here.appendChild(div);
  }

  $('abroad-box').classList.toggle('hidden', !state.abroad.length);
  const abroad = $('abroad-list');
  abroad.innerHTML = '';
  for (const a of state.abroad) {
    const div = document.createElement('div');
    div.className = 'movement';
    div.innerHTML = `🛡️ ${a.name} (${a.x}:${a.y}): ${unitListText(a.units)}
      <button data-withdraw="${a.x},${a.y}">${T('ui.support.withdraw')}</button>`;
    abroad.appendChild(div);
  }
  for (const btn of abroad.querySelectorAll('button[data-withdraw]')) {
    btn.addEventListener('click', async () => {
      const [x, y] = btn.dataset.withdraw.split(',').map(Number);
      try {
        state = await api('/api/withdraw', { x, y, islandId: activeIslandId });
        clockSkew = state.serverNow - Date.now();
        renderState();
      } catch (err) {
        $('build-error').textContent = err.message;
      }
    });
  }
}

// Write the time remaining into every .countdown element. Returns true if any
// of them has run out. renderState() calls this too: it builds countdown cells
// empty, and without an immediate paint they would stay blank until the next
// localTick — up to a second in which the cell has no text, so the table
// reflows around it and visibly jumps (#24).
function paintCountdowns(now) {
  let finished = false;
  for (const el of document.querySelectorAll('.countdown')) {
    const left = (Number(el.dataset.finish) - now) / 1000;
    el.textContent = fmtTime(left);
    if (left <= 0) finished = true;
  }
  return finished;
}

// Smooth local tick: advance resource counters and countdowns between polls.
function localTick() {
  if (!state) return;
  const isl = state.island;
  const now = Date.now() + clockSkew;
  const dt = (now - state.serverNow) / 3600000;
  for (const r of ['wood', 'stone', 'gold']) {
    const val = Math.min(isl.capacity, isl.resources[r] + isl.rates[r] * dt);
    $(`res-${r}`).textContent = fmtNum(val);
  }
  if (paintCountdowns(now)) refresh();
}

// ---------------------------------------------------------------- actions

async function build(key) {
  $('build-error').textContent = '';
  try {
    state = await api('/api/build', { building: key, islandId: activeIslandId });
    clockSkew = state.serverNow - Date.now();
    renderState();
  } catch (err) {
    $('build-error').textContent = err.message;
    refresh();
  }
}

async function train(key) {
  $('train-error').textContent = '';
  const count = Number($(`train-n-${key}`).value);
  try {
    state = await api('/api/train', { unit: key, count, islandId: activeIslandId });
    clockSkew = state.serverNow - Date.now();
    renderState();
  } catch (err) {
    $('train-error').textContent = err.message;
  }
}

$('island-select').addEventListener('change', () => {
  activeIslandId = Number($('island-select').value);
  refresh();
});

$('rename-btn').addEventListener('click', async () => {
  const name = prompt(T('ui.rename.prompt'), state ? state.island.name : '');
  if (!name) return;
  $('build-error').textContent = '';
  try {
    state = await api('/api/rename', { name, islandId: activeIslandId });
    clockSkew = state.serverNow - Date.now();
    renderState();
  } catch (err) {
    $('build-error').textContent = err.message;
  }
});

async function refresh() {
  try {
    state = await api('/api/state' + (activeIslandId ? `?island=${activeIslandId}` : ''));
    clockSkew = state.serverNow - Date.now();
    renderState();
  } catch (err) {
    if (err.status === 401) {
      clearInterval(pollTimer);
      $('game').classList.add('hidden');
      $('auth').classList.remove('hidden');
    }
  }
}

// ---------------------------------------------------------------- map

async function loadMap() {
  const data = await api('/api/map');
  const grid = $('map-grid');
  grid.style.gridTemplateColumns = `repeat(${data.size}, var(--cell))`;
  grid.innerHTML = '';
  let myCell = null;
  const byCoord = new Map(data.islands.map((i) => [`${i.x},${i.y}`, i]));
  for (let y = 0; y < data.size; y++) {
    for (let x = 0; x < data.size; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const isl = byCoord.get(`${x},${y}`);
      if (isl) {
        cell.classList.add('island',
          isl.isYou ? 'you' : isl.unowned ? 'unowned'
            : isl.barbarian ? 'barb' : isl.isBot ? 'bot' : 'player');
        if (isl.relation === 'ally' || isl.relation === 'same') cell.classList.add('rel-ally');
        if (isl.relation === 'war') cell.classList.add('rel-war');
        const ownerLabel = isl.unowned ? T('ui.map.uninhabited')
          : (isl.alliance ? `[${isl.alliance}] ` : '') + isl.owner
            + (isl.barbarian ? ' ' + T('ui.map.barbarian')
              : isl.isBot ? ' ' + T('ui.map.bot') : '');
        let title = `${isl.name} (${x}:${y})\n${ownerLabel} — ${isl.points} ${T('ui.map.pts')}`;
        if (isl.relation && isl.relation !== 'same') title += `\n${T('ui.dip.' + isl.relation)}`;
        if (isl.intel) title += `\n${T('ui.map.intel', { def: isl.intel.def, h: isl.intel.hours })}`;
        cell.title = title;
        const isActive = state && isl.x === state.island.x && isl.y === state.island.y;
        if (isActive) myCell = cell;
        if (!isActive) cell.addEventListener('click', () => openAttackPanel(isl));
      }
      grid.appendChild(cell);
    }
  }
  // Center the view on your island.
  if (myCell) myCell.scrollIntoView({ block: 'center', inline: 'center' });

  lastMapData = data;
  await paintMapBackground(data);
  drawMinimap(data);
}

// ---------------------------------------------------------------- map background

// Two painters over the same grid: 'generated' draws a seeded fictional
// chart from value noise; 'aegean' draws a real coastline mask (Natural
// Earth, public domain). Both are pure decoration — the server never knows.

let lastMapData = null;
let rasterCache = null;
let rasterKey = '';
let regionMask = null; // fetched land mask for real-world themes

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
  return 0.55 * valueNoise(x, y, seed)
    + 0.3 * valueNoise(x * 2.1, y * 2.1, seed ^ 99991)
    + 0.15 * valueNoise(x * 4.3, y * 4.3, seed ^ 31337);
}

// Build the offscreen raster once per (theme, seed): 5 px per grid cell.
function buildRaster(data) {
  const key = data.theme + ':' + data.seed;
  if (rasterCache && rasterKey === key) return rasterCache;
  const P = 5;
  const RES = data.size * P;
  const canvas = document.createElement('canvas');
  canvas.width = RES;
  canvas.height = RES;
  const ctx = canvas.getContext('2d');

  // 0 = deep sea, 1 = land
  const land = new Uint8Array(RES * RES);
  if (data.theme === 'aegean' && regionMask) {
    for (let y = 0; y < RES; y++) {
      const my = Math.floor((y / RES) * regionMask.h);
      const row = regionMask.rows[my];
      for (let x = 0; x < RES; x++) {
        land[y * RES + x] = row[Math.floor((x / RES) * regionMask.w)] === '1' ? 1 : 0;
      }
    }
  } else {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        land[y * RES + x] = fbm(x / 34, y / 34, data.seed) > 0.60 ? 1 : 0;
      }
    }
  }

  // Every game island sits in a dredged lagoon — no dots on dry land.
  for (const isl of data.islands) {
    const cx = (isl.x + 0.5) * P, cy = (isl.y + 0.5) * P;
    for (let y = Math.max(0, cy - 7 | 0); y < Math.min(RES, cy + 7); y++) {
      for (let x = Math.max(0, cx - 7 | 0); x < Math.min(RES, cx + 7); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= 42) land[y * RES + x] = 0;
      }
    }
  }

  const img = ctx.createImageData(RES, RES);
  const set = (i, r, g, b) => {
    img.data[i * 4] = r; img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  };
  const isLand = (x, y) => x >= 0 && y >= 0 && x < RES && y < RES && land[y * RES + x] === 1;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      const n = hash2(x, y, data.seed ^ 7) * 12 - 6; // subtle texture
      if (land[i]) {
        const coast = !isLand(x - 1, y) || !isLand(x + 1, y) || !isLand(x, y - 1) || !isLand(x, y + 1);
        if (coast) set(i, 143 + n, 124 + n, 82 + n);
        else set(i, 201 + n, 185 + n, 138 + n);
      } else {
        let shallow = false;
        for (let dy = -2; dy <= 2 && !shallow; dy++) {
          for (let dx = -2; dx <= 2 && !shallow; dx++) {
            if (isLand(x + dx, y + dy)) shallow = true;
          }
        }
        if (shallow) set(i, 29 + n, 90 + n, 116 + n);
        else set(i, 18 + n, 52 + n, 76 + n);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  rasterCache = canvas;
  rasterKey = key;
  return canvas;
}

async function paintMapBackground(data) {
  if (data.theme === 'aegean' && !regionMask) {
    try {
      regionMask = await (await fetch('maps/aegean.json')).json();
    } catch { /* fall back to generated look */ }
  }
  const grid = $('map-grid');
  let bg = $('map-bg');
  if (!bg) {
    bg = document.createElement('canvas');
    bg.id = 'map-bg';
    grid.insertBefore(bg, grid.firstChild);
  }
  bg.width = grid.scrollWidth;
  bg.height = grid.scrollHeight;
  const ctx = bg.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buildRaster(data), 0, 0, bg.width, bg.height);
}

// ---------------------------------------------------------------- minimap & zoom

const MINI_COLORS = {
  you: '#3faf46', ally: '#2ab5a5', war: '#ff5544',
  player: '#3b7dd8', bot: '#e08030', barb: '#8d7b64', unowned: '#a9b0b8',
};

function drawMinimap(data) {
  const canvas = $('minimap');
  const ctx = canvas.getContext('2d');
  const px = canvas.width / data.size;
  ctx.fillStyle = '#0e2a3f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buildRaster(data), 0, 0, canvas.width, canvas.height);
  for (const isl of data.islands) {
    const kind = isl.isYou ? 'you'
      : isl.relation === 'war' ? 'war'
      : isl.relation === 'ally' || isl.relation === 'same' ? 'ally'
      : isl.unowned ? 'unowned' : isl.barbarian ? 'barb' : isl.isBot ? 'bot' : 'player';
    ctx.fillStyle = MINI_COLORS[kind];
    ctx.fillRect(isl.x * px, isl.y * px, Math.max(2, px - 1), Math.max(2, px - 1));
  }
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * data.size);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * data.size);
    const cell = $('map-grid').children[y * data.size + x];
    if (cell) cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  };
}

const ZOOM_SIZES = [8, 11, 16, 22];

function applyZoom(px) {
  document.documentElement.style.setProperty('--cell', px + 'px');
  localStorage.setItem('cellSize', px);
  if (lastMapData) paintMapBackground(lastMapData);
}

function zoomStep(dir) {
  const cur = Number(localStorage.getItem('cellSize')) || 16;
  const idx = Math.max(0, Math.min(ZOOM_SIZES.length - 1,
    ZOOM_SIZES.indexOf(ZOOM_SIZES.reduce((a, b) =>
      Math.abs(b - cur) < Math.abs(a - cur) ? b : a)) + dir));
  applyZoom(ZOOM_SIZES[idx]);
}

$('zoom-in').addEventListener('click', () => zoomStep(1));
$('zoom-out').addEventListener('click', () => zoomStep(-1));
if (localStorage.getItem('cellSize')) applyZoom(Number(localStorage.getItem('cellSize')));

// ---------------------------------------------------------------- attack

let attackTarget = null;

function openAttackPanel(target) {
  attackTarget = target;
  $('attack-error').textContent = '';
  $('attack-form').classList.toggle('hidden', target.unowned);
  $('colonize-form').classList.toggle('hidden', !target.unowned);

  $('trade-form').classList.add('hidden');
  if (target.unowned) {
    $('attack-title').textContent = T('ui.colonize.title', { name: target.name, x: target.x, y: target.y });
    const ships = state.unitTypes.colonyship;
    const dist = Math.hypot(state.island.x - target.x, state.island.y - target.y);
    const eta = fmtTime((dist * ships.speed * 60) / state.speed);
    $('colonize-hint').textContent =
      T('ui.colonize.hint', { island: state.island.name, n: ships.count, eta });
    $('colonize-send').disabled = ships.count < 1;
  } else {
    // Trade form for any inhabited island (own islands included).
    $('trade-form').classList.remove('hidden');
    $('trade-cap').textContent = T('ui.trade.cap', { cap: state.island.tradeCap });
    $('trade-send').disabled = state.island.tradeCap < 1;

    const supportOnly = target.isYou;
    $('attack-title').textContent = supportOnly
      ? T('ui.support.title', { name: target.name, x: target.x, y: target.y })
      : T('ui.attack.title', {
          name: target.name, x: target.x, y: target.y,
          owner: target.owner + (target.isBot ? ' ' + T('ui.map.bot') : ''),
        });
    $('attack-send').classList.toggle('hidden', supportOnly);
    $('flagship-hint').classList.toggle('hidden', supportOnly);
    $('scout-box').classList.toggle('hidden', supportOnly);
    const box = $('attack-units');
    box.innerHTML = '';
    for (const [key, u] of Object.entries(state.unitTypes)) {
      if (u.ship || key === 'scout') continue; // ships sail their own missions, scouts spy
      const row = document.createElement('label');
      row.className = 'attack-row';
      row.innerHTML = `${T('ui.attack.have', { name: u.name, n: u.count })}
        <input type="number" min="0" max="${u.count}" value="0" data-attack-unit="${key}">`;
      box.appendChild(row);
    }
    $('scout-n').max = state.unitTypes.scout.count;
    for (const input of box.querySelectorAll('input')) {
      input.addEventListener('input', updateAttackEta);
      input.addEventListener('input', runSimulator);
    }
    updateAttackEta();
    $('sim-box').classList.toggle('hidden', supportOnly);
    if (!supportOnly) {
      renderSimulator();
      runSimulator(); // show the scouted-defense verdict immediately on select
    }
  }
  $('attack-panel').classList.remove('hidden');
  $('attack-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('support-send').addEventListener('click', async () => {
  if (!attackTarget) return;
  $('attack-error').textContent = '';
  try {
    state = await api('/api/support', {
      x: attackTarget.x,
      y: attackTarget.y,
      units: selectedArmy(),
      islandId: activeIslandId,
    });
    clockSkew = state.serverNow - Date.now();
    renderState();
    $('attack-panel').classList.add('hidden');
    attackTarget = null;
    showTab('island');
  } catch (err) {
    $('attack-error').textContent = err.message;
  }
});

$('scout-send').addEventListener('click', async () => {
  if (!attackTarget) return;
  $('attack-error').textContent = '';
  try {
    state = await api('/api/scout', {
      x: attackTarget.x,
      y: attackTarget.y,
      count: Number($('scout-n').value),
      islandId: activeIslandId,
    });
    clockSkew = state.serverNow - Date.now();
    renderState();
    $('attack-panel').classList.add('hidden');
    attackTarget = null;
    showTab('island');
  } catch (err) {
    $('attack-error').textContent = err.message;
  }
});

$('trade-send').addEventListener('click', async () => {
  if (!attackTarget) return;
  $('attack-error').textContent = '';
  try {
    state = await api('/api/trade', {
      x: attackTarget.x,
      y: attackTarget.y,
      resources: {
        wood: Number($('trade-wood').value),
        stone: Number($('trade-stone').value),
        gold: Number($('trade-gold').value),
      },
      islandId: activeIslandId,
    });
    clockSkew = state.serverNow - Date.now();
    renderState();
    $('attack-panel').classList.add('hidden');
    attackTarget = null;
    showTab('island');
  } catch (err) {
    $('attack-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- simulator

// Same formula the server uses: D = (def + 15*wall) * (1 + 0.08*wall), and
// A = raw attack * morale. Morale (#9): an attacker who far outweighs the
// defender loses power — max(0.3, sqrt(defPts/atkPts)) — exactly as game.js
// resolves it. When the selected target has scout intel we simulate against
// that real (effective) defense; the manual boxes remain for hypotheticals.
function runSimulator() {
  if (!state) return;
  const army = selectedArmy();
  let Araw = 0;
  for (const [k, n] of Object.entries(army)) Araw += state.unitTypes[k].atk * n;

  const atkPts = (state.player && state.player.points) || 0;
  const defPts = (attackTarget && attackTarget.ownerPoints) || 0;
  // Match the server: a separate morale floor when the defender is a bot.
  const floor = attackTarget && attackTarget.isBot
    ? (state.botMoraleFloor ?? 0.3)
    : (state.moraleFloor ?? 0.3);
  let morale = 1;
  if (atkPts > 0 && defPts > 0 && atkPts > defPts) morale = Math.max(floor, Math.sqrt(defPts / atkPts));
  const A = Araw * morale;

  // Show the attacker's own side so the matchup is legible at a glance —
  // your power (raw→after-morale when it bites) vs the defence D — instead
  // of a bare verdict. Makes "my attack is 0" or "morale gutted me" obvious.
  const num = (n) => Math.round(n).toLocaleString();
  const power = () => (morale < 0.995
    ? `${num(Araw)}→${num(A)} (${T('ui.sim.morale', { pct: Math.round(morale * 100) })})`
    : num(A));

  // A verdict for an A-vs-D matchup. Attacker survivors on a win; defender
  // survivors on a hold only when their unit breakdown is known (manual box
  // case) — scouted intel is an aggregate number, so it holds "plain".
  const verdict = (a, d, defenders) => {
    if (a > d) {
      const lossFrac = d > 0 ? Math.pow(d / a, 1.5) : 0;
      const surv = Object.entries(army)
        .map(([k, n]) => [k, Math.max(0, Math.min(n, Math.round(n * (1 - lossFrac))))])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${state.unitTypes[k].name}`).join(', ') || '—';
      return T('ui.sim.win', { units: surv });
    }
    if (defenders) {
      const defLossFrac = d > 0 ? Math.pow(a / d, 1.5) : 0;
      const left = Object.entries(defenders)
        .map(([k, n]) => [k, Math.max(0, Math.min(n, Math.round(n * (1 - defLossFrac))))])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${state.unitTypes[k].name}`).join(', ') || '—';
      return T('ui.sim.hold', { units: left });
    }
    return T('ui.sim.holdPlain');
  };

  // "⚔️ <your power> vs def <D> — <verdict>"
  const matchup = (d, defenders) => `${T('ui.sim.matchup', { a: power(), d: num(d) })} — ${verdict(A, d, defenders)}`;

  const lines = [];

  // Primary line: the real target's latest scout intel, if we have it.
  if (attackTarget && attackTarget.intel) {
    lines.push(`${T('ui.sim.scouted', { h: attackTarget.intel.hours })} ${matchup(attackTarget.intel.def, null)}`);
  }

  // Manual "assumed defense" from the boxes.
  let def = 0;
  const defenders = {};
  for (const input of document.querySelectorAll('[data-sim-unit]')) {
    const n = Math.max(0, Math.floor(Number(input.value) || 0));
    defenders[input.dataset.simUnit] = n;
    def += state.unitTypes[input.dataset.simUnit].def * n;
  }
  const wall = Math.max(0, Math.floor(Number($('sim-wall').value) || 0));
  const D = Math.round((def + 15 * wall) * (1 + 0.08 * wall));
  // Label the manual line so it can't be mistaken for a second verdict on
  // the real target — it's clearly "vs the numbers you typed" (#9 follow-up).
  if (def > 0) {
    const prefix = attackTarget && attackTarget.intel ? `${T('ui.sim.custom')} ` : '';
    lines.push(`${prefix}${matchup(D, defenders)}`);
  }

  const out = $('sim-result');
  out.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    out.appendChild(div);
  }
}

function renderSimulator() {
  const box = $('sim-units');
  box.innerHTML = '';
  for (const [key, u] of Object.entries(state.unitTypes)) {
    if (u.ship || key === 'scout' || key === 'flagship') continue;
    const label = document.createElement('label');
    label.className = 'sim-cell';
    label.innerHTML = `${u.name} <input type="number" min="0" value="0" data-sim-unit="${key}">`;
    box.appendChild(label);
  }
  for (const input of box.querySelectorAll('input')) {
    input.addEventListener('input', runSimulator);
  }
  $('sim-wall').value = 0;
  $('sim-result').textContent = '';
}

$('sim-wall').addEventListener('input', runSimulator);

$('colonize-send').addEventListener('click', async () => {
  if (!attackTarget) return;
  $('attack-error').textContent = '';
  try {
    state = await api('/api/colonize', {
      x: attackTarget.x,
      y: attackTarget.y,
      islandId: activeIslandId,
    });
    clockSkew = state.serverNow - Date.now();
    renderState();
    $('attack-panel').classList.add('hidden');
    attackTarget = null;
    showTab('island');
  } catch (err) {
    $('attack-error').textContent = err.message;
  }
});

function selectedArmy() {
  const units = {};
  for (const input of document.querySelectorAll('[data-attack-unit]')) {
    units[input.dataset.attackUnit] = Math.max(0, Math.floor(Number(input.value) || 0));
  }
  return units;
}

function updateAttackEta() {
  if (!attackTarget || !state) return;
  const units = selectedArmy();
  const dist = Math.hypot(state.island.x - attackTarget.x, state.island.y - attackTarget.y);
  let slowest = 0;
  for (const [k, n] of Object.entries(units)) {
    if (n > 0) slowest = Math.max(slowest, state.unitTypes[k].speed);
  }
  $('attack-eta').textContent = slowest
    ? fmtTime((dist * slowest * 60) / state.speed) + ' ' + T('ui.attack.eachWay')
    : '—';
}

$('attack-send').addEventListener('click', async () => {
  if (!attackTarget) return;
  $('attack-error').textContent = '';
  try {
    state = await api('/api/attack', {
      x: attackTarget.x,
      y: attackTarget.y,
      units: selectedArmy(),
      islandId: activeIslandId,
    });
    clockSkew = state.serverNow - Date.now();
    renderState();
    $('attack-panel').classList.add('hidden');
    attackTarget = null;
    showTab('island');
  } catch (err) {
    $('attack-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- reports

async function loadReports() {
  const data = await api('/api/reports');
  const box = $('report-list');
  box.innerHTML = '';
  if (!data.reports.length) {
    box.innerHTML = `<p class="hint">${T('ui.reports.empty')}</p>`;
  }
  for (const r of data.reports) {
    const div = document.createElement('div');
    div.className = 'report' + (r.read ? '' : ' unread');
    const when = new Date(r.time).toLocaleString();
    div.innerHTML = `<b>${r.title}</b> <small>${when}</small><br>` +
      r.lines.map((l) => `<span>${l}</span>`).join('<br>');
    box.appendChild(div);
  }
  refresh(); // clears the unread badge
}

// ---------------------------------------------------------------- rankings

async function loadRankings() {
  const data = await api('/api/rankings');

  // Great Beacons in progress
  $('wonders-box').classList.toggle('hidden', !data.wonders.length);
  const wbox = $('wonders-list');
  wbox.innerHTML = '';
  for (const won of data.wonders) {
    const div = document.createElement('div');
    div.className = 'movement';
    div.textContent = T('ui.wonder.progress', {
      name: won.name, island: won.island, lvl: won.level, max: won.max,
    });
    wbox.appendChild(div);
  }

  // Hall of fame — past seasons
  $('hof-box').classList.toggle('hidden', !data.hallOfFame.length);
  const hbox = $('hof-list');
  hbox.innerHTML = '';
  for (const entry of [...data.hallOfFame].reverse()) {
    const div = document.createElement('div');
    div.className = 'movement';
    // Each hall line links to that season's chronicle page (static,
    // generated at the boundary by tools/chronicle.js).
    const a = document.createElement('a');
    a.href = `seasons/season-${entry.season}.html`;
    a.target = '_blank';
    a.textContent = '🏆 ' + T('ui.hof.line', {
      n: entry.season, name: entry.name, islands: entry.islands,
      total: entry.total, share: entry.share,
    }) + (entry.via === 'wonder' ? ' 🗼' : '');
    div.appendChild(a);
    hbox.appendChild(div);
  }

  const tbody = $('ranking-table').querySelector('tbody');
  tbody.innerHTML = '';
  data.rankings.forEach((row, idx) => {
    const tr = document.createElement('tr');
    if (row.isYou) tr.className = 'me';
    tr.innerHTML = `<td>${idx + 1}</td>
      <td>${row.name}${row.isBot ? ` <small class="hint">${T('ui.map.bot')}</small>` : ''}</td>
      <td>${row.alliance ? '[' + row.alliance + ']' : '—'}</td>
      <td>${row.islands}</td><td>${row.points}</td>`;
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------- market

const RES_EMOJI = { wood: '🪵', stone: '🪨', gold: '🪙' };

function fillResSelects() {
  for (const sel of [$('offer-give-res'), $('offer-want-res')]) {
    if (sel.options.length) continue;
    for (const r of ['wood', 'stone', 'gold']) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = `${RES_EMOJI[r]} ${T('res.' + r)}`;
      sel.appendChild(opt);
    }
  }
  $('offer-want-res').selectedIndex = 2;
}

function offerLabel(o) {
  return T('ui.market.gives', {
    give: `${RES_EMOJI[o.give.res]}${o.give.amount}`,
    want: `${RES_EMOJI[o.want.res]}${o.want.amount}`,
  });
}

async function loadMarket() {
  fillResSelects();
  $('market-error').textContent = '';
  const data = await api('/api/market');
  const mine = data.offers.filter((o) => o.isMine);
  const open = data.offers.filter((o) => !o.isMine);

  $('offers-mine-box').classList.toggle('hidden', !mine.length);
  const mineBox = $('offers-mine');
  mineBox.innerHTML = '';
  for (const o of mine) {
    const div = document.createElement('div');
    div.className = 'movement';
    div.innerHTML = `${offerLabel(o)}
      <button data-cancel="${o.id}">${T('ui.market.cancel')}</button>`;
    mineBox.appendChild(div);
  }

  const openBox = $('offers-open');
  openBox.innerHTML = open.length ? '' : `<p class="hint">${T('ui.market.none')}</p>`;
  for (const o of open) {
    const div = document.createElement('div');
    div.className = 'movement';
    div.innerHTML = `${offerLabel(o)} — ${T('ui.market.by', { name: o.by })} (${o.x}:${o.y})
      <button data-accept-offer="${o.id}">${T('ui.market.accept')}</button>`;
    openBox.appendChild(div);
  }

  const act = async (path, body) => {
    $('market-error').textContent = '';
    try {
      await api(path, body);
      loadMarket();
      refresh();
    } catch (err) {
      $('market-error').textContent = err.message;
    }
  };
  for (const btn of mineBox.querySelectorAll('button[data-cancel]')) {
    btn.addEventListener('click', () => act('/api/market/cancel', { id: Number(btn.dataset.cancel) }));
  }
  for (const btn of openBox.querySelectorAll('button[data-accept-offer]')) {
    btn.addEventListener('click', () =>
      act('/api/market/accept', { id: Number(btn.dataset.acceptOffer), islandId: activeIslandId }));
  }
}

$('offer-post').addEventListener('click', async () => {
  $('market-error').textContent = '';
  try {
    await api('/api/market/create', {
      give: { res: $('offer-give-res').value, amount: Number($('offer-give-n').value) },
      want: { res: $('offer-want-res').value, amount: Number($('offer-want-n').value) },
      islandId: activeIslandId,
    });
    loadMarket();
    refresh();
  } catch (err) {
    $('market-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- alliance

async function loadAlliance() {
  $('alliance-error').textContent = '';
  const data = await api('/api/alliance');
  $('alliance-none').classList.toggle('hidden', !!data.alliance);
  $('alliance-mine').classList.toggle('hidden', !data.alliance);

  if (data.alliance) {
    const a = data.alliance;
    $('alliance-title').textContent = `[${a.tag}] ${a.name}`;
    const tbody = $('alliance-members').querySelector('tbody');
    tbody.innerHTML = '';
    for (const m of a.members) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${m.name}</td><td>${m.islands}</td><td>${m.points}</td>`;
      tbody.appendChild(tr);
    }

    // Board
    const board = $('board-list');
    board.innerHTML = a.board.length ? '' : `<p class="hint">${T('ui.board.none')}</p>`;
    for (const post of a.board) {
      const div = document.createElement('div');
      div.className = 'report';
      div.innerHTML = `<b>${post.from}</b> <small>${new Date(post.time).toLocaleString()}</small><br><span></span>`;
      div.querySelector('span').textContent = post.body;
      board.appendChild(div);
    }

    // Diplomacy
    $('dip-note').textContent = a.isLeader ? '' : T('ui.dip.leaderOnly');
    const dip = $('dip-list');
    dip.innerHTML = a.diplomacy.length ? '' : `<p class="hint">${T('ui.dip.noOthers')}</p>`;
    for (const other of a.diplomacy) {
      const div = document.createElement('div');
      div.className = 'movement' + (other.relation === 'war' ? ' incoming' : '');
      const relLabel = other.relation && other.relation !== 'same'
        ? ` — <b>${T('ui.dip.' + other.relation)}</b>` : '';
      let control = '';
      if (a.isLeader) {
        const opts = ['none', 'nap', 'ally', 'war'].map((s) =>
          `<option value="${s}" ${other.stance === s ? 'selected' : ''}>${T('ui.dip.' + s)}</option>`
        ).join('');
        control = `<select data-stance="${other.id}">${opts}</select>`;
      } else {
        control = T('ui.dip.' + other.stance);
      }
      div.innerHTML = `[${other.tag}] ${other.name}${relLabel} &nbsp; ${control}`;
      dip.appendChild(div);
    }
    for (const sel of dip.querySelectorAll('select[data-stance]')) {
      sel.addEventListener('change', () =>
        allianceAction('stance', { allianceId: Number(sel.dataset.stance), stance: sel.value }));
    }
  } else {
    const box = $('alliance-invites');
    box.innerHTML = data.invites.length ? '' : `<p class="hint">${T('ui.alliance.noInvites')}</p>`;
    for (const inv of data.invites) {
      const div = document.createElement('div');
      div.className = 'movement';
      div.innerHTML = `[${inv.tag}] ${inv.name} (${T('ui.alliance.membersOf', { n: inv.members })})
        <button data-accept="${inv.id}">${T('ui.alliance.accept')}</button>
        <button data-decline="${inv.id}">${T('ui.alliance.decline')}</button>`;
      box.appendChild(div);
    }
    for (const btn of box.querySelectorAll('button[data-accept]')) {
      btn.addEventListener('click', () => allianceAction('accept', { allianceId: Number(btn.dataset.accept) }));
    }
    for (const btn of box.querySelectorAll('button[data-decline]')) {
      btn.addEventListener('click', () => allianceAction('decline', { allianceId: Number(btn.dataset.decline) }));
    }
  }
}

async function allianceAction(action, body) {
  $('alliance-error').textContent = '';
  try {
    await api(`/api/alliance/${action}`, body);
    loadAlliance();
  } catch (err) {
    $('alliance-error').textContent = err.message;
  }
}

$('alliance-create').addEventListener('submit', (e) => {
  e.preventDefault();
  allianceAction('create', {
    name: $('alliance-name').value,
    tag: $('alliance-tag').value,
  });
});

$('alliance-invite').addEventListener('submit', (e) => {
  e.preventDefault();
  allianceAction('invite', { name: $('alliance-invite-name').value });
  $('alliance-invite-name').value = '';
});

$('board-form').addEventListener('submit', (e) => {
  e.preventDefault();
  allianceAction('post', { body: $('board-body').value });
  $('board-body').value = '';
});

$('alliance-leave').addEventListener('click', () => {
  if (confirm(T('ui.alliance.leaveConfirm'))) allianceAction('leave', {});
});

// ---------------------------------------------------------------- mail

async function loadMessages() {
  const data = await api('/api/messages');
  const box = $('mail-list');
  box.innerHTML = data.messages.length ? '' : `<p class="hint">${T('ui.mail.empty')}</p>`;
  for (const msg of data.messages) {
    const div = document.createElement('div');
    div.className = 'report' + (msg.read ? '' : ' unread');
    const when = new Date(msg.time).toLocaleString();
    div.innerHTML = `<b>${msg.from}</b> <small>${when}</small>
      <button class="mail-reply" data-reply="${msg.from}">${T('ui.mail.reply')}</button><br><span></span>`;
    div.querySelector('span').textContent = msg.body;
    box.appendChild(div);
  }
  for (const btn of box.querySelectorAll('button[data-reply]')) {
    btn.addEventListener('click', () => {
      $('mail-to').value = btn.dataset.reply;
      $('mail-body').focus();
    });
  }
  refresh(); // clears the unread badge
}

$('mail-compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('mail-error').textContent = '';
  try {
    await api('/api/message', { to: $('mail-to').value, body: $('mail-body').value });
    $('mail-body').value = '';
    $('mail-error').textContent = T('ui.mail.sent');
  } catch (err) {
    $('mail-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------- boot

function enterGame() {
  $('auth').classList.add('hidden');
  $('game').classList.remove('hidden');
  showTab('island');
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

function setupPodAuth() {
  // One button ("sign in with your pod"), pod-username placeholder, and a
  // link to the host's pod-registration page.
  $('auth-name').placeholder = T('ui.auth.podName.ph');
  const login = document.querySelector('.auth-buttons button[data-mode="login"]');
  const register = document.querySelector('.auth-buttons button[data-mode="register"]');
  login.textContent = T('ui.auth.podLogin');
  register.classList.add('hidden');
  const tagline = document.querySelector('[data-i18n="ui.auth.tagline"]');
  if (tagline) tagline.textContent = T('ui.auth.podTagline');
  const help = $('auth-help');
  if (help && !$('pod-create')) {
    const a = document.createElement('a');
    a.id = 'pod-create';
    a.href = '/idp/register';
    a.target = '_blank';
    a.textContent = T('ui.auth.podCreate');
    help.parentNode.insertBefore(a, help);
    help.parentNode.insertBefore(document.createTextNode(' · '), help);
  }
}

(async function boot() {
  META = await api('/api/meta').catch(() => ({ mode: 'password', podLoginUrl: null }));
  if (META.mode === 'pod') setupPodAuth();
  updatePregameBanner(); // show the countdown on the login screen straight away
  try {
    state = await api('/api/state');
    clockSkew = state.serverNow - Date.now();
    enterGame();
  } catch {
    $('auth').classList.remove('hidden');
  }
  setInterval(localTick, 1000);
})();
