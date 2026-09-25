"""Salida: notes.json con el esquema estricto [{"note","freq","start","end"}]."""

import json
from pathlib import Path

from .notes import Note

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(midi: int) -> str:
    return f"{NAMES[midi % 12]}{midi // 12 - 1}"


def midi_to_freq(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def notes_to_json(notes: list[Note]) -> list[dict]:
    return [
        {"note": note_name(n.pitch), "freq": round(midi_to_freq(n.pitch), 2), "start": round(n.start, 3), "end": round(n.end, 3)}
        for n in notes
    ]


def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
