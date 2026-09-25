// Calibración de latencia: 8 clics; el usuario dice "ta" en cada uno.
// Latencia = mediana(inicio detectado en el micrófono − momento del clic).

import { Mic } from './mic.js';

const N_CLICKS = 8;
const INTERVAL = 0.75;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

function click(ctx, t) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = 1200;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

export async function calibrate(ctx, micId, status) {
  if (ctx.state !== 'running') await ctx.resume();
  const mic = new Mic(ctx);
  const readings = [];
  await mic.start(micId);
  mic.onReading = ({ rms, ctxTime }) => readings.push({ rms, t: ctxTime });
  try {
    status('Silencio un momento…');
    const start = ctx.currentTime + 1.2;
    const clicks = [];
    for (let i = 0; i < N_CLICKS; i++) {
      clicks.push(start + i * INTERVAL);
      click(ctx, clicks[i]);
    }
    await wait(1000);
    status('Di "ta" justo en cada clic…');
    await wait((start + N_CLICKS * INTERVAL + 0.6 - ctx.currentTime) * 1000);

    const floor = median(readings.filter((r) => r.t < start - 0.1).map((r) => r.rms));
    const thr = Math.max(floor * 4, 0.02);
    const delays = [];
    for (const c of clicks) {
      const win = readings.filter((r) => r.t >= c - 0.15 && r.t <= c + 0.6);
      for (let i = 1; i < win.length; i++) {
        if (win[i].rms > thr && win[i - 1].rms <= thr) {
          delays.push(win[i].t - c);
          break;
        }
      }
    }
    if (delays.length < 4) throw new Error('No se detectaron suficientes "ta". Acércate al micrófono y prueba de nuevo.');
    const ms = Math.round((median(delays) * 1000) / 5) * 5;
    return Math.max(0, Math.min(300, ms));
  } finally {
    mic.stop();
  }
}
