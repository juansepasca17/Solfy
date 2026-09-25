"""CLI del motor. Emite una lÃ­nea JSON por evento en stdout:

  {"type":"progress","stage":"separating","pct":0.42}
  {"type":"done"}
  {"type":"error","message":"..."}

Uso:  solfy-engine process --input cancion.mp3 --out carpeta [--lyrics] [--models DIR] [--title T]
"""

import argparse
import json
import os
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning, module="torchaudio")


def _default_models_dir() -> Path:
    if env := os.environ.get("SOLFY_MODELS"):
        return Path(env)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "models"
    return Path(__file__).resolve().parents[2] / "models"


def _force_offline(models_dir: Path) -> None:
    """Ninguna librerÃ­a debe intentar descargar nada en tiempo de ejecuciÃ³n."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TORCH_HOME"] = str(models_dir / "torch")
    os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(os.environ.get("TEMP", ".")) / "solfy-numba"))


# Las librerías a veces imprimen en stdout; el canal de eventos es solo nuestro.
_EVENTS = sys.stdout
sys.stdout = sys.stderr


def emit(obj: dict) -> None:
    _EVENTS.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _EVENTS.flush()


class Progress:
    def __init__(self, stages: list[tuple[str, float]]):
        total = sum(w for _, w in stages)
        self._ranges: dict[str, tuple[float, float]] = {}
        acc = 0.0
        for name, w in stages:
            self._ranges[name] = (acc / total, (acc + w) / total)
            acc += w
        self._last = 0.0

    def reporter(self, stage: str):
        a, b = self._ranges[stage]

        def report(frac: float) -> None:
            pct = a + (b - a) * max(0.0, min(1.0, frac))
            if pct - self._last >= 0.005 or frac >= 1.0 or frac == 0.0:
                self._last = pct
                emit({"type": "progress", "stage": stage, "pct": round(pct, 4)})

        return report


def process(args: argparse.Namespace) -> None:
    models_dir = Path(args.models) if args.models else _default_models_dir()
    _force_offline(models_dir)

    import numpy as np
    import torch

    from . import __version__
    from .audio_io import load_mp3, write_ogg
    from .beats import track_beats
    from .export import notes_to_json, write_json
    from .notes import segment, simplify
    from .pitch import HOP_SECONDS, frame_rms_db, to_mono_16k, track, voiced_midi
    from .separate import separate
    from .tuning import estimate_offset_cents

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    stages = [("decoding", 2), ("separating", 55), ("saving", 4), ("pitch", 25), ("beats", 4), ("notes", 2)]
    if args.lyrics:
        stages.append(("lyrics", 30))
    prog = Progress(stages)

    rep = prog.reporter("decoding")
    rep(0.0)
    audio, sr = load_mp3(Path(args.input))
    duration = audio.shape[1] / sr
    rep(1.0)

    vocals, instrumental, sr = separate(audio, sr, models_dir, prog.reporter("separating"))
    del audio

    rep = prog.reporter("saving")
    write_ogg(out / "instrumental.ogg", instrumental, sr)
    rep(0.5)
    write_ogg(out / "vocals.ogg", vocals, sr)
    rep(1.0)

    vocals16k = to_mono_16k(vocals, sr)
    freq, periodicity = track(vocals16k, prog.reporter("pitch"), model=args.pitch_model)
    rms_db = frame_rms_db(vocals16k, len(freq))
    midi = voiced_midi(freq, periodicity, rms_db)

    offset = estimate_offset_cents(midi)
    midi_c = midi - offset / 100.0

    rep = prog.reporter("beats")
    tempo, beats = track_beats(instrumental, sr)
    rep(1.0)
    del instrumental

    rep = prog.reporter("notes")
    normal = segment(midi_c, HOP_SECONDS)
    learning = simplify(normal, beats=beats, duration=duration)
    write_json(out / "notes.json", notes_to_json(normal))
    write_json(out / "notes_learning.json", notes_to_json(learning))

    step = 2  # curva cada 20 ms
    curve = [None if not np.isfinite(v) else round(float(v), 2) for v in midi_c[::step]]
    write_json(out / "pitch_curve.json", {"hop": HOP_SECONDS * step, "midi": curve})

    pitches = [n.pitch for n in normal]
    meta = {
        "title": args.title or Path(args.input).stem,
        "duration": round(duration, 3),
        "tuning_offset_cents": offset,
        "tempo_bpm": tempo,
        "beats": beats.tolist(),
        "range": {"low": min(pitches), "high": max(pitches)} if pitches else None,
        "engine_version": __version__,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "lyrics": False,
    }
    rep(1.0)

    if args.lyrics:
        from .lyrics import transcribe

        words = transcribe(vocals16k, models_dir, duration, prog.reporter("lyrics"))
        write_json(out / "lyrics.json", words)
        meta["lyrics"] = True

    write_json(out / "meta.json", meta)
    emit({"type": "done"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="solfy-engine")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("process", help="Procesa un MP3")
    p.add_argument("--input", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--models")
    p.add_argument("--title")
    p.add_argument("--lyrics", action="store_true")
    p.add_argument("--pitch-model", choices=["full", "tiny"], default="full")
    sub.add_parser("version")
    args = parser.parse_args(argv)

    if args.cmd == "version":
        from . import __version__

        emit({"type": "version", "version": __version__})
        return 0
    try:
        process(args)
        return 0
    except Exception as exc:  # se reporta a la UI en vez de un traceback
        from .audio_io import InputError

        msg = str(exc) if isinstance(exc, (InputError, FileNotFoundError)) else f"{type(exc).__name__}: {exc}"
        emit({"type": "error", "message": msg})
        if os.environ.get("SOLFY_DEBUG"):
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
