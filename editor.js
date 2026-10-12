/* editor.js — 画面。「小節を編集」と「小節を並べる」の 2 つのモードで曲を作り、その場で鳴らす。
   song は再生側と共有しているので、差し替えずに中身を書き換える。 */
(function (root) {
  'use strict';
  const S = root.ChipSound;
  const { TRACKS, STEPS, PATTERNS, PITCHES } = S;
  const $ = id => document.getElementById(id);

  // 以前の版の自動保存（v3 = 小節がトラックごとに別、v2 = 小節に分かれる前）も、読めばいまの形に直る
  const STORE = 'chip-sound-editor-v4', OLD_STORES = ['chip-sound-editor-v3', 'chip-sound-editor-v2'];
  // ピアノロールの寸法: 上から 拍の番号 / 音程のマス目 / 音量の帯
  const CW = 40, RH = 9, TOP = 14, GRID_H = PITCHES * RH, VOL_Y = TOP + GRID_H + 8, VOL_H = 40, ROLL_W = STEPS * CW, ROLL_H = VOL_Y + VOL_H;
  const COLORS = ['#f2796a', '#f7c873', '#62c0a8', '#9db8e8'];
  const LEVEL = [0, 0.45, 0.72, 1];                      // 音量 → 濃さ

  const song = S.newSong();
  const audio = root.ChipAudio.create();
  const seq = S.createSequencer(song, (ch, wave, freq, vol) => audio.voice(ch, wave, freq, vol));
  let mode = 'edit';
  let sel = 0;                                           // 編集モードで選んでいるトラック（＝試聴する波形）
  let pat = 1;                                           // 編集モードで開いている小節の番号。小節はどのトラックからでも使える
  const at = { t: 0, pos: 0 };                           // 並べるモードで選んでいるマス
  let stroke = '', clip = null, dirty = false, saveTimer = 0, ticker = 0, blipTimer = 0, shown = '';
  let alone = false;                                     // 「この小節だけ」で再生しているか
  const undo = [];
  const roll = $('roll'), rg = roll.getContext('2d'), lg = $('labels').getContext('2d');
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const length = () => S.clampLength(song.length);
  const pattern = () => song.patterns[pat - 1];
  const uses = (t, k) => { for (let pos = 0; pos < length(); pos++) if (song.tracks[t].order[pos] === k) return true; return false; };

  /* 開いている小節を、選んでいるトラックが曲のどの位置で使っているか。
     並べるモードで選んでいる位置を優先する。使っていなければ -1 */
  function context() {
    const order = song.tracks[sel].order;
    if (at.t === sel && at.pos < length() && order[at.pos] === pat) return at.pos;
    for (let pos = 0; pos < length(); pos++) if (order[pos] === pat) return pos;
    return -1;
  }

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
  function pushPattern() { // 開いている小節を覚える
    const p = pattern();
    undo.push({ t: sel, k: pat, pitch: p.pitch.slice(), vol: p.vol.slice() });
    if (undo.length > 100) undo.shift();
  }
  function pushOrder(t) { // トラック t の並びを覚える
    undo.push({ t, order: song.tracks[t].order.slice(), pos: at.pos });
    if (undo.length > 100) undo.shift();
  }
  function popUndo() {
    const u = undo.pop();
    if (!u) return;
    if (u.order) {
      song.tracks[u.t].order.set(u.order);
      at.t = u.t; at.pos = u.pos;
      setMode('arrange');
    } else {
      const p = song.patterns[u.k - 1];
      p.pitch.set(u.pitch);
      p.vol.set(u.vol);
      sel = u.t; pat = u.k;
      setMode('edit');
    }
    changed();
  }

  // ---- ピアノロールの描画 ----------------------------------------------
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
  function drawRoll() {
    const g = rg, p = pattern(), ctx = context();
    const playhead = seq.state.playing && seq.state.audition ? seq.state.step : -1;
    g.globalAlpha = 1;
    g.fillStyle = '#1e2038';
    g.fillRect(0, 0, ROLL_W, ROLL_H);
    for (let r = 0; r < PITCHES; r++) {
      g.fillStyle = S.pitchName(PITCHES - 1 - r).includes('#') ? '#181a30' : '#272a48';
      g.fillRect(0, TOP + r * RH, ROLL_W, RH - 1);
    }
    g.fillStyle = '#272a48';
    g.fillRect(0, VOL_Y, ROLL_W, VOL_H);
    // 拍の番号と区切り（拍の頭を太く）
    g.font = '9px ui-monospace, Menlo, monospace';
    for (let i = 0; i < STEPS; i++) {
      const x = i * CW;
      if (i % 4 === 0) {
        g.fillStyle = '#343861';
        g.fillRect(x, 0, 4 * CW - 1, TOP - 2);
        g.fillStyle = '#dcdef0';
        g.fillText(String(i / 4 + 1), x + 4, TOP - 5);
      }
      if (!i) continue;
      g.fillStyle = i % 4 ? '#1e2038' : '#8d91b3';
      g.fillRect(x - 1, TOP, 1, ROLL_H - TOP);
    }
    if (playhead >= 0) {
      g.fillStyle = 'rgba(255,255,255,.14)';
      g.fillRect(playhead * CW, TOP, CW, ROLL_H - TOP);
    }
    // 曲の同じ位置で鳴るほかのトラックを、細く薄く重ねる
    for (let t = 0; t < TRACKS && ctx >= 0; t++) {
      const o = t === sel ? null : S.patternAt(song, t, ctx);
      if (!o) continue;
      shade(g, COLORS[t], 0.45);
      for (let i = 0; i < STEPS; i++) if (o.vol[i]) g.fillRect(i * CW + 5, TOP + (PITCHES - 1 - o.pitch[i]) * RH + 3, CW - 11, 2);
    }
    for (let i = 0; i < STEPS; i++) {
      const v = p.vol[i];
      if (!v) continue;
      shade(g, COLORS[sel], LEVEL[v]);
      g.fillRect(i * CW + 1, TOP + (PITCHES - 1 - p.pitch[i]) * RH, CW - 3, RH - 1);
      g.fillRect(i * CW + 1, VOL_Y + VOL_H - v * 12, CW - 3, v * 12);
    }
    g.globalAlpha = 1;
  }
  function draw() {
    dirty = false;
    const st = seq.state;
    if (mode === 'edit') drawRoll();
    else { // いま鳴っている位置の列を目立たせる
      const now = st.playing && !st.audition ? st.pos : -1;
      document.querySelectorAll('#grid [data-pos]').forEach(el => el.classList.toggle('now', +el.dataset.pos === now));
    }
    $('position').textContent = !st.playing ? '' :
      (st.audition ? '' : (st.pos + 1) + ' 小節目 / ') + 'ステップ ' + (st.step + 1);
  }

  // ---- 画面の更新 ------------------------------------------------------
  // 小節の番号ボタン（box の中）に、選んでいる番号と中身のある番号の印をつける
  function markNumbers(box, current) {
    box.querySelectorAll('button').forEach(b => {
      const k = +b.dataset.k;
      b.classList.toggle('on', k === current);
      b.classList.toggle('used', k > 0 && !S.isEmpty(song.patterns[k - 1]));
    });
  }
  function refreshEdit() {
    document.querySelectorAll('#tabs button').forEach((tab, t) => {
      tab.classList.toggle('on', t === sel);
      tab.classList.toggle('quiet', !S.audible(song, t));
      tab.setAttribute('aria-selected', t === sel);
    });
    markNumbers($('pattern-buttons'), pat);
    $('mute').classList.toggle('on', song.tracks[sel].mute);
    $('solo').classList.toggle('on', song.tracks[sel].solo);
    const used = []; // どのトラックの何小節目で使っているか
    for (let t = 0; t < TRACKS; t++) {
      const where = [];
      for (let pos = 0; pos < length(); pos++) if (song.tracks[t].order[pos] === pat) where.push(pos + 1);
      if (where.length) used.push(S.WAVES[t] + ' の ' + where.join('・') + ' 小節目');
    }
    $('usage').textContent = used.length ? '使用: ' + used.join(' / ') : 'まだ曲に置いていない';
  }
  function buildGrid() { // 曲の長さが変わったときだけ作り直す
    const n = length(), head = document.createElement('tr'), table = $('grid');
    table.textContent = '';
    head.appendChild(document.createElement('th'));
    for (let pos = 0; pos < n; pos++) {
      const th = document.createElement('th'), b = document.createElement('button');
      th.dataset.pos = pos;
      b.textContent = pos + 1;
      b.setAttribute('aria-label', (pos + 1) + ' 小節目を選ぶ');
      b.addEventListener('click', () => { at.pos = pos; refresh(); });
      th.appendChild(b);
      head.appendChild(th);
    }
    table.createTHead().appendChild(head);
    const body = table.createTBody();
    for (let t = 0; t < TRACKS; t++) {
      const tr = body.insertRow(), th = document.createElement('th'), name = document.createElement('span');
      name.className = 'name';
      name.textContent = S.WAVES[t];
      th.appendChild(name);
      for (const [key, label, title] of [['mute', 'M', 'ミュート'], ['solo', 'S', 'ソロ']]) {
        const b = document.createElement('button');
        b.className = 'flag ' + key;
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', S.WAVES[t] + ' を' + title);
        b.addEventListener('click', () => flag(t, key));
        th.appendChild(b);
      }
      tr.appendChild(th);
      for (let pos = 0; pos < n; pos++) {
        const td = tr.insertCell(), b = document.createElement('button');
        td.dataset.pos = pos;
        b.style.setProperty('--ink', COLORS[t]);
        b.addEventListener('click', () => { at.t = t; at.pos = pos; refresh(); });
        b.addEventListener('dblclick', () => openPattern(t, song.tracks[t].order[pos]));
        td.appendChild(b);
      }
    }
  }
  function refreshArrange() {
    const n = length(), table = $('grid');
    if (table.rows.length !== TRACKS + 1 || table.rows[0].cells.length !== n + 1) buildGrid();
    at.pos = clamp(at.pos, 0, n - 1);
    $('length').value = n;
    for (let pos = 0; pos < n; pos++) table.rows[0].cells[pos + 1].classList.toggle('at', pos === at.pos);
    for (let t = 0; t < TRACKS; t++) {
      const row = table.rows[t + 1], track = song.tracks[t];
      row.cells[0].classList.toggle('quiet', !S.audible(song, t));
      row.querySelector('.mute').classList.toggle('on', track.mute);
      row.querySelector('.solo').classList.toggle('on', track.solo);
      for (let pos = 0; pos < n; pos++) {
        const b = row.cells[pos + 1].firstChild, k = track.order[pos];
        b.textContent = k || '';
        b.classList.toggle('sel', t === at.t && pos === at.pos);
        b.setAttribute('aria-label', S.WAVES[t] + ' ' + (pos + 1) + ' 小節目: ' + (k ? '小節 ' + k : '休み'));
      }
    }
    const k = song.tracks[at.t].order[at.pos];
    $('place-label').textContent = S.WAVES[at.t] + ' の ' + (at.pos + 1) + ' 小節目に置く';
    markNumbers($('place-buttons'), k);
    $('edit-this').disabled = !k;
  }
  function refresh() {
    $('bpm').value = Math.round(song.bpm * 10) / 10;
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    $('panel-edit').hidden = mode !== 'edit';
    $('panel-arrange').hidden = mode !== 'arrange';
    if (mode === 'edit') refreshEdit(); else refreshArrange();
    invalidate();
  }
  function changed() { refresh(); touch(); }
  function setMode(next) {
    if (next === mode) return;
    stop();
    mode = next;
    refresh();
  }
  function restart() { if (ticker) play(alone); } // 試聴の対象が変わったら、同じ鳴らしかたで鳴らしなおす
  function select(t) { sel = t; refresh(); restart(); }
  function openPattern(t, k) { // 並べるモードから、その小節の編集へ
    if (!k) return;
    sel = t; pat = k;
    setMode('edit');
    refresh();
  }
  function flag(t, key) {
    song.tracks[t][key] = !song.tracks[t][key];
    seq.state.fresh = true; // いま鳴っているステップからすぐ反映する
    changed();
  }

  // ---- 再生 ------------------------------------------------------------
  function stop() {
    clearInterval(ticker);
    ticker = 0;
    seq.stop();
    $('play').textContent = '▶ 再生';
    $('play-alone').textContent = '▶ この小節だけ';
    invalidate();
  }
  // いったん止めてから begin() で鳴らすものを決め、毎秒 60 回進めはじめる。button は「停止」に変えるボタン
  function start(button, begin) {
    stop();
    audio.resume();
    begin();
    $(button).textContent = '■ 停止';
    shown = '';
    const frame = () => {
      seq.tick();
      if (!seq.state.playing) { stop(); return; }
      const key = seq.state.pos + ':' + seq.state.step;
      if (key === shown) return;
      shown = key;
      if (mode === 'arrange' && !seq.state.audition && seq.state.step === 0) { // いまの位置が見えるところまで横に送る
        const cell = $('grid').rows[0].cells[seq.state.pos + 1];
        if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      invalidate();
    };
    frame();
    ticker = setInterval(frame, 1000 / S.FPS);
  }
  /* only を渡すと、開いている小節だけを、ほかのトラックなしで鳴らす */
  function play(only) {
    alone = !!only && mode === 'edit';
    start(alone ? 'play-alone' : 'play', () => {
      seq.state.loop = $('loop').checked;
      // 編集モードは開いている小節を繰り返す（曲の同じ位置のトラックも重ねる）。並べるモードは選んでいる位置から曲を流す
      if (mode === 'edit') { seq.audition(sel, pat, alone ? -1 : context()); seq.state.loop = true; } else seq.play(at.pos);
    });
  }
  /* 小節 k を、トラック t の波形で 1 回だけ鳴らす（並べるモードで、置く小節を耳で確かめる用） */
  function preview(t, k) {
    alone = false;
    start('play', () => { seq.audition(t, k); seq.state.loop = false; });
  }
  function toggle(only) { if (ticker && alone === !!only) stop(); else play(only); } // 鳴らしかたが違えば、止めずに切り替える
  function blip(p, i) { // 置いた音を短く鳴らす（再生中は曲にまかせる）
    if (ticker) return;
    audio.resume();
    audio.silence();
    audio.voice(sel, song.tracks[sel].wave, S.pitchFreq(p.pitch[i]), p.vol[i] / 3);
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => { if (!ticker) audio.silence(); }, 140);
  }

  // ---- 小節を編集 ------------------------------------------------------
  function cell(e) {
    const r = roll.getBoundingClientRect(), y = e.clientY - r.top;
    return {
      x: clamp(Math.floor((e.clientX - r.left) / CW), 0, STEPS - 1),
      p: PITCHES - 1 - clamp(Math.floor((y - TOP) / RH), 0, PITCHES - 1),
      head: y < TOP,
      level: y >= VOL_Y - 4 ? clamp(3 - Math.floor((y - VOL_Y) / (VOL_H / 4)), 0, 3) : -1,
    };
  }
  function apply(q) {
    const p = pattern(), i = q.x;
    if (stroke === 'vol') { if (q.level < 0 || p.vol[i] === q.level) return; p.vol[i] = q.level; }
    else if (stroke === 'erase') { if (!p.vol[i] || p.pitch[i] !== q.p) return; p.vol[i] = 0; }
    else { if (q.level >= 0 || q.head || (p.vol[i] && p.pitch[i] === q.p)) return; p.pitch[i] = q.p; p.vol[i] = p.vol[i] || 3; }
    if (p.vol[i]) blip(p, i);
    changed();
  }
  roll.addEventListener('pointerdown', e => {
    e.preventDefault();
    const q = cell(e), p = pattern();
    if (q.head) return;
    roll.setPointerCapture(e.pointerId);
    stroke = q.level >= 0 ? 'vol' : (p.vol[q.x] && p.pitch[q.x] === q.p ? 'erase' : 'paint');
    pushPattern();
    apply(q);
  });
  roll.addEventListener('pointermove', e => { if (stroke) apply(cell(e)); });
  for (const type of ['pointerup', 'pointercancel']) roll.addEventListener(type, () => { stroke = ''; });
  roll.addEventListener('contextmenu', e => e.preventDefault());

  for (let t = 0; t < TRACKS; t++) {
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.textContent = S.WAVES[t]; // 波形はトラックごとに決まっているので、それをそのまま名前にする
    tab.addEventListener('click', () => select(t));
    $('tabs').appendChild(tab);
  }
  function numberButtons(box, withRest, onPick) {
    for (let k = withRest ? 0 : 1; k <= PATTERNS; k++) {
      const b = document.createElement('button');
      b.dataset.k = k;
      b.textContent = k || '休み';
      if (!k) b.className = 'rest';
      b.addEventListener('click', () => onPick(k));
      box.appendChild(b);
    }
  }
  numberButtons($('pattern-buttons'), false, k => {
    pat = k;
    // 選んでいるトラックでは使っていない小節なら、使っているトラックのタブに移る（曲の中での鳴り方で確かめられるように）
    if (!uses(sel, k)) { const t = [0, 1, 2, 3].find(o => uses(o, k)); if (t != null) sel = t; }
    refresh();
    restart();
  });
  $('mute').addEventListener('click', () => flag(sel, 'mute'));
  $('solo').addEventListener('click', () => flag(sel, 'solo'));
  $('copy').addEventListener('click', () => { const p = pattern(); clip = { pitch: p.pitch.slice(), vol: p.vol.slice() }; });
  $('paste').addEventListener('click', () => {
    if (!clip) return;
    pushPattern();
    pattern().pitch.set(clip.pitch);
    pattern().vol.set(clip.vol);
    changed();
  });
  $('clear').addEventListener('click', () => { pushPattern(); pattern().vol.fill(0); changed(); });

  // ---- 小節を並べる ----------------------------------------------------
  numberButtons($('place-buttons'), true, k => {
    const flowing = ticker && !seq.state.audition; // 曲を流している最中か
    pushOrder(at.t);
    song.tracks[at.t].order[at.pos] = k;
    if (k) { pat = k; sel = at.t; }
    // 置いた小節を 1 回鳴らす。曲を流しているときは止めずに、そのまま曲にまかせる。休みを置いたら試聴は止める
    if (k && !flowing) preview(at.t, k); else if (!flowing) stop();
    at.pos = Math.min(at.pos + 1, length() - 1); // 続けて置けるように次の位置へ
    changed();
  });
  $('edit-this').addEventListener('click', () => openPattern(at.t, song.tracks[at.t].order[at.pos]));
  $('length').addEventListener('change', e => { song.length = S.clampLength(e.target.value); changed(); });

  // ---- 再生まわりの欄 --------------------------------------------------
  $('modes').addEventListener('click', e => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });
  $('play').addEventListener('click', () => toggle(false));
  $('play-alone').addEventListener('click', () => toggle(true));
  $('bpm').addEventListener('change', e => { song.bpm = S.clampBpm(e.target.value); changed(); });
  $('loop').addEventListener('change', e => { if (!seq.state.audition) seq.state.loop = e.target.checked; });

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
    song.length = next.length;
    next.patterns.forEach((p, k) => { song.patterns[k].pitch.set(p.pitch); song.patterns[k].vol.set(p.vol); });
    next.tracks.forEach((src, t) => {
      const track = song.tracks[t];
      track.mute = src.mute; track.solo = false;
      track.order.set(src.order);
    });
    undo.length = 0;
    // 音の入っている最初のトラックの、最初に鳴る小節を開く
    sel = Math.max(0, song.tracks.findIndex(t => t.order.some(k => k)));
    pat = Array.from(song.tracks[sel].order).find(k => k) || 1;
    at.t = sel; at.pos = 0;
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
    else if (e.code === 'Space') { e.preventDefault(); if (ticker) stop(); else play(e.shiftKey); }
    else if (mode === 'edit' && e.key >= '1' && e.key <= String(TRACKS)) select(+e.key - 1);
  });
  root.addEventListener('beforeunload', save);

  // ---- 起動 ------------------------------------------------------------
  // 見本の曲。DOT JUMP の BGM（1 小節のフレーズ）を元に、小節を足して 4 小節ぶん並べ、ベースとドラムを加えたもの
  function demo() {
    const d = S.newSong();
    d.bpm = 90;
    d.length = 4;
    [
      // 1〜3 = フレーズ: 小節 1 が元の BGM そのまま（C → Am）。2・3 は同じ形で F → G に動かしたもの
      'C4:2 - G4:2 - E4:2 - G4:2 - A3:2 - E4:2 - C4:2 - E4:2 -',
      'F3:2 - C4:2 - A3:2 - C4:2 - G3:2 - D4:2 - B3:2 - D4:2 -',
      'F3:2 - C4:2 - A3:2 - C4:2 - G3:2 - B3:2 - D4:2 - G4:2 -',
      // 4〜6 = ベース: 和音の根音を 3 + 3 + 2 のリズムで
      'C3 - - C3 - - G3 - A3 - - A3 - - E3 -',
      'F3 - - F3 - - C3 - G3 - - G3 - - D3 -',
      'F3 - - F3 - - C3 - G3 - - G3 - G3 B3 D4',
      // 7・8 = ドラム（ノイズで鳴らす）: 低い音 = キック、中くらい = スネア、高くて小さい音 = ハイハット。8 は締めのフィル
      'C3:3 - B6:1 - C5:3 - B6:1 - C3:3 - C3:2 - C5:3 - B6:1 B6:1',
      'C3:3 - B6:1 - C5:3 - B6:1 - C3:3 - C5:2 C5:2 C5:3 C5:3 C4:3 C4:3',
    ].forEach((notes, k) => S.parseNotes(d.patterns[k], notes));
    d.tracks[0].order.set([1, 2, 1, 3]);   // 矩形波 50%
    d.tracks[2].order.set([4, 5, 4, 6]);   // 三角波
    d.tracks[3].order.set([7, 7, 7, 8]);   // ノイズ
    return d;
  }
  let saved = null;
  for (const key of [STORE, ...OLD_STORES]) {
    if (saved) break;
    try { const text = localStorage.getItem(key); if (text) saved = S.decode(text); } catch (e) { /* 壊れていたら見本から */ }
  }
  drawLabels();
  setSong(saved || demo());
})(typeof globalThis !== 'undefined' ? globalThis : this);
