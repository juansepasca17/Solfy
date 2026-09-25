// Tema claro/oscuro: dos paletas en CSS; el canvas lee los mismos tokens.

const listeners = new Set();
const media = window.matchMedia('(prefers-color-scheme: dark)');
let pref = 'system';

function effective() {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

function apply() {
  document.documentElement.dataset.theme = effective();
  const tokens = readTokens();
  listeners.forEach((fn) => fn(tokens));
}

export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (k) => cs.getPropertyValue(k).trim();
  const keys = ['stage-bg', 'stage-pattern', 'stage-grid', 'stage-grid-c', 'stage-now', 'stage-text', 'note-fill', 'note-base', 'note-edge', 'note-hit', 'note-sel', 'voice', 'voice-ball-hi', 'voice-ball', 'voice-ball-lo', 'curve', 'loop', 'muted'];
  return Object.fromEntries(keys.map((k) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), get('--' + k)]));
}

export function initTheme(initial) {
  pref = initial || 'system';
  media.addEventListener('change', () => pref === 'system' && apply());
  apply();
}

export function setTheme(p) {
  pref = p;
  apply();
}

export function toggleTheme() {
  pref = effective() === 'dark' ? 'light' : 'dark';
  apply();
  return pref;
}

export function getThemePref() {
  return pref;
}

export function onTheme(fn) {
  listeners.add(fn);
  fn(readTokens());
}
