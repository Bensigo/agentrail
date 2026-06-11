"""
``agentrail init`` / ``agentrail install`` — native wrapper that execs the
``scripts/install-workflow`` helper (kept as a standalone script, like ralph-loop).
"""
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path
from typing import List


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def run_install(args: List[str]) -> int:
    installer = _repo_dir() / "scripts" / "install-workflow"
    if not (installer.exists() and os.access(installer, os.X_OK)):
        print(f"missing installer: {installer}", file=sys.stderr)
        return 2
    proc = subprocess.run([str(installer), *args], check=False)
    return int(proc.returncode)
