"""The runner worker loop — the heart of the downloaded CLI.

Claim the next dispatched issue from the backend, run it locally, report the
outcome, repeat. That's the whole job. The backend (local now, hosted later)
owns the queue, the DB, and the webhooks; this loop owns nothing but the act of
*executing* — on the user's own machine, with their own agent subscription.

Execution, timing, and the loop predicate are all injected so the loop is
hermetic in tests and so the same loop drives both a long-running daemon
(``should_continue`` always true) and a one-shot cron tick.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from agentrail.runner.client import RunnerAuthError, WorkItem
from agentrail.sandbox.docker_runner import RunResult

_log = logging.getLogger("agentrail.runner.worker")

# execute(item) -> RunResult. The default in the CLI is host-native execution.
Execute = Callable[[WorkItem], RunResult]


def _report(client, item: WorkItem, result: RunResult) -> None:
    client.report_result(
        item,
        status=result.status,
        cost_usd=result.cost_usd,
        branch=result.branch,
        gate_reason=result.gate_reason,
        logs_tail=result.logs_tail,
        pr_url=getattr(result, "pr_url", ""),
    )


def _run_slot(
    client,
    *,
    execute: Execute,
    sleep: Callable[[float], None],
    idle_seconds: float,
    should_continue: Callable[[], bool],
    stop: threading.Event,
) -> None:
    """One worker slot: the serial claim→execute→report loop.

    ``run_worker`` runs ``concurrency`` of these. Because the backend's claim is
    atomic (``FOR UPDATE SKIP LOCKED``), N slots never grab the same item, so N
    issues run truly in parallel. ``stop`` is shared: a terminal auth failure in
    any slot signals all of them to exit.
    """
    while should_continue() and not stop.is_set():
        try:
            item = client.claim_next()
        except RunnerAuthError as exc:
            # A rejected token is terminal for every slot — no retry fixes it.
            _log.error("%s", exc)
            print(f"\nRunner stopped: {exc}")
            stop.set()
            return
        except Exception as exc:  # noqa: BLE001 — a server hiccup must not kill it
            _log.warning("claim failed (will retry): %s", exc)
            sleep(idle_seconds)
            continue
        if item is None:
            sleep(idle_seconds)
            continue
        try:
            result = execute(item)
        except Exception as exc:  # noqa: BLE001 — one issue must not kill the loop
            _log.warning("execution failed for %s: %s", item.id, exc)
            result = RunResult(status="error", gate_reason=str(exc))
        try:
            _report(client, item, result)
        except Exception as exc:  # noqa: BLE001 — reporting is best-effort
            _log.warning("could not report result for %s: %s", item.id, exc)
        try:
            client.report_telemetry(
                item,
                status=result.status,
                gate_reason=result.gate_reason,
                # The failing run's logs tail becomes the failure_event evidence
                # (bounded + secret-scrubbed client-side). #1146.
                evidence=result.logs_tail,
            )
        except Exception as exc:  # noqa: BLE001 — telemetry is best-effort
            _log.warning("could not report telemetry for %s: %s", item.id, exc)


def run_worker(
    client,
    *,
    execute: Execute,
    sleep: Callable[[float], None] = time.sleep,
    idle_seconds: float = 10.0,
    should_continue: Callable[[], bool] = lambda: True,
    concurrency: int = 1,
) -> None:
    """Run the claim→execute→report loop until ``should_continue()`` is false.

    With ``concurrency=1`` (default) this is a single serial loop in the caller's
    thread. With ``concurrency>1`` it runs that many slots on background threads,
    so up to N dispatched issues execute at once — and the atomic backend claim
    guarantees no two slots take the same issue. Each slot, with nothing to
    claim, waits ``idle_seconds`` before retrying; an execution that raises is
    reported as ``error`` and the slot keeps going.
    """
    concurrency = max(1, int(concurrency))
    stop = threading.Event()

    if concurrency == 1:
        _run_slot(
            client,
            execute=execute,
            sleep=sleep,
            idle_seconds=idle_seconds,
            should_continue=should_continue,
            stop=stop,
        )
        return

    threads = [
        threading.Thread(
            target=_run_slot,
            args=(client,),
            kwargs=dict(
                execute=execute,
                sleep=sleep,
                idle_seconds=idle_seconds,
                should_continue=should_continue,
                stop=stop,
            ),
            daemon=True,
            name=f"runner-slot-{i}",
        )
        for i in range(concurrency)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
