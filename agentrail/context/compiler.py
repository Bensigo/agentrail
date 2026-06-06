from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from agentrail.context.config import read_context_config
from agentrail.context.redaction import redact_text
from agentrail.shared.fs import matches_any


CONTRACT_VERSION = "context-compiler-v1"
SOURCE_EVIDENCE_TYPES = {
    "agent_doc",
    "agentrail_state",
    "code",
    "context_doc",
    "external_descriptor",
    "memory",
    "milestone",
    "prd",
    "run_artifact",
    "taste_doc",
}
PROCEDURAL_GUIDANCE_TYPES = {"skill", "tool"}


def _append_anchor(
    anchors: List[Dict[str, str]],
    seen: Set[Tuple[str, str]],
    *,
    kind: str,
    value: str,
    normalized: str,
    source: str,
    confidence: str,
    reason: str,
) -> None:
    key = (kind, normalized)
    if key in seen:
        return
    seen.add(key)
    anchors.append(
        {
            "kind": kind,
            "value": value,
            "normalized": normalized,
            "source": source,
            "confidence": confidence,
            "reason": reason,
        }
    )


def _issue_refs(text: str) -> List[int]:
    refs: Set[int] = set()
    for match in re.finditer(r"(?:^|[^A-Za-z])#(\d+)\b", text):
        prefix = text[: match.start() + len(match.group(0)) - len(match.group(1)) - 1]
        if re.search(r"(?:^|\b)(?:pr|pull\s+request)\s*$", prefix, re.IGNORECASE):
            continue
        refs.add(int(match.group(1)))
    refs.update(int(match.group(1)) for match in re.finditer(r"/issues/(\d+)\b", text))
    return sorted(refs)


def _pr_refs(text: str) -> List[int]:
    refs = {int(match.group(1)) for match in re.finditer(r"/pull/(\d+)\b", text)}
    refs.update(int(match.group(1)) for match in re.finditer(r"\bpr\s*#?(\d+)\b", text, re.IGNORECASE))
    refs.update(int(match.group(1)) for match in re.finditer(r"\bpull\s+request\s*#?(\d+)\b", text, re.IGNORECASE))
    return sorted(refs)


def _safe_anchor_value(root: Optional[Path], value: str) -> Optional[str]:
    if redact_text(value).findings:
        return None
    if root is None:
        return value
    try:
        cfg = read_context_config(root)
    except Exception:
        return value
    if matches_any(cfg.excludeGlobs, value):
        return None
    if cfg.secretRedaction.enabled and matches_any(cfg.secretRedaction.denyGlobs, value):
        return None
    return value


def extract_anchors(
    text: str,
    *,
    root: Optional[Path] = None,
    source: str = "input",
    target_kind: Optional[str] = None,
    target_number: Optional[int] = None,
) -> List[Dict[str, str]]:
    anchors: List[Dict[str, str]] = []
    seen: Set[Tuple[str, str]] = set()
    if target_kind == "issue" and target_number is not None:
        _append_anchor(
            anchors,
            seen,
            kind="issue",
            value=str(target_number),
            normalized=f"#{target_number}",
            source="target",
            confidence="exact",
            reason=f"Context target is issue #{target_number}.",
        )
    elif target_kind == "pr" and target_number is not None:
        _append_anchor(
            anchors,
            seen,
            kind="pull_request",
            value=str(target_number),
            normalized=f"PR #{target_number}",
            source="target",
            confidence="exact",
            reason=f"Context target is PR #{target_number}.",
        )
    for number in _issue_refs(text):
        _append_anchor(
            anchors,
            seen,
            kind="issue",
            value=str(number),
            normalized=f"#{number}",
            source=source,
            confidence="exact",
            reason="Issue reference found in task text.",
        )
    for number in _pr_refs(text):
        _append_anchor(
            anchors,
            seen,
            kind="pull_request",
            value=str(number),
            normalized=f"PR #{number}",
            source=source,
            confidence="exact",
            reason="Pull request reference found in task text.",
        )
    for match in re.finditer(r"(?<![A-Za-z0-9_])(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+", text):
        value = match.group(0).strip(".,:;()[]{}\"'")
        if "://" in value or not value:
            continue
        safe_value = _safe_anchor_value(root, value)
        if safe_value is None:
            continue
        _append_anchor(
            anchors,
            seen,
            kind="path",
            value=safe_value,
            normalized=safe_value,
            source=source,
            confidence="exact",
            reason="Repo-relative path found in task text.",
        )
    for command in re.findall(
        r"\b(?:agentrail\s+context\s+(?:query|build|show|explain|evaluate|sources|index|embed)|bash\s+scripts/[A-Za-z0-9_.-]+|npm\s+(?:test|run\s+[A-Za-z0-9_.-]+))\b",
        text,
    ):
        safe_value = _safe_anchor_value(root, command)
        if safe_value is None:
            continue
        _append_anchor(
            anchors,
            seen,
            kind="command",
            value=safe_value,
            normalized=safe_value,
            source=source,
            confidence="exact",
            reason="Command reference found in task text.",
        )
    return anchors


def compiler_policy(root: Optional[Path]) -> Dict[str, Any]:
    try:
        cfg = read_context_config(root) if root is not None else None
    except Exception:
        cfg = None
    redaction = cfg.secretRedaction if cfg is not None else None
    return {
        "sourceCustody": {
            "mode": "metadata_only",
            "fullSourceUploadAllowed": False,
            "snippetUploadAllowed": False,
            "reason": "Default enterprise mode does not upload full source code.",
        },
        "redaction": {
            "enabled": bool(redaction.enabled) if redaction is not None else True,
            "action": str(redaction.action) if redaction is not None else "exclude",
        },
        "authorityOrder": ["critical", "high", "normal", "low", "denied"],
        "freshnessOrder": ["current", "unknown", "stale", "expired"],
        "deniedSourceHandling": "excluded_context_only",
    }


def _candidate_id(item: Dict[str, Any]) -> str:
    if item.get("sourceType") in PROCEDURAL_GUIDANCE_TYPES and item.get("path"):
        return str(item["path"])
    for field in ("chunkId", "sourceId", "citation", "path"):
        value = item.get(field)
        if value:
            return str(value)
    return "candidate:unknown"


def _candidate_kind(item: Dict[str, Any], forced_kind: Optional[str]) -> str:
    if forced_kind:
        return forced_kind
    source_type = str(item.get("sourceType") or "")
    item_kind = str(item.get("kind") or "")
    if item_kind == "excluded_context":
        return "excluded_context"
    if source_type in PROCEDURAL_GUIDANCE_TYPES or item_kind in {"available_tool", "availableSkills"}:
        return "procedural_guidance"
    return "source_evidence" if source_type in SOURCE_EVIDENCE_TYPES or source_type else "source_evidence"


def _freshness_status(item: Dict[str, Any]) -> str:
    freshness = item.get("freshness")
    if isinstance(freshness, dict):
        return str(freshness.get("status") or "unknown")
    if isinstance(freshness, str):
        return freshness
    return "unknown"


def _visibility(item: Dict[str, Any], kind: str) -> str:
    if item.get("visibility"):
        return str(item["visibility"])
    reason = str(item.get("reason") or "")
    if kind == "excluded_context" and re.search(r"denied|secret|exclude", reason, re.IGNORECASE):
        return "denied"
    return "local"


def candidate_from_item(item: Dict[str, Any], *, kind: Optional[str] = None) -> Dict[str, Any]:
    candidate_kind = _candidate_kind(item, kind)
    value: Dict[str, Any] = {
        "id": _candidate_id(item),
        "kind": candidate_kind,
        "sourceType": item.get("sourceType"),
        "path": item.get("path"),
        "citation": item.get("citation") or item.get("path"),
        "reason": item.get("reason") or "No reason recorded.",
        "contentHash": item.get("contentHash"),
        "textHash": item.get("textHash"),
        "score": item.get("score"),
        "policy": {
            "visibility": _visibility(item, candidate_kind),
            "authority": str(item.get("authority") or "unknown"),
            "freshness": _freshness_status(item),
            "redactions": list(item.get("redactions") or []),
        },
    }
    return {key: current for key, current in value.items() if current is not None}


def _coverage(candidates: List[Dict[str, Any]], field: str) -> float:
    if not candidates:
        return 1.0
    return len([candidate for candidate in candidates if candidate.get(field)]) / len(candidates)


def _citation_summary(candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    missing = [candidate["id"] for candidate in candidates if not candidate.get("citation")]
    return {
        "coverage": round(_coverage(candidates, "citation"), 6),
        "items": [{"candidateId": candidate["id"], "citation": candidate.get("citation")} for candidate in candidates if candidate.get("citation")],
        "missingCandidateIds": missing,
    }


def _reason_summary(candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    missing = [candidate["id"] for candidate in candidates if not candidate.get("reason")]
    return {
        "coverage": round(_coverage(candidates, "reason"), 6),
        "items": [{"candidateId": candidate["id"], "reason": candidate.get("reason")} for candidate in candidates if candidate.get("reason")],
        "missingCandidateIds": missing,
    }


def _stale_or_denied_leakage(selected_candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    leaked: List[Dict[str, Any]] = []
    for candidate in selected_candidates:
        policy = candidate.get("policy") or {}
        if policy.get("visibility") == "denied" or policy.get("authority") == "denied" or policy.get("freshness") in {"stale", "expired"}:
            leaked.append({"candidateId": candidate.get("id"), "path": candidate.get("path")})
    return {"count": len(leaked), "paths": [str(item.get("path")) for item in leaked if item.get("path")], "items": leaked}


def token_pack_metadata(
    *,
    max_items: Optional[int],
    max_tokens: Optional[int],
    selected_candidate_ids: List[str],
    omitted_candidate_ids: Optional[List[str]] = None,
    estimated_tokens: Optional[int] = None,
    strategy: str = "compat_max_items_until_token_estimator_exists",
) -> Dict[str, Any]:
    return {
        "budget": {
            "maxItems": max_items,
            "maxTokens": max_tokens,
        },
        "selectedCandidateIds": selected_candidate_ids,
        "omittedCandidateIds": omitted_candidate_ids or [],
        "estimatedTokens": estimated_tokens,
        "strategy": strategy,
    }


def compiler_contract(
    kind: str,
    text: str,
    *,
    root: Optional[Path] = None,
    phase: Optional[str] = None,
    target_kind: Optional[str] = None,
    target_number: Optional[int] = None,
    token_budget: Optional[Dict[str, Optional[int]]] = None,
    source_items: Optional[Iterable[Dict[str, Any]]] = None,
    procedural_items: Optional[Iterable[Dict[str, Any]]] = None,
    excluded_items: Optional[Iterable[Dict[str, Any]]] = None,
    compatibility: Optional[Dict[str, Any]] = None,
    token_pack_strategy: str = "compat_max_items_until_token_estimator_exists",
) -> Dict[str, Any]:
    budget = token_budget or {"maxItems": None, "maxTokens": None}
    candidates: List[Dict[str, Any]] = []
    for item in source_items or []:
        candidates.append(candidate_from_item(dict(item)))
    for item in procedural_items or []:
        candidates.append(candidate_from_item(dict(item), kind="procedural_guidance"))
    for item in excluded_items or []:
        candidates.append(candidate_from_item(dict(item), kind="excluded_context"))
    selected = [candidate for candidate in candidates if candidate.get("kind") != "excluded_context"]
    selected_candidate_ids = [str(candidate["id"]) for candidate in selected]
    excluded_candidate_ids = [str(candidate["id"]) for candidate in candidates if candidate.get("kind") == "excluded_context"]
    issue_refs = _issue_refs(text)
    pr_refs = _pr_refs(text)
    target_issue = target_number if target_kind == "issue" else (issue_refs[0] if issue_refs else None)
    target_pull_request = target_number if target_kind == "pr" else (pr_refs[0] if pr_refs else None)
    return {
        "contractVersion": CONTRACT_VERSION,
        "input": {
            "kind": kind,
            "text": text,
            "phase": phase,
            "targetIssue": target_issue,
            "targetPullRequest": target_pull_request,
        },
        "anchors": extract_anchors(text, root=root, target_kind=target_kind, target_number=target_number),
        "candidates": candidates,
        "graphExpansion": {
            "status": "not_available",
            "maxHops": 2,
            "startedFromAnchors": [],
            "visited": [],
            "addedCandidateIds": [],
            "rejected": [],
        },
        "policy": compiler_policy(root),
        "rerank": {
            "status": "score_sorted",
            "method": "hybrid_lexical_rrf_authority_freshness",
            "model": None,
            "rankedCandidateIds": selected_candidate_ids,
            "rejectedCandidateIds": excluded_candidate_ids,
        },
        "tokenPack": token_pack_metadata(
            max_items=budget.get("maxItems"),
            max_tokens=budget.get("maxTokens"),
            selected_candidate_ids=selected_candidate_ids,
            strategy=token_pack_strategy,
        ),
        "citations": _citation_summary(candidates),
        "reasons": _reason_summary(candidates),
        "metrics": {
            "citationCoverage": round(_coverage(candidates, "citation"), 6),
            "reasonCoverage": round(_coverage(candidates, "reason"), 6),
            "candidateCount": len(candidates),
            "selectedCount": len(selected),
            "excludedCount": len(excluded_candidate_ids),
            "staleOrDeniedLeakage": _stale_or_denied_leakage(selected),
        },
        "compatibility": {"legacyFieldsPreserved": True, **(compatibility or {})},
    }
