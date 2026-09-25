"""CLI del motor. Emite una línea JSON por evento en stdout:

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
    """Ninguna librería debe intentar descargar nada en tiempo de ejecución."""
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


def _rss_mb() -> float | None:
    """Memoria del proceso (Windows), para el log."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (n, ctypes.c_size_t)
                for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")
            ]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
        return round(pmc.WorkingSetSize / 2**20) if ok else None
    except Exception:
        return None


class EngineLog:
    """engine.log en la carpeta de la canción: tiempos por etapa, memoria y errores. Solo local."""

    def __init__(self, path: Path):
        self.f = path.open("a", encoding="utf-8", buffering=1)
        self.t0 = time.monotonic()
        self.stage_t = self.t0
        self.stage = None
        # Si algo se cuelga, cada 15 min queda un volcado de dónde está cada hilo
        # (en una canción larga procesada en CPU puede aparecer sin que haya un problema).
        import faulthandler

        faulthandler.enable(self.f)
        faulthandler.dump_traceback_later(900, repeat=True, file=self.f)

    def write(self, msg: str) -> None:
        mem = _rss_mb()
        self.f.write(f"[{time.monotonic() - self.t0:8.1f}s] {msg}{f'  (mem {mem} MB)' if mem else ''}\n")

    def start(self, stage: str) -> None:
        if self.stage:
            self.write(f"fin {self.stage}: {time.monotonic() - self.stage_t:.1f}s")
        self.stage, self.stage_t = stage, time.monotonic()
        self.write(f"inicio {stage}")

    def close(self) -> None:
        import faulthandler

        faulthandler.cancel_dump_traceback_later()
        if self.stage:
            self.write(f"fin {self.stage}: {time.monotonic() - self.stage_t:.1f}s")
        self.write(f"total {time.monotonic() - self.t0:.1f}s")
        self.f.close()


class Progress:
    def __init__(self, stages: list[tuple[str, float]], log: "EngineLog | None" = None):
        total = sum(w for _, w in stages)
        self._ranges: dict[str, tuple[float, float]] = {}
        acc = 0.0
        for name, w in stages:
            self._ranges[name] = (acc / total, (acc + w) / total)
            acc += w
        self._last = 0.0
        self._log = log

    def reporter(self, stage: str):
        a, b = self._ranges[stage]
        if self._log:
            self._log.start(stage)

        def report(frac: float) -> None:
            pct = a + (b - a) * max(0.0, min(1.0, frac))
            if pct - self._last >= 0.005 or frac >= 1.0 or frac == 0.0:
                self._last = pct
                emit({"type": "progress", "stage": stage, "pct": round(pct, 4)})

        return report


def process(args: argparse.Namespace) -> None:
    models_dir = Path(args.models) if args.models else _default_models_dir()
    _force_offline(models_dir)

    import torch

    from . import __version__

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    log = EngineLog(out / "engine.log")
    # Casi todos los hilos: la app lanza el motor con prioridad baja, así que la ventana y el
    # sistema siguen respondiendo. Con solo los núcleos físicos, CREPE tarda casi el doble.
    threads = args.threads or max(1, (os.cpu_count() or 2) - 2)
    torch.set_num_threads(threads)
    log.write(f"Solfy engine {__version__} · entrada {Path(args.input).name} · hilos {threads} · letra {bool(args.lyrics)}")
    try:
        _run(args, out, models_dir, log)
    except BaseException:
        import traceback

        log.write("ERROR\n" + traceback.format_exc())
        raise
    finally:
        log.close()


def _run(args: argparse.Namespace, out: Path, models_dir: Path, log: "EngineLog") -> None:
    import numpy as np

    from . import __version__
    from .audio_io import load_mp3, write_ogg
    from .beats import track_beats
    from .export import notes_to_json, write_json
    from .notes import segment, simplify
    from .pitch import HOP_SECONDS, frame_rms_db, to_mono_16k, track, voiced_midi
    from .separate import separate
    from .tuning import estimate_offset_cents

    use_gpu = _want_gpu(args.device, models_dir, log)
    used = {"separation": "cpu", "pitch": "cpu", "gpu_error": None}
    # Pesos ≈ segundos por minuto de canción medidos en una Ryzen 5 7535HS / RX 6550M.
    parallel_lyrics = bool(args.lyrics and use_gpu)
    if use_gpu:
        stages = [("decoding", 0.2), ("separating", 10), ("saving", 2), ("pitch", 15), ("beats", 0.5), ("notes", 0.5)]
    else:
        stages = [("decoding", 0.2), ("separating", 20), ("saving", 2), ("pitch", 90), ("beats", 0.5), ("notes", 0.5)]
    if parallel_lyrics:
        # Whisper (CPU) corre a la vez que CREPE (GPU): una sola etapa combinada.
        stages[3] = ("pitch_lyrics", 30)
    elif args.lyrics:
        stages.append(("lyrics", 30))
    prog = Progress(stages, log)

    def gpu_failed(stage: str, exc: BaseException) -> None:
        nonlocal use_gpu
        import traceback

        use_gpu = False
        used["gpu_error"] = f"{type(exc).__name__}: {exc}"
        log.write(f"La GPU falló durante {stage}; se continúa en CPU\n" + traceback.format_exc())
        emit({"type": "notice", "message": "La GPU falló; se continúa en CPU"})

    rep = prog.reporter("decoding")
    rep(0.0)
    audio, sr = load_mp3(Path(args.input))
    duration = audio.shape[1] / sr
    rep(1.0)

    rep = prog.reporter("separating")
    if use_gpu:
        try:
            from .backends import onnx_dml

            vocals, instrumental, sr_out = onnx_dml.separate(audio, sr, models_dir, rep, log.write)
            used["separation"] = "gpu"
        except Exception as exc:
            gpu_failed("la separación", exc)
    if used["separation"] == "cpu":
        vocals, instrumental, sr_out = separate(audio, sr, models_dir, rep)
    sr = sr_out
    del audio

    rep = prog.reporter("saving")
    write_ogg(out / "instrumental.ogg", instrumental, sr, lambda f: rep(f * 0.5))
    write_ogg(out / "vocals.ogg", vocals, sr, lambda f: rep(0.5 + f * 0.5))

    vocals16k = to_mono_16k(vocals, sr)
    words = None
    if parallel_lyrics and use_gpu:
        freq, periodicity, words = _pitch_and_lyrics_parallel(vocals16k, models_dir, duration, prog.reporter("pitch_lyrics"), used, gpu_failed, log)
    else:
        rep = prog.reporter("pitch_lyrics" if parallel_lyrics else "pitch")
        freq = None
        if use_gpu:
            try:
                from .backends import onnx_dml

                freq, periodicity = onnx_dml.track(vocals16k, rep, models_dir, log.write)
                used["pitch"] = "gpu"
            except Exception as exc:
                gpu_failed("la detección de tono", exc)
        if freq is None:
            freq, periodicity = track(vocals16k, rep, model=args.pitch_model)
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
        "device": used,
    }
    rep(1.0)

    if args.lyrics:
        if words is None:
            from .lyrics import transcribe

            rep = prog.reporter("lyrics") if not parallel_lyrics else (lambda _f: None)
            words = transcribe(vocals16k, models_dir, duration, rep)
        write_json(out / "lyrics.json", words)
        meta["lyrics"] = True

    log.write(f"dispositivos: separación={used['separation']} tono={used['pitch']}" + (f" (error GPU: {used['gpu_error']})" if used["gpu_error"] else ""))
    write_json(out / "meta.json", meta)
    emit({"type": "done"})


def _dml_available() -> bool:
    try:
        import onnxruntime as ort

        return "DmlExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def _gpu_models_present(models_dir: Path) -> bool:
    return all((models_dir / "onnx" / f).is_file() for f in ("htdemucs_core.onnx", "crepe_full.onnx"))


def _want_gpu(device: str, models_dir: Path, log: "EngineLog") -> bool:
    if device == "cpu":
        log.write("modo Normal (CPU)")
        return False
    if not _dml_available():
        log.write("no hay GPU DirectML disponible; se usa CPU")
        if device == "gpu":
            emit({"type": "notice", "message": "No se encontró una GPU compatible; se usa CPU"})
        return False
    if not _gpu_models_present(models_dir):
        log.write("faltan los modelos ONNX; se usa CPU")
        if device == "gpu":
            emit({"type": "notice", "message": "Faltan los modelos de GPU; se usa CPU"})
        return False
    log.write(f"modo GPU (DirectML), pedido: {device}")
    return True


def _pitch_and_lyrics_parallel(vocals16k, models_dir: Path, duration: float, report, used: dict, gpu_failed, log: "EngineLog"):
    """CREPE en la GPU y Whisper en la CPU al mismo tiempo. El avance es el de la tarea más atrasada."""
    import threading

    from .backends import onnx_dml
    from .lyrics import transcribe
    from .pitch import track

    fracs = {"pitch": 0.0, "lyrics": 0.0}
    lock = threading.Lock()

    def part(name: str):
        def rep(f: float) -> None:
            with lock:
                fracs[name] = f
                report(min(fracs.values()))

        return rep

    result: dict = {}

    def run_lyrics() -> None:
        try:
            result["words"] = transcribe(vocals16k, models_dir, duration, part("lyrics"))
        except BaseException as exc:  # se relanza en el hilo principal
            result["lyrics_error"] = exc

    th = threading.Thread(target=run_lyrics, name="whisper", daemon=True)
    th.start()
    freq = None
    try:
        freq, periodicity = onnx_dml.track(vocals16k, part("pitch"), models_dir, log.write)
        used["pitch"] = "gpu"
    except Exception as exc:
        gpu_failed("la detección de tono", exc)
    if freq is None:
        freq, periodicity = track(vocals16k, part("pitch"))
    th.join()
    if "lyrics_error" in result:
        raise result["lyrics_error"]
    return freq, periodicity, result["words"]


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
    p.add_argument("--threads", type=int, default=0, help="hilos de CPU (0 = todos menos 2)")
    p.add_argument("--device", choices=["auto", "cpu", "gpu"], default="auto", help="auto = GPU DirectML si hay, si no CPU")
    sub.add_parser("version")
    d = sub.add_parser("devices", help="¿Hay GPU DirectML y modelos ONNX?")
    d.add_argument("--models")
    args = parser.parse_args(argv)

    if args.cmd == "version":
        from . import __version__

        emit({"type": "version", "version": __version__})
        return 0
    if args.cmd == "devices":
        models_dir = Path(args.models) if args.models else _default_models_dir()
        emit({"type": "devices", "dml": _dml_available(), "models": _gpu_models_present(models_dir)})
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
