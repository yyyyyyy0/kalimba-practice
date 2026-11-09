// 画面切り替えと各モジュールの配線。

import { Listener, SIM_KINDS } from './audio.js';
import { createGame } from './game.js';
import { createSettingsScreen, createStore } from './settings.js';
import { createTuner } from './tuner.js';

const params = new URLSearchParams(location.search);
const sim = SIM_KINDS.includes(params.get('sim')) ? params.get('sim') : null;

const store = createStore();
const listener = new Listener({ getSettings: store.get, onDeviceMissing: () => store.set({ deviceId: '' }), sim });

const screens = {
  game: createGame({ root: document.getElementById('screen-game'), store, listener, params }),
  tuner: createTuner({ root: document.getElementById('screen-tuner'), store, listener }),
  settings: createSettingsScreen({ root: document.getElementById('screen-settings'), store, listener }),
};

const navButtons = [...document.querySelectorAll('[data-screen]')];
let current = null;

function show(name) {
  if (current === name) return;
  if (current) screens[current].leave();
  current = name;
  for (const [key, node] of Object.entries({
    game: document.getElementById('screen-game'),
    tuner: document.getElementById('screen-tuner'),
    settings: document.getElementById('screen-settings'),
  })) {
    node.hidden = key !== name;
  }
  for (const b of navButtons) b.setAttribute('aria-current', String(b.dataset.screen === name));
  screens[name].enter();
}

for (const b of navButtons) b.addEventListener('click', () => show(b.dataset.screen));

if (sim) {
  const banner = document.getElementById('sim-banner');
  banner.textContent = `疑似マイク (${sim})`;
  banner.hidden = false;
}

show('game');
