// 譜面文字列のパーサと検証。ブラウザ API には触れない。

import { LAYOUTS } from './tuning.js';

const TOKEN = /^(\d+)(?::(\d*\.?\d+))?$/;
const CHORD_TOKEN = /^\[([^\]]*)\](?::(\d*\.?\d+))?$/;
const EPS = 1e-6;
const CHORD_MIN = 2;
const CHORD_MAX = 4;

export const SONG_KINDS = ['song', 'drill'];
export const MAX_LEVEL = 5;

// 和音 [1 3 5]:2 の括弧の中には空白があるので、空白で割る前に括弧のまとまりを 1 トークンにする。
function tokenize(score) {
  const text = score.trim();
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    let end = i;
    if (text[i] === '[') {
      const close = text.indexOf(']', i);
      if (close < 0 || text.slice(i + 1, close).includes('[')) {
        throw new Error(`和音の括弧が閉じていません: "${text.slice(i, i + 12)}"`);
      }
      end = close + 1;
    }
    while (end < text.length && !/\s/.test(text[end])) end++;
    tokens.push(text.slice(i, end));
    i = end;
  }
  return tokens;
}

function parseChordDegrees(token, inner) {
  const words = inner.trim() === '' ? [] : inner.trim().split(/\s+/);
  if (words.length === 0) throw new Error(`和音が空です: "${token}"`);
  const degrees = words.map((w) => {
    if (!/^\d+$/.test(w)) throw new Error(`和音の度数を読めません: "${w}" ("${token}")`);
    return Number(w);
  });
  if (degrees.includes(0)) throw new Error(`和音に休符は入れられません: "${token}"`);
  if (new Set(degrees).size !== degrees.length) throw new Error(`和音に同じ度数が重複しています: "${token}"`);
  if (degrees.length < CHORD_MIN || degrees.length > CHORD_MAX) {
    throw new Error(`和音は ${CHORD_MIN}〜${CHORD_MAX} 音です: "${token}"`);
  }
  return degrees;
}

export function parseScore(score) {
  const notes = [];
  const bars = [];
  let current = [];
  let beat = 0;
  let chords = 0;

  for (const token of tokenize(score)) {
    if (token === '|') {
      bars.push(current);
      current = [];
      continue;
    }
    const chord = CHORD_TOKEN.exec(token);
    const m = chord ?? TOKEN.exec(token);
    if (!m) throw new Error(`譜面のトークンを読めません: "${token}"`);
    const beats = m[2] === undefined ? 1 : Number(m[2]);
    if (!(beats > 0)) throw new Error(`拍数が 0 以下です: "${token}"`);
    current.push(beats);
    if (chord) {
      const id = chords++;
      for (const degree of parseChordDegrees(token, m[1])) notes.push({ index: notes.length, degree, beat, beats, chord: id });
    } else if (Number(m[1]) !== 0) {
      notes.push({ index: notes.length, degree: Number(m[1]), beat, beats, chord: null });
    }
    beat += beats;
  }
  if (current.length > 0 || bars.length === 0) bars.push(current);
  return { notes, bars };
}

// 親指 2 本で押さえられる和音か。layoutOrder は左から右へ並ぶ度数。
// 並びの中の位置を昇順にして連続した位置のまとまり (run) に分け、
// run が 1 つなら 4 本以下、2 つなら各 3 本以下で左の最大位置 ≤ 4・右の最小位置 ≥ 3 (左右の親指で 1 つずつ) なら押さえられる。
export function playable(degrees, layoutOrder) {
  const positions = degrees.map((d) => layoutOrder.indexOf(d)).sort((a, b) => a - b);
  if (positions.length === 0 || positions[0] < 0) return false;
  const runs = [];
  for (const p of positions) {
    const last = runs[runs.length - 1];
    if (last && p === last[last.length - 1] + 1) last.push(p);
    else runs.push([p]);
  }
  if (runs.length === 1) return runs[0].length <= 4;
  if (runs.length === 2) {
    const [left, right] = runs;
    return left.length <= 3 && right.length <= 3 && left[left.length - 1] <= 4 && right[0] >= 3;
  }
  return false;
}

export function chordsOf(notes) {
  const groups = new Map();
  for (const n of notes) {
    if (n.chord === null || n.chord === undefined) continue;
    if (!groups.has(n.chord)) groups.set(n.chord, []);
    groups.get(n.chord).push(n);
  }
  return [...groups.values()];
}

export const hasChords = (song) => chordsOf(parseScore(song.score).notes).length > 0;

export function validateSong(song) {
  const errors = [];
  const where = `[${song?.id ?? '?'}]`;
  if (!song || typeof song.id !== 'string' || !song.id) return ['id がありません'];
  if (!SONG_KINDS.includes(song.kind)) errors.push(`${where} kind は song か drill`);
  if (!(song.bpm > 0)) errors.push(`${where} bpm が正の数ではありません`);
  if (!Number.isInteger(song.level) || song.level < 1 || song.level > MAX_LEVEL) {
    errors.push(`${where} level は 1〜${MAX_LEVEL} の整数`);
  }
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

  const order = LAYOUTS.kalimba.order;
  for (const group of chordsOf(notes)) {
    const degrees = group.map((n) => n.degree);
    if (degrees.every((d) => d >= 1 && d <= 8) && !playable(degrees, order)) {
      errors.push(`${where} 和音 [${degrees.join(' ')}] は押さえられません (拍 ${group[0].beat})`);
    }
  }

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
