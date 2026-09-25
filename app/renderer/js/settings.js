// Preferencias locales de la interfaz (solo en esta PC).

const KEY = 'solfy.settings.v1';
const DEFAULTS = {
  theme: 'system',
  notation: 'latin',
  latencyMs: 100,
  micId: '',
  volPiano: 80,
  volInst: 80,
  mix: 'both',
  showCurve: false,
  showLyrics: true,
  octaveFree: false,
};

let data = { ...DEFAULTS };
try {
  data = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch {
  /* sin almacenamiento: usar valores por defecto */
}

export const settings = new Proxy(data, {
  set(target, k, v) {
    target[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(target));
    } catch {
      /* ignorar */
    }
    return true;
  },
});
