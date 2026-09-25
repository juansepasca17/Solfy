"""Separación voz / instrumental con Demucs (htdemucs) en CPU, usando pesos locales."""

from pathlib import Path
from typing import Callable

import numpy as np
import torch

MODEL_NAME = "htdemucs"


class _ProgressTqdm:
    """Sustituto de `tqdm` para demucs.apply: reporta avance sin imprimir en consola."""

    def __init__(self, report: Callable[[float], None]):
        self._report = report

    def tqdm(self, iterable, **_kwargs):
        items = list(iterable)
        total = max(len(items), 1)
        for i, item in enumerate(items):
            yield item
            self._report((i + 1) / total)


def separate(audio: np.ndarray, sr: int, models_dir: Path, report: Callable[[float], None]) -> tuple[np.ndarray, np.ndarray, int]:
    """Devuelve (vocals, instrumental, sample_rate) como [2, muestras] float32."""
    import demucs.apply
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    repo = models_dir / "demucs"
    if not repo.is_dir():
        raise FileNotFoundError(f"No se encontraron los pesos de Demucs en {repo}")
    model = get_model(MODEL_NAME, repo=repo)
    model.eval()

    wav = torch.from_numpy(audio)
    if sr != model.samplerate:
        import julius

        wav = julius.resample_frac(wav, sr, model.samplerate)
        sr = model.samplerate

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    demucs.apply.tqdm = _ProgressTqdm(report)
    with torch.inference_mode():
        sources = apply_model(model, wav[None], device="cpu", shifts=0, split=True, overlap=0.25, progress=True, num_workers=0)[0]
    sources = sources * std + mean

    names = list(model.sources)
    vocals = sources[names.index("vocals")]
    instrumental = sum(sources[i] for i, n in enumerate(names) if n != "vocals")
    return vocals.numpy().astype(np.float32), instrumental.numpy().astype(np.float32), sr
