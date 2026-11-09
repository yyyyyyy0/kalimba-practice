// 和音の検出。歯の周波数は既知なので、多重ピッチ推定ではなく 8 本の正弦波の最小二乗当てはめで
// 「発音で新しく鳴り始めた歯の組」を求める。ブラウザ API には触れない。

import { addSines, fitSines, refineFrequencies } from './sinefit.js';
import { SECOND_MODE_RATIO, centsBetween } from './tuning.js';

// 発音前に鳴っていた歯の残響を発音後の窓へ外挿するときの、振幅の減衰の時定数 (秒)。
// 歯ごとの本当の値は 0.8〜2.5 秒ほどで、外挿の距離 (約 0.11 秒) では誤差が ±5% ほどに収まる。
export const RING_TAU = 1.3;
// 歯を打ち直すと、指が触れて前の振動は止まり、新しい振動に置き換わる (足し算にはならない)。
// そこで、発音後の窓へ当てはめた歯の係数 p を、発音前の残響を外挿した係数 r と比べて、鳴り続けているだけか、打ち直されたかを決める。
// 鳴り続けているだけなら p ≈ r。振幅の比 |p|/|r| は、外挿の誤差 (上の ±5% ほど) の分しか 1 からずれない。
// 打ち直しなら p は r と無関係な振幅と位相になり、比 |p|/|r| が 1 から離れるか、位相がずれて |p − r|/|r| が大きくなる。
// 位相は周波数のわずかな違いで簡単にずれるので、振幅の比のほうを先に見る。
export const AMP_BAND = 1.1;
// 周波数が過去の打鍵で測ってある歯は、外挿の位相が合うので |p − r|/|r| をこの値で見る。測ってない歯は 2 倍まで許す。
export const PHASE_DIST = 0.2;
// 基音の振幅と位相がたまたま残響と揃った打ち直しは、基音だけでは鳴り続けているだけの歯と見分けがつかない (約 0.1% の打ち直し)。
// 打たれた歯は直後に 2 番目の振動モード (基音の SECOND_MODE_RATIO 倍) が強く、約 0.1 秒で消えるので、鳴り続けているだけの歯にはそれがない。
// 発音後の窓でその周波数の振幅が、基音の振幅の ATTACK_REL 倍以上ある歯は、基音が残響と揃っていても打ち直されたとみなす。
// (最大の歯から WITHIN_STRONGEST_DB 以内の歯だけ。基音が小さい歯は比が雑音で大きくなる。)
export const ATTACK_REL = 0.1;
// 新しく鳴った歯のうち最大のものからこの dB 以内の歯だけを組に入れる。
export const WITHIN_STRONGEST_DB = 20;
// 位相のずれだけで疑った歯は、周波数が過去に測った値から KNOWN_MISMATCH_CENTS 以上ずれて当てはまるなら、鳴り続けているだけとみなす。
// 打ち直した歯は同じ歯なので周波数がほぼ同じ。鳴り続けている歯の周波数が既知の値と違うと外挿の位相がずれて、
// 打ち直しに見えてしまう (近い 2 つの正弦波の差は見かけの周波数がずれ、ブラウザの疑似マイクで +28〜40 cent を観測した)。
export const KNOWN_MISMATCH_CENTS = 15;
// 周波数の精密化の対象にする歯と、残響として外挿する歯の下限 (その窓で最大の歯からの dB)。
export const SIGNIFICANT_DB = 30;
// 当てはめで説明できた新しい歯のエネルギーが、残差のこの dB 以上のときだけ音として扱う (クリックや雑音を弾く)。
export const MIN_TONALITY_DB = 0;
// 周波数の探索幅 (nominal からの cent)。隣の歯との間隔が狭いときは、間隔の半分未満に縮めて 2 本が同じ音に寄らないようにする。
export const REFINE_RANGE_CENTS = 60;
const REFINE_GAP_RATIO = 0.48;
const REFINE_ITERATIONS = 4;
const REFINE_STEP_CENTS = 16;

const db = (ratio) => 10 ** (ratio / 20);

// 窓の中の減衰を RING_TAU で打ち消し、窓の中心の振幅を基準にそろえる。
// 減衰を無視した当てはめでは、8 本が鳴っているときに周波数の推定が数 cent ずれ、残響の引き算が合わなくなる。
function compensate(samples, sampleRate) {
  const n = samples.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i] * Math.exp((i - n / 2) / (RING_TAU * sampleRate));
  return out;
}

function ampsOf(coeffs) {
  const out = new Float64Array(coeffs.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = Math.hypot(coeffs[2 * k], coeffs[2 * k + 1]);
  return out;
}

function energyOf(x) {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return e;
}

// 8 本の歯の振幅と周波数を当てはめる。
// 周波数は公称値から始め、目立つ歯 (最大の歯から SIGNIFICANT_DB 以内) だけを、振幅と同時にガウス・ニュートン法で寄せる。
// 歯を 1 本ずつ寄せると、隣り合う歯 (E と F は 100 cent、窓の長さで 0.84 周期しか違わない) が互いの漏れに引かれて収束しない。
// 目立たない歯と frozen の歯は周波数を動かさず、当てはめには含めて漏れの分だけを担わせる。
// 戻り値は 8 本分の周波数・係数・振幅。
function fitTones(x, start, freqs, bounds, sampleRate, frozen = []) {
  const f = Float64Array.from(freqs);
  let coeffs = fitSines(x, start, f, sampleRate);
  for (let it = 0; it < REFINE_ITERATIONS; it++) {
    const amps = ampsOf(coeffs);
    const top = Math.max(...amps);
    if (top === 0) break;
    const sig = [];
    const rest = [];
    amps.forEach((a, k) => (a >= top * db(-SIGNIFICANT_DB) && !frozen.includes(k) ? sig : rest).push(k));
    if (sig.length === 0) break;
    const others = Float64Array.from(x);
    addSines(rest.flatMap((k) => [coeffs[2 * k], coeffs[2 * k + 1]]), rest.map((k) => f[k]), sampleRate, start, others, -1);
    const next = refineFrequencies(others, sig.map((k) => f[k]), sig.map((k) => bounds[k]), sampleRate, { iterations: 1, maxCents: REFINE_STEP_CENTS });
    sig.forEach((k, j) => {
      f[k] = next[j];
    });
    coeffs = fitSines(x, start, f, sampleRate);
  }
  return { freqs: f, coeffs, amps: ampsOf(coeffs) };
}

function searchBounds(freqs) {
  return freqs.map((f, k) => {
    let gap = Infinity;
    for (let j = 0; j < freqs.length; j++) if (j !== k) gap = Math.min(gap, Math.abs(centsBetween(f, freqs[j])));
    const range = Math.min(REFINE_RANGE_CENTS, gap * REFINE_GAP_RATIO);
    return [f * 2 ** (-range / 1200), f * 2 ** (range / 1200)];
  });
}


// pre: 発音の直前の窓 { samples, start } か null。post: 発音の後の窓。start は絶対サンプル番号。
// known[k]: 歯 k の過去の打鍵で測った周波数 (なければ NaN か未指定)。
// 残響は、歯が弾かれたときに測った周波数で窓へ当てはめる。鳴っている歯が多いと、残響の窓だけでは隣り合う歯の周波数を
// 数 cent の精度で分けられず、その誤差が外挿の位相のずれになって、鳴り続けているだけの歯が新しい発音に見えてしまう。
// 戻り値の tines は度数の昇順。diagnostic は閾値を決める根拠の測定値。
export function detectTines({ pre, post, freqs, known = [], sampleRate, toleranceCents = 40 }) {
  const count = freqs.length;
  const bounds = searchBounds(freqs);
  const start = freqs.map((f, k) => (known[k] > 0 ? known[k] : f));
  const isKnown = (k) => known[k] > 0;
  const knownIdx = freqs.map((_, k) => k).filter(isKnown);
  const n = post.samples.length;
  const y = compensate(post.samples, sampleRate);

  // 発音前に鳴っていた歯の係数を、発音後の窓の中心へ外挿する。
  const ringAmps = new Float64Array(count);
  const ringCoeffs = new Float64Array(count * 2);
  if (pre) {
    const ring = fitTones(compensate(pre.samples, sampleRate), pre.start, start, bounds, sampleRate, knownIdx);
    const gap = post.start + n / 2 - (pre.start + pre.samples.length / 2);
    const decay = Math.exp(-gap / sampleRate / RING_TAU);
    const floor = Math.max(...ring.amps) * db(-SIGNIFICANT_DB);
    for (let k = 0; k < count; k++) {
      if (!(ring.amps[k] > 0 && ring.amps[k] >= floor)) continue;
      ringAmps[k] = ring.amps[k] * decay;
      ringCoeffs[2 * k] = ring.coeffs[2 * k] * decay;
      ringCoeffs[2 * k + 1] = ring.coeffs[2 * k + 1] * decay;
    }
  }
  const ringing = (k) => ringAmps[k] > 0;

  // 発音後の窓を、鳴っていた歯の周波数を固定して当てはめ、外挿した残響 r と比べる。
  const frozenRing = knownIdx.filter(ringing);
  const total = fitTones(y, post.start, start, bounds, sampleRate, frozenRing);
  const ratio = new Float64Array(count);
  const dist = new Float64Array(count);
  const attack = new Float64Array(count);
  const status = [];
  for (let k = 0; k < count; k++) {
    if (!ringing(k)) {
      status.push('new');
      continue;
    }
    ratio[k] = total.amps[k] / ringAmps[k];
    dist[k] = Math.hypot(total.coeffs[2 * k] - ringCoeffs[2 * k], total.coeffs[2 * k + 1] - ringCoeffs[2 * k + 1]) / ringAmps[k];
    if (ratio[k] > AMP_BAND) status.push('struck');
    else if (ratio[k] < 1 / AMP_BAND || dist[k] >= (isKnown(k) ? 1 : 2) * PHASE_DIST) status.push('suspect');
    else status.push('ring');
  }

  // 基音が残響と区別できない歯を、2 番目のモードで確かめる。
  if (status.includes('ring')) {
    const rest = Float64Array.from(y);
    addSines(total.coeffs, total.freqs, sampleRate, post.start, rest, -1);
    const modes = freqs.map((f) => f * SECOND_MODE_RATIO);
    const upper = fitSines(rest, post.start, modes, sampleRate);
    const loud = Math.max(...total.amps) * db(-WITHIN_STRONGEST_DB);
    for (let k = 0; k < count; k++) {
      if (!(total.amps[k] >= loud && modes[k] < 0.45 * sampleRate)) continue;
      attack[k] = Math.hypot(upper[2 * k], upper[2 * k + 1]) / total.amps[k];
      if (status[k] === 'ring' && attack[k] >= ATTACK_REL) status[k] = 'struck';
    }
  }

  // 鳴り続けているだけと判った歯の周波数だけを固定して当てはめ直し、打ち直された歯の周波数を測る。
  const frozenAfter = frozenRing.filter((k) => status[k] === 'ring');
  const fit = frozenAfter.length === frozenRing.length ? total : fitTones(y, post.start, start, bounds, sampleRate, frozenAfter);
  const isNew = (k) => {
    if (status[k] === 'ring') return false;
    if (status[k] !== 'suspect' || !isKnown(k)) return true;
    return Math.abs(centsBetween(fit.freqs[k], known[k])) < KNOWN_MISMATCH_CENTS;
  };
  const candidates = freqs.map((_, k) => k).filter((k) => fit.amps[k] > 0 && isNew(k));
  const top = Math.max(0, ...candidates.map((k) => fit.amps[k]));
  const chosen = candidates.filter((k) => fit.amps[k] >= top * db(-WITHIN_STRONGEST_DB));

  // 近い 2 本の歯 (E と F など) は、雑音だけの窓でも互いに打ち消し合う大きな振幅で当てはまる。
  // 振幅の二乗の和ではなく、選んだ歯が合わさって作る波形のエネルギーで数える。
  const tone = new Float64Array(n);
  const toneCoeffs = chosen.flatMap((k) => [fit.coeffs[2 * k], fit.coeffs[2 * k + 1]]);
  addSines(toneCoeffs, chosen.map((k) => fit.freqs[k]), sampleRate, post.start, tone, 1);
  const residual = Float64Array.from(y);
  addSines(fit.coeffs, fit.freqs, sampleRate, post.start, residual, -1);
  const tonalityDb = 10 * Math.log10((energyOf(tone) + 1e-18) / (energyOf(residual) + 1e-18));

  const tines = [];
  if (tonalityDb >= MIN_TONALITY_DB) {
    for (const k of chosen) {
      const cents = centsBetween(fit.freqs[k], freqs[k]);
      if (Math.abs(cents) > toleranceCents) continue;
      tines.push({ degree: k + 1, freq: fit.freqs[k], cents, level: 20 * Math.log10(fit.amps[k]) });
    }
  }
  return { tines, diagnostic: { tonalityDb, ringAmps, ratio, dist, attack, status, amps: fit.amps, top } };
}
