'use strict';
// Lanza el motor de Python (sin shell), lee su progreso JSON y procesa una canción a la vez.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WATCHDOG_MS = 10 * 60 * 1000; // sin eventos durante 10 min = colgado
const EXIT_GRACE_MS = 15000; // tras "done", tiempo para que el proceso cierre solo
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
    // Prioridad baja: el motor usa mucho CPU durante minutos y la ventana debe seguir respondiendo.
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* si no se puede, sigue con prioridad normal */
    }
    const job = { id, child, cancelled: false, error: null, done: false, finished: false, stderr: '', started: Date.now(), lastEvent: Date.now() };
    job.closed = new Promise((resolve) => child.once('exit', resolve));
    this.current = job;
    this.library.update(id, { status: 'processing', error: null, progress: 0 });
    this.notify({ id, status: 'processing', stage: 'starting', pct: 0, elapsed: 0 });

    // Sin eventos durante mucho tiempo = motor colgado.
    job.watchdog = setInterval(() => {
      if (Date.now() - job.lastEvent > WATCHDOG_MS) {
        job.error = 'El motor dejó de responder. Revisa engine.log en la carpeta de la canción.';
        killTree(child);
      }
    }, 30000);

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
        job.lastEvent = Date.now();
        if (ev.type === 'progress') {
          this.notify({ id, status: 'processing', stage: ev.stage, pct: ev.pct, elapsed: (Date.now() - job.started) / 1000 });
        } else if (ev.type === 'error') {
          job.error = String(ev.message || 'Error desconocido');
        } else if (ev.type === 'done') {
          // Los resultados ya están escritos: no hace falta esperar a que el proceso cierre.
          job.done = true;
          this._complete(job, dir);
          job.exitTimer = setTimeout(() => killTree(child), EXIT_GRACE_MS);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      job.stderr = (job.stderr + d).slice(-4000);
    });
    child.on('close', (code) => {
      clearTimeout(job.exitTimer);
      if (!job.done) this._complete(job, dir, code);
    });
    child.on('error', (e) => {
      job.error = `No se pudo iniciar el motor: ${e.message}`;
      this._complete(job, dir, -1);
    });
  }

  async _complete(job, dir, code = 0) {
    if (job.finished) return;
    job.finished = true;
    clearInterval(job.watchdog);
    const { id } = job;
    if (this.current === job) this.current = null;
    try {
      if (job.cancelled) {
        this.library.update(id, { status: 'error', error: 'Cancelado' });
        this.notify({ id, status: 'error', error: 'Cancelado' });
      } else if (job.done) {
        const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8'));
        let warning = null;
        try {
          await this.library.writeMidis(id);
        } catch (e) {
          warning = `No se pudo crear el MIDI: ${e.message}`;
          console.error('[solfy]', warning);
        }
        const seconds = Math.round((Date.now() - job.started) / 1000);
        this.library.update(id, { status: 'ready', duration: meta.duration, hasLyrics: !!meta.lyrics, progress: 1, processSeconds: seconds, warning });
        this.notify({ id, status: 'ready', warning });
      } else {
        const error = job.error || `El motor terminó con código ${code}`;
        if (!job.error) console.error('[solfy] engine stderr:', job.stderr);
        this.library.update(id, { status: 'error', error });
        this.notify({ id, status: 'error', error });
      }
    } catch (e) {
      const error = String(e.message || e);
      this.library.update(id, { status: 'error', error });
      this.notify({ id, status: 'error', error });
    }
    this._next();
  }
}

module.exports = { EngineRunner };
