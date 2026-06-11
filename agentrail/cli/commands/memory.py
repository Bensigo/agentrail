"""
``agentrail memory`` — native wrapper that execs the
``templates/scripts/memory`` helper (kept as a standalone script, like ralph-loop).
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


def _usage() -> str:
    return "Usage:\n  agentrail memory <subcommand> [--target DIR] [args...]\n"


def run_memory(args: List[str]) -> int:
    if not args:
        print(_usage(), file=sys.stderr)
        return 1
    if args[0] in ("-h", "--help"):
        print(_usage())
        return 0

    kind = args[0]
    rest = args[1:]
    target = os.getcwd()
    passthrough: List[str] = []

    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--target":
            # value must exist and must not start with '--'
            if i + 1 >= len(rest) or rest[i + 1].startswith("--"):
                print("--target requires a directory", file=sys.stderr)
                return 2
            target = rest[i + 1]
            i += 2
        elif a in ("-h", "--help"):
            print(_usage())
            return 0
        else:
            # everything else — including unknown --flags — is passthrough
            passthrough.append(a)
            i += 1

    memory_script = _repo_dir() / "templates" / "scripts" / "memory"
    if not (memory_script.exists() and os.access(memory_script, os.X_OK)):
        print(f"missing internal memory helper: {memory_script}", file=sys.stderr)
        return 1

    proc = subprocess.run(
        [str(memory_script), kind, *passthrough],
        cwd=target,
        check=False,
    )
    return int(proc.returncode)
