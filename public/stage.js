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
  function drawMap(m) {
    const canvas = $('stage-map');
    const ctx = canvas.getContext('2d');
    window.TMap.hiDpiCanvas(canvas, 180);
    ctx.fillStyle = '#0e2a3f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    window.TMap.paintDots(ctx, m, activePos); // activePos {x,y} is drawn gold
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

  // app.js fires this the instant you switch islands (arrow key, dock, select);
  // move the gold marker now instead of waiting for the next 5s tickState (#119).
  window.addEventListener('tideholm:island', function (e) {
    if (e.detail) { activePos = e.detail; if (lastMap) drawMap(lastMap); }
  });

  tickStanding().then(tickState);
  tickMap();
  setInterval(tickState, 5000);
  setInterval(tickMap, 30000);
  setInterval(tickStanding, 60000);
})();
