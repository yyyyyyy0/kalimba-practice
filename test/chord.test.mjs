import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../js/analyzer.js';
import { AMP_BAND, ATTACK_REL, MIN_TONALITY_DB, WITHIN_STRONGEST_DB, detectTines } from '../js/chord.js';
import { chordsOf, parseScore } from '../js/score.js';
import { SONGS } from '../js/songs.js';
import { makePreset } from '../js/tuning.js';
import { chordStrikes, feed, gaussianNoise, renderStrikes, seededRandom } from './helpers.mjs';

const SR = 48000;
const ONSET = 0.5;
const SEEDS = 20;

const key = (degrees) => [...degrees].sort((a, b) => a - b).join(' ');

function uniqueChords() {
  const seen = new Map();
  for (const song of SONGS) {
    for (const group of chordsOf(parseScore(song.score).notes)) {
      const degrees = group.map((n) => n.degree).sort((a, b) => a - b);
      seen.set(key(degrees), degrees);
    }
  }
  return [...seen.values()];
}

// 1 つの和音を無音のあとに鳴らして Analyzer に流し、出た PluckEvent を返す。
function detect(preset, degrees, { strumMs, seed, sampleRate = SR }) {
  const rand = seededRandom(seed);
  const strikes = chordStrikes(preset, degrees, ONSET, { strumMs, rand });
  const audio = renderStrikes(strikes, sampleRate, ONSET + 0.5, { duration: 1 });
  const analyzer = new Analyzer({ sampleRate, getPreset: () => preset, tuner: false });
  const events = [];
  analyzer.onPluck((e) => events.push(e));
  feed(audio, sampleRate, (s, start) => analyzer.push(s, start));
  return events;
}

const tinesOf = (events) => (events.length === 1 ? key(events[0].tines.map((t) => t.degree)) : `イベント ${events.length} 個`);

test('chord: 譜面の全和音 × c4・c5 × 48kHz。ずらし 0ms・15ms は 100%、30ms は 95% 以上で歯の組が完全一致', (t) => {
  const chords = uniqueChords();
  t.diagnostic(`譜面の和音 ${chords.length} 種: ${chords.map(key).join(' | ')}`);
  for (const presetId of ['c4', 'c5']) {
    const preset = makePreset(presetId, 440);
    for (const [strumMs, need] of [[0, 1], [15, 1], [30, 0.95]]) {
      let exact = 0;
      let total = 0;
      const misses = [];
      for (const degrees of chords) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          total++;
          const got = tinesOf(detect(preset, degrees, { strumMs, seed }));
          if (got === key(degrees)) exact++;
          else misses.push(`[${key(degrees)}] seed ${seed} → ${got}`);
        }
      }
      t.diagnostic(`${presetId} ずらし ${strumMs}ms: 完全一致 ${exact}/${total} (${((100 * exact) / total).toFixed(1)}%)${misses.length ? ` 例: ${misses.slice(0, 3).join(', ')}` : ''}`);
      assert.ok(exact / total >= need, `${presetId} ずらし ${strumMs}ms: ${exact}/${total} ${misses.slice(0, 5).join(', ')}`);
    }
  }
});

test('chord subset: 3 音の和音のうち 2 音だけ鳴らすと、その 2 音だけが検出される', (t) => {
  const triads = uniqueChords().filter((c) => c.length === 3);
  for (const presetId of ['c4', 'c5']) {
    const preset = makePreset(presetId, 440);
    let exact = 0;
    let total = 0;
    const misses = [];
    for (const triad of triads) {
      for (let skip = 0; skip < 3; skip++) {
        const pair = triad.filter((_, i) => i !== skip);
        for (let seed = 1; seed <= SEEDS; seed++) {
          total++;
          const got = tinesOf(detect(preset, pair, { strumMs: 15, seed }));
          if (got === key(pair)) exact++;
          else misses.push(`[${key(triad)}] から [${key(pair)}] seed ${seed} → ${got}`);
        }
      }
    }
    t.diagnostic(`${presetId} 2 音だけ: 完全一致 ${exact}/${total}${misses.length ? ` 例: ${misses.slice(0, 3).join(', ')}` : ''}`);
    assert.equal(exact, total, `${presetId}: ${misses.slice(0, 5).join(', ')}`);
  }
});

test('chord: 単音は tines が 1 個で、cents は調律のずれを返す。許容外の歯は組に入れない', () => {
  const preset = makePreset('c4', 440);
  const cases = [
    { detune: 0, expect: [3] },
    { detune: 25, expect: [3] },
    { detune: -30, expect: [3] },
    { detune: 50, expect: [] },
  ];
  for (const c of cases) {
    const freq = preset.freqs[2] * 2 ** (c.detune / 1200);
    const audio = renderStrikes([{ time: ONSET, freq }], SR, ONSET + 0.5, { duration: 1 });
    const analyzer = new Analyzer({ sampleRate: SR, getPreset: () => preset, tuner: false });
    const events = [];
    analyzer.onPluck((e) => events.push(e));
    feed(audio, SR, (s, start) => analyzer.push(s, start));
    assert.equal(events.length, 1, `detune ${c.detune}`);
    assert.deepEqual(events[0].tines.map((x) => x.degree), c.expect, `detune ${c.detune}`);
    if (c.expect.length > 0) assert.ok(Math.abs(events[0].tines[0].cents - c.detune) < 1, `cents ${events[0].tines[0].cents}`);
  }
});

test('chord: 前の和音が鳴り続けていても、同じ歯の打ち直しと新しい歯だけが検出される', (t) => {
  const preset = makePreset('c4', 440);
  const sequence = [[1, 3, 5], [1, 3, 5], [5, 7, 2], [4, 6, 8], [2, 4, 6], [2, 5], [3, 5, 7], [3, 5]];
  let exact = 0;
  let total = 0;
  const misses = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = seededRandom(seed);
    const strikes = sequence.flatMap((degrees, i) => chordStrikes(preset, degrees, 0.5 + i * 0.6, { strumMs: 25, rand }));
    const audio = renderStrikes(strikes, SR, 0.5 + sequence.length * 0.6 + 1);
    const analyzer = new Analyzer({ sampleRate: SR, getPreset: () => preset, tuner: false });
    const events = [];
    analyzer.onPluck((e) => events.push(e));
    feed(audio, SR, (s, start) => analyzer.push(s, start));
    assert.equal(events.length, sequence.length, `seed ${seed}: イベント数`);
    sequence.forEach((degrees, i) => {
      total++;
      const got = key(events[i].tines.map((x) => x.degree));
      if (got === key(degrees)) exact++;
      else misses.push(`#${i} [${key(degrees)}] seed ${seed} → ${got}`);
    });
  }
  t.diagnostic(`残響の上の和音 (ずらし 25ms): 完全一致 ${exact}/${total}${misses.length ? ` 例: ${misses.slice(0, 3).join(', ')}` : ''}`);
  assert.equal(exact, total, misses.slice(0, 5).join(', '));
});

// 閾値 (AMP_BAND, ATTACK_REL, MIN_TONALITY_DB, WITHIN_STRONGEST_DB) の根拠。Analyzer を通した実測値を diagnostic に出し、
// 打ち直した歯と鳴り続けているだけの歯、音と雑音のあいだに閾値が入っていることを確かめる。
// 打ち直しは前の振動が止まって置き換わるので、残響を引いた残りの大きさでは分けられない (位相と振幅が揃うと残りが 0 になる)。
// 分ける手がかりは、基音の振幅の比 (AMP_BAND)、位相 (PHASE_DIST)、打たれた直後だけ強い 2 番目のモード (ATTACK_REL)。
test('chord: 閾値の根拠 (打ち直しと残響、音と雑音の分離)', (t) => {
  const sequences = [
    [[1, 3, 5], [5, 7, 2], [1, 3, 5], [4, 6, 8], [1, 3, 5], [2, 4, 6], [2, 4, 6], [3, 5, 7]],
    [[2, 4, 6], [3, 5, 7], [2, 4, 6], [1, 3, 5], [3, 5, 7], [4, 6, 8], [3, 6, 8], [2, 5, 7]],
    [[1, 3], [3, 5], [4, 6], [2, 4], [1, 8], [5, 7], [2, 5], [3, 6], [2, 7]],
    [[1, 3, 5], [1, 3, 5], [5, 7, 2], [4, 6, 8], [2, 4, 6], [2, 5], [3, 5, 7], [3, 5]],
    [[3, 5, 7], [3, 5], [3, 5, 7], [5, 7], [3, 5], [3, 5, 7], [1, 3, 5], [3, 5]],
  ];
  const spacing = 0.7;
  for (const [presetId, sampleRate] of [['c4', 48000], ['c5', 44100]]) {
    const preset = makePreset(presetId, 440);
    const restruckAttack = [];
    const ringAttack = [];
    const ringRatio = [];
    const tonality = [];
    const spread = [];
    for (const sequence of sequences) {
      for (let seed = 1; seed <= 6; seed++) {
        const rand = seededRandom(seed);
        const strikes = sequence.flatMap((degrees, i) => chordStrikes(preset, degrees, 0.5 + i * spacing, { strumMs: 25, rand }));
        const audio = renderStrikes(strikes, sampleRate, 0.5 + sequence.length * spacing + 1);
        const analyzer = new Analyzer({ sampleRate, getPreset: () => preset, tuner: false });
        analyzer.onPluck((e) => {
          const d = analyzer.lastChord;
          const struck = new Set(sequence[Math.round((e.time - 0.5) / spacing)]);
          tonality.push(d.tonalityDb);
          const levels = e.tines.map((x) => x.level);
          if (levels.length > 1) spread.push(Math.max(...levels) - Math.min(...levels));
          for (let k = 0; k < 8; k++) {
            if (!(d.ringAmps[k] > 0) || !(d.attack[k] > 0)) continue;
            (struck.has(k + 1) ? restruckAttack : ringAttack).push(d.attack[k]);
            if (!struck.has(k + 1)) ringRatio.push(d.ratio[k]);
          }
        });
        feed(audio, sampleRate, (s, start) => analyzer.push(s, start));
      }
    }
    const lo = Math.min(...restruckAttack);
    const hi = Math.max(...ringAttack);
    t.diagnostic(`${presetId}/${sampleRate}: 2 番目のモードの比 (その歯の基音に対する振幅) は、打ち直した歯で最小 ${lo.toFixed(3)} (n=${restruckAttack.length})、鳴り続けているだけの歯で最大 ${hi.toFixed(3)} (n=${ringAttack.length})。ATTACK_REL = ${ATTACK_REL}`);
    t.diagnostic(`${presetId}/${sampleRate}: 鳴り続けているだけの歯の (発音後の振幅 / 外挿した残響) は ${Math.min(...ringRatio).toFixed(3)}〜${Math.max(...ringRatio).toFixed(3)}。AMP_BAND = ${AMP_BAND}`);
    t.diagnostic(`${presetId}/${sampleRate}: 発音の tonality 最小 ${Math.min(...tonality).toFixed(1)} dB、同じ発音で検出した歯のレベル差の最大 ${Math.max(...spread).toFixed(1)} dB (WITHIN_STRONGEST_DB = ${WITHIN_STRONGEST_DB})`);
    assert.ok(lo > ATTACK_REL, `${presetId}: 打ち直した歯が閾値を下回る ${lo}`);
    assert.ok(hi < ATTACK_REL, `${presetId}: 鳴り続けているだけの歯が閾値を上回る ${hi}`);
    assert.ok(Math.max(...ringRatio) < AMP_BAND && Math.min(...ringRatio) > 1 / AMP_BAND, `${presetId}: 残響の振幅の比が帯の外 ${Math.min(...ringRatio)}〜${Math.max(...ringRatio)}`);
    assert.ok(Math.min(...tonality) > MIN_TONALITY_DB + 6, `${presetId}: tonality ${Math.min(...tonality)}`);
    assert.ok(Math.max(...spread) < WITHIN_STRONGEST_DB - 6, `${presetId}: レベル差 ${Math.max(...spread)}`);
  }

  const preset = makePreset('c4', 440);
  const noiseTonality = [];
  for (let seed = 1; seed <= 20; seed++) {
    const samples = gaussianNoise(2048, 0.02 * seed, seededRandom(seed));
    const { tines, diagnostic } = detectTines({ pre: null, post: { samples, start: 4800 }, freqs: preset.freqs, sampleRate: SR });
    noiseTonality.push(diagnostic.tonalityDb);
    assert.deepEqual(tines, [], `雑音 seed ${seed}`);
  }
  t.diagnostic(`白色雑音の窓の tonality 最大 ${Math.max(...noiseTonality).toFixed(1)} dB (MIN_TONALITY_DB = ${MIN_TONALITY_DB})`);
  assert.ok(Math.max(...noiseTonality) < MIN_TONALITY_DB - 6);
});
