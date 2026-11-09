// 判定の状態機械。ChartNote.state は pending → hit | missed の一方向だけ。

export const WINDOWS = { perfect: 0.045, great: 0.09, good: 0.15 };
export const POINTS = { perfect: 1000, great: 700, good: 400, miss: 0 };

const EPS = 1e-9;
const TRANSITIONS = { pending: ['hit', 'missed'], hit: [], missed: [] };

export function pitchClassOf(degree) {
  return (degree - 1) % 7;
}

export function judgementOf(absDt) {
  if (absDt <= WINDOWS.perfect + EPS) return 'perfect';
  if (absDt <= WINDOWS.great + EPS) return 'great';
  if (absDt <= WINDOWS.good + EPS) return 'good';
  return null;
}

function transition(note, next) {
  if (!TRANSITIONS[note.state].includes(next)) {
    throw new Error(`ノーツ ${note.index}: ${note.state} から ${next} へは遷移できません`);
  }
  note.state = next;
}

export function createJudge({ notes, mode = 'timed', octaveFree = false, confirmDelay = 0.12 }) {
  const counts = { perfect: 0, great: 0, good: 0, miss: 0 };
  const stats = new Map();
  let wrongCount = 0;
  let combo = 0;
  let maxCombo = 0;

  const statOf = (degree) => {
    if (!stats.has(degree)) stats.set(degree, { hit: 0, miss: 0, wrong: 0, dtSum: 0, dtCount: 0 });
    return stats.get(degree);
  };
  const sameTine = (a, b) => (octaveFree ? pitchClassOf(a) === pitchClassOf(b) : a === b);
  const nextPending = () => notes.find((n) => n.state === 'pending') ?? null;

  function registerHit(note, judgement, dt) {
    transition(note, 'hit');
    note.judgement = judgement;
    if (dt !== undefined) note.dt = dt;
    counts[judgement]++;
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    const st = statOf(note.degree);
    st.hit++;
    if (dt !== undefined) {
      st.dtSum += dt;
      st.dtCount++;
    }
  }

  function registerWrong(expected, degree) {
    wrongCount++;
    combo = 0;
    statOf(expected.degree).wrong++;
    return { kind: 'wrong', degree, expected: expected.degree };
  }

  function onPluck({ time, degree }) {
    if (degree === null || degree === undefined) return { kind: 'ignored' };

    if (mode === 'wait') {
      const note = nextPending();
      if (!note) return { kind: 'ignored' };
      if (sameTine(note.degree, degree)) {
        registerHit(note, 'great');
        return { kind: 'hit', note, judgement: 'great' };
      }
      return registerWrong(note, degree);
    }

    let best = null;
    let nearest = null;
    for (const note of notes) {
      if (note.state !== 'pending') continue;
      const dt = time - note.time;
      const abs = Math.abs(dt);
      if (judgementOf(abs) === null) continue;
      if (nearest === null || abs < Math.abs(time - nearest.time)) nearest = note;
      if (sameTine(note.degree, degree) && (best === null || abs < Math.abs(time - best.time))) best = note;
    }
    if (best) {
      const dt = time - best.time;
      const judgement = judgementOf(Math.abs(dt));
      registerHit(best, judgement, dt);
      return { kind: 'hit', note: best, judgement, dt };
    }
    if (nearest) return registerWrong(nearest, degree);
    return { kind: 'ignored' };
  }

  function tick(now) {
    if (mode === 'wait') return [];
    const missed = [];
    for (const note of notes) {
      if (note.state !== 'pending') continue;
      if (now - (note.time + WINDOWS.good + confirmDelay) > EPS) {
        transition(note, 'missed');
        note.judgement = 'miss';
        counts.miss++;
        combo = 0;
        statOf(note.degree).miss++;
        missed.push(note);
      }
    }
    return missed;
  }

  function result() {
    const hits = counts.perfect + counts.great + counts.good;
    const total = notes.length;
    const perDegree = {};
    for (const [degree, st] of stats) {
      perDegree[degree] = {
        hit: st.hit,
        miss: st.miss,
        wrong: st.wrong,
        meanDt: st.dtCount > 0 ? st.dtSum / st.dtCount : null,
      };
    }
    const score = Object.keys(POINTS).reduce((sum, k) => sum + counts[k] * POINTS[k], 0);
    return {
      counts: { ...counts },
      total,
      wrong: wrongCount,
      accuracy: total > 0 ? hits / total : 0,
      maxCombo,
      combo,
      perDegree,
      score,
    };
  }

  return { notes, mode, onPluck, tick, result, nextPending };
}
