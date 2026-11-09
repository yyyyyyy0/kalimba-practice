// マイク入力を 256 フレームずつ main スレッドへ送る。frame は先頭サンプルの currentFrame。

const BLOCK = 256;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK);
    this.filled = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (this.filled === 0) this.startFrame = currentFrame;
    // 入力が切れている間は無音を流し続け、時刻の連続性を保つ。
    for (let i = 0; i < 128; i++) this.buffer[this.filled + i] = channel ? channel[i] : 0;
    this.filled += 128;
    if (this.filled === BLOCK) {
      this.port.postMessage({ frame: this.startFrame, data: this.buffer }, [this.buffer.buffer]);
      this.buffer = new Float32Array(BLOCK);
      this.filled = 0;
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
