// YIN 音高検出 (de Cheveigné & Kawahara 2002) と、窓付き DFT のピークによる周波数の精密化。

import { addSines, fitSines } from './sinefit.js';

const RMS_FLOOR = 1e-4;
const REFINE_RANGE = 0.06;
const NEIGHBOR_ENERGY = 0.03;
const NEIGHBOR_GAIN = 0.5;
const NEIGHBOR_BINS = 3;
const NEIGHBOR_EXCLUDE_BINS = 0.4;
const GOLDEN = (Math.sqrt(5) - 1) / 2;
const hannCache = new Map();

function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

function spectralPower(buf, window, sampleRate, freq) {
  const phase = (2 * Math.PI * freq) / sampleRate;
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  let re = 1;
  let im = 0;
  let sumRe = 0;
  let sumIm = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] * window[i];
    sumRe += v * re;
    sumIm -= v * im;
    const nextRe = re * c - im * s;
    im = re * s + im * c;
    re = nextRe;
  }
  return sumRe * sumRe + sumIm * sumIm;
}

// 片持ち梁の 6.27 倍の倍音は YIN の差分関数の谷を最大 30 cent ほどずらす。
// 倍音は基音から十分離れているので、窓付き DFT のメインローブ上のピークは倍音の影響を受けない。
function hannPeak(buf, sampleRate, coarse, span) {
  const window = hann(buf.length);
  let lo = coarse - span;
  let hi = coarse + span;
  let x1 = hi - GOLDEN * (hi - lo);
  let x2 = lo + GOLDEN * (hi - lo);
  let p1 = spectralPower(buf, window, sampleRate, x1);
  let p2 = spectralPower(buf, window, sampleRate, x2);
  for (let i = 0; i < 24; i++) {
    if (p1 < p2) {
      lo = x1;
      x1 = x2;
      p1 = p2;
      x2 = lo + GOLDEN * (hi - lo);
      p2 = spectralPower(buf, window, sampleRate, x2);
    } else {
      hi = x2;
      x2 = x1;
      p2 = p1;
      x1 = hi - GOLDEN * (hi - lo);
      p1 = spectralPower(buf, window, sampleRate, x1);
    }
  }
  return (lo + hi) / 2;
}

function energyOf(buf) {
  let e = 0;
  for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
  return e;
}

// freqs[which] だけを動かし、最小二乗フィットの残差エネルギーが最小になる周波数を黄金分割で探す。
function minimizeResidual(buf, sampleRate, freqs, which, span) {
  const cost = (f) => {
    const trial = freqs.slice();
    trial[which] = f;
    const coeffs = fitSines(buf, 0, trial, sampleRate);
    return energyOf(subtractSines(buf, trial, coeffs, sampleRate));
  };
  let lo = freqs[which] - span;
  let hi = freqs[which] + span;
  let x1 = hi - GOLDEN * (hi - lo);
  let x2 = lo + GOLDEN * (hi - lo);
  let c1 = cost(x1);
  let c2 = cost(x2);
  for (let i = 0; i < 16; i++) {
    if (c1 > c2) {
      lo = x1;
      x1 = x2;
      c1 = c2;
      x2 = lo + GOLDEN * (hi - lo);
      c2 = cost(x2);
    } else {
      hi = x2;
      x2 = x1;
      c2 = c1;
      x1 = hi - GOLDEN * (hi - lo);
      c1 = cost(x1);
    }
  }
  return (lo + hi) / 2;
}

function subtractSines(buf, freqs, coeffs, sampleRate) {
  const out = Float64Array.from(buf);
  addSines(coeffs, freqs, sampleRate, 0, out, -1);
  return out;
}

// 隣の歯の音が同時に鳴っていると、DFT のピークはその方向へ最大 20 cent ほど引かれる。
// 単一正弦波を引いた残差にまだ目立つピークが近くに残るときだけ、2 本を交互に推定し直す。
function refineFrequency(buf, sampleRate, coarse, neighbor) {
  const binHz = sampleRate / buf.length;
  const span = Math.min(coarse * REFINE_RANGE, 1.5 * binHz);
  let f1 = hannPeak(buf, sampleRate, coarse, span);

  const total = energyOf(buf);
  const single = fitSines(buf, 0, [f1], sampleRate);
  const residual = subtractSines(buf, [f1], single, sampleRate);
  const singleEnergy = energyOf(residual);
  if (!neighbor || singleEnergy < NEIGHBOR_ENERGY * total) return f1;

  const window = hann(buf.length);
  let f2 = null;
  let best = 0;
  for (let k = -NEIGHBOR_BINS * 4; k <= NEIGHBOR_BINS * 4; k++) {
    const f = f1 + (k * binHz) / 4;
    if (Math.abs(f - f1) < NEIGHBOR_EXCLUDE_BINS * binHz || f <= 0) continue;
    const p = spectralPower(residual, window, sampleRate, f);
    if (p > best) {
      best = p;
      f2 = f;
    }
  }
  if (f2 === null) return f1;

  const freqs = [f1, f2];
  for (let pass = 0; pass < 2; pass++) {
    for (let which = 0; which < 2; which++) {
      freqs[which] = minimizeResidual(buf, sampleRate, freqs, which, binHz / 2);
    }
  }
  const pair = fitSines(buf, 0, freqs, sampleRate);
  // 2 本目が本物なら残差は大きく減る。減らないなら雑音や遠い音を拾っただけなので 1 本の推定を使う。
  if (energyOf(subtractSines(buf, freqs, pair, sampleRate)) > NEIGHBOR_GAIN * singleEnergy) return f1;
  f1 = freqs[0];
  return f1;
}

// 別の歯の音が重なると基音の谷が閾値を超え、倍の周期の谷が先に閾値を下回ることがある。
const LENIENT_THRESHOLD = 0.35;
const SUBMULTIPLE_MAX = 4;

function firstDip(cmnd, from, to, limit) {
  for (let t = from; t < to; t++) {
    if (cmnd[t] < limit) {
      while (t + 1 < to && cmnd[t + 1] < cmnd[t]) t++;
      return t;
    }
  }
  return -1;
}

function pickTau(cmnd, tauMin, tauMax, threshold) {
  let tau = firstDip(cmnd, tauMin, tauMax, threshold);
  if (tau < 0) tau = firstDip(cmnd, tauMin, tauMax, LENIENT_THRESHOLD);
  if (tau < 0) return -1;

  for (let k = SUBMULTIPLE_MAX; k >= 2; k--) {
    const centre = Math.round(tau / k);
    const slack = Math.max(2, Math.round(centre * 0.03));
    const lo = Math.max(tauMin, centre - slack);
    const hi = Math.min(tauMax - 1, centre + slack);
    if (hi <= lo) continue;
    let best = lo;
    for (let t = lo; t <= hi; t++) if (cmnd[t] < cmnd[best]) best = t;
    if (cmnd[best] < LENIENT_THRESHOLD) return best;
  }
  return tau;
}

// neighbor=false は隣の歯との 2 本推定 (数 ms かかる) を省く。残響を引いたあとの窓や、毎フレーム呼ぶ場面向け。
export function detectPitch(buf, sampleRate, { minFreq = 150, maxFreq = 2200, threshold = 0.12, neighbor = true } = {}) {
  const n = buf.length;
  const tauMax = Math.min(Math.floor(sampleRate / minFreq), n >> 1);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const w = n - tauMax;
  if (tauMax <= tauMin + 2 || w <= 0) return null;

  let energy = 0;
  for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
  if (Math.sqrt(energy / n) < RMS_FLOOR) return null;

  // 累積平均正規化差分関数 d'(tau)。tau=1 から積算しないと正規化の分母が合わない。
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let j = 0; j < w; j++) {
      const diff = buf[j] - buf[j + tau];
      d += diff * diff;
    }
    running += d;
    cmnd[tau] = running > 0 ? (d * tau) / running : 1;
  }

  const tau = pickTau(cmnd, tauMin, tauMax, threshold);
  if (tau < 0) return null;

  let refined = tau;
  if (tau > 1 && tau < tauMax) {
    const s0 = cmnd[tau - 1];
    const s1 = cmnd[tau];
    const s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) refined = tau + (s2 - s0) / denom;
  }
  const freq = refineFrequency(buf, sampleRate, sampleRate / refined, neighbor);
  return { freq, clarity: Math.max(0, Math.min(1, 1 - cmnd[tau])) };
}
