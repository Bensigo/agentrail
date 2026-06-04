from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set

from agentrail.context.config import read_context_config
from agentrail.context.embeddings import embed_context
from agentrail.context.retrieval import query_context


FIXTURE_KEYS = [
    "expectedFiles",
    "expectedDocs",
    "expectedMemory",
    "expectedPriorMistakes",
    "expectedExcludedSources",
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


def _recall(expected: List[str], paths: Set[str]) -> float:
    if not expected:
        return 1.0
    return len([path for path in expected if path in paths]) / len(expected)


def _citation_coverage(results: List[Dict[str, Any]]) -> float:
    if not results:
        return 1.0
    cited = [item for item in results if item.get("citation")]
    return len(cited) / len(results)


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

    query = query_context(target_dir, fixture["task"], limit=max(10, int(fixture.get("limit") or 10)))
    results = query.get("results", [])
    result_paths = _paths(results)
    top5 = set(result_paths[:5])
    top10 = set(result_paths[:10])
    all_result_paths = set(result_paths)
    required = _unique(list(fixture.get("requiredSources", [])) or _expected_included(fixture))
    expected = _expected_included(fixture)
    excluded = _unique(fixture.get("expectedExcludedSources", []))
    missing_required = [path for path in required if path not in all_result_paths]
    leaked_excluded = [path for path in excluded if path in all_result_paths]
    citation_coverage = _citation_coverage(results[:10])
    failures: List[str] = []
    if missing_required:
        failures.append(f"missing required sources: {', '.join(missing_required)}")
    if leaked_excluded:
        failures.append(f"excluded sources appeared in results: {', '.join(leaked_excluded)}")
    if citation_coverage < 1:
        failures.append("one or more top-10 results are missing citations")
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
        "citationCoverage": round(citation_coverage, 6),
    }
    return {
        "name": fixture["name"],
        "task": fixture["task"],
        "status": "passed" if not failures else "failed",
        "provider": query.get("provider"),
        "metrics": metrics,
        "failures": failures,
        "topResults": [
            {"rank": item.get("rank"), "path": item.get("path"), "citation": item.get("citation"), "reason": item.get("reason"), "score": item.get("score", {}).get("final")}
            for item in results[:10]
        ],
        "excluded": query.get("excluded", []),
    }


def evaluate_retrieval(target_dir: Path, fixture_file: Path) -> Dict[str, Any]:
    root = target_dir.resolve()
    fixtures_path = fixture_file if fixture_file.is_absolute() else root / fixture_file
    fixtures = load_fixtures(fixtures_path)
    fixture_reports = [_evaluate_fixture(root, fixture) for fixture in fixtures]
    failed = [item for item in fixture_reports if item["status"] == "failed"]
    skipped = [item for item in fixture_reports if item["status"] == "skipped"]
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
        },
        "fixtures": fixture_reports,
        "passed": not failed,
    }


def format_evaluation_report(report: Dict[str, Any]) -> str:
    lines = [
        "Retrieval Evaluation",
        f"fixtures={report['summary']['fixtures']} passed={report['summary']['passed']} failed={report['summary']['failed']} skipped={report['summary']['skipped']}",
    ]
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
            f"citationCoverage={metrics['citationCoverage']}"
        )
        for failure in fixture["failures"]:
            lines.append(f"  failure: {failure}")
    return "\n".join(lines)
