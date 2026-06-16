"""``agentrail runner`` — run the local worker that executes your queued issues.

This is the only thing the user runs after ``agentrail login``. It claims
dispatched issues from the backend, runs each one locally (host-native, on the
user's own agent subscription), and reports the outcome back. No DB URL, no API
key, no webhook forwarding — the backend owns all of that.

  agentrail runner [--idle SECONDS] [--once] [--concurrency N]

``--once`` drains a single claim and exits (handy for a cron tick); the default
runs forever. ``--concurrency N`` runs N issues at once (the backend's atomic
claim keeps two slots from grabbing the same issue).
"""
from __future__ import annotations

import inspect
import os
import sys
import time
from typing import List

from agentrail.runner.client import RunnerClient, WorkItem
from agentrail.runner.credentials import load_credentials
from agentrail.runner.worker import run_worker
from agentrail.sandbox.docker_runner import RunResult
from agentrail.sandbox.native_runner import select_sandbox_runner


def _make_execute(creds):
    """Build the execute callback: run a claimed issue on the host.

    The local run is linked back to the backend (``AGENTRAIL_SERVER_*``) so it
    ingests cost events + run telemetry, keyed to this run's id (= the dashboard
    run / queue entry id) so they join to the run the runner registered.
    """
    runner = select_sandbox_runner(dict(os.environ))
    accepts_run_id = "run_id" in inspect.signature(runner).parameters

    def execute(item: WorkItem) -> RunResult:
        run_env = dict(os.environ)
        # Link this run to the backend so cost/telemetry land on the dashboard.
        # Needs all three (base, key, repo) or load_link ignores it.
        run_env["AGENTRAIL_SERVER_BASE_URL"] = creds.base_url
        run_env["AGENTRAIL_SERVER_API_KEY"] = creds.token
        if item.repository_id:
            run_env["AGENTRAIL_SERVER_REPOSITORY_ID"] = item.repository_id
        kwargs = dict(
            repo_url=item.repo_url,
            ref=item.ref,
            issue_ref=item.issue_number,  # bare number; `run issue` rejects repo#N
            workspace_id=item.workspace_id,
            env=run_env,
        )
        if accepts_run_id:
            # Use the dashboard run id so ingested cost events join to it.
            kwargs["run_id"] = item.id
        return runner(**kwargs)

    return execute


def run_runner(args: List[str]) -> int:
    idle = 10.0
    once = False
    concurrency = 1
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
        elif a == "--concurrency":
            i += 1
            if i >= len(args):
                print("error: --concurrency requires a value", file=sys.stderr)
                return 1
            try:
                concurrency = max(1, int(args[i]))
            except ValueError:
                print("error: --concurrency must be an integer", file=sys.stderr)
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

    # --once drains a single claim; concurrency only applies to the watch loop.
    if once:
        concurrency = 1
    print(
        f"Runner active — workspace {creds.workspace_id} @ {creds.base_url}. "
        + (
            "Draining one claim."
            if once
            else f"Watching for queued issues ({concurrency} in parallel)."
        )
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
            execute=_make_execute(creds),
            sleep=time.sleep,
            idle_seconds=idle,
            should_continue=should_continue,
            concurrency=concurrency,
        )
    except KeyboardInterrupt:
        print("\nRunner stopped.")
    return 0
