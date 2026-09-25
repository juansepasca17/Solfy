'use strict';
// Lanza el motor de Python (sin shell), lee su progreso JSON y procesa una canción a la vez.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function engineCommand() {
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'engine');
    return { cmd: path.join(dir, 'solfy-engine.exe'), pre: [], cwd: dir, models: path.join(dir, 'models') };
  }
  const repo = path.resolve(__dirname, '..', '..');
  const engineDir = path.join(repo, 'engine');
  const py = path.join(engineDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return { cmd: py, pre: ['-m', 'solfy_engine'], cwd: engineDir, models: path.join(repo, 'models') };
}

// Solo las variables necesarias: nada del entorno del usuario se pasa al motor.
function engineEnv(models) {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PATH', 'Path'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { SOLFY_MODELS: models, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' });
  return env;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

class EngineRunner {
  constructor(library, notify) {
    this.library = library;
    this.notify = notify; // (event) => void
    this.queue = [];
    this.current = null;
  }

  enqueue(id) {
    if (!this.queue.includes(id) && (!this.current || this.current.id !== id)) this.queue.push(id);
    this.library.update(id, { status: 'queued', error: null });
    this.notify({ id, status: 'queued' });
    this._next();
  }

  cancel(id) {
    const wasQueued = this.queue.includes(id);
    this.queue = this.queue.filter((q) => q !== id);
    if (this.current && this.current.id === id) {
      this.current.cancelled = true;
      killTree(this.current.child);
    } else if (wasQueued) {
      this.library.update(id, { status: 'error', error: 'Cancelado' });
      this.notify({ id, status: 'error', error: 'Cancelado' });
    }
  }

  /** Cancela y espera a que el proceso termine (para poder borrar sus archivos). */
  async cancelAndWait(id) {
    const job = this.current && this.current.id === id ? this.current : null;
    this.cancel(id);
    if (job) await job.closed;
  }

  shutdown() {
    this.queue = [];
    if (this.current) killTree(this.current.child);
  }

  _next() {
    if (this.current || !this.queue.length) return;
    const id = this.queue.shift();
    const song = this.library.song(id);
    if (!song) return this._next();
    const dir = this.library.dir(id);
    const { cmd, pre, cwd, models } = engineCommand();
    if (!fs.existsSync(cmd)) {
      const error = 'No se encontró el motor de audio. Reinstala Solfy.';
      this.library.update(id, { status: 'error', error });
      this.notify({ id, status: 'error', error });
      return this._next();
    }
    const args = [...pre, 'process', '--input', path.join(dir, 'source.mp3'), '--out', dir, '--title', song.title];
    if (song.lyricsRequested) args.push('--lyrics');

    const child = spawn(cmd, args, { cwd, env: engineEnv(models), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { id, child, cancelled: false, error: null, done: false, stderr: '' };
    job.closed = new Promise((resolve) => child.once('exit', resolve));
    this.current = job;
    this.library.update(id, { status: 'processing', error: null, progress: 0 });
    this.notify({ id, status: 'processing', stage: 'starting', pct: 0 });

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'progress') this.notify({ id, status: 'processing', stage: ev.stage, pct: ev.pct });
        else if (ev.type === 'error') job.error = String(ev.message || 'Error desconocido');
        else if (ev.type === 'done') job.done = true;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      job.stderr = (job.stderr + d).slice(-4000);
    });
    const finish = (code) => {
      if (this.current !== job) return;
      this.current = null;
      if (job.cancelled) {
        this.library.update(id, { status: 'error', error: 'Cancelado' });
        this.notify({ id, status: 'error', error: 'Cancelado' });
      } else if (job.done && code === 0) {
        try {
          this.library.writeMidis(id);
          const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
          this.library.update(id, { status: 'ready', duration: meta.duration, hasLyrics: !!meta.lyrics, progress: 1 });
          this.notify({ id, status: 'ready' });
        } catch (e) {
          this.library.update(id, { status: 'error', error: String(e.message || e) });
          this.notify({ id, status: 'error', error: String(e.message || e) });
        }
      } else {
        const error = job.error || `El motor terminó con código ${code}`;
        if (!job.error) console.error('[solfy] engine stderr:', job.stderr);
        this.library.update(id, { status: 'error', error });
        this.notify({ id, status: 'error', error });
      }
      this._next();
    };
    child.on('close', finish);
    child.on('error', (e) => {
      job.error = `No se pudo iniciar el motor: ${e.message}`;
      finish(-1);
    });
  }
}

module.exports = { EngineRunner };
