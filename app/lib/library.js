'use strict';
// Biblioteca local: %APPDATA%\Solfy\library\<id>\ y %APPDATA%\Solfy\scores.json

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildMidi, nameToMidi } = require('./midi');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTE_RE = /^[A-G]#?-?\d$/;
const MEDIA_FILES = new Set(['instrumental.ogg', 'vocals.ogg']);
const MODES = { normal: 'notes.json', learning: 'notes_learning.json' };
const MAX_MP3_BYTES = 60 * 1024 * 1024;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('ID de canción inválido');
}

function looksLikeMp3(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (head.toString('latin1', 0, 3) === 'ID3') return true;
    return head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) === 0x02;
  } finally {
    fs.closeSync(fd);
  }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function sanitizeNotes(notes) {
  if (!Array.isArray(notes) || notes.length > 20000) throw new Error('Lista de notas inválida');
  return notes
    .map((n) => {
      if (!n || typeof n.note !== 'string' || !NOTE_RE.test(n.note)) throw new Error('Nota inválida');
      const start = Number(n.start);
      const end = Number(n.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 3600) throw new Error('Tiempo inválido');
      const midi = nameToMidi(n.note);
      const note = `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
      return { note, freq: Math.round(440 * 2 ** ((midi - 69) / 12) * 100) / 100, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
    })
    .sort((a, b) => a.start - b.start);
}

function sanitizeWords(words) {
  if (!Array.isArray(words) || words.length > 20000) throw new Error('Letra inválida');
  return words
    .filter((w) => w && typeof w.word === 'string' && w.word.trim())
    .map((w) => {
      const start = Number(w.start);
      const end = Number(w.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) throw new Error('Tiempo inválido');
      return { word: w.word.trim().slice(0, 60), start, end };
    });
}

class Library {
  constructor(userData) {
    this.root = path.join(userData, 'library');
    this.scoresFile = path.join(userData, 'scores.json');
    fs.mkdirSync(this.root, { recursive: true });
  }

  dir(id) {
    assertId(id);
    return path.join(this.root, id);
  }

  song(id) {
    return readJson(path.join(this.dir(id), 'song.json'));
  }

  update(id, patch) {
    const file = path.join(this.dir(id), 'song.json');
    const song = { ...readJson(file, {}), ...patch };
    writeJson(file, song);
    return song;
  }

  list() {
    const out = [];
    for (const id of fs.readdirSync(this.root)) {
      if (!ID_RE.test(id)) continue;
      const s = this.song(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  }

  /** Canciones que quedaron "procesando" cuando se cerró la app. */
  markInterrupted() {
    for (const s of this.list()) {
      if (s.status === 'processing' || s.status === 'queued') this.update(s.id, { status: 'error', error: 'Procesamiento interrumpido. Vuelve a intentarlo.' });
    }
  }

  importMp3(src, { lyrics = false } = {}) {
    if (typeof src !== 'string' || path.extname(src).toLowerCase() !== '.mp3') throw new Error('Solo se aceptan archivos .mp3');
    const stat = fs.statSync(src);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MP3_BYTES) throw new Error('El MP3 debe pesar como máximo 60 MB');
    if (!looksLikeMp3(src)) throw new Error('El archivo no parece un MP3 válido');
    const id = crypto.randomUUID();
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir);
    fs.copyFileSync(src, path.join(dir, 'source.mp3'));
    const title = path.basename(src, path.extname(src)).slice(0, 120);
    const song = { id, title, status: 'queued', lyricsRequested: !!lyrics, created: new Date().toISOString() };
    writeJson(path.join(dir, 'song.json'), song);
    return song;
  }

  delete(id) {
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    const scores = this.scores().filter((s) => s.songId !== id);
    writeJson(this.scoresFile, scores);
  }

  load(id) {
    const dir = this.dir(id);
    const song = this.song(id);
    if (!song || song.status !== 'ready') throw new Error('La canción no está lista');
    return {
      song,
      meta: readJson(path.join(dir, 'meta.json'), {}),
      notes: readJson(path.join(dir, 'notes.json'), []),
      notesLearning: readJson(path.join(dir, 'notes_learning.json'), []),
      pitchCurve: readJson(path.join(dir, 'pitch_curve.json'), null),
      lyrics: readJson(path.join(dir, 'lyrics.json'), null),
      edited: {
        normal: fs.existsSync(path.join(dir, 'notes.orig.json')),
        learning: fs.existsSync(path.join(dir, 'notes_learning.orig.json')),
      },
    };
  }

  mediaPath(id, file) {
    if (!MEDIA_FILES.has(file)) return null;
    return path.join(this.dir(id), file);
  }

  writeMidis(id) {
    const dir = this.dir(id);
    const meta = readJson(path.join(dir, 'meta.json'), {});
    const song = this.song(id) || {};
    const opts = { title: song.title || 'Solfy', tuningCents: meta.tuning_offset_cents || 0 };
    fs.writeFileSync(path.join(dir, 'melody.mid'), buildMidi(readJson(path.join(dir, 'notes.json'), []), opts));
    fs.writeFileSync(path.join(dir, 'melody_learning.mid'), buildMidi(readJson(path.join(dir, 'notes_learning.json'), []), opts));
  }

  midiPath(id, mode) {
    return path.join(this.dir(id), mode === 'learning' ? 'melody_learning.mid' : 'melody.mid');
  }

  saveNotes(id, mode, notes) {
    const file = MODES[mode];
    if (!file) throw new Error('Modo inválido');
    const dir = this.dir(id);
    const clean = sanitizeNotes(notes);
    const backup = path.join(dir, file.replace('.json', '.orig.json'));
    if (!fs.existsSync(backup)) fs.copyFileSync(path.join(dir, file), backup);
    writeJson(path.join(dir, file), clean);
    this.writeMidis(id);
    return clean;
  }

  restoreNotes(id, mode) {
    const file = MODES[mode];
    if (!file) throw new Error('Modo inválido');
    const dir = this.dir(id);
    const backup = path.join(dir, file.replace('.json', '.orig.json'));
    if (fs.existsSync(backup)) fs.renameSync(backup, path.join(dir, file));
    this.writeMidis(id);
    return readJson(path.join(dir, file), []);
  }

  saveLyrics(id, words) {
    const dir = this.dir(id);
    const clean = sanitizeWords(words);
    const backup = path.join(dir, 'lyrics.orig.json');
    if (!fs.existsSync(backup) && fs.existsSync(path.join(dir, 'lyrics.json'))) fs.copyFileSync(path.join(dir, 'lyrics.json'), backup);
    writeJson(path.join(dir, 'lyrics.json'), clean);
    return clean;
  }

  scores() {
    return readJson(this.scoresFile, []);
  }

  addScore(entry) {
    assertId(entry && entry.songId);
    const num = (v, lo, hi) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('Puntaje inválido');
      return n;
    };
    const song = this.song(entry.songId);
    const clean = {
      songId: entry.songId,
      title: song ? song.title : '',
      date: new Date().toISOString(),
      mode: entry.mode === 'learning' ? 'learning' : 'normal',
      speed: num(entry.speed, 0.25, 2),
      transpose: num(entry.transpose, -24, 24),
      octaveFree: !!entry.octaveFree,
      score: Math.round(num(entry.score, 0, 100) * 10) / 10,
      hitPct: Math.round(num(entry.hitPct, 0, 100) * 10) / 10,
      grade: ['S', 'A', 'B', 'C', 'D'].includes(entry.grade) ? entry.grade : 'D',
      notes: Math.round(num(entry.notes, 0, 100000)),
      partial: !!entry.partial,
    };
    const all = this.scores();
    all.push(clean);
    writeJson(this.scoresFile, all);
    return clean;
  }
}

module.exports = { Library, assertId };
