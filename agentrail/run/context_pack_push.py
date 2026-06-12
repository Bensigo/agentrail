"""Push a context pack telemetry event to the linked AgentRail server.

Builds a context_pack payload from retrieval metadata and POSTs it to
POST /api/v1/ingest/context-packs.  Every failure is non-fatal: the local
run always stands on its own.
"""
from __future__ import annotations

import json
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from agentrail.context.snapshot_push import load_link


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def push_context_pack(
    target: Path,
    run_id: str,
    retrieval: Dict[str, Any],
) -> bool:
    """POST one context pack event to the linked server. Returns True only on HTTP 202.

    Non-fatal: any exception → False, never raises.
    Not linked → False (no network call).
    """
    link = load_link(target)
    if link is None:
        return False
    # retrievalBudget is a dict like {"maxItems": 10, "maxTokens": 5000} (or null);
    # the token budget is its maxTokens, not the dict itself.
    budget = retrieval.get("retrievalBudget")
    max_tokens = budget.get("maxTokens") if isinstance(budget, dict) else budget
    payload = {
        "run_id": run_id,
        "repository_id": link["repository_id"],
        "context_pack_id": str(uuid.uuid4()),
        "token_budget": int(max_tokens or 0),
        "tokens_used": int(retrieval.get("selectedContextTokens") or 0),
        "sources_considered": len(retrieval.get("selectedSources") or []),
        "occurred_at": _now_iso(),
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{link['base_url']}/api/v1/ingest/context-packs",
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
