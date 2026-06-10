"""
``agentrail status`` — prints legacy status then appends a telemetry
summary line when ``.agentrail/afk/outbox.jsonl`` exists.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional


def run_status(args: List[str], target: Optional[Path] = None) -> int:
    cwd = target or Path.cwd()

    # Delegate to the legacy bash script first so its existing output is shown.
    repo = Path(__file__).resolve().parents[3]
    candidates = [
        repo / "scripts" / "agentrail-legacy",
        repo / ".agentrail" / "source" / "scripts" / "agentrail-legacy",
        repo / ".agentrail" / "source" / "scripts" / "agentrail",
    ]
    legacy = next((c for c in candidates if c.exists()), None)
    if legacy is not None:
        env = os.environ.copy()
        env["AGENTRAIL_PYTHON_SHIM"] = "1"
        subprocess.run([str(legacy), "status", *args], env=env, check=False, cwd=str(cwd))

    # Append telemetry summary line.
    try:
        from agentrail.afk.telemetry import count_outbox, load_last_flush  # noqa: PLC0415

        queued = count_outbox(cwd)
        last_flush = load_last_flush(cwd) or "never"
        print(f"telemetry: {queued} events queued, last flush {last_flush}")
    except Exception:  # noqa: BLE001
        pass

    return 0
