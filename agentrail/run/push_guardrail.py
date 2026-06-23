"""Secret / prod-push guardrail — back-compat shim (issue #921).

The PURE decision logic moved to
``agentrail.guardrails.policies.push_guardrail`` (the framework-neutral guardrails
package).  This module re-exports it so every existing caller keeps working
unchanged::

    from agentrail.run.push_guardrail import (
        DEFAULT_PROTECTED_TARGETS, SecretFinding, PushDecision,
        detect_secrets, find_protected_target, evaluate_push,
        build_audit_event, guard_push, make_server_emitter,
    )

The decision semantics are identical — the pure names ARE the migrated policy's
objects (re-exported, not re-implemented).  No decision logic remains here (AC4).

``make_server_emitter`` performs network I/O (a run-event POST).  Per the issue's
"mostly-I/O" guidance it stays behind this shim (it is the I/O edge, not a
guardrail decision); keeping it here also preserves the existing test that patches
``agentrail.run.push_guardrail.urllib`` (AC3).  ``_now_iso`` is re-exported because
the approval-gate policy re-uses it for one shared Audit Event envelope.
"""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict

from agentrail.context.snapshot_push import load_link

# Re-export the pure policy so legacy callers (and tests) are unchanged.
from agentrail.guardrails.policies.push_guardrail import (  # noqa: F401
    DEFAULT_PROTECTED_TARGETS,
    PushDecision,
    SecretFinding,
    _now_iso,
    build_audit_event,
    detect_secrets,
    evaluate_push,
    find_protected_target,
    guard_push,
)

__all__ = [
    "DEFAULT_PROTECTED_TARGETS",
    "SecretFinding",
    "PushDecision",
    "detect_secrets",
    "find_protected_target",
    "evaluate_push",
    "build_audit_event",
    "guard_push",
    "make_server_emitter",
]


# ---------------------------------------------------------------------------
# Server emitter (I/O edge): POST the Audit Event to the linked AgentRail
# server. Mirrors failure_push / activity_push: non-fatal, no network when the
# repo is not linked. Returns a callable suitable as guard_push's ``emit``.
# Kept here (the I/O edge) rather than in the pure policy.
# ---------------------------------------------------------------------------

def make_server_emitter(target: Path, run_id: str) -> Callable[[Dict[str, Any]], bool]:
    """Return an ``emit`` callback that POSTs Audit Events to the linked rail.

    The callback is non-fatal: not linked or any error → returns False and
    never raises, so a guardrail block is never masked by a telemetry failure.
    The local run (and the block) always stand on their own.
    """
    def _emit(event: Dict[str, Any]) -> bool:
        link = load_link(target)
        if link is None:
            return False
        # Stamp the run_id if the caller built the event without one.
        if not event.get("session_id"):
            event = {**event, "session_id": run_id}
        body = json.dumps([event]).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}/api/v1/ingest/run-events",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return int(resp.status) == 202
        except Exception:  # noqa: BLE001 — non-fatal by design
            return False

    return _emit
