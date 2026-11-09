import test from 'node:test';
import assert from 'node:assert/strict';
import { POINTS, WINDOWS, createJudge, judgementOf, pitchClassOf } from '../js/judge.js';

const note = (index, degree, time) => ({ index, degree, beat: index, beats: 1, time, state: 'pending' });
const chart = () => [note(0, 1, 1), note(1, 3, 2), note(2, 3, 3), note(3, 8, 4)];
const timed = (notes = chart(), opts = {}) => createJudge({ notes, mode: 'timed', octaveFree: false, ...opts });

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
      const r = j.onPluck({ time: 1 + sign * dt, degree: 1 });
      assert.equal(r.kind, 'hit', `dt=${sign * dt}`);
      assert.equal(r.judgement, expected, `dt=${sign * dt}`);
      assert.ok(Math.abs(r.dt - sign * dt) < 1e-12);
    }
  }
  assert.equal(timed().onPluck({ time: 1.1501, degree: 1 }).kind, 'ignored');
  assert.equal(timed().onPluck({ time: 0.8499, degree: 1 }).kind, 'ignored');
  assert.equal(judgementOf(WINDOWS.good + 0.001), null);
});

test('judge: 浮動小数点の誤差があっても窓の境界で判定が割れない', () => {
  const j = timed([note(0, 1, 10)]);
  assert.equal(j.onPluck({ time: 10.045, degree: 1 }).judgement, 'perfect');
  const k = timed([note(0, 1, 10)]);
  assert.equal(k.onPluck({ time: 10.15, degree: 1 }).judgement, 'good');
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
  j.onPluck({ time: 1, degree: 1 });
  assert.deepEqual(j.tick(2.0), [], '1 番目は hit 済み');
  assert.equal(j.tick(2.0).length, 0);
  const k = timed();
  k.tick(1.5);
  assert.equal(k.onPluck({ time: 1.1, degree: 1 }).kind, 'ignored');
});

test('judge: 1 回の発音で 2 ノーツは叩けない (同じ歯の連打)', () => {
  const j = timed([note(0, 3, 1), note(1, 3, 1.1)]);
  const first = j.onPluck({ time: 1.07, degree: 3 });
  assert.equal(first.kind, 'hit');
  assert.equal(first.note.index, 1, '|dt| が最小のノーツに当たる');
  const second = j.onPluck({ time: 1.09, degree: 3 });
  assert.equal(second.kind, 'hit');
  assert.equal(second.note.index, 0);
  assert.equal(j.onPluck({ time: 1.1, degree: 3 }).kind, 'ignored');
});

test('judge: 残響で次の同じ音のノーツは当たらない (発音がなければ miss)', () => {
  const j = timed([note(0, 3, 1), note(1, 3, 1.7)]);
  assert.equal(j.onPluck({ time: 1, degree: 3 }).kind, 'hit');
  j.tick(2.5);
  const r = j.result();
  assert.equal(r.counts.miss, 1);
  assert.equal(r.counts.perfect, 1);
});

test('judge: 同じ度数の候補のうち |dt| が最小のノーツに当てる', () => {
  const j = timed([note(0, 3, 1), note(1, 3, 1.2)]);
  assert.equal(j.onPluck({ time: 1.14, degree: 3 }).note.index, 1);
});

test('judge: 窓内の別の度数の発音は wrong でコンボが切れ、ノーツは残る', () => {
  const j = timed([note(0, 1, 1), note(1, 2, 2), note(2, 3, 3)]);
  assert.equal(j.onPluck({ time: 1, degree: 1 }).kind, 'hit');
  assert.equal(j.result().combo, 1);
  const w = j.onPluck({ time: 2.02, degree: 5 });
  assert.deepEqual(w, { kind: 'wrong', degree: 5, expected: 2 });
  assert.equal(j.result().combo, 0);
  assert.equal(j.result().maxCombo, 1);
  assert.equal(j.onPluck({ time: 2.08, degree: 2 }).kind, 'hit', 'wrong のあとでも窓内なら当てられる');
  assert.equal(j.result().wrong, 1);
  assert.equal(j.result().perDegree[2].wrong, 1);
});

test('judge: 窓の外の発音と度数 null は ignored', () => {
  const j = timed();
  assert.deepEqual(j.onPluck({ time: 1.5, degree: 5 }), { kind: 'ignored' });
  assert.deepEqual(j.onPluck({ time: 1, degree: null }), { kind: 'ignored' });
  assert.equal(j.result().wrong, 0);
});

test('judge: octaveFree は 1 と 8 を同一視し、オクターブ違いを当てる', () => {
  assert.equal(pitchClassOf(1), pitchClassOf(8));
  assert.notEqual(pitchClassOf(1), pitchClassOf(2));
  const strict = timed();
  assert.equal(strict.onPluck({ time: 4, degree: 1 }).kind, 'wrong');
  const free = timed(chart(), { octaveFree: true });
  const r = free.onPluck({ time: 4, degree: 1 });
  assert.equal(r.kind, 'hit');
  assert.equal(r.note.degree, 8);
});

test('judge: ノーツの状態は pending → hit | missed だけで戻らない', () => {
  const j = timed();
  const [first] = j.notes;
  j.onPluck({ time: 1, degree: 1 });
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
  assert.deepEqual(j.onPluck({ time: 99, degree: 3 }), { kind: 'wrong', degree: 3, expected: 1 });
  const hit = j.onPluck({ time: 99, degree: 1 });
  assert.equal(hit.kind, 'hit');
  assert.equal(hit.judgement, 'great');
  assert.equal(hit.dt, undefined);
  assert.equal(j.nextPending().index, 1);
  assert.deepEqual(j.tick(1000), [], 'wait では miss しない');
  assert.equal(j.result().counts.miss, 0);
  assert.equal(j.result().perDegree[1].meanDt, null);
  for (const d of [3, 3, 8]) assert.equal(j.onPluck({ time: 0, degree: d }).kind, 'hit');
  assert.equal(j.nextPending(), null);
  assert.equal(j.onPluck({ time: 0, degree: 1 }).kind, 'ignored');
});

test('judge: result の集計 (カウント、精度、コンボ、歯ごとの平均ずれ、スコア)', () => {
  const j = timed([note(0, 1, 1), note(1, 2, 2), note(2, 1, 3), note(3, 4, 4), note(4, 1, 5)]);
  j.onPluck({ time: 1.01, degree: 1 });
  j.onPluck({ time: 2.07, degree: 2 });
  j.onPluck({ time: 3.13, degree: 1 });
  j.onPluck({ time: 4.0, degree: 6 });
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
  j.onPluck({ time: 1, degree: 1 });
  j.tick(2.5);
  j.onPluck({ time: 3, degree: 1 });
  const r = j.result();
  assert.equal(r.maxCombo, 1);
  assert.equal(r.combo, 1);
});
