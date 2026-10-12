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
/* patterns: 小節の音符を番号順に。orders: トラックごとの並び */
function setup(bpm, length, patterns, ...orders) {
  const song = S.newSong(), voices = [];
  song.bpm = bpm; song.length = length;
  patterns.forEach((notes, k) => S.parseNotes(song.patterns[k], notes));
  orders.forEach((o, t) => (o || []).forEach((k, pos) => { song.tracks[t].order[pos] = k; }));
  return { song, voices, seq: S.createSequencer(song, (...a) => voices.push(a)) };
}
const run = (seq, frames) => { for (let i = 0; i < frames; i++) seq.tick(); };
// 1 フレームぶん進めて、各トラックが鳴ったか（1 / 0）を並べる
function heard(seq, voices) { voices.length = 0; seq.tick(); return [0, 1, 2, 3].map(t => { const v = voices.find(a => a[0] === t); return v && v[3] > 0 ? 1 : 0; }).join(''); }
const FAST = 900; // 1 ステップ 1 フレーム、1 小節 16 フレーム

test('音名と周波数', () => {
  assert.strictEqual(S.pitchName(0), 'C3');
  assert.strictEqual(S.pitchName(13), 'C#4');
  assert.strictEqual(S.pitchName(47), 'B6');
  assert(Math.abs(S.pitchFreq(21) - 440) < 0.01);   // A4
});

test('音符の文字列を小節に書き込める', () => {
  const p = S.parseNotes(S.newPattern(), 'C3 c#4:2 - B6:1 x');
  assert.deepStrictEqual([...p.pitch.slice(0, 4)], [0, 13, 0, 47]);
  assert.deepStrictEqual([...p.vol.slice(0, 5)], [3, 2, 0, 1, 0]);
  S.parseNotes(p, Array(20).fill('G4').join(' '));     // 16 ステップを越えたぶんは捨てる
  assert.strictEqual(p.vol.length, 16);
  assert(S.isEmpty(S.newPattern()) && !S.isEmpty(p));
});

test('テンポは BPM、1 ステップは 16 分音符', () => {
  assert.strictEqual(S.stepFrames(225), 4);
  assert.strictEqual(S.stepFrames(120), 7.5);
  assert.strictEqual(S.clampBpm(5), 20);
  assert.strictEqual(S.clampBpm(5000), 900);
  assert.strictEqual(S.clampBpm('abc'), S.BPM_DEFAULT);
  assert.strictEqual(S.clampLength(999), 64);
  assert.strictEqual(S.clampLength(0), 1);
});

test('保存して読み戻すと同じになる', () => {
  const { song } = setup(137.5, 5, ['C4 E4:2 G4:1', '', 'B6:1'], [1, 0, 3, 1], null, [0, 0, 0, 0, 1]);
  song.tracks[2].mute = true;
  song.tracks[3].order[63] = 64;
  S.parseNotes(song.patterns[63], '- - - - - - - - - - - - - - - C5');
  const data = S.encode(song), json = JSON.stringify(data);
  assert.deepStrictEqual(S.decode(json), song);
  assert.strictEqual(JSON.stringify(S.encode(S.decode(json))), json);
  assert.deepStrictEqual(data.patterns.slice(0, 3), ['0c3102131', '', '2f1']);
  assert.strictEqual(data.patterns.length, 64);
  assert.deepStrictEqual(data.tracks[0], { m: 0, o: [1, 0, 3, 1] });            // 末尾の空きは省く
  assert.deepStrictEqual(data.tracks[1], { m: 0, o: [] });
  assert.deepStrictEqual(S.encode(S.newSong()).patterns, []);
  assert.throws(() => S.decode('{"tracks":[]}'));
  assert.throws(() => S.decode('{"chip":4}'));
  assert.deepStrictEqual([...S.decode({ chip: 4, tracks: [{ o: [1, 99, -1, 64] }] }).tracks[0].order.slice(0, 4)], [1, 0, 0, 64]);
});

const A = '0c3' + '000'.repeat(15), B = '000'.repeat(15) + '2f1';

test('小節がトラックごとに別だった形式は、1 つの置き場にまとめる（同じ中身は 1 つに）', () => {
  const old = { chip: 3, bpm: 90, length: 4, tracks: [
    { m: 0, p: ['0c3', '', B], o: [1, 3, 1, 0] },
    { m: 1, p: [B, '0c3'], o: [2, 1] },                // トラック 1 と同じ中身を、別の番号で持っている
    { m: 0, p: [], o: [] },
    { m: 0, p: ['183'], o: [] },                       // 置いていない小節も残す
  ] };
  const song = S.decode(old);
  assert.deepStrictEqual([song.bpm, song.length], [90, 4]);
  assert.deepStrictEqual([...song.tracks[0].order.slice(0, 4)], [1, 2, 1, 0]);
  assert.deepStrictEqual([...song.tracks[1].order.slice(0, 2)], [1, 2]);
  assert(song.tracks[1].mute);
  assert.deepStrictEqual(S.encode(song).patterns, ['0c3', B, '183']);
});

test('小節に分かれていない形式は、小節に切り分けて同じ中身をまとめる', () => {
  const old = { chip: 2, bpm: 90, bars: 4, tracks: [{ w: 1, m: 0, n: A + B + A + B }, { m: 1, n: '000'.repeat(16) + A }, { n: '' }, { n: B }] };
  const song = S.decode(old);
  assert.deepStrictEqual([song.bpm, song.length], [90, 4]);
  assert.deepStrictEqual([...song.tracks[0].order.slice(0, 5)], [1, 2, 1, 2, 0]);
  assert.deepStrictEqual([...song.tracks[1].order.slice(0, 4)], [0, 1, 0, 0]);     // 空の小節は休み。トラックをまたいで同じ小節を使う
  assert.deepStrictEqual([...song.tracks[3].order.slice(0, 4)], [2, 0, 0, 0]);
  assert(song.tracks[1].mute);
  assert.deepStrictEqual(S.encode(song).patterns, ['0c3', B]);
  assert.deepStrictEqual(song.tracks.map(t => t.wave), [0, 1, 2, 3]);              // 波形はトラックの番号で決まる
});

test('効果音 32 個の形式や DOT のカートリッジは、同じ波形のトラックへ 4 つまで読む', () => {
  const note = '2f3' + '000'.repeat(15), other = '0c2' + '000'.repeat(15);
  const sfx = [{ i: 0, w: 2, s: 3, n: note }, { i: 1, w: 0, s: 3, n: '000'.repeat(16) }, { i: 2, w: 2, s: 9, n: other },
    { i: 5, w: 3, s: 3, n: note }, { i: 7, w: 1, s: 3, n: note }, { i: 9, w: 0, s: 3, n: note }];
  for (const data of [{ chip: 1, sfx }, { dot: 1, title: 'X', code: '', sfx }]) {
    const song = S.decode(data);
    assert.strictEqual(song.length, 1);
    assert.strictEqual(song.bpm, 300);                 // 速さ 3 フレーム = 300 BPM
    assert.deepStrictEqual(song.tracks.map(t => t.order[0]), [2, 1, 1, 1]);   // 同じ中身の効果音は同じ小節になる
    assert.deepStrictEqual(S.encode(song).patterns, ['2f3', '0c2']);
  }
  assert.strictEqual(S.decode({ chip: 1, sfx: [{ i: 0, w: 0, b: 90, s: 10, n: '2f3' }] }).bpm, 90);
});

test('並べた順に小節が鳴り、同じ小節をどのトラックからでも使える', () => {
  const { seq, voices } = setup(FAST, 3, ['C3', 'E3:2', '- G3'], [1, 2, 1], [0, 3, 3], null, [1, 1, 0]);
  seq.play();
  assert.strictEqual(heard(seq, voices), '1001');      // 位置 1、ステップ 1: トラック 1 と 4 が同じ小節 1
  assert(Math.abs(voices[0][2] - 130.81) < 0.01 && voices[0][3] === 1);
  assert(Math.abs(voices[3][2] - 130.81) < 0.01);
  assert.deepStrictEqual([voices[0][1], voices[3][1]], [0, 3]);   // 波形は鳴らすトラックのもの
  assert.strictEqual(heard(seq, voices), '0000');
  run(seq, 14);
  assert.strictEqual(heard(seq, voices), '1001');      // 位置 2: トラック 1 は小節 2
  assert(Math.abs(voices[0][2] - 164.81) < 0.01 && Math.abs(voices[0][3] - 2 / 3) < 1e-9);
  assert.strictEqual(heard(seq, voices), '0100');
  run(seq, 14);
  assert.strictEqual(heard(seq, voices), '1000');      // 位置 3: トラック 4 は休み
  assert.deepStrictEqual([seq.state.pos, seq.state.step], [2, 1]);
});

test('ループは曲の長さで頭に戻り、ループなしは最後で止まる', () => {
  const { seq, song, voices } = setup(FAST, 2, ['C3'], [1, 1]);
  seq.play();
  run(seq, 32);
  assert.deepStrictEqual([seq.state.pos, seq.state.step, seq.state.playing], [0, 0, true]);
  seq.state.loop = false;
  run(seq, 31);
  assert(seq.state.playing);
  seq.tick();
  assert(!seq.state.playing);
  assert.deepStrictEqual(voices.slice(-4), [[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0], [3, 0, 0, 0]]);
  seq.state.loop = true;
  seq.play(1);                                         // 途中から。ループすると、始めた位置に戻る
  run(seq, 16);
  assert.strictEqual(seq.state.pos, 1);
  song.length = 1;                                     // 再生中に短くしても落ちない
  seq.tick();
  assert.strictEqual(seq.state.pos, 0);
});

test('小節の試聴: その小節だけ、または曲の中で一緒に鳴るトラックと重ねて、ループする', () => {
  const { seq, song, voices } = setup(FAST, 2, ['C3', 'E3', 'G3', 'C4'], [1, 0], [0, 3], [4, 4]);
  seq.audition(0, 2);                                  // 置いていない小節でも鳴る。ほかのトラックは鳴らない
  assert.strictEqual(heard(seq, voices), '1000');
  assert(Math.abs(voices[0][2] - 164.81) < 0.01);
  run(seq, 15);
  assert.deepStrictEqual([seq.state.pos, seq.state.step], [0, 0]);   // 1 小節でループ
  seq.audition(3, 2);                                  // どのトラックの波形でも試聴できる
  assert.strictEqual(heard(seq, voices), '0001');
  assert.strictEqual(voices[3][1], 3);
  song.tracks[0].mute = true;                          // その小節だけの試聴は、ミュートやソロに関係なく鳴る
  song.tracks[2].solo = true;
  seq.audition(0, 2);
  assert.strictEqual(heard(seq, voices), '1000');
  seq.audition(0, 2, 1);                               // 重ねる試聴は、ミュートとソロに従う
  assert.strictEqual(heard(seq, voices), '0010');
  song.tracks[0].mute = false;
  song.tracks[2].solo = false;
  seq.audition(0, 2, 1);                               // 位置 2 と重ねる: トラック 2・3 はその位置の小節
  assert.strictEqual(heard(seq, voices), '1110');
  run(seq, 15);
  assert.strictEqual(seq.state.pos, 1);
  seq.play();                                          // ふつうの再生に戻すと、試聴の指定は消える
  assert.strictEqual(heard(seq, voices), '1010');
  assert(Math.abs(voices[0][2] - 130.81) < 0.01);
});

test('端数のあるテンポでも、平均すると正しい速さで進む', () => {
  const { seq, voices } = setup(120, 1, ['C3'], [1]);  // 1 ステップ 7.5 フレーム
  seq.play();
  const at = [];
  for (let f = 0; f < 120; f++) { const n = voices.length; seq.tick(); if (voices.length > n) at.push(f); }
  assert.deepStrictEqual(at.slice(0, 5), [0, 8, 15, 23, 30]);     // 8, 7, 8, 7 フレームと交互
  assert.strictEqual(at.length, 16);                              // 120 フレーム = 2 秒 = 1 小節
});

test('ミュートとソロ', () => {
  const { seq, song, voices } = setup(FAST, 1, ['C3'], [1], [1], [1], [1]);
  const first = () => { seq.play(); return heard(seq, voices); };
  assert.strictEqual(first(), '1111');
  song.tracks[1].mute = true;
  assert.strictEqual(first(), '1011');
  song.tracks[2].solo = true;
  assert.strictEqual(first(), '0010');
  song.tracks[1].solo = true;                          // ミュートはソロより強い
  assert.strictEqual(first(), '0010');
  assert(!('solo' in S.encode(song).tracks[2]));
});

console.log(passed + ' passed');
