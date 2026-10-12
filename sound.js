/* sound.js — 曲のデータと再生の手順。画面にも音の出力先にも依存しない。
   ブラウザでは window.ChipSound、Node では require('./sound.js') で読める。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChipSound = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- 仕様 ------------------------------------------------------------
  // 曲 = 4 トラック。トラック t は音源のチャンネル t をそのまま使い、同時に 1 音ずつ鳴らす。
  // 波形はトラックごとに決まっていて、トラック t の波形は WAVES[t]
  const TRACKS = 4, STEPS_PER_BAR = 16, MAX_BARS = 16, MAX_STEPS = STEPS_PER_BAR * MAX_BARS;
  const PITCHES = 48, FPS = 60;
  const WAVES = ['矩形波 50%', '矩形波 25%', '三角波', 'ノイズ'];
  // テンポは BPM。1 ステップ = 16 分音符（1 拍 = 4 ステップ）なので、16 ステップで 4/4 の 1 小節
  const STEPS_PER_BEAT = 4, BPM_MIN = 20, BPM_MAX = 900, BPM_DEFAULT = 120;
  const clampBpm = b => Math.max(BPM_MIN, Math.min(BPM_MAX, +b || BPM_DEFAULT));
  const clampBars = n => Math.max(1, Math.min(MAX_BARS, Math.round(+n) || 1));
  /* 1 ステップの長さ（フレーム数。小数になる） */
  const stepFrames = bpm => FPS * 60 / (clampBpm(bpm) * STEPS_PER_BEAT);

  // ---- 音程 ------------------------------------------------------------
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pitchFreq = p => 130.8128 * Math.pow(2, p / 12); // 0 = C3
  const pitchName = p => NOTE_NAMES[p % 12] + (3 + Math.floor(p / 12));
  /* "C4 E4:2 - G4" のような文字列を、トラックのステップ at から書き込む（- は休符、:n は音量 1〜3） */
  function parseNotes(track, text, at) {
    at = at || 0;
    text.trim().split(/\s+/).forEach((tok, k) => {
      const i = at + k;
      if (i >= MAX_STEPS) return;
      const m = /^([A-G]#?)(\d)(?::([0-3]))?$/i.exec(tok);
      if (!m) { track.vol[i] = 0; return; }
      const p = (+m[2] - 3) * 12 + NOTE_NAMES.indexOf(m[1].toUpperCase());
      track.pitch[i] = Math.max(0, Math.min(PITCHES - 1, p));
      track.vol[i] = m[3] == null ? 3 : +m[3];
    });
    return track;
  }

  // ---- データ ----------------------------------------------------------
  // トラック = 波形（番号と同じで変えられない）、ミュート / ソロ、ステップごとの音程と音量（0 = 無音）。
  // 配列はいつも最大の長さで持ち、曲の長さ（bars）はどこまで鳴らすかを決めるだけ
  function newTrack(wave) {
    return { wave: wave & 3, mute: false, solo: false, pitch: new Uint8Array(MAX_STEPS), vol: new Uint8Array(MAX_STEPS) };
  }
  function newSong() {
    return { bpm: BPM_DEFAULT, bars: 2, tracks: [0, 1, 2, 3].map(newTrack) };
  }
  const steps = song => clampBars(song.bars) * STEPS_PER_BAR;
  const isEmpty = track => track.vol.every(v => !v);
  /* ほかにソロのトラックがあるときは、ソロのものだけが鳴る */
  function audible(song, t) {
    const track = song.tracks[t];
    return !track.mute && (track.solo || !song.tracks.some(o => o.solo));
  }

  const HEX = '0123456789abcdef';
  const hexVal = ch => { const v = parseInt(ch, 16); return v >= 0 ? v : 0; };
  // 1 ステップ = 16 進 3 桁（音程 2 桁 + 音量 1 桁）。末尾の無音は落とす
  function encNotes(track) {
    let n = '';
    for (let k = 0; k < MAX_STEPS; k++) n += track.vol[k] ? HEX[track.pitch[k] >> 4] + HEX[track.pitch[k] & 15] + HEX[track.vol[k] & 3] : '000';
    return n.replace(/(000)+$/, '');
  }
  function decNotes(n, track, max) {
    n = String(n || '');
    for (let k = 0; k < max; k++) {
      track.pitch[k] = Math.min(PITCHES - 1, hexVal(n[k * 3]) << 4 | hexVal(n[k * 3 + 1]));
      track.vol[k] = hexVal(n[k * 3 + 2]) & 3;
    }
  }
  /* 保存用の形にする（ソロは保存しない） */
  function encode(song) {
    return {
      chip: 2, bpm: song.bpm, bars: clampBars(song.bars),
      tracks: song.tracks.map(t => ({ m: t.mute ? 1 : 0, n: encNotes(t) })),
    };
  }
  /* 保存した JSON（文字列でもよい）を読む。
     以前の形式（効果音 32 個）や DOT のカートリッジは、中身のある効果音を先頭から順に、
     同じ波形のトラックへ（ふさがっていれば空いているトラックへ）4 つまで読む */
  function decode(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    const song = newSong();
    if (data && data.chip === 2 && Array.isArray(data.tracks)) {
      song.bpm = clampBpm(data.bpm);
      song.bars = clampBars(data.bars);
      data.tracks.slice(0, TRACKS).forEach((e, t) => {
        const track = song.tracks[t];
        track.mute = !!e.m;
        decNotes(e.n, track, MAX_STEPS);
      });
      return song;
    }
    if (data && (data.chip === 1 || data.dot === 1) && Array.isArray(data.sfx)) {
      const used = data.sfx.filter(e => e && /[1-3]/.test(String(e.n || '').replace(/(..)(.)/g, '$2')));
      song.bars = 1;
      if (used.length) song.bpm = used[0].b != null ? clampBpm(used[0].b) : clampBpm(FPS * 60 / (STEPS_PER_BEAT * Math.max(1, used[0].s | 0)));
      const free = [true, true, true, true];
      for (const e of used) {
        const t = free[e.w & 3] ? e.w & 3 : free.indexOf(true);
        if (t < 0) break;
        free[t] = false;
        decNotes(e.n, song.tracks[t], STEPS_PER_BAR);
      }
      return song;
    }
    throw new Error('曲のデータではありません');
  }

  // ---- 再生 ------------------------------------------------------------
  /* tick() を毎秒 60 回呼ぶとステップが進み、ステップが変わるたびに全トラックぶんの
     voice(ch, wave, freq, vol) が呼ばれる。song は参照で持つので、再生中に書き換えてもそのまま反映される */
  function createSequencer(song, voice) {
    const state = { playing: false, step: 0, pos: 0, fresh: false, loop: true };

    function stop() {
      state.playing = false;
      for (let t = 0; t < TRACKS; t++) voice(t, 0, 0, 0);
    }
    /* ステップ from（省くと先頭）から再生する */
    function play(from) {
      state.step = Math.max(0, Math.min(steps(song) - 1, from | 0));
      state.pos = 0;
      state.fresh = true;
      state.playing = true;
    }
    function tick() {
      if (!state.playing) return;
      const n = steps(song);
      if (state.step >= n) state.step = 0; // 再生中に曲を短くした
      if (state.fresh) { // ステップに入った最初のフレームで音を切り替える
        for (let t = 0; t < TRACKS; t++) {
          const track = song.tracks[t], v = audible(song, t) ? track.vol[state.step] : 0;
          voice(t, track.wave, v ? pitchFreq(track.pitch[state.step]) : 0, v / 3);
        }
        state.fresh = false;
      }
      // 1 ステップの長さは整数フレームとは限らないので、端数を持ち越しながら進める
      const frames = stepFrames(song.bpm);
      if (++state.pos >= frames) {
        state.pos -= frames;
        state.fresh = true;
        if (++state.step >= n) { if (state.loop) state.step = 0; else stop(); }
      }
    }
    return { state, play, stop, tick };
  }

  return {
    TRACKS, STEPS_PER_BAR, MAX_BARS, MAX_STEPS, PITCHES, FPS, WAVES, STEPS_PER_BEAT, BPM_MIN, BPM_MAX, BPM_DEFAULT,
    clampBpm, clampBars, stepFrames, pitchFreq, pitchName, parseNotes,
    newTrack, newSong, steps, isEmpty, audible, encode, decode, createSequencer,
  };
});
