// Vista de práctica: une reproductor, piano roll, micrófono, puntaje y editor.

import { Player } from './player.js';
import { PianoRoll } from './pianoroll.js';
import { Mic } from './mic.js';
import { ScoreSession } from './scoring.js';
import { NoteEditor } from './editor.js';
import { parseNotes, serializeNotes, midiName, fmtTime } from './notation.js';
import { settings } from './settings.js';
import { onTheme } from './theme.js';

const $ = (s) => document.querySelector(s);
const TRAIL_SECONDS = 10;

/** Asigna cada palabra a la nota con la que más se solapa. */
function lyricsForNotes(notes, words) {
  const out = new Array(notes.length).fill('');
  if (!words) return out;
  for (const w of words) {
    let best = -1;
    let bestOv = 0;
    let nearest = -1;
    let nearestD = 0.4;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.start > w.end + 0.5) break;
      const ov = Math.min(n.end, w.end) - Math.max(n.start, w.start);
      if (ov > bestOv) {
        bestOv = ov;
        best = i;
      }
      const d = Math.abs(n.start - w.start);
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
    }
    const i = best >= 0 ? best : nearest;
    if (i >= 0) out[i] = out[i] ? `${out[i]} ${w.word}` : w.word;
  }
  return out;
}

export class Practice {
  constructor({ toast, onResult }) {
    this.toast = toast;
    this.onResult = onResult;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.player = new Player(this.ctx);
    this.roll = new PianoRoll($('#roll'));
    this.mic = new Mic(this.ctx);
    this.mic.onReading = (r) => this._reading(r);
    this.data = null;
    this.id = null;
    this.mode = 'listen';
    this.diff = 'normal';
    this.transpose = 0;
    this.session = null;
    this.visible = false;
    this.words = null;
    this.noteLyrics = [];
    this.voice = null;
    this.trail = [];
    this.loopA = null;
    this._raf = null;
    this._lastLive = 0;

    onTheme((t) => this.roll.setTokens(t));
    this.editor = new NoteEditor({
      roll: this.roll,
      player: this.player,
      lyricInput: $('#lyric-input'),
      getNotes: () => this.notes,
      setNotes: (notes, lyrics) => this._setNotes(notes, lyrics),
      getLyrics: () => this.noteLyrics,
      setLyrics: (l) => {
        this.noteLyrics = l;
        this.roll.noteLyrics = l;
      },
      onDirty: () => this._updateEditBar(),
    });

    this.player.addEventListener('ended', () => this._finishSession('ended'));
    this.player.addEventListener('play', () => this._syncPlayBtn());
    this.player.addEventListener('pause', () => this._syncPlayBtn());
    this.player.addEventListener('seek', () => (this.trail = []));
    this.player.addEventListener('loop', () => (this.trail = []));
    this._bindUi();
  }

  get notes() {
    return this.diff === 'learning' ? this.notesLearning : this.notesNormal;
  }

  set notes(v) {
    if (this.diff === 'learning') this.notesLearning = v;
    else this.notesNormal = v;
  }

  // ---------- carga ----------
  async open(id) {
    if (this.editor.dirty && !(await this._confirmDiscard())) return false;
    this.player.pause();
    this._finishSession('switch', true);
    const data = await window.solfy.library.load(id);
    this.id = id;
    this.data = data;
    this.notesNormal = parseNotes(data.notes);
    this.notesLearning = parseNotes(data.notesLearning);
    this.words = data.lyrics;
    this.player.detuneCents = data.meta.tuning_offset_cents || 0;
    this.roll.curve = data.pitchCurve;
    this.loopA = null;
    this.player.loop = null;
    this.roll.loop = null;
    this.transpose = 0;
    this.editor.reset();
    $('#tr-out').value = '0';
    $('#hud-title').textContent = data.song.title;
    $('#lyrics-toggle-wrap').hidden = !this.words;
    await this.player.load(`app://solfy/media/${id}/instrumental.ogg`, data.meta.duration);
    this._applyNotes();
    this._applyMix();
    this.player.seek(0);
    this._updateEditBar();
    return true;
  }

  _applyNotes() {
    this.noteLyrics = lyricsForNotes(this.notes, this.words);
    this.roll.noteLyrics = this.noteLyrics;
    this.roll.setNotes(this.notes, this.transpose);
    this.player.setNotes(this.notes);
    this.player.setTranspose(this.transpose);
  }

  _setNotes(notes, lyrics) {
    this.notes = notes;
    this.noteLyrics = lyrics;
    this.roll.noteLyrics = lyrics;
    this.roll.setNotes(notes, this.transpose);
    this.player.setNotes(notes);
    this._resetSession();
  }

  // ---------- visibilidad y dibujo ----------
  show(on) {
    this.visible = on;
    if (on && !this._raf) this._loop();
    if (!on) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      this.player.pause();
    }
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = this.player.time;
    const cutoff = now - TRAIL_SECONDS;
    while (this.trail.length && this.trail[0].t < cutoff) this.trail.shift();
    this.roll.trail = this.trail;
    this.roll.voice = this.voice && performance.now() - this.voice.at < 200 ? this.voice : null;
    this.roll.noteStatus = this.session ? (i) => this.session.noteRatio(i) : null;
    this.roll.draw(now);
    this._hud(now);
  }

  _hud(now) {
    const notes = this.notes || [];
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].end <= now) lo = mid + 1;
      else hi = mid;
    }
    const n = notes[lo];
    const target = n && n.start - now < 2.5 ? n.pitch + this.transpose : null;
    $('#hud-note').textContent = target == null ? '–' : midiName(target);
    $('#hud-label').textContent = this.mode === 'sing' ? 'Tu turno' : 'Escucha';

    const dur = this.player.duration || 0;
    $('#time').textContent = `${fmtTime(now)} / ${fmtTime(dur)}`;
    if (!this._seeking && dur) $('#seek').value = String(Math.round((now / dur) * 1000));

    if (this.session && performance.now() - this._lastLive > 500) {
      this._lastLive = performance.now();
      const r = this.session.result();
      $('#hud-live').textContent = r.count ? `${Math.round(r.score)}` : '';
    }
    if (!this.session) $('#hud-live').textContent = '';
  }

  // ---------- micrófono ----------
  _reading({ midi, ctxTime }) {
    const tuning = (this.player.detuneCents || 0) / 100;
    const rate = this.player.rate || 1;
    const lag = Math.max(0, this.ctx.currentTime - ctxTime) + settings.latencyMs / 1000;
    const songT = this.player.time - lag * rate;
    let shown = midi == null ? null : midi - tuning;

    const res = this.session && this.player.playing ? this.session.frame(songT, midi) : null;
    if (shown != null && settings.octaveFree && res) {
      // con octava libre, dibujar la voz en la octava de la nota objetivo
      const target = this.notes[res.idx].pitch + this.transpose;
      shown += 12 * Math.round((target - shown) / 12);
    }
    if (this.player.playing) this.trail.push({ t: songT, midi: shown });
    if (shown != null) this.voice = { midi: shown, at: performance.now(), inTune: res && res.cents != null && Math.abs(res.cents) <= 50 };
  }

  async _setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'sing') {
      try {
        await this.mic.start(settings.micId);
      } catch (e) {
        this.toast('No se pudo abrir el micrófono: ' + (e.message || e.name));
        return;
      }
      this.toast('🎧 Usa audífonos: así el micrófono no capta el piano ni la música.');
    } else {
      this._finishSession('mode');
      this.mic.stop();
      this.voice = null;
      this.trail = [];
    }
    this.mode = mode;
    document.querySelectorAll('[data-play]').forEach((b) => b.classList.toggle('active', b.dataset.play === mode));
    if (mode === 'sing' && this.player.playing) this._startSession();
  }

  async restartMic() {
    if (this.mode !== 'sing') return;
    this.mic.stop();
    try {
      await this.mic.start(settings.micId);
    } catch (e) {
      this.toast('No se pudo abrir el micrófono: ' + (e.message || e.name));
    }
  }

  // ---------- puntaje ----------
  _startSession() {
    if (this.session || this.mode !== 'sing') return;
    this.session = new ScoreSession(this.notes, {
      transpose: this.transpose,
      octaveFree: settings.octaveFree,
      tuningCents: this.player.detuneCents,
    });
    this.sessionLoop = !!this.player.loop;
  }

  _resetSession() {
    if (this.session) {
      this.session = null;
      if (this.player.playing) this._startSession();
    }
  }

  async _finishSession(reason, silent = false) {
    const s = this.session;
    this.session = null;
    if (!s) return;
    const r = s.result();
    if (silent || r.count < 3) return;
    const entry = {
      songId: this.id,
      mode: this.diff,
      speed: this.player.rate,
      transpose: this.transpose,
      octaveFree: settings.octaveFree,
      score: r.score,
      hitPct: r.hitPct,
      grade: r.grade,
      notes: r.count,
      partial: this.sessionLoop || r.coverage < 0.9,
    };
    try {
      await window.solfy.scores.add(entry);
    } catch (e) {
      this.toast('No se pudo guardar el puntaje: ' + e.message);
    }
    this.onResult(r, entry, reason);
  }

  // ---------- controles ----------
  _applyMix() {
    const inst = settings.volInst / 100;
    const piano = settings.volPiano / 100;
    const m = settings.mix;
    this.player.setMix(m === 'piano' ? 0 : inst, m === 'inst' ? 0 : m === 'pianoSoft' ? piano * 0.35 : piano);
    $('#transpose-hint').hidden = !(this.transpose % 12 !== 0 && m !== 'piano');
  }

  applySettings() {
    this._applyMix();
    this.roll.showCurve = settings.showCurve;
    this.roll.showLyrics = settings.showLyrics;
  }

  async togglePlay() {
    if (!this.data) return;
    if (this.player.playing) {
      this.player.pause();
      return;
    }
    if (this.editor.active) this._toggleEdit(false);
    try {
      await this.player.play();
      if (this.mode === 'sing') this._startSession();
    } catch (e) {
      this.toast('No se pudo reproducir: ' + e.message);
    }
  }

  _syncPlayBtn() {
    $('#btn-play').textContent = this.player.playing ? '❚❚' : '▶';
  }

  _setTranspose(t) {
    this.transpose = Math.max(-12, Math.min(12, t));
    $('#tr-out').value = (this.transpose > 0 ? '+' : '') + this.transpose;
    this.roll.setNotes(this.notes, this.transpose);
    this.player.setTranspose(this.transpose);
    this._applyMix();
    this._resetSession();
  }

  async _setDiff(diff) {
    if (diff === this.diff) return;
    if (this.editor.dirty && !(await this._confirmDiscard())) return;
    this.editor.reset();
    this.diff = diff;
    document.querySelectorAll('[data-diff]').forEach((b) => b.classList.toggle('active', b.dataset.diff === diff));
    if (this.data) {
      this._applyNotes();
      this._resetSession();
    }
    this._updateEditBar();
  }

  _toggleEdit(on = !this.editor.active) {
    if (on) {
      this.player.pause();
      this._finishSession('edit', true);
    }
    this.editor.enable(on);
    $('#btn-edit').classList.toggle('on', on);
    $('#editor-bar').hidden = !on;
    this._updateEditBar();
  }

  _updateEditBar() {
    const edited = this.data && this.data.edited && this.data.edited[this.diff];
    $('#ed-save').disabled = !this.editor.dirty;
    $('#ed-restore').disabled = !edited && !this.editor.dirty;
  }

  async _confirmDiscard() {
    return window.confirm('Tienes cambios sin guardar en el editor. ¿Descartarlos?');
  }

  async _save() {
    try {
      const saved = await window.solfy.notes.save(this.id, this.diff, serializeNotes(this.notes));
      this.notes = parseNotes(saved);
      if (this.words || this.noteLyrics.some(Boolean)) {
        const words = [];
        this.notes.forEach((n, i) => this.noteLyrics[i] && words.push({ word: this.noteLyrics[i], start: n.start, end: n.end }));
        this.words = await window.solfy.lyrics.save(this.id, words);
        $('#lyrics-toggle-wrap').hidden = false;
      }
      this.data.edited[this.diff] = true;
      this.editor.dirty = false;
      this._applyNotes();
      this._updateEditBar();
      this.toast('Cambios guardados (también en el MIDI).');
    } catch (e) {
      this.toast('No se pudo guardar: ' + e.message);
    }
  }

  async _restore() {
    if (!window.confirm('¿Volver a las notas que generó el análisis automático? Se pierden tus ediciones de este modo.')) return;
    const restored = await window.solfy.notes.restore(this.id, this.diff);
    this.notes = parseNotes(restored);
    this.data.edited[this.diff] = false;
    this.editor.reset();
    this._applyNotes();
    this._updateEditBar();
    this.toast('Notas originales restauradas.');
  }

  _bindUi() {
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-stop').addEventListener('click', () => {
      this.player.pause();
      this._finishSession('stop');
      this.player.seek(this.player.loop ? this.player.loop.a : 0);
    });
    const seek = $('#seek');
    seek.addEventListener('input', () => {
      this._seeking = true;
      this.player.seek((Number(seek.value) / 1000) * (this.player.duration || 0));
    });
    seek.addEventListener('change', () => (this._seeking = false));

    document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => this._setMode(b.dataset.play)));
    document.querySelectorAll('[data-diff]').forEach((b) => b.addEventListener('click', () => this._setDiff(b.dataset.diff)));

    const mix = $('#mix');
    mix.value = settings.mix;
    mix.addEventListener('change', () => {
      settings.mix = mix.value;
      this._applyMix();
    });

    const speed = $('#speed');
    speed.addEventListener('input', () => {
      $('#speed-out').value = `${speed.value}%`;
      this.player.setRate(Number(speed.value) / 100);
    });

    $('#tr-down').addEventListener('click', () => this._setTranspose(this.transpose - 1));
    $('#tr-up').addEventListener('click', () => this._setTranspose(this.transpose + 1));

    const oct = $('#octave-free');
    oct.checked = settings.octaveFree;
    oct.addEventListener('change', () => {
      settings.octaveFree = oct.checked;
      this._resetSession();
    });

    $('#loop-a').addEventListener('click', () => {
      this.loopA = this.player.time;
      this.player.loop = null;
      this.roll.loop = { a: this.loopA, b: this.loopA + 0.01 };
      this.toast('Inicio del bucle marcado. Ahora marca el fin (B).');
    });
    $('#loop-b').addEventListener('click', () => {
      const b = this.player.time;
      if (this.loopA == null || b <= this.loopA + 0.5) {
        this.toast('Marca primero A y luego B más adelante en la canción.');
        return;
      }
      this.player.loop = { a: this.loopA, b };
      this.roll.loop = this.player.loop;
      this.player.seek(this.loopA);
      this._resetSession();
    });
    $('#loop-clear').addEventListener('click', () => {
      this.loopA = null;
      this.player.loop = null;
      this.roll.loop = null;
    });

    const curve = $('#show-curve');
    curve.checked = settings.showCurve;
    curve.addEventListener('change', () => {
      settings.showCurve = curve.checked;
      this.applySettings();
    });
    const lyr = $('#show-lyrics');
    lyr.checked = settings.showLyrics;
    lyr.addEventListener('change', () => {
      settings.showLyrics = lyr.checked;
      this.applySettings();
    });

    $('#btn-edit').addEventListener('click', () => this._toggleEdit());
    $('#ed-save').addEventListener('click', () => this._save());
    $('#ed-restore').addEventListener('click', () => this._restore());
    $('#btn-midi').addEventListener('click', async () => {
      if (!this.id) return;
      if (this.editor.dirty) this.toast('Guarda los cambios del editor para incluirlos en el MIDI.');
      const ok = await window.solfy.library.exportMidi(this.id, this.diff);
      if (ok) this.toast('MIDI guardado.');
    });

    window.addEventListener('keydown', (e) => {
      if (!this.visible || e.target.closest('input, select, textarea, dialog[open]')) return;
      if (this.editor.key(e)) {
        e.preventDefault();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.player.seek(this.player.time + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    });

    this.applySettings();
  }
}
