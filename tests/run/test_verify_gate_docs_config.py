"""Acceptance tests for issue #907 — verify gate stops false-redding test-free
changes (docs/config) WITHOUT weakening anti-false-green (ADR 0008 Red-Green Proof).

Public interface under test: ``bash .agentrail/verify.sh`` invoked in a real git
repo whose state matches each scenario.

The fatal bug in the loop's own attempt (#899, closed) was that it classified the
change by the WORKING TREE only (``git status`` / ``git ls-files --others`` /
``git diff HEAD``). That is correct for the runner flow (the agent leaves changes
uncommitted so the gate can see them — native_runner.py), but EMPTY for the
AFK/branch flow where the work is committed onto a feature branch. So a committed
code-only change with no test slipped through as GREEN — a false-green hole in the
very gate that exists to prevent false-greens.

The fix classifies the change against the merge-base with the base branch (the
UNION of committed-on-branch changes and uncommitted working-tree changes), so the
gate cannot be fooled by whether the agent committed or not.

AC1: docs/config-only change + green suite → passes (not "red: no changed test files").
AC2: change introducing new code behaviour with NO test → still red (ADR 0008 intact).
AC3: the distinction is driven by the changed-file SET (docs/config vs source).
AC4: this file pins BOTH directions, in BOTH the committed and uncommitted flows.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).parents[2]
_VERIFY_SH = _REPO_ROOT / ".agentrail" / "verify.sh"


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def _init_repo(root: Path) -> None:
    """A minimal repo with one commit on branch ``main`` (the base branch)."""
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@test.com")
    _git(root, "config", "user.name", "Test")
    (root / "README.md").write_text("# base\n")
    _git(root, "add", "README.md")
    _git(root, "commit", "-m", "init")


def _run_verify(root: Path, *, base_ref: str = "main") -> subprocess.CompletedProcess:
    """Run verify.sh from *root*. base_ref tells the gate which branch to diff
    against (default ``main`` — the local base branch these tests build on, since
    there is no ``origin/main`` remote in a tempdir repo).

    The tempdir repo has no ``agentrail`` package, so PYTHONPATH points at the
    real repo root: the module is imported from there but operates on *root*'s
    git state (it shells out to git in the current working dir)."""
    import os

    env = dict(os.environ)
    env["AGENTRAIL_BASE_REF"] = base_ref
    env["PYTHONPATH"] = str(_REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        ["bash", str(_VERIFY_SH)],
        cwd=root,
        capture_output=True,
        text=True,
        env=env,
    )


# ---------------------------------------------------------------------------
# Committed flow (AFK / feature-branch): the bug the loop's #899 missed.
# ---------------------------------------------------------------------------

class CommittedChangeGateTest(unittest.TestCase):
    def test_committed_docs_only_is_green(self) -> None:
        """AC1: a docs-only change COMMITTED to a feature branch passes."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            docs = root / "docs" / "concepts" / "gates.md"
            docs.parent.mkdir(parents=True)
            docs.write_text("# Gates\n\nUpdated docs.\n")
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "docs: update gates")

            result = _run_verify(root)

        self.assertEqual(
            result.returncode, 0,
            msg=f"committed docs-only change must be green (AC1).\nstderr: {result.stderr!r}",
        )

    def test_committed_code_without_test_is_red(self) -> None:
        """AC2 + the loop's false-green hole: a code change COMMITTED to a branch
        with NO test must still RED. #899 returned green here (git diff HEAD is
        empty for committed work)."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            src = root / "agentrail" / "run" / "new_feature.py"
            src.parent.mkdir(parents=True)
            src.write_text("def new_feature():\n    return 42\n")
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "feat: new feature (no test)")

            result = _run_verify(root)

        self.assertNotEqual(
            result.returncode, 0,
            msg=(
                "committed code change with no test MUST red — Red-Green Proof "
                f"(ADR 0008) (AC2).\nstderr: {result.stderr!r}"
            ),
        )

    def test_committed_code_with_passing_test_is_green(self) -> None:
        """A code change COMMITTED with a passing acceptance test passes — the
        normal Red-Green Proof success path, on the committed flow."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            _git(root, "checkout", "-b", "work")
            src = root / "pkg" / "calc.py"
            src.parent.mkdir(parents=True)
            src.write_text("def add(a, b):\n    return a + b\n")
            test = root / "pkg" / "test_calc.py"
            test.write_text(
                "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n"
            )
            _git(root, "add", "-A")
            _git(root, "commit", "-m", "feat: add with test")

            result = _run_verify(root)

        self.assertEqual(
            result.returncode, 0,
            msg=f"committed code+passing-test must be green.\nstderr: {result.stderr!r}\nstdout: {result.stdout!r}",
        )


# ---------------------------------------------------------------------------
# Uncommitted flow (runner): the agent leaves changes in the working tree.
# ---------------------------------------------------------------------------

class UncommittedChangeGateTest(unittest.TestCase):
    def test_uncommitted_docs_only_is_green(self) -> None:
        """AC1: a docs-only change left uncommitted in the working tree passes."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            docs = root / "docs" / "x.md"
            docs.parent.mkdir(parents=True)
            docs.write_text("# x\n")

            result = _run_verify(root)

        self.assertEqual(
            result.returncode, 0,
            msg=f"uncommitted docs-only change must be green (AC1).\nstderr: {result.stderr!r}",
        )

    def test_uncommitted_code_without_test_is_red(self) -> None:
        """AC2: a code change left uncommitted with NO test must red."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)
            src = root / "agentrail" / "thing.py"
            src.parent.mkdir(parents=True)
            src.write_text("def thing():\n    return 1\n")

            result = _run_verify(root)

        self.assertNotEqual(
            result.returncode, 0,
            msg=f"uncommitted code change with no test must red (AC2).\nstderr: {result.stderr!r}",
        )


# ---------------------------------------------------------------------------
# Degenerate case: nothing changed at all is NOT a free pass.
# ---------------------------------------------------------------------------

class NoChangeGateTest(unittest.TestCase):
    def test_no_change_is_red(self) -> None:
        """A run that produced no changes at all has nothing to show — red, not a
        free green. Guards against an empty diff being mistaken for 'test-free'."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_repo(root)

            result = _run_verify(root)

        self.assertNotEqual(
            result.returncode, 0,
            msg=f"a no-op run must red (nothing produced).\nstderr: {result.stderr!r}",
        )


if __name__ == "__main__":
    unittest.main()
