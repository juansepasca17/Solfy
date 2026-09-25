// AudioWorklet: detección de tono YIN sobre el micrófono (~43 lecturas por segundo).
/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */

const N = 1024; // ventana (tras diezmar a ~22 kHz ≈ 46 ms)
const HOP = 512;
const FMIN = 65;
const FMAX = 1100;
const THRESH = 0.15;

class PitchDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dec = Math.max(1, Math.round(sampleRate / 22050));
    this.sr = sampleRate / this.dec;
    this.ring = new Float32Array(N);
    this.pos = 0;
    this.since = 0;
    this.acc = 0;
    this.accN = 0;
    this.frame = new Float32Array(N);
    this.W = N / 2;
    this.tauMin = Math.max(2, Math.floor(this.sr / FMAX));
    this.tauMax = Math.min(this.W - 1, Math.ceil(this.sr / FMIN));
    this.d = new Float32Array(this.tauMax + 2);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      if (++this.accN < this.dec) continue;
      this.ring[this.pos] = this.acc / this.accN;
      this.pos = (this.pos + 1) % N;
      this.acc = 0;
      this.accN = 0;
      if (++this.since >= HOP) {
        this.since = 0;
        this.analyze();
      }
    }
    return true;
  }

  analyze() {
    const x = this.frame;
    for (let i = 0; i < N; i++) x[i] = this.ring[(this.pos + i) % N];
    let energy = 0;
    for (let i = 0; i < N; i++) energy += x[i] * x[i];
    const rms = Math.sqrt(energy / N);
    if (rms < 0.004) {
      this.port.postMessage({ f: 0, clarity: 0, rms, t: currentTime });
      return;
    }
    const { W, tauMin, tauMax, d } = this;
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = x[j] - x[j + tau];
        s += diff * diff;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < THRESH) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin; t <= tauMax; t++) if (d[t] < d[best]) best = t;
      if (d[best] < 0.3) tau = best;
    }
    if (tau < 0) {
      this.port.postMessage({ f: 0, clarity: 0, rms, t: currentTime });
      return;
    }
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const f = this.sr / (tau + Math.max(-1, Math.min(1, shift)));
    this.port.postMessage({ f, clarity: 1 - b, rms, t: currentTime });
  }
}

registerProcessor('pitch-detector', PitchDetector);
