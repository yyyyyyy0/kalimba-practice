import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../js/analyzer.js';
import { createJudge } from '../js/judge.js';
import { buildChart } from '../js/score.js';
import { SONGS } from '../js/songs.js';
import { centsBetween, makePreset } from '../js/tuning.js';
import { feed, renderStrikes } from './helpers.mjs';

const LEAD = 1;
const MAX_DEGREE = 8;

// 譜面どおりに合成した 1 本の音声を Analyzer へ流し、同じ時計で judge に渡す。
function play(song, { sampleRate, preset, shift = 0, mode = 'timed', chunk }) {
  const chart = buildChart(song);
  const strikes = chart.notes.map((n) => {
    const degree = shift === 0 ? n.degree : n.degree === MAX_DEGREE ? MAX_DEGREE - 1 : n.degree + shift;
    return { time: LEAD + n.time, freq: preset.freqs[degree - 1] };
  });
  const audio = renderStrikes(strikes, sampleRate, LEAD + chart.endTime + 3);
  const judge = createJudge({ notes: chart.notes, mode, octaveFree: false });
  const analyzer = new Analyzer({ sampleRate, getPreset: () => preset, tuner: false });
  const events = [];
  analyzer.onPluck((e) => {
    events.push(e);
    judge.onPluck({ time: e.time - LEAD, degree: e.degree });
  });
  feed(
    audio,
    sampleRate,
    (samples, start) => {
      analyzer.push(samples, start);
      judge.tick(start + samples.length / sampleRate - LEAD);
    },
    chunk,
  );
  return { chart, judge, events };
}

for (const [presetId, sampleRate] of [
  ['c4', 48000],
  ['c5', 44100],
]) {
  test(`pipeline (${presetId}, ${sampleRate}Hz): 全曲を譜面どおりに弾くと miss 0・wrong 0・perfect+great ≥ 95%`, (t) => {
    const preset = makePreset(presetId, 440);
    for (const song of SONGS) {
      const { judge, chart, events } = play(song, { sampleRate, preset });
      const r = judge.result();
      t.diagnostic(
        `${presetId}/${sampleRate} ${song.id.padEnd(9)} perfect ${r.counts.perfect} great ${r.counts.great} good ${r.counts.good} miss ${r.counts.miss} wrong ${r.wrong} (ノーツ ${chart.notes.length}, 検出 ${events.length})`,
      );
      assert.equal(r.counts.miss, 0, `${song.id}: miss`);
      assert.equal(r.wrong, 0, `${song.id}: wrong`);
      assert.equal(events.length, chart.notes.length, `${song.id}: 検出数`);
      assert.ok((r.counts.perfect + r.counts.great) / chart.notes.length >= 0.95, `${song.id}: perfect+great`);
    }
  });
}

// オーディオ機器によっては AudioContext が 96k や 192k で動く。
for (const sampleRate of [44100, 96000, 192000]) {
  test(`pipeline (c4, ${sampleRate}Hz): 音が重なる曲でも miss 0・wrong 0`, (t) => {
    const preset = makePreset('c4', 440);
    for (const song of SONGS.filter((s) => ['repeat', 'ode', 'jingle', 'brahms'].includes(s.id))) {
      const { judge, chart, events } = play(song, { sampleRate, preset });
      const r = judge.result();
      t.diagnostic(`c4/${sampleRate} ${song.id.padEnd(9)} perfect ${r.counts.perfect} great ${r.counts.great} miss ${r.counts.miss} wrong ${r.wrong}`);
      assert.equal(r.counts.miss, 0, `${song.id}: miss`);
      assert.equal(r.wrong, 0, `${song.id}: wrong`);
      assert.equal(events.length, chart.notes.length, `${song.id}: 検出数`);
      assert.ok((r.counts.perfect + r.counts.great) / chart.notes.length >= 0.95, `${song.id}: perfect+great`);
    }
  });
}

test('pipeline: 度数を 1 ずらした音声 (8 は 7) では全曲で hit 0', (t) => {
  const preset = makePreset('c4', 440);
  for (const song of SONGS) {
    const { judge } = play(song, { sampleRate: 48000, preset, shift: 1 });
    const r = judge.result();
    t.diagnostic(`shift ${song.id.padEnd(9)} hit ${r.total - r.counts.miss} miss ${r.counts.miss} wrong ${r.wrong}`);
    assert.equal(r.counts.perfect + r.counts.great + r.counts.good, 0, `${song.id}: hit`);
    assert.ok(r.wrong > 0, `${song.id}: wrong が出ない`);
  }
});

test('pipeline: wait モードでも、正しい音を弾けば全ノーツが当たる', () => {
  const preset = makePreset('c4', 440);
  const song = SONGS.find((s) => s.id === 'twinkle');
  const { judge } = play(song, { sampleRate: 48000, preset, mode: 'wait' });
  assert.equal(judge.result().counts.great, judge.result().total);
});

test('analyzer: 発音時刻は打鍵時刻の ±15ms 以内で、push の分割に依存しない', () => {
  const preset = makePreset('c4', 440);
  const song = SONGS.find((s) => s.id === 'mary');
  const sampleRate = 48000;
  const chart = buildChart(song);
  const strikes = chart.notes.map((n) => ({ time: LEAD + n.time, freq: preset.freqs[n.degree - 1] }));
  const audio = renderStrikes(strikes, sampleRate, LEAD + chart.endTime + 3);
  const runs = [];
  for (const chunk of [128, 256, 333, 1000, 4096]) {
    const analyzer = new Analyzer({ sampleRate, getPreset: () => preset, tuner: false });
    const events = [];
    analyzer.onPluck((e) => events.push(e));
    feed(audio, sampleRate, (samples, start) => analyzer.push(samples, start), chunk);
    runs.push(events);
  }
  for (const events of runs) {
    assert.equal(events.length, strikes.length);
    events.forEach((e, i) => {
      assert.ok(Math.abs(e.time - strikes[i].time) <= 0.015);
      assert.equal(e.degree, chart.notes[i].degree);
      assert.ok(Math.abs(e.cents) < 5, `cents ${e.cents}`);
      assert.ok(e.clarity >= 0.8);
    });
  }
  assert.deepEqual(
    runs[0].map((e) => e.degree),
    runs[4].map((e) => e.degree),
  );
});

test('analyzer: 調律のずれは cents に出て、許容外は degree が null', () => {
  const preset = makePreset('c4', 440);
  const sampleRate = 48000;
  const cases = [
    { detune: 18, degree: 3, cents: 18 },
    { detune: -30, degree: 3, cents: -30 },
    { detune: 50, degree: null, cents: null },
  ];
  for (const c of cases) {
    const freq = preset.freqs[2] * 2 ** (c.detune / 1200);
    const audio = renderStrikes([{ time: 0.5, freq }], sampleRate, 2.5);
    const analyzer = new Analyzer({ sampleRate, getPreset: () => preset, tuner: false });
    const events = [];
    analyzer.onPluck((e) => events.push(e));
    feed(audio, sampleRate, (s, start) => analyzer.push(s, start));
    assert.equal(events.length, 1);
    assert.equal(events[0].degree, c.degree);
    assert.ok(Math.abs(centsBetween(events[0].freq, freq)) < 0.5);
    if (c.cents !== null) assert.ok(Math.abs(events[0].cents - c.cents) < 1);
  }
});

test('analyzer: 無音とノイズでは発音イベントを出さない', async () => {
  const { gaussianNoise, seededRandom } = await import('./helpers.mjs');
  const preset = makePreset('c4', 440);
  const analyzer = new Analyzer({ sampleRate: 48000, getPreset: () => preset });
  const events = [];
  analyzer.onPluck((e) => events.push(e));
  feed(new Float32Array(48000 * 2), 48000, (s, start) => analyzer.push(s, start));
  feed(gaussianNoise(48000 * 3, 0.05, seededRandom(9)), 48000, (s, start) => analyzer.push(s, 2 + start));
  assert.equal(events.length, 0);
});

test('analyzer: チューナー読み取りは約 20ms ごとで、持続音の周波数とレベルを返す', () => {
  const preset = makePreset('c4', 440);
  const sampleRate = 48000;
  const audio = renderStrikes([{ time: 0.2, freq: preset.freqs[4] }], sampleRate, 2);
  const analyzer = new Analyzer({ sampleRate, getPreset: () => preset });
  const readings = [];
  const levels = [];
  analyzer.onTuner((r) => readings.push(r));
  analyzer.onLevel((l) => levels.push(l));
  feed(audio, sampleRate, (s, start) => analyzer.push(s, start));
  const gaps = readings.slice(1).map((r, i) => r.time - readings[i].time);
  assert.ok(gaps.every((g) => g > 0.019 && g < 0.023), `間隔 ${gaps[0]}`);
  const sounding = readings.filter((r) => r.time > 0.6 && r.time < 1.5);
  assert.ok(sounding.length > 20);
  for (const r of sounding) {
    assert.ok(r.freq !== null);
    assert.ok(Math.abs(centsBetween(r.freq, preset.freqs[4])) < 1);
    assert.ok(r.rmsDb > -40 && r.rmsDb < 0);
  }
  const silent = readings.filter((r) => r.time < 0.15);
  assert.ok(silent.every((r) => r.freq === null));
  assert.ok(levels.length > 0 && levels[0].db < -60);
});
