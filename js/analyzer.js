// サンプル列を PluckEvent / TunerReading / レベルへ変換する解析器。

import { HOP, OnsetDetector, sensitivityToRiseDb } from './onset.js';
import { detectPitch } from './pitch.js';
import { addSines, fitSines } from './sinefit.js';
import { centsBetween, matchTine } from './tuning.js';

export const DEFAULT_SENSITIVITY = 0.6;

const WINDOW = 2048;
const RING_SIZE = 8192;
const MIN_CLARITY = 0.8;
const MIN_ESTIMATES = 2;
const ESTIMATE_FROM = 0.025;
const ESTIMATE_UNTIL = 0.095;
const TUNER_HOPS = 4;
const TUNER_SMOOTHING = 5;
const RING_MEMORY = 8;
const RING_FIT_SAMPLES = 2048;
const RING_FIT_GAP = 128;
const RING_MERGE_CENTS = 30;

// 窓長などの定数は 44.1k〜48k を前提に決めてある。96k や 192k で動く機器では、
// そのままだと窓が短すぎて残響の当てはめが効かないので、整数分の 1 に間引いてから解析する。
const MIN_ANALYSIS_RATE = 40000;

class Decimator {
  constructor(factor) {
    this.factor = factor;
    const n = 16 * factor + 1;
    const fc = 0.45 / factor;
    const mid = (n - 1) / 2;
    this.taps = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
      this.taps[i] = sinc * w;
      sum += this.taps[i];
    }
    for (let i = 0; i < n; i++) this.taps[i] /= sum;
    this.delay = mid;
    this.history = new Float32Array(n);
    this.pos = 0;
    this.phase = 0;
  }

  process(input) {
    const n = this.taps.length;
    const out = new Float32Array(Math.ceil(input.length / this.factor) + 1);
    let k = 0;
    for (let i = 0; i < input.length; i++) {
      this.history[this.pos] = input[i];
      this.pos = (this.pos + 1) % n;
      if (this.phase === 0) {
        let acc = 0;
        for (let j = 0; j < n; j++) acc += this.taps[j] * this.history[(this.pos + j) % n];
        out[k++] = acc;
      }
      this.phase = (this.phase + 1) % this.factor;
    }
    return out.subarray(0, k);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rmsDb(samples) {
  let e = 0;
  for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
  return 10 * Math.log10(e / samples.length + 1e-12);
}

export class Analyzer {
  constructor({ sampleRate, getPreset, getMatchOpts = () => ({}), sensitivity = DEFAULT_SENSITIVITY, tuner = true }) {
    const factor = Math.max(1, Math.floor(sampleRate / MIN_ANALYSIS_RATE));
    this.decimator = factor > 1 ? new Decimator(factor) : null;
    this.filterDelay = this.decimator ? this.decimator.delay / sampleRate : 0;
    this.sampleRate = sampleRate / factor;
    sampleRate = this.sampleRate;
    this.getPreset = getPreset;
    this.getMatchOpts = getMatchOpts;
    this.tunerEnabled = tuner;
    this.onset = new OnsetDetector({ sampleRate, riseDb: sensitivityToRiseDb(sensitivity) });

    this.ring = new Float32Array(RING_SIZE);
    this.total = 0;
    this.t0 = null;
    this.carry = new Float32Array(HOP);
    this.carryLen = 0;
    this.scratch = new Float32Array(WINDOW);
    this.pending = null;
    this.rings = [];
    this.hopCount = 0;
    this.recentFreqs = [];

    this.pluckHandlers = new Set();
    this.tunerHandlers = new Set();
    this.levelHandlers = new Set();
  }

  setSensitivity(sensitivity) {
    this.onset.riseDb = sensitivityToRiseDb(sensitivity);
  }

  onPluck(cb) {
    this.pluckHandlers.add(cb);
    return () => this.pluckHandlers.delete(cb);
  }

  onTuner(cb) {
    this.tunerHandlers.add(cb);
    return () => this.tunerHandlers.delete(cb);
  }

  onLevel(cb) {
    this.levelHandlers.add(cb);
    return () => this.levelHandlers.delete(cb);
  }

  timeOf(sampleIndex) {
    return this.t0 + sampleIndex / this.sampleRate - this.filterDelay;
  }

  push(samples, startTime) {
    if (this.t0 === null) this.t0 = startTime;
    if (this.decimator) samples = this.decimator.process(samples);
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(HOP - this.carryLen, samples.length - i);
      this.carry.set(samples.subarray(i, i + take), this.carryLen);
      this.carryLen += take;
      i += take;
      if (this.carryLen === HOP) {
        this.processHop(this.carry);
        this.carryLen = 0;
      }
    }
  }

  processHop(hop) {
    const hopStart = this.total;
    for (let i = 0; i < HOP; i++) this.ring[(hopStart + i) % RING_SIZE] = hop[i];
    this.total += HOP;
    this.hopCount++;

    const offset = this.onset.process(hop);
    if (offset >= 0) {
      this.finalize();
      this.pending = this.startPending(hopStart + offset);
    } else if (this.pending) {
      this.collect();
    }

    if (this.hopCount % TUNER_HOPS === 0) this.emitTuner();
  }

  window(endSample) {
    for (let i = 0; i < WINDOW; i++) this.scratch[i] = this.ring[(endSample - WINDOW + i) % RING_SIZE];
    return this.scratch;
  }

  // 前の音がまだ鳴っていると、新しい音の窓は 2 音の混合になり基音が取れない。
  // 発音の直前に鳴っていた歯の正弦波を最小二乗で当てはめ、発音後の窓から引く。
  // 同じ歯の連打でも、外挿した残響を引くので新しい音だけが残る。
  startPending(sample) {
    const sr = this.sampleRate;
    const start = sample - RING_FIT_GAP - RING_FIT_SAMPLES;
    this.rings = this.rings.filter((r) => sample - r.sample < RING_MEMORY * sr);
    let ring = null;
    if (this.rings.length > 0 && start >= 0) {
      const freqs = this.rings.map((r) => r.freq);
      const train = new Float32Array(RING_FIT_SAMPLES);
      for (let i = 0; i < RING_FIT_SAMPLES; i++) train[i] = this.ring[(start + i) % RING_SIZE];
      ring = { freqs, coeffs: fitSines(train, start, freqs, sr) };
    }
    return { sample, estimates: [], ring };
  }

  collect() {
    const sr = this.sampleRate;
    const delay = this.total - this.pending.sample;
    if (delay >= ESTIMATE_FROM * sr && delay <= ESTIMATE_UNTIL * sr && this.total >= WINDOW) {
      const win = this.window(this.total);
      const { ring } = this.pending;
      if (ring) addSines(ring.coeffs, ring.freqs, sr, this.total - WINDOW, win, -1);
      const r = detectPitch(win, sr, { neighbor: !ring });
      if (r && r.clarity >= MIN_CLARITY) this.pending.estimates.push(r);
    }
    if (delay + HOP > ESTIMATE_UNTIL * sr) this.finalize();
  }

  finalize() {
    const p = this.pending;
    this.pending = null;
    if (!p || p.estimates.length < MIN_ESTIMATES) return;
    const freq = median(p.estimates.map((e) => e.freq));
    const clarity = median(p.estimates.map((e) => e.clarity));
    this.remember(freq, p.sample);
    const match = matchTine(freq, this.getPreset(), this.getMatchOpts());
    const event = {
      time: this.timeOf(p.sample),
      freq,
      clarity,
      degree: match ? match.degree : null,
      cents: match ? match.cents : null,
    };
    for (const cb of this.pluckHandlers) cb(event);
  }

  remember(freq, sample) {
    this.rings = this.rings.filter((r) => Math.abs(centsBetween(r.freq, freq)) > RING_MERGE_CENTS);
    this.rings.push({ freq, sample });
  }

  emitTuner() {
    if (this.total < WINDOW) return;
    const win = this.window(this.total);
    const db = rmsDb(win.subarray(WINDOW - HOP * TUNER_HOPS));
    for (const cb of this.levelHandlers) cb({ time: this.timeOf(this.total), db });
    if (!this.tunerEnabled) return;

    const r = detectPitch(win, this.sampleRate, { neighbor: false });
    let freq = null;
    let clarity = 0;
    if (r) {
      clarity = r.clarity;
      if (r.clarity >= MIN_CLARITY) {
        this.recentFreqs.push(r.freq);
        if (this.recentFreqs.length > TUNER_SMOOTHING) this.recentFreqs.shift();
        freq = median(this.recentFreqs);
      }
    }
    if (freq === null) this.recentFreqs.length = 0;
    const reading = { time: this.timeOf(this.total), freq, clarity, rmsDb: db };
    for (const cb of this.tunerHandlers) cb(reading);
  }
}
