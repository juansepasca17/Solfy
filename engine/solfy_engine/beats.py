"""Pulso de la canción (sobre el instrumental) para la grilla del modo Aprendizaje."""

import numpy as np


def track_beats(instrumental: np.ndarray, sr: int) -> tuple[float, np.ndarray]:
    import librosa

    mono = instrumental.mean(axis=0) if instrumental.ndim == 2 else instrumental
    y = librosa.resample(mono.astype(np.float32), orig_sr=sr, target_sr=22050, res_type="soxr_hq")
    try:
        tempo, frames = librosa.beat.beat_track(y=y, sr=22050, units="frames")
        beats = librosa.frames_to_time(frames, sr=22050)
        tempo = float(np.atleast_1d(tempo)[0])
    except Exception:
        return 0.0, np.zeros(0)
    return round(tempo, 1), np.round(beats, 3)
