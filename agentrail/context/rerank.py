"""Deterministic, code-aware RERANK stage for the Context Compiler (issue #904).

The hybrid retriever (``query_context``) score-sorts candidates by a fused
lexical/semantic/authority signal, but that ordering rewards *keyword density*
— so a test file or a fixture JSON that merely repeats the task's words can
outrank the actual source file that *defines* the queried symbols.

This module adds the proven retrieve-wide -> rerank -> keep-top-K stage between
hybrid retrieval and the token-budget fill.  It re-scores a *wider* candidate
set against the task using ONLY deterministic, code-aware signals and reorders
them before the budget keeps the top-K that fit:

  * symbol-name overlap  — does the candidate DEFINE (symbolHints / file stem)
    an identifier the task anchors on?  This is the strongest relevance signal
    for a code task and it is fully deterministic (it reads the index's
    tree-sitter ``symbolHints`` and the candidate path, never an LLM).
  * code-graph distance  — how far is the candidate from the task's anchor
    nodes in the deterministic Code Graph (0 = the anchor itself, larger =
    farther).  Closer is more relevant.  Uses ONLY the deterministic graph
    (BFS depth), never Graph Enrichment / inferred edges.
  * freshness            — current sources rank above stale/expired ones.

Authority ordering (CONTEXT.md): every signal here is deterministic evidence
(code symbols, the deterministic Code Graph, git/observed freshness).  No
enrichment or inferred signal is used, so nothing here can let a low-authority
inferred hint outrank deterministic code, tests, docs, ownership, or run
evidence.  Deterministic source files outrank keyword-noise (tests-as-noise,
fixtures, scripts) when a real source is available.

The stage is deterministic and toggleable (see ``rerank_enabled``) so the
pre-rerank baseline remains measurable for the #901 evaluation harness.
"""
from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple


# Per-position step for the first-stage retrieval prior.  The rerank base
# preserves the retriever's full ordering (lexical relevance + deterministic
# evidence already fused in ``query_context``) as a gently-decaying prior, so a
# candidate the retriever ranked highly stays competitive — while the code-aware
# signals below (symbolOverlap up to +4.5, graphDistance up to +2) can still
# promote a lower-ranked but more relevant candidate over the prior gap.
_RANK_PRIOR_STEP = 0.1

# Source types that represent primary, answer-bearing code/docs.  When at least
# one of these is present and symbol-relevant, keyword-noise file types (tests,
# fixtures, scripts) that do NOT define a queried symbol are demoted/rejected.
_PRIMARY_SOURCE_TYPES = {"code", "context_doc", "taste_doc", "agent_doc", "prd", "milestone"}

_RERANK_METHOD = "deterministic_code_aware_v1"

# File extensions that count as source CODE for the path-stem symbol signal.
# A code file named after the symbol it defines is relevant; a doc/memory note
# (.md) named after the task topic is keyword echo, not symbol evidence — even
# when the indexer tags it sourceType=code.
_CODE_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".rb", ".java",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".swift", ".kt",
    ".scala", ".sh", ".mjs", ".cjs",
}


def rerank_enabled() -> bool:
    """Whether the deterministic rerank stage runs.

    Defaults to ON.  Set ``AGENTRAIL_CONTEXT_RERANK=0`` (or ``false``/``off``)
    to fall back to pure score-sorted pass-through — used to measure the
    pre-rerank baseline for the #901 precision-at-budget harness.
    """
    raw = os.environ.get("AGENTRAIL_CONTEXT_RERANK")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _tokenize(text: str) -> Set[str]:
    return {tok for tok in re.split(r"[^a-z0-9_]+", text.lower()) if tok}


def _query_symbols(query: str) -> Set[str]:
    """Identifier-like tokens from the query that a candidate could DEFINE.

    Mirrors the symbol normalization in ``query_context`` (strip edge
    punctuation, keep dotted-member tails) so the overlap signal lines up with
    how the retriever tokenizes symbols.  Single-character tokens are dropped —
    they are too generic to be a meaningful symbol-overlap signal.
    """
    symbols: Set[str] = set()
    for token in re.split(r"\s+", query.strip().lower()):
        stripped = re.sub(r"^[^a-z0-9_]+|[^a-z0-9_]+$", "", token)
        if len(stripped) > 1:
            symbols.add(stripped)
        if "." in token:
            tail = token.rsplit(".", 1)[-1]
            tail = re.sub(r"[^a-z0-9_]+", "", tail)
            if len(tail) > 1:
                symbols.add(tail)
    return symbols


def _anchor_symbols(anchors: Optional[List[Dict[str, Any]]]) -> Set[str]:
    """Lower-cased symbol/test anchor names extracted deterministically."""
    values: Set[str] = set()
    for anchor in anchors or []:
        if not isinstance(anchor, dict):
            continue
        if anchor.get("kind") in {"symbol", "test"}:
            value = str(anchor.get("value") or "").strip().removesuffix("()").lower()
            if len(value) > 1:
                values.add(value)
    return values


def _path_stem(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[0].lower()


def _path_stem_tokens(path: str) -> Set[str]:
    return _tokenize(_path_stem(path))


def _is_noise_file_type(item: Dict[str, Any]) -> bool:
    """Heuristic, deterministic classification of keyword-noise file types.

    Tests, evaluation/retrieval fixtures, and scripts frequently repeat a
    task's vocabulary verbatim without being the answer.  They are *demoted*
    relative to a primary source — never below a deterministic-evidence
    threshold that would violate authority ordering.
    """
    path = str(item.get("path") or "").lower()
    if "/tests/" in path or path.startswith("tests/") or "/test_" in path or path.endswith("_test.py"):
        return True
    if path.endswith("-fixtures.json") or "fixtures/" in path:
        return True
    if path.startswith("scripts/") or "/scripts/" in path:
        return True
    return False


def _freshness_status(item: Dict[str, Any]) -> str:
    freshness = item.get("freshness")
    if isinstance(freshness, dict):
        return str(freshness.get("status") or "unknown")
    if isinstance(freshness, str):
        return freshness
    return "unknown"


def _freshness_signal(item: Dict[str, Any]) -> float:
    return {
        "current": 1.0,
        "unknown": 0.0,
        "stale": -1.0,
        "expired": -2.0,
    }.get(_freshness_status(item), 0.0)


def _symbol_overlap_signal(item: Dict[str, Any], target_symbols: Set[str]) -> Tuple[float, bool]:
    """Deterministic symbol-name overlap between the task and a candidate.

    Returns ``(signal, defines_anchor)``.  A candidate that DEFINES a queried
    symbol (via the index's tree-sitter ``symbolHints``) gets the strongest
    overlap reward; a path-stem match (the file is named after the symbol) is a
    weaker but still deterministic signal.
    """
    if not target_symbols:
        return 0.0, False
    hints = {str(h).strip().lower() for h in (item.get("symbolHints") or []) if str(h).strip()}
    defines = bool(hints & target_symbols)
    # Path-stem match is only a meaningful symbol signal for a CODE file: a
    # source file named after the symbol it defines is relevant, but a doc/memory
    # note named after the task topic (e.g. ``refund-drift-0.md`` for "refund
    # drift") is just keyword echo and must not be treated as symbol evidence.
    # Gate on the file extension — the indexer can tag .md notes sourceType=code.
    stem_match = False
    path = str(item.get("path") or "")
    extension = ("." + path.rsplit(".", 1)[-1].lower()) if "." in path.rsplit("/", 1)[-1] else ""
    if extension in _CODE_EXTENSIONS:
        stem_tokens = _path_stem_tokens(path)
        stem_match = bool(stem_tokens & target_symbols)
    signal = 0.0
    if defines:
        signal += 3.0
    if stem_match:
        signal += 1.5
    return signal, defines


def _graph_distance_signal(item: Dict[str, Any], distance_by_path: Dict[str, int]) -> float:
    """Closeness to a task anchor in the deterministic Code Graph.

    ``distance_by_path`` maps a candidate path to its BFS depth from the
    anchor nodes (0 = the anchor itself).  Unmapped candidates contribute 0
    (no deterministic graph evidence => no boost, never a penalty).
    """
    path = str(item.get("path") or "")
    if path not in distance_by_path:
        return 0.0
    depth = distance_by_path[path]
    # depth 0 -> +2.0, depth 1 -> +1.0, depth 2 -> ~+0.66, ...
    return 2.0 / (depth + 1)


def _candidate_key(item: Dict[str, Any]) -> str:
    for field in ("chunkId", "sourceId", "citation", "path"):
        value = item.get(field)
        if value:
            return str(value)
    return "candidate:unknown"


def rerank_candidates(
    candidates: List[Dict[str, Any]],
    *,
    query: str,
    top_k: int,
    anchors: Optional[List[Dict[str, Any]]] = None,
    distance_by_path: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """Re-score *candidates* with deterministic code-aware signals.

    Input is the WIDER candidate set already retrieved+score-sorted by
    ``query_context``.  Output keeps the top-K most relevant (by rerank score)
    and rejects the rest, each with a reason.

    Returns a dict:
      ``method``    — the rerank method id.
      ``ranked``    — kept candidates, in rerank order, each annotated with a
                       ``rerank`` block (score + component signals + reason).
      ``rejected``  — dropped candidates, each annotated with a ``rerank``
                       block whose ``reason`` explains why it was rejected.
      ``changed``   — True if the kept order/membership differs from input.
    """
    target_symbols = _query_symbols(query) | _anchor_symbols(anchors)
    distance_by_path = distance_by_path or {}

    # Does the candidate set contain a primary source that is symbol-relevant?
    # Only then do we demote keyword-noise file types — otherwise a tests-only
    # result set would be wrongly gutted.
    has_relevant_primary = any(
        str(c.get("sourceType") or "") in _PRIMARY_SOURCE_TYPES
        and not _is_noise_file_type(c)
        and _symbol_overlap_signal(c, target_symbols)[1]
        for c in candidates
    )

    candidate_count = len(candidates)
    scored: List[Tuple[float, int, Dict[str, Any], Dict[str, Any]]] = []
    for index, item in enumerate(candidates):
        symbol_signal, defines_anchor = _symbol_overlap_signal(item, target_symbols)
        graph_signal = _graph_distance_signal(item, distance_by_path)
        freshness_signal = _freshness_signal(item)
        # First-stage retrieval prior: preserve the retriever's order as a
        # gently-decaying base so code-aware signals refine, not replace, it.
        rank_prior = (candidate_count - index) * _RANK_PRIOR_STEP

        noise = _is_noise_file_type(item)
        # A candidate is REJECTABLE keyword-noise only when it is a noise file
        # type (test/fixture/script) that neither defines a queried symbol nor
        # has any symbol overlap, AND a relevant primary source exists in the
        # set.  This drops keyword-echo noise (the precision win) while never
        # dropping legitimate code candidates such as callers or lesson-targeted
        # sources (which carry deterministic evidence and must be kept).
        noise_penalty = 0.0
        is_droppable_noise = bool(noise and has_relevant_primary and not defines_anchor and symbol_signal == 0)
        if is_droppable_noise:
            noise_penalty = 4.0

        rerank_score = rank_prior + symbol_signal + graph_signal + freshness_signal - noise_penalty

        block = {
            "score": round(rerank_score, 6),
            "signals": {
                "retrievalPrior": round(rank_prior, 6),
                "symbolOverlap": round(symbol_signal, 6),
                "graphDistance": round(graph_signal, 6),
                "freshness": round(freshness_signal, 6),
                "noisePenalty": round(noise_penalty, 6),
            },
            "definesAnchorSymbol": defines_anchor,
            "droppableNoise": is_droppable_noise,
        }
        scored.append((rerank_score, index, dict(item), block))

    # Deterministic order: rerank score desc, then original retrieval rank asc
    # (stable tie-break preserving the retriever's lexical/authority signal).
    scored.sort(key=lambda entry: (-entry[0], entry[1]))

    ranked: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []

    # Keep a candidate when it is inside the reranked top-K AND is not droppable
    # keyword-noise.  Reject when it falls outside top-K (the budget cut) or is
    # keyword-echo noise demoted out of the kept set.  Legitimate code evidence
    # (callers, lesson-targeted sources, definitions) is never dropped — only
    # reordered — so authority-ordered deterministic evidence is preserved.
    kept_position = 0
    for (rerank_score, _orig_index, item, block) in scored:
        is_noise = bool(block.get("droppableNoise"))
        if kept_position < top_k and not is_noise:
            kept_position += 1
            kept_block = dict(block)
            kept_reasons = ["kept by rerank"]
            if block["definesAnchorSymbol"]:
                kept_reasons.append("defines a task-anchor symbol")
            if block["signals"]["graphDistance"] > 0:
                kept_reasons.append("close to task anchor in the code graph")
            kept_block["reason"] = "; ".join(kept_reasons)
            item["rerank"] = kept_block
            ranked.append(item)
        else:
            rejected_block = dict(block)
            if is_noise:
                reason = "rejected: keyword-noise file (test/fixture/script) that does not define or overlap a task symbol"
            else:
                reason = "rejected: outside reranked top-K under budget"
            detail = "; ".join(
                r for r in [
                    "no task-symbol overlap" if block["signals"]["symbolOverlap"] == 0 else None,
                    "stale/expired source" if block["signals"]["freshness"] < 0 else None,
                ] if r
            )
            rejected_block["reason"] = f"{reason}{(' (' + detail + ')') if detail and not is_noise else ''}"
            item["rerank"] = rejected_block
            rejected.append(item)

    input_order = [_candidate_key(c) for c in candidates[:top_k]]
    output_order = [_candidate_key(c) for c in ranked]
    changed = input_order != output_order

    return {
        "method": _RERANK_METHOD,
        "ranked": ranked,
        "rejected": rejected,
        "changed": changed,
    }
