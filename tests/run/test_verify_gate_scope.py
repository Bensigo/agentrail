"""Unit tests for the wider-tests scope selection in agentrail.run.verify_gate.

The Red-Green Proof historically ran ONLY the agent's changed test files, so a
change that broke an existing (unchanged) test went green — the gate never ran
that test. The wider scope broadens the pytest target set to existing repo tests
so such a regression reds the gate. It is flag-gated and default-OFF: the default
``changed`` scope reproduces today's behaviour exactly.

These cover the PURE selection (select_pytest_targets) and the impure repo
discovery (discover_repo_test_files) in isolation — no subprocess. The invariant
that matters most: the sealed answer-key tests are NEVER selected, in any scope.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from agentrail.run.verify_gate import (
    DEFAULT_TEST_SCOPE,
    HIDDEN_TEST_DIRNAME,
    discover_repo_test_files,
    is_hidden_test_path,
    select_pytest_targets,
)


class SelectPytestTargetsTest(unittest.TestCase):
    def test_default_changed_scope_is_only_changed_tests(self) -> None:
        """The default scope is a no-op widening: only the changed test files run,
        even when the repo has other existing tests."""
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope=DEFAULT_TEST_SCOPE,
            repo_test_files=["pkg/test_mod.py", "other/test_other.py"],
        )
        self.assertEqual(targets, ["pkg/test_mod.py"])

    def test_unknown_scope_falls_back_to_changed_only(self) -> None:
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope="bananas",
            repo_test_files=["pkg/test_mod.py", "other/test_other.py"],
        )
        self.assertEqual(targets, ["pkg/test_mod.py"])

    def test_repo_scope_runs_all_existing_tests(self) -> None:
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope="repo",
            repo_test_files=["pkg/test_mod.py", "other/test_other.py"],
        )
        self.assertEqual(targets, ["other/test_other.py", "pkg/test_mod.py"])

    def test_dirs_scope_runs_existing_tests_under_changed_dirs_only(self) -> None:
        """``dirs`` widens to existing tests under the changed file's directory
        (and nested under it), but not unrelated directories."""
        targets = select_pytest_targets(
            ["pkg/sub/mod.py", "pkg/sub/test_mod.py"],
            scope="dirs",
            repo_test_files=[
                "pkg/sub/test_mod.py",
                "pkg/sub/test_extra.py",  # same dir as the changed source → included
                "pkg/sub/deep/test_deep.py",  # nested under it → included
                "other/test_other.py",  # unrelated dir → excluded
            ],
        )
        self.assertEqual(
            targets,
            [
                "pkg/sub/deep/test_deep.py",
                "pkg/sub/test_extra.py",
                "pkg/sub/test_mod.py",
            ],
        )

    def test_changed_test_always_included_even_if_not_in_repo_set(self) -> None:
        """A brand-new changed test (not yet in the discovered repo set) is always
        run, regardless of scope."""
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_new.py"],
            scope="dirs",
            repo_test_files=["other/test_other.py"],
        )
        self.assertIn("pkg/test_new.py", targets)

    def test_explicit_paths_override_replaces_computed_set(self) -> None:
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope="repo",
            repo_test_files=["pkg/test_mod.py", "other/test_other.py"],
            explicit_paths=["chosen/test_a.py", "chosen/test_b.py"],
        )
        self.assertEqual(targets, ["chosen/test_a.py", "chosen/test_b.py"])

    def test_results_are_deduped_and_sorted(self) -> None:
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope="repo",
            repo_test_files=["pkg/test_mod.py", "a/test_a.py", "pkg/test_mod.py"],
        )
        self.assertEqual(targets, ["a/test_a.py", "pkg/test_mod.py"])


class AnswerKeyNeverSelectedTest(unittest.TestCase):
    """The sealed hidden exam must never be in the target set, in ANY scope."""

    def test_is_hidden_test_path(self) -> None:
        self.assertTrue(is_hidden_test_path(f"x/{HIDDEN_TEST_DIRNAME}/test_h.py"))
        self.assertTrue(is_hidden_test_path(f"{HIDDEN_TEST_DIRNAME}/test_h.py"))
        self.assertFalse(is_hidden_test_path("pkg/test_mod.py"))
        # A substring match must NOT trigger — only a full path component.
        self.assertFalse(is_hidden_test_path("pkg/answer_keys_helper/test_x.py"))

    def test_answer_key_excluded_from_repo_scope(self) -> None:
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope="repo",
            repo_test_files=[
                "pkg/test_mod.py",
                f"task/{HIDDEN_TEST_DIRNAME}/test_hidden.py",
            ],
        )
        self.assertNotIn(f"task/{HIDDEN_TEST_DIRNAME}/test_hidden.py", targets)
        self.assertEqual(targets, ["pkg/test_mod.py"])

    def test_answer_key_excluded_even_from_explicit_override(self) -> None:
        targets = select_pytest_targets(
            ["pkg/mod.py", "pkg/test_mod.py"],
            scope="changed",
            repo_test_files=[],
            explicit_paths=[
                "chosen/test_a.py",
                f"task/{HIDDEN_TEST_DIRNAME}/test_hidden.py",
            ],
        )
        self.assertEqual(targets, ["chosen/test_a.py"])


class DiscoverRepoTestFilesTest(unittest.TestCase):
    def test_discovers_tests_and_prunes_git_and_answer_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "pkg").mkdir()
            (root / "pkg" / "test_mod.py").write_text("def test_x(): pass\n")
            (root / "pkg" / "mod_test.py").write_text("def test_y(): pass\n")
            (root / "pkg" / "mod.py").write_text("x = 1\n")  # source, not a test
            # .git is pruned
            (root / ".git").mkdir()
            (root / ".git" / "test_fake.py").write_text("def test_z(): pass\n")
            # answer_key subtree is pruned (sealed hidden exam)
            (root / "task" / HIDDEN_TEST_DIRNAME).mkdir(parents=True)
            (root / "task" / HIDDEN_TEST_DIRNAME / "test_hidden.py").write_text(
                "def test_h(): pass\n"
            )

            found = set(discover_repo_test_files(root))

            self.assertIn("pkg/test_mod.py", found)
            self.assertIn("pkg/mod_test.py", found)
            self.assertNotIn("pkg/mod.py", found)
            self.assertFalse(any(".git" in f for f in found))
            self.assertFalse(any(HIDDEN_TEST_DIRNAME in f for f in found))


if __name__ == "__main__":
    unittest.main()
