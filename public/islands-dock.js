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
  var LONG_PRESS_MS = 500;    // hold to pin/unpin
  var PRESS_SLOP_PX = 8;      // more movement than this = a scroll, not a press
  var PIN_KEY = 'tideholm-dock-pins';

  function token() { try { return localStorage.getItem('tideholm-token'); } catch (e) { return null; } }

  // Pinned island ids, newest pin last. Storage may be blocked (same as token()),
  // in which case pinning still works for the session but doesn't persist.
  function loadPins() {
    try {
      var v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (n) { return typeof n === 'number'; }) : [];
    } catch (e) { return []; }
  }
  function savePins() {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch (e) { /* not persisted */ }
  }

  // Relative fetch — resolves under the mount prefix (e.g. /tideholm/), exactly
  // like app.js's api(). Read-only GET; returns null on any failure.
  // Sends the pod Bearer token when there is one, and otherwise relies on the
  // session cookie — password-mode players have no token, and bailing out on
  // that made the whole dock invisible for them.
  function apiGet(path) {
    var t = token();
    return fetch(path.replace(/^\//, ''), t ? { headers: { Authorization: 'Bearer ' + t } } : undefined)
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
      // user-select/touch-callout off: a held press must not start a text
      // selection or the browser's own callout — those fight the long-press.
      '#islands-dock .isl{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;' +
      'padding:5px 9px;border-radius:8px;color:#e8edf5;cursor:pointer;' +
      'background:rgba(255,255,255,.06);border:1px solid transparent;' +
      '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
      '#islands-dock .isl:hover{background:rgba(255,255,255,.12)}' +
      '#islands-dock .isl.active{border-color:#5b9dff;background:rgba(91,157,255,.16)}' +
      '#islands-dock .isl.pinned{background:rgba(245,165,36,.13)}' +
      '#islands-dock .isl.pinned.active{background:rgba(91,157,255,.18)}' +
      '#islands-dock .pin{font-size:10px;line-height:1;flex:0 0 auto;opacity:.9}' +
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
  var pins = loadPins();       // island ids pinned to the front, in pin order

  // THE dock order — used by render() AND by step()'s arrow navigation. Keep it
  // that way: if only one of them knew about pins, the arrow keys would walk a
  // different sequence than the chips on screen.
  function orderedIslands() {
    // Descending creation order: the API lists islands in world-array
    // (map-generation) order, so acquired islands would come BEFORE the
    // founding island. Reversed, the founding island anchors the left.
    var base = islands.slice().reverse();
    // Drop pins for islands we no longer own (lost, or a fresh season).
    var live = {};
    base.forEach(function (i) { live[i.id] = true; });
    var kept = pins.filter(function (id) { return live[id]; });
    if (kept.length !== pins.length) { pins = kept; savePins(); }
    var pinned = [], rest = [];
    base.forEach(function (i) {
      if (pins.indexOf(i.id) >= 0) pinned.push(i); else rest.push(i);
    });
    pinned.sort(function (a, b) { return pins.indexOf(a.id) - pins.indexOf(b.id); });
    return pinned.concat(rest);
  }

  function togglePin(id) {
    var at = pins.indexOf(id);
    if (at >= 0) pins.splice(at, 1); else pins.push(id);
    savePins();
    render();
  }

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
    // The 15s/60s polls call this and replace every chip, so any press still in
    // flight is now aimed at a detached node — drop it rather than let it fire.
    cancelPress();
    // Gate on having islands, not on having a token: a logged-out player has
    // no islands, and a password-mode player has islands but never a token.
    if (!islands.length) { if (dock) dock.style.display = 'none'; return; }
    ensureDock();
    dock.style.display = 'flex';
    var cur = activeId();
    listEl.textContent = '';
    orderedIslands().forEach(function (i) {
      var d = detail[i.id] || {};
      var atk = Object.prototype.hasOwnProperty.call(attackCoords, coordKey(i.x, i.y));
      var isPinned = pins.indexOf(i.id) >= 0;
      var pill = document.createElement('span');
      pill.className = 'isl' + (i.id === cur ? ' active' : '') + (isPinned ? ' pinned' : '');
      pill.title = i.name + ' (' + i.x + ':' + i.y + ')'
        + (atk ? ' — UNDER ATTACK' : '') + (d.cap ? ' — storehouse near full' : '')
        + (d.idle ? ' — build queue idle' : '')
        + (isPinned ? ' — pinned (hold to unpin)' : ' — hold to pin');
      if (isPinned) {
        var pn = document.createElement('span');
        pn.className = 'pin';
        pn.textContent = '📌';
        pill.appendChild(pn);
      }
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
      pill.addEventListener('click', function () {
        if (clickSuppressedUntil > Date.now()) return; // that was a pin, not a tap
        switchTo(i.id);
        setTimeout(render, 120);
      });
      armPin(pill, i.id);
      listEl.appendChild(pill);
    });
  }

  function mkDot(cls) { var s = document.createElement('span'); s.className = 'dot ' + cls; return s; }

  // --- pinning: long-press (touch + mouse) or right-click ------------------
  // A sideways drag in this strip is a SCROLL, so a press that moves more than
  // PRESS_SLOP_PX is abandoned. Pointer events cover touch and mouse alike;
  // HTML5 drag-and-drop would not work on touch at all.
  var press = null;               // {id, x, y, timer}
  var clickSuppressedUntil = 0;   // a fired long-press must not also switch island

  function cancelPress() {
    if (press) { clearTimeout(press.timer); press = null; }
  }

  function armPin(pill, id) {
    pill.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return; // right-click handled below
      cancelPress();
      press = {
        id: id, x: e.clientX, y: e.clientY,
        timer: setTimeout(function () {
          press = null;
          clickSuppressedUntil = Date.now() + 500;
          togglePin(id); // re-renders, so the chip under the finger is replaced
        }, LONG_PRESS_MS),
      };
    });
    // Right-click / long-press context menu: the desktop shortcut.
    pill.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      cancelPress();
      clickSuppressedUntil = Date.now() + 500;
      togglePin(id);
    });
  }

  // Movement past the slop means the user is scrolling the dock — let them.
  document.addEventListener('pointermove', function (e) {
    if (!press) return;
    if (Math.abs(e.clientX - press.x) > PRESS_SLOP_PX
        || Math.abs(e.clientY - press.y) > PRESS_SLOP_PX) cancelPress();
  }, { passive: true });
  document.addEventListener('pointerup', cancelPress, { passive: true });
  document.addEventListener('pointercancel', cancelPress, { passive: true });

  // --- island navigation: arrow keys + swipe -------------------------------
  // Moves through islands in DOCK order — orderedIslands() is shared with
  // render() so pinning can't desync the arrows from what's on screen.
  // dir +1 = the next chip to the right. Wraps at the ends.
  function step(dir) {
    if (islands.length < 2) return;
    var order = orderedIslands();
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
