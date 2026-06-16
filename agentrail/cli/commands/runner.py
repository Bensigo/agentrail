"""``agentrail runner`` — run the local worker that executes your queued issues.

This is the only thing the user runs after ``agentrail login``. It claims
dispatched issues from the backend, runs each one locally (host-native, on the
user's own agent subscription), and reports the outcome back. No DB URL, no API
key, no webhook forwarding — the backend owns all of that.

  agentrail runner [--idle SECONDS] [--once]

``--once`` drains a single claim and exits (handy for a cron tick); the default
runs forever.
"""
from __future__ import annotations

import os
import sys
import time
from typing import List

from agentrail.runner.client import RunnerClient, WorkItem
from agentrail.runner.credentials import load_credentials
from agentrail.runner.worker import run_worker
from agentrail.sandbox.docker_runner import RunResult
from agentrail.sandbox.native_runner import select_sandbox_runner


def _make_execute():
    """Build the execute callback: run a claimed issue on the host."""
    runner = select_sandbox_runner(dict(os.environ))

    def execute(item: WorkItem) -> RunResult:
        return runner(
            repo_url=item.repo_url,
            ref=item.ref,
            issue_ref=item.external_id,
            workspace_id=item.workspace_id,
            env=dict(os.environ),
        )

    return execute


def run_runner(args: List[str]) -> int:
    idle = 10.0
    once = False
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a == "--idle":
            i += 1
            if i >= len(args):
                print("error: --idle requires a value", file=sys.stderr)
                return 1
            try:
                idle = float(args[i])
            except ValueError:
                print("error: --idle must be a number", file=sys.stderr)
                return 1
        elif a == "--once":
            once = True
        else:
            print(f"unknown option: {a}", file=sys.stderr)
            return 1
        i += 1

    creds = load_credentials()
    if creds is None:
        print("Not logged in. Run `agentrail login` first.", file=sys.stderr)
        return 1

    client = RunnerClient(
        base_url=creds.base_url,
        token=creds.token,
        workspace_id=creds.workspace_id,
    )

    print(
        f"Runner active — workspace {creds.workspace_id} @ {creds.base_url}. "
        f"{'Draining one claim.' if once else 'Watching for queued issues.'}"
    )

    # --once: process at most one cycle. Default: run forever.
    if once:
        ticks = {"n": 0}

        def should_continue() -> bool:
            ticks["n"] += 1
            return ticks["n"] <= 1

    else:
        def should_continue() -> bool:
            return True

    try:
        run_worker(
            client,
            execute=_make_execute(),
            sleep=time.sleep,
            idle_seconds=idle,
            should_continue=should_continue,
        )
    except KeyboardInterrupt:
        print("\nRunner stopped.")
    return 0
