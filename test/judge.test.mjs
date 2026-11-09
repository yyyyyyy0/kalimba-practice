import test from 'node:test';
import assert from 'node:assert/strict';
import { POINTS, WINDOWS, createJudge, judgementOf, pitchClassOf } from '../js/judge.js';

const note = (index, degree, time) => ({ index, degree, beat: index, beats: 1, time, state: 'pending' });
const chart = () => [note(0, 1, 1), note(1, 3, 2), note(2, 3, 3), note(3, 8, 4)];
const timed = (notes = chart(), opts = {}) => createJudge({ notes, mode: 'timed', octaveFree: false, ...opts });
// 単音の発音。degree が null のときは歯が特定できなかった発音で、judge には何も渡らない。
const pluck = (j, time, degree) => j.onPluck({ time, degrees: degree === null ? [] : [degree] })[0] ?? { kind: 'ignored' };

test('judge: 各窓の境界 (|dt| ちょうどは内側)', () => {
  const cases = [
    [0, 'perfect'],
    [0.045, 'perfect'],
    [0.0451, 'great'],
    [0.09, 'great'],
    [0.0901, 'good'],
    [0.15, 'good'],
  ];
  for (const [dt, expected] of cases) {
    for (const sign of [1, -1]) {
      const j = timed();
      const r = pluck(j, 1 + sign * dt, 1);
      assert.equal(r.kind, 'hit', `dt=${sign * dt}`);
      assert.equal(r.judgement, expected, `dt=${sign * dt}`);
      assert.ok(Math.abs(r.dt - sign * dt) < 1e-12);
    }
  }
  assert.equal(pluck(timed(), 1.1501, 1).kind, 'ignored');
  assert.equal(pluck(timed(), 0.8499, 1).kind, 'ignored');
  assert.equal(judgementOf(WINDOWS.good + 0.001), null);
});

test('judge: 浮動小数点の誤差があっても窓の境界で判定が割れない', () => {
  const j = timed([note(0, 1, 10)]);
  assert.equal(pluck(j, 10.045, 1).judgement, 'perfect');
  const k = timed([note(0, 1, 10)]);
  assert.equal(pluck(k, 10.15, 1).judgement, 'good');
});

test('judge: miss は note.time + good + confirmDelay を超えた tick で確定する', () => {
  const j = timed();
  const limit = 1 + WINDOWS.good + 0.12;
  assert.deepEqual(j.tick(limit), []);
  const missed = j.tick(limit + 0.001);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].index, 0);
  assert.equal(missed[0].state, 'missed');
  assert.equal(missed[0].judgement, 'miss');
  assert.deepEqual(j.tick(limit + 0.5), [], '二重に miss しない');
  const custom = timed(chart(), { confirmDelay: 0.3 });
  assert.deepEqual(custom.tick(1 + 0.15 + 0.3 + 0.001).map((n) => n.index), [0]);
  assert.deepEqual(custom.tick(1 + 0.15 + 0.3), []);
});

test('judge: 打たれたノーツは miss にならず、missed のあとの発音は当たらない', () => {
  const j = timed();
  pluck(j, 1, 1);
  assert.deepEqual(j.tick(2.0), [], '1 番目は hit 済み');
  assert.equal(j.tick(2.0).length, 0);
  const k = timed();
  k.tick(1.5);
  assert.equal(pluck(k, 1.1, 1).kind, 'ignored');
});

test('judge: 1 回の発音で 2 ノーツは叩けない (同じ歯の連打)', () => {
  const j = timed([note(0, 3, 1), note(1, 3, 1.1)]);
  const first = pluck(j, 1.07, 3);
  assert.equal(first.kind, 'hit');
  assert.equal(first.note.index, 1, '|dt| が最小のノーツに当たる');
  const second = pluck(j, 1.09, 3);
  assert.equal(second.kind, 'hit');
  assert.equal(second.note.index, 0);
  assert.equal(pluck(j, 1.1, 3).kind, 'ignored');
});

test('judge: 残響で次の同じ音のノーツは当たらない (発音がなければ miss)', () => {
  const j = timed([note(0, 3, 1), note(1, 3, 1.7)]);
  assert.equal(pluck(j, 1, 3).kind, 'hit');
  j.tick(2.5);
  const r = j.result();
  assert.equal(r.counts.miss, 1);
  assert.equal(r.counts.perfect, 1);
});

test('judge: 同じ度数の候補のうち |dt| が最小のノーツに当てる', () => {
  const j = timed([note(0, 3, 1), note(1, 3, 1.2)]);
  assert.equal(pluck(j, 1.14, 3).note.index, 1);
});

test('judge: 窓内の別の度数の発音は wrong でコンボが切れ、ノーツは残る', () => {
  const j = timed([note(0, 1, 1), note(1, 2, 2), note(2, 3, 3)]);
  assert.equal(pluck(j, 1, 1).kind, 'hit');
  assert.equal(j.result().combo, 1);
  const w = pluck(j, 2.02, 5);
  assert.deepEqual(w, { kind: 'wrong', degree: 5, expected: 2 });
  assert.equal(j.result().combo, 0);
  assert.equal(j.result().maxCombo, 1);
  assert.equal(pluck(j, 2.08, 2).kind, 'hit', 'wrong のあとでも窓内なら当てられる');
  assert.equal(j.result().wrong, 1);
  assert.equal(j.result().perDegree[2].wrong, 1);
});

test('judge: 窓の外の発音と度数 null は ignored', () => {
  const j = timed();
  assert.deepEqual(pluck(j, 1.5, 5), { kind: 'ignored' });
  assert.deepEqual(pluck(j, 1, null), { kind: 'ignored' });
  assert.equal(j.result().wrong, 0);
});

test('judge: octaveFree は 1 と 8 を同一視し、オクターブ違いを当てる', () => {
  assert.equal(pitchClassOf(1), pitchClassOf(8));
  assert.notEqual(pitchClassOf(1), pitchClassOf(2));
  const strict = timed();
  assert.equal(pluck(strict, 4, 1).kind, 'wrong');
  const free = timed(chart(), { octaveFree: true });
  const r = pluck(free, 4, 1);
  assert.equal(r.kind, 'hit');
  assert.equal(r.note.degree, 8);
});

test('judge: ノーツの状態は pending → hit | missed だけで戻らない', () => {
  const j = timed();
  const [first] = j.notes;
  pluck(j, 1, 1);
  assert.equal(first.state, 'hit');
  assert.equal(first.judgement, 'perfect');
  assert.equal(first.dt, 0);
  j.tick(10);
  assert.equal(first.state, 'hit');
  assert.deepEqual(j.notes.map((n) => n.state), ['hit', 'missed', 'missed', 'missed']);
});

test('judge: wait モードは次の未判定ノーツで止まり、正しい度数で great、誤りは wrong', () => {
  const j = createJudge({ notes: chart(), mode: 'wait', octaveFree: false });
  assert.equal(j.nextPending().index, 0);
  assert.deepEqual(pluck(j, 99, 3), { kind: 'wrong', degree: 3, expected: 1 });
  const hit = pluck(j, 99, 1);
  assert.equal(hit.kind, 'hit');
  assert.equal(hit.judgement, 'great');
  assert.equal(hit.dt, undefined);
  assert.equal(j.nextPending().index, 1);
  assert.deepEqual(j.tick(1000), [], 'wait では miss しない');
  assert.equal(j.result().counts.miss, 0);
  assert.equal(j.result().perDegree[1].meanDt, null);
  for (const d of [3, 3, 8]) assert.equal(pluck(j, 0, d).kind, 'hit');
  assert.equal(j.nextPending(), null);
  assert.equal(pluck(j, 0, 1).kind, 'ignored');
});

test('judge: result の集計 (カウント、精度、コンボ、歯ごとの平均ずれ、スコア)', () => {
  const j = timed([note(0, 1, 1), note(1, 2, 2), note(2, 1, 3), note(3, 4, 4), note(4, 1, 5)]);
  pluck(j, 1.01, 1);
  pluck(j, 2.07, 2);
  pluck(j, 3.13, 1);
  pluck(j, 4.0, 6);
  j.tick(10);
  const r = j.result();
  assert.deepEqual(r.counts, { perfect: 1, great: 1, good: 1, miss: 2 });
  assert.equal(r.total, 5);
  assert.equal(r.accuracy, 3 / 5);
  assert.equal(r.maxCombo, 3);
  assert.equal(r.combo, 0);
  assert.equal(r.wrong, 1);
  assert.equal(r.score, POINTS.perfect + POINTS.great + POINTS.good);
  assert.equal(r.score, 2100);
  assert.deepEqual(Object.keys(r.perDegree).sort(), ['1', '2', '4']);
  assert.equal(r.perDegree[1].hit, 2);
  assert.equal(r.perDegree[1].miss, 1);
  assert.ok(Math.abs(r.perDegree[1].meanDt - 0.07) < 1e-9);
  assert.equal(r.perDegree[4].wrong, 1);
  assert.equal(r.perDegree[4].miss, 1);
});

test('judge: コンボは miss でも切れる', () => {
  const j = timed([note(0, 1, 1), note(1, 1, 2), note(2, 1, 3)]);
  pluck(j, 1, 1);
  j.tick(2.5);
  pluck(j, 3, 1);
  const r = j.result();
  assert.equal(r.maxCombo, 1);
  assert.equal(r.combo, 1);
});

// 和音のノーツは同じ time・beat で chord 番号を共有する。
const chordNote = (index, degree, time, chord) => ({ index, degree, beat: time, beats: 1, time, state: 'pending', chord });
const chordChart = () => [
  chordNote(0, 1, 1, 0),
  chordNote(1, 3, 1, 0),
  chordNote(2, 5, 1, 0),
  { ...note(3, 2, 2), chord: null },
  chordNote(4, 4, 3, 1),
  chordNote(5, 6, 3, 1),
];
const kinds = (results) => results.map((r) => r.kind);

test('judge: 同じ発音で複数の度数が当たり、和音の判定は最も悪い判定になる', () => {
  const j = timed(chordChart());
  const results = j.onPluck({ time: 1.05, degrees: [1, 3, 5] });
  assert.deepEqual(kinds(results), ['hit', 'hit', 'hit']);
  assert.deepEqual(results.map((r) => r.note.degree), [1, 3, 5]);
  assert.ok(results.every((r) => r.judgement === 'great' && Math.abs(r.dt - 0.05) < 1e-12));
  for (const r of results) assert.deepEqual(r.chord, { id: 0, hit: 3, missed: 0, total: 3, worst: 'great' }, '全員が同じ発音の終わりの状態を持つ');
  const r = j.result();
  assert.equal(r.counts.great, 3);
  assert.equal(r.maxCombo, 3);
  assert.deepEqual(r.chords, { total: 2, complete: 1 });
});

test('judge: 和音の部分ヒット (欠けた歯は miss、chords.complete に数えない)', () => {
  const j = timed(chordChart());
  const results = j.onPluck({ time: 1, degrees: [1, 5] });
  assert.deepEqual(kinds(results), ['hit', 'hit']);
  assert.deepEqual(results[1].chord, { id: 0, hit: 2, missed: 0, total: 3, worst: 'perfect' });
  const missed = j.tick(1.5);
  assert.deepEqual(missed.map((n) => n.degree), [3]);
  assert.deepEqual(j.chordStatus(0), { id: 0, hit: 2, missed: 1, total: 3, worst: 'perfect' });
  assert.deepEqual(j.result().chords, { total: 2, complete: 0 });
  assert.equal(j.result().counts.miss, 1);
});

test('judge: 同じ度数のノーツは 1 つの発音で 2 つ叩けないが、違う度数ならいくつでも当たる', () => {
  const j = timed([chordNote(0, 1, 1, 0), chordNote(1, 3, 1, 0), { ...note(2, 1, 1.1), chord: null }]);
  const results = j.onPluck({ time: 1.04, degrees: [1, 3] });
  assert.deepEqual(kinds(results), ['hit', 'hit']);
  assert.equal(results[0].note.index, 0, '度数 1 は |dt| が最小のノーツ');
  assert.equal(j.notes[2].state, 'pending', '同じ度数のもう 1 つは叩かれない');
  assert.equal(pluck(j, 1.1, 1).kind, 'hit');
});

test('judge: どのノーツにも当たらない度数は wrong で、1 回の発音で数えるのは 1 回だけ', () => {
  const j = timed(chordChart());
  const results = j.onPluck({ time: 1, degrees: [1, 3, 5, 6, 7] });
  assert.deepEqual(kinds(results), ['hit', 'hit', 'hit', 'wrong', 'wrong']);
  assert.equal(results[3].counted, undefined);
  assert.equal(results[4].counted, false);
  assert.equal(j.result().wrong, 1);
  assert.equal(j.result().combo, 0, 'wrong でコンボが切れる');
  assert.equal(j.result().maxCombo, 3);
  const none = timed(chordChart()).onPluck({ time: 5, degrees: [1, 3] });
  assert.deepEqual(kinds(none), ['ignored', 'ignored'], '窓に何もなければ wrong にしない');
  assert.deepEqual(timed(chordChart()).onPluck({ time: 1, degrees: [] }), []);
});

test('judge: 和音の発音と時刻の境界は単音と同じ窓で判定する', () => {
  const j = timed(chordChart());
  assert.equal(j.onPluck({ time: 1.15, degrees: [1] })[0].judgement, 'good');
  assert.deepEqual(kinds(j.onPluck({ time: 1.1501, degrees: [3] })), ['ignored']);
});

test('judge: octaveFree でも和音の各度数を同一視で当てる', () => {
  const j = timed([chordNote(0, 8, 1, 0), chordNote(1, 5, 1, 0)], { octaveFree: true });
  assert.deepEqual(kinds(j.onPluck({ time: 1, degrees: [1, 5] })), ['hit', 'hit']);
});

test('judge: wait モードは和音の全ノーツが当たるまで止まり、部分ヒットは次の発音で補える', () => {
  const j = createJudge({ notes: chordChart(), mode: 'wait', octaveFree: false });
  assert.equal(j.nextPending().index, 0);
  const first = j.onPluck({ time: 0, degrees: [1, 5] });
  assert.deepEqual(kinds(first), ['hit', 'hit']);
  assert.equal(first[0].judgement, 'great');
  assert.equal(j.nextPending().index, 1, '度数 3 が残っているので止まる');
  assert.deepEqual(j.chordStatus(0), { id: 0, hit: 2, missed: 0, total: 3, worst: 'great' });
  const wrong = j.onPluck({ time: 0, degrees: [3, 7] });
  assert.deepEqual(kinds(wrong), ['hit', 'wrong'], '和音に含まれない度数は wrong');
  assert.equal(j.result().wrong, 1);
  assert.equal(j.nextPending().index, 3, '和音が揃ったので次のノーツへ');
  assert.deepEqual(j.onPluck({ time: 0, degrees: [4] }).map((r) => r.kind), ['wrong'], '次は単音の 2 なので和音の歯は wrong');
  assert.equal(j.onPluck({ time: 0, degrees: [2] })[0].kind, 'hit');
  assert.deepEqual(kinds(j.onPluck({ time: 0, degrees: [4, 6] })), ['hit', 'hit']);
  assert.equal(j.nextPending(), null);
  assert.deepEqual(kinds(j.onPluck({ time: 0, degrees: [1] })), ['ignored']);
  assert.deepEqual(j.tick(1000), []);
  assert.deepEqual(j.result().chords, { total: 2, complete: 2 });
});

test('judge: result の chords は和音がなければ total 0', () => {
  assert.deepEqual(timed().result().chords, { total: 0, complete: 0 });
});
