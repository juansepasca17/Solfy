// Micrófono -> AudioWorklet YIN -> lecturas {midi|null, rms, ctxTime}.

import { freqToMidi } from './notation.js';

let workletLoaded = null;

export class Mic {
  constructor(ctx) {
    this.ctx = ctx;
    this.stream = null;
    this.node = null;
    this.src = null;
    this.onReading = null;
    this._hist = [];
  }

  get active() {
    return !!this.stream;
  }

  async start(deviceId) {
    if (this.stream) return;
    if (!workletLoaded) workletLoaded = this.ctx.audioWorklet.addModule('js/pitch-worklet.js');
    await workletLoaded;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pitch-detector', { numberOfOutputs: 1 });
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.src.connect(this.node).connect(sink).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this._handle(e.data);
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.src) this.src.disconnect();
    if (this.node) this.node.disconnect();
    this.stream = this.src = this.node = null;
    this._hist = [];
  }

  _handle({ f, clarity, rms, t }) {
    let midi = null;
    if (f > 0 && clarity > 0.8) {
      const m = freqToMidi(f);
      // mediana de 3 para quitar picos sueltos
      this._hist.push(m);
      if (this._hist.length > 3) this._hist.shift();
      const sorted = [...this._hist].sort((a, b) => a - b);
      midi = sorted[sorted.length >> 1];
    } else {
      this._hist = [];
    }
    if (this.onReading) this.onReading({ midi, rms, ctxTime: t });
  }
}

export async function listMics() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}
