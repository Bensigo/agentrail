"""Push the QA phase verdict to the console as a review gate (#1148).

The QA phase produces a runtime verdict on the RUNNER; the console's dashboard
surfaces it alongside the other review gates via
``POST /api/v1/ingest/review-gates`` (gate_name ``qa``). This module is the one
seam that carries it there.

Distinct from ``afk/review_push.py`` on purpose: that helper hardcodes
``gate_name = "review-round-{n}"`` and never emits ``evidence_refs``. QA needs a
stable ``qa`` gate name and the ``evidence_refs`` channel (v1 leaves it empty —
durable artifact hosting is a follow-up — but the plumbing is here so it lights
up without a schema change).

NON-FATAL by contract: any failure — unlinked target, network error, non-202 —
returns ``False`` and never raises. Telemetry must never fail a run. A *skipped*
QA verdict is intentionally NOT posted: a skip is not a gate.
"""
from __future__ import annotations

import json
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from agentrail.context.snapshot_push import load_link
from agentrail.run.qa_phase import QaResult

# Console review-gate status vocabulary. QA only ever posts a decided verdict.
_VERDICT_TO_STATUS = {"passed": "passed", "failed": "failed"}


def build_qa_gate_payload(repository_id: str, run_id: str, qa: QaResult) -> dict:
    """Assemble the review-gate payload for a decided QA verdict.

    ``id`` is a deterministic uuid5 keyed on the run, so a re-push upserts the
    same row rather than duplicating it. ``findings`` / ``evidence_refs`` are
    forwarded verbatim from the QaResult (already in the console vocab).
    """
    status = _VERDICT_TO_STATUS[qa.verdict]
    blocking_reasons = [{"reason": qa.reason}] if qa.is_red and qa.reason else []
    return {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"qa-gate:{run_id}")),
        "repository_id": repository_id,
        "run_id": run_id,
        "gate_name": "qa",
        "status": status,
        "blocking_reasons": blocking_reasons,
        "findings": qa.findings,
        "evidence_refs": qa.evidence_refs,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }


def push_qa_gate(target: Path, run_id: str, qa: QaResult) -> bool:
    """POST the QA verdict as a ``qa`` review gate. Returns True only on HTTP 202.

    Skipped verdicts are not posted (returns False without a network call).
    Non-fatal: unlinked target or any exception → False, never raises.
    """
    if qa.verdict not in _VERDICT_TO_STATUS:
        return False
    try:
        link = load_link(target)
        if link is None:
            return False
        payload = build_qa_gate_payload(link["repository_id"], run_id, qa)
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
