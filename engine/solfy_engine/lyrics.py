"""Letra opcional: faster-whisper local sobre la voz separada, con tiempos por palabra."""

from pathlib import Path
from typing import Callable

import numpy as np


def transcribe(vocals16k: np.ndarray, models_dir: Path, duration: float, report: Callable[[float], None]) -> list[dict]:
    from faster_whisper import WhisperModel

    model_dir = models_dir / "whisper-small"
    if not model_dir.is_dir():
        raise FileNotFoundError("El modelo de letra no está instalado")
    model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", local_files_only=True)
    segments, _info = model.transcribe(
        vocals16k.astype(np.float32),
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
        beam_size=5,
    )
    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"word": text, "start": round(w.start, 3), "end": round(w.end, 3)})
        if duration > 0:
            report(min(1.0, seg.end / duration))
    report(1.0)
    return words
