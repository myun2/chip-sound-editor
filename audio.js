/* audio.js — 4 チャンネルの音源（WebAudio）。voice() で「このチャンネルをこの音で」を受け取って鳴らすだけ。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChipAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const CHANNELS = 4;
  const LEVEL = [1, 1, 1.7, 0.9]; // 波形ごとの聞こえかたの差をならす

  function create() {
    let ctx = null, master = null, pulse25 = null, noise = null, volume = 0.5;
    const voices = [];

    // 最初のユーザー操作のあとでないと音は出せないので、そこで初めて作る
    function ensure() {
      if (ctx) return true;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume * 0.2;
      master.connect(ctx.destination);

      const N = 32, re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) {
        re[n] = 2 / (n * Math.PI) * Math.sin(2 * Math.PI * n * 0.25);
        im[n] = 2 / (n * Math.PI) * (1 - Math.cos(2 * Math.PI * n * 0.25));
      }
      pulse25 = ctx.createPeriodicWave(re, im);

      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() < 0.5 ? -1 : 1;

      for (let i = 0; i < CHANNELS; i++) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(master);
        voices.push({ gain, src: null, wave: -1 });
      }
      return true;
    }

    function source(v, wave) {
      if (v.src) { try { v.src.stop(); } catch (e) { /* まだ鳴っていない */ } v.src.disconnect(); }
      let src;
      if (wave === 3) {
        src = ctx.createBufferSource();
        src.buffer = noise;
        src.loop = true;
      } else {
        src = ctx.createOscillator();
        if (wave === 1) src.setPeriodicWave(pulse25); else src.type = wave === 2 ? 'triangle' : 'square';
      }
      src.connect(v.gain);
      src.start();
      v.src = src; v.wave = wave;
    }

    function voice(ch, wave, freq, vol) {
      if (!ctx) return;
      const v = voices[ch], t = ctx.currentTime;
      if (!v) return;
      if (!(vol > 0 && freq > 0)) { v.gain.gain.setTargetAtTime(0, t, 0.004); return; }
      if (v.wave !== wave) source(v, wave);
      if (wave === 3) v.src.playbackRate.setValueAtTime(Math.max(0.02, Math.min(4, freq / 1000)), t);
      else v.src.frequency.setValueAtTime(freq, t);
      v.gain.gain.setTargetAtTime(vol * LEVEL[wave], t, 0.003);
    }

    return {
      voice,
      resume() { if (ensure() && ctx.state === 'suspended') ctx.resume(); },
      silence() { for (let i = 0; i < voices.length; i++) voice(i, 0, 0, 0); },
      setVolume(v) { volume = v; if (master) master.gain.value = v * 0.2; },
    };
  }

  return { create };
});
