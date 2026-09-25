// Editor básico de notas: seleccionar, borrar, ±semitono, unir con la siguiente, letra por nota, deshacer.

export class NoteEditor {
  /**
   * host: {roll, player, getNotes, setNotes(notes, lyrics), getLyrics, setLyrics, onDirty, lyricInput}
   */
  constructor(host) {
    this.h = host;
    this.active = false;
    this.undo = [];
    this.dirty = false;
    this._drag = null;
    const cv = host.roll.canvas;
    cv.addEventListener('mousedown', (e) => this._down(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', () => (this._drag = null));
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    cv.addEventListener('dblclick', (e) => this._dbl(e));
    host.lyricInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._commitLyric();
      if (e.key === 'Escape') this._closeLyric();
      e.stopPropagation();
    });
    host.lyricInput.addEventListener('blur', () => this._commitLyric());
  }

  enable(on) {
    this.active = on;
    if (!on) {
      this.h.roll.selected = -1;
      this._closeLyric();
    }
  }

  reset() {
    this.undo = [];
    this.dirty = false;
    this.h.roll.selected = -1;
  }

  _snapshot() {
    this.undo.push({ notes: this.h.getNotes().map((n) => ({ ...n })), lyrics: [...this.h.getLyrics()] });
    if (this.undo.length > 100) this.undo.shift();
  }

  _changed() {
    this.dirty = true;
    this.h.onDirty(true);
  }

  _pos(e) {
    const r = this.h.roll.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (!this.active || e.button !== 0) return;
    const { x, y } = this._pos(e);
    const idx = this.h.roll.hitTest(x, y, this.h.player.time);
    this.h.roll.selected = idx;
    if (idx >= 0) this.h.player.preview(this.h.getNotes()[idx].pitch + this.h.player.transpose);
    this._drag = { x0: e.clientX, t0: this.h.player.time, moved: false };
  }

  _move(e) {
    if (!this.active || !this._drag) return;
    const dx = e.clientX - this._drag.x0;
    if (Math.abs(dx) > 3) this._drag.moved = true;
    if (this._drag.moved) this.h.player.seek(this._drag.t0 - dx / this.h.roll.pps);
  }

  _wheel(e) {
    if (!this.active) return;
    e.preventDefault();
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / this.h.roll.pps;
    this.h.player.seek(this.h.player.time + d);
  }

  _dbl(e) {
    if (!this.active) return;
    const { x, y } = this._pos(e);
    const idx = this.h.roll.hitTest(x, y, this.h.player.time);
    if (idx < 0) return;
    this.h.roll.selected = idx;
    const inp = this.h.lyricInput;
    inp.value = this.h.getLyrics()[idx] || '';
    inp.style.left = `${Math.max(8, x - 40)}px`;
    inp.style.top = `${Math.max(8, y - 60)}px`;
    inp.hidden = false;
    inp.dataset.idx = String(idx);
    inp.focus();
    inp.select();
  }

  _commitLyric() {
    const inp = this.h.lyricInput;
    if (inp.hidden) return;
    const idx = Number(inp.dataset.idx);
    const lyrics = this.h.getLyrics();
    const text = inp.value.trim();
    if ((lyrics[idx] || '') !== text) {
      this._snapshot();
      const next = [...lyrics];
      next[idx] = text;
      this.h.setLyrics(next);
      this._changed();
    }
    this._closeLyric();
  }

  _closeLyric() {
    this.h.lyricInput.hidden = true;
  }

  /** Devuelve true si consumió la tecla. */
  key(e) {
    if (!this.active) return false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      const prev = this.undo.pop();
      if (prev) {
        this.h.setNotes(prev.notes, prev.lyrics);
        this.h.roll.selected = Math.min(this.h.roll.selected, prev.notes.length - 1);
        this._changed();
      }
      return true;
    }
    const idx = this.h.roll.selected;
    const notes = this.h.getNotes();
    if (idx < 0 || idx >= notes.length) return false;
    const lyrics = this.h.getLyrics();

    if (e.key === 'Delete' || e.key === 'Backspace') {
      this._snapshot();
      this.h.setNotes(notes.filter((_, i) => i !== idx), lyrics.filter((_, i) => i !== idx));
      this.h.roll.selected = Math.min(idx, notes.length - 2);
      this._changed();
      return true;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      this._snapshot();
      const d = e.key === 'ArrowUp' ? 1 : -1;
      const next = notes.map((n, i) => (i === idx ? { ...n, pitch: Math.max(24, Math.min(96, n.pitch + d)) } : n));
      this.h.setNotes(next, lyrics);
      this.h.player.preview(next[idx].pitch + this.h.player.transpose);
      this._changed();
      return true;
    }
    if (e.key.toLowerCase() === 'm' && idx + 1 < notes.length) {
      this._snapshot();
      const merged = { ...notes[idx], end: Math.max(notes[idx].end, notes[idx + 1].end) };
      const text = [lyrics[idx], lyrics[idx + 1]].filter(Boolean).join(' ');
      const nextNotes = notes.filter((_, i) => i !== idx + 1).map((n, i) => (i === idx ? merged : n));
      const nextLyrics = lyrics.filter((_, i) => i !== idx + 1).map((l, i) => (i === idx ? text : l));
      this.h.setNotes(nextNotes, nextLyrics);
      this._changed();
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const j = idx + (e.key === 'ArrowRight' ? 1 : -1);
      if (j >= 0 && j < notes.length) {
        this.h.roll.selected = j;
        this.h.player.seek(notes[j].start);
      }
      return true;
    }
    return false;
  }
}
