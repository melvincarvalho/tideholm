// Tideholm — UI sound (additive, index.html only; islands-dock pattern).
// All sounds are synthesized in WebAudio — no audio files, nothing
// downloaded, an original palette from one small instrument family:
//   tock        button presses
//   war drum    an incoming attack appears
//   report note the unread-reports badge grows
//   mail ding   the mail badge grows
//   bell        a build or training run completes
//   quest chime the current quest changes (i.e. one was completed)
// Event detection watches the DOM the client already renders (1s poll of
// badges/movements/queues) — the game stays sound-agnostic. One 🔊 toggle
// (localStorage 'ui-sound': 'off') rules everything; remove the script tag
// to revert entirely.

(function () {
  'use strict';

  let ctx = null;
  const enabled = () => localStorage.getItem('ui-sound') !== 'off';

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // A wooden "tock": no tone sweep (that reads as an electronic zap) —
  // just a noise burst ringing through a wood-like resonance, with a
  // whisper of low-end body. Knuckle on a table, not a laser.
  function tock() {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;

    const len = Math.floor(c.sampleRate * 0.02);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = c.createBufferSource();
    noise.buffer = buf;

    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1600;
    bp.Q.value = 5;

    const ng = c.createGain();
    ng.gain.setValueAtTime(0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    noise.connect(bp).connect(ng).connect(c.destination);
    noise.start(t);

    const thump = c.createOscillator();
    thump.type = 'sine';
    thump.frequency.value = 170;
    const tg = c.createGain();
    tg.gain.setValueAtTime(0.06, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    thump.connect(tg).connect(c.destination);
    thump.start(t);
    thump.stop(t + 0.06);
  }

  // ---------------- the rest of the instrument family ----------------

  // A small bell: fundamental plus one inharmonic partial, fast decay.
  function bell(freq, dur, gain) {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    for (const [mult, g] of [[1, gain], [2.76, gain * 0.35]]) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const og = c.createGain();
      og.gain.setValueAtTime(g, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(og).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }

  // A low drum boom: dropping sine plus a soft noise thump.
  function boom(when) {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime + (when || 0);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.25);
    const og = c.createGain();
    og.gain.setValueAtTime(0.28, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(og).connect(c.destination);
    o.start(t);
    o.stop(t + 0.32);

    const len = Math.floor(c.sampleRate * 0.03);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = c.createBufferSource();
    n.buffer = buf;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    n.connect(lp).connect(ng).connect(c.destination);
    n.start(t);
  }

  const warDrum = () => { boom(0); boom(0.22); };          // incoming attack
  const reportNote = () => bell(220, 0.3, 0.09);           // something happened
  const mailDing = () => bell(1175, 0.28, 0.05);           // a letter
  const buildBell = () => bell(660, 0.45, 0.07);           // work finished
  const questChime = () => { bell(523, 0.3, 0.08); setTimeout(() => bell(659, 0.35, 0.07), 100); };

  // ---------------- event watcher (reads what the client renders) -------

  const num = (id) => {
    const el = document.getElementById(id);
    return el ? (parseInt(el.textContent, 10) || 0) : 0;
  };
  const text = (id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden') ? el.textContent.trim() : '';
  };

  let base = null;
  setInterval(() => {
    if (!enabled()) { base = null; return; }
    const snap = {
      incoming: document.querySelectorAll('#movements .movement.incoming').length,
      reports: num('report-badge'),
      mail: num('mail-badge'),
      work: document.querySelectorAll('#queue .countdown, #train-queue .countdown').length,
      quest: text('quest-box'),
      island: text('island-title'),
    };
    if (base) {
      if (snap.incoming > base.incoming) warDrum();
      if (snap.reports > base.reports) reportNote();
      if (snap.mail > base.mail) mailDing();
      // Fewer running jobs on the SAME island = something finished
      // (an island switch changes the whole list; stay silent then).
      if (snap.island === base.island && snap.work < base.work) buildBell();
      if (base.quest && snap.quest !== base.quest) questChime();
    }
    base = snap;
  }, 1000);

  // Any button press ticks (pointerdown feels snappier than click).
  document.addEventListener('pointerdown', (e) => {
    if (!enabled()) return;
    const btn = e.target.closest('button, .tab');
    if (!btn || btn.disabled) return;
    tock();
  }, true);

  // Inject the mute toggle next to the theme button.
  function injectToggle() {
    const anchor = document.getElementById('theme-toggle');
    if (!anchor || document.getElementById('sound-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'sound-toggle';
    btn.className = 'small-btn';
    btn.title = 'Sound';
    btn.textContent = enabled() ? '🔊' : '🔇';
    btn.addEventListener('click', () => {
      const next = enabled() ? 'off' : 'on';
      localStorage.setItem('ui-sound', next);
      btn.textContent = next === 'off' ? '🔇' : '🔊';
      if (next === 'on') tock();
    });
    anchor.insertAdjacentElement('afterend', btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectToggle);
  } else {
    injectToggle();
  }
})();
