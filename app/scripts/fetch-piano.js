'use strict';
// Descarga (una sola vez, en desarrollo) las muestras de piano Salamander (CC-BY 3.0, Alexander Holm)
// que se incluyen en el repo. La app nunca descarga nada.

const fs = require('fs');
const path = require('path');

const BASE = 'https://tonejs.github.io/audio/salamander/';
const OUT = path.join(__dirname, '..', 'renderer', 'assets', 'piano');
const names = [];
for (let o = 1; o <= 6; o++) for (const n of ['C', 'Ds', 'Fs', 'A']) names.push(`${n}${o}`);
names.push('C7');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const n of names) {
    const dest = path.join(OUT, `${n}.mp3`);
    if (fs.existsSync(dest)) continue;
    const res = await fetch(BASE + `${n}.mp3`);
    if (!res.ok) throw new Error(`${n}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log('ok', n);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
