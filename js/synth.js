// カリンバ風の合成音。Float32Array を返すだけで、ブラウザ API には触れない。

const OUTPUT_GAIN = 0.6;
const CLICK_SECONDS = 0.003;
const CLICK_AMP = 0.3;
const TAIL_FADE_SECONDS = 0.15;

// 片持ち梁の振動モードは基音の整数倍にならない。
const PARTIALS = [
  { ratio: 1, amp: 1, tau: null },
  { ratio: 6.27, amp: 0.25, tau: 0.12 },
  { ratio: 17.55, amp: 0.08, tau: 0.04 },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// C4 付近 2.5 秒、C6 付近 0.8 秒になるよう対数で補間する。
function fundamentalTau(freq) {
  const tau = 2.5 * (freq / 261.63) ** -0.82;
  return Math.min(2.5, Math.max(0.8, tau));
}

export function renderKalimba(freq, sampleRate, { duration = 2.5, velocity = 1, seed = 1 } = {}) {
  const length = Math.round(duration * sampleRate);
  const out = new Float32Array(length);
  const nyquist = sampleRate / 2;

  for (const p of PARTIALS) {
    const f = freq * p.ratio;
    if (f >= nyquist) continue;
    const tau = p.tau ?? fundamentalTau(freq);
    const w = (2 * Math.PI * f) / sampleRate;
    const decay = Math.exp(-1 / (tau * sampleRate));
    let env = p.amp;
    for (let i = 0; i < length; i++) {
      out[i] += env * Math.sin(w * i);
      env *= decay;
      if (env < 1e-5) break;
    }
  }

  // 爪や指が歯を弾く音。白色雑音の 2 階差分で高域に寄せ、RMS を 1 に揃えてから振幅を掛ける。
  const rand = mulberry32(seed);
  const clickLen = Math.min(length, Math.round(CLICK_SECONDS * sampleRate));
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < clickLen; i++) {
    const n0 = rand() * 2 - 1;
    const hp = (n0 - 2 * n1 + n2) / Math.sqrt(2);
    n2 = n1;
    n1 = n0;
    out[i] += CLICK_AMP * hp * (1 - i / clickLen);
  }

  // バッファの終端で音が切れると、発音検出がクリックと取り違えるステップができる。
  const fade = Math.min(Math.round(TAIL_FADE_SECONDS * sampleRate), length);
  const gain = OUTPUT_GAIN * velocity;
  for (let i = 0; i < length; i++) {
    const tail = length - i;
    const taper = tail < fade ? 0.5 - 0.5 * Math.cos((Math.PI * tail) / fade) : 1;
    out[i] *= gain * taper;
  }
  return out;
}

// メトロノーム用。音程を持たないノイズバースト。
export function renderClick(sampleRate, { accent = false, seed = 7 } = {}) {
  const length = Math.round(0.03 * sampleRate);
  const out = new Float32Array(length);
  const rand = mulberry32(seed);
  const amp = accent ? 0.5 : 0.3;
  let prev = 0;
  for (let i = 0; i < length; i++) {
    const n = rand() * 2 - 1;
    out[i] = amp * (n - prev) * 0.5 * Math.exp(-i / (0.004 * sampleRate));
    prev = n;
  }
  return out;
}

// 複数の音を 1 本のバッファへ重ねる。events は { time, samples }。
export function mixEvents(events, sampleRate, totalSeconds) {
  const out = new Float32Array(Math.ceil(totalSeconds * sampleRate));
  for (const { time, samples } of events) {
    const start = Math.round(time * sampleRate);
    const end = Math.min(out.length, start + samples.length);
    for (let i = Math.max(0, start); i < end; i++) out[i] += samples[i - start];
  }
  return out;
}
