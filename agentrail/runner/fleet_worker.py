"""The hosted fleet's multi-workspace claim→execute→report loop.

:mod:`agentrail.runner.worker` runs ``concurrency`` slots that ALL claim
against ONE ``workspace_id`` — the right shape for a self-hosted runner logged
into a single workspace. The fleet serves MANY workspaces from one process, so
it needs a different rotation: round-robin over every currently-known
workspace, one ``claim_next()`` per workspace per turn, spread across a
bounded pool of ``concurrency`` slots.

Reuses ``agentrail.runner.worker._report`` (the report_result call shape) so
the "how a finished run gets POSTed back" logic is not duplicated — the ONLY
genuinely new mechanic here is the round-robin rotation and what a
``RunnerAuthError`` means for it.

**Why an auth failure's blast radius differs from ``worker.py``:**
``worker.py:_run_slot`` treats ``RunnerAuthError`` as TERMINAL for the whole
process — a rejected token there IS ``agentrail login``'s only credential, so
there is nothing left to serve; every slot stops (a shared
``threading.Event``). The fleet's per-workspace tokens are independent: one
workspace's token being revoked/expired says nothing about any OTHER
workspace's token. So here a ``RunnerAuthError`` drops ONLY that one workspace
out of rotation (loud warning) and the fleet keeps serving everybody else —
the next sync cycle may mint that workspace a fresh token, at which point
``WorkspaceRotation.refresh`` silently brings it back.
"""
from __future__ import annotations

import logging
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

from agentrail.runner.client import RunnerAuthError
from agentrail.runner.worker import Execute, _report
from agentrail.sandbox.docker_runner import RunResult

_log = logging.getLogger("agentrail.runner.fleet_worker")


@dataclass(frozen=True)
class WorkspaceSlot:
    """Everything one workspace's claim needs: its own client + execute callback.

    ``client`` is a per-workspace ``RunnerClient`` (own bearer token, own
    ``workspace_id`` baked into every claim/report URL); ``execute`` is that
    workspace's ``_make_execute(creds)`` callback
    (``agentrail/cli/commands/fleet.py`` builds these, reusing
    ``agentrail.cli.commands.runner._make_execute`` byte-for-byte — see that
    module for why no refactor of the single-workspace path was needed).
    """

    workspace_id: str
    client: object  # duck-typed RunnerClient: .claim_next() / .report_result() / .report_telemetry()
    execute: Execute


class WorkspaceRotation:
    """Thread-safe round-robin cursor over the fleet's currently active workspaces.

    Multiple claim slots (threads) share ONE rotation: each calls
    :meth:`next` to atomically advance a shared cursor, so the overall
    workspace-visit ORDER stays round-robin (0, 1, ..., k-1, 0, 1, ...)
    regardless of which thread executes which turn — concurrency changes
    which thread does the work, never the rotation order. When there are
    fewer workspaces than concurrent slots, more than one slot may end up
    claiming against the SAME workspace at once; that is safe by the same
    atomic-claim guarantee ``worker.py``'s own concurrency already relies on
    (the backend's ``FOR UPDATE SKIP LOCKED``).
    """

    def __init__(self, slots: List[WorkspaceSlot]) -> None:
        self._lock = threading.Lock()
        self._slots: List[WorkspaceSlot] = list(slots)
        self._i = 0

    def next(self) -> Optional[WorkspaceSlot]:
        """The next workspace slot in rotation, or ``None`` if none are active."""
        with self._lock:
            if not self._slots:
                return None
            slot = self._slots[self._i % len(self._slots)]
            self._i += 1
            return slot

    def drop(self, workspace_id: str) -> None:
        """Remove a workspace from rotation (its token was rejected). Idempotent."""
        with self._lock:
            self._slots = [s for s in self._slots if s.workspace_id != workspace_id]

    def refresh(self, slots: List[WorkspaceSlot]) -> None:
        """Swap in a wholly new workspace list (called after each sync cycle).

        Slots currently mid-claim/execute in another thread are unaffected —
        they hold their OWN ``WorkspaceSlot`` reference already pulled via
        :meth:`next`; only the NEXT call to :meth:`next` sees the new list.
        """
        with self._lock:
            self._slots = list(slots)
            self._i = 0

    def workspace_ids(self) -> List[str]:
        with self._lock:
            return [s.workspace_id for s in self._slots]

    def is_empty(self) -> bool:
        with self._lock:
            return not self._slots


OnAuthDrop = Callable[[str, Exception], None]


def _default_on_auth_drop(workspace_id: str, exc: Exception) -> None:
    _log.error("workspace %s dropped from rotation: %s", workspace_id, exc)
    print(f"\nFleet: workspace {workspace_id} dropped from rotation — {exc}", file=sys.stderr)


def _fleet_slot(
    rotation: WorkspaceRotation,
    *,
    sleep: Callable[[float], None],
    idle_seconds: float,
    should_continue: Callable[[], bool],
    on_auth_drop: OnAuthDrop,
) -> None:
    """One fleet slot: pull the next workspace from ``rotation``, claim, execute,
    report — forever (until ``should_continue()`` is false). Mirrors
    ``worker.py:_run_slot`` turn for turn, with the single-client claim swapped
    for "the next workspace in the shared rotation."
    """
    while should_continue():
        slot = rotation.next()
        if slot is None:
            # Every workspace has been dropped (all tokens rejected, or the
            # store started empty) — nothing to do until the next sync.
            sleep(idle_seconds)
            continue
        try:
            item = slot.client.claim_next()
        except RunnerAuthError as exc:
            # ONE workspace's token was rejected — drop ONLY that workspace;
            # see the module docstring for why this must not be fleet-terminal.
            rotation.drop(slot.workspace_id)
            on_auth_drop(slot.workspace_id, exc)
            continue
        except Exception as exc:  # noqa: BLE001 - a server hiccup must not kill the fleet
            _log.warning(
                "claim failed for workspace %s (will retry): %s", slot.workspace_id, exc
            )
            sleep(idle_seconds)
            continue
        if item is None:
            # Nothing queued for this workspace right now — move on to the
            # next workspace in rotation after the same idle pause worker.py
            # uses for a single workspace.
            sleep(idle_seconds)
            continue
        try:
            result = slot.execute(item)
        except Exception as exc:  # noqa: BLE001 - one issue must not kill the loop
            _log.warning("execution failed for %s (workspace %s): %s",
                         item.id, slot.workspace_id, exc)
            result = RunResult(status="error", gate_reason=str(exc))
        try:
            _report(slot.client, item, result)
        except Exception as exc:  # noqa: BLE001 - reporting is best-effort
            _log.warning("could not report result for %s: %s", item.id, exc)
        try:
            slot.client.report_telemetry(
                item,
                status=result.status,
                gate_reason=result.gate_reason,
                evidence=result.logs_tail,
            )
        except Exception as exc:  # noqa: BLE001 - telemetry is best-effort
            _log.warning("could not report telemetry for %s: %s", item.id, exc)


def run_fleet_worker(
    rotation: WorkspaceRotation,
    *,
    sleep: Callable[[float], None] = time.sleep,
    idle_seconds: float = 10.0,
    should_continue: Callable[[], bool] = lambda: True,
    concurrency: int = 2,
    on_auth_drop: OnAuthDrop = _default_on_auth_drop,
) -> None:
    """Run ``concurrency`` fleet slots against the shared ``rotation`` until
    ``should_continue()`` is false. ``idle_seconds`` reuses
    ``agentrail.runner.worker``'s own default (10.0s) — same meaning: how long
    a slot waits before its next claim attempt when there was nothing to do.
    """
    concurrency = max(1, int(concurrency))

    if concurrency == 1:
        _fleet_slot(
            rotation,
            sleep=sleep,
            idle_seconds=idle_seconds,
            should_continue=should_continue,
            on_auth_drop=on_auth_drop,
        )
        return

    threads = [
        threading.Thread(
            target=_fleet_slot,
            args=(rotation,),
            kwargs=dict(
                sleep=sleep,
                idle_seconds=idle_seconds,
                should_continue=should_continue,
                on_auth_drop=on_auth_drop,
            ),
            daemon=True,
            name=f"fleet-slot-{i}",
        )
        for i in range(concurrency)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
