// hotkeys.js — QoL: keyboard shortcuts for tabs and islands (#32).
//
// Fully additive and FRONTEND-ONLY, in the same spirit as islands-dock.js:
// it drives the app through the DOM it already renders — clicking the real
// tab buttons (so each tab's own loader still runs) and the real island
// <select>. app.js is an ES module and exports nothing, so this is not just
// tidier, it is the only way in without touching it.
// Fails silent; remove the one include line to roll back.
(function () {
  'use strict';

  // letter -> [tab button id, i18n key for the label]. First letters can't be
  // used: Map/Market/Mail all start with 'm', Reports/Rankings with 'r'. And
  // mnemonics don't survive translation (Map is Karte, Reports is Berichte),
  // so these are a fixed convention, listed in the ? sheet and the help pages.
  var TABS = [
    ['i', 'tab-island', 'ui.tab.island'],
    ['o', 'tab-islands', 'ui.tab.islands'],  // overview
    ['m', 'tab-map', 'ui.tab.map'],
    ['r', 'tab-reports', 'ui.tab.reports'],
    ['l', 'tab-rankings', 'ui.tab.rankings'],   // leaderboard
    ['t', 'tab-market', 'ui.tab.market'],       // trade
    ['a', 'tab-alliance', 'ui.tab.alliance'],
    ['p', 'tab-messages', 'ui.tab.mail'],       // post
  ];

  function T(key, fallback) {
    try {
      var s = window.I18N.t(document.documentElement.lang || 'en', key);
      return s === key ? fallback : s;
    } catch (e) { return fallback; }
  }

  // Never steal a keystroke from a field: troop counts, island rename, the
  // mail composer. Same rule islands-dock.js uses for its arrow keys.
  function isTyping(t) {
    return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  }

  function inGame() {
    var g = document.getElementById('game');
    return !!g && !g.classList.contains('hidden');
  }

  // Digits follow the DOCK's rendered order, so pinned islands (#28) are 1,2,3.
  // Falls back to the island <select> when the dock isn't on the page.
  function selectIsland(n) {
    var chips = document.querySelectorAll('#islands-dock .isl');
    if (chips.length >= n) { chips[n - 1].click(); return true; }
    var sel = document.getElementById('island-select');
    if (sel && sel.options.length >= n) {
      sel.value = sel.options[n - 1].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  // --- the ? cheatsheet ----------------------------------------------------
  var sheet = null;

  function buildSheet() {
    var style = document.createElement('style');
    style.textContent =
      '#hotkey-sheet{position:fixed;inset:0;z-index:9500;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(8,10,14,.55)}' +
      '#hotkey-sheet .box{background:rgba(20,24,32,.97);color:#e8edf5;' +
      'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:16px 18px;' +
      'font:500 13px/1.45 system-ui,sans-serif;min-width:240px;max-width:90vw;' +
      'max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.5)}' +
      '#hotkey-sheet h3{margin:0 0 10px;font-size:14px}' +
      '#hotkey-sheet table{border-collapse:collapse;width:100%}' +
      '#hotkey-sheet td{padding:3px 0;border:0}' +
      '#hotkey-sheet kbd{display:inline-block;min-width:1.4em;text-align:center;' +
      'background:rgba(255,255,255,.11);border:1px solid rgba(255,255,255,.2);' +
      'border-radius:4px;padding:1px 5px;font:600 12px/1.4 ui-monospace,monospace;' +
      'margin-right:10px}' +
      '#hotkey-sheet .hint{opacity:.6;margin-top:10px;font-weight:400}';
    document.head.appendChild(style);

    sheet = document.createElement('div');
    sheet.id = 'hotkey-sheet';
    var box = document.createElement('div');
    box.className = 'box';
    var h = document.createElement('h3');
    h.textContent = T('ui.keys.title', 'Keyboard shortcuts');
    box.appendChild(h);
    var tbl = document.createElement('table');
    var rows = TABS.map(function (t) { return [t[0], T(t[2], t[1])]; });
    rows.push(['1–9', T('ui.keys.islands', 'Switch island (dock order)')]);
    rows.push(['?', T('ui.keys.title', 'Keyboard shortcuts')]);
    rows.push(['Esc', T('ui.keys.close', 'Close')]);
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var k = document.createElement('td');
      var kbd = document.createElement('kbd');
      kbd.textContent = r[0];
      k.appendChild(kbd);
      k.style.width = '1%';
      var v = document.createElement('td');
      v.textContent = r[1];
      tr.appendChild(k); tr.appendChild(v);
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '← →  ' + T('ui.keys.islands', 'Switch island (dock order)');
    box.appendChild(hint);
    sheet.appendChild(box);
    // Click anywhere outside the box to dismiss.
    sheet.addEventListener('click', function (e) { if (e.target === sheet) hideSheet(); });
    document.body.appendChild(sheet);
  }

  function showSheet() {
    if (!sheet) buildSheet();
    // Labels are language-dependent and the player can switch mid-session.
    sheet.remove(); sheet = null; buildSheet();
    sheet.style.display = 'flex';
  }
  function hideSheet() { if (sheet) sheet.style.display = 'none'; }
  function sheetOpen() { return !!sheet && sheet.style.display !== 'none'; }

  // --- key handling --------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return; // leave browser/OS shortcuts alone
    if (isTyping(e.target)) return;

    // Escape works even outside the game (dismisses the sheet).
    if (e.key === 'Escape') {
      if (sheetOpen()) { hideSheet(); e.preventDefault(); return; }
      var panel = document.getElementById('attack-panel');
      if (panel && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        e.preventDefault();
      }
      return;
    }

    if (!inGame()) return;

    // '?' needs Shift on most layouts, so it is checked before the Shift bail.
    if (e.key === '?') { showSheet(); e.preventDefault(); return; }
    if (e.shiftKey) return;

    if (e.key >= '1' && e.key <= '9') {
      if (selectIsland(Number(e.key))) e.preventDefault();
      return;
    }

    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i][0] === e.key) {
        var btn = document.getElementById(TABS[i][1]);
        if (btn) { btn.click(); e.preventDefault(); }
        return;
      }
    }
  });

  // Discoverability: show the key on each tab button. Language-neutral, and
  // app.js's applyStatic() only rewrites textContent, so this survives a
  // language switch.
  function label() {
    TABS.forEach(function (t) {
      var b = document.getElementById(t[1]);
      if (b) b.title = '[' + t[0] + ']';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', label);
  } else {
    label();
  }
})();
