"""Genera el ícono de Solfy (PNG 256 + ICO) sin dependencias extra: círculo rojo con una corchea blanca."""

import struct
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def render(size: int) -> np.ndarray:
    ss = 4  # supersampling
    n = size * ss
    y, x = np.mgrid[0:n, 0:n] / n  # 0..1
    img = np.zeros((n, n, 4), dtype=np.float32)

    circle = (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.47**2
    red = np.array([0.90, 0.16, 0.16, 1.0])
    img[circle] = red

    # corchea: cabeza elíptica inclinada + plica + bandera
    cx, cy = 0.42, 0.68
    a, b, ang = 0.13, 0.095, -0.45
    dx, dy = x - cx, y - cy
    rx = dx * np.cos(ang) - dy * np.sin(ang)
    ry = dx * np.sin(ang) + dy * np.cos(ang)
    head = (rx / a) ** 2 + (ry / b) ** 2 <= 1
    stem = (x >= 0.515) & (x <= 0.56) & (y >= 0.22) & (y <= 0.68)
    fy = (y - 0.22) / 0.30
    flag = (fy >= 0) & (fy <= 1) & (x >= 0.54) & (x <= 0.54 + 0.17 * np.sin(np.pi * np.clip(fy, 0, 1)) + 0.02) & (x >= 0.54 + 0.12 * fy - 0.02)
    note = (head | stem | flag) & circle
    img[note] = [1, 1, 1, 1]

    img = img.reshape(size, ss, size, ss, 4).mean(axis=(1, 3))
    return (img * 255).round().astype(np.uint8)


def png_bytes(rgba: np.ndarray) -> bytes:
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[i].tobytes() for i in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico_bytes(pngs: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for size, data in pngs:
        s = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    return header + entries + blobs


def main() -> None:
    big = png_bytes(render(256))
    (ROOT / "app" / "renderer" / "assets").mkdir(parents=True, exist_ok=True)
    (ROOT / "app" / "renderer" / "assets" / "icon.png").write_bytes(big)
    (ROOT / "app" / "build").mkdir(parents=True, exist_ok=True)
    (ROOT / "app" / "build" / "icon.png").write_bytes(big)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    (ROOT / "app" / "build" / "icon.ico").write_bytes(ico_bytes([(s, png_bytes(render(s))) for s in sizes]))
    print("iconos OK")


if __name__ == "__main__":
    main()
