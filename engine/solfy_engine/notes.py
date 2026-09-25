"""De curva de tono (MIDI flotante por frame) a notas discretas, en dos modos.

Normal: sigue la melodía con detalle (duración mínima 0.08 s).
Aprendizaje: línea "gruesa" — absorbe melismas y notas rápidas, rellena huecos y ajusta a la grilla de corcheas.

Problemas que resuelve (ver README):
- vibrato       -> mediana suavizada + cuantización con histéresis + mediana del segmento
- portamento    -> frames con pendiente fuerte no generan nota; restos cortos se descartan
- octava falsa  -> saltos de ±12 cortos se llevan a la octava del contexto
"""

from dataclasses import dataclass, replace

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d


@dataclass
class Note:
    pitch: int  # MIDI
    start: float
    end: float

    @property
    def dur(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class NormalParams:
    smooth_s: float = 0.12
    hysteresis: float = 0.2  # semitonos más allá del borde de redondeo para cambiar de nota
    max_slope: float = 20.0  # semitonos/segundo; por encima es transición (glissando)
    slope_window_s: float = 0.2
    min_dur: float = 0.08
    merge_gap: float = 0.06
    octave_fix_max_dur: float = 0.15
    octave_context_s: float = 0.3


@dataclass(frozen=True)
class LearningParams:
    min_dur: float = 0.25
    gap_fill: float = 0.15
    grid_subdivision: int = 2  # 2 = corcheas


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Intervalos [a, b) donde mask es True."""
    padded = np.concatenate([[False], mask, [False]])
    d = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return list(zip(starts.tolist(), ends.tolist()))


def _smooth(midi: np.ndarray, win: int) -> np.ndarray:
    out = np.full_like(midi, np.nan)
    for a, b in _runs(np.isfinite(midi)):
        seg = midi[a:b]
        size = max(1, min(win, len(seg)))
        if size % 2 == 0:
            size -= 1
        out[a:b] = median_filter(seg, size=size, mode="nearest") if size > 1 else seg
    return out


def _quantize_hysteresis(smooth: np.ndarray, hysteresis: float) -> np.ndarray:
    labels = np.full(len(smooth), np.nan)
    cur = None
    for i, v in enumerate(smooth):
        if not np.isfinite(v):
            cur = None
            continue
        if cur is None or abs(v - cur) > 0.5 + hysteresis:
            cur = float(np.round(v))
        labels[i] = cur
    return labels


def merge_same_pitch(notes: list[Note], max_gap: float) -> list[Note]:
    out: list[Note] = []
    for n in notes:
        if out and out[-1].pitch == n.pitch and n.start - out[-1].end <= max_gap + 1e-9:
            out[-1] = replace(out[-1], end=max(out[-1].end, n.end))
        else:
            out.append(replace(n))
    return out


def fix_octaves(notes: list[Note], max_dur: float, context_s: float) -> list[Note]:
    out = [replace(n) for n in notes]
    for i, n in enumerate(out):
        if n.dur > max_dur:
            continue
        refs = []
        if i > 0 and n.start - out[i - 1].end <= context_s:
            refs.append(out[i - 1].pitch)
        if i + 1 < len(out) and out[i + 1].start - n.end <= context_s:
            refs.append(out[i + 1].pitch)
        if not refs:
            continue
        ref = float(np.median(refs))
        diff = n.pitch - ref
        if 10.5 <= abs(diff) <= 13.5:
            out[i] = replace(n, pitch=n.pitch - 12 * int(np.sign(diff)))
    return out


def _fix_octave_frames(midi: np.ndarray, hop: float, max_dur: float, context_s: float) -> np.ndarray:
    """Tramos cortos que saltan ±12 respecto de la mediana del contexto se llevan a esa octava."""
    out = midi.copy()
    finite = np.isfinite(midi)
    if not finite.any():
        return out
    half = max(1, int(round(context_s / hop)))
    ctx = np.full_like(midi, np.nan)
    for i in np.flatnonzero(finite):
        ctx[i] = np.nanmedian(midi[max(0, i - half) : i + half + 1])
    dev = midi - ctx
    mask = finite & (np.abs(np.abs(dev) - 12) < 1.5)
    max_frames = int(round(max_dur / hop))
    for a, b in _runs(mask):
        if b - a <= max_frames:
            out[a:b] -= 12 * np.sign(np.nanmedian(dev[a:b]))
    return out


def segment(midi: np.ndarray, hop: float, p: NormalParams = NormalParams()) -> list[Note]:
    """midi: MIDI flotante por frame (NaN = sin voz), ya corregido por afinación."""
    midi = _fix_octave_frames(midi, hop, p.octave_fix_max_dur, p.octave_context_s)
    win = max(1, int(round(p.smooth_s / hop)))
    smooth = _smooth(midi, win)

    # Pendiente sobre una media móvil de ~1 periodo de vibrato (0.2 s): el vibrato se cancela,
    # un glissando sostenido no.
    slope_win = max(1, int(round(p.slope_window_s / hop)))
    slope = np.full_like(smooth, 0.0)
    for a, b in _runs(np.isfinite(smooth)):
        if b - a > 1:
            avg = uniform_filter1d(smooth[a:b], size=min(slope_win, b - a), mode="nearest")
            slope[a:b] = np.abs(np.gradient(avg)) / hop
    smooth = np.where(slope > p.max_slope, np.nan, smooth)

    labels = _quantize_hysteresis(smooth, p.hysteresis)
    notes: list[Note] = []
    finite = np.isfinite(labels)
    for a, b in _runs(finite):
        # dentro de un tramo con voz, cortar donde cambia la etiqueta
        seg = labels[a:b]
        cuts = [0] + (np.flatnonzero(np.diff(seg) != 0) + 1).tolist() + [len(seg)]
        for s, e in zip(cuts[:-1], cuts[1:]):
            raw = midi[a + s : a + e]
            raw = raw[np.isfinite(raw)]
            pitch = int(np.round(np.median(raw))) if len(raw) else int(seg[s])
            notes.append(Note(pitch, (a + s) * hop, (a + e) * hop))

    notes = fix_octaves(notes, p.octave_fix_max_dur, p.octave_context_s)
    notes = merge_same_pitch(notes, p.merge_gap)
    notes = [n for n in notes if n.dur >= p.min_dur - 1e-9]
    notes = merge_same_pitch(notes, max(p.merge_gap, 0.1))
    return notes


def _grid(beats: np.ndarray, subdivision: int, duration: float) -> np.ndarray:
    beats = np.asarray(sorted(beats), dtype=float)
    if len(beats) < 2:
        return np.zeros(0)
    step = float(np.median(np.diff(beats)))
    before = np.arange(beats[0] - step, -step, -step)[::-1]
    after = np.arange(beats[-1] + step, duration + 2 * step, step)
    full = np.concatenate([before, beats, after])
    pts = [full[i] + (full[i + 1] - full[i]) * k / subdivision for i in range(len(full) - 1) for k in range(subdivision)]
    pts.append(full[-1])
    return np.asarray(pts)


def _snap(notes: list[Note], grid: np.ndarray) -> list[Note]:
    if len(grid) == 0:
        return notes
    out: list[Note] = []
    for n in notes:
        s = float(grid[np.argmin(np.abs(grid - n.start))])
        e = float(grid[np.argmin(np.abs(grid - n.end))])
        if out and s < out[-1].end:
            s = out[-1].end
        if e <= s + 1e-6:
            later = grid[grid > s + 1e-6]
            if not len(later):
                continue
            e = float(later[0])
        out.append(Note(n.pitch, s, e))
    return out


def simplify(notes: list[Note], p: LearningParams = LearningParams(), beats: np.ndarray | None = None, duration: float = 0.0) -> list[Note]:
    """Modo Aprendizaje a partir de las notas del modo Normal."""
    out = [replace(n) for n in notes]
    kept_short: set[int] = set()  # ids de notas aisladas que no se pueden absorber

    while True:
        candidates = [(n.dur, i) for i, n in enumerate(out) if n.dur < p.min_dur - 1e-9 and id(n) not in kept_short]
        if not candidates:
            break
        _, i = min(candidates)
        n = out[i]
        prev = out[i - 1] if i > 0 and n.start - out[i - 1].end <= p.gap_fill else None
        nxt = out[i + 1] if i + 1 < len(out) and out[i + 1].start - n.end <= p.gap_fill else None
        if prev is None and nxt is None:
            limit = out[i + 1].start if i + 1 < len(out) else n.start + p.min_dur
            n.end = min(n.start + p.min_dur, limit)
            if n.dur < p.min_dur * 0.6:
                out.pop(i)
            else:
                kept_short.add(id(n))
            continue
        if prev is not None and nxt is not None:
            if prev.dur != nxt.dur:
                dominant = prev if prev.dur > nxt.dur else nxt
            else:
                dominant = prev if abs(prev.pitch - n.pitch) <= abs(nxt.pitch - n.pitch) else nxt
        else:
            dominant = prev or nxt
        if dominant is prev:
            prev.end = max(prev.end, n.end)
        else:
            nxt.start = min(nxt.start, n.start)
        out.pop(i)
        out = merge_same_pitch(out, 0.0)

    for a, b in zip(out[:-1], out[1:]):
        if 0 < b.start - a.end < p.gap_fill:
            a.end = b.start

    if beats is not None and len(beats) >= 2:
        out = _snap(out, _grid(beats, p.grid_subdivision, duration or (out[-1].end if out else 0.0)))
    return merge_same_pitch(out, 0.0)
