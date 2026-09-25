// Sampler de piano con muestras Salamander locales (CC-BY 3.0, Alexander Holm).

const NOTE_OFFSETS = { C: 0, Ds: 3, Fs: 6, A: 9 };

function sampleList() {
  const list = [];
  for (let o = 1; o <= 6; o++) {
    for (const [n, off] of Object.entries(NOTE_OFFSETS)) list.push({ file: `${n}${o}.mp3`, midi: (o + 1) * 12 + off });
  }
  list.push({ file: 'C7.mp3', midi: 96 });
  return list;
}

export class Piano {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = destination;
    this.samples = [];
    this.active = new Set();
    this.ready = null;
  }

  load() {
    if (!this.ready) {
      this.ready = Promise.all(
        sampleList().map(async (s) => {
          const res = await fetch(`assets/piano/${s.file}`);
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          return { ...s, buf };
        }),
      ).then((list) => {
        this.samples = list.sort((a, b) => a.midi - b.midi);
      });
    }
    return this.ready;
  }

  _nearest(midi) {
    let best = this.samples[0];
    for (const s of this.samples) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
    return best;
  }

  /** Toca `midi` en el tiempo de AudioContext `when` durante `dur` segundos. */
  play(midi, when, dur, { detuneCents = 0, velocity = 0.85 } = {}) {
    if (!this.samples.length) return;
    const s = this._nearest(midi);
    const src = this.ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = 2 ** ((midi - s.midi + detuneCents / 100) / 12);
    const g = this.ctx.createGain();
    const t0 = Math.max(when, this.ctx.currentTime);
    const end = t0 + Math.max(0.05, dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(velocity, t0 + 0.005);
    g.gain.setValueAtTime(velocity, end);
    g.gain.setTargetAtTime(0, end, 0.07);
    src.connect(g).connect(this.out);
    src.start(t0);
    src.stop(end + 0.6);
    const voice = { src, g };
    this.active.add(voice);
    src.onended = () => {
      this.active.delete(voice);
      g.disconnect();
    };
  }

  stopAll() {
    const now = this.ctx.currentTime;
    for (const { src, g } of this.active) {
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0, now, 0.02);
      try {
        src.stop(now + 0.1);
      } catch {
        /* ya detenido */
      }
    }
  }
}
