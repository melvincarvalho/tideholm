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

// ---------------------------------------------------------------- api

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// ---------------------------------------------------------------- auth

$('auth-form').addEventListener('submit', (e) => e.preventDefault());

for (const btn of document.querySelectorAll('.auth-buttons button')) {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const mode = btn.dataset.mode;
    $('auth-error').textContent = '';
    try {
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
  await api('/api/logout', {});
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
$('tab-alliance').addEventListener('click', () => { showTab('alliance'); loadAlliance(); });
$('tab-messages').addEventListener('click', () => { showTab('messages'); loadMessages(); });

function showTab(which) {
  for (const t of ['island', 'map', 'reports', 'rankings', 'alliance', 'messages']) {
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

  $('who').textContent = state.player.name;
  $('island-title').textContent = `${isl.name} (${isl.x}:${isl.y}) — ${isl.points} ${T('ui.points')}`;

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
  let finished = false;
  for (const el of document.querySelectorAll('.countdown')) {
    const left = (Number(el.dataset.finish) - now) / 1000;
    el.textContent = fmtTime(left);
    if (left <= 0) finished = true;
  }
  if (finished) refresh();
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
  grid.style.gridTemplateColumns = `repeat(${data.size}, 16px)`;
  grid.innerHTML = '';
  const byCoord = new Map(data.islands.map((i) => [`${i.x},${i.y}`, i]));
  for (let y = 0; y < data.size; y++) {
    for (let x = 0; x < data.size; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const isl = byCoord.get(`${x},${y}`);
      if (isl) {
        cell.classList.add('island',
          isl.isYou ? 'you' : isl.unowned ? 'unowned' : isl.isBot ? 'bot' : 'player');
        const ownerLabel = isl.unowned ? T('ui.map.uninhabited')
          : (isl.alliance ? `[${isl.alliance}] ` : '') + isl.owner + (isl.isBot ? ' ' + T('ui.map.bot') : '');
        cell.title = `${isl.name} (${x}:${y})\n${ownerLabel} — ${isl.points} ${T('ui.map.pts')}`;
        if (!isl.isYou) cell.addEventListener('click', () => openAttackPanel(isl));
      }
      grid.appendChild(cell);
    }
  }
}

// ---------------------------------------------------------------- attack

let attackTarget = null;

function openAttackPanel(target) {
  attackTarget = target;
  $('attack-error').textContent = '';
  $('attack-form').classList.toggle('hidden', target.unowned);
  $('colonize-form').classList.toggle('hidden', !target.unowned);

  if (target.unowned) {
    $('attack-title').textContent = T('ui.colonize.title', { name: target.name, x: target.x, y: target.y });
    const ships = state.unitTypes.colonyship;
    const dist = Math.hypot(state.island.x - target.x, state.island.y - target.y);
    const eta = fmtTime((dist * ships.speed * 60) / state.speed);
    $('colonize-hint').textContent =
      T('ui.colonize.hint', { island: state.island.name, n: ships.count, eta });
    $('colonize-send').disabled = ships.count < 1;
  } else {
    $('attack-title').textContent = T('ui.attack.title', {
      name: target.name, x: target.x, y: target.y,
      owner: target.owner + (target.isBot ? ' ' + T('ui.map.bot') : ''),
    });
    const box = $('attack-units');
    box.innerHTML = '';
    for (const [key, u] of Object.entries(state.unitTypes)) {
      if (u.ship) continue; // ships don't fight
      const row = document.createElement('label');
      row.className = 'attack-row';
      row.innerHTML = `${T('ui.attack.have', { name: u.name, n: u.count })}
        <input type="number" min="0" max="${u.count}" value="0" data-attack-unit="${key}">`;
      box.appendChild(row);
    }
    for (const input of box.querySelectorAll('input')) {
      input.addEventListener('input', updateAttackEta);
    }
    updateAttackEta();
  }
  $('attack-panel').classList.remove('hidden');
  $('attack-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

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

(async function boot() {
  try {
    state = await api('/api/state');
    clockSkew = state.serverNow - Date.now();
    enterGame();
  } catch {
    $('auth').classList.remove('hidden');
  }
  setInterval(localTick, 1000);
})();
