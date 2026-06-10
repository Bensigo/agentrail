"""
``agentrail console`` — start the local dev stack for the AgentRail console.

Usage:
  agentrail console            Start Docker services, run migrations, start Next.js dev server.
  agentrail console --seed     Same, but also seed Postgres and ClickHouse before starting.
  agentrail console --stop     Stop Docker Compose services.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import List


def _repo_dir() -> Path:
    # agentrail/cli/commands/console.py → parents[3] is repo root
    return Path(__file__).resolve().parents[3]


def _usage() -> str:
    return """Usage:
  agentrail console [--seed]   Start Docker Compose services (waits for healthy),
                               run Postgres and ClickHouse migrations, then start
                               the Next.js dev server at http://localhost:3000.
                               --seed: also seed both databases before starting.
  agentrail console --stop     Stop Docker Compose services.
"""


def _is_docker_running(repo: Path) -> bool:
    result = subprocess.run(
        ["docker", "info"],
        cwd=str(repo),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def _run(cmd: List[str], cwd: str) -> int:
    return subprocess.run(cmd, cwd=cwd, check=False).returncode


def run_console(args: List[str]) -> int:
    seed = False
    stop = False
    for a in args:
        if a in ("-h", "--help"):
            print(_usage())
            return 0
        elif a == "--seed":
            seed = True
        elif a == "--stop":
            stop = True
        else:
            print(f"unknown option: {a}", file=sys.stderr)
            print(_usage(), file=sys.stderr)
            return 1

    repo = _repo_dir()

    if not _is_docker_running(repo):
        print(
            "error: Docker is not running.\n"
            "Start Docker Desktop (or the Docker daemon) and try again.",
            file=sys.stderr,
        )
        return 1

    if stop:
        print("Stopping Docker Compose services...")
        rc = _run(["docker", "compose", "down"], str(repo))
        if rc != 0:
            print("error: docker compose down failed.", file=sys.stderr)
            return rc
        print("Services stopped.")
        return 0

    # Start services and wait for health checks
    print("Starting Docker Compose services (waiting for healthy)...")
    rc = _run(["docker", "compose", "up", "-d", "--wait"], str(repo))
    if rc != 0:
        print(
            "error: docker compose up failed.\n"
            "Run 'docker compose logs' for details.",
            file=sys.stderr,
        )
        return rc
    print("Services are healthy.")

    # Postgres migration
    print("Running Postgres migrations...")
    rc = _run(["pnpm", "--filter", "@agentrail/db-postgres", "migrate"], str(repo))
    if rc != 0:
        print("error: Postgres migration failed.", file=sys.stderr)
        return rc

    # ClickHouse migration
    print("Running ClickHouse migrations...")
    rc = _run(["pnpm", "--filter", "@agentrail/db-clickhouse", "db:migrate"], str(repo))
    if rc != 0:
        print("error: ClickHouse migration failed.", file=sys.stderr)
        return rc

    if seed:
        print("Seeding Postgres...")
        rc = _run(["pnpm", "--filter", "@agentrail/db-postgres", "seed"], str(repo))
        if rc != 0:
            print("error: Postgres seed failed.", file=sys.stderr)
            return rc

        print("Seeding ClickHouse...")
        rc = _run(["pnpm", "--filter", "@agentrail/db-clickhouse", "db:seed"], str(repo))
        if rc != 0:
            print("error: ClickHouse seed failed.", file=sys.stderr)
            return rc

    print("Starting Next.js dev server at http://localhost:3000 ...")
    # Replace the current process so Ctrl-C works naturally and output streams directly.
    os.chdir(str(repo))
    os.execvp("pnpm", ["pnpm", "--filter", "@agentrail/console", "dev"])
    # unreachable
    return 0  # pragma: no cover
