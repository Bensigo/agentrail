"""LLM listwise rerank — a cheap model reorders the deterministic rerank's kept list (issue #1044).

The deterministic code-aware rerank (rerank.py, issue #904) decides KEEP/REJECT
membership from lexical/graph signals, but its ordering still lets
"graph expansion; BM25 keyword match" doc/spec/template noise sit above the
defining source inside the kept list — mean precision_at_budget is 0.325 while
recall@10 is 1.0, so the wins left are ORDERING wins.  This stage asks a CHEAP
model tier (Haiku, the Critic's tier — see agentrail/run/critic.py) to order
the kept candidates listwise; it NEVER changes membership, so recall cannot
regress (the joint target is precision >=0.7 AT recall >=0.85, never traded).

Default OFF behind ``AGENTRAIL_CONTEXT_LLM_RERANK`` so the deterministic
baseline stays measurable and flag-OFF behavior is byte-identical to today.

Listwise scheme: sliding windows of :data:`_WINDOW_SIZE` candidates walked
back-to-front with :data:`_WINDOW_OVERLAP` overlap (RankGPT-style), so a
strong candidate near the bottom can bubble up across windows into the top of
the global order.  Each window is a permutation-only step: ids the model omits
keep their prior relative order at the window's end, ids it invents are
ignored, malformed output leaves the window in its deterministic order — a
candidate can NEVER be dropped by this stage.

This is a **deep, pure module** split: the window/prompt/parse/merge functions
are pure and unit-testable offline; :func:`_call_model` is the ONE thin
network seam (monkeypatch it in tests).  The stage is fail-open: a missing
``ANTHROPIC_API_KEY`` or any API error returns the deterministic order plus a
``fallback`` reason — the pipeline never crashes and never loses candidates.

Raw token usage per response is aggregated into the returned ``llm`` block
(model/calls/inputTokens/outputTokens plus cache fields) as the metering seam
for PR 3; :func:`llm_rerank_cost_usd` prices that block via the canonical
``cost_for`` in agentrail/context/pricing.py (agentrail/run/pricing.py is a
derived view, not the source of truth).
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

_LLM_RERANK_TRUTHY = {"1", "true", "on", "yes"}

# Cheap model tier, pinned like CRITIC_DEFAULT_MODEL (agentrail/run/critic.py):
# listwise ordering is a fast classification-shaped task, not a reasoning task.
LLM_RERANK_DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Method suffix composed onto the deterministic method string when the stage
# actually reorders (retrieval.py emits "deterministic_code_aware_v1+haiku_listwise_v1").
LLM_RERANK_METHOD = "haiku_listwise_v1"

# Window geometry: 10-wide windows sliding back-to-front with 5 overlap.  The
# overlap is what lets a candidate promoted to the top of window k re-compete
# in window k-1; without it the merge would be a fixed partition.
_WINDOW_SIZE = 10
_WINDOW_OVERLAP = 5

# Prompt snippet bound: enough to identify a candidate, small enough that a
# full window stays a cheap single call.
_SNIPPET_MAX_CHARS = 240
_MAX_COMPLETION_TOKENS = 512


def llm_rerank_enabled() -> bool:
    """LLM listwise rerank (issue #1044) is default-OFF; opt in via env."""
    raw = os.environ.get("AGENTRAIL_CONTEXT_LLM_RERANK")
    if raw is None:
        return False
    return raw.strip().lower() in _LLM_RERANK_TRUTHY


def resolve_llm_rerank_model() -> str:
    """The pinned cheap model, overridable via AGENTRAIL_CONTEXT_LLM_RERANK_MODEL."""
    raw = (os.environ.get("AGENTRAIL_CONTEXT_LLM_RERANK_MODEL") or "").strip()
    return raw or LLM_RERANK_DEFAULT_MODEL


def window_spans(count: int, *, window_size: int = _WINDOW_SIZE, overlap: int = _WINDOW_OVERLAP) -> List[Tuple[int, int]]:
    """Back-to-front sliding ``(start, end)`` spans over ``count`` positions (pure).

    The LAST span is always ``(0, window_size)`` so the final model call decides
    the head of the global order after lower candidates have bubbled up.
    """
    if count <= 0:
        return []
    if count <= window_size:
        return [(0, count)]
    stride = max(1, window_size - overlap)
    spans: List[Tuple[int, int]] = []
    end = count
    while True:
        start = max(0, end - window_size)
        if start == 0:
            # Widen the final span to a full window so the head of the global
            # order is always decided against window_size competitors.
            spans.append((0, min(window_size, count)))
            return spans
        spans.append((start, end))
        end -= stride


def build_window_prompt(query: str, window: Sequence[Tuple[str, Dict[str, Any]]]) -> str:
    """Compact listwise prompt for one window of ``(candidate_id, candidate)`` (pure)."""
    lines = [
        "Rank retrieved code-context candidates for the task below, most useful first.",
        "Prefer sources that DEFINE the symbols/behavior the task needs; demote docs,",
        "specs, templates, and files that merely repeat the task's keywords.",
        "",
        f"Task: {query}",
        "",
        "Candidates:",
    ]
    for candidate_id, item in window:
        symbols = item.get("symbolHints") or []
        symbol = item.get("symbol")
        names = [s for s in ([symbol] if symbol else []) + list(symbols) if s]
        content = item.get("content")
        snippet = " ".join(str(content).split())[:_SNIPPET_MAX_CHARS] if isinstance(content, str) else ""
        lines.append(
            f"[{candidate_id}] path={item.get('path')} type={item.get('sourceType')}"
            + (f" symbols={','.join(dict.fromkeys(names))}" if names else "")
        )
        if snippet:
            lines.append(f"  snippet: {snippet}")
    lines += [
        "",
        "Reply with ONLY a JSON array of the candidate ids, best first, e.g.",
        '["c2","c5","c1"]. Include every id exactly once; no other text.',
    ]
    return "\n".join(lines)


def parse_window_order(text: str, window_ids: Sequence[str]) -> List[str]:
    """Model output -> permutation of ``window_ids`` (pure, defensive).

    Guarantees: the result is ALWAYS a permutation of ``window_ids`` — invented
    ids are dropped, duplicates keep their first occurrence, omitted ids are
    appended in their prior relative order, and malformed output degrades to
    the prior (deterministic) order.  This is the recall-protection contract:
    the LLM can reorder, never remove.
    """
    prior = list(window_ids)
    parsed: Optional[Any] = None
    raw = (text or "").strip()
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        start, end = raw.find("["), raw.rfind("]")
        if 0 <= start < end:
            try:
                parsed = json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                parsed = None
    if not isinstance(parsed, list):
        return prior
    valid = set(prior)
    ordered: List[str] = []
    seen: set = set()
    for value in parsed:
        candidate_id = str(value)
        if candidate_id in valid and candidate_id not in seen:
            ordered.append(candidate_id)
            seen.add(candidate_id)
    ordered.extend(cid for cid in prior if cid not in seen)
    return ordered


def llm_rerank_cost_usd(llm: Dict[str, Any]) -> float:
    """Price an ``llm`` usage block (from :func:`llm_rerank`) in USD (pure).

    Routes through the canonical ``cost_for`` (agentrail/context/pricing.py) so
    the rerank layer's dollar math shares the single price table with every
    other component.  Missing counters default to 0, so a fallback block with
    partial (or zero) usage prices cleanly.  No network, no logging.
    """
    from agentrail.context.pricing import cost_for

    return float(
        cost_for(
            str(llm.get("model", "")),
            input_tokens=int(llm.get("inputTokens", 0) or 0),
            output_tokens=int(llm.get("outputTokens", 0) or 0),
            cached_read=int(llm.get("cacheReadInputTokens", 0) or 0),
            cached_write=int(llm.get("cacheCreationInputTokens", 0) or 0),
        )["dollars"]
    )


def _call_model(model: str, prompt: str) -> Tuple[str, Dict[str, int]]:
    """The ONE network seam: a single Messages API call (monkeypatch in tests).

    Returns ``(response_text, raw_usage)`` where ``raw_usage`` carries the
    response's token counters verbatim (the PR 3 metering input). Never log the
    prompt — candidate content may carry material the index redaction layer
    (agentrail/context/redaction.py) exists to keep out of logs.
    """
    import anthropic

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=model,
        max_tokens=_MAX_COMPLETION_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")
    usage = getattr(response, "usage", None)
    return text, {
        "inputTokens": int(getattr(usage, "input_tokens", 0) or 0),
        "outputTokens": int(getattr(usage, "output_tokens", 0) or 0),
        "cacheCreationInputTokens": int(getattr(usage, "cache_creation_input_tokens", 0) or 0),
        "cacheReadInputTokens": int(getattr(usage, "cache_read_input_tokens", 0) or 0),
    }


def llm_rerank(
    candidates: List[Dict[str, Any]],
    *,
    query: str,
    call_model: Optional[Callable[[str, str], Tuple[str, Dict[str, int]]]] = None,
) -> Dict[str, Any]:
    """Reorder the deterministic rerank's KEPT list with listwise model calls.

    Membership is untouched by contract: the result's ``ordered`` list is
    always a permutation of ``candidates``.  Fail-open: no API key or any API
    error returns the input order with a ``fallback`` reason (partial usage is
    still reported so PR 3 can meter aborted attempts).
    """
    call = call_model or _call_model
    model = resolve_llm_rerank_model()
    llm_meta: Dict[str, Any] = {
        "model": model,
        "calls": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
    }
    result: Dict[str, Any] = {"ordered": list(candidates), "changed": False, "fallback": None, "llm": llm_meta}
    if len(candidates) < 2:
        return result
    if not (os.environ.get("ANTHROPIC_API_KEY") or "").strip():
        result["fallback"] = "missing_api_key"
        return result
    # Ids are positional in the DETERMINISTIC order and stay attached to their
    # candidate across windows, so merges reorder references, never copies.
    ids = [f"c{position}" for position in range(1, len(candidates) + 1)]
    by_id = dict(zip(ids, candidates))
    order = list(ids)
    try:
        for start, end in window_spans(len(order)):
            window_ids = order[start:end]
            prompt = build_window_prompt(query, [(cid, by_id[cid]) for cid in window_ids])
            text, usage = call(model, prompt)
            llm_meta["calls"] += 1
            for key in ("inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"):
                llm_meta[key] += int((usage or {}).get(key, 0) or 0)
            order[start:end] = parse_window_order(text, window_ids)
    except Exception as exc:  # fail-open: API/timeout/SDK errors never break retrieval
        result["fallback"] = f"api_error:{type(exc).__name__}"
        return result
    result["ordered"] = [by_id[cid] for cid in order]
    result["changed"] = order != ids
    return result
