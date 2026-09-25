'use strict';
// Escritor mínimo de MIDI (formato 0, un canal de piano).

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PPQ = 480;
const TEMPO_US = 500000; // 120 bpm -> 1 s = 960 ticks
const TICKS_PER_SEC = (PPQ * 1e6) / TEMPO_US;

function nameToMidi(name) {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`Nota inválida: ${name}`);
  return NAMES.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
}

function varLen(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

/** notes: [{note, start, end}] ; tuningCents: desafinación de la grabación (pitch bend global). */
function buildMidi(notes, { title = 'Solfy', tuningCents = 0 } = {}) {
  const events = [];
  const nameBytes = Buffer.from(title.slice(0, 100), 'utf8');
  events.push({ t: 0, o: 0, data: [0xff, 0x03, ...varLen(nameBytes.length), ...nameBytes] });
  events.push({ t: 0, o: 0, data: [0xff, 0x51, 0x03, (TEMPO_US >> 16) & 0xff, (TEMPO_US >> 8) & 0xff, TEMPO_US & 0xff] });
  events.push({ t: 0, o: 0, data: [0xc0, 0x00] }); // Acoustic Grand Piano
  if (tuningCents) {
    // rango de bend estándar ±2 semitonos
    const bend = Math.max(0, Math.min(16383, Math.round(8192 + (tuningCents / 200) * 8192)));
    events.push({ t: 0, o: 0, data: [0xe0, bend & 0x7f, (bend >> 7) & 0x7f] });
  }
  for (const n of notes) {
    const pitch = nameToMidi(n.note);
    if (pitch < 0 || pitch > 127) continue;
    const on = Math.round(n.start * TICKS_PER_SEC);
    const off = Math.max(on + 1, Math.round(n.end * TICKS_PER_SEC));
    events.push({ t: on, o: 1, data: [0x90, pitch, 90] });
    events.push({ t: off, o: 0, data: [0x80, pitch, 0] }); // note-off antes que note-on del mismo tick
  }
  events.sort((a, b) => a.t - b.t || a.o - b.o);
  const track = [];
  let last = 0;
  for (const e of events) {
    track.push(...varLen(e.t - last), ...e.data);
    last = e.t;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  const len = track.length;
  const trackHeader = Buffer.from([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, trackHeader, Buffer.from(track)]);
}

module.exports = { buildMidi, nameToMidi };
