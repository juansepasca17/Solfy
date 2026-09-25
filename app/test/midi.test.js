'use strict';
// node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { buildMidi } = require('../lib/midi');

function parseTrack(buf) {
  assert.strictEqual(buf.toString('latin1', 0, 4), 'MThd');
  assert.strictEqual(buf.toString('latin1', 14, 18), 'MTrk');
  const len = buf.readUInt32BE(18);
  assert.strictEqual(buf.length, 22 + len);
  // recorrer eventos acumulando ticks
  let i = 22;
  let tick = 0;
  const notes = [];
  let status = 0;
  const readVar = () => {
    let v = 0;
    let b;
    do {
      b = buf[i++];
      v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
  };
  while (i < buf.length) {
    tick += readVar();
    status = buf[i++];
    if (status === 0xff) {
      const type = buf[i++];
      const l = readVar();
      i += l;
      if (type === 0x2f) break;
    } else if ((status & 0xf0) === 0xc0) {
      i += 1;
    } else {
      const a = buf[i++];
      const b = buf[i++];
      if ((status & 0xf0) === 0x90) notes.push({ tick, pitch: a, vel: b });
    }
  }
  return notes;
}

test('MIDI válido con notas normales', () => {
  const buf = buildMidi([{ note: 'C4', start: 1.2, end: 1.85 }, { note: 'E4', start: 1.85, end: 2.4 }], { title: 'Gitana', tuningCents: -23 });
  const notes = parseTrack(buf);
  assert.deepStrictEqual(notes.map((n) => [n.pitch, n.tick]), [[60, 1152], [64, 1776]]);
});

test('notas con tiempos inválidos se descartan en vez de congelar', () => {
  const buf = buildMidi([
    { note: 'C4', start: NaN, end: 1 },
    { note: 'D4', start: -1, end: 0.5 },
    { note: 'E4', start: 1, end: Infinity },
    { note: 'F4', start: 2, end: 2.5 },
  ]);
  assert.deepStrictEqual(parseTrack(buf).map((n) => n.pitch), [65]);
});

test('canción larga: 2000 notas en 10 minutos', () => {
  const list = Array.from({ length: 2000 }, (_, k) => ({ note: ['C4', 'D4', 'E4', 'G4'][k % 4], start: k * 0.3, end: k * 0.3 + 0.25 }));
  const t0 = Date.now();
  const notes = parseTrack(buildMidi(list));
  assert.strictEqual(notes.length, 2000);
  assert.ok(Date.now() - t0 < 1000);
});
