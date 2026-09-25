// Nombres de notas: C D E (inglés) o Do Re Mi (latino).

const ENGLISH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LATIN = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

let style = 'latin';

export function setNotation(s) {
  style = s === 'english' ? 'english' : 'latin';
}

export function nameToMidi(name) {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  return m ? ENGLISH.indexOf(m[1]) + (Number(m[2]) + 1) * 12 : NaN;
}

export function midiName(midi, withOctave = true) {
  const r = Math.round(midi);
  const names = style === 'english' ? ENGLISH : LATIN;
  const base = names[((r % 12) + 12) % 12];
  return withOctave ? `${base}${Math.floor(r / 12) - 1}` : base;
}

export function englishName(midi) {
  const r = Math.round(midi);
  return `${ENGLISH[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

/** Convierte el notes.json del motor en objetos de trabajo {pitch,start,end}. */
export function parseNotes(list) {
  return (list || [])
    .map((n) => ({ pitch: nameToMidi(n.note), start: +n.start, end: +n.end }))
    .filter((n) => Number.isFinite(n.pitch) && n.end > n.start)
    .sort((a, b) => a.start - b.start);
}

export function serializeNotes(notes) {
  return notes.map((n) => ({ note: englishName(n.pitch), freq: Math.round(midiToFreq(n.pitch) * 100) / 100, start: n.start, end: n.end }));
}

export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
