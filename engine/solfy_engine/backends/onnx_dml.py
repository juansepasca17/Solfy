"""Modo GPU: ONNX Runtime + DirectML (cualquier GPU DirectX 12 en Windows: AMD, Intel, NVIDIA).

- Separación: el núcleo de htdemucs corre en la GPU (`htdemucs_core.onnx`); el STFT/iSTFT y la
  máscara compleja se calculan en CPU con los mismos métodos de demucs. La lógica de trozos y
  solapamiento es la de `demucs.apply.apply_model`, igual que en el modo Normal.
- Tono: la red de CREPE full corre en la GPU (`crepe_full.onnx`); el pre y postproceso
  (normalización de frames, Viterbi, periodicidad) son los de torchcrepe, en CPU.
"""

from pathlib import Path
from typing import Callable

import numpy as np
import torch
from torch import nn

from ..pitch import CREPE_SR, FMAX, FMIN, HOP_SECONDS


class GpuUnavailable(RuntimeError):
    """No hay GPU DirectML utilizable (o faltan los modelos ONNX)."""


def dml_available() -> bool:
    try:
        import onnxruntime as ort

        return "DmlExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def make_session(path: Path, log: Callable[[str], None] | None = None):
    import onnxruntime as ort

    if not path.is_file():
        raise GpuUnavailable(f"falta el modelo {path.name}")
    if not dml_available():
        raise GpuUnavailable("DirectML no está disponible")
    so = ort.SessionOptions()
    # DirectML no admite ejecución en paralelo ni el patrón de memoria.
    so.enable_mem_pattern = False
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.log_severity_level = 3
    # high_performance: DXCore ordena los adaptadores poniendo primero la GPU dedicada.
    providers = [("DmlExecutionProvider", {"performance_preference": "high_performance", "device_filter": "gpu"})]
    sess = ort.InferenceSession(str(path), sess_options=so, providers=providers)
    if "DmlExecutionProvider" not in sess.get_providers():
        raise GpuUnavailable("la sesión no pudo usar DirectML")
    if log:
        log(f"DirectML: {path.name} cargado")
    return sess


class OnnxHTDemucs(nn.Module):
    """Se comporta como HTDemucs para `apply_model`, pero el núcleo corre en ONNX/DirectML."""

    def __init__(self, model, session):
        super().__init__()
        self.m = model
        self.sess = session
        self.sources = model.sources
        self.samplerate = model.samplerate
        self.audio_channels = model.audio_channels
        self.segment = model.segment
        self.length = int(model.segment * model.samplerate)

    def valid_length(self, length: int) -> int:
        return self.length

    def forward(self, mix: torch.Tensor) -> torch.Tensor:
        m = self.m
        length = mix.shape[-1]
        if length < self.length:
            mix = nn.functional.pad(mix, (0, self.length - length))
        z = m._spec(mix)
        mag = m._magnitude(z)
        spec, wave = self.sess.run(None, {"mix": mix.numpy().astype(np.float32), "mag": mag.numpy().astype(np.float32)})
        zout = m._mask(z, torch.from_numpy(spec))
        x = m._ispec(zout, self.length) + torch.from_numpy(wave)
        return x[..., :length]


def separate(audio: np.ndarray, sr: int, models_dir: Path, report: Callable[[float], None], log=None) -> tuple[np.ndarray, np.ndarray, int]:
    """Igual que `separate.separate`, pero con el núcleo en la GPU."""
    import demucs.apply
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    from ..separate import _ProgressTqdm

    sess = make_session(models_dir / "onnx" / "htdemucs_core.onnx", log)
    bag = get_model("htdemucs", repo=models_dir / "demucs")
    model = OnnxHTDemucs(bag.models[0].eval(), sess)

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


def track(mono16k: np.ndarray, report: Callable[[float], None], models_dir: Path, log=None, batch: int = 1024) -> tuple[np.ndarray, np.ndarray]:
    """Igual que `pitch.track` (CREPE full + Viterbi), con la red en la GPU."""
    import torchcrepe

    sess = make_session(models_dir / "onnx" / "crepe_full.onnx", log)
    hop = int(CREPE_SR * HOP_SECONDS)
    block = CREPE_SR * 20
    total = len(mono16k)
    freqs, periods = [], []
    for start in range(0, total, block):
        chunk = mono16k[start : start + block]
        if len(chunk) < hop:
            break
        audio = torch.from_numpy(chunk)[None]
        probs = []
        with torch.inference_mode():
            for frames in torchcrepe.core.preprocess(audio, CREPE_SR, hop, batch, "cpu", True):
                probs.append(sess.run(None, {"frames": frames.numpy().astype(np.float32)})[0])
            p = torch.from_numpy(np.concatenate(probs))
            p = p.reshape(1, -1, torchcrepe.PITCH_BINS).transpose(1, 2)
            f, per = torchcrepe.core.postprocess(p, FMIN, FMAX, torchcrepe.decode.viterbi, return_periodicity=True)
        n = len(chunk) // hop + 1 if start + block >= total else block // hop
        freqs.append(f[0].numpy()[:n])
        periods.append(per[0].numpy()[:n])
        report(min(1.0, (start + block) / total))
    freq = np.concatenate(freqs) if freqs else np.zeros(0, np.float32)
    period = np.concatenate(periods) if periods else np.zeros(0, np.float32)
    return freq.astype(np.float32), period.astype(np.float32)
