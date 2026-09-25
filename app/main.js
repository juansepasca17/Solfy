'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require('electron');
const security = require('./lib/security');
const appProtocol = require('./lib/protocol');
const { Library } = require('./lib/library');
const { EngineRunner } = require('./lib/engine-runner');

// Sin reporte de fallos ni servicios en segundo plano de Chromium.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');

if (!app.isPackaged && process.env.SOLFY_USERDATA) app.setPath('userData', process.env.SOLFY_USERDATA);

appProtocol.registerPrivileged();
security.install();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let library = null;
let runner = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function fromApp(event) {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  if (!security.isAppUrl(url)) throw new Error('Origen no permitido');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    fromApp(event);
    return fn(...args);
  });
}

function registerIpc() {
  handle('library:list', () => library.list());
  handle('library:load', (id) => library.load(id));

  handle('library:pick', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Elige una canción (MP3)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'MP3', extensions: ['mp3'] }],
    });
    if (r.canceled) return [];
    const added = [];
    for (const p of r.filePaths) added.push(await importOne(p, opts));
    return added;
  });

  handle('library:importPath', (p, opts = {}) => importOne(p, opts));

  handle('library:retry', (id) => {
    library.dir(id);
    runner.enqueue(id);
    return true;
  });

  handle('library:delete', async (id) => {
    library.dir(id);
    await runner.cancelAndWait(id);
    library.delete(id);
    return true;
  });

  handle('library:rename', (id, title) => {
    const clean = String(title || '').trim().slice(0, 120);
    if (!clean) throw new Error('Título vacío');
    return library.update(id, { title: clean });
  });

  handle('library:exportMidi', async (id, mode) => {
    const song = library.song(id);
    const src = library.midiPath(id, mode);
    const safe = (song.title || 'melodia').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const r = await dialog.showSaveDialog(win, {
      title: 'Guardar MIDI',
      defaultPath: `${safe}${mode === 'learning' ? ' (aprendizaje)' : ''}.mid`,
      filters: [{ name: 'MIDI', extensions: ['mid'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.copyFileSync(src, r.filePath);
    return true;
  });

  handle('engine:cancel', (id) => {
    library.dir(id);
    runner.cancel(id);
    return true;
  });

  handle('notes:save', (id, mode, notes) => library.saveNotes(id, mode, notes));
  handle('notes:restore', (id, mode) => library.restoreNotes(id, mode));
  handle('lyrics:save', (id, words) => library.saveLyrics(id, words));

  handle('scores:add', (entry) => library.addScore(entry));
  handle('scores:list', () => library.scores());

  handle('app:info', () => ({ version: app.getVersion(), dark: nativeTheme.shouldUseDarkColors }));
}

async function importOne(p, opts) {
  const song = await library.importMp3(p, { lyrics: !!(opts && opts.lyrics) });
  runner.enqueue(song.id);
  return song;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Solfy',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151618' : '#e9e9eb',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
  }
  win.loadURL('app://solfy/index.html');
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  security.hardenSession();
  library = new Library(app.getPath('userData'));
  library.markInterrupted();
  runner = new EngineRunner(library, (ev) => send('engine:event', ev));
  appProtocol.install(library);
  registerIpc();
  createWindow();
  if (!app.isPackaged && process.env.SOLFY_SMOKE) require('./scripts/smoke')({ win, library, runner });
});

app.on('before-quit', () => runner && runner.shutdown());
app.on('window-all-closed', () => app.quit());
