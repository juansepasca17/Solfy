'use strict';
// Verificación de sintaxis de todo el JS (proceso principal CommonJS + interfaz en módulos ES).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const cjs = ['main.js', 'preload.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => `lib/${f}`), 'scripts/smoke.js', 'scripts/fetch-piano.js'];
const esm = fs.readdirSync(path.join(root, 'renderer/js')).map((f) => `renderer/js/${f}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solfy-check-'));

let failed = 0;
const check = (file, rel) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${rel}\n${e.stderr}`);
  }
};
for (const f of cjs) check(path.join(root, f), f);
for (const f of esm) {
  const copy = path.join(tmp, path.basename(f, '.js') + '.mjs');
  fs.copyFileSync(path.join(root, f), copy);
  check(copy, f);
}
fs.rmSync(tmp, { recursive: true, force: true });

// La interfaz no debe cargar nada remoto.
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
if (/(src|href)\s*=\s*["']https?:/i.test(html)) {
  failed++;
  console.error('✗ index.html referencia recursos remotos');
}
console.log(failed ? `${failed} error(es)` : `OK: ${cjs.length + esm.length} archivos`);
process.exit(failed ? 1 : 0);
