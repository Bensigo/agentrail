from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.benchmark import (
    BENCHMARK_VARIANTS,
    format_benchmark_summary,
    run_benchmark,
)


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

    def test_pass_gates_and_summary_present(self) -> None:
        root = make_repo()
        report = run_benchmark(root, write_fixtures(root))
        self.assertIn("passGates", report)
        self.assertIn("plannerHybridBeatsCurrentPrecision", report["passGates"])
        summary = format_benchmark_summary(report)
        self.assertIn("Context Retrieval Benchmark", summary)
        self.assertIn("planner_hybrid", summary)


if __name__ == "__main__":
    unittest.main()
