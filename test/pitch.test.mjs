import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../js/pitch.js';
import { renderKalimba } from '../js/synth.js';
import { centsBetween, makePreset } from '../js/tuning.js';
import { dbToGain, gaussianNoise, rmsOf, seededRandom } from './helpers.mjs';

const SR = 48000;
const WINDOW = 2048;
const AFTER = Math.round(0.05 * SR);
const MAX_CENTS = 5;
const CONDITIONS = [
  ['c4', 440],
  ['c4', 442],
  ['c5', 440],
  ['c5', 442],
];

function windowOf(samples) {
  return samples.subarray(AFTER, AFTER + WINDOW);
}

// interferer: 0.2 秒前に弾かれて鳴り続けている別の歯。窓内の RMS が主音より 12 dB 小さくなるよう合わせる。
function mixture(preset, k, { interfererIndex = null, snrDb = null, rand }) {
  const main = Float32Array.from(windowOf(renderKalimba(preset.freqs[k], SR, {})));
  const mainRms = rmsOf(main);
  if (interfererIndex !== null) {
    const lead = Math.round(0.2 * SR);
    const full = renderKalimba(preset.freqs[interfererIndex], SR, { duration: 3 });
    const part = full.subarray(AFTER + lead, AFTER + lead + WINDOW);
    const gain = (mainRms * dbToGain(-12)) / rmsOf(part);
    for (let i = 0; i < WINDOW; i++) main[i] += part[i] * gain;
  }
  if (snrDb !== null) {
    const noise = gaussianNoise(WINDOW, mainRms * dbToGain(-snrDb), rand);
    for (let i = 0; i < WINDOW; i++) main[i] += noise[i];
  }
  return main;
}

function sweep(t, build) {
  let worst = 0;
  let cases = 0;
  for (const [id, a4] of CONDITIONS) {
    const preset = makePreset(id, a4);
    for (let k = 0; k < 8; k++) {
      for (const variant of build(preset, k)) {
        const r = detectPitch(variant.buf, SR);
        const label = `${id} A4=${a4} 度数${k + 1} ${variant.label}`;
        assert.ok(r, `${label}: 検出できない`);
        const cents = centsBetween(r.freq, preset.freqs[k]);
        assert.ok(Math.abs(cents) < 600, `${label}: オクターブ誤り (${cents.toFixed(0)} cent)`);
        assert.ok(Math.abs(cents) <= MAX_CENTS, `${label}: 誤差 ${cents.toFixed(2)} cent`);
        worst = Math.max(worst, Math.abs(cents));
        cases++;
      }
    }
  }
  t.diagnostic(`最大誤差 ${worst.toFixed(2)} cent (${cases} ケース)`);
}

test('pitch: 発音 50ms 後の窓で 4 条件 × 8 音すべて ±5 cent、オクターブ誤りなし', (t) => {
  sweep(t, (preset, k) => [{ label: '単音', buf: mixture(preset, k, { rand: null }) }]);
});

test('pitch: SNR 20dB の白色雑音下でも同じ', (t) => {
  const rand = seededRandom(1);
  sweep(t, (preset, k) => [{ label: '雑音 SNR20dB', buf: mixture(preset, k, { snrDb: 20, rand }) }]);
});

test('pitch: 別の歯の音が -12dB で鳴り続けている状態 (残り 7 本すべて、雑音 SNR20dB つき) でも同じ', (t) => {
  const rand = seededRandom(2);
  sweep(t, (preset, k) => {
    const out = [];
    for (let j = 0; j < 8; j++) {
      if (j === k) continue;
      out.push({ label: `+ 度数${j + 1} (-12dB)`, buf: mixture(preset, k, { interfererIndex: j, snrDb: 20, rand }) });
    }
    return out;
  });
});

test('pitch: 無音とノイズだけでは null', () => {
  const rand = seededRandom(3);
  assert.equal(detectPitch(new Float32Array(WINDOW), SR), null);
  for (const rms of [0.001, 0.01, 0.1, 0.3]) {
    for (let i = 0; i < 5; i++) {
      assert.equal(detectPitch(gaussianNoise(WINDOW, rms, rand), SR), null, `ノイズ rms=${rms}`);
    }
  }
});

test('pitch: 44.1kHz でも同じ精度', () => {
  const sr = 44100;
  const preset = makePreset('c4', 440);
  for (let k = 0; k < 8; k++) {
    const s = renderKalimba(preset.freqs[k], sr, {});
    const off = Math.round(0.05 * sr);
    const r = detectPitch(s.subarray(off, off + WINDOW), sr);
    assert.ok(Math.abs(centsBetween(r.freq, preset.freqs[k])) <= MAX_CENTS);
  }
});
