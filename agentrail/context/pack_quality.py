"""Live context-pack quality proxies.

Computes ground-truth-free quality signals for a retrieved context pack so the
dashboard's Context Quality surfaces (precision_at_budget, citation_coverage,
stale_count, denied_count, source_hash_list) reflect real runs.

``precision_at_budget`` is a DIAGNOSTIC-ONLY label-share proxy (source-type /
authority membership over the fixed ``RETRIEVAL_MAX_TOKENS`` budget). It is
gameable — a rerank that trims filler to a smaller, more relevant pack *lowers*
it — so it MUST NEVER gate a run (issue #1037, AC5). The read-grounded live
precision/recall in :mod:`agentrail.context.live_metrics` is what a run is
judged on; this value survives only as a labeled diagnostic on the dashboard.
The guardrails :class:`~agentrail.guardrails.signals.Signals` (the sole input
every gating policy reads) deliberately has no precision field, so no gate can
read this value even by accident; ``agentrail/tests/guardrails/test_no_precision_gating``
locks that invariant.

This module is pure (no I/O) and total/defensive: it tolerates missing keys,
non-dict items and ``None`` values and never raises.
"""

from __future__ import annotations

from typing import Any, Dict, List

__all__ = ["compute_pack_quality"]

# Context-doc tier — always counts as required/anchor.
_REQUIRED_SOURCE_TYPES = {"context_doc", "taste_doc"}
# High-value authority tiers treated as required/anchor (vs low/unknown filler).
# Broadened from {critical} so precision reflects "high-value vs filler" across
# code-heavy packs, not just packs that include context docs.
_REQUIRED_AUTHORITIES = {"critical", "high"}
_STALE_STATUSES = {"stale", "expired"}
_DENIED = "denied"


def _as_dict(item: Any) -> Dict[str, Any]:
    return item if isinstance(item, dict) else {}


def _freshness_status(item: Dict[str, Any]) -> str:
    """Return the freshness status, tolerating dict or plain-string shapes."""
    freshness = item.get("freshness")
    if isinstance(freshness, dict):
        status = freshness.get("status")
    else:
        status = freshness
    if status is None:
        return ""
    return str(status).strip().lower()


def _stable_hash(item: Dict[str, Any]) -> str:
    """Stable provenance hash for an item: contentHash preferred, else textHash."""
    for key in ("contentHash", "textHash"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _is_required(item: Dict[str, Any]) -> bool:
    """Whether a selected item is required/anchor (high-value, not filler).

    True when the item is a context-doc tier source OR carries a high-value
    authority ({critical, high}). The token share of these items vs. the whole
    budget is `precision_at_budget` — "how much budget went to high-value
    context vs. filler".
    """
    source_type = item.get("sourceType") or item.get("kind")
    if source_type is not None and str(source_type) in _REQUIRED_SOURCE_TYPES:
        return True
    return str(item.get("authority") or "").strip().lower() in _REQUIRED_AUTHORITIES


def _token_estimate(item: Dict[str, Any]) -> float:
    value = item.get("tokenEstimate")
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def compute_pack_quality(
    selected: List[dict],
    excluded: List[dict],
    selected_context_tokens: int,
) -> dict:
    """Compute live context-pack quality proxies (no ground truth needed).

    Returns {"precision_at_budget": float, "citation_coverage": float,
             "stale_count": int, "denied_count": int, "source_hash_list": list[str]}.
    """
    selected_items = [_as_dict(item) for item in (selected or []) if isinstance(item, dict)]
    excluded_items = [_as_dict(item) for item in (excluded or []) if isinstance(item, dict)]

    # precision_at_budget: token share of required/anchor selected items.
    try:
        budget_tokens = float(selected_context_tokens or 0)
    except (TypeError, ValueError):
        budget_tokens = 0.0
    if budget_tokens > 0:
        required_tokens = sum(_token_estimate(item) for item in selected_items if _is_required(item))
        precision_at_budget = required_tokens / budget_tokens
        if precision_at_budget < 0.0:
            precision_at_budget = 0.0
        elif precision_at_budget > 1.0:
            precision_at_budget = 1.0
    else:
        precision_at_budget = 0.0

    # citation_coverage: fraction of selected items carrying a stable provenance hash.
    if selected_items:
        hashed = sum(1 for item in selected_items if _stable_hash(item))
        citation_coverage = hashed / len(selected_items)
    else:
        citation_coverage = 0.0

    # stale_count: selected items whose freshness status is stale/expired.
    stale_count = sum(1 for item in selected_items if _freshness_status(item) in _STALE_STATUSES)

    # denied_count: excluded items denied by visibility or authority policy.
    denied_count = sum(
        1
        for item in excluded_items
        if str(item.get("visibility") or "") == _DENIED or str(item.get("authority") or "") == _DENIED
    )

    # source_hash_list: ordered stable hashes of selected items, skipping empties.
    source_hash_list = [h for h in (_stable_hash(item) for item in selected_items) if h]

    return {
        "precision_at_budget": float(precision_at_budget),
        "citation_coverage": float(citation_coverage),
        "stale_count": int(stale_count),
        "denied_count": int(denied_count),
        "source_hash_list": source_hash_list,
    }
