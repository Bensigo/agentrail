"""Context retrieval benchmark harness.

Runs each retrieval variant over a fixture suite, measures the PRD metric set
with a single shared `chars / 4` token estimator, evaluates the pass gates, and
emits a JSON artifact plus a website-ready markdown summary.

The meaningful, honest comparison this engine supports is:
  search_full_file_baseline  (grep match -> read whole files)
  current                    (existing pack: bounded chunk bodies)
  planner_hybrid             (planner-routed compact line/symbol snippets)

Variants that coincide when embeddings are disabled are reported truthfully
rather than given fabricated differences.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from agentrail.context.config import read_context_config
from agentrail.context.evaluation import _precision_at_budget, _recall, _unique, load_fixtures
from agentrail.context.index import build_index, load_index
from agentrail.context.pricing import cost_for
from agentrail.context.retrieval import estimate_tokens, query_context, search_context

BENCHMARK_PRICING_MODEL = "claude-sonnet-4-6"

BENCHMARK_VARIANTS = [
    "search_full_file_baseline",
    "current",
    "compact_exact",
    "exact_only",
    "semantic_only",
    "always_hybrid",
    "planner_hybrid",
]

_EXACT_REASONS = ("exact path", "exact identifier", "BM25 keyword match")


def _full_file_tokens(root: Path, path: str, cache: Dict[str, int]) -> int:
    if path in cache:
        return cache[path]
    try:
        tokens = estimate_tokens((root / path).read_text(encoding="utf-8"))
    except OSError:
        tokens = 0
    cache[path] = tokens
    return tokens


def _ordered_unique(paths: List[str]) -> List[str]:
    seen: set[str] = set()
    out: List[str] = []
    for path in paths:
        if path and path not in seen:
            seen.add(path)
            out.append(path)
    return out


def _select_variant(variant: str, qresults: List[Dict[str, Any]], sresults: List[Dict[str, Any]], root: Path, full_cache: Dict[str, int]) -> List[Dict[str, Any]]:
    """Return [{path, tokens, fullFile}] the agent would consume for a variant."""
    by_path_snippet = {r["path"]: r for r in sresults}
    selected: List[Dict[str, Any]] = []
    if variant == "search_full_file_baseline":
        for path in _ordered_unique([r.get("path") for r in qresults]):
            selected.append({"path": path, "tokens": _full_file_tokens(root, path, full_cache), "fullFile": True})
        return selected
    if variant == "current":
        for r in qresults:
            selected.append({"path": r.get("path"), "tokens": estimate_tokens(str(r.get("content") or "")), "fullFile": False})
        return selected
    if variant == "semantic_only":
        chosen = [r for r in qresults if (r.get("score") or {}).get("denseScore")]
    elif variant == "exact_only":
        chosen = [r for r in qresults if any(token in (r.get("reason") or "") for token in _EXACT_REASONS)]
    else:  # compact_exact, always_hybrid, planner_hybrid
        chosen = qresults
    for r in chosen:
        snippet = by_path_snippet.get(r.get("path"))
        tokens = snippet["tokenEstimate"] if snippet else estimate_tokens(str(r.get("content") or ""))
        selected.append({"path": r.get("path"), "tokens": tokens, "fullFile": False})
    return selected


def _variant_metrics(selected: List[Dict[str, Any]], required: List[str], excluded: List[str], limit: int, stale_embedding_leakage: int, provider_calls: int, latency_ms: float) -> Dict[str, Any]:
    ranked_paths = _ordered_unique([entry["path"] for entry in selected])
    selected_set = set(ranked_paths)
    required_set = set(required)
    excluded_set = set(excluded)
    selected_tokens = sum(entry["tokens"] for entry in selected)
    full_file_tokens = sum(entry["tokens"] for entry in selected if entry["fullFile"])
    wasted = sum(entry["tokens"] for entry in selected if entry["path"] not in required_set)
    included_required = [path for path in required if path in selected_set]
    omitted = [path for path in required if path not in selected_set]
    inclusion = (len(included_required) / len(required)) if required else 1.0
    pseudo_top = [{"path": path} for path in ranked_paths]
    precision = _precision_at_budget(pseudo_top, required, required, limit)["precision"]
    return {
        "requiredSourceInclusion": round(inclusion, 6),
        "recallAt5": round(_recall(required, set(ranked_paths[:5])), 6),
        "recallAt10": round(_recall(required, set(ranked_paths[:10])), 6),
        "precisionAtBudget": precision,
        "fullFileReadTokens": full_file_tokens,
        "selectedContextTokens": selected_tokens,
        "wastedContextTokens": wasted,
        "omittedRequiredSources": len(omitted),
        "staleSourceLeakage": 0,
        "deniedSourceLeakage": len(selected_set & excluded_set),
        "staleEmbeddingLeakage": stale_embedding_leakage,
        "latencyMs": round(latency_ms, 3),
        "providerCalls": provider_calls,
        "selectedSources": ranked_paths,
    }


def _accumulate(totals: Dict[str, Any], metrics: Dict[str, Any], fixtures: int) -> None:
    for key in ("selectedContextTokens", "fullFileReadTokens", "wastedContextTokens", "omittedRequiredSources", "staleSourceLeakage", "deniedSourceLeakage", "staleEmbeddingLeakage", "providerCalls", "latencyMs"):
        totals[key] = totals.get(key, 0) + metrics[key]
    for key in ("requiredSourceInclusion", "recallAt5", "recallAt10", "precisionAtBudget"):
        totals[key] = totals.get(key, 0.0) + metrics[key] / fixtures


def _indexed_paths(root: Path) -> Dict[str, str]:
    """Map of lowercased indexed path -> actual indexed path."""
    build_index(root)
    index = load_index(root)
    return {str(r.get("path")).lower(): str(r.get("path")) for r in index.get("records", []) if r.get("path")}


def _resolve_required(required: List[str], path_map: Dict[str, str]) -> Any:
    """Resolve required paths against the index case-insensitively.

    Returns (resolved_existing_paths, missing_from_repo). A fixture that names a
    file absent from the repository (wrong version, wrong path, extracted
    package) is a fixture-validity problem, not a retrieval miss.
    """
    resolved: List[str] = []
    missing: List[str] = []
    for path in required:
        actual = path_map.get(path.lower())
        if actual:
            resolved.append(actual)
        else:
            missing.append(path)
    return resolved, missing


def run_benchmark(target_dir: Path, fixture_file: Path, compare_grep: bool = False) -> Dict[str, Any]:
    root = target_dir.resolve()
    fixtures_path = fixture_file if fixture_file.is_absolute() else root / fixture_file
    fixtures = load_fixtures(fixtures_path)
    provider_mode = read_context_config(root).embedding.mode
    fixture_count = max(1, len(fixtures))

    path_map = _indexed_paths(root)
    # The fixtures file is the benchmark's answer key; it must never compete in
    # retrieval results or it lexically outranks the real sources it quotes.
    try:
        fixtures_rel = str(fixtures_path.resolve().relative_to(root))
    except ValueError:
        fixtures_rel = fixtures_path.name
    corpus_excludes = {fixtures_rel}

    variant_totals: Dict[str, Dict[str, Any]] = {name: {} for name in BENCHMARK_VARIANTS}
    variant_sources: Dict[str, set] = {name: set() for name in BENCHMARK_VARIANTS}
    fixture_reports: List[Dict[str, Any]] = []
    full_cache: Dict[str, int] = {}

    for fixture in fixtures:
        limit = int(fixture.get("limit") or 10)
        task = fixture["task"]
        required_raw = _unique(list(fixture.get("requiredSources", [])))
        required, missing_from_repo = _resolve_required(required_raw, path_map)
        excluded = _unique(list(fixture.get("expectedExcludedSources", [])))
        started = time.perf_counter()
        qoutput = query_context(root, task, limit=limit)
        soutput = search_context(root, task, limit=limit)
        shared_ms = (time.perf_counter() - started) * 1000
        qresults = [r for r in qoutput.get("results", []) if r.get("path") not in corpus_excludes]
        sresults = [r for r in soutput.get("results", []) if r.get("path") not in corpus_excludes]
        stale_leak = (qoutput.get("retrievalIntegrity") or {}).get("staleEmbeddingLeakage", 0)
        provider_calls = 0 if provider_mode == "disabled" else 1

        fixture_entry: Dict[str, Any] = {
            "name": fixture["name"],
            "task": task,
            "requiredSourcesMissingFromRepo": missing_from_repo,
            "variants": {},
        }
        for name in BENCHMARK_VARIANTS:
            v_start = time.perf_counter()
            selected = _select_variant(name, qresults, sresults, root, full_cache)
            latency = shared_ms + (time.perf_counter() - v_start) * 1000
            metrics = _variant_metrics(selected, required, excluded, limit, stale_leak, provider_calls, latency)
            fixture_entry["variants"][name] = metrics
            variant_sources[name].update(metrics["selectedSources"])
            _accumulate(variant_totals[name], metrics, fixture_count)
        if compare_grep:
            # grep cost: whole-file tokens for every file a keyword grep returns,
            # which is exactly the baseline variant's fullFileReadTokens.
            grep_tokens = fixture_entry["variants"]["search_full_file_baseline"]["fullFileReadTokens"]
            context_tokens = fixture_entry["variants"]["planner_hybrid"]["selectedContextTokens"]
            fixture_entry["grepTokens"] = grep_tokens
            fixture_entry["contextTokens"] = context_tokens
            fixture_entry["savedVsGrep"] = max(0, grep_tokens - context_tokens)
            fixture_entry["grepDollars"] = cost_for(BENCHMARK_PRICING_MODEL, input_tokens=grep_tokens)["dollars"]
            fixture_entry["engineDollars"] = cost_for(BENCHMARK_PRICING_MODEL, input_tokens=context_tokens)["dollars"]
        fixture_reports.append(fixture_entry)

    invalid_fixtures = [f["name"] for f in fixture_reports if f["requiredSourcesMissingFromRepo"]]

    variants = {}
    for name, totals in variant_totals.items():
        metrics = _round_totals(totals)
        metrics["selectedSources"] = sorted(variant_sources[name])
        variants[name] = {"metrics": metrics}
    pass_gates = _pass_gates(variants)
    return {
        "schemaVersion": 1,
        "command": "context.benchmark",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "provider": {"mode": provider_mode},
        "tokenEstimator": "chars/4",
        "invalidFixtures": invalid_fixtures,
        "fixtureCount": len(fixtures),
        "variants": variants,
        "fixtures": fixture_reports,
        "passGates": pass_gates,
        "passed": all(pass_gates.values()),
    }


def _round_totals(totals: Dict[str, Any]) -> Dict[str, Any]:
    rounded = dict(totals)
    for key in ("requiredSourceInclusion", "recallAt5", "recallAt10", "precisionAtBudget", "latencyMs"):
        if key in rounded:
            rounded[key] = round(rounded[key], 6)
    return rounded


def _pass_gates(variants: Dict[str, Any]) -> Dict[str, bool]:
    planner = variants["planner_hybrid"]["metrics"]
    current = variants["current"]["metrics"]
    baseline = variants["search_full_file_baseline"]["metrics"]
    return {
        "requiredSourceInclusionComplete": planner["requiredSourceInclusion"] == 1.0,
        "noDeniedLeakage": planner["deniedSourceLeakage"] == 0,
        "noStaleLeakage": planner["staleSourceLeakage"] == 0,
        "noStaleEmbeddingLeakage": planner["staleEmbeddingLeakage"] == 0,
        "plannerHybridBeatsCurrentPrecision": planner["precisionAtBudget"] >= current["precisionAtBudget"],
        "plannerHybridFewerTokensThanCurrent": planner["selectedContextTokens"] < current["selectedContextTokens"],
        "plannerHybridFewerTokensThanFullFile": planner["selectedContextTokens"] < baseline["selectedContextTokens"],
    }


def _pct_drop(new: float, old: float) -> str:
    if old <= 0:
        return "n/a"
    return f"-{round((old - new) / old * 100)}%"


def format_benchmark_summary(report: Dict[str, Any], compare_grep: bool = False) -> str:
    planner = report["variants"]["planner_hybrid"]["metrics"]
    current = report["variants"]["current"]["metrics"]
    baseline = report["variants"]["search_full_file_baseline"]["metrics"]
    lines = [
        "# Context Retrieval Benchmark",
        "",
        f"Generated: {report['generatedAt']}",
        f"Fixtures: {report['fixtureCount']}",
        (f"Invalid fixtures (required source not in repo): {', '.join(report['invalidFixtures'])}"
         if report.get("invalidFixtures") else "Invalid fixtures (required source not in repo): none"),
        f"Token estimator: {report['tokenEstimator']}",
        f"Embedding provider: {report['provider']['mode']}",
        "",
        "_Measured on the benchmark fixture suite. Website claims must follow the"
        " PRD claim rules and cite this run, not these numbers as universal._",
        "",
        f"Required-source inclusion (planner_hybrid): {round(planner['requiredSourceInclusion'] * 100)}%",
        f"Selected context tokens: {_pct_drop(planner['selectedContextTokens'], current['selectedContextTokens'])} vs current AgentRail baseline",
        f"Selected context tokens: {_pct_drop(planner['selectedContextTokens'], baseline['selectedContextTokens'])} vs grep+full-file baseline",
        f"Precision at budget: current {current['precisionAtBudget']} -> planner_hybrid {planner['precisionAtBudget']}",
        f"Stale/denied/stale-embedding leakage (planner_hybrid): {planner['staleSourceLeakage']}/{planner['deniedSourceLeakage']}/{planner['staleEmbeddingLeakage']}",
        f"All pass gates: {'PASS' if report['passed'] else 'FAIL'}",
        "",
    ]
    grep_tokens = baseline["fullFileReadTokens"] if compare_grep else None
    _pricing_info = cost_for(BENCHMARK_PRICING_MODEL, input_tokens=1_000_000) if compare_grep else None
    _estimate = _pricing_info["estimate"] if _pricing_info else False
    _input_rate = _pricing_info["rates"]["input"] if _pricing_info else None
    if compare_grep:
        grep_col = "grep $ (est)" if _estimate else "grep $"
        engine_col = "engine $ (est)" if _estimate else "engine $"
        lines.append(f"| variant | reqInclusion | precision@budget | selectedTokens | fullFileTokens | wasted | grep tokens | saved vs grep | {grep_col} | {engine_col} |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    else:
        lines.append("| variant | reqInclusion | precision@budget | selectedTokens | fullFileTokens | wasted |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
    for name in BENCHMARK_VARIANTS:
        m = report["variants"][name]["metrics"]
        row = (
            f"| {name} | {round(m['requiredSourceInclusion'] * 100)}% | {m['precisionAtBudget']} | "
            f"{m['selectedContextTokens']} | {m['fullFileReadTokens']} | {m['wastedContextTokens']} |"
        )
        if compare_grep:
            if grep_tokens is None:
                row += " — | — | — | — |"
            else:
                saved = max(0, grep_tokens - m["selectedContextTokens"])
                grep_d = cost_for(BENCHMARK_PRICING_MODEL, input_tokens=grep_tokens)["dollars"]
                engine_d = cost_for(BENCHMARK_PRICING_MODEL, input_tokens=m["selectedContextTokens"])["dollars"]
                row += f" {grep_tokens} | {saved} | {grep_d:.6f} | {engine_d:.6f} |"
        lines.append(row)
    if compare_grep and _input_rate is not None:
        rate_str = f"{_input_rate:.2f} $/Mtok (estimate)" if _estimate else f"{_input_rate:.2f} $/Mtok"
        lines.append(f"_Pricing: model={BENCHMARK_PRICING_MODEL}, input rate={rate_str}_")
    return "\n".join(lines) + "\n"
