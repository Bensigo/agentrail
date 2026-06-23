"""Adapters produce Signals from the environment (issue #919, AC1).

* git adapter   -> changed_files / diff / deleted_files (real temp git repo)
* ci adapter    -> ci_checks (from a fetched payload)
* test-runner   -> test_results (from a runner command)
* build_signals -> composes them into a Signals
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from agentrail.guardrails.adapters import build_signals
from agentrail.guardrails.adapters import ci as ci_adapter
from agentrail.guardrails.adapters import git as git_adapter
from agentrail.guardrails.adapters import test_runner
from agentrail.guardrails.signals import CiCheck, Signals, TestResult


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def _init_repo(root: Path) -> None:
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "t@t.com")
    _git(root, "config", "user.name", "t")
    (root / "README.md").write_text("# base\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "init")


class TestGitAdapter:
    def test_changed_files_committed_and_untracked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            (root / "pkg").mkdir()
            (root / "pkg" / "feature.py").write_text("x = 1\n")
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "feat")
            # plus an untracked file in the working tree
            (root / "pkg" / "untracked.py").write_text("y = 2\n")

            changed = git_adapter.collect_changed_files(root, base_ref="main")

        assert "pkg/feature.py" in changed
        assert "pkg/untracked.py" in changed

    def test_diff_text_is_collected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            (root / "pkg").mkdir()
            (root / "pkg" / "f.py").write_text("def f():\n    return 1\n")
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "feat")

            diff = git_adapter.collect_diff(root, base_ref="main")

        assert "def f()" in diff
        assert "+++ b/pkg/f.py" in diff

    def test_deleted_files_are_collected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            (root / "README.md").unlink()
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "rm readme")

            deleted = git_adapter.collect_deleted_files(root, base_ref="main")

        assert "README.md" in deleted

    def test_build_signals_composes_git_slice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            (root / "a.py").write_text("z = 3\n")
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "feat")

            sig = build_signals(root, base_ref="main", include_diff=True)

        assert isinstance(sig, Signals)
        assert "a.py" in sig.changed_files
        assert "a.py" in sig.diff


class TestCiAdapter:
    def test_checks_from_payload(self):
        checks = ci_adapter.checks_from_payload(
            [
                {"name": "build", "conclusion": "success"},
                {"name": "lint", "state": "failure"},
                {"context": "legacy", "status": "success"},
                {"conclusion": "success"},  # no name → dropped
            ]
        )
        assert checks == (
            CiCheck("build", "success"),
            CiCheck("lint", "failure"),
            CiCheck("legacy", "success"),
        )

    def test_fetch_is_best_effort_when_gh_missing(self):
        # Pointing at a non-existent ref / no gh PR context must degrade to ().
        # We don't assert a specific value beyond "tuple, no raise".
        result = ci_adapter.fetch_ci_checks(ref="definitely-not-a-real-ref-zzz")
        assert isinstance(result, tuple)


class TestTestRunnerAdapter:
    def test_passing_command_yields_passing_result(self):
        results, code = test_runner.run_tests(
            [sys.executable, "-c", "import sys; sys.exit(0)"], names=["suiteA"]
        )
        assert code == 0
        assert results == (TestResult("suiteA", True, None),)

    def test_failing_command_yields_failing_result_with_message(self):
        results, code = test_runner.run_tests(
            [sys.executable, "-c", "import sys; sys.exit(1)"], names=["suiteB"]
        )
        assert code == 1
        assert len(results) == 1 and results[0].passed is False
        assert results[0].name == "suiteB"

    def test_default_label_when_no_names(self):
        results, _ = test_runner.run_tests([sys.executable, "-c", "pass"])
        assert [r.name for r in results] == ["tests"]
