# PyInstaller: motor de Solfy como carpeta (onedir) -> engine/dist/solfy-engine/solfy-engine.exe
# Uso:  .venv\Scripts\pyinstaller solfy_engine.spec --noconfirm
from PyInstaller.utils.hooks import collect_all, collect_data_files

datas, binaries, hiddenimports = [], [], []
for pkg in ("demucs", "torchcrepe", "librosa", "soundfile", "soxr", "faster_whisper", "ctranslate2", "julius", "openunmix", "dora", "onnxruntime"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("lazy_loader")

a = Analysis(
    ["entry.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["solfy_engine.cli", "solfy_engine.backends.onnx_dml", "sklearn.utils._typedefs", "sklearn.neighbors._partition_nodes"],
    excludes=["tkinter", "matplotlib", "IPython", "jupyter", "notebook", "pytest", "torchvision", "tensorboard", "PyQt5", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="solfy-engine",
    console=True,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="solfy-engine")
