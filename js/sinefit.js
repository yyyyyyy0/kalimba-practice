// 周波数が既知の正弦波の最小二乗フィット。位相は絶対サンプル番号を基準にするので、
// 過去の窓で求めた係数をそのまま先の時刻へ外挿できる。

function solve(a, b, n) {
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r * n + i]) > Math.abs(a[pivot * n + i])) pivot = r;
    if (pivot !== i) {
      for (let c = 0; c < n; c++) {
        const t = a[i * n + c];
        a[i * n + c] = a[pivot * n + c];
        a[pivot * n + c] = t;
      }
      const t = b[i];
      b[i] = b[pivot];
      b[pivot] = t;
    }
    const d = a[i * n + i];
    if (d === 0) continue;
    for (let r = i + 1; r < n; r++) {
      const f = a[r * n + i] / d;
      if (f === 0) continue;
      for (let c = i; c < n; c++) a[r * n + c] -= f * a[i * n + c];
      b[r] -= f * b[i];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= a[i * n + c] * x[c];
    x[i] = a[i * n + i] === 0 ? 0 : s / a[i * n + i];
  }
  return x;
}

// x[i] ≈ Σ a_r cos(w_r (startIndex+i)) + b_r sin(w_r (startIndex+i))。戻り値は [a0, b0, a1, b1, ...]。
export function fitSines(x, startIndex, freqs, sampleRate) {
  const len = x.length;
  const m = freqs.length * 2;
  const basis = new Float64Array(m * len);
  freqs.forEach((f, r) => {
    const w = (2 * Math.PI * f) / sampleRate;
    const dc = Math.cos(w);
    const ds = Math.sin(w);
    let c = Math.cos(w * startIndex);
    let s = Math.sin(w * startIndex);
    const rowC = 2 * r * len;
    const rowS = rowC + len;
    for (let i = 0; i < len; i++) {
      basis[rowC + i] = c;
      basis[rowS + i] = s;
      const nc = c * dc - s * ds;
      s = s * dc + c * ds;
      c = nc;
    }
  });

  const gram = new Float64Array(m * m);
  const rhs = new Float64Array(m);
  for (let p = 0; p < m; p++) {
    const rowP = p * len;
    let r = 0;
    for (let i = 0; i < len; i++) r += basis[rowP + i] * x[i];
    rhs[p] = r;
    for (let q = p; q < m; q++) {
      const rowQ = q * len;
      let g = 0;
      for (let i = 0; i < len; i++) g += basis[rowP + i] * basis[rowQ + i];
      gram[p * m + q] = g;
      gram[q * m + p] = g;
    }
  }
  for (let p = 0; p < m; p++) gram[p * m + p] *= 1 + 1e-9;
  return solve(gram, rhs, m);
}

export function addSines(coeffs, freqs, sampleRate, startIndex, out, sign = 1) {
  const len = out.length;
  freqs.forEach((f, r) => {
    const a = coeffs[2 * r] * sign;
    const b = coeffs[2 * r + 1] * sign;
    const w = (2 * Math.PI * f) / sampleRate;
    const dc = Math.cos(w);
    const ds = Math.sin(w);
    let c = Math.cos(w * startIndex);
    let s = Math.sin(w * startIndex);
    for (let i = 0; i < len; i++) {
      out[i] += a * c + b * s;
      const nc = c * dc - s * ds;
      s = s * dc + c * ds;
      c = nc;
    }
  });
}
