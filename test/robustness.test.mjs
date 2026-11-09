import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../js/analyzer.js';
import { createJudge } from '../js/judge.js';
import { buildChart } from '../js/score.js';
import { SONGS } from '../js/songs.js';
import { makePreset } from '../js/tuning.js';
import { DAMP_SECONDS, dbToGain, feed, renderStrikes, seededRandom } from './helpers.mjs';

// 頑健性の掃引。pipeline.test.mjs の 1 本の音声 (譜面どおり) を、乱数の種と開始位置のずれを振って何通りも流す。
// 打ち直した歯は、前の振動が止まって新しい振動に置き換わる物理で鳴らす (renderStrikes の既定)。
// 打ち直しの位相と振幅が残響とたまたま揃う確率は低く (約 0.1%)、種を 1 通りしか試さないテストでは見えないので、
// 種ごとに違う音を作り、曲のどこかで一度でも取りこぼせば落ちるようにしてある。
const SONG_IDS = ['chords', 'chord-arp', 'twinkle-chords', 'ode-chords', 'canon', 'jingle-chords', 'susanna-chords', 'etude-hard', 'repeat', 'fast-scale'];
const SWEEPS = [
  { sampleRate: 48000, seeds: 5 },
  // 192k は 4 分の 1 に間引いて解析する。間引きの位相が開始位置で変わるので、開始位置を振ること自体に意味がある。
  { sampleRate: 192000, seeds: 3 },
];
const LEAD = 1;
const LEAD_JITTER = 0.01;
const STRUM_MS = 25;

function play(song, { sampleRate, preset, seed }) {
  const chart = buildChart(song);
  const rand = seededRandom(seed * 7919 + song.id.length);
  const lead = LEAD + rand() * LEAD_JITTER;
  const strikes = chart.notes.map((n) => {
    const chord = n.chord !== null;
    return {
      time: lead + n.time + (chord ? (rand() * STRUM_MS) / 1000 : 0),
      freq: preset.freqs[n.degree - 1],
      velocity: chord ? dbToGain((rand() * 2 - 1) * 3) : 1,
    };
  });
  const audio = renderStrikes(strikes, sampleRate, lead + chart.endTime + 3);
  const judge = createJudge({ notes: chart.notes, mode: 'timed', octaveFree: false });
  const analyzer = new Analyzer({ sampleRate, getPreset: () => preset, tuner: false });
  analyzer.onPluck((e) => {
    if (e.tines.length > 0) judge.onPluck({ time: e.time - lead, degrees: e.tines.map((t) => t.degree) });
  });
  feed(audio, sampleRate, (samples, start) => {
    analyzer.push(samples, start);
    judge.tick(start + samples.length / sampleRate - lead);
  });
  return { chart, result: judge.result() };
}

test('renderStrikes: 同じ歯の打ち直しは前の振動を止めて置き換え、別の歯は足し算で重なる', () => {
  const sampleRate = 48000;
  const preset = makePreset('c4', 440);
  const [f1, f2] = preset.freqs;
  const second = renderStrikes([{ time: 0.5, freq: f1 }], sampleRate, 1.5);
  const restruck = renderStrikes([{ time: 0, freq: f1 }, { time: 0.5, freq: f1 }], sampleRate, 1.5);
  const settled = Math.round((0.5 + DAMP_SECONDS + 0.01) * sampleRate);
  let worst = 0;
  for (let i = settled; i < second.length; i++) worst = Math.max(worst, Math.abs(restruck[i] - second[i]));
  assert.ok(worst < 1e-6, `置き換えにならず、前の振動が残る (差 ${worst})`);
  const before = Math.round(0.45 * sampleRate);
  const first = renderStrikes([{ time: 0, freq: f1 }], sampleRate, 1.5);
  assert.equal(restruck[before], first[before], '打ち直しの前は前の振動がそのまま鳴る');

  const stacked = renderStrikes([{ time: 0, freq: f1 }, { time: 0.5, freq: f2 }], sampleRate, 1.5);
  const alone = renderStrikes([{ time: 0.5, freq: f2 }], sampleRate, 1.5);
  const i = Math.round(0.8 * sampleRate);
  assert.ok(Math.abs(stacked[i] - alone[i] - first[i]) < 1e-6, '別の歯は足し算で重なる');
});

for (const { sampleRate, seeds } of SWEEPS) {
  test(`robustness (c4, ${sampleRate}Hz): 和音・打ち直しの多い曲 × 乱数の種 ${seeds} 通り × 開始位置のずれで miss 0・wrong 0`, (t) => {
    const preset = makePreset('c4', 440);
    const failures = [];
    const perSong = [];
    let notes = 0;
    for (const id of SONG_IDS) {
      const song = SONGS.find((s) => s.id === id);
      assert.ok(song, id);
      let miss = 0;
      let wrong = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const { chart, result } = play(song, { sampleRate, preset, seed });
        notes += chart.notes.length;
        miss += result.counts.miss;
        wrong += result.wrong;
        if (result.counts.miss > 0 || result.wrong > 0) failures.push(`${id} 種 ${seed}: miss ${result.counts.miss} wrong ${result.wrong}`);
      }
      perSong.push(`${id} miss ${miss} wrong ${wrong}`);
    }
    t.diagnostic(`${sampleRate}Hz ${seeds} 種: ${perSong.join(' / ')}`);
    t.diagnostic(`${SONG_IDS.length} 曲 × ${seeds} 種、延べ ${notes} ノーツ: 失敗 ${failures.length} 件`);
    assert.deepEqual(failures, []);
  });
}
