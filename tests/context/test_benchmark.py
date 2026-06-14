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

from agentrail.context import daemon as _daemon_helpers
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


def _make_large_query_repo(num_files: int = 320) -> Path:
    """Fixture repo with ≥300 files to exercise realistic cold/warm query latency (AC3 #686)."""
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
    # Spread files across several subdirectories to exercise glob matching at depth
    subdirs = ["src/core", "src/utils", "src/api", "src/models", "src/handlers",
               "lib/helpers", "lib/transforms", "tests/unit", "tests/integration", "docs"]
    for d in subdirs:
        (root / d).mkdir(parents=True, exist_ok=True)
    body = "\n".join(f"    detail_{n} = compute_{n}()" for n in range(20))
    # Primary searchable file
    (root / "src" / "core" / "widget.py").write_text(
        f"def alpha_token_handler():\n{body}\n    return alpha_token_handler\n", encoding="utf-8")
    # Fill remaining files across subdirs with generic content
    files_written = 1
    for i in range(num_files - 1):
        subdir = subdirs[i % len(subdirs)]
        ext = ".py" if i % 3 != 0 else (".ts" if i % 3 == 1 else ".md")
        ext = [".py", ".ts", ".md"][i % 3]
        fname = f"module_{i:04d}{ext}"
        content = f"# module {i}\ndef func_{i}():\n    return {i}\n"
        (root / subdir / fname).write_text(content, encoding="utf-8")
        files_written += 1
    return root


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


def _print_latency_table(
    rows: list[tuple[str, str, float, float, bool]],
    *,
    title: str,
) -> None:
    """Print a latency results table to stdout.

    Each row: (run_label, path, latency_ms, threshold_ms, pass_flag)
    """
    print("\n")
    print(f"## {title}")
    print("")
    print(f"| {'run':<8} | {'path':<8} | {'latency_ms':>10} | {'threshold_ms':>12} | {'pass':<4} |")
    print(f"|{'-'*10}|{'-'*10}|{'-'*12}|{'-'*14}|{'-'*6}|")
    for run_label, path, latency_ms, threshold_ms, passed in rows:
        pass_str = "PASS" if passed else "FAIL"
        print(f"| {run_label:<8} | {path:<8} | {latency_ms:>10.1f} | {threshold_ms:>12.1f} | {pass_str:<4} |")
    print("")


def test_cold_query_latency() -> None:
    """AC1 (M020): cold query latency (no daemon) — median < 1.5 s over 5 runs."""
    root = _make_cold_query_repo()
    build_index(root)

    threshold_ms = 1500.0
    latencies_ms: list[float] = []
    rows: list[tuple[str, str, float, float, bool]] = []

    for i in range(5):
        t0 = time.perf_counter()
        query_context(root, "alpha_token_handler")
        elapsed_ms = (time.perf_counter() - t0) * 1000
        latencies_ms.append(elapsed_ms)
        rows.append((str(i + 1), "cold", elapsed_ms, threshold_ms, elapsed_ms < threshold_ms))

    median_ms = statistics.median(latencies_ms)
    rows.append(("median", "cold", median_ms, threshold_ms, median_ms < threshold_ms))

    _print_latency_table(rows, title="Cold query latency benchmark (M020 AC1)")

    assert median_ms < threshold_ms, (
        f"Cold query median {median_ms:.1f} ms >= {threshold_ms:.1f} ms threshold"
    )


def test_warm_query_latency() -> None:
    """AC2 (M020): warm query latency (via daemon) — median < 150 ms, p95 < 200 ms over 10 runs."""
    root = _make_cold_query_repo()
    build_index(root)

    socket_path = _daemon_helpers.socket_path_for(root)
    pid = _daemon_helpers.start_detached(root)

    try:
        ready = _daemon_helpers._wait_for_socket(socket_path, timeout=10.0)
        assert ready, "Daemon socket did not become ready within 10 s"

        client = _resolve_context_client(root)
        assert client.mode == "warm", f"Expected warm client, got mode={client.mode!r}"

        # Discard one priming query so startup I/O doesn't skew timings
        client.query("alpha_token_handler")

        median_threshold_ms = 150.0
        p95_threshold_ms = 200.0
        latencies_ms: list[float] = []
        rows: list[tuple[str, str, float, float, bool]] = []

        for i in range(10):
            t0 = time.perf_counter()
            client.query("alpha_token_handler")
            elapsed_ms = (time.perf_counter() - t0) * 1000
            latencies_ms.append(elapsed_ms)
            rows.append((str(i + 1), "warm", elapsed_ms, p95_threshold_ms, elapsed_ms < p95_threshold_ms))

        median_ms = statistics.median(latencies_ms)
        sorted_ms = sorted(latencies_ms)
        p95_idx = min(len(sorted_ms) - 1, int(len(sorted_ms) * 0.95))
        p95_ms = sorted_ms[p95_idx]

        rows.append(("median", "warm", median_ms, median_threshold_ms, median_ms < median_threshold_ms))
        rows.append(("p95", "warm", p95_ms, p95_threshold_ms, p95_ms < p95_threshold_ms))

        _print_latency_table(rows, title="Warm query latency benchmark (M020 AC2)")

        assert median_ms < median_threshold_ms, (
            f"Warm query median {median_ms:.1f} ms >= {median_threshold_ms:.1f} ms threshold"
        )
        assert p95_ms < p95_threshold_ms, (
            f"Warm query p95 {p95_ms:.1f} ms >= {p95_threshold_ms:.1f} ms threshold"
        )

    finally:
        try:
            _daemon_helpers.rpc(socket_path, "shutdown", timeout=3.0)
        except Exception:
            pass
        _daemon_helpers._wait_for_socket_gone(socket_path, timeout=3.0)
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
        socket_path.unlink(missing_ok=True)


def test_cold_query_latency_large_repo() -> None:
    """AC3 (#686): cold query median < 1.5 s on a ≥300-file realistic fixture."""
    root = _make_large_query_repo(num_files=320)
    build_index(root)

    threshold_ms = 1500.0
    latencies_ms: list[float] = []
    rows: list[tuple[str, str, float, float, bool]] = []

    for i in range(5):
        t0 = time.perf_counter()
        query_context(root, "alpha_token_handler")
        elapsed_ms = (time.perf_counter() - t0) * 1000
        latencies_ms.append(elapsed_ms)
        rows.append((str(i + 1), "cold-large", elapsed_ms, threshold_ms, elapsed_ms < threshold_ms))

    median_ms = statistics.median(latencies_ms)
    rows.append(("median", "cold-large", median_ms, threshold_ms, median_ms < threshold_ms))

    _print_latency_table(rows, title="Cold query latency benchmark — 320-file repo (issue #686 AC3)")

    assert median_ms < threshold_ms, (
        f"Cold query (320-file repo) median {median_ms:.1f} ms >= {threshold_ms:.1f} ms threshold"
    )


def test_warm_query_latency_large_repo() -> None:
    """AC3 (#686): warm daemon query median < 150 ms on a ≥300-file realistic fixture."""
    root = _make_large_query_repo(num_files=320)
    build_index(root)

    socket_path = _daemon_helpers.socket_path_for(root)
    pid = _daemon_helpers.start_detached(root)

    try:
        ready = _daemon_helpers._wait_for_socket(socket_path, timeout=10.0)
        assert ready, "Daemon socket did not become ready within 10 s"

        client = _resolve_context_client(root)
        assert client.mode == "warm", f"Expected warm client, got mode={client.mode!r}"

        # Discard one priming query so startup I/O doesn't skew timings
        client.query("alpha_token_handler")

        median_threshold_ms = 150.0
        p95_threshold_ms = 200.0
        latencies_ms: list[float] = []
        rows: list[tuple[str, str, float, float, bool]] = []

        for i in range(10):
            t0 = time.perf_counter()
            client.query("alpha_token_handler")
            elapsed_ms = (time.perf_counter() - t0) * 1000
            latencies_ms.append(elapsed_ms)
            rows.append((str(i + 1), "warm-large", elapsed_ms, p95_threshold_ms, elapsed_ms < p95_threshold_ms))

        median_ms = statistics.median(latencies_ms)
        sorted_ms = sorted(latencies_ms)
        p95_idx = min(len(sorted_ms) - 1, int(len(sorted_ms) * 0.95))
        p95_ms = sorted_ms[p95_idx]

        rows.append(("median", "warm-large", median_ms, median_threshold_ms, median_ms < median_threshold_ms))
        rows.append(("p95", "warm-large", p95_ms, p95_threshold_ms, p95_ms < p95_threshold_ms))

        _print_latency_table(rows, title="Warm query latency benchmark — 320-file repo (issue #686 AC3)")

        assert median_ms < median_threshold_ms, (
            f"Warm query (320-file repo) median {median_ms:.1f} ms >= {median_threshold_ms:.1f} ms threshold"
        )
        assert p95_ms < p95_threshold_ms, (
            f"Warm query (320-file repo) p95 {p95_ms:.1f} ms >= {p95_threshold_ms:.1f} ms threshold"
        )

    finally:
        try:
            _daemon_helpers.rpc(socket_path, "shutdown", timeout=3.0)
        except Exception:
            pass
        _daemon_helpers._wait_for_socket_gone(socket_path, timeout=3.0)
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
        socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
