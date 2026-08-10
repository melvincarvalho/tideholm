// Tideholm — shared map rendering. One place that owns the island colours,
// HiDPI handling, and how the "you are here" gold is drawn, so the three map
// surfaces can't drift apart: the minimap and big-grid highlight (app.js) and
// the rail World Map (stage.js). Each caller passes the active island in — a
// single input — so "which island is gold" is never rediscovered per surface,
// which is what the earlier split kept getting wrong (#131).
//
// Exposed on window.TMap so the classic stage.js IIFE and the app.js module
// can both use it — the same pattern as window.I18N.
window.TMap = (function () {
  const COLORS = {
    you: '#3faf46', ally: '#2ab5a5', war: '#ff5544',
    player: '#3b7dd8', bot: '#e08030', barb: '#8d7b64', unowned: '#a9b0b8',
  };
  // The island you're currently on — gold, the one colour no team uses, so it
  // reads at a glance where an outline on a few-pixel cell never could (#119).
  const YOU_ARE_HERE = '#ffd21a';

  function kindOf(isl) {
    return isl.isYou ? 'you'
      : isl.relation === 'war' ? 'war'
      : isl.relation === 'ally' || isl.relation === 'same' ? 'ally'
      : isl.unowned ? 'unowned' : isl.barbarian ? 'barb' : isl.isBot ? 'bot' : 'player';
  }

  // Is this island the one you're currently on? `active` is {x,y} or null.
  function isHere(isl, active) {
    return !!active && isl.x === active.x && isl.y === active.y;
  }

  // Size the canvas backing store to the display's pixel ratio, so a fixed
  // 160/180px buffer isn't upscaled and blurred on a HiDPI screen (island
  // dots and the gold marker smear otherwise). Idempotent — safe every draw.
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

  // Paint the island dots onto a canvas the caller has already sized (via
  // hiDpiCanvas) and given a background. `active` {x,y} is drawn gold.
  function paintDots(ctx, data, active) {
    const px = ctx.canvas.width / data.size;
    for (const isl of data.islands) {
      ctx.fillStyle = isHere(isl, active) ? YOU_ARE_HERE : COLORS[kindOf(isl)];
      ctx.fillRect(isl.x * px, isl.y * px, Math.max(2, px - 1), Math.max(2, px - 1));
    }
  }

  // The big DOM grid's gold highlight (app.js owns the grid; this owns the
  // rule). Clears every prior highlight and re-derives it from `active`, so it
  // can never leave two golds or a stale one — the bug the surgical move hit.
  // `size` is the grid's side; cells are row-major (index = y*size + x).
  function markGridActive(grid, size, active) {
    if (!grid || !grid.children.length || !active) return;
    const prev = grid.querySelectorAll('.cell.active');
    for (let i = 0; i < prev.length; i++) prev[i].classList.remove('active');
    const cell = grid.children[active.y * size + active.x];
    if (cell && cell.classList.contains('island')) cell.classList.add('active');
  }

  return { COLORS, YOU_ARE_HERE, kindOf, isHere, hiDpiCanvas, paintDots, markGridActive };
})();
