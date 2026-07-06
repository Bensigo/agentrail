from __future__ import annotations

import json
import os
import re
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from agentrail.context.compiler import compiler_contract
from agentrail.context.dedup import compute_retrieval_dedup
from agentrail.context.index import append_audit, load_index
from agentrail.context.llm_rerank import llm_rerank_cost_usd
from agentrail.context.memory_lane import build_memory_lane, frame_untrusted_memory
from agentrail.context.pack_quality import compute_pack_quality
from agentrail.context.pricing import cost_for
from agentrail.context.retrieval import RETRIEVAL_MAX_TOKENS, compute_tokens_saved, estimate_tokens, get_file_lines, query_context
from agentrail.shared.json import write_json


PACK_SECTION_KEYS = [
    # --- stable cache-eligible prefix (same across repeated calls) ---
    "requiredContext",    # CONTEXT.md, TASTE.md — never changes mid-run
    "availableSkills",   # local skill blocks — stable per project
    "availableTools",    # agentrail tool list — stable per install
    # --- dynamic / per-task retrieval results ---
    "likelyFiles",
    "likelyDocs",
    "relevantMemory",
    "memoryLane",
    "priorMistakes",
    "activeState",
    "goals",
    # --- metadata / excluded ---
    "excludedContext",
    "openQuestions",
]

SECTION_TITLES = {
    "requiredContext": "Required Context",
    "likelyFiles": "Likely Files",
    "likelyDocs": "Likely Docs",
    "relevantMemory": "Relevant Memory",
    # Factory read half of shared memory (#1039): typed, attributed, untrusted
    # advisory memory_items — distinct from relevantMemory (markdown files).
    "memoryLane": "Memory Lane",
    "priorMistakes": "Prior Mistakes",
    "activeState": "Active State",
    "availableTools": "Available Tools",
    "availableSkills": "Available Skills",
    "goals": "Goals",
    "excludedContext": "Excluded Context",
    "openQuestions": "Open Questions",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _relative(root: Path, path: Path) -> str:
    return str(path.relative_to(root)).replace("/", "/")


def _pack_slug(value: str) -> str:
    return value.replace("-", "").replace(":", "").replace(".", "")


def _target_label(target_kind: str, target_number: int) -> str:
    return f"{'PR' if target_kind == 'pr' else 'issue'} #{target_number}"


def _query_for(target_kind: str, target_number: int, phase: str) -> str:
    label = _target_label(target_kind, target_number)
    return f"{label} {phase} context pack required context likely files docs memory prior mistakes active state tools skills excluded context open questions"


def _citation_for(item: Dict[str, Any]) -> str:
    return str(item.get("citation") or item.get("path") or ".agentrail/context/index/index.json")


_SYMBOL_PACKING_TRUTHY = {"1", "true", "on", "yes"}


def symbol_packing_enabled() -> bool:
    """Symbol-range packing (issue #1044 AC4) is default-OFF; opt in via env."""
    raw = os.environ.get("AGENTRAIL_CONTEXT_SYMBOL_PACKING")
    if raw is None:
        return False
    return raw.strip().lower() in _SYMBOL_PACKING_TRUTHY


def _apply_symbol_packing(root: Path, index: Dict[str, Any], items: List[Dict[str, Any]]) -> int:
    """Replace each symbol-bearing code candidate's content with the symbol's
    exact line range from the index symbol table.

    Never changes a candidate's path and never drops a candidate — item
    selection stays identical to the flag-OFF pack, so precision/recall
    semantics are untouched; packing only shrinks the tokens per candidate.
    Returns the number of candidates packed.
    """
    symbol_table = index.get("symbolTable") or {}
    packed = 0
    for item in items:
        if not isinstance(item, dict) or item.get("sourceType") != "code":
            continue
        symbol = item.get("symbol")
        path = item.get("path")
        if not isinstance(symbol, str) or not symbol or not isinstance(path, str) or not path:
            continue
        record = next(
            (
                rec
                for rec in symbol_table.get(symbol, [])
                if isinstance(rec, dict) and rec.get("path") == path and rec.get("authority") != "denied"
            ),
            None,
        )
        if record is None:
            continue
        try:
            line_start = int(record.get("lineStart", 1))
            line_end = int(record.get("lineEnd", line_start))
            snippet = get_file_lines(root, path, line_start, line_end)
        except (SystemExit, TypeError, ValueError):
            continue
        content = snippet["content"]
        if not content:
            continue
        item["content"] = content
        item["lineStart"] = snippet["lineStart"]
        item["lineEnd"] = snippet["lineEnd"]
        item["citation"] = f"{path}#{symbol}"
        item["tokenEstimate"] = estimate_tokens(content)
        packed += 1
    return packed


def _reason_for(item: Dict[str, Any], fallback: str) -> str:
    return str(item.get("reason") or fallback)


def _prior_mistake_excerpt(item: Dict[str, Any]) -> str:
    content = item.get("content")
    if isinstance(content, str) and content.strip():
        compact = re.sub(r"\s+", " ", content).strip()
        return compact[:260].rstrip() if len(compact) > 260 else compact
    return _reason_for(item, "Prior mistake matched this task.")


def _normalized_item(item: Dict[str, Any], kind: str, fallback_reason: str) -> Dict[str, Any]:
    value = dict(item)
    value["kind"] = kind
    value["reason"] = _reason_for(value, fallback_reason)
    value["citation"] = _citation_for(value)
    if kind == "priorMistakes":
        prior_mistake = value.get("priorMistake")
        prior_fields = prior_mistake if isinstance(prior_mistake, dict) else {}
        value["source"] = prior_fields.get("source") or value.get("path") or "prior mistake"
        value["whyItMatters"] = prior_fields.get("whyItMatters") or _prior_mistake_excerpt(value)
        value["preventionGuidance"] = prior_fields.get("preventionGuidance") or "Review this prior mistake before repeating the same workflow."
    return value


def _bounded_content(content: Any) -> Any:
    """Return content without truncation.

    Budget is enforced by dropping entire low-relevance candidates via
    _greedy_token_budget_fill, not by mutilating high-value item content.
    """
    return content


def _section_for(item: Dict[str, Any]) -> str:
    source_type = str(item.get("sourceType") or "")
    path = str(item.get("path") or "")
    if item.get("priorMistake"):
        return "priorMistakes"
    if source_type in {"context_doc", "taste_doc"}:
        return "requiredContext"
    if source_type == "code":
        return "likelyFiles"
    if source_type in {"agent_doc", "prd", "milestone", "external_descriptor"}:
        return "likelyDocs"
    if source_type == "memory":
        return "relevantMemory"
    if source_type == "run_artifact":
        lowered = path.lower()
        if any(marker in lowered for marker in ("finding", "failure", "blocked", "review")):
            return "priorMistakes"
        return "activeState"
    if source_type == "agentrail_state":
        return "activeState"
    if source_type == "skill":
        return "availableSkills"
    return "likelyDocs"


def _append_unique(section: List[Dict[str, Any]], item: Dict[str, Any]) -> None:
    key = (item.get("path"), item.get("citation"), item.get("kind"))
    if not any((existing.get("path"), existing.get("citation"), existing.get("kind")) == key for existing in section):
        section.append(item)


def _tool_items() -> List[Dict[str, Any]]:
    return [
        {
            "kind": "available_tool",
            "sourceType": "tool",
            "path": "agentrail context build",
            "reason": "Builds issue and PR context packs from the local AgentRail context index.",
            "citation": "agentrail/cli/commands/context.py",
        },
        {
            "kind": "available_tool",
            "sourceType": "tool",
            "path": "agentrail context show",
            "reason": "Displays generated context packs for humans and agents.",
            "citation": "agentrail/cli/commands/context.py",
        },
        {
            "kind": "available_tool",
            "sourceType": "tool",
            "path": "agentrail context explain",
            "reason": "Explains generated pack inclusion, exclusion, budget, provider, and audit metadata.",
            "citation": "agentrail/cli/commands/context.py",
        },
    ]


def _record_text(source: Dict[str, Any], chunk: Dict[str, Any] | None) -> str:
    return "\n".join(
        [
            str(source.get("path", "")),
            str(source.get("sourceType", "")),
            str((chunk or {}).get("content") or source.get("content") or ""),
            str((chunk or {}).get("citation", "")),
            str((chunk or {}).get("parentContext", "")),
            json.dumps((chunk or {}).get("headingPath", [])),
            json.dumps((chunk or {}).get("symbolHints", [])),
            json.dumps((chunk or {}).get("importHints", [])),
            json.dumps((chunk or {}).get("priorMistake") or source.get("priorMistake") or {}),
            json.dumps(source.get("linkedIssues", [])),
            json.dumps(source.get("linkedPullRequests", [])),
        ]
    ).lower()


def _target_linked_items(index: Dict[str, Any], target_kind: str, target_number: int) -> List[Dict[str, Any]]:
    target_token = f"#{target_number}".lower()
    target_url = f"/{'issues' if target_kind == 'issue' else 'pull'}/{target_number}".lower()
    sources = {record["id"]: record for record in index.get("records", [])}
    items = [(sources.get(chunk.get("sourceId"), {}), chunk) for chunk in index.get("chunks", [])] if index.get("chunks") else [(record, None) for record in index.get("records", [])]
    linked_items: List[Dict[str, Any]] = []
    linked_key = "linkedIssues" if target_kind == "issue" else "linkedPullRequests"
    for source, chunk in items:
        if not source:
            continue
        text = _record_text(source, chunk)
        chunk_linked = bool(chunk) and (target_token in text or target_url in text)
        source_linked = target_number in source.get(linked_key, [])
        single = bool(chunk) and len(source.get("chunkIds", [])) == 1
        if not (chunk_linked or (single and source_linked) if chunk else source_linked):
            continue
        linked_items.append(
            {
                "kind": "indexed_context",
                "sourceType": source.get("sourceType"),
                "path": source.get("path"),
                "sourceId": source.get("id"),
                "chunkId": (chunk or {}).get("id"),
                "citation": (chunk or {}).get("citation") or source.get("path"),
                "reason": f"Included because it directly cites {_target_label(target_kind, target_number)}.",
                "contentHash": source.get("contentHash"),
                "textHash": (chunk or {}).get("textHash"),
                "headingPath": (chunk or {}).get("headingPath", []),
                "parentContext": (chunk or {}).get("parentContext") or source.get("path"),
                "matchContext": " > ".join([value for value in [source.get("path"), (chunk or {}).get("parentContext"), *((chunk or {}).get("headingPath", []))] if value]),
                "symbolHints": (chunk or {}).get("symbolHints", []),
                "importHints": (chunk or {}).get("importHints", []),
                "memory": (chunk or {}).get("memory") or source.get("memory"),
                "priorMistake": (chunk or {}).get("priorMistake") or source.get("priorMistake"),
                "authority": source.get("authority"),
                "visibility": source.get("visibility"),
                "freshness": source.get("freshness"),
                "redactions": source.get("redactions", []),
                "content": _bounded_content((chunk or {}).get("content") if chunk else source.get("content")),
                "score": {"deterministic": 1.0, "keyword": 1.0, "embedding": None, "authorityBoost": 0.0, "final": 2.0},
            }
        )
    return linked_items


def _ensure_required_sections(root: Path, sections: Dict[str, List[Dict[str, Any]]], index: Dict[str, Any]) -> None:
    existing_paths = {str(item.get("path")) for values in sections.values() for item in values}
    for record in index.get("records", []):
        path = str(record.get("path") or "")
        if path in existing_paths:
            continue
        source_type = str(record.get("sourceType") or "")
        if source_type not in {"context_doc", "taste_doc", "agentrail_state", "skill"}:
            continue
        section = _section_for(record)
        if section == "availableSkills" and len(sections[section]) >= 8:
            continue
        if section == "availableSkills":
            reason = "Included so agents can see available local skill guidance for this task."
        elif section == "activeState":
            reason = "Included so agents can inspect current AgentRail workflow and configuration state."
        else:
            reason = "Included as required local AgentRail context for visible state and quality guidance."
        _append_unique(
            sections[section],
            _normalized_item(
                {
                    "sourceType": source_type,
                    "path": path,
                    "sourceId": record.get("id"),
                    "citation": path,
                    "contentHash": record.get("contentHash"),
                    "authority": record.get("authority"),
                    "visibility": record.get("visibility"),
                    "freshness": record.get("freshness"),
                    "redactions": record.get("redactions", []),
                    "content": record.get("content"),
                },
                section,
                reason,
            ),
        )
    if not sections["availableTools"]:
        sections["availableTools"].extend(_tool_items())


def _sectioned_results(results: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    sections: Dict[str, List[Dict[str, Any]]] = {key: [] for key in PACK_SECTION_KEYS}
    for result in results:
        section = _section_for(result)
        _append_unique(sections[section], _normalized_item(result, section, f"Included in {SECTION_TITLES[section].lower()} by local context retrieval."))
    return sections


def _excluded_context(excluded: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items = []
    for item in excluded:
        items.append(_normalized_item(dict(item), "excluded_context", "Excluded by AgentRail context indexing policy."))
    return items


def _all_included(pack: Dict[str, Any]) -> List[Dict[str, Any]]:
    included: List[Dict[str, Any]] = []
    for key in PACK_SECTION_KEYS:
        if key in {"excludedContext", "openQuestions"}:
            continue
        included.extend(pack.get(key, []))
    return included


def _load_workflow_goals(root: Path) -> List[Dict[str, Any]]:
    state_path = root / ".agentrail" / "state.json"
    if not state_path.exists():
        return []
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    workflow = state.get("workflow") if isinstance(state, dict) else {}
    goals = workflow.get("goals") if isinstance(workflow, dict) else []
    if not isinstance(goals, list):
        return []
    return [goal for goal in goals if isinstance(goal, dict)]


def _goal_relevant(goal: Dict[str, Any], target_kind: str, target_number: int, phase: str) -> bool:
    status = str(goal.get("status") or "").lower()
    if phase in {"plan", "execute", "verify"} and status not in {"active", "blocked"}:
        return False
    if target_kind == "issue":
        return goal.get("activeIssue") == target_number
    if target_kind == "pr":
        return goal.get("activePullRequest") == target_number
    return False


def _relevant_goals(root: Path, target_kind: str, target_number: int, phase: str) -> List[Dict[str, Any]]:
    values: List[Dict[str, Any]] = []
    for goal in _load_workflow_goals(root):
        if not _goal_relevant(goal, target_kind, target_number, phase):
            continue
        value = dict(goal)
        value["kind"] = "goal"
        value["path"] = ".agentrail/state.json"
        value["reason"] = f"Relevant {goal.get('kind') or 'workflow'} goal for {_target_label(target_kind, target_number)} {phase}."
        value["citation"] = ".agentrail/state.json#workflow.goals"
        value["successCriteria"] = list(value.get("successCriteria") or [])
        value["nonGoals"] = list(value.get("nonGoals") or [])
        values.append(value)
    return values


def _primary_goal(target_kind: str, target_number: int, phase: str, goals: List[Dict[str, Any]]) -> Dict[str, str]:
    if goals:
        goal = goals[0]
        return {
            "summary": str(goal.get("summary") or f"Complete {_target_label(target_kind, target_number)} {phase}."),
            "citation": str(goal.get("citation") or ".agentrail/state.json#workflow.goals"),
        }
    return {"summary": f"Prepare auditable {_target_label(target_kind, target_number)} {phase} context.", "citation": f"github:{target_kind}/{target_number}"}


def _render_item(item: Dict[str, Any]) -> str:
    score = item.get("score")
    score_text = f" score={score.get('final')}" if isinstance(score, dict) and score.get("final") is not None else ""
    return f"- `{item.get('path')}`: {item.get('reason')} Citation: {item.get('citation')}.{score_text}"


# ---------------------------------------------------------------------------
# Budget trimming helpers
# ---------------------------------------------------------------------------

_RETRIEVAL_SECTION_KEYS = [
    "likelyFiles",
    "likelyDocs",
    "relevantMemory",
    "priorMistakes",
    "activeState",
]

_DEFAULT_BUDGET_MODEL = "claude-sonnet-4-6"


def _item_tokens(item: Dict[str, Any]) -> int:
    content = item.get("content")
    if isinstance(content, str):
        return estimate_tokens(content)
    return 0


def _pack_input_tokens(sections: Dict[str, List[Dict[str, Any]]]) -> int:
    return sum(_item_tokens(item) for items in sections.values() for item in items)


def _score_final(item: Dict[str, Any]) -> float:
    score = item.get("score")
    if isinstance(score, dict):
        val = score.get("final")
        if isinstance(val, (int, float)):
            return float(val)
    return float("inf")


def _trim_to_budget(
    sections: Dict[str, List[Dict[str, Any]]],
    budget_usd: float,
    model: str,
) -> Dict[str, Any]:
    """Drop lowest-value items until the pack's input-token cost ≤ budget_usd.

    Drop order: excludedContext, openQuestions, then retrieval items ascending
    by score.final.  requiredContext, availableTools, availableSkills, and goals
    are never dropped.

    Returns a dict with budgetUsd, packCostUsd, and itemsDropped.
    """
    total_tokens = _pack_input_tokens(sections)
    result = cost_for(model, input_tokens=total_tokens)

    if result["estimate"]:
        warnings.warn(
            f"Unknown model '{model}': cannot price context pack for --budget-usd; skipping trim.",
            stacklevel=4,
        )
        return {"itemsDropped": 0, "packCostUsd": result["dollars"], "budgetUsd": budget_usd}

    if result["dollars"] <= budget_usd:
        return {"itemsDropped": 0, "packCostUsd": result["dollars"], "budgetUsd": budget_usd}

    # Build droppable list in priority order
    droppable: List[Tuple[str, Dict[str, Any]]] = []
    for item in list(sections.get("excludedContext", [])):
        droppable.append(("excludedContext", item))
    for item in list(sections.get("openQuestions", [])):
        droppable.append(("openQuestions", item))
    retrieval_pairs: List[Tuple[str, Dict[str, Any]]] = []
    for key in _RETRIEVAL_SECTION_KEYS:
        for item in sections.get(key, []):
            retrieval_pairs.append((key, item))
    retrieval_pairs.sort(key=lambda pair: _score_final(pair[1]))
    droppable.extend(retrieval_pairs)

    items_dropped = 0
    for section_key, item in droppable:
        if result["dollars"] <= budget_usd:
            break
        try:
            sections[section_key].remove(item)
        except ValueError:
            continue
        items_dropped += 1
        total_tokens -= _item_tokens(item)
        result = cost_for(model, input_tokens=total_tokens)

    return {"itemsDropped": items_dropped, "packCostUsd": result["dollars"], "budgetUsd": budget_usd}


def _greedy_token_budget_fill(sections: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Enforce RETRIEVAL_MAX_TOKENS by dropping whole low-relevance candidates.

    Rank all droppable retrieval items by score ascending (lowest first).
    Drop items one by one until the included-item token total ≤
    RETRIEVAL_MAX_TOKENS.  Returns a list of items that were dropped (each
    to be recorded in excludedContext with a budget reason).

    Protected sections (never dropped): requiredContext, availableTools,
    availableSkills, goals, openQuestions.
    Droppable: likelyFiles, likelyDocs, relevantMemory, priorMistakes,
    activeState (in ascending score order).
    """
    # Compute total tokens over included (non-excluded) sections only.
    included_sections = [k for k in PACK_SECTION_KEYS if k not in {"excludedContext", "openQuestions"}]

    def _included_tokens() -> int:
        return sum(_item_tokens(item) for key in included_sections for item in sections.get(key, []))

    if _included_tokens() <= RETRIEVAL_MAX_TOKENS:
        return []

    # Build droppable list: retrieval sections only, sorted by score ascending.
    candidates: List[Tuple[str, Dict[str, Any]]] = []
    for key in _RETRIEVAL_SECTION_KEYS:
        for item in list(sections.get(key, [])):
            candidates.append((key, item))
    candidates.sort(key=lambda pair: _score_final(pair[1]))

    dropped: List[Dict[str, Any]] = []
    for section_key, item in candidates:
        if _included_tokens() <= RETRIEVAL_MAX_TOKENS:
            break
        try:
            sections[section_key].remove(item)
        except ValueError:
            continue
        dropped.append(item)

    return dropped


def render_context_pack_markdown(pack: Dict[str, Any]) -> str:
    lines = [
        f"# Context Pack: {pack['target']['kind']} #{pack['target']['number']} {pack['target']['phase']}",
        "",
        f"Pack ID: `{pack['packId']}`",
        f"Generated: {pack['generatedAt']}",
        f"Goal: {pack['goal']['summary']}",
        f"Goal citation: {pack['goal']['citation']}",
        "",
    ]
    for key in PACK_SECTION_KEYS:
        lines.append(f"## {SECTION_TITLES[key]}")
        values = pack.get(key, [])
        if key == "memoryLane":
            # Memory crosses the trust boundary from chat into the runner's
            # prompt (#1039): always emit it framed as UNTRUSTED advisory DATA
            # (reusing the #1035 read-side framing pattern), even when empty, so
            # the delimiters/frame are a stable, auditable part of the pack.
            lines.append(frame_untrusted_memory(values))
        elif values:
            lines.extend(_render_item(item) for item in values)
        else:
            lines.append("None.")
        lines.append("")
    budget_lines = []
    if pack.get("budgetUsd") is not None:
        budget_lines = [
            f"- Budget: ${pack['budgetUsd']:.6f} USD",
            f"- Pack cost: ${pack['packCostUsd']:.6f} USD (model={pack.get('costModel', _DEFAULT_BUDGET_MODEL)})",
            f"- Items dropped to meet budget: {pack['itemsDropped']}",
        ]
    # Rerank-layer cost line (issue #1044 AC3): rendered whenever the pack
    # carries rerankCostUsd, independently of the budget lines above — the
    # rerank LLM spends real dollars whether or not --budget-usd was passed.
    rerank_lines = []
    if pack.get("rerankCostUsd") is not None:
        rerank_llm = ((pack.get("compiler") or {}).get("rerank") or {}).get("llm") or {}
        rerank_lines = [
            f"- Rerank cost: ${pack['rerankCostUsd']:.6f} USD"
            f" (model={rerank_llm.get('model')}, calls={rerank_llm.get('calls')})",
        ]
    lines.extend(
        [
            "## Metadata",
            f"- Retrieval budget: maxItems={pack['retrievalBudget']['maxItems']}, maxTokens={pack['retrievalBudget']['maxTokens']}",
            f"- Tokens saved vs reading full files: {pack.get('tokensSaved', 0)}",
            *budget_lines,
            *rerank_lines,
            f"- Index: {pack['index'].get('version')} builtAt={pack['index'].get('builtAt')}",
            f"- Provider mode: {pack['provider'].get('mode')}",
            f"- Audit event: {pack['audit'].get('event')} citation={pack['audit'].get('citation')}",
            "",
        ]
    )
    return "\n".join(lines)


def _load_prior_run_items(packs_dir: Path, run_id: str, target_kind: str, target_number: int) -> List[Dict[str, Any]]:
    """Return included items from all packs in *packs_dir* that share *run_id*, target_kind, target_number."""
    prior_items: List[Dict[str, Any]] = []
    if not packs_dir.exists():
        return prior_items
    for json_file in sorted(packs_dir.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict) or data.get("runId") != run_id:
            continue
        tgt = data.get("target") or {}
        if tgt.get("kind") != target_kind or tgt.get("number") != target_number:
            continue
        phase_label = str(tgt.get("phase") or "prior")
        for item in (data.get("included") or []):
            if isinstance(item, dict):
                annotated = dict(item)
                annotated["_firstPhase"] = phase_label
                prior_items.append(annotated)
    return prior_items


def build_context_pack(
    target_dir: Path,
    target_kind: str,
    target_number: int,
    phase: str,
    *,
    budget_usd: float | None = None,
    model: str = _DEFAULT_BUDGET_MODEL,
    run_id: Optional[str] = None,
    memory_items: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    root = target_dir.resolve()
    if target_kind not in {"issue", "pr"}:
        raise RuntimeError("context build requires target kind: issue or pr")
    if target_kind == "issue" and phase not in {"plan", "execute", "verify"} or target_kind == "pr" and phase != "review":
        raise RuntimeError("context build phase must be one of: issue plan|execute|verify, pr review")

    retrieval_budget = {"maxItems": 20, "maxTokens": RETRIEVAL_MAX_TOKENS}
    query_text = _query_for(target_kind, target_number, phase)
    query = query_context(root, query_text, limit=retrieval_budget["maxItems"])
    index = load_index(root)
    sections = _sectioned_results(query.get("results", []))
    for result in _target_linked_items(index, target_kind, target_number):
        section = _section_for(result)
        _append_unique(sections[section], _normalized_item(result, section, f"Included in {SECTION_TITLES[section].lower()} because it directly cites {_target_label(target_kind, target_number)}."))
    sections["excludedContext"] = _excluded_context(query.get("excluded", []))
    _ensure_required_sections(root, sections, index)
    sections["goals"] = _relevant_goals(root, target_kind, target_number, phase)
    # Factory read half of shared memory (#1039): a size-capped, deterministic,
    # typed + attributed selection of memory_items, read-side secret-filtered and
    # framed untrusted at render time. Injectable for tests; otherwise read from
    # the local snapshot. This lane is NOT subject to the retrieval token budget
    # trim below — it is independently byte-capped inside build_memory_lane so
    # its bytes stay stable for cache identity regardless of retrieval pressure.
    sections["memoryLane"] = build_memory_lane(root, items=memory_items)

    # Greedy token budget fill: enforce RETRIEVAL_MAX_TOKENS by dropping
    # entire low-relevance candidates (whole-item selection beats truncation).
    budget_dropped = _greedy_token_budget_fill(sections)
    for item in budget_dropped:
        dropped_item = _normalized_item(
            dict(item),
            "excluded_context",
            "dropped: over token budget",
        )
        dropped_item["reason"] = "dropped: over token budget"
        sections["excludedContext"].append(dropped_item)

    # USD budget trimming (AC1-AC5, optional --budget-usd flag)
    budget_meta: Dict[str, Any] = {}
    if budget_usd is not None:
        budget_meta = _trim_to_budget(sections, budget_usd, model)

    generated_at = _now()
    pack_id = f"{target_kind}-{target_number}-{phase}-{_pack_slug(generated_at)}"
    packs_dir = root / ".agentrail" / "context" / "packs"
    json_path = packs_dir / f"{pack_id}.json"
    md_path = packs_dir / f"{pack_id}.md"
    audit = {
        "event": "generated_context_pack",
        "citation": ".agentrail/context/audit/events.jsonl",
        "query": query.get("query"),
        "queryGeneratedAt": query.get("generatedAt"),
        "jsonPath": _relative(root, json_path),
        "markdownPath": _relative(root, md_path),
    }
    pack: Dict[str, Any] = {
        "schemaVersion": 1,
        "packId": pack_id,
        "target": {"kind": target_kind, "number": target_number, "phase": phase},
        "generatedAt": generated_at,
        "index": {"version": index.get("version"), "builtAt": index.get("builtAt")},
        "retrievalBudget": retrieval_budget,
        "provider": query.get("provider") or index.get("provider") or {"mode": "disabled", "externalCalls": []},
        "audit": audit,
        "goal": _primary_goal(target_kind, target_number, phase, sections["goals"]),
        **sections,
    }
    if budget_meta:
        pack["budgetUsd"] = budget_meta["budgetUsd"]
        pack["packCostUsd"] = budget_meta["packCostUsd"]
        pack["itemsDropped"] = budget_meta["itemsDropped"]
        pack["costModel"] = model
    if run_id is not None:
        pack["runId"] = run_id
    pack["included"] = _all_included(pack)
    pack["excluded"] = pack["excludedContext"]
    # Symbol-range packing (issue #1044 AC4, default OFF): shrink symbol-bearing
    # code candidates to the symbol's exact line range AFTER selection is final,
    # so the flag never changes which candidates are included (precision/recall
    # semantics untouched). Included items share dict references with the
    # sections above, so the packed content flows through to the markdown too.
    symbol_packing_on = symbol_packing_enabled()
    symbol_packed_count = 0
    if symbol_packing_on:
        symbol_packed_count = _apply_symbol_packing(root, index, pack["included"])
    # Compute live precision_at_budget and attach it to the pack so that
    # Milestone 014 telemetry reads a real value instead of 0/absent.
    # tokenEstimate is added from content for items that don't carry it yet,
    # so the token-share calculation in compute_pack_quality is accurate.
    # The fixed RETRIEVAL_MAX_TOKENS denominator measures "required token
    # share of the available retrieval budget" — higher when more high-value
    # sources (context_doc, taste_doc, critical/high authority) are packed.
    for _item in pack["included"]:
        if not isinstance(_item.get("tokenEstimate"), (int, float)) or isinstance(_item.get("tokenEstimate"), bool):
            _item["tokenEstimate"] = _item_tokens(_item)
    _quality = compute_pack_quality(pack["included"], pack["excludedContext"], RETRIEVAL_MAX_TOKENS)
    # Persist the full quality proxy set (not just precision_at_budget) so the
    # context-pack telemetry push (agentrail/run/context_pack_push.py) can read
    # every quality field directly from the persisted pack JSON — the actual
    # pack the run produced — rather than re-deriving them from search runMetadata.
    pack["precision_at_budget"] = _quality["precision_at_budget"]
    pack["citation_coverage"] = _quality["citation_coverage"]
    pack["stale_count"] = _quality["stale_count"]
    pack["denied_count"] = _quality["denied_count"]
    pack["source_hash_list"] = _quality["source_hash_list"]
    # Estimated tokens the bounded snippets saved versus reading every selected
    # file in full (ceil(chars/4) per file, each distinct file counted once).
    pack["tokensSaved"] = compute_tokens_saved(root, pack["included"])
    # Cross-phase retrieval dedup: detect items already retrieved in prior phases
    # of the same run and report avoided tokens/cost.  Always present (zeros when
    # nothing is reused).
    _dedup_model = (query.get("provider") or {}).get("model") or "claude-sonnet-4-6"
    if run_id is not None:
        prior_items = _load_prior_run_items(packs_dir, run_id, target_kind, target_number)
    else:
        prior_items = []
    pack["retrieval_dedup"] = compute_retrieval_dedup(prior_items, pack["included"], _dedup_model)
    # Thread the deterministic rerank metadata (issue #904) produced by the
    # underlying query_context retrieval into the pack's own compiler contract so
    # the live pack build records the populated rerank (method + ranked +
    # rejected-with-reasons), not the inert model:None pass-through.
    rerank_meta = (query.get("compiler") or {}).get("rerank") if isinstance(query.get("compiler"), dict) else None
    if isinstance(rerank_meta, dict) and rerank_meta.get("status") == "score_sorted":
        rerank_meta = None
    pack["compiler"] = compiler_contract(
        target_kind,
        query_text,
        root=root,
        phase=phase,
        target_kind=target_kind,
        target_number=target_number,
        token_budget=retrieval_budget,
        source_items=pack["included"],
        excluded_items=pack["excludedContext"],
        compatibility={
            "generatedPackJsonPath": _relative(root, json_path),
            "generatedPackMarkdownPath": _relative(root, md_path),
            "packIncludedMapTo": "compiler.tokenPack.selectedCandidateIds",
            "packExcludedMapTo": "compiler.candidates[kind=excluded_context]",
            "skillsMapTo": "compiler.candidates[kind=procedural_guidance]",
        },
        token_pack_strategy="greedy_budget_fill",
        rerank=rerank_meta,
    )
    if symbol_packing_on:
        # Mirror the rerank metadata threading: record that symbol packing ran
        # and how many candidates it shrank. Only attached when the flag is ON
        # so the flag-OFF pack stays byte-identical to today's output.
        pack["compiler"]["tokenPack"]["symbolPacking"] = {
            "enabled": True,
            "packedCount": symbol_packed_count,
        }
    # Rerank-layer cost telemetry (issue #1044 AC3): when the LLM rerank stage
    # ran (flag ON — its usage block is always present then, including on
    # fallback), price the metered usage through the canonical price table and
    # surface it on the pack BEFORE the JSON write and markdown render below.
    # Flag OFF leaves the pack byte-identical: no key, no markdown line.
    rerank_llm_usage = (pack["compiler"].get("rerank") or {}).get("llm") if isinstance(pack["compiler"].get("rerank"), dict) else None
    if isinstance(rerank_llm_usage, dict):
        pack["rerankCostUsd"] = llm_rerank_cost_usd(rerank_llm_usage)
    write_json(json_path, pack)
    md_path.write_text(render_context_pack_markdown(pack), encoding="utf-8")
    append_audit(
        root,
        {
            "event": "generated_context_pack",
            "packId": pack_id,
            "target": pack["target"],
            "jsonPath": _relative(root, json_path),
            "markdownPath": _relative(root, md_path),
            "includedCount": len(pack["included"]),
            "excludedCount": len(pack["excludedContext"]),
            "providerMode": pack["provider"].get("mode"),
        },
    )
    result: Dict[str, Any] = {
        "schemaVersion": 1,
        "command": "context.build",
        "packId": pack_id,
        "target": pack["target"],
        "generatedAt": generated_at,
        "jsonPath": _relative(root, json_path),
        "markdownPath": _relative(root, md_path),
        "index": pack["index"],
        "retrievalBudget": pack["retrievalBudget"],
        "tokensSaved": pack["tokensSaved"],
        "provider": pack["provider"],
        "audit": audit,
        "compiler": pack["compiler"],
        "retrieval_dedup": pack["retrieval_dedup"],
    }
    if budget_meta:
        result["budgetUsd"] = budget_meta["budgetUsd"]
        result["packCostUsd"] = budget_meta["packCostUsd"]
        result["itemsDropped"] = budget_meta["itemsDropped"]
        result["costModel"] = model
    if isinstance(rerank_llm_usage, dict):
        result["rerankCostUsd"] = pack["rerankCostUsd"]
    if run_id is not None:
        result["runId"] = run_id
    return result


def _pack_path(root: Path, pack: str) -> Path:
    packs_dir = (root / ".agentrail" / "context" / "packs").resolve()
    candidate = Path(pack)
    if not candidate.suffix:
        candidate = packs_dir / f"{pack}.json"
    elif not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(packs_dir)
    except ValueError as error:
        raise RuntimeError("context pack path must resolve under .agentrail/context/packs") from error
    if not resolved.exists():
        raise RuntimeError(f"context pack not found: {pack}")
    return resolved


def load_context_pack(target_dir: Path, pack: str) -> Dict[str, Any]:
    root = target_dir.resolve()
    path = _pack_path(root, pack)
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(f"invalid context pack JSON: {path}") from error
    if not isinstance(parsed, dict) or not parsed.get("packId"):
        raise RuntimeError(f"invalid context pack: {path}")
    return parsed


def show_context_pack(target_dir: Path, pack: str, *, json_output: bool = False) -> Any:
    parsed = load_context_pack(target_dir, pack)
    if not json_output:
        return render_context_pack_markdown(parsed)
    return {**parsed, "command": "context.show"}


def explain_context_pack(target_dir: Path, pack: str) -> Dict[str, Any]:
    parsed = load_context_pack(target_dir, pack)
    sections = {
        key: [
            {
                "path": item.get("path"),
                "reason": item.get("reason"),
                "citation": item.get("citation"),
                "score": item.get("score"),
            }
            for item in parsed.get(key, [])
        ]
        for key in PACK_SECTION_KEYS
    }
    explanation = {
        "schemaVersion": 1,
        "command": "context.explain",
        "packId": parsed.get("packId"),
        "target": parsed.get("target"),
        "generatedAt": parsed.get("generatedAt"),
        "includedCount": len(parsed.get("included", [])),
        "excludedCount": len(parsed.get("excludedContext", [])),
        "retrievalBudget": parsed.get("retrievalBudget"),
        "index": parsed.get("index"),
        "provider": parsed.get("provider"),
        "audit": parsed.get("audit"),
        "sections": sections,
    }
    append_audit(
        target_dir.resolve(),
        {
            "event": "explained_context_pack",
            "packId": parsed.get("packId"),
            "target": parsed.get("target"),
            "includedCount": explanation["includedCount"],
            "excludedCount": explanation["excludedCount"],
            "providerMode": (parsed.get("provider") or {}).get("mode"),
        },
    )
    return explanation
