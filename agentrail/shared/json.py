from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: Any, *, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, indent=2 if pretty else None, separators=None if pretty else (",", ":"))
    path.write_text(f"{text}\n", encoding="utf-8")


def json_line(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))
