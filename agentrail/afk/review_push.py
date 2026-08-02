"""Push per-review-round gate results to the AgentRail telemetry pipeline.

NON-FATAL: every failure is swallowed; the afk run is never affected.
"""
from __future__ import annotations

import json
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from agentrail.context.snapshot_push import load_link

_GATE_STATE_TO_STATUS = {"pass": "passed", "fail": "failed", "pending": "pending"}


def extract_memory_suggestions(outcome) -> list:
    """Extract memory-worthy suggestions from a review outcome.

    ``outcome`` is duck-typed (a ``memory_suggestions`` list attribute is all
    that's read) — the ``ReviewOutcome``/``Finding`` types that used to define
    this shape lived in ``agentrail.afk.review``, deleted with the Arc B
    reviewer-of-record wave.

    Returns a list of dicts with 'content' and 'tags' keys, filtered to items
    where 'body' is non-empty. Returns [] when none are present.
    """
    suggestions = getattr(outcome, "memory_suggestions", None)
    if not isinstance(suggestions, list):
        return []
    items = []
    for m in suggestions:
        if not isinstance(m, dict):
            continue
        body = str(m.get("body") or "").strip()
        if not body:
            continue
        tags: list = []
        kind = str(m.get("kind") or "").strip()
        if kind:
            tags.append(f"kind:{kind}")
        target = str(m.get("target_file") or "").strip()
        if target:
            tags.append(f"file:{target}")
        items.append({"content": body, "tags": tags})
    return items


def push_memory_items(
    target,  # Path
    run_id: str,
    outcome,  # duck-typed review outcome — see extract_memory_suggestions
) -> bool:
    """POST memory suggestions extracted from a review outcome.

    Returns True only on HTTP 202; returns False (never raises) otherwise.
    Skips silently when no memory suggestions are present.
    """
    try:
        items = extract_memory_suggestions(outcome)
        if not items:
            return True  # nothing to push — not a failure
        link = load_link(target)
        if link is None:
            return False
        payload = {
            "run_id": run_id,
            "repository_id": link["repository_id"],
            "items": items,
        }
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}/api/v1/ingest/memory-items",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False


def build_gate_payload(repository_id: str, run_id: str, round_no: int, gate) -> dict:
    """Build the review-gate telemetry payload.

    status / blocking_reasons describe the OBJECTIVE gate (CI + security) —
    the only signal this payload carries. It no longer has a ``findings``
    field: that was the advisory LLM-review output (parsed by the
    now-deleted ``parse_findings``), removed with the Arc B
    reviewer-of-record wave. The console's Review Gates dashboard keeps
    showing status/blockingReasons; its findings section is empty from here
    on (accepted per the design's recorded blast radius).
    """
    gate_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
    return {
        "id": gate_id,
        "repository_id": repository_id,
        "run_id": run_id,
        "gate_name": f"review-round-{round_no}",
        "status": _GATE_STATE_TO_STATUS.get(gate.state, "pending"),
        "blocking_reasons": list(gate.reasons),
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }


def push_review_gate(
    target: Path,
    run_id: str,
    round_no: int,
    gate,  # ObjectiveGateResult
) -> bool:
    """POST a review-gate record carrying the objective gate's status/reasons."""
    try:
        link = load_link(target)
        if link is None:
            return False
        payload = build_gate_payload(
            link["repository_id"], run_id, round_no, gate
        )
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}/api/v1/ingest/review-gates",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False
