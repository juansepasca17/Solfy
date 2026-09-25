"""Estimación de la desafinación global de la grabación respecto de A440."""

import numpy as np


def estimate_offset_cents(midi: np.ndarray) -> float:
    """Media circular de la parte fraccional (en cents) de los frames con voz.

    Una grabación afinada 30 cents arriba da ~ +30. Resultado en [-50, 50).
    """
    m = midi[np.isfinite(midi)]
    if len(m) < 20:
        return 0.0
    frac = m - np.round(m)  # [-0.5, 0.5]
    angles = 2 * np.pi * frac
    mean_angle = np.arctan2(np.sin(angles).mean(), np.cos(angles).mean())
    cents = float(mean_angle / (2 * np.pi) * 100.0)
    return round(cents, 1)
