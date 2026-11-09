// 譜面文字列のパーサと検証。ブラウザ API には触れない。

const TOKEN = /^(\d+)(?::(\d*\.?\d+))?$/;
const EPS = 1e-6;

export const SONG_KINDS = ['song', 'drill'];

export function parseScore(score) {
  const notes = [];
  const bars = [];
  let current = [];
  let beat = 0;

  for (const token of score.trim().split(/\s+/)) {
    if (token === '|') {
      bars.push(current);
      current = [];
      continue;
    }
    const m = TOKEN.exec(token);
    if (!m) throw new Error(`譜面のトークンを読めません: "${token}"`);
    const degree = Number(m[1]);
    const beats = m[2] === undefined ? 1 : Number(m[2]);
    if (!(beats > 0)) throw new Error(`拍数が 0 以下です: "${token}"`);
    current.push(beats);
    if (degree !== 0) notes.push({ index: notes.length, degree, beat, beats });
    beat += beats;
  }
  if (current.length > 0 || bars.length === 0) bars.push(current);
  return { notes, bars };
}

export function validateSong(song) {
  const errors = [];
  const where = `[${song?.id ?? '?'}]`;
  if (!song || typeof song.id !== 'string' || !song.id) return ['id がありません'];
  if (!SONG_KINDS.includes(song.kind)) errors.push(`${where} kind は song か drill`);
  if (!(song.bpm > 0)) errors.push(`${where} bpm が正の数ではありません`);
  const bpb = song.beatsPerBar;
  if (!Number.isInteger(bpb) || bpb < 1) {
    errors.push(`${where} beatsPerBar が 1 以上の整数ではありません`);
    return errors;
  }
  if (typeof song.score !== 'string') return [...errors, `${where} score が文字列ではありません`];

  let parsed;
  try {
    parsed = parseScore(song.score);
  } catch (e) {
    return [...errors, `${where} ${e.message}`];
  }
  const { notes, bars } = parsed;

  for (const n of notes) {
    if (!Number.isInteger(n.degree) || n.degree < 0 || n.degree > 8) {
      errors.push(`${where} 度数が範囲外です: ${n.degree} (index ${n.index})`);
    }
  }
  if (notes.length === 0) errors.push(`${where} ノーツがありません`);

  bars.forEach((bar, i) => {
    const sum = bar.reduce((a, b) => a + b, 0);
    const edge = i === 0 || i === bars.length - 1;
    if (edge ? sum > bpb + EPS : Math.abs(sum - bpb) > EPS) {
      const expect = edge ? `${bpb} 以下` : `${bpb}`;
      errors.push(`${where} 小節 ${i + 1}: 拍数 ${sum} (期待 ${expect})`);
    }
  });
  return errors;
}

// time は譜面の最初のノーツを 0 秒とする。速度は所要時間だけを変える。
export function buildChart(song, { speed = 1 } = {}) {
  const { notes } = parseScore(song.score);
  const secPerBeat = 60 / song.bpm / speed;
  const chart = notes.map((n) => ({ ...n, time: n.beat * secPerBeat, state: 'pending' }));
  const last = chart[chart.length - 1];
  return {
    notes: chart,
    secPerBeat,
    countInBeats: song.beatsPerBar,
    endTime: last.time + last.beats * secPerBeat,
  };
}
