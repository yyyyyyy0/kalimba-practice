// キャリブレーション (実測の調律・遅延補正) の判定ロジック。純粋関数とクラスだけで、ブラウザ API には触れない。

import { centsBetween } from './tuning.js';

export const MIN_TINE_GAP_CENTS = 60;
// 発音ごとの推定 (前の歯の残響を引いたあとの中央値) がこの clarity 以上のときだけ歯の実測として登録する。
export const CALIBRATION_CLARITY = 0.9;

export function validateCalibration(freqs) {
  if (freqs.length !== 8) return '8 本そろっていません。';
  for (let i = 1; i < freqs.length; i++) {
    const gap = centsBetween(freqs[i], freqs[i - 1]);
    if (gap <= 0) return `${i + 1} 本目が ${i} 本目より低くなっています。低い音から順に弾いてください。`;
    if (gap < MIN_TINE_GAP_CENTS) {
      return `${i} 本目と ${i + 1} 本目が ${Math.round(gap)} cent しか離れていません。同じ歯を二度弾いていないか確かめてください。`;
    }
  }
  return null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 各クリックに最も近い発音との差 (発音 − クリック) の中央値を遅延とする。4 個以上取れたときだけ返す。
export function estimateLatency(clickTimes, pluckTimes, { window = 0.3, minMatches = 4 } = {}) {
  const diffs = [];
  for (const click of clickTimes) {
    let best = null;
    for (const p of pluckTimes) {
      if (best === null || Math.abs(p - click) < Math.abs(best - click)) best = p;
    }
    if (best !== null && Math.abs(best - click) <= window) diffs.push(best - click);
  }
  if (diffs.length < minMatches) return null;
  return { ms: Math.round(median(diffs) * 1000), matches: diffs.length };
}
