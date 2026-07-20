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
from typing import Optional

from agentrail.context.snapshot_push import load_link
from agentrail.run.pricing import cache_savings
from agentrail.run.usage_capture import Usage


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_cost_record(
    run_id: str,
    phase: str,
    usage: Usage,
    cost: float,
    price_source: Optional[str] = None,
) -> dict:
    """Build a cost event record dict (for both local ledger and remote push).

    ``price_source`` (#1337 PR ②) records WHICH price tier resolved this
    usage's rates — ``"gateway"`` | ``"price_table"`` | ``None`` (unknown
    model) — carried into both the local JSONL ledger and the remote
    ``POST /api/v1/ingest/cost-events`` payload so the durable ledger is
    auditable (AC1). Defaults to ``None`` so callers that don't yet have a
    source (and existing tests) still build a valid record. The value comes
    from ``agentrail.run.pricing.resolve_price_source`` /
    ``cost_breakdown(...)["price_source"]`` at the call site.
    """
    return {
        "run_id": run_id,
        "cost_type": "model_call",
        "tokens": (
            usage.input_tokens
            + usage.output_tokens
            + usage.cache_tokens
            + usage.cache_creation_tokens
        ),
        "cost_usd": cost,
        "model": usage.model,
        "occurred_at": _now_iso(),
        "event_id": str(uuid.uuid4()),
        "phase": phase,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_tokens": usage.cache_tokens,
        "cache_creation_tokens": usage.cache_creation_tokens,
        "price_source": price_source,
        "cache_savings": cache_savings(usage),
    }


def push_cost_event(
    target: Path,
    run_id: str,
    phase: str,
    usage: Usage,
    cost: float,
    price_source: Optional[str] = None,
) -> bool:
    """POST one cost event to the linked server. Returns True only on HTTP 202.

    Non-fatal: any exception → False, never raises.
    Not linked → False (no network call).

    ``price_source`` (#1337 PR ②) is threaded into the posted payload — see
    ``build_cost_record``.
    """
    link = load_link(target)
    if link is None:
        return False
    payload = {
        **build_cost_record(run_id, phase, usage, cost, price_source),
        "repository_id": link["repository_id"],
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
