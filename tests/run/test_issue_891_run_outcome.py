"""Acceptance test for issue #891 — verify-gate false-red reconciliation.

Root cause 2 (of 2): `.agentrail/verify.sh` exits 1 with "no changed test
files — nothing to prove (red)" for ANY change that contains no Python test
file, including legitimately test-free changes such as docs/config updates.
This causes green-CI PRs for docs-only issues to display as `failed` on the
dashboard.

**Public interface under test**: `bash .agentrail/verify.sh` invoked in an
isolated git worktree whose porcelain status matches each scenario.

AC3 (issue #891): The verify Objective Gate no longer false-reds a change
that is legitimately test-free (docs/config only) — without weakening
Red-Green-Proof enforcement for code changes that need a test (ADR 0008).

AC4 (issue #891): A code change that lacks a test file STILL fails the gate —
no false greens are introduced.

These tests must be RED before the implementation and GREEN after.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

# Absolute path to the verify script (two parents up from tests/run/).
_REPO_ROOT = Path(__file__).parents[2]
_VERIFY_SH = _REPO_ROOT / ".agentrail" / "verify.sh"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _init_git_repo(root: Path) -> None:
    """Initialise a minimal git repo in *root* with one committed file."""

    def _git(*args: str) -> None:
        subprocess.run(
            ["git", *args], cwd=root, check=True, capture_output=True
        )

    _git("init")
    _git("config", "user.email", "test@test.com")
    _git("config", "user.name", "Test")
    (root / "README.md").write_text("# base\n")
    _git("add", "README.md")
    _git("commit", "-m", "init")


def _run_verify(root: Path) -> subprocess.CompletedProcess:
    """Run .agentrail/verify.sh from *root* and return the CompletedProcess."""
    return subprocess.run(
        ["bash", str(_VERIFY_SH)],
        cwd=root,
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class VerifyGateFileClassificationTest(unittest.TestCase):
    """verify.sh must distinguish 'test-free change (green)' from
    'code change without test file (red)'.

    AC3: A change that touches ONLY docs/config/markdown files is
    legitimately test-free; verify must exit 0 (green).  'Nothing to prove'
    is only a failure when there IS code that needs proving.

    AC4: A change that touches source code but includes NO test file must
    still exit non-zero.  Red-Green-Proof (ADR 0008) must not be weakened.
    """

    def test_docs_only_change_exits_zero(self) -> None:
        """AC3: a docs-only change (no code touched) must exit 0 — not false-red.

        This test is RED before the fix (verify.sh exits 1 for any change
        with no test files) and GREEN after the fix.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_git_repo(root)

            # Untracked docs file — no Python, no test file.
            docs = root / "docs" / "concepts" / "review-gates.md"
            docs.parent.mkdir(parents=True)
            docs.write_text("# Review Gates\n\nUpdated docs.\n")

            result = _run_verify(root)

        self.assertEqual(
            result.returncode,
            0,
            msg=(
                "verify.sh must exit 0 for a docs-only change; "
                "'nothing to prove' is green for legitimately test-free changes "
                "(AC3 issue #891).\n"
                f"stderr: {result.stderr!r}"
            ),
        )

    def test_config_only_change_exits_zero(self) -> None:
        """AC3: a config-only change (.agentrail/config.json) must exit 0."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_git_repo(root)

            cfg_dir = root / ".agentrail"
            cfg_dir.mkdir(parents=True, exist_ok=True)
            (cfg_dir / "config.json").write_text('{"verify": "pytest -q"}\n')

            result = _run_verify(root)

        self.assertEqual(
            result.returncode,
            0,
            msg=(
                "verify.sh must exit 0 for a config-only change (AC3).\n"
                f"stderr: {result.stderr!r}"
            ),
        )

    def test_code_change_without_test_file_exits_nonzero(self) -> None:
        """AC4: a Python source change with no test file must still fail the gate.

        Red-Green-Proof (ADR 0008) must not be weakened — a code change that
        has nothing to prove is a problem, not a free pass.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _init_git_repo(root)

            src = root / "agentrail" / "run" / "new_feature.py"
            src.parent.mkdir(parents=True)
            src.write_text("def new_feature(): pass\n")

            result = _run_verify(root)

        self.assertNotEqual(
            result.returncode,
            0,
            msg=(
                "verify.sh must exit non-zero for a code change with no test file — "
                "Red-Green-Proof (ADR 0008) must remain enforced (AC4).\n"
                f"stderr: {result.stderr!r}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
