import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateLatency, validateCalibration } from '../js/calibrate.js';
import { makePreset } from '../js/tuning.js';

test('calibrate: 昇順で 60 cent 以上離れていれば合格、そうでなければ理由を返す', () => {
  const freqs = makePreset('c4').freqs;
  assert.equal(validateCalibration(freqs), null);
  assert.match(validateCalibration(freqs.slice(0, 7)), /8 本/);
  const swapped = [...freqs];
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.match(validateCalibration(swapped), /低くなっています/);
  const close = [...freqs];
  close[3] = close[2] * 2 ** (50 / 1200);
  assert.match(validateCalibration(close), /近すぎ|離れていません/);
});

test('calibrate: 遅延は各クリックに最も近い発音との差の中央値で、4 個未満なら null', () => {
  const clicks = [1, 1.667, 2.333, 3, 3.667, 4.333, 5, 5.667];
  const plucks = clicks.map((c, i) => c + 0.12 + (i % 2 ? 0.004 : -0.004));
  assert.deepEqual(estimateLatency(clicks, plucks), { ms: 120, matches: 8 });
  assert.equal(estimateLatency(clicks, plucks.slice(0, 3)), null);
  assert.equal(estimateLatency(clicks, []), null);
  const far = clicks.map((c) => c + 0.33);
  assert.equal(estimateLatency(clicks, far), null, '窓の外は対応づけない');
  assert.equal(estimateLatency(clicks, clicks.map((c) => c - 0.05)).ms, -50);
});
