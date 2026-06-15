"""Cross-phase retrieval deduplication for context packs.

When two or more phases of a single run (plan → execute → verify) retrieve
the same context item — identified by ``(path, contentHash)`` — the second
phase can reuse the first phase's pack result instead of re-fetching.  This
module provides the pure functions that detect those matches and compute the
avoided tokens and dollar cost.

All dollar math routes through ``cost_for`` in ``agentrail.context.pricing``.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.context.pricing import PRICE_TABLE, cost_for
from agentrail.context.retrieval import estimate_tokens


# ---------------------------------------------------------------------------
# Dedup key
# ---------------------------------------------------------------------------

def dedup_key(item: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """Return ``(path, contentHash)`` for an item, or ``None`` if either is absent.

    Only items with both a non-empty path and a non-empty contentHash can
    participate in dedup.
    """
    path = item.get("path")
    content_hash = item.get("contentHash")
    if isinstance(path, str) and path and isinstance(content_hash, str) and content_hash:
        return (path, content_hash)
    return None


# ---------------------------------------------------------------------------
# Per-phase dedup engine
# ---------------------------------------------------------------------------

def compute_retrieval_dedup(
    prior_items: List[Dict[str, Any]],
    current_items: List[Dict[str, Any]],
    model: str,
    prior_phase: str = "prior",
) -> Dict[str, Any]:
    """Detect items in *current_items* that were already retrieved in *prior_items*.

    Parameters
    ----------
    prior_items:
        All ``included`` items from previous phases of the same run.  Each item
        may carry a ``"_firstPhase"`` annotation set by the pack loader.
    current_items:
        ``included`` items from the current phase being built.
    model:
        Model identifier (e.g. ``"claude-sonnet-4-6"``) used to price the
        avoided tokens via ``cost_for``.
    prior_phase:
        Fallback label when a prior item lacks a ``_firstPhase`` annotation.

    Returns
    -------
    dict with keys:
        ``items_reused``       – count of current items whose (path, contentHash) appeared in prior phases
        ``tokens_avoided``     – sum of ``estimate_tokens(item.content)`` for reused items
        ``cost_avoided_usd``   – dollar cost of avoided tokens at ``model``'s input rate
        ``model``              – model string passed in
        ``estimate``           – True when model is unknown (chars/4 fallback used)
        ``reused``             – list of per-item evidence dicts (path, contentHash, firstPhase, tokens)
    """
    # Build a lookup: dedup_key → first-phase label, from prior items.
    # When a key appears multiple times (several phases), the first wins.
    prior_map: Dict[Tuple[str, str], str] = {}
    for item in prior_items:
        key = dedup_key(item)
        if key is not None and key not in prior_map:
            prior_map[key] = str(item.get("_firstPhase") or prior_phase)

    reused: List[Dict[str, Any]] = []
    tokens_avoided = 0

    for item in current_items:
        key = dedup_key(item)
        if key is None or key not in prior_map:
            continue
        content = item.get("content")
        tokens = estimate_tokens(content) if isinstance(content, str) else 0
        tokens_avoided += tokens
        reused.append({
            "path": key[0],
            "contentHash": key[1],
            "firstPhase": prior_map[key],
            "tokens": tokens,
        })

    cost_result = cost_for(model, input_tokens=tokens_avoided)
    return {
        "items_reused": len(reused),
        "tokens_avoided": tokens_avoided,
        "cost_avoided_usd": cost_result["dollars"],
        "model": model,
        "estimate": cost_result["estimate"],
        "reused": reused,
    }


# ---------------------------------------------------------------------------
# Run-level aggregator (for agentrail cost <run_id> — AC2)
# ---------------------------------------------------------------------------

def run_retrieval_dedup(target_dir: Path, run_id: str, model: str) -> Dict[str, Any]:
    """Aggregate ``retrieval_dedup`` stats across all packs for *run_id*.

    Reads every pack JSON under ``.agentrail/context/packs/`` whose ``runId``
    field matches *run_id* and sums the per-phase ``retrieval_dedup`` blocks.

    Returns a dict with the same shape as ``compute_retrieval_dedup`` output,
    plus a ``phases`` list of the phases that contributed data.  When no
    matching packs are found, all numeric fields are zero and ``phases`` is
    empty.
    """
    packs_dir = target_dir.resolve() / ".agentrail" / "context" / "packs"
    total_reused = 0
    total_tokens = 0
    total_cost = 0.0
    phases: List[str] = []

    if packs_dir.exists():
        for json_file in sorted(packs_dir.glob("*.json")):
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict) or data.get("runId") != run_id:
                continue
            dedup = data.get("retrieval_dedup")
            if not isinstance(dedup, dict):
                continue
            total_reused += int(dedup.get("items_reused") or 0)
            total_tokens += int(dedup.get("tokens_avoided") or 0)
            total_cost += float(dedup.get("cost_avoided_usd") or 0.0)
            phase = (data.get("target") or {}).get("phase")
            if phase:
                phases.append(str(phase))

    return {
        "run_id": run_id,
        "items_reused": total_reused,
        "tokens_avoided": total_tokens,
        "cost_avoided_usd": total_cost,
        "model": model,
        "estimate": PRICE_TABLE.get(model) is None,
        "phases": phases,
    }
