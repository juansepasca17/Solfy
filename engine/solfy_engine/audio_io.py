"""Lectura/validación de MP3 y escritura de stems. Sin ffmpeg: libsndfile >= 1.1 decodifica MP3."""

from pathlib import Path

import numpy as np
import soundfile as sf

MAX_BYTES = 60 * 1024 * 1024
MAX_SECONDS = 15 * 60


class InputError(ValueError):
    """El archivo de entrada no es un MP3 válido o excede los límites."""


def _looks_like_mp3(head: bytes) -> bool:
    if head[:3] == b"ID3":
        return True
    # MPEG audio frame sync: 11 bits en 1, layer III (bits 01)
    return len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and (head[1] & 0x06) == 0x02


def validate_mp3(path: Path) -> None:
    if path.suffix.lower() != ".mp3":
        raise InputError("Solo se aceptan archivos .mp3")
    if not path.is_file():
        raise InputError("El archivo no existe")
    size = path.stat().st_size
    if size == 0 or size > MAX_BYTES:
        raise InputError(f"El MP3 debe pesar entre 1 byte y {MAX_BYTES // (1024 * 1024)} MB")
    with path.open("rb") as f:
        head = f.read(4)
    if not _looks_like_mp3(head):
        raise InputError("El archivo no parece un MP3 válido")


def load_mp3(path: Path) -> tuple[np.ndarray, int]:
    """Devuelve (audio float32 [canales, muestras], sample_rate). Siempre estéreo."""
    validate_mp3(path)
    try:
        info = sf.info(str(path))
    except Exception as exc:  # libsndfile no pudo abrirlo
        raise InputError(f"No se pudo decodificar el MP3: {exc}") from exc
    if info.duration > MAX_SECONDS:
        raise InputError(f"La canción dura más de {MAX_SECONDS // 60} minutos")
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    audio = data.T
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    elif audio.shape[0] > 2:
        audio = audio[:2]
    return np.ascontiguousarray(audio), sr


def write_ogg(path: Path, audio: np.ndarray, sr: int) -> None:
    """Escribe [canales, muestras] como OGG Vorbis, por bloques (libsndfile falla con bloques enormes)."""
    frames = np.clip(audio.T, -1.0, 1.0).astype(np.float32)
    block = 1 << 15
    with sf.SoundFile(str(path), "w", samplerate=sr, channels=frames.shape[1], format="OGG", subtype="VORBIS") as f:
        for i in range(0, len(frames), block):
            f.write(frames[i : i + block])
