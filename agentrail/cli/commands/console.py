from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import List


def _repo_dir() -> Path:
    return Path(__file__).resolve().parents[3]


def _docker_available() -> bool:
    return shutil.which("docker") is not None


def _pnpm_available() -> bool:
    return shutil.which("pnpm") is not None


def _run(cmd: List[str], cwd: Path | None = None) -> int:
    result = subprocess.run(cmd, cwd=cwd, check=False)
    return result.returncode


def run_console(args: List[str]) -> int:
    repo = _repo_dir()
    seed = "--seed" in args
    stop = "--stop" in args

    if not _docker_available():
        print("Error: Docker is not installed or not in PATH.", file=sys.stderr)
        print("Install Docker Desktop and try again.", file=sys.stderr)
        return 1

    if stop:
        print("Stopping console services...")
        return _run(["docker", "compose", "down"], cwd=repo)

    if not _pnpm_available():
        print("Error: pnpm is not installed or not in PATH.", file=sys.stderr)
        print("Install pnpm: npm install -g pnpm", file=sys.stderr)
        return 1

    print("Starting Docker services...")
    rc = _run(["docker", "compose", "up", "-d", "--wait"], cwd=repo)
    if rc != 0:
        print("Error: Failed to start Docker services.", file=sys.stderr)
        return rc

    print("Installing dependencies...")
    rc = _run(["pnpm", "install"], cwd=repo)
    if rc != 0:
        print("Error: pnpm install failed.", file=sys.stderr)
        return rc

    print("Running Postgres migrations...")
    rc = _run(["pnpm", "run", "db:migrate"], cwd=repo)
    if rc != 0:
        print("Warning: Migrations may have failed (services might still be starting).")

    if seed:
        print("Seeding data...")
        rc = _run(["pnpm", "run", "db:seed"], cwd=repo)
        if rc != 0:
            print("Warning: Seed may have partially failed.")

    print("Starting console dev server at http://localhost:3000 ...")
    return _run(["pnpm", "run", "dev"], cwd=repo)
