"""Unit tests for the pure change-set classifier (issue #907).

These cover the deterministic core of agentrail.run.verify_gate in isolation —
no git, no subprocess. The git-backed collector and the shell wrapper are
covered by test_verify_gate_docs_config.py.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.run.verify_gate import (
    changed_source_files,
    changed_test_files,
    collect_changed_files,
    decide,
    is_proof_requiring_source,
    is_test_file,
    is_test_free_change,
    requires_red_green_proof,
)


class ClassifierTest(unittest.TestCase):
    def test_is_test_file(self) -> None:
        self.assertTrue(is_test_file("tests/run/test_x.py"))
        self.assertTrue(is_test_file("pkg/x_test.py"))
        self.assertFalse(is_test_file("agentrail/run/pipeline.py"))
        self.assertFalse(is_test_file("docs/test_plan.md"))  # not .py

    def test_source_requires_proof_but_docs_config_do_not(self) -> None:
        self.assertTrue(is_proof_requiring_source("agentrail/run/pipeline.py"))
        for p in (
            "docs/x.md",
            "README.md",
            ".agentrail/config.json",
            "infra/deploy.yaml",
            "Makefile",
            "scripts/run.sh",
            "apps/console/app/page.tsx",  # TS has its own CI gate
            "tests/run/test_x.py",  # a test is not a "needs-proof" source file
        ):
            self.assertFalse(is_proof_requiring_source(p), p)

    def test_requires_red_green_proof(self) -> None:
        self.assertTrue(requires_red_green_proof(["docs/x.md", "agentrail/a.py"]))
        self.assertFalse(requires_red_green_proof(["docs/x.md", ".agentrail/config.json"]))
        self.assertFalse(requires_red_green_proof([]))
        # A test-only change does not, by itself, require a NEW proof here.
        self.assertFalse(requires_red_green_proof(["tests/run/test_x.py"]))

    def test_changed_source_and_test_partition(self) -> None:
        changed = ["a.py", "tests/test_a.py", "docs/x.md", "b/c_test.py"]
        self.assertEqual(changed_source_files(changed), ["a.py"])
        self.assertEqual(changed_test_files(changed), ["b/c_test.py", "tests/test_a.py"])

    def test_is_test_free_change(self) -> None:
        # Non-empty docs/config-only → test-free (the #907 waiver case).
        self.assertTrue(is_test_free_change(["docs/x.md", ".agentrail/config.json"]))
        # Any source present → NOT test-free.
        self.assertFalse(is_test_free_change(["docs/x.md", "agentrail/a.py"]))
        # EMPTY change set is deliberately NOT test-free — nothing produced must
        # not waive the Red-Green Proof (guards the pipeline waiver from an
        # unknown/empty git state silently granting a free green).
        self.assertFalse(is_test_free_change([]))


class DecideTest(unittest.TestCase):
    def test_test_files_signal_run_pytest(self) -> None:
        code, msg = decide(["tests/test_a.py", "a.py"])
        self.assertEqual((code, msg), (0, ""))

    def test_source_without_test_is_red(self) -> None:
        code, msg = decide(["agentrail/a.py", "docs/x.md"])
        self.assertEqual(code, 1)
        self.assertIn("Red-Green Proof required", msg)

    def test_docs_config_only_is_green(self) -> None:
        code, msg = decide(["docs/x.md", ".agentrail/config.json"])
        self.assertEqual(code, 0)
        self.assertIn("legitimately test-free", msg)

    def test_no_change_is_red(self) -> None:
        code, msg = decide([])
        self.assertEqual(code, 1)
        self.assertIn("nothing to prove", msg)


class CollectChangedFilesTest(unittest.TestCase):
    """The git-backed collector must union committed-on-branch and working-tree
    changes — the property the loop's #899 missed."""

    @staticmethod
    def _git(root: Path, *args: str) -> None:
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

    def _repo(self, root: Path) -> None:
        self._git(root, "init", "-b", "main")
        self._git(root, "config", "user.email", "t@t.com")
        self._git(root, "config", "user.name", "t")
        (root / "README.md").write_text("# base\n")
        self._git(root, "add", "-A")
        self._git(root, "commit", "-m", "init")

    def test_collects_committed_branch_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._repo(root)
            self._git(root, "checkout", "-b", "work")
            (root / "agentrail").mkdir()
            (root / "agentrail" / "feature.py").write_text("x = 1\n")
            self._git(root, "add", "-A")
            self._git(root, "commit", "-m", "feat")

            changed = collect_changed_files(root, base_ref="main")

        self.assertIn("agentrail/feature.py", changed)

    def test_collects_untracked_files_inside_new_dir(self) -> None:
        """A wholly-new directory must surface its individual files, not the dir."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._repo(root)
            (root / "agentrail").mkdir()
            (root / "agentrail" / "thing.py").write_text("y = 2\n")

            changed = collect_changed_files(root, base_ref="main")

        self.assertIn("agentrail/thing.py", changed)


if __name__ == "__main__":
    unittest.main()
