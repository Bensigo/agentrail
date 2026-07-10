"""Acceptance tests for issue #935 — plain-grep baseline arm.

The offline retrieval evaluation (`agentrail/context/evaluation.py`) grades the
Context Compiler against itself with no baseline, so its recall/precision cannot
say whether AgentRail beats a dumb baseline.  This issue adds a pure-Python
plain-grep baseline arm that retrieves candidate files by a naive case-insensitive
keyword match over the target repo, computed over the SAME fixtures with the SAME
recall/precision helpers, so AgentRail's numbers become comparative.

ACs:
  AC1 — the offline retrieval eval runs a plain-grep baseline arm over the
        existing fixtures and reports its recall and precision.
  AC2 — the report shows AgentRail's recall/precision next to plain-grep's on the
        same fixtures (comparative, not standalone).
  AC3 — the baseline is deterministic and runs in the existing fixture/eval
        harness; it produces a known hit and a known miss on a controlled repo.

These tests are RED before implementation because the baseline functions
(`grep_baseline_paths`, `evaluate_grep_baseline`) and the comparative wiring in
`evaluate_retrieval` / `format_evaluation_report` do not exist yet.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.evaluation import (
    evaluate_grep_baseline,
    evaluate_retrieval,
    format_evaluation_report,
    grep_baseline_paths,
    load_fixtures,
)

REPO_ROOT = Path(__file__).parent.parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"


def _write_controlled_repo() -> Path:
    """A tiny repo where one file clearly matches the query and one clearly does not."""
    root = Path(tempfile.mkdtemp())
    (root / "src").mkdir()
    # HIT: contains the query token "widget_factory"
    (root / "src" / "hit.py").write_text(
        "def widget_factory():\n    return 'Widget'\n",
        encoding="utf-8",
    )
    # MISS: contains none of the query tokens
    (root / "src" / "miss.py").write_text(
        "def unrelated_helper():\n    return 42\n",
        encoding="utf-8",
    )
    return root


class AC1_BaselineProducesRecallAndPrecision(unittest.TestCase):
    """AC1: the grep baseline arm produces recall + precision over the fixtures."""

    def test_grep_baseline_paths_are_repo_relative_strings(self) -> None:
        root = _write_controlled_repo()
        paths = grep_baseline_paths(root, ["widget_factory"], limit=10)
        self.assertIn("src/hit.py", paths)
        self.assertNotIn("src/miss.py", paths)
        for path in paths:
            self.assertIsInstance(path, str)
            self.assertNotIn("\\", path, "paths must use forward slashes")

    def test_evaluate_grep_baseline_returns_recall_and_precision_per_fixture(self) -> None:
        fixtures = load_fixtures(RETRIEVAL_FIXTURE_FILE)
        baseline = evaluate_grep_baseline(REPO_ROOT, fixtures)
        self.assertEqual(len(baseline["fixtures"]), len(fixtures))
        for fixture_report in baseline["fixtures"]:
            metrics = fixture_report["metrics"]
            self.assertIn("recallAt5", metrics)
            self.assertIn("recallAt10", metrics)
            self.assertIn("precisionAtBudget", metrics)
            self.assertIsInstance(metrics["recallAt5"], float)
            self.assertIsInstance(metrics["recallAt10"], float)
            self.assertIsInstance(metrics["precisionAtBudget"]["precision"], float)

    def test_grep_baseline_recalls_the_required_source_for_real_fixtures(self) -> None:
        """On the repo fixtures, grep can find at least one required source."""
        fixtures = load_fixtures(RETRIEVAL_FIXTURE_FILE)
        baseline = evaluate_grep_baseline(REPO_ROOT, fixtures)
        recalls = [f["metrics"]["recallAt10"] for f in baseline["fixtures"]]
        self.assertTrue(any(r > 0.0 for r in recalls), f"all grep recalls zero: {recalls}")


class AC2_ReportShowsBothArmsSideBySide(unittest.TestCase):
    """AC2: report shows AgentRail's recall/precision next to plain-grep's."""

    def test_evaluate_retrieval_attaches_grep_baseline_arm(self) -> None:
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        self.assertIn("grepBaseline", report)
        self.assertEqual(
            len(report["grepBaseline"]["fixtures"]),
            report["summary"]["fixtures"],
        )

    def test_each_fixture_carries_both_arms_metrics(self) -> None:
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        grep_by_name = {f["name"]: f for f in report["grepBaseline"]["fixtures"]}
        non_skipped = [f for f in report["fixtures"] if f["status"] != "skipped"]
        self.assertTrue(non_skipped)
        for fixture in non_skipped:
            self.assertIn(fixture["name"], grep_by_name)
            grep_metrics = grep_by_name[fixture["name"]]["metrics"]
            # both arms expose the same metric keys, computed by the same helpers
            self.assertIn("recallAt5", fixture["metrics"])
            self.assertIn("recallAt5", grep_metrics)

    def test_formatted_report_renders_both_arms(self) -> None:
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        text = format_evaluation_report(report)
        self.assertIn("grep", text.lower())
        # the AgentRail arm label and a grep label both appear
        self.assertIn("agentrail", text.lower())


class AC3_BaselineIsDeterministicWithKnownHitAndMiss(unittest.TestCase):
    """AC3: deterministic baseline on a fixture with a known grep hit AND miss."""

    def test_known_hit_and_known_miss(self) -> None:
        root = _write_controlled_repo()
        fixtures = [
            {
                "name": "controlled-hit",
                "task": "widget_factory",
                "limit": 10,
                "requiredSources": ["src/hit.py"],
                "expectedFiles": ["src/hit.py"],
                "expectedDocs": [],
                "expectedMemory": [],
                "expectedPriorMistakes": [],
                "expectedExcludedSources": [],
                "expectedGraphExpandedSources": [],
                "optionalProviderEnv": [],
                "minPrecisionAtBudget": 0.0,
            },
            {
                "name": "controlled-miss",
                "task": "nonexistent_token_zzzqqq",
                "limit": 10,
                "requiredSources": ["src/hit.py"],
                "expectedFiles": ["src/hit.py"],
                "expectedDocs": [],
                "expectedMemory": [],
                "expectedPriorMistakes": [],
                "expectedExcludedSources": [],
                "expectedGraphExpandedSources": [],
                "optionalProviderEnv": [],
                "minPrecisionAtBudget": 0.0,
            },
        ]
        baseline = evaluate_grep_baseline(root, fixtures)
        by_name = {f["name"]: f for f in baseline["fixtures"]}
        # HIT: grep finds src/hit.py -> recall 1.0
        self.assertEqual(by_name["controlled-hit"]["metrics"]["recallAt10"], 1.0)
        # MISS: grep finds nothing -> recall 0.0
        self.assertEqual(by_name["controlled-miss"]["metrics"]["recallAt10"], 0.0)

    def test_baseline_is_deterministic_across_runs(self) -> None:
        root = _write_controlled_repo()
        paths_a = grep_baseline_paths(root, ["widget", "factory", "return"], limit=10)
        paths_b = grep_baseline_paths(root, ["widget", "factory", "return"], limit=10)
        self.assertEqual(paths_a, paths_b, "grep baseline ordering must be stable")

    def test_ordering_is_score_desc_then_path_asc(self) -> None:
        root = Path(tempfile.mkdtemp())
        # a.py matches one token; b.py matches two tokens -> b ranks first.
        (root / "a.py").write_text("alpha\n", encoding="utf-8")
        (root / "b.py").write_text("alpha beta\n", encoding="utf-8")
        (root / "c.py").write_text("alpha\n", encoding="utf-8")
        paths = grep_baseline_paths(root, ["alpha", "beta"], limit=10)
        self.assertEqual(paths[0], "b.py")
        # a.py and c.py tie on score; tie broken by path ascending
        self.assertEqual(paths[1:], ["a.py", "c.py"])


class ExistingArmUnchanged(unittest.TestCase):
    """Adding the baseline must not change the AgentRail arm's numbers."""

    def test_agentrail_arm_metrics_present_and_unchanged_shape(self) -> None:
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        # the AgentRail arm still lives under 'fixtures' with the same metric keys
        for fixture in report["fixtures"]:
            if fixture["status"] == "skipped":
                continue
            self.assertIn("recallAt5", fixture["metrics"])
            self.assertIn("precisionAtBudget", fixture["metrics"])
        # summary and passed flag still reflect the AgentRail arm only
        self.assertIn("summary", report)
        self.assertIn("passed", report)


class BaselineExcludesEvalFixtureFile(unittest.TestCase):
    """The baseline must not 'find' the eval's own fixture/answer-key file.

    retrieval-fixtures.json quotes every required path, so an un-excluded grep
    ranks it as the top hit on every query — stealing a top-k slot from the real
    required files and unfairly depressing grep's recall/precision (which would
    inflate AgentRail's relative edge). The eval excludes it.
    """

    def test_grep_baseline_paths_honours_exclude(self) -> None:
        root = Path(tempfile.mkdtemp())
        (root / "answer_key.json").write_text("alpha beta gamma\n", encoding="utf-8")
        (root / "real.py").write_text("alpha\n", encoding="utf-8")
        without = grep_baseline_paths(root, ["alpha", "beta", "gamma"], limit=10)
        self.assertIn("answer_key.json", without)
        with_exclude = grep_baseline_paths(
            root, ["alpha", "beta", "gamma"], limit=10, exclude={root / "answer_key.json"}
        )
        self.assertNotIn("answer_key.json", with_exclude)
        self.assertIn("real.py", with_exclude)

    def test_evaluate_retrieval_baseline_never_lists_the_fixture_file(self) -> None:
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        for fixture_report in report["grepBaseline"]["fixtures"]:
            self.assertNotIn(
                "agentrail/context/retrieval-fixtures.json",
                fixture_report["selectedPaths"],
                "the eval's own answer-key file must be excluded from the grep corpus",
            )


class BaselineSkipsDotDirScratchCopies(unittest.TestCase):
    """Issue #1097: the grep baseline must ignore gitignored dot-dir scratch.

    On a dev machine, `.claude/worktrees/agent-*`, `.codex-review/pr-*` and
    `.afk-workflow/` hold full-repo copies from past AFK/subagent runs. Those
    copies duplicate every expected source; because `.claude`/`.codex-review`
    sort lexically before `agentrail/`, they fill grep's top-k and push the real
    (un-prefixed) files out — recall against the real path drops to 0 locally
    while CI (a clean checkout with no scratch dirs) stays green. The real
    AgentRail index never walks those dirs, so the baseline must skip them too.
    """

    def test_dot_dir_copy_is_pruned_real_file_still_recalled(self) -> None:
        root = Path(tempfile.mkdtemp())
        # The real source the query should recall.
        (root / "agentrail").mkdir()
        (root / "agentrail" / "widget.py").write_text(
            "def widget_factory():\n    return 'Widget'\n",
            encoding="utf-8",
        )
        # A gitignored scratch copy under a dot-dir at the SAME relative path.
        scratch = root / ".claude" / "worktrees" / "agent-x" / "agentrail"
        scratch.mkdir(parents=True)
        (scratch / "widget.py").write_text(
            "def widget_factory():\n    return 'Widget'\n",
            encoding="utf-8",
        )

        paths = grep_baseline_paths(root, ["widget_factory"], limit=10)

        # The real file is recalled; the dot-dir copy is skipped entirely.
        self.assertIn("agentrail/widget.py", paths)
        self.assertNotIn(".claude/worktrees/agent-x/agentrail/widget.py", paths)
        self.assertFalse(
            any(p.startswith(".") for p in paths),
            f"no dot-dir path should appear in the baseline: {paths}",
        )

    def test_dot_dir_copies_do_not_crowd_out_real_file(self) -> None:
        """Many scratch copies must not push the single real file out of top-k."""
        root = Path(tempfile.mkdtemp())
        (root / "agentrail").mkdir()
        (root / "agentrail" / "widget.py").write_text(
            "widget_factory widget_factory\n", encoding="utf-8"
        )
        # A dozen dot-dir scratch copies, each a stronger textual match than the
        # real file, all sorting lexically before `agentrail/`.
        for i in range(12):
            copy_dir = root / ".claude" / "worktrees" / f"agent-{i}" / "agentrail"
            copy_dir.mkdir(parents=True)
            (copy_dir / "widget.py").write_text(
                "widget_factory widget_factory widget_factory\n", encoding="utf-8"
            )

        paths = grep_baseline_paths(root, ["widget_factory"], limit=10)

        self.assertEqual(
            paths,
            ["agentrail/widget.py"],
            "only the real file should survive; all dot-dir scratch is pruned",
        )

    def test_evaluate_grep_baseline_recalls_real_file_despite_pollution(self) -> None:
        """End-to-end: recall stays 1.0 when a dot-dir scratch copy is present."""
        root = Path(tempfile.mkdtemp())
        (root / "agentrail").mkdir()
        (root / "agentrail" / "widget.py").write_text(
            "def widget_factory():\n    return 'Widget'\n", encoding="utf-8"
        )
        scratch = root / ".codex-review" / "pr-1" / "agentrail"
        scratch.mkdir(parents=True)
        (scratch / "widget.py").write_text(
            "def widget_factory():\n    return 'Widget'\n", encoding="utf-8"
        )
        fixture = {
            "name": "polluted-tree",
            "task": "widget_factory",
            "limit": 10,
            "requiredSources": ["agentrail/widget.py"],
            "expectedFiles": ["agentrail/widget.py"],
            "expectedDocs": [],
            "expectedMemory": [],
            "expectedPriorMistakes": [],
            "expectedExcludedSources": [],
            "expectedGraphExpandedSources": [],
            "optionalProviderEnv": [],
            "minPrecisionAtBudget": 0.0,
        }
        baseline = evaluate_grep_baseline(root, [fixture])
        report = baseline["fixtures"][0]
        self.assertEqual(report["metrics"]["recallAt10"], 1.0)
        self.assertEqual(report["selectedPaths"], ["agentrail/widget.py"])


if __name__ == "__main__":
    unittest.main()
