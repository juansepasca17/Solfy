// Piano roll horizontal en canvas: las barras se desplazan hacia la línea central ("ahora").
// Tu voz se dibuja en verde encima (rastro + bolita en la línea).

import { midiName } from './notation.js';

const TOP_PAD = 120; // espacio para el nombre de la nota (HUD)
const BOTTOM_PAD = 28;

export class PianoRoll {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.W = 0;
    this.H = 0;
    this.pps = 170; // píxeles por segundo
    this.tokens = {};
    this.notes = [];
    this.transpose = 0;
    this.lo = 55;
    this.hi = 72;
    this.curve = null;
    this.showCurve = false;
    this.noteLyrics = null;
    this.showLyrics = true;
    this.trail = []; // {t, midi|null}
    this.voice = null; // {midi, age}
    this.loop = null;
    this.selected = -1;
    this.noteStatus = null; // (idx) => ratio|null
    this.pattern = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setTokens(t) {
    this.tokens = t;
    this.pattern = null;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.pattern = null;
  }

  setNotes(notes, transpose) {
    this.notes = notes;
    this.transpose = transpose;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    if (!Number.isFinite(lo)) {
      lo = 57;
      hi = 69;
    }
    lo += transpose - 3;
    hi += transpose + 3;
    if (hi - lo < 14) {
      const c = (hi + lo) / 2;
      lo = Math.floor(c - 7);
      hi = Math.ceil(c + 7);
    }
    this.lo = lo;
    this.hi = hi;
  }

  get rowH() {
    return (this.H - TOP_PAD - BOTTOM_PAD) / (this.hi - this.lo);
  }

  get barH() {
    return Math.max(14, Math.min(58, this.rowH * 1.15));
  }

  y(midi) {
    return TOP_PAD + (this.hi - midi) * this.rowH;
  }

  midiAtY(y) {
    return this.hi - (y - TOP_PAD) / this.rowH;
  }

  x(t, now) {
    return this.W / 2 + (t - now) * this.pps;
  }

  timeAtX(x, now) {
    return now + (x - this.W / 2) / this.pps;
  }

  /** Índice de la nota bajo (x, y) o -1. */
  hitTest(px, py, now) {
    const t = this.timeAtX(px, now);
    const bh = this.barH;
    for (let i = this._firstVisible(t - 0.01); i < this.notes.length && this.notes[i].start <= t; i++) {
      const n = this.notes[i];
      if (n.end < t) continue;
      const cy = this.y(n.pitch + this.transpose);
      if (Math.abs(py - cy) <= bh / 2 + 3) return i;
    }
    return -1;
  }

  _firstVisible(t) {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].end < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _bgPattern() {
    if (this.pattern) return this.pattern;
    const c = document.createElement('canvas');
    const s = 220;
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.fillStyle = this.tokens.stagePattern;
    g.strokeStyle = this.tokens.stagePattern;
    g.lineWidth = 3;
    // pentagrama curvo y algunas notas, muy tenue
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(0, 120 + k * 12);
      g.bezierCurveTo(70, 60 + k * 12, 150, 180 + k * 12, s, 120 + k * 12);
      g.stroke();
    }
    const note = (x, y) => {
      g.beginPath();
      g.ellipse(x, y, 11, 8, -0.4, 0, Math.PI * 2);
      g.fill();
      g.fillRect(x + 8, y - 44, 3.5, 44);
    };
    note(40, 100);
    note(120, 150);
    note(180, 110);
    this.pattern = this.ctx.createPattern(c, 'repeat');
    return this.pattern;
  }

  draw(now) {
    const { ctx, W, H, tokens: T } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = T.stageBg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = this._bgPattern();
    ctx.fillRect(0, 0, W, H);

    // grilla de semitonos (más marcada en cada Do)
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (let m = Math.ceil(this.lo); m <= this.hi; m++) {
      const y = this.y(m);
      const isC = ((m % 12) + 12) % 12 === 0;
      ctx.fillStyle = isC ? T.stageGridC : T.stageGrid;
      ctx.fillRect(0, Math.round(y), W, 1);
      if (isC) {
        ctx.fillStyle = T.muted;
        ctx.fillText(midiName(m), W - 34, y - 7);
      }
    }

    const tLeft = this.timeAtX(0, now);
    const tRight = this.timeAtX(W, now);

    if (this.loop) {
      const a = this.x(this.loop.a, now);
      const b = this.x(this.loop.b, now);
      ctx.fillStyle = T.loop;
      ctx.fillRect(a, 0, b - a, H);
    }

    // curva de la voz original
    if (this.showCurve && this.curve) {
      const { hop, midi } = this.curve;
      ctx.strokeStyle = T.curve;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let pen = false;
      const i0 = Math.max(0, Math.floor(tLeft / hop));
      const i1 = Math.min(midi.length - 1, Math.ceil(tRight / hop));
      for (let i = i0; i <= i1; i++) {
        const v = midi[i];
        if (v == null) {
          pen = false;
          continue;
        }
        const px = this.x(i * hop, now);
        const py = this.y(v + this.transpose);
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
      }
      ctx.stroke();
    }

    // barras (notas objetivo)
    const bh = this.barH;
    const fontPx = Math.round(Math.max(14, Math.min(34, bh * 0.72)));
    for (let i = this._firstVisible(tLeft); i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.start > tRight) break;
      const x0 = this.x(n.start, now);
      const x1 = this.x(n.end, now);
      const cy = this.y(n.pitch + this.transpose);
      const top = cy - bh / 2;
      const w = Math.max(2, x1 - x0);
      const ratio = this.noteStatus && n.end < now ? this.noteStatus(i) : null;
      ctx.fillStyle = ratio != null && ratio > 0.6 ? T.noteHit : T.noteFill;
      ctx.fillRect(x0, top, w, bh);
      ctx.fillStyle = ratio != null && ratio > 0.6 ? T.noteHit : T.noteBase;
      ctx.globalAlpha = ratio != null && ratio > 0.6 ? 0.6 : 1;
      ctx.fillRect(x0, top + bh * 0.74, w, bh * 0.26);
      ctx.globalAlpha = 1;
      ctx.fillStyle = T.noteEdge;
      ctx.fillRect(x0, top, w, 2);
      ctx.fillRect(x0, top + bh - 1, w, 1);
      if (i === this.selected) {
        ctx.strokeStyle = T.noteSel;
        ctx.lineWidth = 3;
        ctx.strokeRect(x0 - 1.5, top - 1.5, w + 3, bh + 3);
      }
      const lyric = this.showLyrics && this.noteLyrics && this.noteLyrics[i];
      if (lyric) {
        ctx.fillStyle = T.stageText;
        ctx.font = `${fontPx}px "Segoe UI", sans-serif`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(lyric, x0 + 2, top - 4);
      }
    }

    // línea de "ahora"
    ctx.fillStyle = T.stageNow;
    ctx.fillRect(Math.round(W / 2), 0, 1, H);

    // rastro verde de tu voz
    const lw = bh * 0.9;
    ctx.strokeStyle = T.voice;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let prev = null;
    for (const p of this.trail) {
      if (p.t < tLeft - 1) continue;
      if (p.midi == null || p.midi < this.lo - 2 || p.midi > this.hi + 2) {
        prev = null;
        continue;
      }
      const px = this.x(p.t, now);
      const py = this._clampY(p.midi);
      // un salto grande (ruido, octava falsa) corta el trazo en vez de dibujar una columna
      if (prev && p.t - prev.t <= 0.12 && Math.abs(p.midi - prev.midi) <= 2.5) {
        ctx.lineTo(px, py);
      } else {
        ctx.moveTo(px, py);
        ctx.lineTo(px + 0.01, py); // punto suelto: el extremo redondo lo dibuja
      }
      prev = p;
    }
    ctx.stroke();

    // bolita en la línea central
    if (this.voice && this.voice.midi != null) {
      const cx = W / 2;
      const cy = this._clampY(this.voice.midi);
      const r = bh * 0.5;
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.45, r * 0.1, cx, cy, r);
      g.addColorStop(0, T.voiceBallHi);
      g.addColorStop(0.45, T.voiceBall);
      g.addColorStop(1, T.voiceBallLo);
      ctx.globalAlpha = this.voice.inTune ? 1 : 0.8;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  _clampY(midi) {
    return Math.max(TOP_PAD - 20, Math.min(this.H - 10, this.y(midi)));
  }
}
