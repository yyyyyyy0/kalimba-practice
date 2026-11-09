// ゲーム画面。曲選択、カウントイン、Canvas 描画、判定の進行、結果。

import { StaleOpen } from './audio.js';
import { clear, el } from './dom.js';
import { WINDOWS, createJudge } from './judge.js';
import { buildChart } from './score.js';
import { SCROLLS, SPEEDS, presetFromSettings } from './settings.js';
import { SONGS } from './songs.js';
import { DEGREE_LABELS, LAYOUTS, SOLFEGE, freqToMidi, noteName } from './tuning.js';

const COUNT_IN_LEAD = 0.5;
const CLICK_IGNORE = 0.02;
const FINISH_DELAY = 0.6;
const DEMO_TAIL = 1.5;
const SIM_WAIT_DELAY = 0.4;
const FLASH_SECONDS = 0.28;
const POPUP_SECONDS = 0.75;

// css/style.css の変数と同じ値。Canvas は CSS 変数を読めないので写している。
const PALETTE = {
  bg: '#14171d',
  lane: '#1a1e26',
  laneAlt: '#171b22',
  line: '#e8d8a8',
  text: '#e6e9ef',
  muted: '#8a93a3',
  perfect: '#f2d98c',
  great: '#8fe3b0',
  good: '#8fc6ff',
  miss: '#ff8a8a',
};
const JUDGEMENT_COLOR = { perfect: PALETTE.perfect, great: PALETTE.great, good: PALETTE.good, miss: PALETTE.miss };
const DEGREE_HUES = [4, 30, 52, 140, 190, 225, 275];

function degreeColor(degree, alpha = 1) {
  const hue = DEGREE_HUES[(degree - 1) % 7];
  const light = degree === 8 ? 76 : 62;
  return `hsla(${hue}, 68%, ${light}%, ${alpha})`;
}

const wrongDegree = (d) => (d === 8 ? 7 : d + 1);
const byId = (id) => SONGS.find((s) => s.id === id);
const stars = (n) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));

export function createGame({ root, store, listener, params }) {
  const kalimba = (window.__kalimba = { state: 'idle', result: null, events: [] });
  const setState = (state) => {
    kalimba.state = state;
  };

  let selectedId = [params.get('song'), store.get().lastSongId, SONGS[0].id].find((id) => id && byId(id));
  const options = {
    speed: Number(params.get('speed')) || store.get().speed,
    mode: params.get('mode') === 'wait' || params.get('mode') === 'timed' ? params.get('mode') : store.get().mode,
  };
  if (!(options.speed >= 0.5 && options.speed <= 1.25)) options.speed = 1;

  let run = null;
  let starting = false;
  let active = false;

  const ui = {
    home: el('section', { id: 'game-home', class: 'view' }),
    play: el('section', { id: 'game-play', class: 'view', hidden: true }),
    result: el('section', { id: 'game-result', class: 'view', hidden: true }),
    error: el('p', { id: 'game-error', class: 'status error', role: 'alert', hidden: true }),
    score: el('span', { class: 'hud-value', id: 'hud-score' }, '0'),
    combo: el('span', { class: 'hud-value', id: 'hud-combo' }, '0'),
    progress: el('div', { class: 'progress-fill' }),
    canvas: el('canvas', { id: 'game-canvas', role: 'img', 'aria-label': 'ノーツが上から落ちてくる譜面' }),
    startBtn: null,
    demoBtn: null,
    songButtons: new Map(),
  };
  const g = ui.canvas.getContext('2d');
  let size = { w: 360, h: 520, dpr: 1 };

  function setError(message) {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function showView(name) {
    ui.home.hidden = name !== 'home';
    ui.play.hidden = name !== 'play';
    ui.result.hidden = name !== 'result';
    if (name === 'play') resize();
  }

  function selectSong(id) {
    selectedId = id;
    store.set({ lastSongId: id });
    for (const [songId, btn] of ui.songButtons) {
      btn.classList.toggle('selected', songId === id);
      btn.setAttribute('aria-pressed', String(songId === id));
    }
  }

  function bestLabel(song) {
    const best = store.bestOf(song.id);
    return best ? `ベスト ${best.score.toLocaleString('ja-JP')} 点 (${Math.round(best.accuracy * 100)}%)` : 'ベスト なし';
  }

  function optionSelect(id, label, items, value, onChange) {
    const select = el('select', { id, onchange: () => onChange(select.value) });
    for (const [v, text] of items) select.append(el('option', { value: v, selected: String(v) === String(value) }, text));
    return el('label', { class: 'field' }, el('span', { class: 'label' }, label), select);
  }

  function renderHome() {
    const settings = store.get();
    ui.songButtons.clear();
    const speedItems = SPEEDS.includes(options.speed) ? SPEEDS : [...SPEEDS, options.speed].sort((a, b) => a - b);
    ui.startBtn = el('button', { id: 'start-btn', class: 'btn primary', type: 'button', onclick: () => begin({ demo: false }) }, 'スタート');
    ui.demoBtn = el('button', { id: 'demo-btn', class: 'btn', type: 'button', onclick: () => begin({ demo: true }) }, 'お手本を見る');

    const list = el('ul', { class: 'song-list' });
    for (const song of SONGS) {
      const note = song.note && el('span', { class: 'song-note' }, `編曲メモ: ${song.note}`);
      const btn = el(
        'button',
        { class: 'song', type: 'button', dataset: { songId: song.id }, onclick: () => selectSong(song.id) },
        el('span', { class: 'song-title' }, song.title),
        el('span', { class: 'song-meta' },
          el('span', { class: `badge kind-${song.kind}` }, song.kind === 'drill' ? '練習' : '曲'),
          el('span', { class: 'level', title: '難易度' }, stars(song.level)),
          el('span', {}, `♩=${song.bpm}`),
          el('span', { class: 'best' }, bestLabel(song))),
        el('span', { class: 'song-credit' }, song.credit),
        note,
      );
      ui.songButtons.set(song.id, btn);
      list.append(el('li', {}, btn));
    }

    clear(ui.home).append(
      el('h2', {}, '曲を選ぶ'),
      list,
      el('section', { class: 'panel options' },
        optionSelect('opt-speed', '速度', speedItems.map((v) => [v, `${Math.round(v * 100)}%`]), options.speed, (v) => {
          options.speed = Number(v);
          store.set({ speed: options.speed });
        }),
        optionSelect('opt-mode', 'モード', [['timed', '通常 (タイミングも判定)'], ['wait', '待ち (正しい音を弾くまで止まる)']], options.mode, (v) => {
          options.mode = v;
          store.set({ mode: v });
        }),
        optionSelect('opt-scroll', 'スクロール速度', SCROLLS.map((s) => [s.value, s.label]), settings.scroll, (v) => store.set({ scroll: Number(v) })),
        el('label', { class: 'check' },
          el('input', { id: 'opt-metronome', type: 'checkbox', checked: settings.metronome, onchange: (e) => store.set({ metronome: e.target.checked }) }),
          'カウントインのメトロノーム音を鳴らす'),
      ),
      el('div', { class: 'row actions' }, ui.startBtn, ui.demoBtn),
      ui.error,
      el('p', { class: 'hint' }, 'スタートするとマイクを使います。カリンバをマイクの近くで弾いてください。'),
    );
    selectSong(selectedId);
  }

  const freqOf = (preset, degree) => preset.freqs[degree - 1];

  async function begin({ demo }) {
    if (run || starting) return;
    starting = true;
    ui.startBtn.disabled = true;
    ui.demoBtn.disabled = true;
    setError('');
    try {
      if (demo) await listener.ensureContext();
      else await listener.open();
    } catch (err) {
      if (!(err instanceof StaleOpen)) setError(err.userMessage ?? 'オーディオを開始できませんでした。');
      ui.startBtn.disabled = false;
      ui.demoBtn.disabled = false;
      starting = false;
      return;
    }
    starting = false;
    if (!active) return;

    const settings = store.get();
    const song = byId(selectedId);
    const preset = presetFromSettings(settings);
    const chart = buildChart(song, { speed: options.speed });
    const mode = options.mode;
    const ctx = listener.ctx;
    const countIn = chart.secPerBeat * chart.countInBeats;
    const origin = ctx.currentTime + COUNT_IN_LEAD + countIn;

    run = {
      song, chart, preset, mode, demo, origin, countIn,
      judge: createJudge({ notes: chart.notes, mode, octaveFree: settings.octaveFree }),
      latency: settings.latencyMs / 1000,
      lookahead: settings.scroll,
      order: LAYOUTS[settings.layout].order,
      events: [],
      clickTimes: [],
      sources: [],
      popups: [],
      lit: new Map(),
      unsubs: [],
      holdSince: null,
      simServed: -1,
      raf: 0,
    };
    kalimba.events = run.events;
    kalimba.result = null;
    setState('countin');
    listener.setTunerEnabled(false);
    updateHud();

    if (settings.metronome) {
      for (let i = 0; i < chart.countInBeats; i++) {
        const t = origin - countIn + i * chart.secPerBeat;
        run.clickTimes.push(t);
        run.sources.push(listener.click(t, i === 0));
      }
    }
    if (demo) {
      for (const n of chart.notes) run.sources.push(listener.playTone(freqOf(preset, n.degree), origin + n.time));
    } else {
      run.unsubs.push(listener.analyzer.onPluck(onPluck), listener.onFrame(onFrame));
      if (mode === 'timed' && (listener.sim === 'autoplay' || listener.sim === 'wrong')) {
        for (const n of chart.notes) {
          const d = listener.sim === 'wrong' ? wrongDegree(n.degree) : n.degree;
          run.sources.push(listener.simPluck(freqOf(preset, d), origin + n.time));
        }
      }
    }
    showView('play');
    run.raf = requestAnimationFrame(frame);
  }

  function stopRun() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    for (const u of run.unsubs) u();
    // 鳴り始めた音を途中で切ると波形が途切れてクリックになり、疑似マイクでは発音と誤検出される。まだ始まっていない音だけ止める。
    const now = listener.ctx.currentTime;
    for (const s of run.sources) if (s.scheduledAt > now) s.stop();
  }

  function abort() {
    if (!run) return;
    stopRun();
    run = null;
    setState('idle');
    listener.close();
    resetHome();
  }

  function resetHome() {
    renderHome();
    showView('home');
  }

  function finish() {
    const finished = run;
    stopRun();
    run = null;
    listener.close();
    if (finished.demo) {
      setState('idle');
      resetHome();
      return;
    }
    const result = { ...finished.judge.result(), songId: finished.song.id, mode: finished.mode, speed: options.speed };
    kalimba.result = result;
    setState('result');
    const newBest = finished.mode === 'timed' && store.recordBest(finished.song.id, result);
    renderResult(finished.song, result, newBest);
    showView('result');
  }

  const gameTime = (ctxTime) => ctxTime - run.origin;

  function onPluck(event) {
    if (!run) return;
    run.events.push(event);
    const t = gameTime(event.time - run.latency);
    if (run.clickTimes.some((c) => Math.abs(event.time - run.latency - c) <= CLICK_IGNORE)) return;
    if (t < -WINDOWS.good) return;
    const result = run.judge.onPluck({ time: t, degree: event.degree });
    const now = listener.ctx.currentTime;
    if (event.degree === null) {
      popup('音程が合いません', PALETTE.muted, now);
      return;
    }
    if (result.kind === 'hit') {
      popup(result.judgement.toUpperCase(), JUDGEMENT_COLOR[result.judgement], now);
      light(result.note.degree, JUDGEMENT_COLOR[result.judgement], now);
    } else if (result.kind === 'wrong') {
      popup(`${SOLFEGE[event.degree - 1]} を弾いた`, PALETTE.miss, now, true);
      light(event.degree, PALETTE.miss, now);
    }
    updateHud();
  }

  function onFrame(endCtxTime) {
    if (!run) return;
    const now = gameTime(endCtxTime - run.latency);
    if (run.judge.tick(now).length > 0) {
      popup('MISS', PALETTE.miss, listener.ctx.currentTime);
      updateHud();
    }
    const notes = run.chart.notes;
    if (notes.every((n) => n.state !== 'pending') && now > notes[notes.length - 1].time + FINISH_DELAY) finish();
  }

  function popup(text, color, at, secondary = false) {
    run.popups.push({ text, color, at, secondary });
    if (run.popups.length > 6) run.popups.shift();
  }

  function light(degree, color, at) {
    run.lit.set(degree, { until: at + FLASH_SECONDS, color });
  }

  function updateHud() {
    const r = run ? run.judge.result() : { score: 0, combo: 0 };
    ui.score.textContent = r.score.toLocaleString('ja-JP');
    ui.combo.textContent = String(r.combo);
  }

  // 待ちモードでは、次の未判定ノーツの時刻で時計を止める (origin を進めて経過を相殺する)。
  function advanceWaitClock(ctxNow) {
    const next = run.judge.nextPending();
    if (!next) return;
    const t = gameTime(ctxNow);
    if (t > next.time) {
      run.origin += t - next.time;
      run.holdSince ??= ctxNow;
    } else {
      run.holdSince = null;
    }
    const sim = listener.sim;
    if (!run.demo && (sim === 'autoplay' || sim === 'wrong') && run.holdSince !== null && ctxNow - run.holdSince >= SIM_WAIT_DELAY && run.simServed !== next.index) {
      run.simServed = next.index;
      const d = sim === 'wrong' ? wrongDegree(next.degree) : next.degree;
      run.sources.push(listener.simPluck(freqOf(run.preset, d), ctxNow + 0.05));
    }
  }

  function frame() {
    if (!run) return;
    const ctxNow = listener.ctx.currentTime;
    if (run.mode === 'wait' && !run.demo) advanceWaitClock(ctxNow);
    const t = gameTime(ctxNow);
    if (t >= 0 && kalimba.state === 'countin') setState('playing');
    if (run.demo) {
      for (const n of run.chart.notes) {
        if (n.state === 'pending' && t >= n.time) {
          n.state = 'hit';
          light(n.degree, degreeColor(n.degree), ctxNow);
        }
      }
      if (t > run.chart.endTime + DEMO_TAIL) return finish();
    }
    draw(t, ctxNow);
    run.raf = requestAnimationFrame(frame);
  }

  function resize() {
    const wrap = ui.canvas.parentElement;
    const w = Math.max(280, Math.floor(wrap?.getBoundingClientRect().width || 360));
    const h = Math.max(420, Math.min(720, Math.floor(window.innerHeight - 240)));
    const dpr = window.devicePixelRatio || 1;
    size = { w, h, dpr };
    ui.canvas.width = Math.round(w * dpr);
    ui.canvas.height = Math.round(h * dpr);
    ui.canvas.style.height = `${h}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (run) draw(gameTime(listener.ctx.currentTime), listener.ctx.currentTime);
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  }

  function draw(t, ctxNow) {
    const { w, h } = size;
    const lanes = run.order;
    const margin = 6;
    const laneW = (w - margin * 2) / 8;
    const judgeY = Math.round(h * 0.6);
    const pps = judgeY / run.lookahead;

    g.clearRect(0, 0, w, h);
    g.fillStyle = PALETTE.bg;
    g.fillRect(0, 0, w, h);
    lanes.forEach((_, i) => {
      g.fillStyle = i % 2 ? PALETTE.laneAlt : PALETTE.lane;
      g.fillRect(margin + i * laneW, 0, laneW, h);
    });

    const laneX = (degree) => margin + lanes.indexOf(degree) * laneW;

    g.strokeStyle = PALETTE.line;
    g.globalAlpha = 0.85;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(margin, judgeY);
    g.lineTo(w - margin, judgeY);
    g.stroke();
    g.globalAlpha = 1;

    const noteH = Math.max(12, Math.min(18, laneW * 0.4));
    for (const note of run.chart.notes) {
      if (note.state === 'hit') continue;
      const y = judgeY - (note.time - t) * pps;
      if (y < -noteH || y > h + noteH) continue;
      const missed = note.state === 'missed';
      g.fillStyle = degreeColor(note.degree, missed ? 0.3 : 1);
      roundRect(laneX(note.degree) + 3, y - noteH / 2, laneW - 6, noteH, 5);
      g.fill();
    }

    for (const [degree, flash] of run.lit) {
      const age = FLASH_SECONDS - (flash.until - ctxNow);
      if (age > FLASH_SECONDS) {
        run.lit.delete(degree);
        continue;
      }
      g.globalAlpha = Math.max(0, 1 - age / FLASH_SECONDS) * 0.55;
      g.fillStyle = flash.color;
      g.fillRect(laneX(degree), judgeY - 46, laneW, 56);
      g.globalAlpha = 1;
    }

    const labelFont = Math.max(11, Math.min(20, laneW * 0.46));
    g.textAlign = 'center';
    lanes.forEach((degree, i) => {
      const cx = margin + (i + 0.5) * laneW;
      const midi = Math.round(freqToMidi(freqOf(run.preset, degree), store.get().a4));
      g.fillStyle = degreeColor(degree);
      g.font = `700 ${labelFont}px system-ui, sans-serif`;
      g.fillText(DEGREE_LABELS[degree - 1], cx, judgeY + 26);
      g.fillStyle = PALETTE.text;
      g.font = `${Math.max(10, labelFont * 0.62)}px system-ui, sans-serif`;
      g.fillText(SOLFEGE[degree - 1], cx, judgeY + 44);
      g.fillStyle = PALETTE.muted;
      g.fillText(noteName(midi).en, cx, judgeY + 59);
    });

    drawTines(judgeY + 72, h - 8, laneW, margin, ctxNow);
    drawPopups(ctxNow, judgeY, w);
    drawCountIn(t, w, judgeY);
    ui.progress.style.width = `${Math.max(0, Math.min(1, t / run.chart.endTime)) * 100}%`;
  }

  function drawTines(top, bottom, laneW, margin, ctxNow) {
    const lanes = run.order;
    const maxLen = Math.max(30, bottom - top);
    g.fillStyle = '#2a303b';
    g.fillRect(margin, top - 4, laneW * 8, 5);
    lanes.forEach((degree, i) => {
      const spread = Math.abs(i - 3.5) / 3.5;
      const len = maxLen * (1 - 0.34 * spread);
      const tw = laneW * 0.44;
      const x = margin + (i + 0.5) * laneW - tw / 2;
      const flash = run.lit.get(degree);
      const lit = flash && flash.until > ctxNow;
      g.fillStyle = lit ? flash.color : '#4a5262';
      roundRect(x, top, tw, len, tw / 2);
      g.fill();
      g.fillStyle = lit ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.12)';
      roundRect(x + tw * 0.18, top + 4, tw * 0.22, len - 10, tw * 0.1);
      g.fill();
    });
  }

  function drawPopups(ctxNow, judgeY, w) {
    run.popups = run.popups.filter((p) => ctxNow - p.at < POPUP_SECONDS);
    for (const p of run.popups) {
      const age = (ctxNow - p.at) / POPUP_SECONDS;
      g.globalAlpha = 1 - age;
      g.fillStyle = p.color;
      g.textAlign = 'center';
      g.font = p.secondary ? '600 15px system-ui, sans-serif' : '800 26px system-ui, sans-serif';
      g.fillText(p.text, w / 2, judgeY - (p.secondary ? 20 : 58) - age * 14);
    }
    g.globalAlpha = 1;
  }

  function drawCountIn(t, w, judgeY) {
    if (t >= 0) return;
    const beatsLeft = Math.ceil(-t / run.chart.secPerBeat - 1e-6);
    if (beatsLeft < 1 || beatsLeft > run.chart.countInBeats) return;
    g.fillStyle = PALETTE.text;
    g.globalAlpha = 0.9;
    g.textAlign = 'center';
    g.font = '800 88px system-ui, sans-serif';
    g.fillText(String(run.chart.countInBeats - beatsLeft + 1), w / 2, judgeY * 0.55);
    g.globalAlpha = 1;
  }

  function renderResult(song, r, newBest) {
    const counts = r.counts;
    const trouble = Object.entries(r.perDegree)
      .map(([d, s]) => ({ degree: Number(d), bad: s.miss + s.wrong, ...s }))
      .filter((s) => s.bad > 0)
      .sort((a, b) => b.bad - a.bad)
      .slice(0, 3);
    const timing = Object.entries(r.perDegree)
      .filter(([, s]) => s.meanDt !== null)
      .sort(([a], [b]) => a - b);
    const stat = (label, value, cls = '') => el('div', { class: `stat ${cls}` }, el('span', { class: 'stat-label' }, label), el('span', { class: 'stat-value' }, value));

    clear(ui.result).append(
      el('h2', {}, `結果: ${song.title}`),
      newBest && el('p', { class: 'status ok' }, 'ベストスコアを更新しました'),
      el('div', { class: 'stats' },
        stat('PERFECT', counts.perfect, 'perfect'), stat('GREAT', counts.great, 'great'),
        stat('GOOD', counts.good, 'good'), stat('MISS', counts.miss, 'miss')),
      el('div', { class: 'stats' },
        stat('精度', `${Math.round(r.accuracy * 100)}%`), stat('最大コンボ', r.maxCombo),
        stat('スコア', r.score.toLocaleString('ja-JP')), stat('誤った音', r.wrong)),
      el('section', { class: 'panel' },
        el('h3', {}, '苦手な歯'),
        trouble.length === 0
          ? el('p', {}, '苦手な歯はありません。')
          : el('ol', { class: 'plain' }, trouble.map((s) => el('li', {}, `度数 ${s.degree} (${SOLFEGE[s.degree - 1]}): ミス ${s.miss}・誤り ${s.wrong}`)))),
      timing.length > 0 && el('section', { class: 'panel' },
        el('h3', {}, '歯ごとの平均ずれ'),
        el('ul', { class: 'plain timing' }, timing.map(([d, s]) => {
          const ms = Math.round(s.meanDt * 1000);
          const word = ms >= 5 ? '遅め' : ms <= -5 ? '早め' : 'ちょうど';
          return el('li', {}, `度数 ${d} (${SOLFEGE[d - 1]}): ${ms > 0 ? '+' : ''}${ms} ms ${word}`);
        }))),
      el('div', { class: 'row actions' },
        el('button', { id: 'retry-btn', class: 'btn primary', type: 'button', onclick: () => { resetHome(); begin({ demo: false }); } }, 'もう一度'),
        el('button', { id: 'back-btn', class: 'btn', type: 'button', onclick: () => { setState('idle'); resetHome(); } }, '曲選択へ')),
    );
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && run) abort();
  };
  const onResize = () => {
    if (run) resize();
  };

  ui.play.append(
    el('div', { class: 'hud' },
      el('div', { class: 'hud-item' }, el('span', { class: 'hud-label' }, 'スコア'), ui.score),
      el('div', { class: 'hud-item' }, el('span', { class: 'hud-label' }, 'コンボ'), ui.combo),
      el('button', { id: 'abort-btn', class: 'btn small', type: 'button', onclick: abort }, '中断 (Esc)')),
    el('div', { class: 'progress', role: 'progressbar', 'aria-label': '進行' }, ui.progress),
    el('div', { class: 'canvas-wrap' }, ui.canvas),
  );
  root.append(ui.home, ui.play, ui.result);

  return {
    enter() {
      active = true;
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', onResize);
      if (!run) resetHome();
    },
    leave() {
      active = false;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (run) abort();
      else listener.close();
    },
  };
}

