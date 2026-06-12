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
from typing import Any, Dict, List

from agentrail.context.snapshot_push import load_link

# Server-side batch limit; also keeps payloads bounded.
_MAX_ITEMS = 100


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _build_items(retrieval: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Derive context-pack items from retrieval metadata, capped at _MAX_ITEMS.

    runMetadata carries selectedSources as a list of path strings with parallel
    reasons/scores lists; entries may also be dicts (path/reason/score) from
    other producers. Missing or malformed fields degrade to defaults — an item
    is dropped only when it has no usable path.
    """
    sources = retrieval.get("selectedSources")
    if not isinstance(sources, list):
        return []
    reasons = retrieval.get("reasons")
    reasons = reasons if isinstance(reasons, list) else []
    scores = retrieval.get("scores")
    scores = scores if isinstance(scores, list) else []
    items: List[Dict[str, Any]] = []
    for i, src in enumerate(sources):
        if len(items) >= _MAX_ITEMS:
            break
        if isinstance(src, dict):
            path = src.get("path")
            reason = src.get("reason")
            score = src.get("score")
            included = src.get("included", True)
        else:
            path = src
            reason = reasons[i] if i < len(reasons) else None
            score = scores[i] if i < len(scores) else None
            included = True
        if not isinstance(path, str) or not path:
            continue
        is_number = isinstance(score, (int, float)) and not isinstance(score, bool)
        items.append({
            "path": path,
            "reason": reason if isinstance(reason, str) else "",
            "score": float(score) if is_number else 0.0,
            "included": bool(included),
        })
    return items


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
    source_hash_list = retrieval.get("source_hash_list")
    if not isinstance(source_hash_list, list):
        source_hash_list = []
    else:
        source_hash_list = [s for s in source_hash_list if isinstance(s, str)]
    payload = {
        "run_id": run_id,
        "repository_id": link["repository_id"],
        "context_pack_id": str(uuid.uuid4()),
        "token_budget": int(max_tokens or 0),
        "tokens_used": int(retrieval.get("selectedContextTokens") or 0),
        "tokens_saved": int(retrieval.get("tokensSaved") or 0),
        "sources_considered": len(retrieval.get("selectedSources") or []),
        "occurred_at": _now_iso(),
        "items": _build_items(retrieval),
        "precision_at_budget": float(retrieval.get("precision_at_budget") or 0.0),
        "citation_coverage": float(retrieval.get("citation_coverage") or 0.0),
        "stale_count": int(retrieval.get("stale_count") or 0),
        "denied_count": int(retrieval.get("denied_count") or 0),
        "source_hash_list": source_hash_list,
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
