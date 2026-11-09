// 設定の保存 (localStorage、失敗しても動く) と、設定・キャリブレーション画面。

import { StaleOpen } from './audio.js';
import { CALIBRATION_CLARITY, estimateLatency, validateCalibration } from './calibrate.js';
import { clear, el } from './dom.js';
import { LAYOUTS, PRESETS, calibratedPreset, freqToMidi, makePreset, noteName } from './tuning.js';

const SETTINGS_KEY = 'kalimba-practice.settings.v1';
const BEST_KEY = 'kalimba-practice.best.v1';

export const DEFAULT_SETTINGS = {
  presetId: 'c4',
  a4: 440,
  layout: 'kalimba',
  toleranceCents: 40,
  octaveFree: false,
  sensitivity: 0.6,
  latencyMs: 0,
  deviceId: '',
  speed: 1,
  mode: 'timed',
  scroll: 2.2,
  metronome: true,
  lastSongId: null,
  customFreqs: null,
};

export const SPEEDS = [0.5, 0.75, 1, 1.25];
export const SCROLLS = [
  { value: 3, label: 'ゆっくり' },
  { value: 2.2, label: 'ふつう' },
  { value: 1.6, label: 'はやい' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const custom =
    Array.isArray(r.customFreqs) && r.customFreqs.length === 8 && r.customFreqs.every((f) => num(f, 0) > 0)
      ? r.customFreqs.map(Number)
      : null;
  const presetOk = Object.hasOwn(PRESETS, r.presetId) || (r.presetId === 'custom' && custom);
  return {
    presetId: presetOk ? r.presetId : d.presetId,
    a4: clamp(num(r.a4, d.a4), 415, 466),
    layout: Object.hasOwn(LAYOUTS, r.layout) ? r.layout : d.layout,
    toleranceCents: clamp(Math.round(num(r.toleranceCents, d.toleranceCents)), 20, 50),
    octaveFree: r.octaveFree === true,
    sensitivity: clamp(num(r.sensitivity, d.sensitivity), 0, 1),
    latencyMs: clamp(Math.round(num(r.latencyMs, d.latencyMs)), -200, 500),
    deviceId: typeof r.deviceId === 'string' ? r.deviceId : d.deviceId,
    speed: clamp(num(r.speed, d.speed), 0.5, 1.25),
    mode: r.mode === 'wait' ? 'wait' : 'timed',
    scroll: clamp(num(r.scroll, d.scroll), 1.2, 4),
    metronome: r.metronome !== false,
    lastSongId: typeof r.lastSongId === 'string' ? r.lastSongId : null,
    customFreqs: custom,
  };
}

export function sanitizeBest(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw)) {
    if (v && Number.isFinite(v.score) && Number.isFinite(v.accuracy)) out[id] = { score: v.score, accuracy: v.accuracy };
  }
  return out;
}

export function presetFromSettings(s) {
  if (s.presetId === 'custom' && s.customFreqs) return calibratedPreset(s.customFreqs);
  return makePreset(Object.hasOwn(PRESETS, s.presetId) ? s.presetId : 'c4', s.a4);
}

export function matchOptionsFromSettings(s) {
  return { toleranceCents: s.toleranceCents, octaveFree: s.octaveFree };
}

function browserStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem('kalimba-practice.probe', '1');
    s.removeItem('kalimba-practice.probe');
    return s;
  } catch {
    return null;
  }
}

export function createStore({ storage = browserStorage() } = {}) {
  const memory = new Map();
  const read = (key) => {
    try {
      return storage ? storage.getItem(key) : (memory.get(key) ?? null);
    } catch {
      return memory.get(key) ?? null;
    }
  };
  const write = (key, value) => {
    memory.set(key, value);
    try {
      storage?.setItem(key, value);
    } catch {
      // 保存できなくても、このタブの中では設定を保てる
    }
  };
  const parse = (key) => {
    try {
      return JSON.parse(read(key) ?? 'null');
    } catch {
      return null;
    }
  };

  let settings = sanitizeSettings(parse(SETTINGS_KEY));
  let best = sanitizeBest(parse(BEST_KEY));
  const listeners = new Set();

  return {
    get: () => settings,
    set(patch) {
      settings = sanitizeSettings({ ...settings, ...patch });
      write(SETTINGS_KEY, JSON.stringify(settings));
      for (const cb of listeners) cb(settings);
      return settings;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    bestOf: (songId) => (Object.hasOwn(best, songId) ? best[songId] : null),
    recordBest(songId, { score, accuracy }) {
      const prev = Object.hasOwn(best, songId) ? best[songId] : null;
      if (prev && prev.score >= score) return false;
      best = { ...best, [songId]: { score, accuracy } };
      write(BEST_KEY, JSON.stringify(best));
      return true;
    },
  };
}

const CLICK_BPM = 90;
const CLICK_COUNT = 8;

export function createSettingsScreen({ root, store, listener }) {
  let busy = null;
  let active = false;
  let unsubs = [];
  const status = el('p', { class: 'status', role: 'status' });
  const calibrationBox = el('div', { class: 'calibration' });
  const latencyOut = el('output', { class: 'value' });

  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `status ${kind}`;
  };

  function field(label, control, hint) {
    return el('label', { class: 'field' }, el('span', { class: 'label' }, label), control, hint && el('span', { class: 'hint' }, hint));
  }

  function select(options, value, onChange) {
    const node = el('select', { onchange: () => onChange(node.value) });
    for (const [v, label] of options) node.append(el('option', { value: v, selected: String(v) === String(value) }, label));
    return node;
  }

  function range(min, max, step, value, format, onInput) {
    const out = el('output', { class: 'value' }, format(value));
    const input = el('input', {
      type: 'range', min, max, step, value,
      oninput: () => {
        out.textContent = format(Number(input.value));
        onInput(Number(input.value));
      },
    });
    return el('div', { class: 'range' }, input, out);
  }

  let deviceSelect = null;

  function buildDeviceSelect(options) {
    const current = store.get().deviceId;
    if (current && !options.some(([id]) => id === current)) options = [...options, [current, '保存済みの入力 (見つかりません)']];
    deviceSelect = select(options, current, (v) => {
      store.set({ deviceId: v });
      listener.close();
    });
    return deviceSelect;
  }

  function render() {
    const s = store.get();
    const deviceField = buildDeviceSelect([['', '既定の入力']]);
    const presetOptions = [
      ...Object.values(PRESETS).map((p) => [p.id, p.label]),
      ...(s.customFreqs ? [['custom', '実測 (キャリブレーション)']] : []),
    ];
    clear(root).append(
      el('h2', {}, '設定'),
      el('section', { class: 'panel' },
        el('h3', {}, '楽器'),
        field('調律のプリセット', select(presetOptions, s.presetId, (v) => store.set({ presetId: v }))),
        field('A4 の基準周波数 (Hz)', el('input', {
          type: 'number', min: 415, max: 466, step: 1, value: s.a4,
          onchange: (e) => { store.set({ a4: Number(e.target.value) }); render(); },
        }), '415〜466 Hz。既定は 440 Hz'),
        field('レーンの並び', select(Object.values(LAYOUTS).map((l) => [l.id, l.label]), s.layout, (v) => store.set({ layout: v }))),
      ),
      el('section', { class: 'panel' },
        el('h3', {}, '判定'),
        field('音程の許容 (cent)', range(20, 50, 1, s.toleranceCents, (v) => `±${v}`, (v) => store.set({ toleranceCents: v }))),
        field('', el('label', { class: 'check' },
          el('input', { type: 'checkbox', checked: s.octaveFree, onchange: (e) => store.set({ octaveFree: e.target.checked }) }),
          'オクターブ違いも正解にする (ド と 高いド も同じ扱い)')),
        field('発音の感度', range(0, 1, 0.05, s.sensitivity, (v) => (v < 0.35 ? '低め' : v > 0.75 ? '高め' : 'ふつう'), (v) => {
          store.set({ sensitivity: v });
          listener.applySettings();
        }), '高くすると弱い音も拾いますが、物音にも反応しやすくなります'),
      ),
      el('section', { class: 'panel' },
        el('h3', {}, '入力と遅延'),
        field('マイク', deviceField, 'マイクを許可すると入力デバイスの一覧が出ます'),
        el('div', { class: 'row' }, el('button', { id: 'device-btn', class: 'btn', onclick: loadDevices }, 'マイクを許可して一覧を出す')),
        field('遅延補正 (ms)', el('input', {
          type: 'number', min: -200, max: 500, step: 1, value: s.latencyMs,
          onchange: (e) => store.set({ latencyMs: Number(e.target.value) }),
        }), '音が遅れて検出されるとき、その分だけ時刻を戻します'),
        el('div', { class: 'row' },
          el('button', { id: 'latency-btn', class: 'btn', onclick: runLatency }, '自動補正 (BPM 90 のクリックに合わせて弾く)'),
          latencyOut),
      ),
      el('section', { class: 'panel' },
        el('h3', {}, '調律の実測 (キャリブレーション)'),
        el('p', { class: 'hint' }, '低い音から順に 8 本、1 本ずつ弾いてください。安定した音を聞き取るたびに次の歯へ進みます。'),
        el('div', { class: 'row' }, el('button', { id: 'calibrate-btn', class: 'btn', onclick: runCalibration }, '8 本の実測を始める')),
        calibrationBox,
      ),
      status,
    );
    renderCalibration([]);
  }

  async function open() {
    try {
      await listener.open();
      return active;
    } catch (err) {
      if (!(err instanceof StaleOpen)) setStatus(err.userMessage ?? 'マイクを開けませんでした。', 'error');
      return false;
    }
  }

  async function loadDevices() {
    if (!(await open())) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
    const options = [['', '既定の入力'], ...devices.map((d, i) => [d.deviceId, d.label || `入力 ${i + 1}`])];
    deviceSelect.replaceWith(buildDeviceSelect(options));
    setStatus(`${devices.length} 個の入力デバイスが見つかりました。選び直すと、次に聞き取りを始めるときから切り替わります。`);
  }

  function renderCalibration(freqs, message = '') {
    clear(calibrationBox).append(
      el('ol', { class: 'tine-list' },
        Array.from({ length: 8 }, (_, i) => {
          const f = freqs[i];
          const name = f ? noteName(freqToMidi(f, store.get().a4)) : null;
          return el('li', { class: f ? 'done' : '' }, f ? `${f.toFixed(1)} Hz (${name.ja} ${name.en})` : `${i + 1} 本目 待機中`);
        }),
      ),
      message && el('p', { class: 'status error' }, message),
    );
  }

  // 続けて弾くと前の歯の残響がチューナーの読み取りを引っ張るので、残響を引いたあとの発音ごとの推定で登録する。
  async function runCalibration() {
    if (busy) return;
    busy = 'calibration';
    if (!(await open())) {
      busy = null;
      return;
    }
    const freqs = [];
    renderCalibration(freqs);
    setStatus('1 本目 (いちばん低い歯) を弾いてください。');
    const stop = () => {
      unsub();
      busy = null;
    };
    const unsub = listener.analyzer.onPluck((event) => {
      if (event.clarity < CALIBRATION_CLARITY) return;
      freqs.push(event.freq);
      renderCalibration(freqs);
      if (freqs.length < 8) {
        setStatus(`${freqs.length} 本目を登録しました。${freqs.length + 1} 本目を弾いてください。`);
        return;
      }
      stop();
      const problem = validateCalibration(freqs);
      if (problem) {
        renderCalibration(freqs, problem);
        setStatus('やり直してください。', 'error');
        return;
      }
      store.set({ presetId: 'custom', customFreqs: freqs });
      setStatus('8 本の実測を保存しました。プリセットは「実測」になっています。', 'ok');
      render();
    });
    unsubs.push(stop);

    if (listener.sim === 'autoplay' || listener.sim === 'wrong') {
      const order = presetFreqs();
      const played = listener.sim === 'wrong' ? [...order].reverse() : order;
      const start = listener.ctx.currentTime + 0.3;
      played.forEach((f, i) => listener.simPluck(f, start + i * 1.2));
    }
  }

  const presetFreqs = () => presetFromSettings(store.get()).freqs;

  async function runLatency() {
    if (busy) return;
    busy = 'latency';
    if (!(await open())) {
      busy = null;
      return;
    }
    const ctx = listener.ctx;
    const period = 60 / CLICK_BPM;
    const first = ctx.currentTime + 1;
    const clicks = Array.from({ length: CLICK_COUNT }, (_, i) => first + i * period);
    const plucks = [];
    const unsub = listener.analyzer.onPluck((e) => plucks.push(e.time));
    clicks.forEach((t, i) => listener.click(t, i === 0));
    if (listener.sim === 'autoplay' || listener.sim === 'wrong') clicks.forEach((t) => listener.simPluck(presetFreqs()[0], t));
    setStatus('クリックに合わせて、どれかの歯を弾いてください (8 回)。');
    const finish = () => {
      unsub();
      busy = null;
      const est = estimateLatency(clicks, plucks);
      if (!est) {
        setStatus('合わせた音を 4 回以上聞き取れませんでした。クリックに合わせて弾き直してください。', 'error');
        return;
      }
      store.set({ latencyMs: est.ms });
      latencyOut.textContent = `${est.ms} ms (${est.matches} 回から算出)`;
      setStatus(`遅延補正を ${est.ms} ms にしました。`, 'ok');
      render();
    };
    const timer = setTimeout(finish, (clicks[clicks.length - 1] - ctx.currentTime + 1.2) * 1000);
    unsubs.push(() => {
      clearTimeout(timer);
      unsub();
      busy = null;
    });
  }

  return {
    enter() {
      active = true;
      render();
    },
    leave() {
      active = false;
      for (const u of unsubs) u();
      unsubs = [];
      busy = null;
      listener.close();
    },
  };
}
