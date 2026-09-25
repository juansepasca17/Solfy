"""Pruebas con curvas sintéticas (sin audio real ni modelos)."""

import numpy as np

from solfy_engine.export import note_name, notes_to_json
from solfy_engine.notes import Note, segment, simplify
from solfy_engine.tuning import estimate_offset_cents

HOP = 0.01


def curve(*parts):
    """parts: (segundos, midi_inicial, midi_final | None). None = silencio (NaN)."""
    out = []
    for dur, a, b in parts:
        n = int(round(dur / HOP))
        if a is None:
            out.append(np.full(n, np.nan))
        else:
            out.append(np.linspace(a, a if b is None else b, n, endpoint=False))
    return np.concatenate(out)


def test_vibrato_gives_single_note():
    t = np.arange(int(1.0 / HOP)) * HOP
    midi = 69 + 0.4 * np.sin(2 * np.pi * 6 * t)  # ±40 cents a 6 Hz
    notes = segment(midi, HOP)
    assert len(notes) == 1
    assert notes[0].pitch == 69
    assert note_name(notes[0].pitch) == "A4"
    assert notes[0].dur > 0.9


def test_wide_vibrato_gives_single_note():
    t = np.arange(int(1.2 / HOP)) * HOP
    midi = 64 + 0.7 * np.sin(2 * np.pi * 5.5 * t)
    notes = segment(midi, HOP)
    assert [n.pitch for n in notes] == [64]


def test_glissando_does_not_produce_garbage():
    midi = curve((0.5, 60, None), (0.25, 60, 67), (0.5, 67, None))
    notes = segment(midi, HOP)
    pitches = [n.pitch for n in notes]
    assert pitches[0] == 60 and pitches[-1] == 67
    assert len(notes) <= 4  # como mucho algún paso intermedio de >= 80 ms
    assert all(n.dur >= 0.08 - 1e-9 for n in notes)


def test_short_octave_error_is_fixed():
    midi = curve((0.4, 62, None), (0.1, 74, None), (0.4, 62, None))
    notes = segment(midi, HOP)
    assert [n.pitch for n in notes] == [62]


def test_steps_and_silence():
    midi = curve((0.3, 60, None), (0.3, 62, None), (0.2, None, None), (0.3, 64, None))
    notes = segment(midi, HOP)
    assert [n.pitch for n in notes] == [60, 62, 64]
    assert abs(notes[2].start - 0.8) < 0.05


def test_tuning_offset_detected_and_corrected():
    rng = np.random.default_rng(0)
    base = np.repeat([60, 62, 64, 65, 67], 40).astype(float)
    midi = base + 0.30 + rng.normal(0, 0.05, len(base))
    offset = estimate_offset_cents(midi)
    assert 25 <= offset <= 35
    notes = segment(midi - offset / 100, HOP)
    assert [n.pitch for n in notes] == [60, 62, 64, 65, 67]


def test_tuning_offset_negative():
    midi = np.full(200, 57 - 0.2)
    assert -25 <= estimate_offset_cents(midi) <= -15


def test_learning_mode_absorbs_melisma():
    # nota larga, adorno rápido de 3 notas, nota larga
    normal = [
        Note(60, 0.0, 0.8),
        Note(62, 0.8, 0.9),
        Note(64, 0.9, 1.0),
        Note(62, 1.0, 1.1),
        Note(65, 1.1, 1.9),
    ]
    learn = simplify(normal)
    assert len(learn) < len(normal)
    assert all(n.dur >= 0.25 - 1e-9 for n in learn)
    assert learn[0].pitch == 60 and learn[-1].pitch == 65


def test_learning_mode_fills_small_gaps_and_snaps():
    normal = [Note(60, 0.02, 0.45), Note(62, 0.55, 0.98)]
    beats = np.arange(0, 3, 0.5)
    learn = simplify(normal, beats=beats, duration=3.0)
    assert learn[0].start == 0.0
    assert learn[0].end == learn[1].start
    assert learn[1].end == 1.0


def test_learning_snap_never_negative():
    # Regresión v0.1.0 (Gitana): primer beat en 0.3 s -> la grilla hacia atrás daba -0.05 s
    normal = [Note(74, 0.0, 0.99), Note(73, 1.0, 1.5)]
    beats = np.arange(0.3, 10, 0.35)
    learn = simplify(normal, beats=beats, duration=10.0)
    assert all(n.start >= 0 for n in learn)
    assert learn[0].start == 0.0


def test_json_drops_negative_times():
    data = notes_to_json([Note(60, -0.05, 0.5), Note(62, 0.6, 0.6)])
    assert data == [{"note": "C4", "freq": 261.63, "start": 0.0, "end": 0.5}]


def test_json_schema():
    data = notes_to_json([Note(60, 1.2, 1.85), Note(64, 1.85, 2.4)])
    assert data == [
        {"note": "C4", "freq": 261.63, "start": 1.2, "end": 1.85},
        {"note": "E4", "freq": 329.63, "start": 1.85, "end": 2.4},
    ]
