// Tideholm — stage rails. Loaded by index.html (the default layout) and by
// the leftover stage.html; classic.html omits it.
// Read-only decoration: fills the left/right rails from its own polls of the
// same API the client uses. Fails silent; never mutates anything.
//
// The stage layout won (it is index.html now), so the fold this file was
// waiting for is still owed: these rails should become a renderRails(state)
// called from renderState() in app.js, reusing that file's api(), fmtTime()
// and MINI_COLORS instead of the copies below. Until then the page runs three
// independent /api/state pollers (app.js, this, islands-dock.js) and the
// rails can show a different snapshot than the column beside them.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const RES = { wood: '🪵', stone: '🪨', gold: '🪙' };
  const MAP_COLORS = {
    you: '#3faf46', ally: '#2ab5a5', war: '#ff5544',
    player: '#3b7dd8', bot: '#e08030', barb: '#8d7b64', unowned: '#a9b0b8',
  };

  function T(key, params) {
    try { return window.I18N.t(document.documentElement.lang || 'en', key, params); }
    catch (e) { return key; }
  }

  async function get(path) {
    const res = await fetch(path, { headers: authHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  function authHeaders() {
    const token = localStorage.getItem('tideholm-token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  // Player total points + rank come from the rankings, not the island.
  let standing = null; // { rank, points }
  // The active island's position and the last map payload, so the "you are
  // here" ring (#119) can follow island switches without waiting for the 30s
  // map poll — the two pollers are independent, so we redraw on state change.
  let activePos = null;
  let lastMap = null;

  function left(finish) {
    const s = Math.max(0, Math.round((finish - Date.now()) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function fillState(s) {
    const isl = s.island;
    activePos = { x: isl.x, y: isl.y };
    if (lastMap) drawMap(lastMap); // reflect an island switch on the map at once
    $('stage-name').textContent = s.player.name;
    $('stage-rank').textContent = standing ? T('ui.stage.rank', { n: standing.rank }) : '';
    // Player TOTAL from rankings; the active island's own points as fallback,
    // marked as such so the number never masquerades as the total.
    $('stage-points').textContent = standing
      ? '🏆 ' + standing.points + ' ' + T('ui.points')
      : '🏝️ ' + isl.points + ' ' + T('ui.points');
    $('stage-islands').textContent = '🏝️ ' + s.islands.length;
    $('stage-loyalty').textContent = '⚜️ ' + isl.loyalty + ' / ' + isl.loyaltyMax;
    $('stage-pop').textContent = '👥 ' + isl.popUsed + ' / ' + isl.popCap;

    $('stage-quest').textContent = s.quest
      ? s.quest.name + ' (' + s.quest.i + '/' + s.quest.n + ')'
      : '—';
    $('stage-quest-panel').style.display = s.quest ? '' : 'none';

    $('stage-info').innerHTML =
      '<b>' + esc(isl.name) + '</b> (' + isl.x + ':' + isl.y + ')<br>' +
      T('ui.points') + ': <b>' + isl.points + '</b><br>' +
      T('ui.loyalty') + ': <b>' + isl.loyalty + ' / ' + isl.loyaltyMax + '</b>';

    $('stage-prod').innerHTML = ['wood', 'stone', 'gold'].map((r) =>
      RES[r] + ' <b>' + Math.round(isl.rates[r]) + '</b>/h').join('<br>') +
      '<br>📦 <b>' + isl.capacity + '</b> ' + T('ui.capacity');

    const items = [];
    for (const q of isl.queue) {
      items.push('🏛️ ' + esc(q.building) + ' → ' + q.level + ' <small>' + left(q.finish) + '</small>');
    }
    for (const tq of isl.trainQueue) {
      items.push('🛡️ ' + tq.count + ' × ' + esc(tq.unit) + ' <small>' + left(tq.finish) + '</small>');
    }
    $('stage-queue').innerHTML = items.length ? items.join('<br>') : T('ui.queue.empty');
  }

  async function tickStanding() {
    try {
      const data = await get('api/rankings');
      const i = data.rankings.findIndex((r) => r.isYou);
      if (i >= 0) standing = { rank: i + 1, points: data.rankings[i].points };
    } catch (e) { /* ignore */ }
  }

  function esc(s) {
    const d = document.createElement('span');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Match the backing store to the pixel ratio so the map isn't upscaled and
  // blurred on HiDPI (#119) — a 1px ring bloomed into a white blob without it.
  function hiDpiCanvas(canvas, logical) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const want = Math.round(logical * dpr);
    if (canvas.width !== want) {
      canvas.width = want;
      canvas.height = want;
      canvas.style.width = logical + 'px';
      canvas.style.height = logical + 'px';
    }
  }

  // "You are here": a bold white ring outside the cell over a dark halo, so the
  // island's colour shows and it reads on light islands too. Matches app.js.
  function drawYouAreHere(ctx, gx, gy, px) {
    const s = Math.max(2, px - 1);
    const out = Math.max(2, px * 0.55);
    const x = gx * px - out;
    const y = gy * px - out;
    const w = s + 2 * out;
    const lw = Math.max(1.5, px * 0.26);
    ctx.lineWidth = lw + 2;
    ctx.strokeStyle = 'rgba(14,42,63,0.85)';
    ctx.strokeRect(x, y, w, w);
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, w);
  }

  function drawMap(m) {
    const canvas = $('stage-map');
    const ctx = canvas.getContext('2d');
    hiDpiCanvas(canvas, 180);
    const px = canvas.width / m.size;
    ctx.fillStyle = '#0e2a3f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const isl of m.islands) {
      const kind = isl.isYou ? 'you'
        : isl.relation === 'war' ? 'war'
        : isl.relation === 'ally' || isl.relation === 'same' ? 'ally'
        : isl.unowned ? 'unowned'
        : isl.barbarian ? 'barb'
        : isl.isBot ? 'bot' : 'player';
      ctx.fillStyle = MAP_COLORS[kind];
      ctx.fillRect(isl.x * px, isl.y * px, Math.max(2, px - 1), Math.max(2, px - 1));
    }
    // "You are here" (#119): a white ring around the island you're on, drawn
    // last so it sits above its neighbours. Matches drawMinimap in app.js.
    if (activePos) drawYouAreHere(ctx, activePos.x, activePos.y, px);
    // Clicking the widget jumps to the real map tab.
    canvas.onclick = () => { const t = $('tab-map'); if (t) t.click(); };
  }

  // Follow the island the main column is on (app.js publishes it), so the
  // rails don't default to mine[0] and disagree with the view beside them.
  function islandQuery() {
    const id = localStorage.getItem('tideholm-island');
    return id ? '?island=' + encodeURIComponent(id) : '';
  }

  async function tickState() {
    try {
      const s = await get('api/state' + islandQuery());
      fillState(s);
    } catch (e) { /* logged out or offline: rails just go stale */ }
  }

  async function tickMap() {
    try {
      lastMap = await get('api/map');
      drawMap(lastMap);
    } catch (e) { /* ignore */ }
  }

  tickStanding().then(tickState);
  tickMap();
  setInterval(tickState, 5000);
  setInterval(tickMap, 30000);
  setInterval(tickStanding, 60000);
})();
