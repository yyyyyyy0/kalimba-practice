import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUTS,
  PRESETS,
  calibratedPreset,
  centsBetween,
  freqToMidi,
  makePreset,
  matchTine,
  midiToFreq,
  noteName,
} from '../js/tuning.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const detune = (freq, cents) => freq * 2 ** (cents / 1200);

test('tuning: 周波数と MIDI と cent の変換', () => {
  close(midiToFreq(69), 440);
  close(midiToFreq(60), 261.6255653005986, 1e-9);
  close(midiToFreq(69, 442), 442);
  close(freqToMidi(440), 69);
  close(freqToMidi(523.2511306011972), 72, 1e-9);
  close(centsBetween(880, 440), 1200);
  close(centsBetween(440, 880), -1200);
  close(centsBetween(440 * 2 ** (1 / 12), 440), 100, 1e-9);
});

test('tuning: プリセットは低い順の 8 本で、A4 基準を変えると全体が動く', () => {
  const c4 = makePreset('c4');
  assert.equal(c4.freqs.length, 8);
  close(c4.freqs[0], 261.6255653005986, 1e-6);
  close(c4.freqs[7], 523.2511306011972, 1e-6);
  close(c4.freqs[4], 391.99543598174927, 1e-6);
  const c5 = makePreset('c5', 442);
  close(c5.freqs[0], midiToFreq(72, 442), 1e-9);
  close(c5.freqs[7], midiToFreq(84, 442), 1e-9);
  for (const id of Object.keys(PRESETS)) {
    const f = makePreset(id).freqs;
    for (let i = 1; i < 8; i++) assert.ok(f[i] > f[i - 1]);
  }
  assert.throws(() => makePreset('nope'));
});

test('tuning: 実測プリセットは昇順に並べ替える', () => {
  const p = calibratedPreset([300, 250, 280]);
  assert.deepEqual(p.freqs, [250, 280, 300]);
  assert.equal(p.id, 'custom');
});

test('tuning: noteName', () => {
  assert.deepEqual(noteName(72), { ja: 'ド', en: 'C5', degreeLabel: '1' });
  assert.deepEqual(noteName(67), { ja: 'ソ', en: 'G4', degreeLabel: '5' });
  assert.equal(noteName(61).ja, 'ド♯');
  assert.equal(noteName(61).degreeLabel, '');
  assert.equal(noteName(60.4).en, 'C4');
});

test('tuning: matchTine は最も近い歯を選び、許容 cent ちょうどまでが一致', () => {
  const p = makePreset('c4');
  for (let i = 0; i < 8; i++) {
    const m = matchTine(p.freqs[i], p);
    assert.equal(m.degree, i + 1);
    close(m.cents, 0, 1e-9);
  }
  const tol = { toleranceCents: 40 };
  assert.equal(matchTine(detune(p.freqs[2], 39.9), p, tol).degree, 3);
  assert.equal(matchTine(detune(p.freqs[2], -39.9), p, tol).degree, 3);
  assert.equal(matchTine(detune(p.freqs[2], 40.1), p, tol), null);
  assert.equal(matchTine(detune(p.freqs[2], -40.1), p, tol), null);
  close(matchTine(detune(p.freqs[2], -25), p).cents, -25, 1e-9);
  // 半音離れた歯 (ミとファ) の間では近いほうを選ぶ
  assert.equal(matchTine(detune(p.freqs[2], 60), p, { toleranceCents: 50 }).degree, 4);
});

test('tuning: octaveFree のときだけオクターブ違いを同じ歯とみなす', () => {
  const p = makePreset('c4');
  const lowG = p.freqs[4] / 2;
  const highE = p.freqs[2] * 2;
  assert.equal(matchTine(lowG, p), null);
  assert.equal(matchTine(highE, p), null);
  assert.equal(matchTine(lowG, p, { octaveFree: true }).degree, 5);
  assert.equal(matchTine(highE, p, { octaveFree: true }).degree, 3);
  const off = matchTine(detune(lowG, 12), p, { octaveFree: true });
  assert.equal(off.degree, 5);
  close(off.cents, 12, 1e-9);
  assert.equal(matchTine(detune(lowG, 45), p, { octaveFree: true }), null);
  // 直接一致が優先される
  assert.equal(matchTine(p.freqs[7], p, { octaveFree: true }).degree, 8);
});

test('tuning: 不正な周波数は null', () => {
  const p = makePreset('c4');
  assert.equal(matchTine(0, p), null);
  assert.equal(matchTine(NaN, p), null);
});

test('tuning: レイアウトはどれも 1〜8 の並べ替え', () => {
  for (const layout of Object.values(LAYOUTS)) {
    assert.deepEqual([...layout.order].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  }
  assert.deepEqual(LAYOUTS.kalimba.order, [8, 6, 4, 2, 1, 3, 5, 7]);
  assert.deepEqual(LAYOUTS['kalimba-mirror'].order, [7, 5, 3, 1, 2, 4, 6, 8]);
  assert.deepEqual(LAYOUTS.scale.order, [1, 2, 3, 4, 5, 6, 7, 8]);
});
