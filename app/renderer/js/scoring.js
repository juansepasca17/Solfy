// Puntaje: por cada lectura del micrófono dentro de una nota objetivo
//   ±50 cents = 1, ±100 cents = 0.5, fuera o en silencio = 0.
// Nota acertada = más del 60 % de sus lecturas dentro de ±50 cents.
// Puntaje final = promedio de las notas ponderado por duración (0–100).

export function centsDiff(user, target, octaveFree) {
  let d = (user - target) * 100;
  if (octaveFree) d = ((((d + 600) % 1200) + 1200) % 1200) - 600;
  return d;
}

export function gradeFor(score) {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

export class ScoreSession {
  constructor(notes, { transpose = 0, octaveFree = false, tuningCents = 0 } = {}) {
    this.notes = notes;
    this.transpose = transpose;
    this.octaveFree = octaveFree;
    this.tuning = tuningCents / 100;
    this.stats = new Map(); // idx -> {frames, sum, good}
  }

  _noteAt(t) {
    const ns = this.notes;
    let lo = 0;
    let hi = ns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ns[mid].end <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo < ns.length && ns[lo].start <= t ? lo : -1;
  }

  /** userMidi: MIDI del micrófono (o null). Devuelve {idx, cents} o null si no hay nota objetivo. */
  frame(songTime, userMidi) {
    const idx = this._noteAt(songTime);
    if (idx < 0) return null;
    const st = this.stats.get(idx) || { frames: 0, sum: 0, good: 0 };
    st.frames++;
    let cents = null;
    if (userMidi != null) {
      cents = centsDiff(userMidi - this.tuning, this.notes[idx].pitch + this.transpose, this.octaveFree);
      const a = Math.abs(cents);
      if (a <= 50) {
        st.sum += 1;
        st.good++;
      } else if (a <= 100) st.sum += 0.5;
    }
    this.stats.set(idx, st);
    return { idx, cents };
  }

  noteRatio(idx) {
    const st = this.stats.get(idx);
    return st && st.frames >= 3 ? st.good / st.frames : null;
  }

  result() {
    let wsum = 0;
    let wtot = 0;
    let hits = 0;
    const map = [];
    const idxs = [...this.stats.keys()].sort((a, b) => a - b);
    for (const i of idxs) {
      const st = this.stats.get(i);
      if (st.frames < 3) continue;
      const n = this.notes[i];
      const dur = n.end - n.start;
      const s = st.sum / st.frames;
      const hit = st.good / st.frames > 0.6;
      wsum += s * dur;
      wtot += dur;
      if (hit) hits++;
      map.push(hit ? 'hit' : s >= 0.3 ? 'half' : 'miss');
    }
    const count = map.length;
    const score = wtot > 0 ? (wsum / wtot) * 100 : 0;
    return { score, hitPct: count ? (hits / count) * 100 : 0, hits, count, grade: gradeFor(score), map, coverage: this.notes.length ? count / this.notes.length : 0 };
  }
}
