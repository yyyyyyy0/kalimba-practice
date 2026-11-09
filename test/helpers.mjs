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

// strikes: [{ time, freq, velocity? }]。各音は十分長く (ほぼ切れずに) 減衰させる。
export function renderStrikes(strikes, sampleRate, totalSeconds, { duration = 6 } = {}) {
  const events = strikes.map(({ time, freq, velocity = 1 }) => ({
    time,
    samples: renderKalimba(freq, sampleRate, { duration, velocity }),
  }));
  return mixEvents(events, sampleRate, totalSeconds);
}

// samples を analyzer 等へ 10 ms ずつ流す。
export function feed(samples, sampleRate, consumer, chunk = Math.round(sampleRate / 100)) {
  for (let i = 0; i < samples.length; i += chunk) {
    consumer(samples.subarray(i, Math.min(samples.length, i + chunk)), i / sampleRate);
  }
}
