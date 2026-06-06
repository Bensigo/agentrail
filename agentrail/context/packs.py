from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from agentrail.context.compiler import compiler_contract
from agentrail.context.index import append_audit, load_index
from agentrail.context.retrieval import query_context
from agentrail.shared.json import write_json


PACK_SECTION_KEYS = [
    "requiredContext",
    "likelyFiles",
    "likelyDocs",
    "relevantMemory",
    "priorMistakes",
    "activeState",
    "availableTools",
    "availableSkills",
    "goals",
    "excludedContext",
    "openQuestions",
]

SECTION_TITLES = {
    "requiredContext": "Required Context",
    "likelyFiles": "Likely Files",
    "likelyDocs": "Likely Docs",
    "relevantMemory": "Relevant Memory",
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
    if isinstance(content, str) and len(content) > 2000:
        return f"{content[:2000]}\n[TRUNCATED]"
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
        if values:
            lines.extend(_render_item(item) for item in values)
        else:
            lines.append("None.")
        lines.append("")
    lines.extend(
        [
            "## Metadata",
            f"- Retrieval budget: maxItems={pack['retrievalBudget']['maxItems']}, maxTokens={pack['retrievalBudget']['maxTokens']}",
            f"- Index: {pack['index'].get('version')} builtAt={pack['index'].get('builtAt')}",
            f"- Provider mode: {pack['provider'].get('mode')}",
            f"- Audit event: {pack['audit'].get('event')} citation={pack['audit'].get('citation')}",
            "",
        ]
    )
    return "\n".join(lines)


def build_context_pack(target_dir: Path, target_kind: str, target_number: int, phase: str) -> Dict[str, Any]:
    root = target_dir.resolve()
    if target_kind not in {"issue", "pr"}:
        raise RuntimeError("context build requires target kind: issue or pr")
    if target_kind == "issue" and phase not in {"plan", "execute", "verify"} or target_kind == "pr" and phase != "review":
        raise RuntimeError("context build phase must be one of: issue plan|execute|verify, pr review")

    retrieval_budget = {"maxItems": 20, "maxTokens": 6000}
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
    pack["included"] = _all_included(pack)
    pack["excluded"] = pack["excludedContext"]
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
        token_pack_strategy="compat_pack_sections_until_token_estimator_exists",
    )
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
    return {
        "schemaVersion": 1,
        "command": "context.build",
        "packId": pack_id,
        "target": pack["target"],
        "generatedAt": generated_at,
        "jsonPath": _relative(root, json_path),
        "markdownPath": _relative(root, md_path),
        "index": pack["index"],
        "provider": pack["provider"],
        "audit": audit,
        "compiler": pack["compiler"],
    }


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
