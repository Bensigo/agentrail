from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import List

from agentrail.cli.commands.afk import run_afk
from agentrail.cli.commands.doctor import run_doctor
from agentrail.cli.commands.console import run_console
from agentrail.cli.commands.context import run_context
from agentrail.cli.commands.install import run_install
from agentrail.cli.commands.internal import run_internal
from agentrail.cli.commands.link import run_link
from agentrail.cli.commands.prompt import run_prompt
from agentrail.cli.commands.run import run_run
from agentrail.cli.commands.status import run_status
from agentrail.cli.commands.upgrade import run_upgrade
from agentrail.cli.commands.timeline import run_timeline


def _repo_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _legacy_script() -> Path:
    repo = _repo_dir()
    candidates = [
        repo / "scripts" / "agentrail-legacy",
        repo / ".agentrail" / "source" / "scripts" / "agentrail-legacy",
        repo / ".agentrail" / "source" / "scripts" / "agentrail",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return repo / "scripts" / "agentrail-legacy"


def main(argv: List[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in ("init", "install"):
        return run_install(args[1:])
    if args and args[0] == "doctor":
        return run_doctor(args[1:])
    if args and args[0] == "context":
        return run_context(args[1:])
    if args and args[0] == "afk":
        return run_afk(args[1:])
    if args and args[0] == "console":
        return run_console(args[1:])
    if args and args[0] == "link":
        return run_link(args[1:])
    if args and args[0] == "timeline":
        return run_timeline(args[1:])
    if args and args[0] == "status":
        return run_status(args[1:])
    if args and args[0] == "prompt":
        return run_prompt(args[1:])
    if args and args[0] == "run":
        return run_run(args[1:])
    if args and args[0] == "upgrade":
        return run_upgrade(args[1:])
    if args and args[0] == "internal":
        return run_internal(args[1:])
    legacy = _legacy_script()
    if not legacy.exists():
        print(f"missing AgentRail legacy command: {legacy}", file=sys.stderr)
        return 1
    env = os.environ.copy()
    env["AGENTRAIL_PYTHON_SHIM"] = "1"
    result = subprocess.run([str(legacy), *args], env=env, check=False)
    return int(result.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
