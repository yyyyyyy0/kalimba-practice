// 発音検出。高域寄りの差分エネルギーは爪や指が歯を弾くクリックで立ち上がり、減衰中の音では下がり続ける。
// 1 次差分だと基音・倍音の残響が差分エネルギーの大半を占め、同じ歯の弱い連打や、複数の歯が鳴っている最中の
// 打鍵でクリックとの差が 9 dB に届かない。2 次差分は残響の基音をさらに落とすので、既定は 2 次にしている。

export const HOP = 256;

const FLOOR_MIN_DB = -80;
const FLOOR_RISE_DB_PER_SEC = 3;
const MIN_DB = -120;
const LOCATE_RATIO = 0.3;

// 感度 0..1 を立ち上がり閾値 (dB) に写す。0 → 15 dB、1 → 5 dB。
export function sensitivityToRiseDb(sensitivity) {
  const s = Math.min(1, Math.max(0, sensitivity));
  return 15 - 10 * s;
}

export class OnsetDetector {
  constructor({
    sampleRate,
    riseDb = 9,
    noiseMarginDb = 12,
    refractory = 0.07,
    historySeconds = 0.04,
    order = 2,
  }) {
    this.sampleRate = sampleRate;
    this.riseDb = riseDb;
    this.noiseMarginDb = noiseMarginDb;
    this.refractoryHops = Math.ceil((refractory * sampleRate) / HOP);
    this.floorRisePerHop = (FLOOR_RISE_DB_PER_SEC * HOP) / sampleRate;
    this.history = new Float64Array(Math.max(2, Math.ceil((historySeconds * sampleRate) / HOP)));
    this.filled = 0;
    this.cursor = 0;
    this.floorDb = null;
    this.prevSample = 0;
    this.prevSample2 = 0;
    this.order = order;
    this.sinceOnset = Infinity;
  }

  // 発音があれば hop 内のサンプル位置、なければ -1。
  process(hop) {
    let energy = 0;
    let peak = 0;
    let prev = this.prevSample;
    let prev2 = this.prevSample2;
    for (let i = 0; i < hop.length; i++) {
      const d = this.order === 2 ? hop[i] - 2 * prev + prev2 : hop[i] - prev;
      prev2 = prev;
      prev = hop[i];
      energy += d * d;
      const a = Math.abs(d);
      if (a > peak) peak = a;
    }
    this.prevSample = prev;
    this.prevSample2 = prev2;

    const db = Math.max(MIN_DB, 10 * Math.log10(energy / hop.length + 1e-12));
    this.floorDb =
      this.floorDb === null ? db : Math.min(db, this.floorDb + this.floorRisePerHop);
    const floor = Math.max(FLOOR_MIN_DB, this.floorDb);

    let onset = -1;
    this.sinceOnset++;
    if (this.filled === this.history.length && this.sinceOnset >= this.refractoryHops) {
      // 複数の歯の残響が干渉して一瞬エネルギーが落ちる (うなり) と、dB の平均は引き下げられて誤検出する。
      // 基準はエネルギーの平均を dB にしたものにする。
      let mean = 0;
      for (let i = 0; i < this.history.length; i++) mean += this.history[i];
      const referenceDb = 10 * Math.log10(mean / this.history.length + 1e-12);
      if (db - referenceDb >= this.riseDb && db >= floor + this.noiseMarginDb) {
        onset = this.locate(hop, peak);
        this.sinceOnset = 0;
      }
    }

    this.history[this.cursor] = energy / hop.length;
    this.cursor = (this.cursor + 1) % this.history.length;
    if (this.filled < this.history.length) this.filled++;
    return onset;
  }

  locate(hop, peak) {
    const threshold = peak * LOCATE_RATIO;
    for (let i = 2; i < hop.length; i++) {
      const d = this.order === 2 ? hop[i] - 2 * hop[i - 1] + hop[i - 2] : hop[i] - hop[i - 1];
      if (Math.abs(d) >= threshold) return i;
    }
    return 0;
  }
}
