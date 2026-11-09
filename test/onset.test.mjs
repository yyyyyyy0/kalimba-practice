import test from 'node:test';
import assert from 'node:assert/strict';
import { HOP, OnsetDetector } from '../js/onset.js';
import { makePreset } from '../js/tuning.js';
import { addInto, gaussianNoise, renderStrikes, seededRandom } from './helpers.mjs';

const MAX_ERROR = 0.015;
const preset = makePreset('c4', 440);

function detect(samples, sampleRate, riseDb) {
  const det = new OnsetDetector({ sampleRate, ...(riseDb ? { riseDb } : {}) });
  const times = [];
  for (let i = 0; i + HOP <= samples.length; i += HOP) {
    const offset = det.process(samples.subarray(i, i + HOP));
    if (offset >= 0) times.push((i + offset) / sampleRate);
  }
  return times;
}

function withNoise(samples, rms, rand) {
  return addInto(Float32Array.from(samples), gaussianNoise(samples.length, rms, rand));
}

// 検出数 = 打鍵数、かつ各打鍵との時刻差が MAX_ERROR 以内であることを確かめ、最大の時刻差を返す。
function expectOnsets(strikes, sampleRate, label, rand) {
  const total = strikes[strikes.length - 1].time + 3;
  const audio = withNoise(renderStrikes(strikes, sampleRate, total), 0.003, rand);
  const found = detect(audio, sampleRate);
  assert.equal(found.length, strikes.length, `${label}: 検出 ${found.length} 個 / 打鍵 ${strikes.length} 個 (${found.map((t) => t.toFixed(3)).join(' ')})`);
  let worst = 0;
  strikes.forEach((s, i) => {
    const err = Math.abs(found[i] - s.time);
    assert.ok(err <= MAX_ERROR, `${label}: ${i} 番目の時刻ずれ ${(err * 1000).toFixed(1)} ms`);
    worst = Math.max(worst, err);
  });
  return worst;
}

function patterns() {
  const f = (k) => preset.freqs[k];
  const out = [];
  for (let k = 0; k < 8; k++) {
    out.push([`度数${k + 1} 300ms 間隔の連打`, Array.from({ length: 6 }, (_, i) => ({ time: 0.5 + i * 0.3, freq: f(k) }))]);
    out.push([
      `度数${k + 1} -6dB の弱い再打鍵`,
      Array.from({ length: 6 }, (_, i) => ({ time: 0.5 + i * 0.3, freq: f(k), velocity: i % 2 ? 0.5 : 1 })),
    ]);
  }
  for (const gap of [0.15, 0.2, 0.25]) {
    const up = Array.from({ length: 8 }, (_, i) => ({ time: 0.5 + i * gap, freq: f(i) }));
    const down = Array.from({ length: 8 }, (_, i) => ({ time: 0.5 + (8 + i) * gap, freq: f(7 - i) }));
    out.push([`音階の上り下り ${gap * 1000}ms 間隔 (前の音が鳴っている中の打鍵)`, [...up, ...down]]);
  }
  out.push([
    '強弱をつけた別の歯の打鍵 (250ms)',
    Array.from({ length: 12 }, (_, i) => ({ time: 0.5 + i * 0.25, freq: f((i * 3) % 8), velocity: i % 2 ? 0.5 : 1 })),
  ]);
  const rand = seededRandom(11);
  let t = 0.5;
  out.push([
    '乱数列 (間隔 120〜600ms、強さ 0.5〜1)',
    Array.from({ length: 40 }, () => {
      t += 0.12 + rand() * 0.48;
      return { time: t, freq: f(Math.floor(rand() * 8)), velocity: 0.5 + rand() * 0.5 };
    }),
  ]);
  return out;
}

for (const sampleRate of [48000, 44100]) {
  test(`onset (${sampleRate}Hz): 打鍵列で検出数 = 打鍵数、時刻 ±15ms 以内`, (t) => {
    const rand = seededRandom(5);
    let worst = 0;
    for (const [label, strikes] of patterns()) {
      worst = Math.max(worst, expectOnsets(strikes, sampleRate, label, rand));
    }
    t.diagnostic(`${sampleRate}Hz 最大時刻ずれ ${(worst * 1000).toFixed(1)} ms`);
  });
}

test('onset: 無音・ノイズ・減衰中の単音で誤検出 0', () => {
  const rand = seededRandom(6);
  for (const sampleRate of [48000, 44100]) {
    assert.equal(detect(new Float32Array(sampleRate * 3), sampleRate).length, 0, '無音');
    for (const rms of [0.001, 0.01, 0.1, 0.3]) {
      assert.equal(detect(gaussianNoise(sampleRate * 4, rms, rand), sampleRate).length, 0, `ノイズ rms=${rms}`);
    }
    for (let k = 0; k < 8; k++) {
      const audio = withNoise(renderStrikes([{ time: 0.3, freq: preset.freqs[k] }], sampleRate, 8), 0.003, rand);
      const found = detect(audio, sampleRate);
      assert.equal(found.length, 1, `度数${k + 1} の単音: 発音のあとに誤検出 (${found.map((x) => x.toFixed(2)).join(' ')})`);
    }
  }
});

test('onset: 感度 (riseDb) を上げると弱い打鍵を拾わなくなる', () => {
  const strikes = [
    { time: 0.5, freq: preset.freqs[0] },
    { time: 1.5, freq: preset.freqs[3], velocity: 0.02 },
  ];
  const audio = withNoise(renderStrikes(strikes, 48000, 3), 0.0005, seededRandom(7));
  assert.equal(detect(audio, 48000, 5).length, 2);
  assert.equal(detect(audio, 48000, 15).length, 1);
});
