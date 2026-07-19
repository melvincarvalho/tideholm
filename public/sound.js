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

  // A wooden "tock": a fast pitch-dropping blip plus a whisper of noise.
  function tock() {
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    const out = c.createGain();
    out.gain.setValueAtTime(0.12, t);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    out.connect(c.destination);

    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(950, t);
    osc.frequency.exponentialRampToValueAtTime(480, t + 0.045);
    osc.connect(out);
    osc.start(t);
    osc.stop(t + 0.07);

    const len = Math.floor(c.sampleRate * 0.015);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = c.createBufferSource();
    noise.buffer = buf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const ng = c.createGain();
    ng.gain.value = 0.05;
    noise.connect(hp).connect(ng).connect(out);
    noise.start(t);
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
