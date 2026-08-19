"""Standalone read-only pnpm observation producer loop."""
from __future__ import annotations

import os
import sys
import time
from typing import Callable, Protocol

from agentrail.dependencies.acceptance_pnpm_observation_worker import (
    PnpmObservationWorker,
    WorkerConfig,
    WorkerError,
    bounded_http_request,
    bounded_version_command,
)


class _Worker(Protocol):
    def run_once(self) -> str: ...


def _real_worker() -> PnpmObservationWorker:
    required = {
        "JACE_CONSOLE_URL": os.environ.get("JACE_CONSOLE_URL"),
        "AGENTRAIL_SERVER_API_KEY": os.environ.get("AGENTRAIL_SERVER_API_KEY"),
        "AGENTRAIL_WORKSPACE_ID": os.environ.get("AGENTRAIL_WORKSPACE_ID"),
        "AGENTRAIL_DEPENDENCY_WORKER_ID": os.environ.get("AGENTRAIL_DEPENDENCY_WORKER_ID"),
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise ValueError("missing required environment: " + ", ".join(missing))
    return PnpmObservationWorker(
        WorkerConfig(
            console_url=required["JACE_CONSOLE_URL"] or "",
            workspace_api_key=required["AGENTRAIL_SERVER_API_KEY"] or "",
            workspace_id=required["AGENTRAIL_WORKSPACE_ID"] or "",
            worker_id=required["AGENTRAIL_DEPENDENCY_WORKER_ID"] or "",
        ),
        request=bounded_http_request,
        run_command=bounded_version_command,
    )


def run_dependency_observation_worker(
    args: list[str],
    *,
    worker_factory: Callable[[], _Worker] = _real_worker,
) -> int:
    once = False
    interval = 30
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--once":
            once = True
        elif argument == "--interval":
            index += 1
            if index >= len(args):
                print("dependency-observation-worker: --interval needs seconds", file=sys.stderr)
                return 2
            try:
                interval = int(args[index])
            except ValueError:
                print("dependency-observation-worker: --interval must be an integer", file=sys.stderr)
                return 2
            if interval < 1 or interval > 3600:
                print("dependency-observation-worker: --interval must be 1..3600", file=sys.stderr)
                return 2
        else:
            print(f"dependency-observation-worker: unknown option {argument!r}", file=sys.stderr)
            return 2
        index += 1

    try:
        worker = worker_factory()
        while True:
            outcome = worker.run_once()
            print(f"dependency-observation: {outcome}")
            if once:
                return 0
            time.sleep(interval)
    except (ValueError, WorkerError) as error:
        print(f"dependency-observation-worker: {error}", file=sys.stderr)
        return 1
