"""Push a cost event to the linked AgentRail server.

Builds a cost_event payload from a Usage record and POSTs it to
POST /api/v1/ingest/cost-events.  Every failure is non-fatal: the local
run always stands on its own.
"""
from __future__ import annotations

import json
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from agentrail.context.snapshot_push import load_link
from agentrail.run.usage_capture import Usage


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def push_cost_event(
    target: Path,
    run_id: str,
    phase: str,
    usage: Usage,
    cost: float,
) -> bool:
    """POST one cost event to the linked server. Returns True only on HTTP 202.

    Non-fatal: any exception → False, never raises.
    Not linked → False (no network call).
    """
    link = load_link(target)
    if link is None:
        return False
    payload = {
        "run_id": run_id,
        "repository_id": link["repository_id"],
        "cost_type": "model_call",
        "tokens": usage.input_tokens + usage.output_tokens + usage.cache_tokens,
        "cost_usd": cost,
        "model": usage.model,
        "occurred_at": _now_iso(),
        "event_id": str(uuid.uuid4()),
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{link['base_url']}/api/v1/ingest/cost-events",
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
