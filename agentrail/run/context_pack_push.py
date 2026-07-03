"""Push a context pack telemetry event to the linked AgentRail server.

Builds a context_pack payload and POSTs it to
POST /api/v1/ingest/context-packs.  Every failure is non-fatal: the local
run always stands on its own.

Source of truth: when a persisted pack JSON path is supplied (``pack_file``),
the payload — tokens, sources AND all quality proxies (precision_at_budget,
citation_coverage, stale_count, denied_count, source_hash_list) — is read
directly from that pack, the actual context pack the run produced. The legacy
``retrieval`` (search runMetadata) is only a fallback for callers that have no
persisted pack.

Unlinked runs (eval / canary — no registered console run) still produce a
pack-metadata record: it is appended to a local JSONL sidecar that identifies
the run, so PRD4's nightly canary reports can join it.
"""
from __future__ import annotations

import json
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.snapshot_push import load_link

# Server-side batch limit; also keeps payloads bounded.
_MAX_ITEMS = 100

# Local sidecar where pack-metadata records for unlinked (eval/canary) runs land.
# Relative to the target dir; keyed on run_id so canary reports can join it.
_UNLINKED_SIDECAR = ".agentrail/context/pack-telemetry.jsonl"


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


def _read_pack(target: Path, pack_file: Optional[str]) -> Optional[Dict[str, Any]]:
    """Read the persisted pack JSON at <target>/<pack_file>; None if unavailable."""
    if not pack_file:
        return None
    try:
        pack = json.loads((Path(target) / pack_file).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — non-fatal: fall back to retrieval
        return None
    return pack if isinstance(pack, dict) else None


def read_pack_included(target: Path, pack_file: Optional[str]) -> List[Dict[str, Any]]:
    """Return the persisted pack's ``included`` items (path/tokenEstimate), or [].

    The read-grounded live-metric computation (#1037) needs the ACTUAL selected
    pack items — the precision denominator is these items' tokens, not a fixed
    budget. This reads them straight from the source-of-truth pack JSON and never
    raises: an unavailable/malformed pack yields an empty list, which the metric
    treats as an empty pack (precision n/a, not a crash).
    """
    pack = _read_pack(target, pack_file)
    if pack is None:
        return []
    included = pack.get("included")
    if not isinstance(included, list):
        return []
    return [entry for entry in included if isinstance(entry, dict)]


def _items_from_pack(pack: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Derive context-pack items from a persisted pack's included list, capped."""
    included = pack.get("included")
    if not isinstance(included, list):
        return []
    items: List[Dict[str, Any]] = []
    for entry in included:
        if len(items) >= _MAX_ITEMS:
            break
        if not isinstance(entry, dict):
            continue
        path = entry.get("path") or entry.get("citation")
        if not isinstance(path, str) or not path:
            continue
        reason = entry.get("reason")
        score = entry.get("score")
        is_number = isinstance(score, (int, float)) and not isinstance(score, bool)
        items.append({
            "path": path,
            "reason": reason if isinstance(reason, str) else "",
            "score": float(score) if is_number else 0.0,
            "included": True,
        })
    return items


def _pack_tokens_used(pack: Dict[str, Any]) -> int:
    """Sum of tokenEstimate across included pack items (the tokens the pack used)."""
    total = 0.0
    for entry in pack.get("included") or []:
        if not isinstance(entry, dict):
            continue
        value = entry.get("tokenEstimate")
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            total += float(value)
    return int(total)


def _clean_hash_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [s for s in value if isinstance(s, str)]


def _payload_from_pack(pack: Dict[str, Any], run_id: str, repository_id: str) -> Dict[str, Any]:
    """Build the ingest payload from the persisted pack JSON (source of truth).

    Every quality field is read from the pack, so a downstream assertion of
    'byte-equal to the persisted pack' holds. Missing fields degrade to zeros.
    """
    budget = pack.get("retrievalBudget")
    max_tokens = budget.get("maxTokens") if isinstance(budget, dict) else budget
    included = pack.get("included")
    return {
        "run_id": run_id,
        "repository_id": repository_id,
        "context_pack_id": str(pack.get("packId") or uuid.uuid4()),
        "token_budget": int(max_tokens or 0),
        "tokens_used": _pack_tokens_used(pack),
        "tokens_saved": int(pack.get("tokensSaved") or 0),
        "sources_considered": len(included) if isinstance(included, list) else 0,
        "occurred_at": _now_iso(),
        "items": _items_from_pack(pack),
        "precision_at_budget": float(pack.get("precision_at_budget") or 0.0),
        "citation_coverage": float(pack.get("citation_coverage") or 0.0),
        "stale_count": int(pack.get("stale_count") or 0),
        "denied_count": int(pack.get("denied_count") or 0),
        "source_hash_list": _clean_hash_list(pack.get("source_hash_list")),
    }


def _payload_from_retrieval(retrieval: Dict[str, Any], run_id: str, repository_id: str) -> Dict[str, Any]:
    """Legacy payload from search runMetadata; fallback when no persisted pack."""
    # retrievalBudget is a dict like {"maxItems": 10, "maxTokens": 5000} (or null);
    # the token budget is its maxTokens, not the dict itself.
    budget = retrieval.get("retrievalBudget")
    max_tokens = budget.get("maxTokens") if isinstance(budget, dict) else budget
    return {
        "run_id": run_id,
        "repository_id": repository_id,
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
        "source_hash_list": _clean_hash_list(retrieval.get("source_hash_list")),
    }


def _emit_unlinked(target: Path, payload: Dict[str, Any]) -> bool:
    """Append a pack-metadata record to the local sidecar (unlinked runs).

    Non-fatal: any exception → False. The record carries run_id + repository
    so PRD4's nightly canary reports can join it without a console run.
    """
    try:
        sidecar = Path(target) / _UNLINKED_SIDECAR
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        with sidecar.open("a", encoding="utf-8") as file:
            file.write(json.dumps({"delivery": "unlinked", **payload}) + "\n")
        return True
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False


def _live_metric_items(metrics: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Turn the waste/miss lists into context_events items (migration-free).

    The two lists (#1037, AC4) ride the SAME items channel the pack already uses,
    tagged with a distinguishing ``reason`` so the console can split them out:

      * ``reason="live_waste"``  — a pack file the executor never read
        (``included=True`` — it WAS in the pack; the waste is that it was unread).
      * ``reason="live_miss"``   — a file the executor fetched itself, absent from
        the pack (``included=False`` — it was NOT in the pack).

    No new ClickHouse column is needed: these are ordinary context_events rows,
    already drillable via ``getContextPackItems``. Bounded by ``_MAX_ITEMS``.
    """
    items: List[Dict[str, Any]] = []
    waste = metrics.get("waste")
    miss = metrics.get("miss")
    if isinstance(waste, list):
        for path in waste:
            if len(items) >= _MAX_ITEMS:
                return items
            if isinstance(path, str) and path:
                items.append(
                    {"path": path, "reason": "live_waste", "score": 0.0, "included": True}
                )
    if isinstance(miss, list):
        for path in miss:
            if len(items) >= _MAX_ITEMS:
                return items
            if isinstance(path, str) and path:
                items.append(
                    {"path": path, "reason": "live_miss", "score": 0.0, "included": False}
                )
    return items


def push_live_context_metrics(
    target: Path,
    run_id: str,
    metrics: Dict[str, Any],
    pack_file: Optional[str] = None,
) -> bool:
    """Re-emit the accepted pack carrying read-grounded live metrics (#1037).

    Called ONCE at run finalization, after the final accepted diff is known —
    the per-phase :func:`push_context_pack` fires before recall can be computed.
    It re-pushes the same ``context_pack_id`` so the console row is updated in
    place (ClickHouse ReplacingMergeTree semantics), now carrying:

      * ``engine`` + read-grounded ``precision`` / ``recall`` — surfaced on the
        pack payload as extra fields (the ingest route tolerates unknown keys);
        the two scalar numerics have NO dedicated ClickHouse column, so they are
        additionally encoded in the migration-free items channel below and
        FLAGGED in the PR body per the STOP-and-flag rule.
      * waste / miss lists as ``live_waste`` / ``live_miss`` context_events items.

    Non-fatal: any exception → False, never raises. n/a-engine runs (no reads)
    still push so the console can show the engine tag and an explicit n/a.
    """
    if not isinstance(metrics, dict):
        return False
    pack = _read_pack(target, pack_file)
    link = load_link(target)

    if pack is not None:
        repository_id = link["repository_id"] if link else ""
        payload = _payload_from_pack(pack, run_id, repository_id)
    else:
        # No persisted pack (e.g. a search-only run): still emit a minimal record
        # so the engine tag + live metrics are not dark.
        payload = {
            "run_id": run_id,
            "repository_id": link["repository_id"] if link else "",
            "context_pack_id": str(uuid.uuid4()),
            "token_budget": 0,
            "tokens_used": int(metrics.get("packTokens") or 0),
            "tokens_saved": 0,
            "sources_considered": int(metrics.get("packFileCount") or 0),
            "occurred_at": _now_iso(),
            "items": [],
            "precision_at_budget": 0.0,
            "citation_coverage": 0.0,
            "stale_count": 0,
            "denied_count": 0,
            "source_hash_list": [],
        }

    # Attach the live metrics. These extra top-level keys have no dedicated
    # ClickHouse column (FLAGGED); the ingest route ignores unknown keys, and the
    # waste/miss detail travels through the items channel which DOES persist.
    payload["live_context_metrics"] = metrics
    live_items = _live_metric_items(metrics)
    if live_items:
        existing = payload.get("items")
        merged = (existing if isinstance(existing, list) else []) + live_items
        payload["items"] = merged[:_MAX_ITEMS]

    if link is None:
        return _emit_unlinked(target, payload)

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


def push_context_pack(
    target: Path,
    run_id: str,
    retrieval: Dict[str, Any],
    pack_file: Optional[str] = None,
) -> bool:
    """Deliver one context-pack telemetry event. Returns True on delivery.

    Delivery is:
      * a POST to the linked server (True only on HTTP 202), when linked; or
      * a local sidecar append that identifies the run, when unlinked AND a
        persisted pack (``pack_file``) is available (eval / canary runs).

    Source of truth is the persisted pack JSON when ``pack_file`` is supplied;
    otherwise the legacy ``retrieval`` runMetadata is used.

    Non-fatal: any exception → False, never raises.
    Unlinked with no persisted pack → False (legacy contract, no network call).
    """
    pack = _read_pack(target, pack_file)
    link = load_link(target)

    if link is None:
        # Unlinked (eval / canary). We can only emit a run-identifying record
        # when a persisted pack exists; without one there is nothing to join on.
        if pack is None:
            return False
        payload = _payload_from_pack(pack, run_id, repository_id="")
        return _emit_unlinked(target, payload)

    if pack is not None:
        payload = _payload_from_pack(pack, run_id, link["repository_id"])
    else:
        payload = _payload_from_retrieval(retrieval, run_id, link["repository_id"])

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
