"""Curva de tono de la voz separada con CREPE (monofónico, frame a frame)."""

from typing import Callable

import numpy as np

CREPE_SR = 16000
HOP_SECONDS = 0.01
FMIN = 65.0  # ~C2
FMAX = 1100.0  # ~C#6


def to_mono_16k(audio: np.ndarray, sr: int) -> np.ndarray:
    import librosa

    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    return librosa.resample(mono.astype(np.float32), orig_sr=sr, target_sr=CREPE_SR, res_type="soxr_hq")


def frame_rms_db(mono16k: np.ndarray, n_frames: int) -> np.ndarray:
    """Energía por frame (dB relativos al máximo) alineada con los frames de CREPE."""
    hop = int(CREPE_SR * HOP_SECONDS)
    win = hop * 4
    padded = np.pad(mono16k, (win // 2, win // 2))
    rms = np.empty(n_frames, dtype=np.float32)
    for i in range(n_frames):
        seg = padded[i * hop : i * hop + win]
        rms[i] = np.sqrt(np.mean(seg * seg)) if len(seg) else 0.0
    db = 20 * np.log10(rms + 1e-9)
    return db - db.max()


def track(mono16k: np.ndarray, report: Callable[[float], None], model: str = "full") -> tuple[np.ndarray, np.ndarray]:
    """Devuelve (freq_hz, periodicity) por frame de 10 ms. Procesa por bloques para reportar avance."""
    import torch
    import torchcrepe

    hop = int(CREPE_SR * HOP_SECONDS)
    block = CREPE_SR * 20  # 20 s por bloque (múltiplo de hop)
    freqs, periods = [], []
    total = len(mono16k)
    for start in range(0, total, block):
        chunk = mono16k[start : start + block]
        if len(chunk) < hop:
            break
        with torch.inference_mode():
            f, p = torchcrepe.predict(
                torch.from_numpy(chunk)[None],
                CREPE_SR,
                hop,
                FMIN,
                FMAX,
                model,
                decoder=torchcrepe.decode.viterbi,
                return_periodicity=True,
                batch_size=512,
                device="cpu",
                pad=True,
            )
        n = len(chunk) // hop + 1 if start + block >= total else block // hop
        freqs.append(f[0].numpy()[:n])
        periods.append(p[0].numpy()[:n])
        report(min(1.0, (start + block) / total))
    freq = np.concatenate(freqs) if freqs else np.zeros(0, np.float32)
    period = np.concatenate(periods) if periods else np.zeros(0, np.float32)
    return freq.astype(np.float32), period.astype(np.float32)


def voiced_midi(freq: np.ndarray, periodicity: np.ndarray, rms_db: np.ndarray, min_periodicity: float = 0.35, min_db: float = -40.0) -> np.ndarray:
    """Convierte a MIDI flotante; NaN donde no hay voz confiable."""
    from scipy.ndimage import median_filter

    per = median_filter(periodicity, size=3, mode="nearest")
    midi = 69 + 12 * np.log2(np.maximum(freq, 1e-6) / 440.0)
    ok = (per >= min_periodicity) & (rms_db >= min_db) & (freq > FMIN) & (freq < FMAX)
    return np.where(ok, midi, np.nan).astype(np.float64)
