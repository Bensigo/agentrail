from __future__ import annotations

import json
import os
import shutil
import signal
import statistics
import subprocess
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

from agentrail.context import daemon as daemon_mod
from agentrail.context.benchmark import (
    BENCHMARK_VARIANTS,
    format_benchmark_summary,
    run_benchmark,
)
from agentrail.context.client import _resolve_context_client
from agentrail.context.index import build_index
from agentrail.context.retrieval import query_context


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**", ".env"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": True, "action": "exclude", "denyGlobs": [".env"]},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "src").mkdir(parents=True)
    body = "\n".join(f"    detail_{n} = compute_{n}()" for n in range(60))
    (root / "src" / "widget.py").write_text(
        f"def alpha_token_handler():\n{body}\n    return alpha_token_handler\n", encoding="utf-8")
    (root / "src" / "unrelated.py").write_text("def something_else():\n    return 0\n", encoding="utf-8")
    (root / ".env").write_text("SECRET=must-not-appear\n", encoding="utf-8")
    return root


def write_fixtures(root: Path) -> Path:
    fixtures = {
        "schemaVersion": 1,
        "fixtures": [
            {
                "name": "alpha-token-handler",
                "task": "alpha_token_handler()",
                "requiredSources": ["src/widget.py"],
                "expectedExcludedSources": [".env"],
            }
        ],
    }
    path = root / "benchmark-fixtures.json"
    path.write_text(json.dumps(fixtures), encoding="utf-8")
    return path


class BenchmarkHarnessTests(unittest.TestCase):
    def test_runs_all_variants_with_full_metric_set(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        self.assertEqual(set(report["variants"].keys()), set(BENCHMARK_VARIANTS))
        metric_keys = {
            "requiredSourceInclusion", "recallAt5", "recallAt10", "precisionAtBudget",
            "fullFileReadTokens", "selectedContextTokens", "wastedContextTokens",
            "omittedRequiredSources", "staleSourceLeakage", "deniedSourceLeakage",
            "staleEmbeddingLeakage", "latencyMs", "providerCalls",
        }
        for name, variant in report["variants"].items():
            self.assertTrue(metric_keys.issubset(variant["metrics"].keys()), f"{name} missing metrics")

    def test_planner_hybrid_uses_fewer_tokens_than_full_file_baseline(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        planner = report["variants"]["planner_hybrid"]["metrics"]
        baseline = report["variants"]["search_full_file_baseline"]["metrics"]
        self.assertLess(planner["selectedContextTokens"], baseline["selectedContextTokens"])
        self.assertLess(planner["selectedContextTokens"], report["variants"]["current"]["metrics"]["selectedContextTokens"])

    def test_planner_hybrid_keeps_required_sources_and_no_leakage(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        planner = report["variants"]["planner_hybrid"]["metrics"]
        self.assertEqual(planner["requiredSourceInclusion"], 1.0)
        self.assertEqual(planner["deniedSourceLeakage"], 0)
        self.assertEqual(planner["staleEmbeddingLeakage"], 0)

    def test_flags_required_sources_missing_from_repo(self) -> None:
        root = make_repo()
        # Reference a missing file and a wrong-case file; both differ from what exists.
        fixtures = {
            "schemaVersion": 1,
            "fixtures": [{
                "name": "validity",
                "task": "alpha_token_handler()",
                "requiredSources": ["src/WIDGET.py", "src/ghost.py"],
                "expectedExcludedSources": [".env"],
            }],
        }
        path = root / "benchmark-fixtures.json"
        path.write_text(json.dumps(fixtures), encoding="utf-8")
        report = run_benchmark(root, path)
        fixture = report["fixtures"][0]
        # src/WIDGET.py resolves case-insensitively to src/widget.py -> NOT missing.
        # src/ghost.py truly does not exist -> flagged.
        self.assertIn("src/ghost.py", fixture["requiredSourcesMissingFromRepo"])
        self.assertNotIn("src/widget.py", fixture["requiredSourcesMissingFromRepo"])
        self.assertNotIn("src/WIDGET.py", fixture["requiredSourcesMissingFromRepo"])

    def test_fixtures_file_is_not_indexed_into_results(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        for name, variant in report["variants"].items():
            self.assertNotIn("benchmark-fixtures.json", variant["metrics"]["selectedSources"], f"{name} leaked the fixtures file")

    def test_pass_gates_and_summary_present(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        self.assertIn("passGates", report)
        self.assertIn("plannerHybridBeatsCurrentPrecision", report["passGates"])
        summary = format_benchmark_summary(report)
        self.assertIn("Context Retrieval Benchmark", summary)
        self.assertIn("planner_hybrid", summary)

    def test_compare_grep_populates_per_fixture_fields(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root), compare_grep=True)
        for fixture in report["fixtures"]:
            self.assertIsInstance(fixture["grepTokens"], int)
            self.assertIsInstance(fixture["contextTokens"], int)
            self.assertIsInstance(fixture["savedVsGrep"], int)
            self.assertGreaterEqual(fixture["savedVsGrep"], 0)

    def test_compare_grep_grep_tokens_match_baseline_full_file(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root), compare_grep=True)
        for fixture in report["fixtures"]:
            baseline = fixture["variants"]["search_full_file_baseline"]
            self.assertEqual(fixture["grepTokens"], baseline["fullFileReadTokens"])

    def test_without_compare_grep_no_new_fields(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        for fixture in report["fixtures"]:
            self.assertNotIn("grepTokens", fixture)
            self.assertNotIn("contextTokens", fixture)
            self.assertNotIn("savedVsGrep", fixture)

    def test_compare_grep_summary_has_columns(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root), compare_grep=True)
        summary = format_benchmark_summary(report, compare_grep=True)
        self.assertIn("grep tokens", summary)
        self.assertIn("saved vs grep", summary)

    def test_summary_without_compare_grep_has_no_grep_columns(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        summary = format_benchmark_summary(report)
        self.assertNotIn("grep tokens", summary)
        self.assertNotIn("saved vs grep", summary)


def _make_build_repo() -> Path:
    """Create a fixture repo with Python + TypeScript files for build-time benchmarking."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "src").mkdir(parents=True)
    # Python file — exercises tree-sitter python grammar
    (root / "src" / "service.py").write_text(
        "def parse(data):\n    return data\n\ndef validate(data):\n    return bool(data)\n\n"
        "class Handler:\n    def handle(self, req):\n        return parse(req)\n",
        encoding="utf-8",
    )
    # TypeScript file — exercises tree-sitter typescript grammar
    (root / "src" / "client.ts").write_text(
        "function fetch(url: string): string {\n    return url;\n}\n\n"
        "class ApiClient {\n    get(url: string): string {\n        return fetch(url);\n    }\n}\n",
        encoding="utf-8",
    )
    return root


def _timed_build(root: Path, iterations: int = 3) -> float:
    """Return median wall-clock build time (seconds) over N cache-isolated runs."""
    times: list[float] = []
    for _ in range(iterations):
        index_dir = root / ".agentrail" / "context" / "index"
        if index_dir.exists():
            shutil.rmtree(index_dir)
        t0 = time.perf_counter()
        build_index(root)
        times.append(time.perf_counter() - t0)
    return statistics.median(times)


class BuildTimeBenchmarkTests(unittest.TestCase):
    """AC3 (M018): index build time with tree-sitter <= 2× pre-tree-sitter (regex) baseline."""

    def test_build_time_within_2x_of_pre_tree_sitter(self) -> None:
        """Build identical fixture repos with and without tree-sitter; assert 2× bound."""
        root_baseline = _make_build_repo()
        root_ts = _make_build_repo()

        # Pre-tree-sitter baseline: monkeypatch grammar_for → None so extracted_symbols
        # always falls back to the regex path (identical to the pre-swap code path).
        with unittest.mock.patch(
            "agentrail.context.index.grammar_for", return_value=None
        ):
            baseline_s = _timed_build(root_baseline)

        # Tree-sitter path: unpatched.
        ts_s = _timed_build(root_ts)

        ratio = ts_s / baseline_s if baseline_s > 0 else 1.0

        # Print results table (visible with pytest -s; copy into PR body as evidence).
        print("\n")
        print("## Build-time benchmark (M018 tree-sitter verification)")
        print("")
        print(f"| variant          | median build time (s) | ratio vs baseline |")
        print(f"|------------------|-----------------------|-------------------|")
        print(f"| regex_fallback   | {baseline_s:.4f}                | 1.00              |")
        print(f"| tree_sitter      | {ts_s:.4f}                | {ratio:.2f}              |")
        print(f"| threshold        | baseline × 2.0        | ≤ 2.00             |")
        print("")

        self.assertLessEqual(
            ts_s,
            baseline_s * 2.0,
            f"tree-sitter build ({ts_s:.4f}s) exceeded 2× baseline ({baseline_s:.4f}s). "
            f"ratio={ratio:.2f}",
        )


def _make_cold_query_repo() -> Path:
    """Fixture repo with enough content to exercise the cold query path."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "src").mkdir(parents=True)
    body = "\n".join(f"    detail_{n} = compute_{n}()" for n in range(60))
    (root / "src" / "widget.py").write_text(
        f"def alpha_token_handler():\n{body}\n    return alpha_token_handler\n", encoding="utf-8")
    (root / "src" / "unrelated.py").write_text("def something_else():\n    return 0\n", encoding="utf-8")
    return root


def _percentile(data: list[float], p: float) -> float:
    """Return the p-th percentile (0–100) of data via linear interpolation."""
    sorted_data = sorted(data)
    n = len(sorted_data)
    if n == 0:
        return 0.0
    idx = (p / 100.0) * (n - 1)
    lo = int(idx)
    hi = lo + 1
    if hi >= n:
        return sorted_data[lo]
    frac = idx - lo
    return sorted_data[lo] + frac * (sorted_data[hi] - sorted_data[lo])


def _print_latency_table(
    title: str,
    rows: list[dict],
    *,
    median_ms: float,
    median_threshold_ms: float,
    p95_ms: float | None = None,
    p95_threshold_ms: float | None = None,
) -> None:
    """Print a formatted latency results table to stdout."""
    print("\n")
    print(f"## {title}")
    print("")
    print(f"| {'run':<4} | {'path':<6} | {'latency_ms':>10} | {'threshold_ms':>12} | {'pass':<6} |")
    print(f"|{'-'*6}|{'-'*8}|{'-'*12}|{'-'*14}|{'-'*8}|")
    for row in rows:
        print(
            f"| {row['run']:<4} | {row['path']:<6} | {row['latency_ms']:>10.1f} |"
            f" {row['threshold_ms']:>12.1f} | {'PASS' if row['pass'] else 'FAIL':<6} |"
        )
    print(f"|{'-'*6}|{'-'*8}|{'-'*12}|{'-'*14}|{'-'*8}|")
    med_pass = median_ms < median_threshold_ms
    print(
        f"| {'med':<4} | {'—':<6} | {median_ms:>10.1f} | {median_threshold_ms:>12.1f} | {'PASS' if med_pass else 'FAIL':<6} |"
    )
    if p95_ms is not None and p95_threshold_ms is not None:
        p95_pass = p95_ms < p95_threshold_ms
        print(
            f"| {'p95':<4} | {'—':<6} | {p95_ms:>10.1f} | {p95_threshold_ms:>12.1f} | {'PASS' if p95_pass else 'FAIL':<6} |"
        )
    print("")


class ColdLatencyBenchmarkTests(unittest.TestCase):
    """AC4 (M020): cold query latency with postings.json < 1.5 s."""

    def test_cold_query_latency_with_postings(self) -> None:
        """Build index (writes postings.json), then run a cold query; assert < 1.5 s."""
        root = _make_cold_query_repo()
        # Build index — this should write both index.json and postings.json
        build_index(root)
        postings_path = root / ".agentrail" / "context" / "index" / "postings.json"
        self.assertTrue(postings_path.exists(), "postings.json must be written by build_index")

        # Cold query: index is already built so build_index inside query_context is a cache hit;
        # the corpus is built from postings.json, not by re-tokenizing.
        t0 = time.perf_counter()
        result = query_context(root, "alpha_token_handler")
        elapsed = time.perf_counter() - t0

        print("\n")
        print("## Cold query latency benchmark (M020 postings.json verification)")
        print("")
        print(f"| metric             | value      | threshold  |")
        print(f"|--------------------|------------|------------|")
        print(f"| cold latency (s)   | {elapsed:.4f}     | < 1.5000   |")
        print(f"| postings.json      | present    | required   |")
        print(f"| results returned   | {len(result.get('results', []))}          | >= 1       |")
        print("")

        self.assertLess(elapsed, 1.5, f"Cold query took {elapsed:.4f}s, expected < 1.5s")
        self.assertGreater(len(result.get("results", [])), 0, "Query must return at least one result")

    def test_fallback_when_postings_absent(self) -> None:
        """Query succeeds and returns results when postings.json is deleted (fallback path)."""
        root = _make_cold_query_repo()
        build_index(root)
        postings_path = root / ".agentrail" / "context" / "index" / "postings.json"
        postings_path.unlink()

        result = query_context(root, "alpha_token_handler")
        self.assertGreater(len(result.get("results", [])), 0, "Fallback query must return results")

    def test_fallback_when_postings_malformed(self) -> None:
        """Query succeeds when postings.json contains invalid JSON."""
        root = _make_cold_query_repo()
        build_index(root)
        postings_path = root / ".agentrail" / "context" / "index" / "postings.json"
        postings_path.write_text("{not valid json", encoding="utf-8")

        result = query_context(root, "alpha_token_handler")
        self.assertGreater(len(result.get("results", [])), 0, "Fallback on malformed postings must return results")

    def test_postings_schema(self) -> None:
        """postings.json has required keys: version, builtAt, postings."""
        root = _make_cold_query_repo()
        build_index(root)
        postings_path = root / ".agentrail" / "context" / "index" / "postings.json"
        data = json.loads(postings_path.read_text(encoding="utf-8"))
        self.assertEqual(data.get("version"), 1)
        self.assertIn("builtAt", data)
        self.assertIn("postings", data)
        self.assertIsInstance(data["postings"], dict)


def test_cold_query_latency() -> None:
    """AC1 (M020): cold query median latency < 1.5 s; prints results table.

    Builds a temp repo, indexes it, then times 5 query_context calls with no
    daemon running (cold path).  Asserts median < 1500 ms and prints a results
    table to stdout so it can be pasted into the PR body.
    """
    RUNS = 5
    COLD_THRESHOLD_MS = 1500.0

    root = _make_cold_query_repo()
    try:
        build_index(root)

        # Confirm no daemon socket is present (cold path must be exercised)
        socket_path = daemon_mod.socket_path_for(root)
        assert not socket_path.exists(), (
            f"Daemon socket unexpectedly present at {socket_path}; "
            "cold latency test requires no running daemon for this repo"
        )

        latencies_ms: list[float] = []
        rows: list[dict] = []

        for i in range(RUNS):
            t0 = time.perf_counter()
            query_context(root, "alpha_token_handler")
            elapsed_ms = (time.perf_counter() - t0) * 1000
            latencies_ms.append(elapsed_ms)
            rows.append({
                "run": i + 1,
                "path": "cold",
                "latency_ms": elapsed_ms,
                "threshold_ms": COLD_THRESHOLD_MS,
                "pass": elapsed_ms < COLD_THRESHOLD_MS,
            })

        median_ms = statistics.median(latencies_ms)
        p95_ms = _percentile(latencies_ms, 95)

        _print_latency_table(
            "Cold query latency benchmark (M020 AC1)",
            rows,
            median_ms=median_ms,
            median_threshold_ms=COLD_THRESHOLD_MS,
            p95_ms=p95_ms,
            p95_threshold_ms=None,
        )

        assert median_ms < COLD_THRESHOLD_MS, (
            f"Cold query median {median_ms:.1f} ms >= threshold {COLD_THRESHOLD_MS:.0f} ms"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_warm_query_latency() -> None:
    """AC2 (M020): warm query median < 150 ms and p95 < 200 ms; prints results table.

    Builds a temp repo, indexes it, starts a real daemon, waits for socket
    readiness (max 10 s), issues one untimed warmup query, then times 10 warm
    queries through _resolve_context_client.  Tears down the daemon in a
    finally block so no socket leaks between tests.
    """
    RUNS = 10
    MEDIAN_THRESHOLD_MS = 150.0
    P95_THRESHOLD_MS = 200.0

    root = _make_cold_query_repo()
    pid: int | None = None
    socket_path: Path | None = None

    try:
        build_index(root)

        pid = daemon_mod.start_detached(root)
        socket_path = daemon_mod.socket_path_for(root)

        ready = daemon_mod._wait_for_socket(socket_path, timeout=10.0)
        assert ready, (
            f"Daemon socket {socket_path} did not become ready within 10 s "
            f"(pid={pid}). Cannot measure warm latency."
        )

        client = _resolve_context_client(root)
        assert client.mode == "warm", (
            f"Expected warm client but got mode={client.mode!r}. "
            "Check that the daemon started and the socket path matches."
        )

        # Untimed warmup — absorbs any first-query index-load or JIT cost
        client.query("alpha_token_handler")

        latencies_ms: list[float] = []
        rows: list[dict] = []

        for i in range(RUNS):
            t0 = time.perf_counter()
            client.query("alpha_token_handler")
            elapsed_ms = (time.perf_counter() - t0) * 1000
            latencies_ms.append(elapsed_ms)
            rows.append({
                "run": i + 1,
                "path": "warm",
                "latency_ms": elapsed_ms,
                "threshold_ms": MEDIAN_THRESHOLD_MS,
                "pass": elapsed_ms < MEDIAN_THRESHOLD_MS,
            })

        median_ms = statistics.median(latencies_ms)
        p95_ms = _percentile(latencies_ms, 95)

        _print_latency_table(
            "Warm query latency benchmark (M020 AC2)",
            rows,
            median_ms=median_ms,
            median_threshold_ms=MEDIAN_THRESHOLD_MS,
            p95_ms=p95_ms,
            p95_threshold_ms=P95_THRESHOLD_MS,
        )

        assert median_ms < MEDIAN_THRESHOLD_MS, (
            f"Warm query median {median_ms:.1f} ms >= threshold {MEDIAN_THRESHOLD_MS:.0f} ms"
        )
        assert p95_ms < P95_THRESHOLD_MS, (
            f"Warm query p95 {p95_ms:.1f} ms >= threshold {P95_THRESHOLD_MS:.0f} ms"
        )

    finally:
        # Graceful shutdown: send shutdown RPC then wait for socket to disappear
        if socket_path is not None and socket_path.exists():
            try:
                daemon_mod.rpc(socket_path, "shutdown", timeout=2.0)
                daemon_mod._wait_for_socket_gone(socket_path, timeout=5.0)
            except Exception:
                pass
        # Last-resort: SIGTERM the daemon PID if the socket still exists
        if pid is not None and socket_path is not None and socket_path.exists():
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
