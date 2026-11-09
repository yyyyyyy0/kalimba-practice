// AudioContext、マイク、AudioWorklet、疑似マイク、メトロノーム、お手本の音。

import { Analyzer, DEFAULT_SENSITIVITY } from './analyzer.js';
import { matchOptionsFromSettings, presetFromSettings } from './settings.js';
import { renderClick, renderKalimba } from './synth.js';

export const SIM_KINDS = ['autoplay', 'wrong', 'silence'];

// 画面を離れて close() された後に終わった open。呼び出し側は何も表示せずに抜ける。
export class StaleOpen extends Error {}

export class MicError extends Error {
  constructor(userMessage, cause) {
    super(userMessage);
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されていません。アドレスバー付近のマイクの設定で許可してから、もう一度お試しください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '使えるマイクが見つかりません。マイクをつなぎ直すか、設定の入力デバイスを確かめてください。';
    case 'NotReadableError':
      return 'マイクを開けませんでした。ほかのアプリがマイクを使っていないか確かめてください。';
    default:
      return `マイクを開けませんでした (${err?.name ?? 'エラー'})。`;
  }
}

export class Listener {
  constructor({ getSettings, onDeviceMissing = () => {}, sim = null }) {
    this.getSettings = getSettings;
    this.onDeviceMissing = onDeviceMissing;
    this.sim = sim;
    this.ctx = null;
    this.analyzer = null;
    this.capture = null;
    this.stream = null;
    this.micSource = null;
    this.frameHandlers = new Set();
    this.buffers = new Map();
    this.starting = null;
    this.opening = null;
    this.openingGen = 0;
    this.gen = 0;
  }

  // AudioContext はユーザー操作の中で作る。マイクは開かない (お手本再生や疑似マイクにも使う)。
  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (!this.starting) {
      this.starting = this.createContext().catch((err) => {
        this.starting = null;
        throw err;
      });
    }
    await this.starting;
  }

  async createContext() {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) throw new MicError('このブラウザは Web Audio に対応していません。Chrome か Safari の最新版でお試しください。');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    // Safari はユーザー操作から await を挟むと resume を保留することがあるので、操作の直後に呼んでおく。
    const resumed = ctx.resume();
    resumed.catch(() => {});
    let capture;
    try {
      await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      await resumed;
      capture = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      capture.connect(mute).connect(ctx.destination);
    } catch (err) {
      ctx.close().catch(() => {});
      throw new MicError('音声処理の準備に失敗しました。ページを再読み込みしてください。', err);
    }

    const analyzer = new Analyzer({
      sampleRate: ctx.sampleRate,
      getPreset: () => presetFromSettings(this.getSettings()),
      getMatchOpts: () => matchOptionsFromSettings(this.getSettings()),
      sensitivity: this.getSettings().sensitivity ?? DEFAULT_SENSITIVITY,
      tuner: false,
    });
    capture.port.onmessage = ({ data: { frame, data } }) => {
      const start = frame / ctx.sampleRate;
      analyzer.push(data, start);
      const end = start + data.length / ctx.sampleRate;
      for (const cb of this.frameHandlers) cb(end);
    };
    this.ctx = ctx;
    this.capture = capture;
    this.analyzer = analyzer;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  // 画面の往復やボタン連打で同時に呼ばれても、ストリームを 1 本だけ開く。
  // close() のたびに世代を進め、古い世代の open が後から終わってもストリームを残さない。
  open() {
    if (this.opening && this.openingGen === this.gen) return this.opening;
    const gen = this.gen;
    const p = (this.opening ?? Promise.resolve()).catch(() => {}).then(() => this.openOnce(gen));
    this.opening = p;
    this.openingGen = gen;
    p.catch(() => {}).finally(() => {
      if (this.opening === p) this.opening = null;
    });
    return p;
  }

  async openOnce(gen) {
    await this.ensureContext();
    this.applySettings();
    if (gen !== this.gen) throw new StaleOpen();
    if (this.sim || this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('このブラウザではマイクを使えません。localhost か https のページで開いてください。');
    }
    const { deviceId } = this.getSettings();
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
    } catch (err) {
      // 保存した入力が抜かれた、または Safari で ID が変わったときは既定の入力に戻す。
      if (!deviceId || (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError')) {
        throw new MicError(describeMicError(err), err);
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      } catch (err2) {
        throw new MicError(describeMicError(err2), err2);
      }
      this.onDeviceMissing();
    }
    if (gen !== this.gen) {
      stream.getTracks().forEach((t) => t.stop());
      throw new StaleOpen();
    }
    this.stream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.capture);
  }

  close() {
    this.gen++;
    this.micSource?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.stream = null;
  }

  applySettings() {
    this.analyzer?.setSensitivity(this.getSettings().sensitivity);
  }

  setTunerEnabled(on) {
    if (this.analyzer) this.analyzer.tunerEnabled = on;
  }

  onFrame(cb) {
    this.frameHandlers.add(cb);
    return () => this.frameHandlers.delete(cb);
  }

  bufferFor(key, make) {
    let buf = this.buffers.get(key);
    if (!buf) {
      const samples = make(this.ctx.sampleRate);
      buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
      buf.copyToChannel(samples, 0);
      this.buffers.set(key, buf);
    }
    return buf;
  }

  play(buffer, when, destination, gain = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    let out = destination;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      g.connect(destination);
      out = g;
    }
    src.connect(out);
    src.scheduledAt = Math.max(when, this.ctx.currentTime);
    src.start(src.scheduledAt);
    return src;
  }

  toneBuffer(freq) {
    return this.bufferFor(`tone:${freq.toFixed(3)}`, (sr) => renderKalimba(freq, sr, {}));
  }

  playTone(freq, when, gain = 0.8) {
    return this.play(this.toneBuffer(freq), when, this.ctx.destination, gain);
  }

  // マイクの代わりに解析器の入力へ直接つなぐ (スピーカーには出さない)。
  simPluck(freq, when) {
    return this.play(this.toneBuffer(freq), when, this.capture);
  }

  click(when, accent = false) {
    const buf = this.bufferFor(`click:${accent}`, (sr) => renderClick(sr, { accent }));
    return this.play(buf, when, this.ctx.destination, 0.9);
  }
}
