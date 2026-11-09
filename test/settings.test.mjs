import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, createStore, presetFromSettings, sanitizeBest, sanitizeSettings } from '../js/settings.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

test('settings: 不正な値は範囲内か既定値に直す', () => {
  const s = sanitizeSettings({
    presetId: 'nope', a4: 9999, layout: 'x', toleranceCents: 3, sensitivity: -4, latencyMs: 'a',
    speed: 9, mode: 'zzz', scroll: 0, octaveFree: 'yes', customFreqs: [1, 2],
  });
  assert.equal(s.presetId, 'c4');
  assert.equal(s.a4, 466);
  assert.equal(s.layout, 'kalimba');
  assert.equal(s.toleranceCents, 20);
  assert.equal(s.sensitivity, 0);
  assert.equal(s.latencyMs, 0);
  assert.equal(s.speed, 1.25);
  assert.equal(s.mode, 'timed');
  assert.equal(s.scroll, 1.2);
  assert.equal(s.octaveFree, false);
  assert.equal(s.customFreqs, null);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
});

test('settings: 実測プリセットは 8 本の周波数があるときだけ選べる', () => {
  assert.equal(sanitizeSettings({ presetId: 'custom' }).presetId, 'c4');
  const freqs = [260, 290, 330, 350, 390, 440, 495, 520];
  const s = sanitizeSettings({ presetId: 'custom', customFreqs: freqs });
  assert.equal(s.presetId, 'custom');
  assert.deepEqual(presetFromSettings(s).freqs, freqs);
  assert.equal(presetFromSettings(DEFAULT_SETTINGS).freqs.length, 8);
});

test('settings: store は保存と読み戻しができ、壊れた JSON や保存失敗でも動く', () => {
  const storage = fakeStorage();
  const a = createStore({ storage });
  a.set({ a4: 442, mode: 'wait' });
  assert.equal(createStore({ storage }).get().a4, 442);
  assert.equal(createStore({ storage }).get().mode, 'wait');

  const broken = createStore({ storage: fakeStorage({ 'kalimba-practice.settings.v1': '{oops' }) });
  assert.deepEqual(broken.get(), DEFAULT_SETTINGS);

  const failing = createStore({ storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
  failing.set({ a4: 443 });
  assert.equal(failing.get().a4, 443);

  const none = createStore({ storage: null });
  none.set({ toleranceCents: 25 });
  assert.equal(none.get().toleranceCents, 25);
});

test('settings: ベストスコアは上回ったときだけ更新する', () => {
  const store = createStore({ storage: fakeStorage() });
  assert.equal(store.bestOf('scale'), null);
  assert.equal(store.recordBest('scale', { score: 5000, accuracy: 0.9 }), true);
  assert.equal(store.recordBest('scale', { score: 4000, accuracy: 1 }), false);
  assert.deepEqual(store.bestOf('scale'), { score: 5000, accuracy: 0.9 });
});

test('settings: subscribe は変更を通知し、解除できる', () => {
  const store = createStore({ storage: fakeStorage() });
  const seen = [];
  const off = store.subscribe((s) => seen.push(s.a4));
  store.set({ a4: 441 });
  off();
  store.set({ a4: 442 });
  assert.deepEqual(seen, [441]);
});

test('settings: 壊れたベスト記録やプロトタイプ名でも起動できる値に整える', () => {
  assert.deepEqual(sanitizeBest({ a: { id: 5 }, b: { score: 10, accuracy: 0.5 }, c: null }), { b: { score: 10, accuracy: 0.5 } });
  assert.deepEqual(sanitizeBest('x'), {});
  const s = sanitizeSettings({ presetId: 'constructor', layout: 'toString' });
  assert.equal(s.presetId, sanitizeSettings({}).presetId);
  assert.equal(s.layout, sanitizeSettings({}).layout);
});
