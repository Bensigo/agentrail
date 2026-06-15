"""Output Format Enforcer — deep, pure module (no file/network I/O in enforce()).

Rejects full-file rewrites of existing files; accepts diff/patch edits and any
content for new files or renames.

Design notes
------------
* ``enforce()`` is a pure predicate: callers pass the content to inspect and a
  flag indicating whether the file is new or renamed.  No I/O.
* Heuristic: the presence of a unified-diff hunk header (``@@ -N[,N] +N[,N] @@``)
  is the canonical signal that the content is a diff/patch.  Conservative
  direction: if ANY hunk header is present → Accepted; no hunk header in content
  that targets an existing file → Rejected.  False negatives (missed full rewrites)
  are safer than false positives that block legitimate edits.
* ``push_format_rejection_event()`` is non-fatal by design — mirrors
  ``push_agent_activity``.  Local runs always stand on their own.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

from agentrail.context.snapshot_push import load_link

# Matches the hunk header of a unified diff, e.g. "@@ -1,20 +1,21 @@"
_HUNK_HEADER_RE = re.compile(r"^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@", re.MULTILINE)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Accepted:
    """The content passed enforcement (diff/patch, or new-file/rename)."""


@dataclass(frozen=True)
class Rejected:
    """The content failed enforcement (full-file rewrite of an existing file)."""
    reason: str


EnforceResult = Union[Accepted, Rejected]


# ---------------------------------------------------------------------------
# Core enforcer (pure — no I/O)
# ---------------------------------------------------------------------------

def enforce(content: str, *, is_new_or_rename: bool = False) -> EnforceResult:
    """Return ``Accepted`` or ``Rejected`` for *content*.

    Parameters
    ----------
    content:
        The text to inspect — typically the agent's output for a single edit
        or the full phase output file.
    is_new_or_rename:
        ``True`` when the target file did not exist before (``git status A``) or
        is a rename (``git status R``).  Full content is always allowed for these.
    """
    if is_new_or_rename:
        return Accepted()

    if _HUNK_HEADER_RE.search(content):
        return Accepted()

    return Rejected(
        reason=(
            "Full-file rewrite of an existing file detected: no unified-diff hunk "
            "headers (@@ ... @@) found in the content.  Edit existing files with a "
            "diff/patch instead.  Full content is only accepted for new files or renames."
        )
    )


# ---------------------------------------------------------------------------
# Run-event push (non-fatal)
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
