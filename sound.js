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
  // 波形はトラックごとに決まっていて、トラック t の波形は WAVES[t]。
  // 小節（16 ステップ）は曲全体で 64 個まで。どのトラックからでも使え、鳴らすトラックの波形で鳴る。
  // 各トラックは、曲の位置ごとにどの小節を鳴らすかを並べる
  const TRACKS = 4, STEPS = 16, PATTERNS = 64, MAX_LENGTH = 64;
  const PITCHES = 48, FPS = 60;
  const WAVES = ['矩形波 50%', '矩形波 25%', '三角波', 'ノイズ'];
  // テンポは BPM。1 ステップ = 16 分音符（1 拍 = 4 ステップ）なので、16 ステップで 4/4 の 1 小節
  const STEPS_PER_BEAT = 4, BPM_MIN = 20, BPM_MAX = 900, BPM_DEFAULT = 120;
  const clampBpm = b => Math.max(BPM_MIN, Math.min(BPM_MAX, +b || BPM_DEFAULT));
  const clampLength = n => Math.max(1, Math.min(MAX_LENGTH, Math.round(+n) || 1));
  /* 1 ステップの長さ（フレーム数。小数になる） */
  const stepFrames = bpm => FPS * 60 / (clampBpm(bpm) * STEPS_PER_BEAT);

  // ---- 音程 ------------------------------------------------------------
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pitchFreq = p => 130.8128 * Math.pow(2, p / 12); // 0 = C3
  const pitchName = p => NOTE_NAMES[p % 12] + (3 + Math.floor(p / 12));
  /* "C4 E4:2 - G4" のような文字列を小節に書き込む（- は休符、:n は音量 1〜3） */
  function parseNotes(pattern, text) {
    text.trim().split(/\s+/).slice(0, STEPS).forEach((tok, i) => {
      const m = /^([A-G]#?)(\d)(?::([0-3]))?$/i.exec(tok);
      if (!m) { pattern.vol[i] = 0; return; }
      const p = (+m[2] - 3) * 12 + NOTE_NAMES.indexOf(m[1].toUpperCase());
      pattern.pitch[i] = Math.max(0, Math.min(PITCHES - 1, p));
      pattern.vol[i] = m[3] == null ? 3 : +m[3];
    });
    return pattern;
  }

  // ---- データ ----------------------------------------------------------
  // 小節 = ステップごとの音程と音量（0 = 無音）
  const newPattern = () => ({ pitch: new Uint8Array(STEPS), vol: new Uint8Array(STEPS) });
  // トラック = 小節の並び。order[位置] は 0 なら休み、k なら小節 k（song.patterns[k - 1]）
  function newTrack(wave) {
    return { wave: wave & 3, mute: false, solo: false, order: new Uint8Array(MAX_LENGTH) };
  }
  function newSong() {
    return {
      bpm: BPM_DEFAULT, length: 4,
      patterns: Array.from({ length: PATTERNS }, newPattern),
      tracks: [0, 1, 2, 3].map(newTrack),
    };
  }
  const isEmpty = pattern => pattern.vol.every(v => !v);
  /* 曲の位置 pos でトラック t が鳴らす小節（休みなら null） */
  function patternAt(song, t, pos) {
    const k = song.tracks[t].order[pos];
    return k ? song.patterns[k - 1] : null;
  }
  /* ほかにソロのトラックがあるときは、ソロのものだけが鳴る */
  function audible(song, t) {
    const track = song.tracks[t];
    return !track.mute && (track.solo || !song.tracks.some(o => o.solo));
  }

  const HEX = '0123456789abcdef';
  const hexVal = ch => { const v = parseInt(ch, 16); return v >= 0 ? v : 0; };
  // 1 ステップ = 16 進 3 桁（音程 2 桁 + 音量 1 桁）。末尾の無音は落とす
  function encNotes(pitch, vol) {
    let n = '';
    for (let k = 0; k < vol.length; k++) n += vol[k] ? HEX[pitch[k] >> 4] + HEX[pitch[k] & 15] + HEX[vol[k] & 3] : '000';
    return n.replace(/(000)+$/, '');
  }
  function decNotes(n, pitch, vol) {
    n = String(n || '');
    for (let k = 0; k < vol.length; k++) {
      vol[k] = hexVal(n[k * 3 + 2]) & 3;
      pitch[k] = vol[k] ? Math.min(PITCHES - 1, hexVal(n[k * 3]) << 4 | hexVal(n[k * 3 + 1])) : 0;
    }
  }
  function trimEnd(list, empty) {
    let n = list.length;
    while (n && list[n - 1] === empty) n--;
    return list.slice(0, n);
  }
  /* 保存用の形にする（ソロは保存しない）。patterns = 小節、o = 並び。どちらも末尾の空きは省く */
  function encode(song) {
    return {
      chip: 4, bpm: song.bpm, length: clampLength(song.length),
      patterns: trimEnd(song.patterns.map(p => encNotes(p.pitch, p.vol)), ''),
      tracks: song.tracks.map(t => ({ m: t.mute ? 1 : 0, o: trimEnd(Array.from(t.order), 0) })),
    };
  }

  // 以前の形式を読むための道具。中身（音の並び）から小節の番号を引き、同じ中身は 1 つの小節にまとめる
  function pool(song) {
    const seen = new Map();
    return notes => { // 空なら 0（休み）。入りきらないときも 0
      if (!notes) return 0;
      if (!seen.has(notes)) {
        if (seen.size >= PATTERNS) return 0;
        decNotes(notes, song.patterns[seen.size].pitch, song.patterns[seen.size].vol);
        seen.set(notes, seen.size + 1);
      }
      return seen.get(notes);
    };
  }
  const bar = n => encNotes(...(() => { const p = newPattern(); decNotes(n, p.pitch, p.vol); return [p.pitch, p.vol]; })());

  /* 保存した JSON（文字列でもよい）を読む。以前の形式も読める:
     chip 3（小節がトラックごとに別）は、小節を 1 つの置き場にまとめる。
     chip 2（小節に分かれていない 4 トラック）は、16 ステップごとに小節へ切り分ける。
     chip 1 や DOT のカートリッジ（効果音 32 個）は、中身のある効果音を同じ波形のトラックへ 4 つまで読む */
  function decode(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    const song = newSong();
    const tracks = data && Array.isArray(data.tracks) ? data.tracks.slice(0, TRACKS) : null;
    if (data && data.chip === 4 && tracks) {
      song.bpm = clampBpm(data.bpm);
      song.length = clampLength(data.length);
      (Array.isArray(data.patterns) ? data.patterns : []).slice(0, PATTERNS).forEach((n, k) => decNotes(n, song.patterns[k].pitch, song.patterns[k].vol));
      tracks.forEach((e, t) => {
        song.tracks[t].mute = !!e.m;
        (Array.isArray(e.o) ? e.o : []).slice(0, MAX_LENGTH).forEach((k, pos) => { song.tracks[t].order[pos] = k >= 1 && k <= PATTERNS ? k : 0; });
      });
      return song;
    }
    if (data && data.chip === 3 && tracks) {
      const id = pool(song);
      song.bpm = clampBpm(data.bpm);
      song.length = clampLength(data.length);
      tracks.forEach((e, t) => { // 並びに出てくる順に番号をふる
        const own = Array.isArray(e.p) ? e.p : [];
        song.tracks[t].mute = !!e.m;
        (Array.isArray(e.o) ? e.o : []).slice(0, MAX_LENGTH).forEach((k, pos) => { song.tracks[t].order[pos] = id(bar(own[k - 1])); });
      });
      tracks.forEach(e => (Array.isArray(e.p) ? e.p : []).forEach(n => id(bar(n)))); // 置いていない小節も残す
      return song;
    }
    if (data && data.chip === 2 && tracks) {
      const id = pool(song), bars = Math.max(1, Math.min(16, Math.round(+data.bars) || 1));
      song.bpm = clampBpm(data.bpm);
      song.length = bars;
      tracks.forEach((e, t) => {
        const n = String(e.n || '');
        song.tracks[t].mute = !!e.m;
        for (let b = 0; b < bars; b++) song.tracks[t].order[b] = id(bar(n.slice(b * STEPS * 3, (b + 1) * STEPS * 3)));
      });
      return song;
    }
    if (data && (data.chip === 1 || data.dot === 1) && Array.isArray(data.sfx)) {
      const id = pool(song), used = data.sfx.filter(e => e && bar(e.n));
      song.length = 1;
      if (used.length) song.bpm = used[0].b != null ? clampBpm(used[0].b) : clampBpm(FPS * 60 / (STEPS_PER_BEAT * Math.max(1, used[0].s | 0)));
      const free = [true, true, true, true];
      for (const e of used) {
        const t = free[e.w & 3] ? e.w & 3 : free.indexOf(true);
        if (t < 0) break;
        free[t] = false;
        song.tracks[t].order[0] = id(bar(e.n));
      }
      return song;
    }
    throw new Error('曲のデータではありません');
  }

  // ---- 再生 ------------------------------------------------------------
  /* tick() を毎秒 60 回呼ぶとステップが進み、ステップが変わるたびに全トラックぶんの
     voice(ch, wave, freq, vol) が呼ばれる。song は参照で持つので、再生中に書き換えてもそのまま反映される */
  function createSequencer(song, voice) {
    // pos = 曲の位置（何小節目か）、step = その中のステップ
    const state = { playing: false, pos: 0, step: 0, acc: 0, fresh: false, loop: true, from: 0, to: null, audition: null };

    function stop() {
      state.playing = false;
      for (let t = 0; t < TRACKS; t++) voice(t, 0, 0, 0);
    }
    /* 曲を位置 from（省くと先頭）から再生する。to を渡すと、その手前までを範囲にする */
    function play(from, to) {
      state.from = Math.max(0, Math.min(clampLength(song.length) - 1, from | 0));
      state.to = to == null ? null : to;
      state.audition = null;
      state.pos = state.from; state.step = 0; state.acc = 0;
      state.fresh = true;
      state.playing = true;
    }
    /* 小節 k（1〜）をトラック t の波形で試聴する。pos を渡すと、曲のその位置で一緒に鳴るほかのトラックも重ねる。
       省くとその小節だけを鳴らす（このときはミュートやソロの指定に関係なく鳴る）。置いていない小節でも試聴できる */
    function audition(t, k, pos) {
      const alone = pos == null || pos < 0;
      play(alone ? 0 : pos, alone ? 1 : pos + 1);
      state.audition = { t, k, alone };
    }
    function current(t) {
      const a = state.audition;
      if (a && a.t === t) return song.patterns[a.k - 1] || null;
      if (a && a.alone) return null;
      return patternAt(song, t, state.pos);
    }
    function tick() {
      if (!state.playing) return;
      const end = Math.min(state.to == null ? MAX_LENGTH : state.to, clampLength(song.length));
      if (state.pos >= end) { state.pos = Math.min(state.from, end - 1); state.step = 0; } // 再生中に曲を短くした
      if (state.fresh) { // ステップに入った最初のフレームで音を切り替える
        for (let t = 0; t < TRACKS; t++) {
          const a = state.audition, p = current(t);
          const v = p && ((a && a.alone) || audible(song, t)) ? p.vol[state.step] : 0;
          voice(t, song.tracks[t].wave, v ? pitchFreq(p.pitch[state.step]) : 0, v / 3);
        }
        state.fresh = false;
      }
      // 1 ステップの長さは整数フレームとは限らないので、端数を持ち越しながら進める
      const frames = stepFrames(song.bpm);
      if (++state.acc >= frames) {
        state.acc -= frames;
        state.fresh = true;
        if (++state.step >= STEPS) {
          state.step = 0;
          if (++state.pos >= end) { if (state.loop) state.pos = Math.min(state.from, end - 1); else stop(); }
        }
      }
    }
    return { state, play, audition, stop, tick };
  }

  return {
    TRACKS, STEPS, PATTERNS, MAX_LENGTH, PITCHES, FPS, WAVES, STEPS_PER_BEAT, BPM_MIN, BPM_MAX, BPM_DEFAULT,
    clampBpm, clampLength, stepFrames, pitchFreq, pitchName, parseNotes,
    newPattern, newTrack, newSong, isEmpty, patternAt, audible, encode, decode, createSequencer,
  };
});
