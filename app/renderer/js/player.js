// Reloj maestro = <audio> del instrumental. El piano se agenda contra ese reloj,
// así velocidad, bucles y saltos quedan siempre sincronizados con las barras.

import { Piano } from './piano.js';

const LOOKAHEAD = 0.2; // segundos de canción agendados por adelantado

export class Player extends EventTarget {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.master = ctx.createGain();
    this.instGain = ctx.createGain();
    this.pianoGain = ctx.createGain();
    ctx.createMediaElementSource(this.audio).connect(this.instGain).connect(this.master);
    this.pianoGain.connect(this.master);
    this.master.connect(ctx.destination);
    this.piano = new Piano(ctx, this.pianoGain);

    this.notes = [];
    this.transpose = 0;
    this.detuneCents = 0;
    this.loop = null;
    this.duration = 0;
    this._idx = 0;
    this._timer = null;

    this.audio.addEventListener('ended', () => {
      this._stopScheduler();
      this.dispatchEvent(new Event('ended'));
    });
    this.audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(this.audio.duration)) this.duration = this.audio.duration;
    });
  }

  async load(url, duration) {
    this.pause();
    this.duration = duration || 0;
    this.audio.src = url;
    this.audio.load();
    await this.piano.load();
  }

  get time() {
    return this.audio.currentTime || 0;
  }

  get playing() {
    return !this.audio.paused;
  }

  get rate() {
    return this.audio.playbackRate;
  }

  setNotes(notes) {
    this.notes = notes;
    this._resync();
  }

  setTranspose(t) {
    this.transpose = t;
    this._resync();
  }

  setRate(r) {
    this.audio.playbackRate = r;
    this._resync();
  }

  setMix(instVol, pianoVol) {
    const now = this.ctx.currentTime;
    this.instGain.gain.setTargetAtTime(instVol, now, 0.02);
    this.pianoGain.gain.setTargetAtTime(pianoVol, now, 0.02);
  }

  async play() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.loop && (this.time < this.loop.a || this.time >= this.loop.b)) this.audio.currentTime = this.loop.a;
    await this.audio.play();
    this._resync();
    this._startScheduler();
    this.dispatchEvent(new Event('play'));
  }

  pause() {
    this.audio.pause();
    this._stopScheduler();
    this.piano.stopAll();
    this.dispatchEvent(new Event('pause'));
  }

  seek(t) {
    const max = this.duration || this.audio.duration || 0;
    this.audio.currentTime = Math.max(0, Math.min(t, max ? max - 0.05 : t));
    this._resync();
    this.dispatchEvent(new Event('seek'));
  }

  /** Nota de prueba (editor). */
  preview(midi) {
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.piano.play(midi, this.ctx.currentTime, 0.35, { detuneCents: this.detuneCents });
  }

  _resync() {
    this.piano.stopAll();
    const t = this.time;
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].start < t - 0.001) lo = mid + 1;
      else hi = mid;
    }
    this._idx = lo;
  }

  _startScheduler() {
    this._stopScheduler();
    this._timer = setInterval(() => this._tick(), 25);
    this._tick();
  }

  _stopScheduler() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    if (this.audio.paused) return;
    const now = this.time;
    const rate = this.rate || 1;
    if (this.loop && now >= this.loop.b) {
      this.audio.currentTime = this.loop.a;
      this._resync();
      this.dispatchEvent(new Event('loop'));
      return;
    }
    const horizon = now + LOOKAHEAD * rate;
    const limit = this.loop ? this.loop.b : Infinity;
    while (this._idx < this.notes.length && this.notes[this._idx].start < horizon) {
      const n = this.notes[this._idx++];
      if (n.start < now - 0.03 || n.start >= limit) continue;
      const when = this.ctx.currentTime + (n.start - now) / rate;
      const end = Math.min(n.end, limit);
      this.piano.play(n.pitch + this.transpose, when, (end - n.start) / rate, { detuneCents: this.detuneCents });
    }
  }
}
