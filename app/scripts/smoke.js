'use strict';
// Prueba de humo (solo desarrollo): SOLFY_SMOKE=<ruta.mp3> SOLFY_SMOKE_OUT=<carpeta> npm start
// Importa el MP3, espera el procesamiento, abre la práctica, reproduce y guarda capturas.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke({ win, library, runner }) {
  const mp3 = process.env.SOLFY_SMOKE;
  const out = process.env.SOLFY_SMOKE_OUT || path.join(app.getPath('temp'), 'solfy-smoke');
  fs.mkdirSync(out, { recursive: true });
  const log = (...a) => console.log('[smoke]', ...a);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name), img.toPNG());
    log('captura', name);
  };

  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await sleep(800);
    let song = library.list().find((s) => s.status === 'ready');
    if (!song) {
      song = library.importMp3(mp3, { lyrics: process.env.SOLFY_SMOKE_LYRICS === '1' });
      runner.enqueue(song.id);
      await sleep(1500);
      await shot('01-procesando.png');
      const t0 = Date.now();
      while (!['ready', 'error'].includes(library.song(song.id).status)) {
        if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('timeout procesando');
        await sleep(2000);
      }
      log('estado', library.song(song.id).status, library.song(song.id).error || '', `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await js(`document.querySelector('[data-view=library]').click()`);
    await sleep(600);
    await shot('02-biblioteca.png');

    await js(`document.querySelector('.song[data-id="${song.id}"] [data-act=open]').click()`);
    await sleep(1500);
    await js(`document.querySelector('#show-curve').click()`);
    await js(`document.querySelector('#btn-play').click()`);
    await sleep(3500);
    await shot('03-practica-claro.png');
    await js(`document.querySelector('#btn-theme').click()`);
    await sleep(500);
    await shot('04-practica-oscuro.png');
    await js(`document.querySelector('[data-diff=learning]').click()`);
    await sleep(1500);
    await shot('05-aprendizaje-oscuro.png');

    // Tu turno (si hay micrófono)
    await js(`document.querySelector('[data-play=sing]').click()`);
    await sleep(4000);
    await shot('06-tu-turno.png');
    const st = await js(`({ t: document.querySelector('#time').textContent, note: document.querySelector('#hud-note').textContent, label: document.querySelector('#hud-label').textContent })`);
    log('hud', JSON.stringify(st));

    await js(`document.querySelector('#btn-stop').click()`);
    await sleep(800);
    await shot('07-resultado.png');
    await js(`document.querySelector('#result-dialog').open && document.querySelector('#res-close').click()`);

    // Editor: modo Normal, pausa en t=1.2 s, buscar la nota bajo la línea central y subirla un semitono
    await js(`document.querySelector('[data-play=listen]').click(); document.querySelector('[data-diff=normal]').click()`);
    await sleep(800);
    const dir = library.dir(song.id);
    fs.writeFileSync(path.join(dir, 'lyrics.json'), JSON.stringify([{ word: 'Do', start: 0.05, end: 0.4 }, { word: 're', start: 0.5, end: 0.9 }, { word: 'mi', start: 1.0, end: 1.4 }]));
    await js(`document.querySelector('[data-view=library]').click()`);
    await sleep(300);
    await js(`document.querySelector('.song[data-id="${song.id}"] [data-act=open]').click()`);
    await sleep(1200);
    const seek = await js(`(() => { const s = document.querySelector('#seek'); s.value = String(Math.round(1.2 / ${library.song(song.id).duration} * 1000)); s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); return s.value; })()`);
    log('seek', seek);
    await js(`document.querySelector('#btn-edit').click()`);
    await sleep(300);
    const rect = await js(`(() => { const r = document.querySelector('#roll').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const cx = Math.round(rect.x + rect.w / 2 + 5);
    let edited = false;
    for (let y = Math.round(rect.y + 110); y < rect.y + rect.h - 10 && !edited; y += 8) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y, button: 'left', clickCount: 1 });
      await sleep(40);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
      await sleep(40);
      edited = await js(`!document.querySelector('#ed-save').disabled`);
    }
    log('editor: nota editada =', edited);
    await shot('10-editor.png');
    if (edited) {
      await js(`document.querySelector('#ed-save').click()`);
      await sleep(800);
      const saved = library.load(song.id);
      log('editor: guardado, notas =', saved.notes.length, 'backup =', saved.edited.normal, 'midi bytes =', fs.statSync(library.midiPath(song.id, 'normal')).size);
    }
    await js(`document.querySelector('#btn-edit').click()`);
    await js(`document.querySelector('#result-dialog').open && document.querySelector('#res-history').click(); document.querySelector('[data-view=history]').click()`);
    await sleep(800);
    await shot('08-historial.png');
    await js(`document.querySelector('#btn-theme').click()`);
    await js(`document.querySelector('#btn-settings').click()`);
    await sleep(600);
    await shot('09-ajustes.png');
    log('OK');
  } catch (e) {
    log('FALLÓ', e.stack || e);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
};
