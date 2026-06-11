"""
``agentrail resume`` — native Python port of the legacy bash run_resume.

Reads .agentrail/state.json and writes a resume/handoff markdown to
<target>/.agentrail/handoffs/<YYYYMMDD-HHMMSS>-resume.md (or a custom path).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from agentrail.run.state import render_resume


def _usage() -> str:
    return (
        "Usage: agentrail resume [--target DIR] [--output FILE]\n"
        "\n"
        "Generates a resume/handoff markdown from .agentrail/state.json.\n"
        "Output defaults to <target>/.agentrail/handoffs/<YYYYMMDD-HHMMSS>-resume.md.\n"
    )


def _utc_stamp() -> str:
    """Return current UTC time as YYYYMMDD-HHMMSS."""
    return datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")


def run_resume(args: List[str], now: Optional[str] = None) -> int:
    """Parse args and write the resume/handoff file.

    Args:
        args: CLI arguments after ``resume``.
        now:  Optional injected timestamp string (YYYYMMDD-HHMMSS) for tests.
              Defaults to current UTC time.

    Returns:
        Exit code (0 on success, 2 on usage error).
    """
    target: str = os.getcwd()
    output_file: str = ""

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            return 0
        elif a == "--target":
            if i + 1 >= len(args) or args[i + 1].startswith("--"):
                print("--target requires a directory", file=sys.stderr)
                return 2
            target = args[i + 1]
            i += 2
        elif a == "--output":
            if i + 1 >= len(args) or args[i + 1].startswith("--"):
                print("--output requires a file path", file=sys.stderr)
                return 2
            output_file = args[i + 1]
            i += 2
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            print(_usage(), file=sys.stderr)
            return 2

    stamp = now if now is not None else _utc_stamp()
    if not output_file:
        output_file = str(Path(target) / ".agentrail" / "handoffs" / f"{stamp}-resume.md")

    # mkdir -p the output directory
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)

    body = render_resume(Path(target))

    # Write body + trailing newline to file
    Path(output_file).write_text(body + "\n", encoding="utf-8")

    # Tee: print body and the handoff line
    print(body)
    print()
    print(f"handoff: {output_file}")

    return 0
