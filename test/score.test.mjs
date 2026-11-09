import test from 'node:test';
import assert from 'node:assert/strict';
import { SONGS } from '../js/songs.js';
import { buildChart, parseScore, validateSong } from '../js/score.js';

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
