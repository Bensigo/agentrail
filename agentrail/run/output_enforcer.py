"""Output Format Enforcer — back-compat shim (issue #918).

The PURE policy moved to ``agentrail.guardrails.policies.output_enforcer`` (the
framework-neutral guardrails package).  This module re-exports it so every
existing caller keeps working unchanged::

    from agentrail.run.output_enforcer import enforce, Accepted, Rejected, \
        all_changes_new_or_rename, EnforceResult

The decision semantics are identical — these names ARE the migrated policy's
objects (re-exported, not re-implemented), so ``isinstance`` checks across the
old and new import paths line up exactly.

Only ``push_format_rejection_event`` (and its helpers) stays here, because it
performs network I/O (a run-event POST) and is therefore NOT part of the pure
guardrail (AC3).  It mirrors ``push_agent_activity`` — non-fatal by design; local
runs always stand on their own.
"""
from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from agentrail.context.snapshot_push import load_link

# Re-export the pure policy so legacy callers (and tests) are unchanged.
from agentrail.guardrails.policies.output_enforcer import (  # noqa: F401
    Accepted,
    EnforceResult,
    Rejected,
    all_changes_new_or_rename,
    enforce,
)

__all__ = [
    "Accepted",
    "Rejected",
    "EnforceResult",
    "enforce",
    "all_changes_new_or_rename",
    "push_format_rejection_event",
]


# ---------------------------------------------------------------------------
# Run-event push (non-fatal) — I/O, stays in run/ (not part of the pure policy)
# ---------------------------------------------------------------------------

_seq_state: dict[str, int] = {}


def _next_seq(run_id: str) -> int:
    nxt = max(_seq_state.get(run_id, 0) + 1, int(time.time() * 1000))
    _seq_state[run_id] = nxt
    return nxt


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def push_format_rejection_event(
    target: Path,
    run_id: str,
    phase: str,
    reason: str,
    *,
    output_file: Optional[str] = None,
) -> bool:
    """POST an ``output_format_rejected`` run event to the linked AgentRail server.

    Returns ``True`` only on HTTP 202.  Non-fatal: any exception → ``False``.
    Not linked → ``False`` (no network call).
    """
    link = load_link(target)
    if link is None:
        return False

    ts = _now_iso()
    event = {
        "session_id": run_id,
        "seq": _next_seq(run_id),
        "ts": ts,
        "kind": phase,
        "action": {
            "type": "output_format_rejected",
            "phase": phase,
            "reason": reason,
            **({"output_file": output_file} if output_file else {}),
        },
        "digest": reason[:64],
    }

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
