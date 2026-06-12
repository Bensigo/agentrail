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


def push_review_gate(
    target: Path,
    run_id: str,
    round_no: int,
    outcome,  # ReviewOutcome — avoid circular import at module level
) -> bool:
    """POST a review-gate record for one completed review round.

    Returns True only on HTTP 202; returns False (never raises) otherwise.
    ``round_no`` should be the post-increment value so it matches
    'review round N completed' semantics.
    """
    try:
        link = load_link(target)
        if link is None:
            return False
        gate_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
        payload = {
            "id": gate_id,
            "repository_id": link["repository_id"],
            "run_id": run_id,
            "gate_name": f"review-round-{round_no}",
            "status": "failed" if outcome.has_blocking else "passed",
            "blocking_reasons": [
                {
                    "title": f.title,
                    "severity": f.severity,
                    "file": f.file,
                    "body": f.body,
                }
                for f in outcome.blocking
            ],
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
        }
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
