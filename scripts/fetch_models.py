"""Descarga los modelos que se empaquetan dentro del instalador (se corre en la build, nunca en la app).

  python scripts/fetch_models.py [--out models] [--no-lyrics]

- Demucs htdemucs (separación de voz), verificado por el prefijo SHA256 del nombre de archivo.
- faster-whisper small (letra opcional).
Los pesos de CREPE vienen dentro del paquete `torchcrepe`.
"""

import argparse
import hashlib
import shutil
import sys
import urllib.request
from pathlib import Path

DEMUCS_URL = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th"
WHISPER_REPO = "Systran/faster-whisper-small"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_demucs(out: Path) -> None:
    dest_dir = out / "demucs"
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = DEMUCS_URL.rsplit("/", 1)[1]
    dest = dest_dir / name
    if not dest.exists():
        print(f"Descargando {name} ...")
        tmp = dest.with_suffix(".part")
        with urllib.request.urlopen(DEMUCS_URL) as r, tmp.open("wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(dest)
    expected = name.split("-")[1].split(".")[0]
    if not sha256(dest).startswith(expected):
        dest.unlink()
        sys.exit(f"Checksum inválido para {name}")

    import demucs

    yaml_src = Path(demucs.__file__).parent / "remote" / "htdemucs.yaml"
    shutil.copy(yaml_src, dest_dir / "htdemucs.yaml")
    print("Demucs OK")


def fetch_whisper(out: Path) -> None:
    from huggingface_hub import snapshot_download

    dest = out / "whisper-small"
    snapshot_download(WHISPER_REPO, local_dir=str(dest), allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"])
    print("Whisper small OK")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "models"))
    ap.add_argument("--no-lyrics", action="store_true")
    args = ap.parse_args()
    out = Path(args.out)
    fetch_demucs(out)
    if not args.no_lyrics:
        fetch_whisper(out)


if __name__ == "__main__":
    main()
