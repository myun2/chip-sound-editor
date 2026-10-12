/* tests/sound.cjs — 画面も音もなしで、データと再生の手順を検査する
   実行: node tests/sound.cjs */
const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, '..', 'sound.js'));
require(path.join(__dirname, '..', 'audio.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}
function setup(bpm, bars, ...notes) {
  const song = S.newSong(), voices = [];
  song.bpm = bpm; song.bars = bars;
  notes.forEach((n, t) => S.parseNotes(song.tracks[t], n));
  return { song, voices, seq: S.createSequencer(song, (...a) => voices.push(a)) };
}
const run = (seq, frames) => { for (let i = 0; i < frames; i++) seq.tick(); };

test('音名と周波数', () => {
  assert.strictEqual(S.pitchName(0), 'C3');
  assert.strictEqual(S.pitchName(13), 'C#4');
  assert.strictEqual(S.pitchName(47), 'B6');
  assert(Math.abs(S.pitchFreq(21) - 440) < 0.01);   // A4
});

test('音符の文字列を、好きな位置から書き込める', () => {
  const t = S.parseNotes(S.newTrack(0), 'C3 c#4:2 - B6:1 x');
  assert.deepStrictEqual([...t.pitch.slice(0, 4)], [0, 13, 0, 47]);
  assert.deepStrictEqual([...t.vol.slice(0, 5)], [3, 2, 0, 1, 0]);
  S.parseNotes(t, 'G4', 16);
  assert.strictEqual(t.vol[16], 3);
  S.parseNotes(t, 'G4 G4', S.MAX_STEPS - 1);          // はみ出したぶんは捨てる
  assert.strictEqual(t.vol[S.MAX_STEPS - 1], 3);
  assert(S.isEmpty(S.newTrack(0)) && !S.isEmpty(t));
});

test('テンポは BPM、1 ステップは 16 分音符', () => {
  assert.strictEqual(S.stepFrames(225), 4);
  assert.strictEqual(S.stepFrames(120), 7.5);
  assert.strictEqual(S.clampBpm(5), 20);
  assert.strictEqual(S.clampBpm(5000), 900);
  assert.strictEqual(S.clampBpm('abc'), S.BPM_DEFAULT);
  assert.strictEqual(S.clampBars(99), 16);
  assert.strictEqual(S.steps({ bars: 3 }), 48);
});

test('保存して読み戻すと同じになる', () => {
  const { song } = setup(137.5, 3, 'C4 E4:2 G4:1', '', 'C3 - - C3');
  S.parseNotes(song.tracks[3], 'B6:1', 255);
  song.tracks[2].mute = true;
  const json = JSON.stringify(S.encode(song));
  assert.deepStrictEqual(S.decode(json), song);
  assert.strictEqual(JSON.stringify(S.encode(S.decode(json))), json);
  assert.strictEqual(S.encode(song).tracks[0].n, '0c3102131');   // 末尾の無音は落とす
  assert.strictEqual(S.encode(song).tracks[1].n, '');
  assert.deepStrictEqual(Object.keys(S.encode(song).tracks[0]), ['m', 'n']);   // 波形は保存しない
  const forced = S.decode({ chip: 2, bpm: 120, bars: 1, tracks: [{ w: 3, m: 0, n: '' }, { w: 0 }, {}, {}] });
  assert.deepStrictEqual(forced.tracks.map(t => t.wave), [0, 1, 2, 3]);         // 以前のデータに波形があっても、トラックの番号で決まる
  assert.throws(() => S.decode('{"tracks":[]}'));
  assert.throws(() => S.decode('{"chip":2}'));
});

test('以前の形式や DOT のカートリッジは、効果音を同じ波形のトラックへ 4 つまで読む', () => {
  const note = '2f3' + '000'.repeat(15);
  const other = '0c2' + '000'.repeat(15);
  // 波形 2 → トラック 3、波形 2 がもう 1 つ → 空いているトラック 1、波形 3 → トラック 4、波形 1 → トラック 2、5 つ目は入らない
  const sfx = [{ i: 0, w: 2, s: 3, n: note }, { i: 2, w: 2, s: 9, n: other }, { i: 5, w: 3, s: 3, n: note }, { i: 7, w: 1, s: 3, n: note }, { i: 9, w: 0, s: 3, n: note }];
  sfx.splice(1, 0, { i: 1, w: 0, s: 3, n: '000'.repeat(16) });   // 空のものは飛ばす
  for (const data of [{ chip: 1, sfx }, { dot: 1, title: 'X', code: '', sfx }]) {
    const song = S.decode(data);
    assert.strictEqual(song.bars, 1);
    assert.strictEqual(song.bpm, 300);                 // 速さ 3 フレーム = 300 BPM
    assert.deepStrictEqual(song.tracks.map(t => t.wave), [0, 1, 2, 3]);
    assert.deepStrictEqual(song.tracks.map(t => t.pitch[0]), [12, 47, 47, 47]);
    assert.deepStrictEqual(song.tracks.map(t => t.vol[0]), [2, 3, 3, 3]);
  }
  assert.strictEqual(S.decode({ chip: 1, sfx: [{ i: 0, w: 0, b: 90, s: 10, n: '2f3' }] }).bpm, 90);
});

test('全トラックが同じステップで同時に鳴る', () => {
  const { seq, voices } = setup(900, 1, 'C3 -', 'E3:2 E3:2', '', 'C5:1');   // 1 ステップ 1 フレーム
  seq.play();
  seq.tick();
  assert.deepStrictEqual(voices.map(v => v[0]), [0, 1, 2, 3]);
  assert(Math.abs(voices[0][2] - 130.81) < 0.01 && voices[0][3] === 1);
  assert(Math.abs(voices[1][2] - 164.81) < 0.01 && Math.abs(voices[1][3] - 2 / 3) < 1e-9);
  assert.deepStrictEqual(voices[2].slice(2), [0, 0]);              // 何も置いていないトラックは無音
  assert.strictEqual(voices[3][1], 3);                             // 波形はトラックごと
  voices.length = 0;
  seq.tick();
  assert.deepStrictEqual(voices.map(v => v[3] > 0), [false, true, false, false]);
});

test('ループは曲の長さで頭に戻り、ループなしは最後で止まる', () => {
  const { seq, song, voices } = setup(900, 2, 'C3');
  seq.play();
  run(seq, 32);
  assert.strictEqual(seq.state.step, 0);
  assert(seq.state.playing);
  seq.state.loop = false;
  run(seq, 31);
  assert(seq.state.playing);
  seq.tick();
  assert(!seq.state.playing);
  assert.deepStrictEqual(voices.slice(-4), [[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0], [3, 0, 0, 0]]);
  seq.play(20);                                        // 途中から
  assert.strictEqual(seq.state.step, 20);
  song.bars = 1;                                       // 再生中に短くしても落ちない
  seq.tick();
  assert.strictEqual(seq.state.step, 1);
});

test('端数のあるテンポでも、平均すると正しい速さで進む', () => {
  const { seq, voices } = setup(120, 1, 'C3');         // 1 ステップ 7.5 フレーム
  seq.play();
  const at = [];
  for (let f = 0; f < 120; f++) { const n = voices.length; seq.tick(); if (voices.length > n) at.push(f); }
  assert.deepStrictEqual(at.slice(0, 5), [0, 8, 15, 23, 30]);   // 8, 7, 8, 7 フレームと交互
  assert.strictEqual(at.length, 16);                            // 120 フレーム = 2 秒 = 1 小節
});

test('ミュートとソロ', () => {
  const { seq, song, voices } = setup(900, 1, 'C3', 'C3', 'C3', 'C3');
  const heard = () => { voices.length = 0; seq.play(); seq.tick(); return voices.map(v => v[3] > 0 ? 1 : 0).join(''); };
  assert.strictEqual(heard(), '1111');
  song.tracks[1].mute = true;
  assert.strictEqual(heard(), '1011');
  song.tracks[2].solo = true;
  assert.strictEqual(heard(), '0010');
  song.tracks[1].solo = true;                          // ミュートはソロより強い
  assert.strictEqual(heard(), '0010');
  assert(!('solo' in S.encode(song).tracks[2]));
});

console.log(passed + ' passed');
