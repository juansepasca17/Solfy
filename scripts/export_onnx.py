"""Exporta a ONNX los modelos que el modo GPU (DirectML) ejecuta. Se corre en la build, no en la app.

  python scripts/export_onnx.py [--models models]

- htdemucs_core.onnx: el núcleo de htdemucs (encoders + transformer + decoders). El STFT/iSTFT
  y la máscara compleja quedan fuera (DirectML no soporta números complejos) y los calcula
  `solfy_engine.backends.onnx_dml` en CPU con los mismos métodos de demucs.
- crepe_full.onnx: CREPE full, (N, 1024) muestras normalizadas -> (N, 360) probabilidades.
"""

import argparse
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from solfy_engine.backends.htdemucs_core import HTDemucsCore, core_input_shapes  # noqa: E402


def export_demucs(models: Path) -> Path:
    from demucs.pretrained import get_model

    bag = get_model("htdemucs", repo=models / "demucs")
    model = bag.models[0].eval()
    core = HTDemucsCore(model).eval()
    mix_shape, mag_shape = core_input_shapes(model)
    mix = torch.randn(*mix_shape)
    mag = torch.randn(*mag_shape)
    # El "fast path" de MultiheadAttention (aten::_native_multi_head_attention) no se exporta a ONNX.
    torch.backends.mha.set_fastpath_enabled(False)
    out = models / "onnx" / "htdemucs_core.onnx"
    out.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            core,
            (mix, mag),
            str(out),
            input_names=["mix", "mag"],
            output_names=["spec", "wave"],
            dynamic_axes={"mix": {0: "batch"}, "mag": {0: "batch"}, "spec": {0: "batch"}, "wave": {0: "batch"}},
            opset_version=17,
            dynamo=False,
        )
    print("htdemucs_core.onnx OK", out.stat().st_size // 2**20, "MB")
    return out


def export_crepe(models: Path) -> Path:
    import torchcrepe

    torchcrepe.load.model("cpu", "full")
    net = torchcrepe.infer.model.eval()
    out = models / "onnx" / "crepe_full.onnx"
    out.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            net,
            (torch.randn(8, 1024),),
            str(out),
            input_names=["frames"],
            output_names=["probs"],
            dynamic_axes={"frames": {0: "n"}, "probs": {0: "n"}},
            opset_version=17,
            dynamo=False,
        )
    print("crepe_full.onnx OK", out.stat().st_size // 2**20, "MB")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=str(ROOT / "models"))
    ap.add_argument("--only", choices=["demucs", "crepe"])
    args = ap.parse_args()
    models = Path(args.models)
    if args.only != "crepe":
        export_demucs(models)
    if args.only != "demucs":
        export_crepe(models)


if __name__ == "__main__":
    main()
