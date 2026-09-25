import { settings } from './settings.js';
import { initTheme, setTheme, toggleTheme, getThemePref } from './theme.js';
import { setNotation, fmtTime } from './notation.js';
import { Practice } from './practice.js';
import { listMics } from './mic.js';
import { calibrate } from './calibrate.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STAGES = {
  starting: 'Iniciando motor…',
  decoding: 'Leyendo MP3…',
  separating: 'Separando la voz…',
  saving: 'Guardando pistas…',
  pitch: 'Detectando la melodía…',
  pitch_lyrics: 'Detectando la melodía y la letra…',
  beats: 'Buscando el pulso…',
  notes: 'Creando notas…',
  lyrics: 'Transcribiendo la letra…',
};

// ---------- utilidades ----------
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

initTheme(settings.theme);
setNotation(settings.notation);

// ---------- navegación ----------
let current = 'library';
function showView(name) {
  current = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  practice.show(name === 'practice');
  if (name === 'history') renderHistory();
  if (name === 'library') renderLibrary();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => !b.disabled && showView(b.dataset.view)));

// ---------- práctica ----------
const practice = new Practice({ toast, onResult: showResult });

async function openSong(id) {
  try {
    const ok = await practice.open(id);
    if (!ok) return;
    $('#tab-practice').disabled = false;
    showView('practice');
  } catch (e) {
    toast('No se pudo abrir la canción: ' + e.message);
  }
}

// ---------- biblioteca ----------
const progress = new Map(); // id -> {stage, pct, elapsed}

function fmtDuration(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  return `${Math.round(sec / 60)} min`;
}

/** " con GPU" / " con CPU" / " con CPU (la GPU falló)" según meta.device del motor. */
function deviceLabel(d) {
  if (!d) return '';
  if (d.separation === 'gpu' && d.pitch === 'gpu') return ' con GPU';
  if (d.gpu_error) return ' con CPU (la GPU falló)';
  if (d.separation === 'gpu' || d.pitch === 'gpu') return ' con GPU + CPU';
  return ' con CPU';
}

/** "Detectando la melodía… 42% · quedan ~3 min" */
function progressLabel(p) {
  if (!p) return 'Procesando…';
  const pct = Math.round((p.pct || 0) * 100);
  let eta = '';
  if (p.elapsed > 20 && p.pct > 0.05 && p.pct < 1) eta = ` · quedan ~${fmtDuration((p.elapsed * (1 - p.pct)) / p.pct)}`;
  return `${STAGES[p.stage] || 'Procesando…'} ${pct}%${eta}`;
}

async function renderLibrary() {
  const songs = await window.solfy.library.list();
  const list = $('#song-list');
  $('#empty-library').hidden = songs.length > 0;
  list.innerHTML = songs
    .map((s) => {
      const p = progress.get(s.id);
      let sub = '';
      let actions = '';
      if (s.status === 'ready') {
        sub = `${fmtTime(s.duration)}${s.hasLyrics ? ' · con letra' : ''}${s.processSeconds ? ` · procesada en ${fmtDuration(s.processSeconds)}${deviceLabel(s.device)}` : ''}${s.warning ? ` · <span class="err">${esc(s.warning)}</span>` : ''}`;
        actions = `<button class="btn primary" data-act="open">Practicar</button><button class="btn" data-act="rename">Renombrar</button><button class="btn danger" data-act="delete">Borrar</button>`;
      } else if (s.status === 'processing' || s.status === 'queued') {
        const pct = p ? Math.round(p.pct * 100) : 0;
        sub = `${s.status === 'queued' ? 'En cola…' : esc(progressLabel(p))}<div class="progress"><div data-pct="${pct}"></div></div>`;
        actions = `<button class="btn" data-act="cancel">Cancelar</button>`;
      } else {
        sub = `<span class="err">${esc(s.error || 'Error')}</span>`;
        actions = `<button class="btn" data-act="retry">Reintentar</button><button class="btn danger" data-act="delete">Borrar</button>`;
      }
      return `<div class="song" data-id="${esc(s.id)}"><div class="song-title" title="${esc(s.title)}">${esc(s.title)}</div><div class="song-actions">${actions}</div><div class="song-sub">${sub}</div></div>`;
    })
    .join('');
  // CSP bloquea style="" en el HTML; el ancho se asigna por CSSOM
  list.querySelectorAll('[data-pct]').forEach((d) => (d.style.width = `${d.dataset.pct}%`));
}

$('#song-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.song').dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'open') await openSong(id);
    if (act === 'retry') await window.solfy.library.retry(id);
    if (act === 'cancel') await window.solfy.engine.cancel(id);
    if (act === 'rename') {
      const title = btn.closest('.song').querySelector('.song-title');
      const input = document.createElement('input');
      input.value = title.textContent;
      input.maxLength = 120;
      title.replaceWith(input);
      input.focus();
      const done = async (save) => {
        if (save && input.value.trim()) await window.solfy.library.rename(id, input.value.trim());
        renderLibrary();
      };
      input.addEventListener('keydown', (ev) => ev.key === 'Enter' ? done(true) : ev.key === 'Escape' && done(false));
      input.addEventListener('blur', () => done(true));
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('¿Borrar esta canción, sus notas y sus puntajes? No se puede deshacer.')) return;
      await window.solfy.library.remove(id);
      if (practice.id === id) {
        practice.show(false);
        practice.id = null;
        practice.data = null;
        $('#tab-practice').disabled = true;
      }
    }
  } catch (err) {
    toast(err.message);
  }
  renderLibrary();
});

$('#btn-import').addEventListener('click', async () => {
  try {
    const added = await window.solfy.library.pick({ lyrics: $('#opt-lyrics').checked });
    if (added.length) toast('Canción agregada. Se está procesando…');
  } catch (e) {
    toast(e.message);
  }
  renderLibrary();
});

const drop = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    if (!f.name.toLowerCase().endsWith('.mp3')) {
      toast(`"${f.name}" no es un MP3.`);
      continue;
    }
    try {
      await window.solfy.library.importFile(f, { lyrics: $('#opt-lyrics').checked });
      toast('Canción agregada. Se está procesando…');
    } catch (err) {
      toast(err.message);
    }
  }
  renderLibrary();
});
// evitar que soltar un archivo fuera de la zona navegue
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

window.solfy.engine.onEvent((ev) => {
  if (ev.notice) {
    toast(ev.notice);
    return;
  }
  if (ev.status === 'processing') progress.set(ev.id, { stage: ev.stage, pct: ev.pct || 0, elapsed: ev.elapsed || 0 });
  else progress.delete(ev.id);
  if (ev.status === 'ready') toast('¡Lista! Ya puedes practicar la canción.');
  if (ev.status === 'error' && ev.error !== 'Cancelado') toast('Error al procesar: ' + ev.error);
  if (current === 'library') {
    // actualizar solo la barra si ya existe, para no redibujar todo en cada evento
    const card = document.querySelector(`.song[data-id="${CSS.escape(ev.id)}"]`);
    if (ev.status === 'processing' && card && card.querySelector('.progress')) {
      const pct = Math.round((ev.pct || 0) * 100);
      card.querySelector('.progress > div').style.width = `${pct}%`;
      card.querySelector('.song-sub').firstChild.textContent = progressLabel(progress.get(ev.id));
    } else {
      renderLibrary();
    }
  }
});

// ---------- historial ----------
async function renderHistory() {
  const all = await window.solfy.scores.list();
  const filter = $('#history-filter');
  const songs = new Map(all.map((s) => [s.songId, s.title]));
  const prev = filter.value;
  filter.innerHTML = '<option value="">Todas</option>' + [...songs].map(([id, t]) => `<option value="${esc(id)}">${esc(t)}</option>`).join('');
  filter.value = songs.has(prev) ? prev : '';
  const rows = all.filter((s) => !filter.value || s.songId === filter.value).sort((a, b) => b.date.localeCompare(a.date));

  $('#empty-history').hidden = rows.length > 0;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const scores = rows.map((r) => r.score);
  const full = rows.filter((r) => !r.partial).map((r) => r.score);
  $('#stats').innerHTML = [
    ['Intentos', rows.length],
    ['Promedio', scores.length ? avg(scores).toFixed(1) : '–'],
    ['Mejor', scores.length ? Math.max(...scores).toFixed(1) : '–'],
    ['Promedio últimos 5', scores.length ? avg(scores.slice(0, 5)).toFixed(1) : '–'],
    ['Promedio canciones completas', full.length ? avg(full).toFixed(1) : '–'],
  ]
    .map(([k, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`)
    .join('');

  $('#history-body').innerHTML = rows
    .map((r) => {
      const d = new Date(r.date);
      const date = `${d.toLocaleDateString('es')} ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
      const mode = `${r.mode === 'learning' ? 'Aprendizaje' : 'Normal'}${r.octaveFree ? ' · oct. libre' : ''}${r.partial ? ' · parcial' : ''}`;
      const tr = r.transpose ? (r.transpose > 0 ? `+${r.transpose}` : r.transpose) : '0';
      return `<tr><td>${esc(date)}</td><td>${esc(r.title)}</td><td>${esc(mode)}</td><td class="num">${Math.round(r.speed * 100)}%</td><td class="num">${esc(tr)}</td><td class="num">${r.hitPct.toFixed(0)}%</td><td class="num"><strong>${r.score.toFixed(1)}</strong><span class="grade">${esc(r.grade)}</span></td></tr>`;
    })
    .join('');
}
$('#history-filter').addEventListener('change', renderHistory);

// ---------- resultado ----------
async function showResult(r, entry) {
  $('#res-grade').textContent = r.grade;
  $('#res-score').textContent = r.score.toFixed(1);
  $('#res-detail').textContent = `${r.hits} de ${r.count} notas acertadas (${r.hitPct.toFixed(0)} %)${entry.partial ? ' · intento parcial' : ''}`;
  $('#res-map').innerHTML = r.map.map((m) => `<span class="${m}"></span>`).join('');
  const all = (await window.solfy.scores.list()).filter((s) => s.songId === entry.songId);
  const prevScores = all.slice(0, -1).map((s) => s.score);
  $('#res-compare').textContent = prevScores.length
    ? `Tu promedio en esta canción: ${(prevScores.reduce((a, b) => a + b, 0) / prevScores.length).toFixed(1)} · mejor: ${Math.max(...prevScores).toFixed(1)}`
    : 'Primer intento en esta canción.';
  $('#result-dialog').showModal();
}
$('#res-close').addEventListener('click', () => $('#result-dialog').close());
$('#res-history').addEventListener('click', () => {
  $('#result-dialog').close();
  showView('history');
});

// ---------- ajustes ----------
async function openSettings() {
  $('#set-notation').value = settings.notation;
  $('#set-theme').value = getThemePref();
  $('#set-latency').value = settings.latencyMs;
  $('#set-latency-out').value = `${settings.latencyMs} ms`;
  $('#set-vol-piano').value = settings.volPiano;
  $('#set-vol-inst').value = settings.volInst;
  const mics = await listMics();
  $('#set-mic').innerHTML = '<option value="">Predeterminado</option>' + mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, i) => `<option value="${esc(m.deviceId)}">${esc(m.label || `Micrófono ${i + 1}`)}</option>`).join('');
  $('#set-mic').value = settings.micId;
  $('#set-device').value = settings.device;
  showGpuInfo();
  const info = await window.solfy.info();
  $('#about').textContent = `Solfy ${info.version} · Piano: Salamander Grand Piano (CC-BY 3.0, Alexander Holm) · Separación: Demucs · Tono: CREPE`;
  $('#settings-dialog').showModal();
}
$('#btn-settings').addEventListener('click', openSettings);

let gpuInfo = null;
async function showGpuInfo() {
  const el = $('#gpu-info');
  try {
    gpuInfo = gpuInfo || (await window.solfy.engine.gpuInfo());
  } catch {
    gpuInfo = { names: [], available: false };
  }
  const names = gpuInfo.names.join(' · ') || 'ninguna';
  if (gpuInfo.available) {
    el.textContent = `GPU: ${names}. DirectML listo: el modo GPU usa la más potente. Si falla, la canción se termina en CPU.`;
  } else if (!gpuInfo.dml) {
    el.textContent = `GPU: ${names}. DirectML no está disponible en esta PC: se usará CPU.`;
  } else {
    el.textContent = `GPU: ${names}. Faltan los modelos de GPU en esta instalación: se usará CPU.`;
  }
}

$('#set-device').addEventListener('change', async (e) => {
  settings.device = e.target.value;
  await window.solfy.engine.setDevice(settings.device);
  if (settings.device === 'gpu' && gpuInfo && !gpuInfo.available) toast('No hay GPU compatible: las canciones se procesarán en CPU.');
});
$('#set-close').addEventListener('click', () => $('#settings-dialog').close());
$('#set-notation').addEventListener('change', (e) => {
  settings.notation = e.target.value;
  setNotation(settings.notation);
});
$('#set-theme').addEventListener('change', (e) => {
  settings.theme = e.target.value;
  setTheme(settings.theme);
});
$('#btn-theme').addEventListener('click', () => {
  settings.theme = toggleTheme();
});
$('#set-latency').addEventListener('input', (e) => {
  settings.latencyMs = Number(e.target.value);
  $('#set-latency-out').value = `${settings.latencyMs} ms`;
});
$('#set-vol-piano').addEventListener('input', (e) => {
  settings.volPiano = Number(e.target.value);
  practice.applySettings();
});
$('#set-vol-inst').addEventListener('input', (e) => {
  settings.volInst = Number(e.target.value);
  practice.applySettings();
});
$('#set-mic').addEventListener('change', (e) => {
  settings.micId = e.target.value;
  practice.restartMic();
});
$('#btn-calibrate').addEventListener('click', async () => {
  const status = $('#calib-status');
  const btn = $('#btn-calibrate');
  btn.disabled = true;
  try {
    const ms = await calibrate(practice.ctx, settings.micId, (msg) => (status.textContent = msg));
    settings.latencyMs = ms;
    $('#set-latency').value = ms;
    $('#set-latency-out').value = `${ms} ms`;
    status.textContent = `Listo: ${ms} ms`;
  } catch (e) {
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- arranque ----------
window.solfy.engine.setDevice(settings.device).catch(() => {});
renderLibrary();
