"""Compara el modo Normal (CPU) con el modo GPU (DirectML) sobre una canción real.

  python scripts/bench_gpu.py cancion.mp3 carpeta_cpu [--models models]

`carpeta_cpu` es la salida del motor en modo Normal para esa misma canción (notes.json).
Mide el tiempo de separación y de tono en GPU, y compara las notas resultantes con las de CPU.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from solfy_engine.audio_io import load_mp3  # noqa: E402
from solfy_engine.backends import onnx_dml  # noqa: E402
from solfy_engine.export import notes_to_json  # noqa: E402
from solfy_engine.notes import segment  # noqa: E402
from solfy_engine.pitch import HOP_SECONDS, frame_rms_db, to_mono_16k, voiced_midi  # noqa: E402
from solfy_engine.tuning import estimate_offset_cents  # noqa: E402

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def to_midi(name: str) -> int:
    m = re.match(r"([A-G]#?)(-?\d+)", name)
    return NAMES.index(m[1]) + (int(m[2]) + 1) * 12


def piano_roll(notes: list[dict], frames: int) -> np.ndarray:
    r = np.full(frames, -1)
    for n in notes:
        r[int(n["start"] * 100) : int(n["end"] * 100)] = to_midi(n["note"])
    return r


def compare(ref: list[dict], other: list[dict]) -> dict:
    frames = int(max(ref[-1]["end"], other[-1]["end"]) * 100) + 1
    a, b = piano_roll(ref, frames), piano_roll(other, frames)
    both = (a >= 0) & (b >= 0)
    return {
        "misma_altura_%": round(100 * float((a[both] == b[both]).mean()), 1),
        "cobertura_%": round(100 * both.sum() / max(1, (a >= 0).sum()), 1),
        "notas": (len(ref), len(other)),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mp3")
    ap.add_argument("cpu_dir")
    ap.add_argument("--models", default=str(ROOT / "models"))
    args = ap.parse_args()
    models = Path(args.models)

    audio, sr = load_mp3(Path(args.mp3))
    print(f"canción: {audio.shape[1] / sr:.0f} s")

    t = time.perf_counter()
    vocals, _inst, sr = onnx_dml.separate(audio, sr, models, lambda _: None, print)
    t_sep = time.perf_counter() - t
    print(f"separación GPU: {t_sep:.1f} s")

    y = to_mono_16k(vocals, sr)
    t = time.perf_counter()
    f, p = onnx_dml.track(y, lambda _: None, models, print)
    t_pitch = time.perf_counter() - t
    print(f"tono GPU (CREPE full): {t_pitch:.1f} s")

    midi = voiced_midi(f, p, frame_rms_db(y, len(f)))
    off = estimate_offset_cents(midi)
    gpu_notes = notes_to_json(segment(midi - off / 100, HOP_SECONDS))
    cpu_notes = json.loads((Path(args.cpu_dir) / "notes.json").read_text())
    print("comparación con CPU:", compare(cpu_notes, gpu_notes))


if __name__ == "__main__":
    main()
