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


def _append_text_anchor(
    anchors: List[Dict[str, str]],
    seen: Set[Tuple[str, str]],
    *,
    root: Optional[Path],
    kind: str,
    value: str,
    source: str,
    reason: str,
) -> None:
    cleaned = value.strip(".,;[]{}\"'")
    if not cleaned:
        return
    safe_value = _safe_anchor_value(root, cleaned)
    if safe_value is None:
        return
    _append_anchor(
        anchors,
        seen,
        kind=kind,
        value=safe_value,
        normalized=safe_value,
        source=source,
        confidence="exact",
        reason=reason,
    )


def _path_like_matches(text: str) -> Iterable[str]:
    for match in re.finditer(r"(?<![A-Za-z0-9_])(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+", text):
        value = match.group(0).strip(".,:;()[]{}\"'")
        if "://" in value or not value:
            continue
        yield value


def _test_matches(text: str) -> Iterable[str]:
    pattern = re.compile(
        r"(?<![A-Za-z0-9_./-])"
        r"(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.(?:py|js|jsx|ts|tsx|rb|go|rs|java|kt|php)"
        r"(?:::[A-Za-z_][A-Za-z0-9_]*)+"
    )
    for match in pattern.finditer(text):
        yield match.group(0).strip(".,;()[]{}\"'")


def _command_matches(text: str) -> Iterable[str]:
    command_pattern = re.compile(
        r"\b("
        r"agentrail\s+(?:context\s+(?:query|build|show|explain|evaluate|sources|index|embed)|memory\s+recall|status|resume|doctor|run\s+issue\s+\d+)"
        r"|bash\s+scripts/[A-Za-z0-9_.-]+"
        r"|python3?\s+-m\s+unittest(?:\s+[A-Za-z0-9_./:-]+)?"
        r"|pytest(?:\s+[A-Za-z0-9_./:-]+)?"
        r"|npm\s+(?:test|run\s+[A-Za-z0-9_.-]+)"
        r"|pnpm\s+(?:test|run\s+[A-Za-z0-9_.-]+)"
        r"|yarn\s+(?:test|run\s+[A-Za-z0-9_.-]+)"
        r")\b"
    )
    for match in command_pattern.finditer(text):
        yield re.sub(r"\s+", " ", match.group(1).strip())


def _symbol_matches(text: str) -> Iterable[str]:
    patterns = [
        r"(?<![A-Za-z0-9_.])(?:[A-Za-z_][A-Za-z0-9_]*::)+[A-Za-z_][A-Za-z0-9_]*",
        r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]{2,})\(\)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            value = match.group(0).strip(".,;[]{}\"'")
            if "/" in value:
                continue
            if re.search(r"\.(?:py|js|jsx|ts|tsx|rb|go|rs|java|kt|php)(?:::|$)", value):
                continue
            if "_" not in value and "::" not in value and "." not in value and not value.endswith("()") and not re.search(r"[a-z][A-Z]|[A-Z][a-z]", value):
                continue
            yield value


def _error_matches(text: str) -> Iterable[str]:
    error_prefix = re.compile(
        r"\b((?:[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Failure)|AssertionError|RuntimeError|ValueError|TypeError|SyntaxError|ImportError|ModuleNotFoundError|FAILED|ERROR):\s+.+)"
    )
    for line in text.splitlines():
        compact = re.sub(r"\s+", " ", line).strip()
        if not compact or redact_text(compact).findings:
            continue
        match = error_prefix.search(compact)
        if not match:
            continue
        value = re.split(
            r"\s+(?=(?:agentrail|bash|python3?|pytest|npm|pnpm|yarn)\b|(?:[A-Za-z0-9_.-]+/)+)",
            match.group(1),
            maxsplit=1,
        )[0]
        words = value.split()
        if len(words) > 8:
            value = " ".join(words[:8])
        yield value[:160].rstrip()


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
    for value in _test_matches(text):
        _append_text_anchor(anchors, seen, root=root, kind="test", value=value, source=source, reason="Test identifier found in task text.")
    for value in _path_like_matches(text):
        _append_text_anchor(anchors, seen, root=root, kind="path", value=value, source=source, reason="Repo-relative path found in task text.")
    for command in _command_matches(text):
        _append_text_anchor(anchors, seen, root=root, kind="command", value=command, source=source, reason="Command reference found in task text.")
    for symbol in _symbol_matches(text):
        _append_text_anchor(anchors, seen, root=root, kind="symbol", value=symbol, source=source, reason="Symbol identifier found in task text.")
    for error in _error_matches(text):
        _append_text_anchor(anchors, seen, root=root, kind="error", value=error, source=source, reason="Error text found in task text.")
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
            "snippetUploadEligible": False,
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


def _candidate_id(item: Dict[str, Any], candidate_kind: str) -> str:
    if candidate_kind == "excluded_context":
        for field in ("sourceId", "chunkId", "path", "citation"):
            value = item.get(field)
            if value:
                return f"excluded:{value}"
        return "excluded:candidate:unknown"
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


def _redaction_policy(item: Dict[str, Any], candidate_kind: str, base_policy: Dict[str, Any]) -> Dict[str, Any]:
    findings = list(item.get("redactions") or [])
    state = "redacted" if findings else "none"
    if candidate_kind == "excluded_context" and (_visibility(item, candidate_kind) == "denied" or findings):
        state = "excluded"
    redaction = base_policy.get("redaction") if isinstance(base_policy.get("redaction"), dict) else {}
    return {
        "enabled": bool(redaction.get("enabled", True)),
        "action": str(redaction.get("action") or "exclude"),
        "state": state,
        "findings": findings,
    }


def _score_number(item: Dict[str, Any], field: str) -> float:
    score = item.get("score")
    if not isinstance(score, dict):
        return 0.0
    value = score.get(field)
    return float(value) if isinstance(value, (int, float)) else 0.0


def _authority_policy(item: Dict[str, Any], candidate_kind: str, authority: str) -> Dict[str, Any]:
    boost = _score_number(item, "authorityBoost")
    demotion = _score_number(item, "authorityDemotion")
    if candidate_kind == "excluded_context" or authority == "denied":
        effect = "excluded"
    elif authority in {"critical", "high"} or boost > 0:
        effect = "boosted"
    elif authority == "low" or demotion > 0:
        effect = "demoted"
    else:
        effect = "neutral"
    return {
        "value": authority,
        "effect": effect,
        "scoreEffect": round(boost - demotion, 6),
    }


def _freshness_policy(item: Dict[str, Any], candidate_kind: str, freshness: str) -> Dict[str, Any]:
    demotion = _score_number(item, "freshnessDemotion")
    if candidate_kind == "excluded_context":
        effect = "excluded"
    elif freshness in {"stale", "expired"} or demotion > 0:
        effect = "demoted"
    else:
        effect = "neutral"
    return {
        "value": freshness,
        "effect": effect,
        "scoreEffect": round(-demotion, 6),
    }


def candidate_from_item(item: Dict[str, Any], *, kind: Optional[str] = None, base_policy: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    candidate_kind = _candidate_kind(item, kind)
    policy = base_policy or compiler_policy(None)
    source_custody = dict(policy.get("sourceCustody") or {})
    source_custody.setdefault("mode", "metadata_only")
    source_custody.setdefault("fullSourceUploadAllowed", False)
    source_custody.setdefault("snippetUploadAllowed", False)
    source_custody.setdefault("snippetUploadEligible", bool(source_custody.get("snippetUploadAllowed")))
    source_custody.setdefault("reason", "Default enterprise mode does not upload full source code.")
    authority = str(item.get("authority") or "unknown")
    freshness = _freshness_status(item)
    value: Dict[str, Any] = {
        "id": _candidate_id(item, candidate_kind),
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
            "authority": authority,
            "freshness": freshness,
            "redactions": list(item.get("redactions") or []),
            "sourceCustody": source_custody,
            "redaction": _redaction_policy(item, candidate_kind, policy),
            "authorityPolicy": _authority_policy(item, candidate_kind, authority),
            "freshnessPolicy": _freshness_policy(item, candidate_kind, freshness),
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


def _rerank_contract(
    rerank: Optional[Dict[str, Any]],
    selected_candidate_ids: List[str],
    excluded_candidate_ids: List[str],
) -> Dict[str, Any]:
    """Build the rerank contract block.

    When a real deterministic rerank ran (issue #904), populate ``method``, the
    ranked candidate list, and the rejected list (each rejection carrying a
    reason) — NOT ``model: None`` pass-through.  When rerank is disabled, fall
    back to the legacy score-sorted descriptor so the baseline stays measurable.
    """
    if isinstance(rerank, dict):
        contract = {
            "status": rerank.get("status") or "reranked",
            "method": rerank.get("method") or "deterministic_code_aware",
            # Deterministic stage carries NO LLM model; the optional listwise
            # stage (issue #1044) sets it only when it actually reordered.
            "model": rerank.get("model"),
            "signals": ["symbolOverlap", "graphDistance", "freshness"],
            "candidateCount": rerank.get("candidateCount"),
            "keptCount": rerank.get("keptCount"),
            "rejectedCount": rerank.get("rejectedCount"),
            "orderChanged": rerank.get("orderChanged"),
            "rankedCandidateIds": rerank.get("rankedCandidateIds") or selected_candidate_ids,
            # Backward-compatible flat id list plus the rich reason-carrying list.
            "rejectedCandidateIds": [
                str(item.get("candidateId"))
                for item in (rerank.get("rejected") or [])
                if item.get("candidateId")
            ] or excluded_candidate_ids,
            "rejected": rerank.get("rejected") or [],
        }
        # LLM listwise stage telemetry (issue #1044): the raw token-usage
        # block is the PR 3 metering seam.  Threaded CONDITIONALLY so the
        # flag-OFF contract gains no keys and stays byte-identical.
        if "llm" in rerank:
            contract["llm"] = rerank["llm"]
        if "llmFallback" in rerank:
            contract["llmFallback"] = rerank["llmFallback"]
        return contract
    return {
        "status": "score_sorted",
        "method": "hybrid_lexical_rrf_authority_freshness",
        "model": None,
        "rankedCandidateIds": selected_candidate_ids,
        "rejectedCandidateIds": excluded_candidate_ids,
        "rejected": [],
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
    graph_expansion: Optional[Dict[str, Any]] = None,
    rerank: Optional[Dict[str, Any]] = None,
    compatibility: Optional[Dict[str, Any]] = None,
    token_pack_strategy: str = "compat_max_items_until_token_estimator_exists",
) -> Dict[str, Any]:
    budget = token_budget or {"maxItems": None, "maxTokens": None}
    policy = compiler_policy(root)
    candidates: List[Dict[str, Any]] = []
    for item in source_items or []:
        candidates.append(candidate_from_item(dict(item), base_policy=policy))
    for item in procedural_items or []:
        candidates.append(candidate_from_item(dict(item), kind="procedural_guidance", base_policy=policy))
    for item in excluded_items or []:
        candidates.append(candidate_from_item(dict(item), kind="excluded_context", base_policy=policy))
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
        "graphExpansion": graph_expansion or {
            "status": "not_available",
            "maxHops": 2,
            "startedFromAnchors": [],
            "visited": [],
            "addedCandidateIds": [],
            "rejected": [],
        },
        "policy": policy,
        "rerank": _rerank_contract(rerank, selected_candidate_ids, excluded_candidate_ids),
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
