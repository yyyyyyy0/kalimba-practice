// チューナー画面。大きな音名表示、cent メーター、最寄りの歯、8 本の調律チェック表、入力レベル。

import { StaleOpen } from './audio.js';
import { clear, el } from './dom.js';
import { presetFromSettings } from './settings.js';
import { SOLFEGE, centsBetween, freqToMidi, matchTine, midiToFreq, noteName } from './tuning.js';

const METER_RANGE = 50;
const LEVEL_FLOOR_DB = -60;
const GREEN_CENTS = 5;
const YELLOW_CENTS = 15;
const HOLD_SECONDS = 0.6;

export function tuneClass(cents) {
  const a = Math.abs(cents);
  return a <= GREEN_CENTS ? 'good' : a <= YELLOW_CENTS ? 'warn' : 'bad';
}

export function createTuner({ root, store, listener }) {
  const last = new Array(8).fill(null);
  let unsubs = [];
  let simTimer = null;
  let simIndex = 0;
  let lastHeard = -Infinity;
  let active = false;

  const ui = {
    name: el('div', { class: 'tuner-name', id: 'tuner-name' }, '—'),
    en: el('div', { class: 'tuner-en' }, ''),
    hz: el('div', { class: 'tuner-hz', id: 'tuner-hz' }, '— Hz'),
    needle: el('div', { class: 'needle' }),
    cents: el('div', { class: 'tuner-cents', id: 'tuner-cents' }, ''),
    nearest: el('div', { class: 'tuner-nearest', id: 'tuner-nearest' }, '音を鳴らしてください'),
    level: el('div', { class: 'level-fill' }),
    message: el('p', { class: 'status', role: 'status' }),
    rows: [],
  };

  function buildTable() {
    ui.rows = Array.from({ length: 8 }, (_, i) => ({
      li: el('li', {}, el('span', { class: 'deg' }, String(i + 1)), el('span', { class: 'sol' }, SOLFEGE[i]), el('span', { class: 'val' }, '—')),
    }));
    return el('ol', { class: 'check-table', id: 'tuner-table' }, ui.rows.map((r) => r.li));
  }

  function render() {
    const meter = el('div', { class: 'cent-meter', 'aria-hidden': 'true' },
      el('div', { class: 'zone' }),
      ui.needle,
      el('span', { class: 'tick t-neg' }, `−${METER_RANGE}`),
      el('span', { class: 'tick t-zero' }, '0'),
      el('span', { class: 'tick t-pos' }, `+${METER_RANGE}`),
    );
    clear(root).append(
      el('h2', {}, 'チューナー'),
      el('section', { class: 'panel tuner-main' }, ui.name, ui.en, ui.hz, meter, ui.cents, ui.nearest,
        el('div', { class: 'input-level', role: 'img', 'aria-label': '入力レベル' }, ui.level)),
      ui.message,
      el('section', { class: 'panel' }, el('h3', {}, '調律チェック'), buildTable(),
        el('p', { class: 'hint' }, '8 本それぞれを弾くと、最後に測ったずれが入ります。緑は ±5 cent 以内、黄は ±15 cent 以内、赤はそれ以上です。')),
      el('section', { class: 'panel' }, el('h3', {}, '調整のしかた'),
        el('p', {}, '振動する部分 (ブリッジから手前の先端まで) を長くすると音が下がり、短くすると上がります。チューニングハンマーで少しずつ叩いて調整してください。')),
    );
    for (let i = 0; i < 8; i++) paintRow(i);
  }

  function paintRow(i) {
    const row = ui.rows[i];
    const v = last[i];
    row.li.className = v === null ? '' : tuneClass(v);
    row.li.querySelector('.val').textContent = v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(0)} cent`;
  }

  function showReading(r) {
    if (r.freq === null) {
      if (r.time - lastHeard > HOLD_SECONDS) {
        ui.name.textContent = '—';
        ui.en.textContent = '';
        ui.hz.textContent = '— Hz';
        ui.cents.textContent = '';
        ui.nearest.textContent = '音を鳴らしてください';
        ui.needle.style.left = '50%';
        ui.needle.className = 'needle idle';
      }
      return;
    }
    lastHeard = r.time;
    const settings = store.get();
    const midi = freqToMidi(r.freq, settings.a4);
    const nearestMidi = Math.round(midi);
    const cents = centsBetween(r.freq, midiToFreq(nearestMidi, settings.a4));
    const name = noteName(nearestMidi);
    ui.name.textContent = name.ja;
    ui.en.textContent = name.en;
    ui.hz.textContent = `${r.freq.toFixed(1)} Hz`;
    ui.cents.textContent = `${cents > 0 ? '+' : ''}${cents.toFixed(0)} cent`;
    ui.needle.style.left = `${50 + (Math.max(-METER_RANGE, Math.min(METER_RANGE, cents)) / METER_RANGE) * 50}%`;
    ui.needle.className = `needle ${tuneClass(cents)}`;

    const tine = matchTine(r.freq, presetFromSettings(settings), { toleranceCents: 600 });
    if (tine) {
      const sol = SOLFEGE[tine.degree - 1];
      const dir = Math.abs(tine.cents) <= GREEN_CENTS ? '合っています' : tine.cents > 0 ? 'もう少し下げる (高すぎ)' : 'もう少し上げる (低すぎ)';
      ui.nearest.textContent = `最も近い歯: 度数 ${tine.degree} (${sol})  ${tine.cents > 0 ? '+' : ''}${tine.cents.toFixed(0)} cent  ${dir}`;
    }
  }

  // 連続読み取りは弾いた直後に前の歯の残響が混ざるので、表は残響を引いて確定した発音ごとの値で更新する。
  function recordPluck(e) {
    const tine = matchTine(e.freq, presetFromSettings(store.get()), { toleranceCents: 50 });
    if (!tine) return;
    last[tine.degree - 1] = tine.cents;
    paintRow(tine.degree - 1);
  }

  function startSim() {
    const kind = listener.sim;
    if (kind !== 'autoplay' && kind !== 'wrong') return;
    const play = () => {
      const freq = presetFromSettings(store.get()).freqs[simIndex % 8] * (kind === 'wrong' ? 2 ** (20 / 1200) : 1);
      listener.simPluck(freq, listener.ctx.currentTime + 0.05);
      simIndex++;
    };
    play();
    simTimer = setInterval(play, 1400);
  }

  return {
    async enter() {
      active = true;
      render();
      try {
        await listener.open();
      } catch (err) {
        if (err instanceof StaleOpen) return;
        ui.message.className = 'status error';
        ui.message.textContent = err.userMessage ?? 'マイクを開けませんでした。';
        ui.message.append(' ', el('button', { id: 'tuner-retry-btn', class: 'btn small', type: 'button', onclick: () => { ui.message.textContent = ''; this.enter(); } }, 'もう一度試す'));
        return;
      }
      if (!active) return;
      listener.setTunerEnabled(true);
      unsubs.push(listener.analyzer.onTuner(showReading));
      unsubs.push(listener.analyzer.onPluck(recordPluck));
      unsubs.push(
        listener.analyzer.onLevel(({ db }) => {
          ui.level.style.width = `${Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB)) * 100}%`;
        }),
      );
      startSim();
    },
    leave() {
      active = false;
      for (const u of unsubs) u();
      unsubs = [];
      clearInterval(simTimer);
      simTimer = null;
      listener.setTunerEnabled(false);
      listener.close();
    },
  };
}
