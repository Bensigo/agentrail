"""Reduce a local Acceptance Record Context Pack to its durable handoff metadata.

The context compiler may use bounded source snippets inside a disposable local
checkout. The central Acceptance Record must retain only the selection that an
external builder can rehydrate from its own checkout: cited source ranges,
token accounting, contract ids, exclusions, and freshness. This module is the
explicit boundary between those two custody domains.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple


def _strings(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _criteria(contract: Dict[str, Any]) -> List[Dict[str, str]]:
    raw = contract.get("acceptanceCriteria")
    if not isinstance(raw, list):
        raise RuntimeError("confirmed Acceptance Contract has no acceptance criteria")
    criteria: List[Dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise RuntimeError("confirmed Acceptance Contract has malformed acceptance criteria")
        identifier = item.get("id")
        if not isinstance(identifier, str) or not identifier.strip() or identifier in seen:
            raise RuntimeError("confirmed Acceptance Contract has malformed acceptance criteria")
        seen.add(identifier)
        criteria.append({"id": identifier})
    if not criteria:
        raise RuntimeError("confirmed Acceptance Contract has no acceptance criteria")
    return criteria


def _sources(included: Iterable[Any]) -> Tuple[List[Dict[str, Any]], int]:
    selected: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str, int, int]] = set()
    token_count = 0
    for item in included:
        if not isinstance(item, dict):
            continue
        path, citation = item.get("path"), item.get("citation")
        start, end = item.get("startLine"), item.get("endLine")
        if not isinstance(path, str) or not path.strip() or not isinstance(citation, str) or not citation.strip():
            continue
        if not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start:
            continue
        reason = item.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise RuntimeError("compiled Context Pack selected source has no reason")
        key = (path, citation, start, end)
        if key in seen:
            continue
        seen.add(key)
        token_estimate = item.get("tokenEstimate")
        tokens = token_estimate if isinstance(token_estimate, int) and token_estimate >= 0 else 0
        source: Dict[str, Any] = {
            "path": path,
            "citation": citation,
            "startLine": start,
            "endLine": end,
            "reason": reason.strip(),
            "tokenEstimate": tokens,
        }
        content_hash = item.get("contentHash") or item.get("textHash")
        if isinstance(content_hash, str) and content_hash:
            source["contentHash"] = content_hash
        source_type = item.get("sourceType")
        if isinstance(source_type, str) and source_type:
            source["sourceType"] = source_type
        selected.append(source)
        token_count += tokens
    if not selected:
        raise RuntimeError("compiled Context Pack contains no cited bounded source ranges")
    return selected, token_count


def _exclusions(items: Iterable[Any]) -> List[Dict[str, str]]:
    exclusions: List[Dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        path, citation, reason = item.get("path"), item.get("citation"), item.get("reason")
        if not all(isinstance(value, str) and value.strip() for value in (path, citation, reason)):
            continue
        exclusions.append({"path": path, "citation": citation, "reason": reason})
    return exclusions


def acceptance_context_manifest(
    pack: Dict[str, Any],
    contract: Dict[str, Any],
    *,
    repository_ref: str,
) -> Dict[str, Dict[str, Any]]:
    """Return Console-compatible metadata without any source/snippet content.

    ``pack`` is the local output from :func:`build_context_pack`; ``contract``
    is the exact confirmed snapshot. The result deliberately contains no
    ``content`` field at any depth, so it is safe to persist through
    ``recordAcceptanceContextPack``.
    """
    if not isinstance(repository_ref, str) or not repository_ref.strip():
        raise RuntimeError("compiled Context Pack has no claimed repository ref")
    budget = pack.get("retrievalBudget")
    if not isinstance(budget, dict) or not isinstance(budget.get("maxTokens"), int) or budget["maxTokens"] <= 0:
        raise RuntimeError("compiled Context Pack has no explicit token budget")
    sources, token_count = _sources(pack.get("included", []))
    if token_count > budget["maxTokens"]:
        raise RuntimeError("compiled Context Pack exceeds its explicit token budget")
    freshness = pack.get("freshness")
    generated_at = pack.get("generatedAt")
    if not isinstance(freshness, dict) or not isinstance(freshness.get("commitSha"), str) or not freshness["commitSha"]:
        raise RuntimeError("compiled Context Pack has no exact index revision")
    if not isinstance(generated_at, str) or not generated_at:
        raise RuntimeError("compiled Context Pack has no compilation timestamp")
    custody = pack.get("custody")
    if not isinstance(custody, dict) or custody.get("fullSourceUploadAllowed") is not False:
        raise RuntimeError("compiled Context Pack custody must forbid full source upload")

    manifest = {
        "tokenBudget": budget["maxTokens"],
        "tokenCount": token_count,
        "sources": sources,
        "acceptanceCriteria": _criteria(contract),
        "architectureBoundaries": _strings(contract.get("affectedCodebaseUnits")),
        "tests": _strings(contract.get("verificationCommands")),
        "decisions": _strings(contract.get("nonGoals")),
        "exclusions": _exclusions(pack.get("excludedContext", [])),
    }
    durable_freshness = {
        "indexRevision": freshness["commitSha"],
        "repositoryRef": repository_ref,
        "compiledAt": generated_at,
        "sourceTreeFingerprint": freshness.get("sourceTreeFingerprint"),
        "staleCount": freshness.get("staleCount", 0),
        "deniedCount": freshness.get("deniedCount", 0),
    }
    return {"manifest": manifest, "custody": dict(custody), "freshness": durable_freshness}
