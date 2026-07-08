from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from agentrail.context.config import read_context_config
from agentrail.context.embeddings import embed_context
from agentrail.context.retrieval import query_context


FIXTURE_KEYS = [
    "expectedFiles",
    "expectedDocs",
    "expectedMemory",
    "expectedPriorMistakes",
    "expectedExcludedSources",
    "expectedGraphExpandedSources",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _string_list(value: Any, field: str) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise RuntimeError(f"evaluation fixture field '{field}' must be an array of non-empty strings")
    return list(value)


def _fixture_list(parsed: Any) -> List[Dict[str, Any]]:
    if isinstance(parsed, dict) and isinstance(parsed.get("fixtures"), list):
        fixtures = parsed["fixtures"]
    elif isinstance(parsed, list):
        fixtures = parsed
    else:
        raise RuntimeError("evaluation fixture file must be an array or an object with a fixtures array")
    if not all(isinstance(item, dict) for item in fixtures):
        raise RuntimeError("evaluation fixtures must be objects")
    return fixtures


def load_fixtures(path: Path) -> List[Dict[str, Any]]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(f"invalid evaluation fixture file: {error}") from error
    fixtures = _fixture_list(parsed)
    normalized: List[Dict[str, Any]] = []
    for index, fixture in enumerate(fixtures, 1):
        task = fixture.get("task")
        if not isinstance(task, str) or not task.strip():
            raise RuntimeError(f"evaluation fixture #{index} requires task text")
        item: Dict[str, Any] = {
            "name": str(fixture.get("name") or f"fixture-{index}"),
            "task": task,
            "limit": int(fixture.get("limit") or 10),
            "requiredSources": _string_list(fixture.get("requiredSources"), "requiredSources"),
            "optionalProviderEnv": _string_list(fixture.get("optionalProviderEnv"), "optionalProviderEnv"),
            "minPrecisionAtBudget": float(fixture.get("minPrecisionAtBudget", 0.0) or 0.0),
        }
        for key in FIXTURE_KEYS:
            item[key] = _string_list(fixture.get(key), key)
        normalized.append(item)
    return normalized


def _expected_included(fixture: Dict[str, Any]) -> List[str]:
    values: List[str] = []
    for key in ("expectedFiles", "expectedDocs", "expectedMemory", "expectedPriorMistakes"):
        values.extend(fixture.get(key, []))
    return _unique(values)


def _unique(values: Iterable[str]) -> List[str]:
    seen: Set[str] = set()
    result: List[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _paths(results: Iterable[Dict[str, Any]]) -> List[str]:
    return [str(item.get("path") or "") for item in results if item.get("path")]


def _compiler(query: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    compiler = query.get("compiler")
    return compiler if isinstance(compiler, dict) else None


def _compiler_candidates(query: Dict[str, Any]) -> List[Dict[str, Any]]:
    compiler = _compiler(query)
    if not compiler or not isinstance(compiler.get("candidates"), list):
        return []
    return [item for item in compiler["candidates"] if isinstance(item, dict)]


def _candidate_lookup(query: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    lookup: Dict[str, Dict[str, Any]] = {}
    for candidate in _compiler_candidates(query):
        candidate_id = candidate.get("id")
        if candidate_id:
            lookup[str(candidate_id)] = candidate
    return lookup


def _selected_compiler_candidates(query: Dict[str, Any]) -> List[Dict[str, Any]]:
    compiler = _compiler(query)
    if not compiler:
        return []
    token_pack = compiler.get("tokenPack")
    selected_ids = token_pack.get("selectedCandidateIds") if isinstance(token_pack, dict) else None
    if not isinstance(selected_ids, list):
        return []
    lookup = _candidate_lookup(query)
    selected: List[Dict[str, Any]] = []
    for candidate_id in selected_ids:
        candidate = lookup.get(str(candidate_id))
        if candidate and candidate.get("kind") != "excluded_context":
            selected.append(candidate)
    return selected


def _result_candidate_id(item: Dict[str, Any]) -> str:
    for field in ("chunkId", "sourceId", "citation", "path"):
        value = item.get(field)
        if value:
            return str(value)
    return "candidate:unknown"


def _score_final(item: Dict[str, Any]) -> Any:
    score = item.get("score")
    if isinstance(score, dict):
        return score.get("final")
    return None


def _top_result_details(query: Dict[str, Any], results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_candidate_id = {_result_candidate_id(item): item for item in results}
    by_path = {str(item.get("path")): item for item in results if item.get("path")}
    selected = _selected_compiler_candidates(query)
    if selected:
        details: List[Dict[str, Any]] = []
        for index, candidate in enumerate(selected[:10], 1):
            candidate_id = str(candidate.get("id") or "")
            legacy = by_candidate_id.get(candidate_id) or by_path.get(str(candidate.get("path")))
            details.append(
                {
                    "rank": (legacy or {}).get("rank") or index,
                    "candidateId": candidate_id,
                    "path": candidate.get("path"),
                    "citation": candidate.get("citation"),
                    "reason": candidate.get("reason"),
                    "sourceType": candidate.get("sourceType"),
                    "policy": candidate.get("policy"),
                    "score": _score_final(candidate) if _score_final(candidate) is not None else _score_final(legacy or {}),
                }
            )
        return details
    return [
        {
            "rank": item.get("rank"),
            "candidateId": _result_candidate_id(item),
            "path": item.get("path"),
            "citation": item.get("citation"),
            "reason": item.get("reason"),
            "sourceType": item.get("sourceType"),
            "policy": {
                "visibility": item.get("visibility"),
                "authority": item.get("authority"),
                "freshness": (item.get("freshness") or {}).get("status") if isinstance(item.get("freshness"), dict) else item.get("freshness"),
            },
            "score": _score_final(item),
        }
        for item in results[:10]
    ]


def _included_paths(query: Dict[str, Any], results: List[Dict[str, Any]]) -> List[str]:
    if _compiler(query):
        return _paths(_selected_compiler_candidates(query))
    return _paths(results)


def _recall(expected: List[str], paths: Set[str]) -> float:
    if not expected:
        return 1.0
    return len([path for path in expected if path in paths]) / len(expected)


def _has_field_value(item: Dict[str, Any], field: str) -> bool:
    value = item.get(field)
    if not isinstance(value, str):
        return bool(value)
    if not value.strip():
        return False
    if field == "reason" and value.strip() == "No reason recorded.":
        return False
    return True


def _field_coverage(items: List[Dict[str, Any]], field: str) -> Dict[str, Any]:
    if not items:
        return {"coverage": 1.0, "missing": []}
    missing = [item for item in items if not _has_field_value(item, field)]
    return {"coverage": (len(items) - len(missing)) / len(items), "missing": missing}


def _describe_top_result(item: Dict[str, Any]) -> str:
    path = item.get("path") or "<unknown path>"
    rank = item.get("rank")
    candidate_id = item.get("candidateId")
    details = [str(path)]
    if rank:
        details.append(f"rank {rank}")
    if candidate_id:
        details.append(f"candidate {candidate_id}")
    return " (".join([details[0], ", ".join(details[1:]) + ")"]) if len(details) > 1 else details[0]


def _nearest_candidates(top_results: List[Dict[str, Any]], limit: int = 5) -> List[Dict[str, Any]]:
    return [
        {
            "rank": item.get("rank"),
            "path": item.get("path"),
            "candidateId": item.get("candidateId"),
            "citation": item.get("citation"),
            "reason": item.get("reason"),
            "score": item.get("score"),
        }
        for item in top_results[:limit]
    ]


def _budget_metadata_presence(query: Dict[str, Any]) -> Dict[str, Any]:
    compiler = _compiler(query)
    missing_fields: List[str] = []
    if not compiler:
        missing_fields.append("compiler")
        return {
            "passed": False,
            "budget": None,
            "retrievalBudget": query.get("retrievalBudget"),
            "missingFields": missing_fields,
            "matchesRetrievalBudget": None,
        }
    token_pack = compiler.get("tokenPack")
    if not isinstance(token_pack, dict):
        missing_fields.append("compiler.tokenPack")
        budget = None
    else:
        budget = token_pack.get("budget")
        if not isinstance(budget, dict):
            missing_fields.append("compiler.tokenPack.budget")
            budget = None
    if isinstance(budget, dict):
        for field in ("maxItems", "maxTokens"):
            if field not in budget:
                missing_fields.append(f"compiler.tokenPack.budget.{field}")
    retrieval_budget = query.get("retrievalBudget")
    matches = None
    if isinstance(budget, dict) and isinstance(retrieval_budget, dict) and not missing_fields:
        matches = budget.get("maxItems") == retrieval_budget.get("maxItems") and budget.get("maxTokens") == retrieval_budget.get("maxTokens")
    return {
        "passed": not missing_fields and matches is not False,
        "budget": budget,
        "retrievalBudget": retrieval_budget,
        "missingFields": missing_fields,
        "matchesRetrievalBudget": matches,
    }


def _precision_at_budget(top_results: List[Dict[str, Any]], relevant_paths: List[str], required_sources: List[str], limit: int) -> Dict[str, Any]:
    considered = top_results[:limit]
    relevant = set(relevant_paths or required_sources)
    if not considered:
        precision = 1.0 if not relevant else 0.0
    else:
        precision = len([item for item in considered if item.get("path") in relevant]) / len(considered)
    noisy = [item for item in considered if item.get("path") not in relevant]
    dropped_required = [path for path in required_sources if path not in {str(item.get("path")) for item in considered}]
    return {
        "precision": round(precision, 6),
        "budget": {"maxItems": limit, "maxTokens": None},
        "relevantSources": sorted(relevant),
        "droppedRequiredSources": dropped_required,
        "noisyCandidates": [
            {
                "path": item.get("path"),
                "candidateId": item.get("candidateId"),
                "rank": item.get("rank"),
                "reason": item.get("reason"),
            }
            for item in noisy
        ],
    }


def _dedupe_paths(items: Iterable[Dict[str, Any]]) -> List[str]:
    """Distinct candidate paths in first-seen (rank) order, skipping blanks.

    Collapses the many chunks a single file contributes down to one file entry,
    so the file-level metrics below score FILES, not chunks.
    """
    seen: Set[str] = set()
    ordered: List[str] = []
    for item in items:
        path = str(item.get("path") or "")
        if path and path not in seen:
            seen.add(path)
            ordered.append(path)
    return ordered


def _file_level_precision(
    ranked_results: List[Dict[str, Any]],
    packed_results: List[Dict[str, Any]],
    relevant_paths: List[str],
    required_sources: List[str],
) -> Dict[str, Any]:
    """File-level companion to ``_precision_at_budget`` (issue #1044).

    ``precision_at_budget`` is CHUNK-level: it scores the ~10 packed chunks, so a
    single relevant file that only has 4 chunks caps the score at 0.40 even when
    retrieval is perfect.  The 0.75-0.85 precision figures quoted for coding
    agents are FILE-level, so this reports the file-level view the benchmark
    actually uses, alongside (never replacing) the chunk-level number:

      ``rPrecision``      standard IR R-precision — of the top-R DISTINCT files
                          in the ranked retrieval (R = number of relevant
                          files), how many are relevant.  Directly comparable to
                          the 0.75-0.85 coding-agent benchmark.
      ``precisionInPack`` of the distinct files the compiler actually packed,
                          how many are relevant.  ``precisionInPack`` low while
                          ``rPrecision`` is high means the ranker is fine but the
                          pack over-fills with noise (a packing problem, not a
                          ranking problem).
      ``recall``          of the relevant files, how many appear anywhere in the
                          pack.  Guard rail: precision gains are meaningless if
                          this drops — never optimise precision alone.

    Pure and deterministic: computed only from paths already in the result
    lists, so it is unit-testable without an index.
    """
    relevant = set(relevant_paths or required_sources)
    r = len(relevant)

    ranked_files = _dedupe_paths(ranked_results)
    considered = ranked_files[:r] if r else []
    r_precision = (len([path for path in considered if path in relevant]) / r) if r else 1.0

    pack_files = _dedupe_paths(packed_results)
    if pack_files:
        precision_in_pack = len([path for path in pack_files if path in relevant]) / len(pack_files)
    else:
        precision_in_pack = 1.0 if not relevant else 0.0

    packed = set(pack_files)
    recall = (len([path for path in relevant if path in packed]) / r) if r else 1.0

    return {
        "rPrecision": round(r_precision, 6),
        "precisionInPack": round(precision_in_pack, 6),
        "recall": round(recall, 6),
        "relevantFileCount": r,
        "rankedFilesConsidered": considered,
        "packFiles": pack_files,
        "noisyPackFiles": [path for path in pack_files if path not in relevant],
    }


def _mean_metric(fixtures: List[Dict[str, Any]], metric_path: Tuple[str, ...]) -> Optional[float]:
    """Mean of a (possibly nested) numeric metric across fixtures, or ``None`` if empty.

    ``metric_path`` walks into each fixture's ``metrics`` dict, e.g.
    ``("fileLevelPrecision", "rPrecision")``.  Missing or non-numeric values are
    skipped so one malformed fixture can't poison the corpus mean.  Booleans are
    excluded on purpose (``True`` is an ``int`` in Python but not a score).
    """
    values: List[float] = []
    for fixture in fixtures:
        node: Any = fixture.get("metrics", {})
        for key in metric_path:
            if not isinstance(node, dict):
                node = None
                break
            node = node.get(key)
        if isinstance(node, (int, float)) and not isinstance(node, bool):
            values.append(float(node))
    return round(sum(values) / len(values), 6) if values else None


def _graph_expansion_metrics(query: Dict[str, Any], expected_graph_sources: List[str]) -> Dict[str, Any]:
    compiler = _compiler(query)
    expansion = compiler.get("graphExpansion") if compiler else None
    if not isinstance(expansion, dict):
        return {
            "passed": not expected_graph_sources,
            "status": "missing",
            "maxHops": None,
            "startedFromAnchors": [],
            "addedCandidateIds": [],
            "missingExpectedSources": expected_graph_sources,
        }
    added = [str(value) for value in expansion.get("addedCandidateIds") or []]
    missing = [path for path in expected_graph_sources if path not in added]
    return {
        "passed": not missing and (not expected_graph_sources or expansion.get("status") == "expanded"),
        "status": expansion.get("status"),
        "maxHops": expansion.get("maxHops"),
        "startedFromAnchors": expansion.get("startedFromAnchors") or [],
        "addedCandidateIds": added,
        "missingExpectedSources": missing,
        "excludedExpansionCandidates": expansion.get("excludedExpansionCandidates") or [],
        "demotedExpansionCandidates": expansion.get("demotedExpansionCandidates") or [],
    }


def _candidate_leaks(candidate: Dict[str, Any]) -> bool:
    policy = candidate.get("policy")
    if not isinstance(policy, dict):
        return False
    return policy.get("visibility") == "denied" or policy.get("authority") == "denied" or policy.get("freshness") in {"stale", "expired"}


def _add_leak(leaks: List[Dict[str, Any]], seen: Set[str], *, path: Any, candidate_id: Any = None, reason: str) -> None:
    key = str(path or candidate_id)
    if key in seen:
        return
    seen.add(key)
    leaks.append({"path": path, "candidateId": candidate_id, "reason": reason})


def _stale_or_denied_leakage(query: Dict[str, Any], selected_candidates: List[Dict[str, Any]], expected_excluded: List[str], included_paths: Set[str]) -> Dict[str, Any]:
    leaks: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for path in expected_excluded:
        if path in included_paths:
            _add_leak(leaks, seen, path=path, reason="expected excluded source appeared in included results")
    for candidate in selected_candidates:
        if _candidate_leaks(candidate):
            _add_leak(leaks, seen, path=candidate.get("path"), candidate_id=candidate.get("id"), reason="compiler policy marks selected candidate stale or denied")
    compiler = _compiler(query)
    compiler_leakage = ((compiler or {}).get("metrics") or {}).get("staleOrDeniedLeakage")
    if isinstance(compiler_leakage, dict):
        for item in compiler_leakage.get("items") or []:
            if isinstance(item, dict):
                _add_leak(leaks, seen, path=item.get("path"), candidate_id=item.get("candidateId"), reason="compiler metrics reported stale or denied leakage")
        for path in compiler_leakage.get("paths") or []:
            _add_leak(leaks, seen, path=path, reason="compiler metrics reported stale or denied leakage")
    return {
        "passed": not leaks,
        "expectedExcludedSources": expected_excluded,
        "leaked": [str(item.get("path") or item.get("candidateId")) for item in leaks if item.get("path") or item.get("candidateId")],
        "items": leaks,
    }


def _provider_env_ready(fixture: Dict[str, Any], target_dir: Path) -> bool:
    required_env = fixture.get("optionalProviderEnv", [])
    if required_env:
        return all(os.environ.get(name) for name in required_env)
    cfg = read_context_config(target_dir).embedding
    if cfg.mode == "openai-compatible":
        return bool(os.environ.get(cfg.apiKeyEnv or "OPENAI_API_KEY"))
    return cfg.mode in {"disabled", "custom-command"}


def _evaluate_fixture(target_dir: Path, fixture: Dict[str, Any]) -> Dict[str, Any]:
    optional_env = fixture.get("optionalProviderEnv", [])
    if optional_env and not _provider_env_ready(fixture, target_dir):
        return {
            "name": fixture["name"],
            "task": fixture["task"],
            "status": "skipped",
            "skipReason": f"missing provider environment: {', '.join(optional_env)}",
            "metrics": {},
            "failures": [],
        }

    cfg = read_context_config(target_dir).embedding
    if cfg.mode != "disabled":
        if not _provider_env_ready(fixture, target_dir):
            return {
                "name": fixture["name"],
                "task": fixture["task"],
                "status": "skipped",
                "skipReason": "embedding provider environment is not configured",
                "metrics": {},
                "failures": [],
            }
        embed_context(target_dir)

    fixture_limit = int(fixture.get("limit") or 10)
    query = query_context(target_dir, fixture["task"], limit=fixture_limit)
    results = query.get("results", [])
    selected_candidates = _selected_compiler_candidates(query)
    included_paths = _included_paths(query, results)
    result_paths = _paths(results)
    top_results = _top_result_details(query, results)
    top5 = set(result_paths[:5])
    top10 = set(result_paths[:10])
    all_result_paths = set(included_paths)
    required = _unique(list(fixture.get("requiredSources", [])) or _expected_included(fixture))
    expected = _expected_included(fixture)
    excluded = _unique(fixture.get("expectedExcludedSources", []))
    missing_required = [path for path in required if path not in all_result_paths]
    leaked_excluded = [path for path in excluded if path in all_result_paths]
    citation_coverage = _field_coverage(top_results, "citation")
    reason_coverage = _field_coverage(top_results, "reason")
    budget_metadata = _budget_metadata_presence(query)
    graph_expansion = _graph_expansion_metrics(query, fixture.get("expectedGraphExpandedSources", []))
    precision_at_budget = _precision_at_budget(top_results, _unique(expected + required), required, fixture_limit)
    file_level_precision = _file_level_precision(results, top_results, _unique(expected + required), required)
    stale_or_denied_leakage = _stale_or_denied_leakage(query, selected_candidates, excluded, all_result_paths)
    failures: List[str] = []
    failure_details: List[Dict[str, Any]] = []
    if missing_required:
        failures.append(f"missing required sources: {', '.join(missing_required)}")
        for path in missing_required:
            failure_details.append(
                {
                    "kind": "missing_required_source",
                    "fixture": fixture["name"],
                    "expectedPath": path,
                    "nearestIncludedCandidates": _nearest_candidates(top_results),
                }
            )
    if leaked_excluded:
        failures.append(f"excluded sources appeared in results: {', '.join(leaked_excluded)}")
        for path in leaked_excluded:
            failure_details.append({"kind": "excluded_source_included", "fixture": fixture["name"], "path": path})
    if citation_coverage["missing"]:
        failures.append(f"top results missing citations: {', '.join(_describe_top_result(item) for item in citation_coverage['missing'])}")
        failure_details.append({"kind": "citation_coverage", "fixture": fixture["name"], "missingCandidates": citation_coverage["missing"]})
    if reason_coverage["missing"]:
        failures.append(f"top results missing reasons: {', '.join(_describe_top_result(item) for item in reason_coverage['missing'])}")
        failure_details.append({"kind": "reason_coverage", "fixture": fixture["name"], "missingCandidates": reason_coverage["missing"]})
    if not stale_or_denied_leakage["passed"]:
        failures.append(f"leaked denied/stale sources: {', '.join(stale_or_denied_leakage['leaked'])}")
        failure_details.append({"kind": "stale_or_denied_leakage", "fixture": fixture["name"], "leaked": stale_or_denied_leakage["items"]})
    if not budget_metadata["passed"]:
        if budget_metadata["missingFields"]:
            failures.append(f"missing compiler budget metadata: {', '.join(budget_metadata['missingFields'])}")
        else:
            failures.append(f"compiler budget metadata does not match retrievalBudget: compiler={budget_metadata['budget']} retrievalBudget={budget_metadata['retrievalBudget']}")
        failure_details.append({"kind": "budget_metadata", "fixture": fixture["name"], **budget_metadata})
    if not graph_expansion["passed"]:
        failures.append(f"graph expansion missing expected sources: {', '.join(graph_expansion['missingExpectedSources'])}")
        failure_details.append(
            {
                "kind": "graph_expansion",
                "fixture": fixture["name"],
                "missingExpectedSources": graph_expansion["missingExpectedSources"],
                "status": graph_expansion["status"],
                "maxHops": graph_expansion["maxHops"],
                "startedFromAnchors": graph_expansion["startedFromAnchors"],
                "addedCandidateIds": graph_expansion["addedCandidateIds"],
                "budgetImpact": precision_at_budget,
            }
        )
    min_precision = float(fixture.get("minPrecisionAtBudget") or 0.0)
    if precision_at_budget["precision"] < min_precision:
        failures.append(
            "precision at budget below threshold: "
            f"precision={precision_at_budget['precision']} min={min_precision} "
            f"droppedRequiredSources={', '.join(precision_at_budget['droppedRequiredSources']) or 'none'} "
            f"noisyCandidates={', '.join(str(item.get('path')) for item in precision_at_budget['noisyCandidates']) or 'none'}"
        )
        failure_details.append({"kind": "precision_at_budget", "fixture": fixture["name"], "minimum": min_precision, **precision_at_budget})
    metrics = {
        "requiredSourceInclusion": {
            "passed": not missing_required,
            "required": required,
            "missing": missing_required,
        },
        "recallAt5": round(_recall(expected, top5), 6),
        "recallAt10": round(_recall(expected, top10), 6),
        "staleSourceExclusion": {
            "passed": not leaked_excluded,
            "expectedExcludedSources": excluded,
            "leaked": leaked_excluded,
        },
        "citationCoverage": round(citation_coverage["coverage"], 6),
        "reasonCoverage": round(reason_coverage["coverage"], 6),
        "staleOrDeniedLeakage": stale_or_denied_leakage,
        "budgetMetadataPresence": budget_metadata,
        "graphExpansion": graph_expansion,
        "precisionAtBudget": precision_at_budget,
        "fileLevelPrecision": file_level_precision,
    }
    return {
        "name": fixture["name"],
        "task": fixture["task"],
        "status": "passed" if not failures else "failed",
        "provider": query.get("provider"),
        "metrics": metrics,
        "failures": failures,
        "failureDetails": failure_details,
        "topResults": top_results,
        "excluded": query.get("excluded", []),
    }


# ---------------------------------------------------------------------------
# Plain-grep baseline arm (issue #935)
#
# A naive, pure-Python keyword retriever over the target repo, used so the
# Context Compiler's recall/precision become COMPARATIVE rather than standalone.
# It deliberately does NOT shell out to grep/rg/find: pure Python keeps it
# deterministic (stable ordering) and portable, and the offline eval harness
# blocks those binaries anyway.  It reuses the same recall/precision helpers as
# the AgentRail arm so the two arms are measured on equal terms.
# ---------------------------------------------------------------------------

# Directories that a plain grep over a working tree would never usefully scan;
# excluding them keeps the baseline fast and deterministic without privileging
# AgentRail's own indexing.
_GREP_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".agentrail",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}

# A plain grep matches text files; skip obviously binary / large blobs so the
# baseline stays a keyword match rather than a binary scan.
_GREP_MAX_FILE_BYTES = 262144
_GREP_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


def _grep_query_tokens(query_terms: Iterable[str]) -> List[str]:
    """Lower-cased, de-duplicated alphanumeric tokens drawn from the fixture query."""
    tokens: List[str] = []
    seen: Set[str] = set()
    for term in query_terms:
        if not term:
            continue
        for match in _GREP_TOKEN_RE.findall(str(term)):
            token = match.lower()
            if token and token not in seen:
                seen.add(token)
                tokens.append(token)
    return tokens


def _grep_relpath(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def grep_baseline_paths(
    target_dir: Path,
    query_terms: Iterable[str],
    limit: int = 10,
    exclude: Optional[Set[Path]] = None,
) -> List[str]:
    """Return up to ``limit`` repo-relative paths a naive keyword grep would surface.

    For every text file under ``target_dir`` (excluding VCS/build noise), count how
    many distinct query tokens appear (case-insensitive substring match) in the
    file's contents.  Files with at least one hit are ranked by hit-count desc,
    then path asc, so the result is fully deterministic.

    ``exclude`` is a set of absolute paths the baseline must NOT scan — used to keep
    the eval's own fixture/answer-key file out of the searched corpus, so the
    baseline is measured against the repo a real grep would see (not against the
    answer key, which would unfairly depress grep's numbers and inflate AgentRail's
    relative edge).
    """
    root = target_dir.resolve()
    tokens = _grep_query_tokens(query_terms)
    if not tokens:
        return []
    excluded = {path.resolve() for path in (exclude or set())}
    scored: List[tuple[int, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune excluded directories in place; sort for deterministic traversal.
        # Also skip any hidden dot-dir (name starts with "."): on a dev machine
        # these hold gitignored agent-scratch (`.claude/worktrees/agent-*`,
        # `.codex-review/pr-*`, `.afk-workflow/`) — full-repo copies that duplicate
        # every expected source and crowd the real files out of grep's top-k. The
        # real AgentRail index never walks them, so pruning them keeps the
        # grep-vs-AgentRail comparison honest on any machine.
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in _GREP_EXCLUDED_DIRS and not name.startswith(".")
        )
        for filename in sorted(filenames):
            file_path = Path(dirpath) / filename
            if file_path.resolve() in excluded:
                continue  # the eval's own fixture/answer key is not part of the repo under test
            try:
                if file_path.stat().st_size > _GREP_MAX_FILE_BYTES:
                    continue
                text = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue  # binary or unreadable: a plain text grep skips it
            haystack = text.lower()
            hits = sum(1 for token in tokens if token in haystack)
            if hits:
                scored.append((hits, _grep_relpath(root, file_path)))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [path for _, path in scored[:limit]]


def _grep_baseline_fixture(
    target_dir: Path, fixture: Dict[str, Any], exclude: Optional[Set[Path]] = None
) -> Dict[str, Any]:
    fixture_limit = int(fixture.get("limit") or 10)
    expected = _expected_included(fixture)
    required = _unique(list(fixture.get("requiredSources", [])) or expected)
    paths = grep_baseline_paths(target_dir, [fixture["task"]], limit=fixture_limit, exclude=exclude)
    top5 = set(paths[:5])
    top10 = set(paths[:10])
    top_results = [{"path": path, "rank": index} for index, path in enumerate(paths, 1)]
    precision_at_budget = _precision_at_budget(top_results, _unique(expected + required), required, fixture_limit)
    # Grep returns one flat ranked list of files (no compiler pack), so the ranked
    # and packed lists are the same here.
    file_level_precision = _file_level_precision(top_results, top_results, _unique(expected + required), required)
    return {
        "name": fixture["name"],
        "task": fixture["task"],
        "arm": "plain-grep",
        "metrics": {
            "recallAt5": round(_recall(expected, top5), 6),
            "recallAt10": round(_recall(expected, top10), 6),
            "precisionAtBudget": precision_at_budget,
            "fileLevelPrecision": file_level_precision,
        },
        "selectedPaths": paths,
    }


def evaluate_grep_baseline(
    target_dir: Path, fixtures: List[Dict[str, Any]], exclude: Optional[Set[Path]] = None
) -> Dict[str, Any]:
    """Run the plain-grep baseline arm over the same (already-loaded) fixtures.

    Computes recall@5/recall@10 and precision-at-budget with the SAME helpers the
    AgentRail arm uses, so the two arms are directly comparable on identical
    fixtures.  Deterministic by construction.  ``exclude`` keeps the eval's own
    fixture/answer-key file out of the searched corpus.
    """
    root = target_dir.resolve()
    return {
        "arm": "plain-grep",
        "fixtures": [_grep_baseline_fixture(root, fixture, exclude=exclude) for fixture in fixtures],
    }


def evaluate_retrieval(target_dir: Path, fixture_file: Path) -> Dict[str, Any]:
    root = target_dir.resolve()
    fixtures_path = fixture_file if fixture_file.is_absolute() else root / fixture_file
    fixtures = load_fixtures(fixtures_path)
    fixture_reports = [_evaluate_fixture(root, fixture) for fixture in fixtures]
    failed = [item for item in fixture_reports if item["status"] == "failed"]
    skipped = [item for item in fixture_reports if item["status"] == "skipped"]
    # The eval's own fixture file is not part of the repo a real grep would search;
    # exclude it so the baseline is honest (it would otherwise rank as the top hit
    # on every query and unfairly depress grep's recall/precision).
    grep_baseline = evaluate_grep_baseline(root, fixtures, exclude={fixtures_path.resolve()})
    scored = [item for item in fixture_reports if item["status"] != "skipped"]
    return {
        "schemaVersion": 1,
        "command": "context.evaluate",
        "target": {"kind": "evaluation", "fixturePath": str(fixture_file)},
        "generatedAt": _now(),
        "provider": {"mode": read_context_config(root).embedding.mode},
        "summary": {
            "fixtures": len(fixture_reports),
            "passed": len([item for item in fixture_reports if item["status"] == "passed"]),
            "failed": len(failed),
            "skipped": len(skipped),
            # Corpus-level means over scored (non-skipped) fixtures. chunkPrecisionAtBudget
            # is the harsh pack-of-10 headline; fileRPrecision is the benchmark-comparable
            # file-level ranking quality (compare to the 0.75-0.85 coding-agent band);
            # fileRecall is the guard rail that must not drop when precision is tuned.
            "means": {
                "chunkPrecisionAtBudget": _mean_metric(scored, ("precisionAtBudget", "precision")),
                "fileRPrecision": _mean_metric(scored, ("fileLevelPrecision", "rPrecision")),
                "filePrecisionInPack": _mean_metric(scored, ("fileLevelPrecision", "precisionInPack")),
                "fileRecall": _mean_metric(scored, ("fileLevelPrecision", "recall")),
                "recallAt10": _mean_metric(scored, ("recallAt10",)),
            },
        },
        "fixtures": fixture_reports,
        "grepBaseline": grep_baseline,
        "passed": not failed,
    }


def format_evaluation_report(report: Dict[str, Any]) -> str:
    lines = [
        "Retrieval Evaluation",
        f"fixtures={report['summary']['fixtures']} passed={report['summary']['passed']} failed={report['summary']['failed']} skipped={report['summary']['skipped']}",
    ]
    means = report["summary"].get("means")
    if means:
        lines.append(
            "means: "
            f"chunkPrecisionAtBudget={means.get('chunkPrecisionAtBudget')} "
            f"fileRPrecision={means.get('fileRPrecision')} "
            f"filePrecisionInPack={means.get('filePrecisionInPack')} "
            f"fileRecall={means.get('fileRecall')} "
            f"recall@10={means.get('recallAt10')}"
        )
    grep_by_name = {
        item["name"]: item
        for item in (report.get("grepBaseline") or {}).get("fixtures", [])
    }
    for fixture in report["fixtures"]:
        if fixture["status"] == "skipped":
            lines.append(f"- {fixture['name']}: skipped ({fixture['skipReason']})")
            continue
        metrics = fixture["metrics"]
        lines.append(
            f"- {fixture['name']}: {fixture['status']} "
            f"requiredSourceInclusion={metrics['requiredSourceInclusion']['passed']} "
            f"recall@5={metrics['recallAt5']} "
            f"recall@10={metrics['recallAt10']} "
            f"staleSourceExclusion={metrics['staleSourceExclusion']['passed']} "
            f"staleOrDeniedLeakage={metrics['staleOrDeniedLeakage']['passed']} "
            f"citationCoverage={metrics['citationCoverage']} "
            f"reasonCoverage={metrics['reasonCoverage']} "
            f"budgetMetadataPresence={metrics['budgetMetadataPresence']['passed']} "
            f"graphExpansion={metrics['graphExpansion']['passed']} "
            f"precisionAtBudget={metrics['precisionAtBudget']['precision']} "
            f"fileRPrecision={metrics.get('fileLevelPrecision', {}).get('rPrecision')} "
            f"filePrecisionInPack={metrics.get('fileLevelPrecision', {}).get('precisionInPack')} "
            f"fileRecall={metrics.get('fileLevelPrecision', {}).get('recall')}"
        )
        # Comparative arm: show AgentRail's recall/precision next to plain-grep's
        # on the SAME fixture so the numbers are not standalone (issue #935).
        grep = grep_by_name.get(fixture["name"])
        if grep is not None:
            grep_metrics = grep["metrics"]
            lines.append(
                f"  arms: "
                f"agentrail[recall@5={metrics['recallAt5']} recall@10={metrics['recallAt10']} "
                f"precisionAtBudget={metrics['precisionAtBudget']['precision']} "
                f"fileRPrecision={metrics.get('fileLevelPrecision', {}).get('rPrecision')}] "
                f"vs plain-grep[recall@5={grep_metrics['recallAt5']} recall@10={grep_metrics['recallAt10']} "
                f"precisionAtBudget={grep_metrics['precisionAtBudget']['precision']} "
                f"fileRPrecision={grep_metrics.get('fileLevelPrecision', {}).get('rPrecision')}]"
            )
        for failure in fixture["failures"]:
            lines.append(f"  failure: {failure}")
        for detail in fixture.get("failureDetails", []):
            lines.append(f"  detail: {json.dumps(detail, sort_keys=True)}")
    return "\n".join(lines)
