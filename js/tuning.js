// 音名・周波数・cent 計算、歯のプリセット、周波数から歯へのマッチ。

export const DEGREE_LABELS = ['1', '2', '3', '4', '5', '6', '7', '1̇'];
export const SOLFEGE = ['ド', 'レ', 'ミ', 'ファ', 'ソ', 'ラ', 'シ', 'ド'];

const MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12];
const SOLFEGE_CHROMATIC = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
const EN_CHROMATIC = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const NATURAL_DEGREE = { 0: '1', 2: '2', 4: '3', 5: '4', 7: '5', 9: '6', 11: '7' };

// 低い音から高い音への並びが 8 本の歯の順（index 0 = 度数 1）。
export const PRESETS = {
  c4: { id: 'c4', label: 'C4–C5', rootMidi: 60 },
  c5: { id: 'c5', label: 'C5–C6', rootMidi: 72 },
};

// 左から右へ並ぶ度数。17 音カリンバの「中央が低音で左右交互」の規則から 8 本版を推測したもの。
export const LAYOUTS = {
  kalimba: { id: 'kalimba', label: 'カリンバ (中央が低音)', order: [8, 6, 4, 2, 1, 3, 5, 7] },
  'kalimba-mirror': { id: 'kalimba-mirror', label: 'カリンバ (左右反転)', order: [7, 5, 3, 1, 2, 4, 6, 8] },
  scale: { id: 'scale', label: '音階順 (左が低音)', order: [1, 2, 3, 4, 5, 6, 7, 8] },
};

export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

export function midiToFreq(midi, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function centsBetween(freq, ref) {
  return 1200 * Math.log2(freq / ref);
}

export function noteName(midi) {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return {
    ja: SOLFEGE_CHROMATIC[pc],
    en: `${EN_CHROMATIC[pc]}${octave}`,
    degreeLabel: NATURAL_DEGREE[pc] ?? '',
  };
}

export function makePreset(id, a4 = 440) {
  const def = PRESETS[id];
  if (!def) throw new Error(`未知のプリセット: ${id}`);
  return {
    id: def.id,
    label: def.label,
    freqs: MAJOR_OFFSETS.map((o) => midiToFreq(def.rootMidi + o, a4)),
  };
}

export function calibratedPreset(freqs) {
  return { id: 'custom', label: '実測', freqs: [...freqs].sort((a, b) => a - b) };
}

function nearestTine(freq, preset) {
  let best = null;
  preset.freqs.forEach((ref, i) => {
    const cents = centsBetween(freq, ref);
    if (best === null || Math.abs(cents) < Math.abs(best.cents)) best = { degree: i + 1, cents };
  });
  return best;
}

export function matchTine(freq, preset, { toleranceCents = 40, octaveFree = false } = {}) {
  if (!(freq > 0)) return null;
  const candidates = octaveFree ? [freq, freq * 2, freq / 2] : [freq];
  for (const f of candidates) {
    const hit = nearestTine(f, preset);
    if (Math.abs(hit.cents) <= toleranceCents) return hit;
  }
  return null;
}
