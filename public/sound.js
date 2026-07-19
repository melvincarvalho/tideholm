// Tideholm — UI sound (additive, index.html only; islands-dock pattern).
// v1: a short synthesized "tock" on button presses. No audio files — the
// sound is generated in WebAudio, so nothing is downloaded and the palette
// stays original. A 🔊 toggle is injected next to the theme button and the
// preference persists in localStorage ('ui-sound': 'off' mutes).
// Remove the script tag to revert entirely.

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
