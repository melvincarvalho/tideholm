// Tideholm — stage rails (Tier-2 experiment, stage.html only).
// Read-only decoration: fills the left/right rails from its own polls of the
// same API the client uses. Deliberately throwaway scaffolding — if the
// stage layout wins, this logic folds into the real client; if not, the
// three stage files are deleted. Fails silent; never mutates anything.

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

  function left(finish) {
    const s = Math.max(0, Math.round((finish - Date.now()) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function fillState(s) {
    const isl = s.island;
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

  function drawMap(m) {
    const canvas = $('stage-map');
    const ctx = canvas.getContext('2d');
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
    // Clicking the widget jumps to the real map tab.
    canvas.onclick = () => { const t = $('tab-map'); if (t) t.click(); };
  }

  async function tickState() {
    try {
      const s = await get('api/state');
      fillState(s);
    } catch (e) { /* logged out or offline: rails just go stale */ }
  }

  async function tickMap() {
    try {
      drawMap(await get('api/map'));
    } catch (e) { /* ignore */ }
  }

  tickStanding().then(tickState);
  tickMap();
  setInterval(tickState, 5000);
  setInterval(tickMap, 30000);
  setInterval(tickStanding, 60000);
})();
