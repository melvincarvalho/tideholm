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

// The Almanac is the help. Resolve against this module's own URL (import.meta.url
// is always the correctly-resolved path the browser loaded) so the link works
// whether the game is served at /, /tideholm/, or /tideholm without a trailing
// slash — an absolute '/help.html' resolved to the host root (Cannot GET). The
// Almanac is English today; a localised edition would be keyed here per LANG.
const HELP_URL = new URL('almanac.html', import.meta.url).href;

function applyStatic() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = T(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = T(el.dataset.i18nPh);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = T(el.dataset.i18nTitle);
  }
  $('auth-help').href = HELP_URL;
  $('game-help').href = HELP_URL;
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
$('tab-islands').addEventListener('click', () => { showTab('islands'); renderIslands(); });
$('tab-map').addEventListener('click', () => { showTab('map'); loadMap(); });
$('tab-reports').addEventListener('click', () => { showTab('reports'); loadReports(); });
$('tab-rankings').addEventListener('click', () => { showTab('rankings'); loadRankings(); });
$('tab-market').addEventListener('click', () => { showTab('market'); loadMarket(); refreshFuel(); refreshAnchored(); renderTavernLine(); renderSlip(); });
$('tab-alliance').addEventListener('click', () => { showTab('alliance'); loadAlliance(); });
$('tab-messages').addEventListener('click', () => { showTab('messages'); loadMessages(); });

function showTab(which) {
  for (const t of ['island', 'islands', 'map', 'reports', 'rankings', 'market', 'alliance', 'messages']) {
    $(`view-${t}`).classList.toggle('hidden', t !== which);
    $(`tab-${t}`).classList.toggle('active', t === which);
  }
}

// ---------------------------------------------------------------- islands

// The islands table (#77). No fetch of its own: /api/state already carries a
// row per island, so this renders whatever the last refresh brought back.
// Sorted by defence ascending, because the question it exists to answer is
// "which of mine is undefended" — that answer belongs at the top.
function renderIslands() {
  const tbody = $('islands-table').querySelector('tbody');
  tbody.innerHTML = '';
  if (!state) return;
  const rows = [...state.islands].sort((a, b) => a.defence - b.defence || a.points - b.points);
  for (const i of rows) {
    const tr = document.createElement('tr');
    tr.className = 'clickable' + (i.id === state.island.id ? ' active' : '');
    tr.dataset.islandId = i.id; // hotkeys.js walks these rows with ArrowUp/Down
    const pop = i.popUsed + (i.popAbroad || 0);
    const slots = i.tradeSlots ? `${i.tradeSlots.free}/${i.tradeSlots.total}` : '∞';
    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    tr.appendChild(cell(`${i.name} (${i.x}:${i.y})`));
    tr.appendChild(cell(fmtNum(i.resources.wood), i.resources.wood >= i.capacity ? 'warn' : ''));
    tr.appendChild(cell(fmtNum(i.resources.stone), i.resources.stone >= i.capacity ? 'warn' : ''));
    tr.appendChild(cell(fmtNum(i.resources.gold), i.resources.gold >= i.capacity ? 'warn' : ''));
    tr.appendChild(cell(`${pop}/${i.popCap}`, pop >= i.popCap ? 'warn' : ''));
    tr.appendChild(cell(fmtNum(i.defence), i.defence === 0 ? 'warn' : ''));
    tr.appendChild(cell(String(i.wall)));
    tr.appendChild(cell(slots, i.tradeSlots && i.tradeSlots.free === 0 ? 'warn' : ''));
    tr.appendChild(cell(String(i.points)));
    tr.addEventListener('click', () => {
      selectIsland(i.id);
      showTab('island');
    });
    tbody.appendChild(tr);
  }

  // Totals — only for the columns where a sum is honest. Resources, pop,
  // merchants and points add up; defence and wall stay a dash in the markup,
  // because an attacker meets one island's defence, never the fleet's.
  const sum = (f) => rows.reduce((n, i) => n + f(i), 0);
  $('isl-t-wood').textContent = fmtNum(sum((i) => i.resources.wood));
  $('isl-t-stone').textContent = fmtNum(sum((i) => i.resources.stone));
  $('isl-t-gold').textContent = fmtNum(sum((i) => i.resources.gold));
  // The production row (#77 follow-up, take two): empire output per hour,
  // its own row rather than fine print squeezed under every stock figure.
  $('isl-p-wood').textContent = `+${fmtNum(sum((i) => (i.rates && i.rates.wood) || 0))}/h`;
  $('isl-p-stone').textContent = `+${fmtNum(sum((i) => (i.rates && i.rates.stone) || 0))}/h`;
  $('isl-p-gold').textContent = `+${fmtNum(sum((i) => (i.rates && i.rates.gold) || 0))}/h`;
  $('isl-t-pop').textContent = `${sum((i) => i.popUsed + (i.popAbroad || 0))}/${sum((i) => i.popCap)}`;
  $('isl-t-merch').textContent = rows.some((i) => !i.tradeSlots)
    ? '∞'
    : `${sum((i) => i.tradeSlots.free)}/${sum((i) => i.tradeSlots.total)}`;
  $('isl-t-points').textContent = String(sum((i) => i.points));
  // The average lives one row down, in the Production row's spare Points
  // cell (green, like every derived figure) — the benchmark that tells you
  // which islands drag, without widening the Points column (#165 follow-up).
  $('isl-p-points').textContent = rows.length > 1
    ? T('ui.islands.avg', { n: Math.round(sum((i) => i.points) / rows.length) })
    : '';

  // #104: wealth on the water. Cargo aboard outbound shipments and loot on
  // returning fleets — the resources every other ledger forgets until they
  // dock. Units in transit are counts, not resources; they live in the
  // movements table below, never in this sum.
  const moves = (state.movements && state.movements.outgoing) || [];
  const atSea = (r) => moves.reduce((n, m) => n + ((m.loot && m.loot[r]) || 0), 0);
  $('isl-s-wood').textContent = fmtNum(Math.floor(atSea('wood')));
  $('isl-s-stone').textContent = fmtNum(Math.floor(atSea('stone')));
  $('isl-s-gold').textContent = fmtNum(Math.floor(atSea('gold')));

  // The empire-wide movements table (#104): every fleet and cargo in one
  // place, exactly the view the movements box shows one island at a time.
  const fbody = $('fleet-moves').querySelector('tbody');
  fbody.innerHTML = '';
  if (!moves.length && !(state.movements && state.movements.incoming || []).length) {
    fbody.innerHTML = `<tr><td colspan="4"><i>${T('ui.islands.movNone')}</i></td></tr>`;
  }
  for (const m of moves) {
    const tr = document.createElement('tr');
    // Troops AND loot (#160): a combat return carries both, and the old
    // loot-first ternary hid every soldier aboard — a returning flagship
    // rendered exactly like a trade shipment, so fleets "rematerialized"
    // at home with no visible journey.
    const cargo = [moveUnitsStr(m.units), moveLootStr(m.loot)]
      .filter(Boolean).join(' · ') || '—';
    tr.innerHTML = `<td>${T('ui.move.' + m.type, { target: m.target })}</td>
      <td>${m.from || '—'}</td><td>${cargo}</td>
      <td class="countdown" data-finish="${m.arrive}"></td>`;
    fbody.appendChild(tr);
  }
  for (const inc of (state.movements && state.movements.incoming) || []) {
    const tr = document.createElement('tr');
    tr.className = 'incoming';
    tr.innerHTML = `<td colspan="2">${T('ui.move.incoming', { target: inc.target, attacker: inc.attacker, from: inc.from })}</td>
      <td>—</td><td class="countdown" data-finish="${inc.arrive}"></td>`;
    fbody.appendChild(tr);
  }
  paintCountdowns(Date.now() + clockSkew);
  renderArmy(rows);
}

// #113: the whole holding's military on one screen. A column per unit type you
// actually own (empty types hidden), a row per island with home counts and any
// this-island troops stationed abroad marked, and an empire total. Offensive
// units (raider, flagship) lead; the defensive backbone follows.
const ARMY_ORDER = ['raider', 'flagship', 'spearman', 'sentinel', 'scout', 'colonyship'];
// Raw attack power of the units you actually raid with, HOME only — troops
// stationed abroad are defending elsewhere, not launchable from here. Raw
// meaning before morale (exact vs bots, an upper bound vs a much larger human).
const ATK_WEIGHT = { raider: 24, spearman: 10 };
const homeAtk = (a) => Object.entries(ATK_WEIGHT).reduce(
  (n, [u, w]) => n + ((a && a.home[u]) || 0) * w, 0);
function renderArmy(rows) {
  const own = ARMY_ORDER.filter((u) => rows.some((i) =>
    (i.army && (i.army.home[u] || i.army.abroad[u])) > 0));
  const head = $('army-head');
  head.innerHTML = '<th>' + T('ui.tab.island') + '</th>'
    + '<th class="n">' + T('ui.islands.atk') + '</th>'
    + own.map((u) => `<th class="n">${T(`unit.${u}.name`)}</th>`).join('');
  const body = $('army-table').querySelector('tbody');
  body.innerHTML = '';
  if (!own.length) {
    body.innerHTML = `<tr><td colspan="2"><i>${T('ui.islands.armyNone')}</i></td></tr>`;
    $('army-total').innerHTML = '';
    return;
  }
  for (const i of rows) {
    const tr = document.createElement('tr');
    if (i.id === state.island.id) tr.className = 'active';
    const atk = homeAtk(i.army);
    let cells = `<td>${i.name}</td><td class="n atk">${atk ? fmtNum(atk) : '·'}</td>`;
    for (const u of own) {
      const home = (i.army && i.army.home[u]) || 0;
      const away = (i.army && i.army.abroad[u]) || 0;
      // e.g. "45" or "45 +12" where 12 of this island's troops are abroad.
      cells += `<td class="n">${home || away ? home : '·'}`
        + (away ? ` <small class="hint">+${away}</small>` : '') + '</td>';
    }
    tr.innerHTML = cells;
    body.appendChild(tr);
  }
  const sum = (u) => rows.reduce((n, i) =>
    n + ((i.army && (i.army.home[u] || 0) + (i.army.abroad[u] || 0)) || 0), 0);
  const totalAtk = rows.reduce((n, i) => n + homeAtk(i.army), 0);
  $('army-total').innerHTML = `<th>${T('ui.islands.total')}</th>`
    + `<td class="n atk">${fmtNum(totalAtk)}</td>`
    + own.map((u) => `<td class="n">${sum(u)}</td>`).join('');
}

// ---------------------------------------------------------------- rendering

function fmtNum(n) {
  n = Math.floor(n);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// Movement-cargo formatters (#160). A movement can carry troops, resources,
// or both — a combat return carries both — and every render site must show
// whatever is actually aboard. The old loot-first ternary hid every soldier
// on a looted return, so a returning flagship rendered exactly like a trade
// shipment and fleets "rematerialized" at home with no visible journey.
// Zero-loot returns show no 🪵0 🪨0 🪙0 noise.
function moveUnitsStr(units) {
  return Object.entries(units || {}).filter(([, n]) => n > 0)
    .map(([k, n]) => `${n}× ${T(`unit.${k}.name`)}`).join(', ');
}
function moveLootStr(loot) {
  if (!loot || !Object.values(loot).some((v) => v >= 1)) return '';
  return `🪵${fmtNum(Math.floor(loot.wood))} 🪨${fmtNum(Math.floor(loot.stone))} 🪙${fmtNum(Math.floor(loot.gold))}`;
}

// The next-completion chip (#87): the soonest committed finish across the
// empire — every island's queue heads (from the payload) plus own fleet
// arrivals. The one number that answers "why open the tab now".
let nextChipTarget = null; // { at, label, islandId } — islandId null for fleet
function computeNextChip() {
  if (!state) return null;
  const cands = [];
  for (const i of state.islands) {
    if (i.nextFinish) cands.push({ at: i.nextFinish.at, label: `${i.nextFinish.label} · ${i.name}`, islandId: i.id });
  }
  for (const m of (state.movements && state.movements.outgoing) || []) {
    // Movements carry type+target, not a label — same wording as the
    // Movements list, or the chip prints a fallback at the player (#66).
    if (m.arrive > Date.now()) cands.push({ at: m.arrive, label: T('ui.move.' + m.type, { target: m.target }), islandId: null });
  }
  if (!cands.length) return null;
  return cands.reduce((a, b) => (a.at <= b.at ? a : b));
}
function renderNextChip() {
  const el = $('next-chip');
  if (!el) return;
  if (!nextChipTarget || nextChipTarget.at - Date.now() < -5000) {
    nextChipTarget = computeNextChip();
  }
  if (!nextChipTarget) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const left = Math.max(0, (nextChipTarget.at - Date.now() - clockSkew) / 1000);
  // Minute granularity until the final minute — a calm chip, not a stopwatch.
  const mins = Math.ceil(left / 60);
  const shown = left >= 60
    ? (mins >= 60 ? `${Math.floor(mins / 60)}h` + (mins % 60 ? ` ${mins % 60}m` : '') : `${mins}m`)
    : fmtTime(left);
  $('next-chip-text').textContent = `${nextChipTarget.label} · ${shown}`;
  el.title = nextChipTarget.label;
}
setInterval(renderNextChip, 1000);

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
  // Publish the selection so the stage rails (stage.js, a separate poller)
  // can show the SAME island as this column — otherwise they default to
  // mine[0] and disagree with the main view (#119 follow-up).
  localStorage.setItem('tideholm-island', String(isl.id));
  // And nudge the rail's World Map to move its gold marker NOW, instead of
  // waiting up to 5s for stage.js's own poll to notice the switch (#119).
  window.dispatchEvent(new CustomEvent('tideholm:island', { detail: { x: isl.x, y: isl.y } }));

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
  // Vault balance (#132) — raid-proof gold, shown in the Market tab. When the
  // withdrawal-fee knob is on (0 today), note the rate beside the balance.
  if ($('vault-balance') && state.player.vault != null) {
    let txt = T('ui.vault.balance', { n: fmtNum(state.player.vault) });
    if (state.vaultFee > 0) {
      txt += ' · ' + T('ui.vault.fee', { pct: +(state.vaultFee * 100).toFixed(2) });
    }
    $('vault-balance').textContent = txt;
  }
  // Tidegate sealed balance (#135) — gold pegged out of the vault.
  if ($('tidegate-balance') && state.player.pegged != null) {
    $('tidegate-balance').textContent = T('ui.tidegate.balance', { n: fmtNum(state.player.pegged) });
  }
  // Loyalty and pop moved to the resbar meters (#116). The title now holds
  // only what is stable per island — which also keeps sound.js's "same
  // island?" snapshot from resetting on every loyalty tick.
  $('island-title').textContent =
    `${isl.name} (${isl.x}:${isl.y}) — ${isl.points} ${T('ui.points')}`;

  // The island switcher stays hidden (#112): the dock and the Islands tab are
  // the switchers now. The <select> lives on as the invisible source of truth
  // — selectIsland() sets its value and fires its change event, the dock reads
  // it — so its options must still populate even though it never shows.
  const sel = $('island-select');
  sel.classList.add('hidden');
  sel.innerHTML = '';
  for (const i of state.islands) {
    const opt = document.createElement('option');
    opt.value = i.id;
    opt.textContent = `${i.name} (${i.x}:${i.y})`;
    opt.selected = i.id === isl.id;
    sel.appendChild(opt);
  }

  // Keep the islands table live while it is the tab on screen (#77).
  if (!$('view-islands').classList.contains('hidden')) renderIslands();

  // Keep both maps' gold "you are here" live while the map tab is open — from
  // cache, no fetch — so switching islands moves them at once (#119, #131).
  // markGridActive re-derives the highlight from scratch, so it can't strand a
  // stale gold or paint two the way the surgical move did.
  if (lastMapData && !$('view-map').classList.contains('hidden')) {
    drawMinimap(lastMapData);
    TMap.markGridActive($('map-grid'), lastMapData.size, selectedXY());
  }

  nextChipTarget = computeNextChip();
  renderNextChip();

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
    setMeter(`bar-${r}`, isl.resources[r] / isl.capacity);
  }

  // Vitals meters (#116). Pop counts citizens home + abroad against the home
  // cap, matching the Islands table; loyalty fills toward a secure hold.
  const popNow = isl.popUsed + (isl.popAbroad || 0);
  $('pop-val').textContent = `${popNow}/${isl.popCap}`;
  $('pop-chip').title = T('ui.pop')
    + (isl.popAbroad ? ` — ${T('ui.popAbroad', { n: isl.popAbroad })}` : '');
  setMeter('bar-pop', popNow / isl.popCap);
  $('loyal-val').textContent = `${isl.loyalty}/${isl.loyaltyMax}`;
  $('loyal-chip').title = T('ui.loyalty');
  setMeter('bar-loyal', isl.loyalty / isl.loyaltyMax, 'low');

  // Queue
  const qbody = $('queue').querySelector('tbody');
  qbody.innerHTML = '';
  if (!isl.queue.length) {
    qbody.innerHTML = `<tr><td colspan="3"><i>${T('ui.queue.empty')}</i></td></tr>`;
  }
  for (const item of isl.queue) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${item.building}</td><td>${T('ui.queue.level', { n: item.level })}</td>
      ${countdownCell(item.start, item.finish)}`;
    qbody.appendChild(tr);
  }

  // Buildings
  const bbody = $('buildings').querySelector('tbody');
  bbody.innerHTML = '';
  for (const [key, b] of Object.entries(state.buildings)) {
    const tr = document.createElement('tr');
    const queueFull = isl.queue.length >= isl.queueMax;
    tr.innerHTML = `
      <td><b>${b.name}</b>${b.atMax || b.needs || b.affordable ? '' : affordBadge(b.cost)}<br><small>${b.desc}</small></td>
      <td>${b.level}</td>
      <td class="cost">${b.atMax ? '—' : `🪵 ${b.cost.wood} 🪨 ${b.cost.stone} 🪙 ${b.cost.gold}`}</td>
      <td>${b.atMax ? '—' : fmtTime(b.time)}</td>
      <td>${b.atMax
        ? `<span class="hint">${T('ui.maxLevel', { max: b.maxLevel })}</span>`
        : b.needs
          ? `<span class="hint">${T('ui.needsLevel', { building: b.needs.building, n: b.needs.level })}</span>`
          : `<button data-build="${key}" ${b.affordable && !queueFull ? '' : 'disabled'}>→ ${b.nextLevel}</button>`
      }</td>`;
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

// #18: when the island can afford a cost, given stocks and rates. Seconds
// until affordable, or null when it already is — or never will be at current
// rates (a deficit with no production, or a cost over the storehouse cap):
// 'never' is not a countdown worth printing.
function affordEtaSeconds(cost) {
  const isl = state.island;
  let secs = 0;
  for (const r of ['wood', 'stone', 'gold']) {
    const need = cost[r] || 0;
    const deficit = need - isl.resources[r];
    if (deficit <= 0) continue;
    if (need > isl.capacity) return null;
    const rate = isl.rates && isl.rates[r];
    if (!rate) return null;
    secs = Math.max(secs, (deficit / rate) * 3600);
  }
  return secs > 0 ? secs : null;
}

// The green badge beside a name: '⏳ 2h 14m' until affordable. Minute-granular
// — the table re-renders on every state poll, so no timer of its own.
function affordBadge(cost) {
  const secs = affordEtaSeconds(cost);
  if (secs == null) return '';
  const mins = Math.ceil(secs / 60);
  const label = mins >= 60 ? `${Math.floor(mins / 60)}h` + (mins % 60 ? ` ${mins % 60}m` : '')
    : mins >= 1 ? `${mins}m` : '<1m';
  return ` <small class="afford-eta">⏳ ${label}</small>`;
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
    // One key per movement type — including 'trade', which the old ternary
    // chain had no branch for, so every shipment rendered as "Returning to".
    // Troops aboard first, then loot (#160): this box never showed units at
    // all, so a return full of soldiers read as an empty errand.
    // Floor for display. Pool swaps and withdrawals are the first source of
    // fractional loot in the game — combat floors it, sendTrade floors it, and
    // offers are integers — so this printed 107.20775939008854 at a player.
    // The stored value stays fractional: the pool debited exactly `out`, and
    // rounding here changes only what is shown, not what arrives.
    const troopsAboard = moveUnitsStr(out.units);
    const lootAboard = moveLootStr(out.loot);
    const what = T('ui.move.' + out.type, { target: out.target })
      + (troopsAboard ? ` — ${troopsAboard}` : '')
      + (lootAboard ? ` ${T('ui.move.withLoot')} ${lootAboard}` : '');
    div.innerHTML = `${what} — <span class="countdown" data-finish="${out.arrive}"></span>`;
    box.appendChild(div);
  }
}

function renderTroops() {
  const isl = state.island;
  const ubody = $('units').querySelector('tbody');
  // The 5s poll re-renders this table, which wiped any count you were typing
  // back to the default. Snapshot the fields (and the focused one's cursor)
  // before the rebuild and restore them after, so a running poll never
  // clobbers input mid-type.
  const typed = {};
  for (const box of ubody.querySelectorAll('input[id^="train-n-"]')) {
    typed[box.id] = box.value;
  }
  const active = document.activeElement;
  const keepId = active && active.id && active.id.startsWith('train-n-') ? active.id : null;
  const keepSel = keepId ? [active.selectionStart, active.selectionEnd] : null;
  ubody.innerHTML = '';
  for (const [key, u] of Object.entries(state.unitTypes)) {
    const tr = document.createElement('tr');
    const trainCell = u.available
      ? `<input type="number" min="1" max="500" value="${u.ship || u.capture ? 1 : 5}" id="train-n-${key}">
         <button data-train="${key}">${T('ui.train.button', { t: fmtTime(u.time) })}</button>`
      : `<small class="hint">${T('ui.needs', { building: u.requires })}</small>`;
    tr.innerHTML = `
      <td><b>${u.name}</b>${u.available ? affordBadge(u.cost) : ''}<br><small>${u.desc}</small></td>
      <td>${u.count}</td><td>${u.atk}</td><td>${u.def}</td><td>${u.carry}</td>
      <td class="cost" id="cost-${key}">🪵${u.cost.wood} 🪨${u.cost.stone} 🪙${u.cost.gold}</td>
      <td class="train-cell">${trainCell}</td>`;
    ubody.appendChild(tr);
  }
  for (const btn of ubody.querySelectorAll('button[data-train]')) {
    btn.addEventListener('click', () => train(btn.dataset.train));
  }
  // The catalog price is for ONE unit, but the Colony Ship steps per ship along
  // the expansion curve, so cost x count under-quotes badly (#62). Ask the
  // server for the real batch total whenever the count changes — that keeps the
  // stepped formula in exactly one place.
  for (const box of ubody.querySelectorAll('input[id^="train-n-"]')) {
    const key = box.id.slice('train-n-'.length);
    box.addEventListener('input', () => quoteTrain(key, box.value));
    if (typed[box.id] !== undefined) box.value = typed[box.id]; // survive the poll
  }
  if (keepId) {
    const el = document.getElementById(keepId);
    if (el) {
      el.focus();
      // number inputs throw on setSelectionRange in some engines; ignore.
      try { el.setSelectionRange(keepSel[0], keepSel[1]); } catch { /* fine */ }
    }
  }

  const tbody = $('train-queue').querySelector('tbody');
  tbody.innerHTML = '';
  for (const item of isl.trainQueue) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${T('ui.training', { n: item.count, unit: item.unit })}</td>
      ${countdownCell(item.start, item.finish)}`;
    tbody.appendChild(tr);
  }

  renderSupport();
}

// Batch price for whatever is in the count box. Debounced because it fires on
// every keystroke, and sequence-guarded so a slow reply cannot overwrite a
// newer one with a stale figure.
const trainQuoteTimers = {};
const trainQuoteSeq = {};
function quoteTrain(key, raw) {
  clearTimeout(trainQuoteTimers[key]);
  trainQuoteTimers[key] = setTimeout(async () => {
    const cell = $(`cost-${key}`);
    if (!cell) return;
    const n = Math.floor(Number(raw));
    if (!(n >= 1 && n <= 500)) return; // out of range: leave the last good figure
    const seq = (trainQuoteSeq[key] = (trainQuoteSeq[key] || 0) + 1);
    try {
      const r = await api(`/api/train/quote?islandId=${state.island.id}`
        + `&unit=${encodeURIComponent(key)}&count=${n}`);
      if (seq !== trainQuoteSeq[key] || !r || r.error || !r.cost) return;
      cell.textContent = `\u{1FAB5}${r.cost.wood} \u{1FAA8}${r.cost.stone} \u{1FA99}${r.cost.gold}`;
    } catch { /* transient — the figure on screen stays as it was */ }
  }, 200);
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
// Set a meter fill to a 0..1 fraction and colour it. Default mode: high is the
// alert (storage/pop near cap wastes production / blocks training). mode 'low':
// low is the danger (a weak loyalty hold). Missing element = skinless, no-op.
function setMeter(id, frac, mode) {
  const el = $(id);
  if (!el) return;
  frac = Math.max(0, Math.min(1, frac || 0));
  el.style.width = (frac * 100).toFixed(1) + '%';
  el.classList.remove('warn', 'full');
  if (mode === 'low') {
    if (frac < 0.25) el.classList.add('full');
    else if (frac < 0.5) el.classList.add('warn');
  } else if (frac >= 1) {
    el.classList.add('full');
  } else if (frac >= 0.9) {
    el.classList.add('warn');
  }
}

// A countdown table cell (#118). With a known start it wears a progress bar
// that fills as the job runs; without one — a legacy item queued before the
// field shipped — it degrades to the plain text cell. The initial fill is
// stamped inline so a fresh render doesn't sweep up from zero; paintCountdowns
// then nudges both bar and text each second.
function countdownCell(start, finish) {
  if (!start) return `<td class="countdown" data-finish="${finish}"></td>`;
  const now = Date.now() + clockSkew;
  const frac = finish > start
    ? Math.max(0, Math.min(1, (now - start) / (finish - start))) : 1;
  return `<td class="countdown" data-start="${start}" data-finish="${finish}">`
    + `<span class="cd-bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></span>`
    + '<span class="cd-txt"></span></td>';
}

function paintCountdowns(now) {
  let finished = false;
  for (const el of document.querySelectorAll('.countdown')) {
    const finish = Number(el.dataset.finish);
    const left = (finish - now) / 1000;
    const start = Number(el.dataset.start);
    if (start) {
      const total = finish - start;
      const frac = total > 0 ? Math.max(0, Math.min(1, (now - start) / total)) : 1;
      const fill = el.querySelector('.cd-bar > i');
      const txt = el.querySelector('.cd-txt');
      if (fill) fill.style.width = (frac * 100).toFixed(1) + '%';
      if (txt) txt.textContent = fmtTime(left);
    } else {
      el.textContent = fmtTime(left);
    }
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
    setMeter(`bar-${r}`, val / isl.capacity);
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

$('next-chip').addEventListener('click', () => {
  if (nextChipTarget && nextChipTarget.islandId != null) {
    selectIsland(nextChipTarget.islandId);
    showTab('island');
  }
});

$('island-select').addEventListener('change', () => {
  activeIslandId = Number($('island-select').value);
  refresh();
});

// THE way to switch islands programmatically: drive the select and fire its
// change event, so every listener — this file's handler, the dock's highlight
// (which was lagging until its next poll when the select was bypassed) —
// sees the switch at once. Table rows and hotkeys both come through here.
function selectIsland(id) {
  const sel = $('island-select');
  sel.value = String(id);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

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

let refreshSeq = 0;
async function refresh() {
  // Sequence-guard the poll (#131). The 5s poll and an island switch both call
  // refresh(); without this, a poll already in flight for your OLD island can
  // return AFTER the switch's fetch and clobber state back to it — the "switch
  // goes gold, then ticks back to the wrong island" bug. Only the newest
  // refresh's response is applied; older ones are dropped.
  if (document.hidden) return; // hidden tab: no polling (#158), independent of event delivery
  const seq = ++refreshSeq;
  try {
    const next = await api('/api/state' + (activeIslandId ? `?island=${activeIslandId}` : ''));
    if (seq !== refreshSeq) return; // a newer poll/switch superseded this one
    state = next;
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
  const cur = selectedXY();
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
        const isActive = cur && isl.x === cur.x && isl.y === cur.y;
        if (isActive) { myCell = cell; cell.classList.add('active'); } // gold: the island you're on (#119)
        // Every island cell is clickable — including your own (opens its trade
        // panel) — so the gold is purely a marker and can move by class alone,
        // with no click to rebind when you switch islands (#131).
        cell.addEventListener('click', () => openAttackPanel(isl));
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

// The island you're currently on, read from the <select> you drive — the dock,
// the arrows, and the islands table all set it, and every surface agrees on it.
// state.island is the FETCHED active, which a poll race can roll back to your
// default island; the gold must follow your SELECTION, not that (#131). Returns
// {x,y}, falling back to state.island before the select is populated.
function selectedXY() {
  const id = Number($('island-select').value);
  const isl = state && state.islands && state.islands.find((i) => i.id === id);
  return isl || (state && state.island) || null;
}

function drawMinimap(data) {
  const canvas = $('minimap');
  const ctx = canvas.getContext('2d');
  TMap.hiDpiCanvas(canvas, 160);
  ctx.fillStyle = '#0e2a3f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buildRaster(data), 0, 0, canvas.width, canvas.height);
  TMap.paintDots(ctx, data, selectedXY());
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * data.size);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * data.size);
    const cell = $('map-grid').querySelectorAll('.cell')[y * data.size + x];
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
    // Slots are null on worlds without the rule, so this reads exactly as it
    // did before on a season that predates it.
    const slots = state.island.tradeSlots;
    $('trade-cap').textContent = T('ui.trade.cap', { cap: state.island.tradeCap })
      + (slots ? ` · ${T('ui.merchants')} ${slots.free}/${slots.total}` : '');
    $('trade-send').disabled = state.island.tradeCap < 1 || (slots ? slots.free < 1 : false);

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

// The ▲ next to each resource fills a single-resource shipment: that leg to
// the maximum the harbor and the stores allow, the other two to zero. The
// native number-spinners were never the tool for moving 500 wood — and
// nearly every convoy of the live season was single-resource anyway.
for (const btn of document.querySelectorAll('#trade-form .res-max')) {
  btn.addEventListener('click', () => {
    if (!state) return;
    const res = btn.dataset.res;
    for (const r of ['wood', 'stone', 'gold']) {
      $('trade-' + r).value = r === res
        ? Math.max(0, Math.min(Math.floor(state.island.resources[r]), state.island.tradeCap))
        : 0;
    }
  });
}

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
  rankingRows = data.rankings; // the Mail profile reads these, no second fetch
  data.rankings.forEach((row, idx) => {
    const tr = document.createElement('tr');
    if (row.isYou) tr.className = 'me';
    // ⚿ marks a raised did:nostr banner (#86) — the quest's real reward.
    tr.innerHTML = `<td>${idx + 1}</td>
      <td>${row.name}${row.nostrDid ? ' <span class="banner-glyph" title="did:nostr">⚿</span>' : ''}${row.isBot ? ` <small class="hint">${T('ui.map.bot')}</small>` : ''}</td>
      <td>${row.alliance ? '[' + row.alliance + ']' : '—'}</td>
      <td>${row.islands}</td><td>${row.points}</td>`;
    // Pod players carry a host-verified WebID; bots and password-mode players
    // don't, so this also reads as "who is a real signed-in human".
    if (row.webId) {
      const cell = tr.cells[1];
      cell.appendChild(document.createElement('br'));
      cell.appendChild(identityLine(row.webId));
    }
    // Click a human to open their profile in the Mail tab (bots have none).
    if (!row.isBot) {
      tr.classList.add('clickable');
      tr.addEventListener('click', () => showProfile(row.name));
    }
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

// The pool (#46 step 4). Read-only: reserves, prices and your own position.
// No swap UI yet — there is no endpoint to swap against.
//
// Prices come from the server rather than being derived here. The client
// deliberately carries no copy of the curve maths, so it cannot drift from
// what the server would actually charge.
async function loadPool() {
  const box = $('pool-box');
  let data;
  try {
    data = await api('/api/pool');
  } catch (err) {
    // 404 only: an older server has no pool endpoint. The client is deployed
    // by git pull and the server by restart, so a newer client routinely runs
    // against an older process — that case should go quiet.
    if (err.status === 404) {
      box.classList.add('hidden');
      return;
    }
    // Anything else is a real failure. Hiding it would mask exactly the
    // regressions worth knowing about.
    box.classList.remove('hidden');
    $('pool-shut').classList.add('hidden');
    $('pool-live').classList.add('hidden');
    $('market-error').textContent = err.message;
    return;
  }
  box.classList.remove('hidden');
  $('pool-shut').classList.toggle('hidden', !!data.open);
  $('pool-live').classList.toggle('hidden', !data.open);
  if (!data.open) return;

  const tb = $('pool-reserves').tBodies[0];
  tb.innerHTML = '';
  for (const r of ['wood', 'stone', 'gold']) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = `${RES_EMOJI[r]} ${T('res.' + r)}`;
    tr.insertCell().textContent = fmtNum(Math.floor(data.reserves[r]));
    // A reserve on its floor is the pool reporting that the economy is
    // lopsided, so it is worth saying out loud rather than just going quiet.
    const floored = data.floor && data.reserves[r] <= data.floor[r] + 1e-9;
    tr.insertCell().textContent = floored ? T('ui.pool.floored') : '';
  }

  $('pool-prices').textContent = [['wood', 'gold'], ['stone', 'gold'], ['wood', 'stone']]
    .map(([a, b]) => {
      const p = data.prices.find((x) => x.from === a && x.to === b);
      return T('ui.pool.rate', {
        one: `${RES_EMOJI[b]} 1`,
        many: `${RES_EMOJI[a]} ${p ? p.price.toFixed(2) : '?'}`,
      });
    }).join(' · ');

  $('pool-mine').textContent = data.mine.shares > 0
    ? T('ui.pool.mine', {
      pct: (data.mine.share * 100).toFixed(1),
      value: ['wood', 'stone', 'gold']
        .map((r) => `${RES_EMOJI[r]}${fmtNum(Math.floor(data.mine.value[r]))}`).join(' '),
    })
    : T('ui.pool.noStake');

  fillPoolSelects();
  quotePool();
  previewLiquidity();
}

// ---- liquidity. The preview comes from the same server function the POST
// handler calls, so it cannot describe a different deposit from the one that
// executes — the failure that hit the quote and the swap in 7a.
async function previewLiquidity() {
  const el = $('lp-preview');
  if (!el) return;
  const wood = Math.floor(Number($('lp-wood').value));
  if (!(wood > 0)) { el.textContent = ''; return; }
  try {
    const d = await api(`/api/pool?islandId=${activeIslandId}&deposit=${wood}`);
    const p = d.depositPlan;
    // Pass errorParams through, or messages like "your Harbor can carry {cap}"
    // reach the player with the placeholder still in them.
    if (!p || p.error) { el.textContent = p ? T(p.error, p.errorParams || {}) : ''; return; }
    el.textContent = T('ui.pool.depositPlan', {
      cost: ['wood', 'stone', 'gold']
        .map((r) => `${RES_EMOJI[r]}${fmtNum(Math.ceil(p.required[r]))}`).join(' '),
      pct: (p.share * 100).toFixed(2),
    });
  } catch (err) {
    el.textContent = err.message;
  }
}

if ($('lp-wood')) {
  $('lp-wood').addEventListener('input', () => {
    const sent = $('pool-sent');
    if (sent) sent.textContent = '';
    previewLiquidity();
  });
}

if ($('lp-deposit')) {
  $('lp-deposit').addEventListener('click', async () => {
    // Errors go to #lp-preview, which sits directly under this form.
    // #market-error lives beneath "Post an offer", so a failed deposit was
    // reported in the offer section — and duplicated, because the preview
    // line showed the same message already.
    $('lp-preview').textContent = '';
    $('pool-sent').textContent = '';
    try {
      const d = await api('/api/pool/deposit', {
        islandId: activeIslandId,
        wood: Math.floor(Number($('lp-wood').value)),
      });
      $('pool-sent').textContent = T('ui.pool.deposited', {
        pct: ((d.share || 0) * 100).toFixed(2),
        cost: ['wood', 'stone', 'gold']
          .map((r) => `${RES_EMOJI[r]}${fmtNum(Math.ceil(d.required[r]))}`).join(' '),
      });
      loadMarket();
      refresh();
    } catch (err) {
      $('lp-preview').textContent = err.message;
    }
  });
}

if ($('lp-withdraw')) {
  $('lp-withdraw').addEventListener('click', async () => {
    $('lp-preview').textContent = '';
    $('pool-sent').textContent = '';
    try {
      const d = await api('/api/pool');
      if (!(d.mine.shares > 0)) { $('lp-preview').textContent = T('err.poolNoShares'); return; }
      const r = await api('/api/pool/withdraw',
        { islandId: activeIslandId, shares: d.mine.shares });
      // #pool-sent, not #lp-preview. The preview line is rewritten by the
      // refresh that follows, which is how the swap confirmation vanished
      // three times before this. One confirmation line for every pool action.
      $('pool-sent').textContent = T('ui.pool.withdrawn', {
        out: ['wood', 'stone', 'gold']
          .map((x) => `${RES_EMOJI[x]}${fmtNum(Math.floor(r.out[x]))}`).join(' '),
      });
      loadMarket();
      refresh();
    } catch (err) {
      $('lp-preview').textContent = err.message;
    }
  });
}

// The Vault (#132): move gold to/from a personal, raid-proof balance. Both
// endpoints return the full state, so swap it in and re-render.
async function vaultMove(path) {
  $('vault-msg').textContent = '';
  const amount = Math.floor(Number($('vault-amount').value));
  if (!(amount > 0)) { $('vault-msg').textContent = T('err.badRequest'); return; }
  try {
    state = await api(path, { islandId: activeIslandId, amount });
    clockSkew = state.serverNow - Date.now();
    renderState();
  } catch (err) {
    $('vault-msg').textContent = err.message;
  }
}
if ($('vault-deposit')) {
  $('vault-deposit').addEventListener('click', () => vaultMove('/api/vault/deposit'));
  $('vault-withdraw').addEventListener('click', () => vaultMove('/api/vault/withdraw'));
}

// The Tidegate (#135): the sealed, cross-app balance. Driven through the
// `tidegate` library — imported straight from its gh-pages URL — with a
// Tideholm backend injected: pegIn/pegOut go through the server, which caps
// peg-out at what was pegged in (so no gold is minted). The library is the
// client's interface; in phase 2b its backend swaps to BlockTrails/nostr and
// the signer to noskey, with no change to this call site. Loaded lazily, so a
// failed fetch never breaks the game — only the peg buttons report it.
let _tidegate = null;
async function getTidegate() {
  if (_tidegate) return _tidegate;
  const base = 'https://melvincarvalho.github.io/tidegate/';
  const [core, keys] = await Promise.all([
    import(base + 'tidegate.js'),
    import(base + 'keys.js'),
  ]);
  // Real signer: prompts for a 64-hex nostr key ONCE, keeps it in localStorage,
  // and BIP340-signs every peg (#135). PoC — later a NIP-07/xlogin signer.
  const signer = await keys.keySigner();
  _tidegate = core.createTidegate({
    backend: {
      balance: async () => (state && state.player && state.player.pegged) || 0,
      append: async (did, t) => {
        const path = t.delta > 0 ? '/api/vault/pegin' : '/api/vault/pegout';
        // Carry the signed transition so the server persists the SEAL (#135) —
        // the durable, portable trail, one signed doc per did:nostr. The peg
        // itself stays server-capped (no minting); the trail is the mirror.
        state = await api(path, {
          islandId: activeIslandId,
          amount: Math.abs(t.delta),
          transition: { did, prev: t.prev, delta: t.delta, next: t.next, sig: t.sig, pubkey: signer.pubkey },
        });
        clockSkew = state.serverNow - Date.now();
        renderState();
        return (state.player && state.player.pegged) || 0;
      },
      subscribe: () => () => {},
    },
    signer,
  });
  return _tidegate;
}
async function pegMove(dir) {
  $('tidegate-msg').textContent = '';
  const amount = Math.floor(Number($('tidegate-amount').value));
  if (!(amount > 0)) { $('tidegate-msg').textContent = T('err.badRequest'); return; }
  try {
    const tg = await getTidegate();
    const did = state.player.did || ('tideholm:' + state.player.name);
    if (dir === 'in') await tg.pegIn(did, amount);
    else await tg.pegOut(did, amount);
  } catch (err) {
    $('tidegate-msg').textContent = err.message || String(err);
  }
}
if ($('tidegate-pegin')) {
  $('tidegate-pegin').addEventListener('click', () => pegMove('in'));
  $('tidegate-pegout').addEventListener('click', () => pegMove('out'));
}

// The testnet4 "fuel" behind the seal (#135). The taproot address this identity
// controls IS a Bitcoin address (same secp256k1 key), and its testnet4 balance
// is what a BlockTrails committer will eventually spend to anchor the trail.
// Read-only, and deliberately NOT in the poll loop: fetched only when the market
// opens and on an explicit refresh, cached with a cooldown so repeats coalesce
// and a single in-flight request is never duplicated. mempool.space serves
// testnet4 with permissive CORS, so the browser reads it directly. Address
// derivation is public-key only — no signer, so this never prompts for a key.
const FUEL_TTL = 60000; // never re-hit mempool more than once a minute
let _fuel = { did: null, addr: null, data: null, at: 0, pending: false };
let _btcMod = null;

function fuelDid() {
  const did = state && state.player && state.player.did;
  return (did && /^did:nostr:[0-9a-f]{64}$/i.test(did)) ? did : null;
}

async function refreshFuel(force) {
  const el = $('tidegate-fuel');
  if (!el) return;
  const did = fuelDid();
  // Only did:nostr players have an address; reset + clear so no stale line lingers.
  if (!did) { _fuel = { did: null, addr: null, data: null, at: 0, pending: false }; renderFuel(); return; }
  if (_fuel.did !== did) _fuel = { did, addr: null, data: null, at: 0, pending: false };
  if (_fuel.pending) return;                           // one flight at a time
  if (!force && _fuel.data && Date.now() - _fuel.at < FUEL_TTL) { renderFuel(); return; }
  _fuel.pending = true;
  renderFuel();                                        // show the checking/last state immediately
  try {
    if (!_fuel.addr) {
      const btc = _btcMod || (_btcMod = await import('https://melvincarvalho.github.io/tidegate/btc.js'));
      _fuel.addr = btc.taprootAddress(did, 'testnet');
    }
    const r = await fetch(`https://mempool.space/testnet4/api/address/${_fuel.addr}`);
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    const c = j.chain_stats || {};
    const m = j.mempool_stats || {};
    _fuel.data = {
      sat: (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0),
      // unconfirmed delta (e.g. an anchor's change on its way back) — shown so
      // the confirmed number changing later doesn't look like a glitch
      pending: (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0),
    };
    _fuel.at = Date.now();
  } catch (_) {
    _fuel.data = { error: true };
    _fuel.at = Date.now();   // rate-limit failures too — don't re-hit a down endpoint on every open
  } finally {
    _fuel.pending = false;
    renderFuel();
  }
}

// The anchor (#140): commit the sealed trail to testnet4, signed IN THE BROWSER
// with the same localStorage nostr key that seals pegs — non-custodial, the
// server only records the txid. Two clicks by design: the first computes a
// keyless preview (what will be spent, where, the fee) into the message line;
// the second signs, broadcasts, and reports the commitment for stamping.
let _anchorArmed = false;
async function anchorFlow() {
  const btn = $('tidegate-anchor');
  const msg = $('tidegate-msg');
  if (btn.disabled) return; // one flight at a time — a double-click must not double-broadcast
  btn.disabled = true;
  msg.textContent = '';
  try {
    const mod = await import('https://melvincarvalho.github.io/tidegate/anchor.js');
    const did = state.player.did;
    const { trail } = await api('/api/tidegate/trail');
    if (!_anchorArmed) {
      const p = await mod.previewAnchor(did, trail);
      const o = p.outputs[0];
      msg.textContent = T('ui.tidegate.anchorPreview', { sats: fmtNum(o.value), addr: o.address.slice(0, 12) + '…', fee: p.fee })
        + (p.regenesis ? ' · ' + T('ui.tidegate.regenesis') : '');
      btn.textContent = T('ui.tidegate.anchorConfirm');
      _anchorArmed = true;
      return;
    }
    const c = await mod.anchor(did, trail);          // sign + broadcast, in-browser
    _anchorArmed = false;
    btn.textContent = T('ui.tidegate.anchor');
    await api('/api/tidegate/anchor', { commitment: { seq: c.seq, txid: c.txid, address: c.address, network: c.network, amount: c.value, chain: c.chain } });
    msg.textContent = T('ui.tidegate.anchored', { seq: c.seq }) + ' ';
    const a = document.createElement('a');
    a.href = c.explorer; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = c.txid.slice(0, 12) + '…';
    msg.appendChild(a);
    refreshFuel(true);                                // the float just moved
    refreshAnchored();                                // the stamp just landed
  } catch (err) {
    _anchorArmed = false;
    if (btn) btn.textContent = T('ui.tidegate.anchor');
    msg.textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
}
if ($('tidegate-anchor')) $('tidegate-anchor').addEventListener('click', anchorFlow);

// Persistent anchored status (#140): rendered from the trail's OWN stamp, so it
// survives refreshes — the transient message line was lost on reload. Fetched
// only on market-open / after an anchor (our server, cheap). Confirmation is
// checked against mempool at most once a minute and is STICKY: once confirmed,
// never asked again.
let _anchored = { txid: null, confirmed: false, retired: false, checkedAt: 0 };
async function refreshAnchored() {
  const el = $('tidegate-anchored');
  if (!el) return;
  if (!fuelDid()) { el.classList.add('hidden'); el.textContent = ''; return; }
  try {
    const { trail } = await api('/api/tidegate/trail');
    // The LAST anchored entry, not the tip: a peg after an anchor moves the tip
    // past the stamp, but the anchor still happened — keep showing it, plus how
    // far the trail has drifted since (which is also the nudge to anchor again).
    let c = null;
    for (let i = (trail || []).length - 1; i >= 0; i--) {
      if (trail[i] && trail[i].commitment) { c = trail[i].commitment; break; }
    }
    if (!c) { el.classList.add('hidden'); el.textContent = ''; return; }
    if (_anchored.txid !== c.txid) _anchored = { txid: c.txid, confirmed: false, retired: false, checkedAt: 0 };
    if ((!_anchored.confirmed || !_anchored.retired) && Date.now() - _anchored.checkedAt > 60000) {
      _anchored.checkedAt = Date.now();
      try {
        const s = await (await fetch(`https://mempool.space/testnet4/api/tx/${c.txid}/status`)).json();
        _anchored.confirmed = !!s.confirmed;
      } catch (_) { /* stays pending; re-checked on the next open */ }
      // Retirement detection (re-genesis): the tip output spent with no newer
      // stamp means the chain was swept closed — the next anchor starts fresh.
      // Read from the chain itself; the sweep never phones home.
      try {
        const os = await (await fetch(`https://mempool.space/testnet4/api/tx/${c.txid}/outspend/${c.vout || 0}`)).json();
        _anchored.retired = !!(os && os.spent);
      } catch (_) { /* unknown — say nothing rather than guess */ }
    }
    el.textContent = '';
    el.classList.remove('hidden');
    // chain appears once a re-genesis has happened (chain ≥ 2) — before that,
    // "chain 1" would be noise; seq alone tells the whole story (#TRAIL §7.4:
    // seq counts the trail, chain names the spine carrying it)
    const chainNo = Math.trunc(Number(c.chain)) || 1;
    el.appendChild(document.createTextNode((chainNo > 1
      ? T('ui.tidegate.anchoredChainSeq', { chain: chainNo, seq: c.seq })
      : T('ui.tidegate.anchoredSeq', { seq: c.seq })) + ' '));
    const a = document.createElement('a');
    a.href = c.explorer || `https://mempool.space/testnet4/tx/${c.txid}`;
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = c.txid.slice(0, 10) + '…';
    el.appendChild(a);
    el.appendChild(document.createTextNode(' (' + T(_anchored.confirmed ? 'ui.tidegate.confirmed' : 'ui.tidegate.pending') + ')'));
    if (_anchored.retired) el.appendChild(document.createTextNode(' · ' + T('ui.tidegate.retired')));
    const drift = trail.length - c.seq;
    if (drift > 0) el.appendChild(document.createTextNode(' · ' + T('ui.tidegate.sinceAnchor', { n: drift })));
    // Independent verification (#135): the whole trail's marks, checked against
    // Bitcoin by blocktrails.org's own page — a site this game does not run.
    el.appendChild(document.createTextNode(' · '));
    const v = document.createElement('a');
    const pub = fuelDid().slice('did:nostr:'.length);
    v.href = 'https://blocktrails.org/verify/?uri=' + encodeURIComponent(
      location.origin + location.pathname.replace(/\/[^/]*$/, '/') + 'api/tidegate/blocktrails/' + pub + '/blocktrails.json');
    v.target = '_blank'; v.rel = 'noopener noreferrer';
    v.textContent = T('ui.tidegate.verify');
    el.appendChild(v);
  } catch (_) { /* leave whatever is shown */ }
}

// ---- the fleet door + the courier slip (#146) -----------------------------
// The games are SEPARATE apps behind one lobby (tide-games.github.io) that
// passes the query string through, unparsed, to whichever game the player
// picks. Tideholm's whole integration surface is this link out and the slip
// coming back. Out: ?did=&seal=&return= — the prefill seam every seal-ready
// game understands. Home: the player carries ?tavern=<b64 signed transitions>;
// Redeem posts them to /api/tidegate/sync, where every signature is verified
// before the seal moves.

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}
let _slip = null; // parsed once from the arrival URL
{
  const raw = new URLSearchParams(location.search).get('tavern');
  if (raw) {
    try {
      const txs = JSON.parse(b64urlDecode(raw));
      if (Array.isArray(txs) && txs.length) _slip = txs;
    } catch (_) { /* not a slip */ }
  }
}

function renderTavernLine() {
  const el = $('tidegate-tavern');
  if (!el) return;
  const did = fuelDid();
  el.classList.toggle('hidden', !did);
  if (!did) return;
  el.textContent = '';
  const a = document.createElement('a');
  const fleetHref = () => 'https://tide-games.github.io/?did=' + encodeURIComponent(did)
    + '&seal=' + Math.floor((state.player && state.player.pegged) || 0)
    + '&return=' + encodeURIComponent(location.origin + location.pathname);
  a.href = fleetHref();
  // The seal is read at CLICK time, not render time: a player who pegs in
  // and sails fast otherwise carries a stale seal=0 into the fleet and finds
  // every purse empty (learned live, twice, on den night).
  a.addEventListener('click', () => { a.href = fleetHref(); });
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = T('ui.tidegate.tavern');
  el.appendChild(a);
}

function renderSlip() {
  const el = $('tidegate-slip');
  if (!el) return;
  if (!_slip || !fuelDid()) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = '';
  const net = _slip.reduce((a, t) => a + (Number(t.delta) || 0), 0);
  el.appendChild(document.createTextNode(
    T('ui.tidegate.slip', { n: _slip.length, net: (net >= 0 ? '+' : '') + fmtNum(net) }) + ' '));
  const b = document.createElement('button');
  b.textContent = T('ui.tidegate.redeem');
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      state = await api('/api/tidegate/sync', { islandId: activeIslandId, transitions: _slip });
      clockSkew = state.serverNow - Date.now();
      _slip = null;
      history.replaceState(null, '', location.pathname); // the slip is spent
      renderState();
      renderSlip();
      renderTavernLine();
      $('tidegate-msg').textContent = T('ui.tidegate.redeemed');
    } catch (err) {
      b.disabled = false;
      $('tidegate-msg').textContent = err.message || String(err);
    }
  });
  el.appendChild(b);
}

// Render-only: paints whatever is in the cache. Safe to call any time; never fetches.
function renderFuel() {
  const el = $('tidegate-fuel');
  if (!el) return;
  const ab = $('tidegate-anchor');
  if (ab) ab.classList.toggle('hidden', !fuelDid()); // anchor needs an identity, like the gauge
  if (!fuelDid()) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = '';
  const label = document.createElement('span');
  if (!_fuel.data) label.textContent = '⛽ ' + T('ui.tidegate.fuelChecking');
  else if (_fuel.data.error) label.textContent = '⛽ ' + T('ui.tidegate.fuelOffline');
  else {
    label.textContent = '⛽ ' + T('ui.tidegate.fuel', { sat: fmtNum(_fuel.data.sat) });
    if (_fuel.data.pending) {
      label.textContent += ' · ' + T('ui.tidegate.fuelPending',
        { sat: (_fuel.data.pending > 0 ? '+' : '') + fmtNum(_fuel.data.pending) });
    }
  }
  el.appendChild(label);
  if (_fuel.addr) {
    el.appendChild(document.createTextNode(' · '));
    const a = document.createElement('a');
    a.href = `https://mempool.space/testnet4/address/${_fuel.addr}`;
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = _fuel.addr.slice(0, 10) + '…' + _fuel.addr.slice(-4);
    el.appendChild(a);
  }
  el.appendChild(document.createTextNode(' · '));
  const rf = document.createElement('a');
  rf.href = '#';
  rf.textContent = T('ui.tidegate.fuelRefresh');
  rf.addEventListener('click', (ev) => { ev.preventDefault(); refreshFuel(true); });
  el.appendChild(rf);
}

// Slippage tolerance. A quote is fetched, then the player acts; the pool can
// move in between. minOut is what stops them being committed to whatever price
// it has drifted to by the time the request lands.
const POOL_SLIPPAGE = 0.01;
let lastQuote = null;

// Held after a swap lands. The reserves have moved, so a re-quote prices a
// DIFFERENT trade from the one just executed — and it renders immediately above
// the confirmation, so the two read as one statement (#73). At shallow depth the
// figures diverge sharply: a 100/100/100 pool moves 30% on one swap, so
// "receive 18" sat directly under "Sent. 30 is sailing home".
//
// Held rather than cleared once, because loadMarket() re-quotes on every
// refresh. Touching an input is the moment the player is asking about a NEW
// trade rather than reading about the old one, so that is what releases it.
let quoteHeld = false;

function fillPoolSelects() {
  for (const [sel, dflt] of [[$('pool-from'), 'wood'], [$('pool-to'), 'gold']]) {
    if (sel.options.length) continue;
    for (const r of ['wood', 'stone', 'gold']) {
      const o = document.createElement('option');
      o.value = r;
      o.textContent = `${RES_EMOJI[r]} ${T('res.' + r)}`;
      sel.appendChild(o);
    }
    sel.value = dflt;
  }
}

// The quote comes from the server, never from arithmetic here, so what the
// player is shown is what they will actually be charged.
async function quotePool() {
  const from = $('pool-from').value, to = $('pool-to').value;
  const amount = Number($('pool-amount').value);
  const out = $('pool-quote');
  lastQuote = null;
  if (quoteHeld) { out.textContent = ''; return; }
  if (from === to) { out.textContent = T('ui.pool.samePair'); return; }
  if (!(amount > 0)) { out.textContent = ''; return; }
  try {
    const d = await api(`/api/pool?from=${from}&to=${to}&amount=${amount}`);
    const q = d.quote;
    if (!q || !(q.out > 0)) { out.textContent = T('ui.pool.noQuote'); return; }
    lastQuote = q;
    out.textContent = T('ui.pool.quote', {
      pay: `${RES_EMOJI[from]}${fmtNum(Math.floor(q.used))}`,
      get: `${RES_EMOJI[to]}${fmtNum(Math.floor(q.out))}`,
      impact: (q.impact * 100).toFixed(1),
    }) + (q.capped ? ' ' + T('ui.pool.capped') : '');
  } catch (err) {
    out.textContent = err.message;
  }
}

// Clearing the confirmation belongs here, on user intent — not inside
// quotePool(), which also runs on every refresh and so wiped the message
// before it could be read. Guessing from document.activeElement was worse: a
// programmatic click does not focus the button.
for (const id of ['pool-from', 'pool-to', 'pool-amount']) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener(id === 'pool-amount' ? 'input' : 'change', () => {
    const sent = $('pool-sent');
    if (sent) sent.textContent = '';
    quoteHeld = false;
    quotePool();
  });
}

const poolSwapBtn = $('pool-swap');
if (poolSwapBtn) {
  poolSwapBtn.addEventListener('click', async () => {
    // Clear BOTH lines first. Clearing the confirmation only on edit meant a
    // second click — one that failed, or bailed for want of a quote — left
    // the previous "Sent" on screen, reading as if the latest attempt had
    // worked. It must only ever describe the most recent attempt.
    $('market-error').textContent = '';
    $('pool-sent').textContent = '';
    if (!lastQuote) {
      $('pool-quote').textContent = T('ui.pool.noQuote');
      return;
    }
    try {
      const r = await api('/api/pool/swap', {
        islandId: activeIslandId,
        from: $('pool-from').value,
        to: $('pool-to').value,
        amount: Number($('pool-amount').value),
        // Floor what we will accept at the quote we showed, less tolerance.
        minOut: lastQuote.out * (1 - POOL_SLIPPAGE),
      });
      // Its own line. Writing this into #pool-quote meant loadMarket() below
      // re-quoted and wiped the confirmation before it could be read.
      $('pool-sent').textContent = T('ui.pool.sent', {
        get: `${RES_EMOJI[$('pool-to').value]}${fmtNum(Math.floor(r.out))}`,
      });
      // Set BEFORE loadMarket(), which re-quotes against the reserves this
      // swap just moved (#73).
      quoteHeld = true;
      loadMarket();
      refresh();
    } catch (err) {
      // No hold: a refused swap moved nothing, so the standing quote still
      // describes the trade the player is looking at.
      $('market-error').textContent = err.message;
    }
  });
}

async function loadMarket() {
  fillResSelects();
  $('market-error').textContent = '';
  loadPool();
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

// Identifiers are shown as identifiers, not links: a pod WebID is issued by
// the IdP and is not necessarily dereferenceable from outside it, so a link
// would often 404. Handles both shapes an identity can take — the host's
// getAgent returns a WebID for mapped keys and a did:nostr for unmapped ones.
function shortId(id) {
  const s = String(id);
  const did = /^did:nostr:([0-9a-f]{6})[0-9a-f]{54}([0-9a-f]{4})$/.exec(s);
  if (did) return `did:nostr:${did[1]}…${did[2]}`;
  try {
    const u = new URL(s);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return u.hostname + (seg ? '/' + seg : '');
  } catch (e) { return s; }
}

// icon: 🪪 host-verified login identity, 🔑 self-declared and unverified.
// A did:nostr resolves to a DID document at the host root, so that one gets a
// link; a pod WebID is issued by the IdP and often isn't dereferenceable from
// outside it, so it stays plain text. Relative to the origin, never a
// hardcoded host — the game is meant to be mountable anywhere.
function identityLine(id, unverified) {
  const el = document.createElement('small');
  el.className = 'hint webid';
  el.title = unverified ? id + ' (' + T('ui.identity.unverified') + ')' : id;
  const hex = /^did:nostr:([0-9a-f]{64})$/.exec(String(id));
  if (hex) {
    el.append('🔑 ');
    const a = document.createElement('a');
    a.href = `/.well-known/did/nostr/${hex[1]}.json`; // .json is required
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = shortId(id);
    el.appendChild(a);
    return el;
  }
  el.textContent = (unverified ? '🔑 ' : '🪪 ') + shortId(id);
  return el;
}

// ---------------------------------------------------------------- profile
// Identity + standing, built entirely from /api/rankings — it already carries
// isYou and webId per row, so no server call of its own and nothing new to
// plumb. Stages 2-4 of #34 (npub, taproot address, order intents) hang here.

let profileName = null; // whose profile the Mail tab shows; null = your own

// External key tool. Takes a bare 64-hex pubkey or an npub via ?pubkey= and
// shows the coin addresses derived from it; with no parameter it generates a
// fresh keypair. Both halves of the identity flow ride on that, which is why
// Tideholm needs no secp256k1 of its own.
const NOSKEY = 'https://melvincarvalho.github.io/noskey/web/';

// Set or clear your own Nostr identifier. Accepts a bare 64-hex pubkey or a
// full did:nostr URI — the server canonicalises. If a NIP-07 extension is
// present, offer to read the pubkey from it instead of typing.
function nostrDidForm(current) {
  const wrap = document.createElement('div');
  wrap.className = 'did-form';
  const input = document.createElement('input');
  input.id = 'nostr-did-input';
  input.maxLength = 74; // did:nostr: + 64 hex
  input.placeholder = T('ui.identity.placeholder');
  input.value = current || '';
  wrap.appendChild(input);

  const save = document.createElement('button');
  save.className = 'small-btn';
  save.textContent = T('ui.identity.save');
  save.addEventListener('click', async () => {
    const err = $('mail-error');
    err.textContent = '';
    try {
      await api('/api/identity/nostr', { did: input.value });
      rankingRows = (await api('/api/rankings')).rankings;
      renderProfile(rankingRows);
    } catch (e) { err.textContent = e.message; }
  });
  wrap.appendChild(save);

  // NIP-07 extensions expose window.nostr; xlogin shims the same shape.
  if (window.nostr && typeof window.nostr.getPublicKey === 'function') {
    const use = document.createElement('button');
    use.className = 'small-btn';
    use.textContent = T('ui.identity.fromExtension');
    use.addEventListener('click', async () => {
      const err = $('mail-error');
      err.textContent = '';
      try {
        input.value = await window.nostr.getPublicKey();
      } catch (e) { err.textContent = String(e && e.message || e); }
    });
    wrap.appendChild(use);
  }

  // One outbound action, depending on whether an identity is set yet.
  // noskey takes a bare 64-hex pubkey or an npub — exactly the form stored in
  // a did:nostr — and with no parameter at all it generates a fresh key.
  // So neither case needs any crypto here.
  const hex = /^did:nostr:([0-9a-f]{64})$/.exec(String(current || ''));
  const link = document.createElement('a');
  link.className = 'small-btn did-link';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (hex) {
    link.href = NOSKEY + '?pubkey=' + hex[1];
    link.textContent = T('ui.identity.addresses');
  } else {
    link.href = NOSKEY;
    link.textContent = T('ui.identity.generate');
    // The generator hands back a secret key too; only the public half belongs
    // here, and a hex secret is indistinguishable from a hex pubkey on sight.
    link.title = T('ui.identity.generateHint');
  }
  wrap.appendChild(link);
  return wrap;
}

function renderProfile(rows) {
  const box = $('profile-box');
  if (!box || !rows) return;
  const me = rows.findIndex((r) => r.isYou);
  const idx = profileName
    ? rows.findIndex((r) => r.name === profileName)
    : me;
  if (idx < 0) { box.innerHTML = ''; profileName = null; return; }
  const row = rows[idx];
  const isMe = idx === me;

  box.innerHTML = '';
  box.className = 'profile';
  const h = document.createElement('h4');
  h.textContent = isMe ? T('ui.profile.title') : T('ui.profile.viewing');
  box.appendChild(h);

  const line = document.createElement('div');
  const nm = document.createElement('b');
  nm.textContent = row.name;
  line.appendChild(nm);
  const meta = document.createElement('span');
  meta.className = 'hint';
  meta.textContent = ` — ${T('ui.profile.rank')} ${idx + 1} · `
    + `🏆 ${row.points} ${T('ui.points')} · 🏝️ ${row.islands}`
    + (row.alliance ? ` · [${row.alliance}]` : '')
    + (isMe ? ` · ${T('ui.profile.you')}` : '');
  line.appendChild(meta);
  box.appendChild(line);

  if (row.webId) {
    box.appendChild(identityLine(row.webId));
  } else {
    const none = document.createElement('small');
    none.className = 'hint';
    none.textContent = T('ui.profile.noIdentity');
    box.appendChild(none);
  }
  if (row.nostrDid) {
    box.appendChild(document.createElement('br'));
    box.appendChild(identityLine(row.nostrDid, true));
  }
  // Only you can set your own; others' are read-only.
  if (isMe) box.appendChild(nostrDidForm(row.nostrDid));

  // Actions: message this player, or step back to your own profile.
  const actions = document.createElement('div');
  actions.className = 'profile-actions';
  if (!isMe) {
    const msg = document.createElement('button');
    msg.className = 'small-btn';
    msg.textContent = T('ui.profile.message');
    msg.addEventListener('click', () => {
      $('mail-to').value = row.name;
      $('mail-body').focus();
    });
    actions.appendChild(msg);
    const back = document.createElement('button');
    back.className = 'small-btn';
    back.textContent = T('ui.profile.back');
    back.addEventListener('click', () => { profileName = null; renderProfile(rows); });
    actions.appendChild(back);
  }
  if (actions.children.length) box.appendChild(actions);
}

// Rankings caches its rows so the Mail tab can render a profile without
// refetching; loadMessages() falls back to fetching if you go there first.
let rankingRows = null;

async function showProfile(name) {
  profileName = name;
  if (!rankingRows) {
    try { rankingRows = (await api('/api/rankings')).rankings; } catch (e) { return; }
  }
  showTab('messages');
  renderProfile(rankingRows);
  loadMessages();
}

async function loadMessages() {
  // Profile needs the rankings rows; fetch once if Mail was opened first.
  if (!rankingRows) {
    try { rankingRows = (await api('/api/rankings')).rankings; } catch (e) { /* profile just stays empty */ }
  }
  renderProfile(rankingRows);
  const data = await api('/api/messages');
  const box = $('mail-list');
  box.innerHTML = data.messages.length ? '' : `<p class="hint">${T('ui.mail.empty')}</p>`;
  for (const msg of data.messages) {
    const div = document.createElement('div');
    div.className = 'report' + (msg.read ? '' : ' unread');
    const when = new Date(msg.time).toLocaleString();
    div.innerHTML = `<b></b> <small></small>
      <button class="mail-reply">${T('ui.mail.reply')}</button><br><span></span>`;
    // Names and WebIDs are player-controlled, so they go in as text, never
    // interpolated into the markup.
    div.querySelector('b').textContent = msg.from;
    div.querySelector('small').textContent = when;
    div.querySelector('button').dataset.reply = msg.from;
    div.querySelector('span').textContent = msg.body;
    if (msg.webId) {
      const body = div.querySelector('span');
      div.insertBefore(identityLine(msg.webId), body);
      div.insertBefore(document.createElement('br'), body);
    }
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

// Hidden tabs stop polling (#158): a forgotten background tab otherwise drains
// the per-player request budget forever (#157). On return, refresh once right
// away — through the #131 sequence guard, so a stale in-flight poll can't
// clobber it — then resume the normal cadence. Local tickers (next-chip,
// countdowns) keep running; they cost no requests.
document.addEventListener('visibilitychange', () => {
  clearInterval(pollTimer);
  if (document.hidden) return;
  if ($('game').classList.contains('hidden')) return; // login screen: nothing to poll
  refresh();
  pollTimer = setInterval(refresh, 5000);
});

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
