// islands-dock.js — QoL: a bottom dock of YOUR islands with alert dots.
//
// Fully additive and FRONTEND-ONLY. It never mutates game state:
//   • reads the player's island list + incoming attacks from GET /api/state
//   • reads per-island queue/storehouse from GET /api/state?island=<id> (read-only)
//   • switches islands by driving the app's existing <select id="island-select">
// It touches nothing in app.js and fails silent — a throw here can't break the
// game (separate <script defer>). Remove the one include line to roll back.
(function () {
  'use strict';

  var BASE_POLL_MS = 15000;   // island list + incoming-attack dots
  var DETAIL_POLL_MS = 60000; // per-island queue/storehouse dots
  var CAP_WARN = 0.9;         // storehouse >= 90% -> amber

  function token() { try { return localStorage.getItem('tideholm-token'); } catch (e) { return null; } }

  // Relative fetch — resolves under the mount prefix (e.g. /tideholm/), exactly
  // like app.js's api(). Read-only GET; returns null on any failure.
  function apiGet(path) {
    var t = token();
    if (!t) return Promise.resolve(null);
    return fetch(path.replace(/^\//, ''), { headers: { Authorization: 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // --- one-time DOM + styles ----------------------------------------------
  var dock, listEl;
  function ensureDock() {
    if (dock) return;
    var style = document.createElement('style');
    style.textContent =
      '#islands-dock{position:fixed;left:0;right:0;bottom:0;z-index:9000;display:none;' +
      'gap:6px;padding:6px 8px;overflow-x:auto;white-space:nowrap;' +
      'background:rgba(20,24,32,.94);border-top:1px solid rgba(255,255,255,.14);' +
      'font:500 12px/1.2 system-ui,sans-serif;-webkit-overflow-scrolling:touch}' +
      '#islands-dock .isl{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;' +
      'padding:5px 9px;border-radius:8px;color:#e8edf5;cursor:pointer;' +
      'background:rgba(255,255,255,.06);border:1px solid transparent}' +
      '#islands-dock .isl:hover{background:rgba(255,255,255,.12)}' +
      '#islands-dock .isl.active{border-color:#5b9dff;background:rgba(91,157,255,.16)}' +
      '#islands-dock .nm{max-width:120px;overflow:hidden;text-overflow:ellipsis}' +
      '#islands-dock .co{opacity:.55;font-weight:400}' +
      '#islands-dock .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}' +
      '#islands-dock .d-atk{background:#e5484d;box-shadow:0 0 0 2px rgba(229,72,77,.28)}' +
      '#islands-dock .d-cap{background:#f5a524}' +
      '#islands-dock .d-idle{background:#5b9dff;opacity:.75}' +
      '#islands-dock .lbl{color:#7f8ea3;font-weight:400;padding:5px 4px;flex:0 0 auto}';
    document.head.appendChild(style);

    dock = document.createElement('div');
    dock.id = 'islands-dock';
    var lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Islands';
    listEl = document.createElement('span');
    dock.appendChild(lbl);
    dock.appendChild(listEl);
    document.body.appendChild(dock);
  }

  // --- state ---------------------------------------------------------------
  var islands = [];            // [{id,name,x,y}]
  var attackCoords = {};       // "x:y" -> soonest arrive ms (incoming attacks)
  var detail = {};             // id -> {cap:bool, idle:bool}
  var knownIds = '';           // island-set signature; changes -> refresh dots now

  function activeId() {
    var sel = document.getElementById('island-select');
    return sel && sel.value ? Number(sel.value) : (islands[0] ? islands[0].id : null);
  }

  function switchTo(id) {
    var sel = document.getElementById('island-select');
    if (sel) {
      sel.value = String(id);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function coordKey(x, y) { return x + ':' + y; }

  function render() {
    if (!islands.length || !token()) { if (dock) dock.style.display = 'none'; return; }
    ensureDock();
    dock.style.display = 'flex';
    var cur = activeId();
    listEl.textContent = '';
    // Descending creation order: the API lists islands in world-array
    // (map-generation) order, so acquired islands would come BEFORE the
    // founding island. Reversed, the founding island anchors the left.
    islands.slice().reverse().forEach(function (i) {
      var d = detail[i.id] || {};
      var atk = Object.prototype.hasOwnProperty.call(attackCoords, coordKey(i.x, i.y));
      var pill = document.createElement('span');
      pill.className = 'isl' + (i.id === cur ? ' active' : '');
      pill.title = i.name + ' (' + i.x + ':' + i.y + ')'
        + (atk ? ' — UNDER ATTACK' : '') + (d.cap ? ' — storehouse near full' : '')
        + (d.idle ? ' — build queue idle' : '');
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = i.name;
      pill.appendChild(nm);
      var co = document.createElement('span');
      co.className = 'co';
      co.textContent = i.x + ':' + i.y;
      pill.appendChild(co);
      if (atk) pill.appendChild(mkDot('d-atk'));
      if (d.cap) pill.appendChild(mkDot('d-cap'));
      if (d.idle) pill.appendChild(mkDot('d-idle'));
      pill.addEventListener('click', function () { switchTo(i.id); setTimeout(render, 120); });
      listEl.appendChild(pill);
    });
  }

  function mkDot(cls) { var s = document.createElement('span'); s.className = 'dot ' + cls; return s; }

  // --- island navigation: arrow keys + swipe -------------------------------
  // Moves through islands in DOCK order (see render's reverse). dir +1 = the
  // next chip to the right. Wraps at the ends.
  function step(dir) {
    if (islands.length < 2 || !token()) return;
    var order = islands.slice().reverse();
    var cur = activeId();
    var idx = order.findIndex(function (i) { return i.id === cur; });
    var next = order[(idx + dir + order.length) % order.length];
    switchTo(next.id);
    setTimeout(function () {
      render();
      var active = listEl && listEl.querySelector('.isl.active');
      if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }, 120);
  }

  // Plain ←/→ only, and never while typing (inputs, textareas, selects,
  // contenteditable) — those own their own arrow-key behavior.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    var t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  });

  // Swipe on the island header only — a page-wide listener would fight the
  // map drag, wide tables, and the dock's own horizontal scroll. Swipe left
  // (content moves left) = next island rightward in the dock.
  var swipe = null;
  document.addEventListener('touchstart', function (e) {
    var hd = e.target && e.target.closest && e.target.closest('#island-title');
    swipe = (hd && e.touches.length === 1)
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!swipe || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - swipe.x;
    var dy = e.changedTouches[0].clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) >= 50 && Math.abs(dy) < Math.abs(dx)) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  // --- polls ---------------------------------------------------------------
  function pollBase() {
    apiGet('/api/state').then(function (s) {
      if (!s || !Array.isArray(s.islands)) return;
      islands = s.islands;
      attackCoords = {};
      var inc = s.movements && s.movements.incoming;
      if (Array.isArray(inc)) {
        inc.forEach(function (m) {
          var mm = /\((\d+):(\d+)\)/.exec(m.target || '');
          if (mm) {
            var k = coordKey(Number(mm[1]), Number(mm[2]));
            if (!(k in attackCoords) || m.arrive < attackCoords[k]) attackCoords[k] = m.arrive;
          }
        });
      }
      render();
      // Dots come from per-island detail; the islands list arrives here (async),
      // so prime/refresh detail as soon as we know the set — don't wait a full
      // DETAIL_POLL_MS for the first amber/blue dots to paint.
      var ids = islands.map(function (i) { return i.id; }).join(',');
      if (ids !== knownIds) { knownIds = ids; pollDetail(); }
    });
  }

  function pollDetail() {
    if (!islands.length) return;
    islands.forEach(function (i, idx) {
      // stagger so N islands don't fire simultaneously
      setTimeout(function () {
        apiGet('/api/state?island=' + i.id).then(function (s) {
          if (!s || !s.island) return;
          var isl = s.island, cap = Number(isl.capacity) || 0;
          var maxRes = Math.max(isl.resources ? isl.resources.wood : 0,
                                isl.resources ? isl.resources.stone : 0);
          detail[i.id] = {
            cap: cap > 0 && maxRes >= cap * CAP_WARN,
            idle: Array.isArray(isl.queue) && isl.queue.length === 0,
          };
          render();
        });
      }, idx * 250);
    });
  }

  function start() {
    try {
      ensureDock();
      pollBase();
      pollDetail();
      setInterval(pollBase, BASE_POLL_MS);
      setInterval(pollDetail, DETAIL_POLL_MS);
    } catch (e) { /* fail silent: the game must never break because of the dock */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
