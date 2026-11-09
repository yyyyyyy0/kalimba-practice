import test from 'node:test';
import assert from 'node:assert/strict';
import { SONGS } from '../js/songs.js';
import { buildChart, chordsOf, hasChords, parseScore, playable, validateSong } from '../js/score.js';
import { LAYOUTS } from '../js/tuning.js';

const song = (score, extra = {}) => ({ id: 't', kind: 'song', level: 1, bpm: 60, beatsPerBar: 4, score, ...extra });

test('score: 全曲で validateSong がエラー 0', () => {
  assert.ok(SONGS.length > 0);
  for (const s of SONGS) assert.deepEqual(validateSong(s), [], s.id);
  assert.equal(new Set(SONGS.map((s) => s.id)).size, SONGS.length, 'id が重複');
});

test('score: parseScore は度数・拍・休符・小節を読む', () => {
  const { notes, bars } = parseScore('1 2:.5 0:.5 3:1.5 | 4:2');
  assert.deepEqual(
    notes.map((n) => [n.index, n.degree, n.beat, n.beats]),
    [
      [0, 1, 0, 1],
      [1, 2, 1, 0.5],
      [2, 3, 2, 1.5],
      [3, 4, 3.5, 2],
    ],
  );
  assert.deepEqual(bars, [[1, 0.5, 0.5, 1.5], [2]]);
});

test('score: 末尾の小節線は空の小節を作らない', () => {
  assert.equal(parseScore('1 2 3 4 |').bars.length, 1);
});

test('score: 読めないトークンは例外', () => {
  assert.throws(() => parseScore('1 x'), /x/);
  assert.throws(() => parseScore('1:0'), /拍数/);
});

test('score: アウフタクト (最初) と短い最後の小節は許し、途中の拍数不足と超過は検出', () => {
  assert.deepEqual(validateSong(song('1 | 2 3 4 5 | 6:2')), []);
  assert.deepEqual(validateSong(song('1 2 3 4')), []);
  assert.match(validateSong(song('1 2 3 4 | 5 6 7 | 1 2 3 4 | 8'))[0], /小節 2/);
  assert.match(validateSong(song('1 2 3 4 | 5:2 6 7 8 | 1'))[0], /小節 2/);
  assert.match(validateSong(song('1 2 3 4 5'))[0], /小節 1/);
  assert.match(validateSong(song('1 2 3 4 | 5 6 7 8 | 1:5'))[0], /小節 3/);
});

test('score: 度数の範囲、ノーツ数、拍子の検証', () => {
  assert.match(validateSong(song('1 2 3 9'))[0], /範囲外/);
  assert.match(validateSong(song('0 0 0 0'))[0], /ノーツがありません/);
  assert.match(validateSong(song('1', { beatsPerBar: 0 }))[0], /beatsPerBar/);
  assert.match(validateSong(song('1', { kind: 'x' }))[0], /kind/);
});

test('score: buildChart は速度で時間を伸縮し、ノーツは pending で始まる', () => {
  const s = song('1 2 | 3:2', { bpm: 120, beatsPerBar: 2 });
  const normal = buildChart(s);
  assert.deepEqual(
    normal.notes.map((n) => n.time),
    [0, 0.5, 1],
  );
  assert.ok(normal.notes.every((n) => n.state === 'pending'));
  assert.equal(normal.endTime, 2);
  assert.equal(normal.countInBeats, 2);
  const slow = buildChart(s, { speed: 0.5 });
  assert.deepEqual(
    slow.notes.map((n) => n.time),
    [0, 1, 2],
  );
});

const degreesOf = (notes) => notes.map((n) => n.degree);

test('score: 和音 [1 3 5]:2 は同じ chord 番号・beat・beats の複数ノーツになり、単音の chord は null', () => {
  const { notes, bars } = parseScore('1 [1 3 5]:2 | [2 4] 5 [6 8]:.5 7');
  assert.deepEqual(
    notes.map((n) => [n.index, n.degree, n.beat, n.beats, n.chord]),
    [
      [0, 1, 0, 1, null],
      [1, 1, 1, 2, 0],
      [2, 3, 1, 2, 0],
      [3, 5, 1, 2, 0],
      [4, 2, 3, 1, 1],
      [5, 4, 3, 1, 1],
      [6, 5, 4, 1, null],
      [7, 6, 5, 0.5, 2],
      [8, 8, 5, 0.5, 2],
      [9, 7, 5.5, 1, null],
    ],
  );
  assert.deepEqual(bars, [[1, 2], [1, 1, 0.5, 1]]);
  assert.deepEqual(degreesOf(chordsOf(notes)[0]), [1, 3, 5]);
  assert.equal(chordsOf(notes).length, 3);
});

test('score: 和音の拍数は小節の拍数に 1 トークンとして数える', () => {
  assert.deepEqual(validateSong(song('[1 3 5]:2 [1 3 5]:2 | [4 6 8]:4')), []);
  assert.match(validateSong(song('[1 3 5]:2 [1 3 5]:2 | [4 6 8]:3 | 1:4'))[0], /小節 2/);
});

test('score: 和音の構文エラー (閉じ忘れ・空・重複・個数・休符・トークン)', () => {
  assert.throws(() => parseScore('1 [1 3 5 2'), /閉じていません/);
  assert.throws(() => parseScore('[1 3 [5 7]'), /閉じていません/);
  assert.throws(() => parseScore('[]'), /空/);
  assert.throws(() => parseScore('[ ]:2'), /空/);
  assert.throws(() => parseScore('[1 1 3]'), /重複/);
  assert.throws(() => parseScore('[3]'), /2〜4/);
  assert.throws(() => parseScore('[1 2 3 4 5]'), /2〜4/);
  assert.throws(() => parseScore('[1 0 3]'), /休符/);
  assert.throws(() => parseScore('[1 x]'), /x/);
  assert.throws(() => parseScore('1 ]'), /\]/);
  assert.throws(() => parseScore('[1 3]:0'), /拍数/);
  assert.throws(() => parseScore('[1 3]x'), /読めません/);
  assert.equal(parseScore('[1 3]:.5 [2 4]:1.5').notes.length, 4);
});

test('score: 範囲外の度数は和音の中でも validateSong が検出する', () => {
  assert.match(validateSong(song('[1 9] 2 3 4'))[0], /範囲外/);
  assert.deepEqual(validateSong(song('[1 9] 2 3 4')).filter((e) => /押さえられません/.test(e)), []);
});

test('score: playable の境界 (連続した位置の run、左右の親指)', () => {
  const order = LAYOUTS.kalimba.order;
  assert.deepEqual(order, [8, 6, 4, 2, 1, 3, 5, 7]);
  const at = (...positions) => positions.map((p) => order[p]);
  // run が 1 つ: 4 本まで
  assert.equal(playable(at(0, 1), order), true);
  assert.equal(playable(at(2, 3, 4, 5), order), true);
  assert.equal(playable(at(3, 4, 5, 6), order), true);
  assert.equal(playable(at(0, 1, 2, 3, 4), order), false, '5 本はそもそも押さえられない');
  // run が 2 つ: 各 3 本以下、左の最大位置 ≤ 4、右の最小位置 ≥ 3
  assert.equal(playable(at(0, 5), order), true);
  assert.equal(playable(at(0, 1, 5), order), true);
  assert.equal(playable(at(0, 1, 2, 6), order), true, '左の run が 3 本');
  assert.equal(playable(at(0, 1, 2, 3, 6), order), false, '左の run が 4 本');
  assert.equal(playable(at(0, 5, 6, 7), order), true, '右の run が 3 本');
  assert.equal(playable(at(0, 2, 4, 6), order), false, 'run が 4 つ');
  assert.equal(playable(at(0, 3, 6), order), false, 'run が 3 つ');
  assert.equal(playable(at(4, 6), order), true, '左の最大位置 4、右の最小位置 6');
  assert.equal(playable(at(5, 7), order), false, '左の最大位置が 5');
  assert.equal(playable(at(0, 2), order), false, '右の最小位置が 2');
  assert.equal(playable(at(0, 3), order), true, '右の最小位置がちょうど 3');
  assert.equal(playable(at(1, 4), order), true, '左の最大位置がちょうど 4');
  assert.equal(playable([1, 99], order), false, '並びにない度数');
  assert.equal(playable([], order), false);
  const scale = LAYOUTS.scale.order;
  assert.equal(playable([1, 2, 3], scale), true);
  assert.equal(playable([1, 2, 3, 4, 5], scale), false);
});

test('score: validateSong は既定レイアウトで押さえられない和音を検出し、check の対象にする', () => {
  assert.deepEqual(validateSong(song('[1 3 5 7] 1 2 3')), [], '[1 3 5 7] は位置 4..7 の 1 run');
  const errors = validateSong(song('[8 6 4 2 1] 1 2 3'));
  assert.match(errors[0] ?? '', /範囲外|2〜4/);
  const hard = validateSong(song('[8 4 5 3] 1 2 3'));
  assert.match(hard[0], /和音 \[8 4 5 3\] は押さえられません/);
});

test('score: level は 1〜5 の整数', () => {
  assert.deepEqual(validateSong(song('1 2 3 4', { level: 5 })), []);
  assert.match(validateSong(song('1 2 3 4', { level: 6 }))[0], /level/);
  assert.match(validateSong(song('1 2 3 4', { level: 0 }))[0], /level/);
  assert.match(validateSong(song('1 2 3 4', { level: 2.5 }))[0], /level/);
});

test('score: 譜面の和音はすべて既定レイアウトで押さえられ、buildChart は chord を引き継ぐ', () => {
  const withChords = SONGS.filter(hasChords);
  assert.ok(withChords.length >= 5);
  for (const s of withChords) {
    const chart = buildChart(s);
    for (const group of chordsOf(chart.notes)) {
      assert.ok(playable(group.map((n) => n.degree), LAYOUTS.kalimba.order), `${s.id}: ${group.map((n) => n.degree)}`);
      assert.equal(new Set(group.map((n) => n.time)).size, 1, `${s.id}: 同じ和音の time が揃う`);
    }
  }
  assert.ok(SONGS.filter((s) => !hasChords(s)).length >= 10);
});
