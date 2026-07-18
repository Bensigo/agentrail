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
        # Per-PASS idle accounting (#1267 PR② review fix). The naive shape —
        # sleep idle_seconds after EVERY empty claim, as worker.py does for
        # its single workspace — multiplies across a fleet: per-workspace
        # poll latency becomes ceil(workspaces/concurrency) * idle_seconds
        # (~100s at 20 workspaces, concurrency 2). Instead the fleet sweeps
        # the WHOLE rotation back-to-back and idles once per fully-empty
        # pass: `_empty_streak` counts consecutive empty claims fleet-wide
        # (any claim resets it), and when it reaches the rotation's size —
        # every workspace seen empty in a row, i.e. one full empty pass —
        # `_idle_gen` is bumped. Each slot sleeps once per generation (see
        # `_fleet_slot`), so per-workspace poll latency when idle is one
        # sweep of cheap claim calls + idle_seconds, independent of fleet
        # size.
        self._empty_streak = 0
        self._idle_gen = 0

    def next(self) -> Optional[WorkspaceSlot]:
        """The next workspace slot in rotation, or ``None`` if none are active."""
        with self._lock:
            if not self._slots:
                return None
            slot = self._slots[self._i % len(self._slots)]
            self._i += 1
            return slot

    def note_empty(self) -> None:
        """Record an empty (or transiently failed) claim turn.

        When the streak of consecutive empty turns reaches the rotation's
        size — one full pass with nothing claimed anywhere — a new idle
        generation opens and the streak resets. Transient claim ERRORS count
        as empty turns too: a fleet whose console is down must idle between
        sweeps exactly like a fleet with no work, not spin.
        """
        with self._lock:
            if not self._slots:
                return
            self._empty_streak += 1
            if self._empty_streak >= len(self._slots):
                self._empty_streak = 0
                self._idle_gen += 1

    def note_claim(self) -> None:
        """Record a successful claim: the current pass is not empty."""
        with self._lock:
            self._empty_streak = 0

    def idle_generation(self) -> int:
        """The current idle generation (bumped once per fully-empty pass)."""
        with self._lock:
            return self._idle_gen

    def drop(self, workspace_id: str) -> None:
        """Remove a workspace from rotation (its token was rejected). Idempotent."""
        with self._lock:
            self._slots = [s for s in self._slots if s.workspace_id != workspace_id]
            # The pass is redefined by the membership change; a stale streak
            # could otherwise compare against the wrong rotation size.
            self._empty_streak = 0

    def refresh(self, slots: List[WorkspaceSlot]) -> None:
        """Swap in a wholly new workspace list (called after each sync cycle).

        Slots currently mid-claim/execute in another thread are unaffected —
        they hold their OWN ``WorkspaceSlot`` reference already pulled via
        :meth:`next`; only the NEXT call to :meth:`next` sees the new list.
        """
        with self._lock:
            self._slots = list(slots)
            self._i = 0
            self._empty_streak = 0

    def workspace_ids(self) -> List[str]:
        with self._lock:
            return [s.workspace_id for s in self._slots]

    def is_empty(self) -> bool:
        with self._lock:
            return not self._slots


OnAuthDrop = Callable[[str, Exception], None]


def _default_on_auth_drop(workspace_id: str, exc: Exception) -> None:
    # Deliberately does NOT print str(exc): RunnerAuthError's message is
    # written for the single-workspace CLI ("run `agentrail login` again"),
    # which is exactly wrong here — no human ever logs a fleet workspace in.
    # The fleet-correct story: this one workspace is out of rotation; if its
    # key was revoked on purpose, nothing to do; if not, the operator revokes
    # the (now dead) fleet key in the console so the next sync mints a fresh
    # one and the workspace rejoins the rotation automatically.
    message = (
        f"workspace {workspace_id} dropped from rotation: its fleet token was "
        "rejected (revoked or invalid). Other workspaces are unaffected. If "
        "this workspace should still be served, revoke its fleet key in the "
        "console — the next sync will mint a fresh one and the workspace "
        "rejoins automatically."
    )
    _log.error("%s", message)
    print(f"\nFleet: {message}", file=sys.stderr)


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

    Idle semantics are PER PASS, not per empty claim: empty turns advance the
    rotation immediately (a sweep of N workspaces is N cheap back-to-back
    claim calls), and only a FULLY empty pass — every workspace seen empty
    consecutively, tracked fleet-wide by the rotation — makes each slot sleep
    ``idle_seconds`` once (the idle-generation check at the top of the loop)
    before the next sweep. Any claim anywhere in the pass resets the streak,
    so a busy fleet never idles mid-pass. This keeps per-workspace poll
    latency at roughly sweep-time + idle_seconds regardless of how many
    workspaces the fleet serves, where sleeping per empty claim would have
    made it ceil(workspaces/concurrency) * idle_seconds.
    """
    seen_idle_gen = rotation.idle_generation()
    while should_continue():
        current_gen = rotation.idle_generation()
        if current_gen != seen_idle_gen:
            # A fully-empty pass completed somewhere in the fleet — honor it
            # once per slot, so every slot pauses and the console gets a real
            # quiet window instead of C-1 threads continuing to sweep.
            seen_idle_gen = current_gen
            sleep(idle_seconds)
            continue
        slot = rotation.next()
        if slot is None:
            # Every workspace has been dropped (all tokens rejected, or the
            # store started empty) — nothing to sweep until the next sync
            # refreshes the rotation; plain idle, no pass accounting.
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
            # Counts as an empty turn: an all-workspaces-erroring sweep (the
            # console is down) must reach a fully-empty pass and idle, not spin.
            rotation.note_empty()
            continue
        if item is None:
            # Nothing queued for THIS workspace — move straight on to the next
            # workspace in rotation; the sleep happens once per fully-empty
            # pass (see the idle-generation check above), not here.
            rotation.note_empty()
            continue
        rotation.note_claim()
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
    ``agentrail.runner.worker``'s own default (10.0s), but fires once per
    FULLY-EMPTY rotation pass rather than per empty claim (see
    ``_fleet_slot``'s docstring) — per-workspace poll latency when the fleet
    is idle is therefore ~(one sweep of claim calls + idle_seconds),
    independent of how many workspaces the fleet serves.
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
