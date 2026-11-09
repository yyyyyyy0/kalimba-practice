import { mixEvents, renderKalimba } from '../js/synth.js';

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussianNoise(length, rms, rand) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rand() + 1e-12));
    const phase = 2 * Math.PI * rand();
    out[i] = rms * r * Math.cos(phase);
    if (i + 1 < length) out[i + 1] = rms * r * Math.sin(phase);
  }
  return out;
}

export function rmsOf(samples) {
  let e = 0;
  for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
  return Math.sqrt(e / samples.length);
}

export function dbToGain(db) {
  return 10 ** (db / 20);
}

export function addInto(target, source, gain = 1) {
  for (let i = 0; i < target.length; i++) target[i] += source[i] * gain;
  return target;
}

// 同じ歯を打ち直すと、指が歯に触れて前の振動が止まり、新しい振動に置き換わる (足し算にはならない)。
// 前の打鍵は、同じ周波数の次の打鍵の時刻から DAMP_SECONDS で消す。
export const DAMP_SECONDS = 0.004;
const SAME_TINE_CENTS = 1;

// strikes: [{ time, freq, velocity? }]。各音は十分長く (ほぼ切れずに) 減衰させる。
// 低い歯は時定数 2.5 秒なので 10 秒で約 −35 dB。これより短いと、打鍵から数秒後の残響が窓の途中で急に消えて、
// 実機では起きない「残響の消失」を新しい発音と取り違えることがある。
// replace: false にすると、同じ歯の打鍵も足し算で重ねる (実機にない物理。比較用)。
export function renderStrikes(strikes, sampleRate, totalSeconds, { duration = 10, replace = true } = {}) {
  const events = strikes.map(({ time, freq, velocity = 1 }, i) => {
    const samples = renderKalimba(freq, sampleRate, { duration, velocity });
    let stop = Infinity;
    if (replace) {
      for (let j = 0; j < strikes.length; j++) {
        const o = strikes[j];
        if (j !== i && o.time > time && o.time < stop && Math.abs(1200 * Math.log2(o.freq / freq)) < SAME_TINE_CENTS) stop = o.time;
      }
    }
    if (stop === Infinity) return { time, samples };
    const cut = Math.max(0, Math.round((stop - time) * sampleRate));
    const fade = Math.max(1, Math.round(DAMP_SECONDS * sampleRate));
    const kept = samples.slice(0, Math.min(samples.length, cut + fade));
    for (let k = cut; k < kept.length; k++) kept[k] *= 0.5 + 0.5 * Math.cos((Math.PI * (k - cut)) / fade);
    return { time, samples: kept };
  });
  return mixEvents(events, sampleRate, totalSeconds);
}

// samples を analyzer 等へ 10 ms ずつ流す。
export function feed(samples, sampleRate, consumer, chunk = Math.round(sampleRate / 100)) {
  for (let i = 0; i < samples.length; i += chunk) {
    consumer(samples.subarray(i, Math.min(samples.length, i + chunk)), i / sampleRate);
  }
}

// 人が和音をストラムしたときの近似。歯ごとに 0〜strumMs のずらしと ±levelDb の強さの揺れを付ける。
export function chordStrikes(preset, degrees, time, { strumMs, levelDb = 3, rand }) {
  return degrees.map((degree) => ({
    time: time + (rand() * strumMs) / 1000,
    freq: preset.freqs[degree - 1],
    velocity: dbToGain((rand() * 2 - 1) * levelDb),
  }));
}
