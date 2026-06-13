from __future__ import annotations

import json
import shutil
import statistics
import subprocess
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

from agentrail.context.benchmark import (
    BENCHMARK_VARIANTS,
    format_benchmark_summary,
    run_benchmark,
)
from agentrail.context.index import build_index


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


if __name__ == "__main__":
    unittest.main()
