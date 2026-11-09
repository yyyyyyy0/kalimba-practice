// サンプル列を PluckEvent / TunerReading / レベルへ変換する解析器。

import { detectTines } from './chord.js';
import { HOP, OnsetDetector, sensitivityToRiseDb } from './onset.js';
import { detectPitch } from './pitch.js';
import { addSines, fitSines } from './sinefit.js';
import { centsBetween, matchTine } from './tuning.js';

export const DEFAULT_SENSITIVITY = 0.6;

const WINDOW = 2048;
const RING_SIZE = 16384;
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
// 和音用の当てはめ窓は発音 + 約 110ms に終わる。ストラムで遅れて鳴る歯も窓に入り、判定の confirmDelay (0.12s) には収まる。
const CHORD_UNTIL = 0.11;
const CHORD_MIN_START = 0.02;
const DEFAULT_TOLERANCE_CENTS = 40;
const KNOWN_MEMORY = 5;
const LEARN_WITHIN_DB = 6;

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
    this.inputRate = sampleRate;
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
    this.knownTines = [];
    // 直近の和音検出の測定値 (残響の振幅、新しい振幅、tonality)。閾値の根拠をテストで読むためのもの。
    this.lastChord = null;

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
    if (this.t0 === null) {
      this.t0 = startTime;
      this.inputSamples = 0;
    }
    // 音声スレッドが処理を飛ばすとブロックの時刻が飛ぶ。サンプル数だけで数えると以後の時刻がずっとずれるので、基準を合わせ直す。
    const drift = startTime - (this.t0 + this.inputSamples / this.inputRate);
    if (Math.abs(drift) > 1 / this.inputRate) this.t0 += drift;
    this.inputSamples += samples.length;
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
      this.finalize(hopStart + offset);
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
    let train = null;
    if (start >= 0) {
      train = new Float32Array(RING_FIT_SAMPLES);
      for (let i = 0; i < RING_FIT_SAMPLES; i++) train[i] = this.ring[(start + i) % RING_SIZE];
    }
    let ring = null;
    if (this.rings.length > 0 && train) {
      const freqs = this.rings.map((r) => r.freq);
      ring = { freqs, coeffs: fitSines(train, start, freqs, sr) };
    }
    return { sample, windows: [], ring, pre: train && { samples: train, start } };
  }

  collect() {
    const sr = this.sampleRate;
    const delay = this.total - this.pending.sample;
    if (delay >= ESTIMATE_FROM * sr && delay <= ESTIMATE_UNTIL * sr && this.total >= WINDOW) {
      this.pending.windows.push({ samples: Float32Array.from(this.window(this.total)), start: this.total - WINDOW });
    }
    if (delay + HOP > CHORD_UNTIL * sr) this.finalize();
  }

  // 単音の音高。窓は集めておくだけにして、和音と判明した発音では YIN を走らせない。
  // 打ち直された歯 (struck) は前の振動が止まって新しい振動に置き換わるので、その歯の残響は引かない。
  estimatePitch(p, struck = []) {
    const sr = this.sampleRate;
    const estimates = [];
    let ring = p.ring;
    if (ring) {
      const keep = ring.freqs.map((f) => !struck.some((t) => Math.abs(centsBetween(f, t.freq)) <= RING_MERGE_CENTS));
      ring = {
        freqs: ring.freqs.filter((_, i) => keep[i]),
        coeffs: ring.coeffs.filter((_, i) => keep[i >> 1]),
      };
      if (ring.freqs.length === 0) ring = null;
    }
    for (const { samples, start } of p.windows) {
      if (ring) addSines(ring.coeffs, ring.freqs, sr, start, samples, -1);
      const r = detectPitch(samples, sr, { neighbor: !ring });
      if (r && r.clarity >= MIN_CLARITY) estimates.push(r);
    }
    return estimates;
  }

  // 発音後の窓 (次の発音が先に来たらその手前まで) で 8 本の歯を当てはめ、新しく鳴り始めた歯の組を返す。
  newTines(p, limit) {
    const sr = this.sampleRate;
    const end = Math.min(p.sample + Math.round(CHORD_UNTIL * sr), this.total, limit);
    const start = end - WINDOW;
    if (start < p.sample + CHORD_MIN_START * sr || start < this.total - RING_SIZE) return [];
    const samples = new Float32Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) samples[i] = this.ring[(start + i) % RING_SIZE];
    const toleranceCents = this.getMatchOpts().toleranceCents ?? DEFAULT_TOLERANCE_CENTS;
    const nominal = this.getPreset().freqs;
    const known = nominal.map((f, k) => (this.knownTines[k]?.nominal === f ? median(this.knownTines[k].freqs) : NaN));
    const { tines, diagnostic } = detectTines({ pre: p.pre, post: { samples, start }, freqs: nominal, known, sampleRate: sr, toleranceCents });
    this.lastChord = diagnostic;
    // 弾かれた歯の周波数を覚え、次からその歯の残響を引くときに使う。1 回の推定は隣の歯の残響に引かれることがあるので、
    // 直近の中央値を使い、誤検出かもしれない弱い歯 (最大から LEARN_WITHIN_DB より下) は覚えない。
    const loudest = Math.max(...tines.map((t) => t.level));
    for (const t of tines) {
      if (t.level < loudest - LEARN_WITHIN_DB) continue;
      const k = t.degree - 1;
      if (this.knownTines[k]?.nominal !== nominal[k]) this.knownTines[k] = { nominal: nominal[k], freqs: [] };
      this.knownTines[k].freqs.push(t.freq);
      if (this.knownTines[k].freqs.length > KNOWN_MEMORY) this.knownTines[k].freqs.shift();
    }
    return tines;
  }

  finalize(limit = Infinity) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    let tines = this.newTines(p, limit);
    const estimates = tines.length >= 2 ? [] : this.estimatePitch(p, tines);
    const hasPitch = estimates.length >= MIN_ESTIMATES;
    if (!hasPitch && tines.length === 0) return;

    const preset = this.getPreset();
    const opts = this.getMatchOpts();
    let freq;
    let clarity;
    if (tines.length >= 2 || !hasPitch) {
      const main = tines.reduce((a, b) => (b.level > a.level ? b : a));
      freq = main.freq;
      clarity = 0;
    } else {
      freq = median(estimates.map((e) => e.freq));
      clarity = median(estimates.map((e) => e.clarity));
    }
    const match = matchTine(freq, preset, opts);
    // 当てはめが新しい歯を出さなくても、単音の推定が歯に一致すればその 1 本として渡す。実機の打ち直しが残響と区別できなかったときの保険で、
    // オクターブ違いを許す設定では、歯の範囲の外の音もここで拾う。
    if (tines.length === 0 && match) {
      tines = [{ degree: match.degree, freq, cents: match.cents, level: null }];
    }
    if (tines.length >= 2) for (const t of tines) this.remember(t.freq, p.sample);
    else this.remember(freq, p.sample);
    const event = {
      time: this.timeOf(p.sample),
      tines,
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
