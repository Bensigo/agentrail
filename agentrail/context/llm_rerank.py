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
network seam (monkeypatch it in tests).  That seam rides the AUTHENTICATED
Claude Code CLI harness — a headless ``claude -p`` call, the SAME agent path a
run phase uses (agentrail/run/pipeline.py, agentrail/afk/review_engine.py) —
NOT a raw ``anthropic.Anthropic()`` + ``ANTHROPIC_API_KEY``.  AgentRail *is* the
CLI harness, so a utility LLM call must route through the agent, never hard-gate
on a missing key (see the "harness model calls ride Claude Code" convention).
The stage is fail-open: when the headless model path is unavailable (no
``claude`` on PATH) or the call errors, it returns the deterministic order plus
a ``fallback`` reason — the pipeline never crashes and never loses candidates.

Raw token usage per response is aggregated into the returned ``llm`` block
(model/calls/inputTokens/outputTokens plus cache fields) as the metering seam
for PR 3; :func:`llm_rerank_cost_usd` prices that block via the canonical
``cost_for`` in agentrail/context/pricing.py (agentrail/run/pricing.py is a
derived view, not the source of truth).  The headless ``claude -p
--output-format json`` envelope carries a real ``usage`` block, so metering is
honest; a call whose envelope cannot be parsed records zero usage (never a
fabricated number) while :func:`parse_window_order` still recovers the order.
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

# The headless agent binary the rerank shells out to (the SAME CLI a run phase
# invokes — DEFAULT_COMMANDS["claude"] is "claude -p …").  Overridable so a
# non-default install / a stub can be pointed at, mirroring
# ``resolve_llm_rerank_model``'s env override.
LLM_RERANK_CLI_ENV = "AGENTRAIL_CONTEXT_LLM_RERANK_CLI"
_LLM_RERANK_DEFAULT_CLI = "claude"

# Per-call wall-clock cap (seconds): a hung headless agent must never stall
# retrieval.  A timeout raises ``subprocess.TimeoutExpired``, which llm_rerank's
# fail-open branch catches and records as ``api_error:TimeoutExpired``.
_CALL_TIMEOUT_SECONDS = 60

# Window geometry: 10-wide windows sliding back-to-front with 5 overlap.  The
# overlap is what lets a candidate promoted to the top of window k re-compete
# in window k-1; without it the merge would be a fixed partition.
_WINDOW_SIZE = 10
_WINDOW_OVERLAP = 5

# Prompt snippet bound: enough to identify a candidate, small enough that a
# full window stays a cheap single call.
_SNIPPET_MAX_CHARS = 240


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


def resolve_llm_rerank_cli() -> str:
    """The headless agent binary, overridable via AGENTRAIL_CONTEXT_LLM_RERANK_CLI."""
    raw = (os.environ.get(LLM_RERANK_CLI_ENV) or "").strip()
    return raw or _LLM_RERANK_DEFAULT_CLI


def llm_rerank_model_path_available() -> bool:
    """True when the headless ``claude -p`` path is resolvable (the gate condition).

    Replaces the old ``ANTHROPIC_API_KEY`` gate: the rerank rides the
    authenticated CLI harness, so "is the model path available" means the agent
    binary is on ``PATH`` — not that a raw API key is exported.  When it is
    missing the stage fails open to the deterministic order.
    """
    import shutil

    return shutil.which(resolve_llm_rerank_cli()) is not None


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


def _parse_cli_response(stdout: str) -> Tuple[str, Dict[str, int]]:
    """``claude -p --output-format json`` stdout -> ``(text, usage)`` (pure, defensive).

    The CLI's JSON envelope carries the assistant text in ``result`` and the
    token counters in ``usage``; those are mapped to the same keys the metering
    seam already aggregates.  A body that is NOT the expected envelope (older
    CLI, an error banner, a bare array) degrades to the raw stdout as the text
    with ZERO usage — so :func:`parse_window_order` can still recover the
    permutation and the cost stays honest (never fabricated).
    """
    zero = {"inputTokens": 0, "outputTokens": 0, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0}
    try:
        envelope = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return stdout, zero
    if not isinstance(envelope, dict):
        return stdout, zero
    result = envelope.get("result")
    text = result if isinstance(result, str) else stdout
    raw_usage = envelope.get("usage")
    if not isinstance(raw_usage, dict):
        return text, zero
    return text, {
        "inputTokens": int(raw_usage.get("input_tokens", 0) or 0),
        "outputTokens": int(raw_usage.get("output_tokens", 0) or 0),
        "cacheCreationInputTokens": int(raw_usage.get("cache_creation_input_tokens", 0) or 0),
        "cacheReadInputTokens": int(raw_usage.get("cache_read_input_tokens", 0) or 0),
    }


def _call_model(model: str, prompt: str) -> Tuple[str, Dict[str, int]]:
    """The ONE network seam: one headless ``claude -p`` call (monkeypatch in tests).

    Rides the authenticated Claude Code CLI harness — the SAME headless path a
    run phase drives (``claude -p`` with the prompt on stdin and the agent-session
    env stripped via :func:`agentrail.run.proc.sanitized_env`, mirroring
    ``_run_headless`` in agentrail/cli/commands/issue.py).  There is NO
    ``anthropic`` SDK import and NO ``ANTHROPIC_API_KEY`` dependency: the
    installed agent owns authentication.  ``--output-format json`` makes stdout a
    result envelope whose ``result`` is the assistant text and whose ``usage``
    carries the token counters verbatim (the metering input).

    Returns ``(response_text, raw_usage)``.  A non-zero exit raises so
    llm_rerank's fail-open branch records it (``api_error:*``) and the
    deterministic order stands.  Never log the prompt — candidate content may
    carry material the index redaction layer (agentrail/context/redaction.py)
    exists to keep out of logs.
    """
    import subprocess

    from agentrail.run.proc import sanitized_env

    argv = [
        resolve_llm_rerank_cli(),
        "-p",
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
        "--model",
        model,
    ]
    completed = subprocess.run(
        argv,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=_CALL_TIMEOUT_SECONDS,
        env=sanitized_env(),
    )
    if completed.returncode != 0:
        # A real failure (bad model, auth, CLI error). Raise so the fail-open
        # branch surfaces it and the deterministic order is kept — never fabricate
        # a reorder from a failed call.
        raise RuntimeError(f"headless rerank call exited {completed.returncode}")
    return _parse_cli_response(completed.stdout or "")


def llm_rerank(
    candidates: List[Dict[str, Any]],
    *,
    query: str,
    call_model: Optional[Callable[[str, str], Tuple[str, Dict[str, int]]]] = None,
) -> Dict[str, Any]:
    """Reorder the deterministic rerank's KEPT list with listwise model calls.

    Membership is untouched by contract: the result's ``ordered`` list is
    always a permutation of ``candidates``.  Fail-open: an unavailable headless
    model path (no ``claude`` on ``PATH``) or any call error returns the input
    order with a ``fallback`` reason (partial usage is still reported so PR 3 can
    meter aborted attempts).
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
    if not llm_rerank_model_path_available():
        result["fallback"] = "missing_model_path"
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
