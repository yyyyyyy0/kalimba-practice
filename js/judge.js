// 判定の状態機械。ChartNote.state は pending → hit | missed の一方向だけ。

export const WINDOWS = { perfect: 0.045, great: 0.09, good: 0.15 };
export const POINTS = { perfect: 1000, great: 700, good: 400, miss: 0 };

const RANK = ['miss', 'good', 'great', 'perfect'];
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

  const isChord = (note) => note.chord !== null && note.chord !== undefined;
  const chordNotes = new Map();
  for (const note of notes) {
    if (!isChord(note)) continue;
    if (!chordNotes.has(note.chord)) chordNotes.set(note.chord, []);
    chordNotes.get(note.chord).push(note);
  }

  // 和音 1 つの現在の状態。worst は当たったノーツのうち最も悪い判定。
  function chordStatus(id) {
    const group = chordNotes.get(id) ?? [];
    const hit = group.filter((n) => n.state === 'hit');
    const worst = hit.reduce((w, n) => (w === null || RANK.indexOf(n.judgement) < RANK.indexOf(w) ? n.judgement : w), null);
    return { id, hit: hit.length, missed: group.filter((n) => n.state === 'missed').length, total: group.length, worst };
  }

  function hitResult(note, judgement, dt) {
    const result = { kind: 'hit', note, judgement };
    if (dt !== undefined) result.dt = dt;
    if (isChord(note)) result.chord = chordStatus(note.chord);
    return result;
  }

  // 当たらなかった度数のうち、wrong に数えるのは 1 回の発音につき 1 回だけ。残りは counted: false で返す。
  function unmatched(degrees, expected) {
    return degrees.map((degree, i) => {
      if (i === 0) return registerWrong(expected, degree);
      return { kind: 'wrong', degree, expected: expected.degree, counted: false };
    });
  }

  function onPluckWait(degrees) {
    const first = nextPending();
    if (!first) return degrees.map(() => ({ kind: 'ignored' }));
    const group = isChord(first) ? chordNotes.get(first.chord) : [first];
    const results = [];
    const missing = [];
    for (const degree of degrees) {
      const note = group.find((n) => n.state === 'pending' && sameTine(n.degree, degree));
      if (!note) {
        missing.push(degree);
        continue;
      }
      registerHit(note, 'great');
      results.push(hitResult(note, 'great'));
    }
    if (missing.length > 0) results.push(...unmatched(missing, group.find((n) => n.state === 'pending') ?? first));
    return results;
  }

  function onPluckTimed(time, degrees) {
    const inWindow = notes.filter((n) => n.state === 'pending' && judgementOf(Math.abs(time - n.time)) !== null);
    const taken = new Set();
    const results = [];
    const missing = [];
    for (const degree of degrees) {
      let best = null;
      for (const note of inWindow) {
        if (taken.has(note) || !sameTine(note.degree, degree)) continue;
        if (best === null || Math.abs(time - note.time) < Math.abs(time - best.time)) best = note;
      }
      if (!best) {
        missing.push(degree);
        continue;
      }
      taken.add(best);
      const dt = time - best.time;
      const judgement = judgementOf(Math.abs(dt));
      registerHit(best, judgement, dt);
      results.push(hitResult(best, judgement, dt));
    }
    if (missing.length === 0) return results;
    if (inWindow.length === 0) return [...results, ...missing.map(() => ({ kind: 'ignored' }))];
    const pool = inWindow.filter((n) => !taken.has(n));
    const candidates = pool.length > 0 ? pool : inWindow;
    const expected = candidates.reduce((a, b) => (Math.abs(time - b.time) < Math.abs(time - a.time) ? b : a));
    return [...results, ...unmatched(missing, expected)];
  }

  // degrees は 1 回の発音 (和音なら複数の歯) で新しく鳴った歯の度数。各度数について hit / wrong / ignored を返す。
  function onPluck({ time, degrees }) {
    const list = [...new Set((degrees ?? []).filter((d) => d !== null && d !== undefined))];
    if (list.length === 0) return [];
    const results = mode === 'wait' ? onPluckWait(list) : onPluckTimed(time, list);
    // 同じ発音で当たった和音のノーツには、発音の終わりの時点の状態を載せる。
    for (const r of results) if (r.chord) r.chord = chordStatus(r.chord.id);
    return results;
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
    const chordTotal = chordNotes.size;
    const complete = [...chordNotes.keys()].filter((id) => chordStatus(id).hit === chordNotes.get(id).length).length;
    return {
      counts: { ...counts },
      chords: { total: chordTotal, complete },
      total,
      wrong: wrongCount,
      accuracy: total > 0 ? hits / total : 0,
      maxCombo,
      combo,
      perDegree,
      score,
    };
  }

  return { notes, mode, onPluck, tick, result, nextPending, chordStatus };
}
