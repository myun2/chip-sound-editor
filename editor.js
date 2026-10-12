/* editor.js — 画面。4 トラックの曲をピアノロールで編集し、その場で鳴らす。
   song は再生側と共有しているので、差し替えずに中身を書き換える。 */
(function (root) {
  'use strict';
  const S = root.ChipSound;
  const { TRACKS, STEPS_PER_BAR, PITCHES } = S;
  const $ = id => document.getElementById(id);

  const STORE = 'chip-sound-editor-v2';                 // v1 は効果音 32 個の時代。形が違うので引き継がない
  // ピアノロールの寸法: 上から 小節番号 / 音程のマス目 / 音量の帯
  const CW = 22, RH = 9, TOP = 14, GRID_H = PITCHES * RH, VOL_Y = TOP + GRID_H + 8, VOL_H = 40, ROLL_H = VOL_Y + VOL_H;
  const LANE = 13;                                       // 全体図の 1 トラックぶんの高さ
  const COLORS = ['#f2796a', '#f7c873', '#62c0a8', '#9db8e8'];
  const LEVEL = [0, 0.45, 0.72, 1];                      // 音量 → 濃さ

  const song = S.newSong();
  const audio = root.ChipAudio.create();
  const seq = S.createSequencer(song, (ch, wave, freq, vol) => audio.voice(ch, wave, freq, vol));
  let sel = 0, cursor = 0, mode = '', clip = null;       // cursor = 選んでいる小節の先頭ステップ
  let dirty = false, saveTimer = 0, ticker = 0, blipTimer = 0, shown = -1;
  const undo = [];
  const roll = $('roll'), rg = roll.getContext('2d'), lg = $('labels').getContext('2d'), og = $('overview').getContext('2d');
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const steps = () => S.steps(song);
  const overviewStep = () => clamp(Math.floor(960 / steps()), 3, 12);

  // ---- 保存と元に戻す --------------------------------------------------
  function save() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORE, JSON.stringify(S.encode(song)));
      $('saved').textContent = '自動保存済み';
    } catch (e) { $('saved').textContent = '自動保存できません'; }
  }
  function touch() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
    $('saved').textContent = '';
  }
  function pushUndo() { // 選んでいるトラックをまるごと覚える
    const t = song.tracks[sel];
    undo.push({ t: sel, pitch: t.pitch.slice(), vol: t.vol.slice() });
    if (undo.length > 100) undo.shift();
  }
  function popUndo() {
    const u = undo.pop();
    if (!u) return;
    const t = song.tracks[u.t];
    t.pitch.set(u.pitch);
    t.vol.set(u.vol);
    sel = u.t;
    changed();
  }

  // ---- 描画 ------------------------------------------------------------
  function invalidate() {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(draw);
  }
  function shade(g, color, alpha) { g.globalAlpha = alpha; g.fillStyle = color; }
  function drawLabels() {
    lg.fillStyle = '#1e2038';
    lg.fillRect(0, 0, 30, ROLL_H);
    lg.font = '8px ui-monospace, Menlo, monospace';
    for (let r = 0; r < PITCHES; r++) {
      const p = PITCHES - 1 - r, name = S.pitchName(p);
      if (name.includes('#')) continue;
      lg.fillStyle = p % 12 ? '#8d91b3' : '#dcdef0';
      lg.fillText(name, 4, TOP + r * RH + RH - 2);
    }
    lg.fillStyle = '#8d91b3';
    lg.fillText('VOL', 4, VOL_Y + 12);
  }
  function drawRoll(playhead) {
    const g = rg, n = steps(), w = n * CW, track = song.tracks[sel];
    g.globalAlpha = 1;
    g.fillStyle = '#1e2038';
    g.fillRect(0, 0, w, ROLL_H);
    for (let r = 0; r < PITCHES; r++) {
      g.fillStyle = S.pitchName(PITCHES - 1 - r).includes('#') ? '#181a30' : '#272a48';
      g.fillRect(0, TOP + r * RH, w, RH - 1);
    }
    g.fillStyle = '#272a48';
    g.fillRect(0, VOL_Y, w, VOL_H);
    // 小節番号と区切り（ステップ・拍・小節の順に太く）
    g.font = '9px ui-monospace, Menlo, monospace';
    for (let i = 0; i < n; i++) {
      const x = i * CW;
      if (i % STEPS_PER_BAR === 0) {
        g.fillStyle = i === cursor ? '#f7c873' : '#343861';
        g.fillRect(x, 0, STEPS_PER_BAR * CW - 1, TOP - 2);
        g.fillStyle = i === cursor ? '#2a1c05' : '#dcdef0';
        g.fillText(String(i / STEPS_PER_BAR + 1), x + 4, TOP - 5);
      }
      if (!i) continue;
      g.fillStyle = i % STEPS_PER_BAR ? '#1e2038' : '#8d91b3';
      g.fillRect(x - 1, TOP, i % 4 ? 1 : 2, ROLL_H - TOP);
    }
    if (playhead >= 0) {
      g.fillStyle = 'rgba(255,255,255,.14)';
      g.fillRect(playhead * CW, TOP, CW, ROLL_H - TOP);
    }
    // ほかのトラックの音は細く薄く重ねる
    for (let t = 0; t < TRACKS; t++) {
      if (t === sel) continue;
      const o = song.tracks[t];
      shade(g, COLORS[t], 0.4);
      for (let i = 0; i < n; i++) if (o.vol[i]) g.fillRect(i * CW + 3, TOP + (PITCHES - 1 - o.pitch[i]) * RH + 3, CW - 7, 2);
    }
    for (let i = 0; i < n; i++) {
      const v = track.vol[i];
      if (!v) continue;
      shade(g, COLORS[sel], LEVEL[v]);
      g.fillRect(i * CW + 1, TOP + (PITCHES - 1 - track.pitch[i]) * RH, CW - 3, RH - 1);
      g.fillRect(i * CW + 1, VOL_Y + VOL_H - v * 12, CW - 3, v * 12);
    }
    g.globalAlpha = 1;
  }
  function drawOverview(playhead) {
    const g = og, n = steps(), sw = overviewStep(), w = n * sw;
    g.globalAlpha = 1;
    g.fillStyle = '#1e2038';
    g.fillRect(0, 0, w, TRACKS * LANE);
    g.fillStyle = '#272a48';
    g.fillRect(0, sel * LANE, w, LANE);
    for (let t = 0; t < TRACKS; t++) {
      const o = song.tracks[t];
      shade(g, COLORS[t], S.audible(song, t) ? 1 : 0.3);
      for (let i = 0; i < n; i++) if (o.vol[i]) g.fillRect(i * sw, t * LANE + 3, sw - 1, LANE - 6);
    }
    g.globalAlpha = 1;
    g.fillStyle = '#8d91b3';
    for (let i = STEPS_PER_BAR; i < n; i += STEPS_PER_BAR) g.fillRect(i * sw - 1, 0, 1, TRACKS * LANE);
    g.fillStyle = '#f7c873';
    g.fillRect(cursor * sw, 0, 2, TRACKS * LANE);
    if (playhead >= 0) { g.fillStyle = '#ffffff'; g.fillRect(playhead * sw, 0, 2, TRACKS * LANE); }
  }
  function draw() {
    dirty = false;
    const playhead = seq.state.playing ? seq.state.step : -1;
    drawRoll(playhead);
    drawOverview(playhead);
    $('position').textContent = playhead < 0 ? '' :
      '小節 ' + (Math.floor(playhead / STEPS_PER_BAR) + 1) + ' / ステップ ' + (playhead % STEPS_PER_BAR + 1);
  }
  function resize() { // 曲の長さに合わせてキャンバスを作り直す
    roll.width = steps() * CW;
    roll.height = ROLL_H;
    $('overview').width = steps() * overviewStep();
    $('overview').height = TRACKS * LANE;
    cursor = clamp(cursor, 0, steps() - STEPS_PER_BAR);
    invalidate();
  }
  function refresh() {
    $('bpm').value = Math.round(song.bpm * 10) / 10;
    $('bars').value = song.bars;
    document.querySelectorAll('#tabs button').forEach((tab, t) => {
      tab.classList.toggle('on', t === sel);
      tab.classList.toggle('quiet', !S.audible(song, t));
      tab.setAttribute('aria-selected', t === sel);
    });
    const track = song.tracks[sel];
    $('mute').classList.toggle('on', track.mute);
    $('solo').classList.toggle('on', track.solo);
    invalidate();
  }
  function changed() { refresh(); touch(); }
  function select(t) { sel = t; refresh(); }

  // ---- 再生 ------------------------------------------------------------
  function stop() {
    clearInterval(ticker);
    ticker = 0;
    seq.stop();
    $('play').textContent = '▶ 再生';
    invalidate();
  }
  function follow() { // 再生位置が見えるところまで横に送る
    const box = $('roll-scroll'), x = seq.state.step * CW;
    if (x < box.scrollLeft || x + CW > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, x - 44);
  }
  function play() {
    stop();
    audio.resume();
    seq.state.loop = $('loop').checked;
    seq.play(cursor);
    $('play').textContent = '■ 停止';
    shown = -1;
    const frame = () => {
      seq.tick();
      if (!seq.state.playing) { stop(); return; }
      if (seq.state.step !== shown) { shown = seq.state.step; follow(); invalidate(); }
    };
    frame();
    ticker = setInterval(frame, 1000 / S.FPS);
  }
  function toggle() { if (ticker) stop(); else play(); }
  function blip(track, i) { // 置いた音を短く鳴らす（再生中は曲にまかせる）
    if (ticker) return;
    audio.resume();
    audio.silence();
    audio.voice(sel, track.wave, S.pitchFreq(track.pitch[i]), track.vol[i] / 3);
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => { if (!ticker) audio.silence(); }, 140);
  }

  // ---- ピアノロールの操作 ----------------------------------------------
  function cell(e) {
    const r = roll.getBoundingClientRect(), y = e.clientY - r.top;
    return {
      x: clamp(Math.floor((e.clientX - r.left) / CW), 0, steps() - 1),
      p: PITCHES - 1 - clamp(Math.floor((y - TOP) / RH), 0, PITCHES - 1),
      head: y < TOP,
      level: y >= VOL_Y - 4 ? clamp(3 - Math.floor((y - VOL_Y) / (VOL_H / 4)), 0, 3) : -1,
    };
  }
  function apply(q) {
    const t = song.tracks[sel], i = q.x;
    if (mode === 'vol') { if (q.level < 0 || t.vol[i] === q.level) return; t.vol[i] = q.level; }
    else if (mode === 'erase') { if (!t.vol[i] || t.pitch[i] !== q.p) return; t.vol[i] = 0; }
    else { if (q.level >= 0 || q.head || (t.vol[i] && t.pitch[i] === q.p)) return; t.pitch[i] = q.p; t.vol[i] = t.vol[i] || 3; }
    if (t.vol[i]) blip(t, i);
    changed();
  }
  function setCursor(step) {
    cursor = clamp(Math.floor(step / STEPS_PER_BAR) * STEPS_PER_BAR, 0, steps() - STEPS_PER_BAR);
    invalidate();
  }
  roll.addEventListener('pointerdown', e => {
    e.preventDefault();
    const q = cell(e), t = song.tracks[sel];
    if (q.head) { setCursor(q.x); return; }
    roll.setPointerCapture(e.pointerId);
    mode = q.level >= 0 ? 'vol' : (t.vol[q.x] && t.pitch[q.x] === q.p ? 'erase' : 'paint');
    pushUndo();
    apply(q);
  });
  roll.addEventListener('pointermove', e => { if (mode) apply(cell(e)); });
  for (const type of ['pointerup', 'pointercancel']) roll.addEventListener(type, () => { mode = ''; });
  roll.addEventListener('contextmenu', e => e.preventDefault());

  $('overview').addEventListener('pointerdown', e => { // 押した場所のトラックと小節へ移る
    const r = $('overview').getBoundingClientRect();
    const step = clamp(Math.floor((e.clientX - r.left) / r.width * steps()), 0, steps() - 1);
    setCursor(step);
    $('roll-scroll').scrollLeft = cursor * CW;
    select(clamp(Math.floor((e.clientY - r.top) / r.height * TRACKS), 0, TRACKS - 1));
  });

  // ---- トラックのタブと、選んだトラックの操作 --------------------------
  for (let t = 0; t < TRACKS; t++) {
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.textContent = S.WAVES[t]; // 波形はトラックごとに決まっているので、それをそのまま名前にする
    tab.addEventListener('click', () => select(t));
    $('tabs').appendChild(tab);
  }
  for (const key of ['mute', 'solo']) {
    $(key).addEventListener('click', () => {
      song.tracks[sel][key] = !song.tracks[sel][key];
      seq.state.fresh = true; // いま鳴っているステップからすぐ反映する
      changed();
    });
  }
  $('copy-bar').addEventListener('click', () => {
    const t = song.tracks[sel];
    clip = { pitch: t.pitch.slice(cursor, cursor + STEPS_PER_BAR), vol: t.vol.slice(cursor, cursor + STEPS_PER_BAR) };
  });
  $('paste-bar').addEventListener('click', () => {
    if (!clip) return;
    pushUndo();
    song.tracks[sel].pitch.set(clip.pitch, cursor);
    song.tracks[sel].vol.set(clip.vol, cursor);
    changed();
  });
  $('clear-bar').addEventListener('click', () => { pushUndo(); song.tracks[sel].vol.fill(0, cursor, cursor + STEPS_PER_BAR); changed(); });
  $('clear-track').addEventListener('click', () => { pushUndo(); song.tracks[sel].vol.fill(0); changed(); });

  // ---- 再生まわりの欄 --------------------------------------------------
  $('play').addEventListener('click', toggle);
  $('bpm').addEventListener('change', e => { song.bpm = S.clampBpm(e.target.value); changed(); });
  $('bars').addEventListener('change', e => { song.bars = S.clampBars(e.target.value); resize(); changed(); });
  $('loop').addEventListener('change', e => { seq.state.loop = e.target.checked; });

  // ---- ダイアログと出し入れ --------------------------------------------
  // ボタンの fn が false を返すと開いたままにする。opts.area を渡すと文字の欄を出す
  function ask(text, buttons, opts) {
    opts = opts || {};
    const area = $('modal-area'), box = $('modal-buttons');
    $('modal-text').textContent = text;
    $('modal-text').classList.remove('err');
    area.hidden = opts.area == null;
    area.value = opts.area || '';
    area.readOnly = !!opts.readonly;
    box.textContent = '';
    buttons.forEach((def, i) => {
      const b = document.createElement('button');
      b.textContent = def.label;
      if (i === 0) b.className = 'primary';
      b.addEventListener('click', () => { if (!def.fn || def.fn() !== false) $('modal').hidden = true; });
      box.appendChild(b);
    });
    $('modal').hidden = false;
    (area.hidden ? box.firstChild : area).focus();
    if (opts.readonly) area.select();
  }
  function modalError(text) {
    $('modal-text').textContent = text;
    $('modal-text').classList.add('err');
    return false;
  }
  function setSong(next) {
    stop();
    song.bpm = next.bpm;
    song.bars = next.bars;
    next.tracks.forEach((t, i) => {
      const track = song.tracks[i];
      track.mute = t.mute; track.solo = false;
      track.pitch.set(t.pitch);
      track.vol.set(t.vol);
    });
    undo.length = 0;
    sel = Math.max(0, next.tracks.findIndex(t => !S.isEmpty(t))); // 音の入っている最初のトラックを開く
    cursor = 0;
    $('roll-scroll').scrollLeft = 0;
    resize();
    refresh();
    save();
  }
  function load(text) {
    try { setSong(S.decode(text)); } catch (e) { return modalError('読み込めませんでした: ' + e.message); }
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const CANCEL = { label: 'やめる' };
  $('demo').addEventListener('click', () => {
    ask('いまの曲を、見本の曲に置き換えます。', [{ label: '見本を開く', fn: () => setSong(demo()) }, CANCEL]);
  });
  $('new').addEventListener('click', () => {
    ask('いまの曲をすべて消して、空の曲にします。', [{ label: '消して新規にする', fn: () => setSong(S.newSong()) }, CANCEL]);
  });
  $('export').addEventListener('click', () => {
    const text = JSON.stringify(S.encode(song));
    const failed = () => modalError('コピーできませんでした。欄の文字を選んでコピーしてください。');
    ask('曲のデータ（song.chip.json）。「読み込み」で開けます。', [
      { label: 'ファイルに保存', fn: () => download('song.chip.json', text) },
      {
        label: 'コピー',
        fn() {
          $('modal-area').focus();
          $('modal-area').select();
          try { navigator.clipboard.writeText(text).then(() => { $('modal-text').textContent = 'コピーしました。'; }, failed); } catch (e) { failed(); }
          return false;
        },
      },
      { label: '閉じる' },
    ], { area: text, readonly: true });
  });
  $('import').addEventListener('click', () => {
    ask('保存した曲のデータ（.chip.json）の中身を貼りつけるか、ファイルを選んでください。いまの曲は置き換えられます。', [
      { label: '読み込む', fn: () => load($('modal-area').value) },
      { label: 'ファイルを選ぶ', fn: () => { $('file').click(); return false; } },
      CANCEL,
    ], { area: '' });
  });
  $('file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f && load(await f.text()) !== false) $('modal').hidden = true;
  });

  root.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'checkbox';
    if (!$('modal').hidden) { if (e.key === 'Escape') $('modal').hidden = true; return; }
    if (typing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); popUndo(); }
    else if (e.metaKey || e.ctrlKey || e.altKey) return;
    else if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.key >= '1' && e.key <= String(TRACKS)) select(+e.key - 1);
  });
  root.addEventListener('beforeunload', save);

  // ---- 起動 ------------------------------------------------------------
  // 見本の曲。DOT JUMP の BGM（1 小節のフレーズ）を元に、4 小節に広げてベースとドラムを足したもの
  function demo() {
    const d = S.newSong(), bar = STEPS_PER_BAR;
    const write = (t, ...bars) => bars.forEach((notes, i) => S.parseNotes(d.tracks[t], notes, i * bar));
    d.bpm = 90;
    d.bars = 4;

    // 矩形波 50% = フレーズ: 1 小節目が元の BGM そのまま（C → Am）。2・4 小節目は同じ形で F → G に動かす
    const phrase = 'C4:2 - G4:2 - E4:2 - G4:2 - A3:2 - E4:2 - C4:2 - E4:2 -';
    write(0, phrase,
      'F3:2 - C4:2 - A3:2 - C4:2 - G3:2 - D4:2 - B3:2 - D4:2 -',
      phrase,
      'F3:2 - C4:2 - A3:2 - C4:2 - G3:2 - B3:2 - D4:2 - G4:2 -');

    // 三角波 = ベース: 和音の根音を 3 + 3 + 2 のリズムで
    const bass = 'C3 - - C3 - - G3 - A3 - - A3 - - E3 -';
    write(2, bass,
      'F3 - - F3 - - C3 - G3 - - G3 - - D3 -',
      bass,
      'F3 - - F3 - - C3 - G3 - - G3 - G3 B3 D4');

    // ノイズ = ドラム: 低い音 = キック、中くらい = スネア、高くて小さい音 = ハイハット
    const beat = 'C3:3 - B6:1 - C5:3 - B6:1 - C3:3 - C3:2 - C5:3 - B6:1 B6:1';
    write(3, beat, beat, beat,
      'C3:3 - B6:1 - C5:3 - B6:1 - C3:3 - C5:2 C5:2 C5:3 C5:3 C4:3 C4:3');
    return d;
  }
  let saved = null;
  try { const text = localStorage.getItem(STORE); if (text) saved = S.decode(text); } catch (e) { /* 壊れていたら見本から */ }
  drawLabels();
  setSong(saved || demo());
})(typeof globalThis !== 'undefined' ? globalThis : this);
