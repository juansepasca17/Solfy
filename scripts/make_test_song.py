"""Crea un MP3 sintético (melodía conocida + bajo + batería) para probar el motor sin usar música con derechos.

  python scripts/make_test_song.py salida.mp3

Melodía (x3): C D E F G | G F E D C
"""

import sys

import numpy as np
import soundfile as sf

SR = 44100
MELODY = [(60, 0.5), (62, 0.5), (64, 0.5), (65, 0.5), (67, 1.0), (None, 0.5), (67, 0.5), (65, 0.25), (64, 0.25), (62, 0.5), (60, 1.0), (None, 0.5)] * 3


def main(path: str) -> None:
    parts, phase = [], 0.0
    for m, d in MELODY:
        n = int(SR * d)
        t = np.arange(n) / SR
        if m is None:
            parts.append(np.zeros(n))
            continue
        f = 440 * 2 ** ((m - 69) / 12) * 2 ** (0.3 * np.sin(2 * np.pi * 5.5 * t) / 12)  # vibrato ±30 cents
        ph = phase + 2 * np.pi * np.cumsum(f) / SR
        phase = ph[-1]
        tone = sum((0.6 / k) * np.sin(k * ph) for k in range(1, 8))
        env = np.minimum(1, t / 0.03) * np.minimum(1, (d - t) / 0.05)
        parts.append(tone * env * 0.3)
    voice = np.concatenate(parts)
    t = np.arange(len(voice)) / SR
    bass = 0.25 * np.sin(2 * np.pi * 65.4 * t) * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 2 * t)))
    drums = np.zeros(len(voice))
    for b in np.arange(0, len(voice) / SR, 0.5):
        i = int(b * SR)
        L = min(3000, len(voice) - i)
        drums[i : i + L] += np.random.default_rng(int(b * 10)).normal(0, 0.3, L) * np.exp(-np.arange(L) / 400)
    mix = (voice + bass + drums) * 0.8
    sf.write(path, np.stack([mix, mix], 1).astype(np.float32), SR, format="MP3")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "test_song.mp3")
