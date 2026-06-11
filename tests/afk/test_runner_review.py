"""
Unit tests for the worktree-based _review() implementation.

Verifies that _review() never mutates the main checkout (no git switch / reset
on self.base) and always cleans up the disposable review worktree.
"""
from __future__ import annotations

import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, call, patch

from agentrail.afk.runner import Runner
from agentrail.afk.state import AfkState, Store
from agentrail.afk import review as review_policy


def _make_runner(tmp_path: Path) -> Runner:
    """Construct a minimal Runner without touching git or GitHub."""
    target = tmp_path / "main"
    target.mkdir()
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    store = Store(AfkState(
        concurrency=1,
        max_retries=1,
        max_review_rounds=1,
        slots={0: None},
    ))
    return Runner(
        target=target,
        engine="claude",
        base="main",
        concurrency=1,
        afk_label="afk",
        queue_labels=["ready"],
        run_dir=run_dir,
        store=store,
    )


def _make_git_mock(stdout: str = "", returncode: int = 0):
    """Return a _git mock that always yields returncode and stdout."""
    result = MagicMock(spec=subprocess.CompletedProcess)
    result.returncode = returncode
    result.stdout = stdout
    return MagicMock(return_value=result)


class TestReviewUsesWorktree(unittest.IsolatedAsyncioTestCase):
    """The new _review() must review inside a disposable worktree."""

    async def test_sh_called_with_worktree_cwd_not_main(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = _make_runner(tmp)

            git_mock = _make_git_mock(stdout="")
            clean_outcome = review_policy.ReviewOutcome(
                blocking=[], advisory=[], memory_suggestions=[])

            with patch("agentrail.afk.runner.gh.pr_head_ref", return_value="feat-x"), \
                 patch.object(runner, "_git", git_mock), \
                 patch("agentrail.afk.runner._sh", new=AsyncMock(return_value=0)), \
                 patch("agentrail.afk.runner.review_policy.classify",
                       return_value=clean_outcome), \
                 patch.object(runner, "_remove_worktree") as rm_mock:

                import agentrail.afk.runner as _runner_mod
                sh_mock = _runner_mod._sh  # already replaced by patch context

                result = await runner._review(7)

            # _sh must be called with cwd = the review worktree, NOT self.target
            expected_wt = runner.run_dir / "worktrees" / "review-pr-7"
            sh_mock.assert_awaited_once()
            _, sh_kwargs = sh_mock.call_args
            assert sh_kwargs.get("cwd") == expected_wt, (
                f"_sh cwd should be worktree {expected_wt}, got {sh_kwargs.get('cwd')}"
            )
            assert sh_kwargs.get("cwd") != runner.target, (
                "_sh must NOT run in the main checkout"
            )

    async def test_git_worktree_add_and_branch_force_called(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = _make_runner(tmp)

            git_mock = _make_git_mock(stdout="")
            clean_outcome = review_policy.ReviewOutcome(
                blocking=[], advisory=[], memory_suggestions=[])

            with patch("agentrail.afk.runner.gh.pr_head_ref", return_value="feat-x"), \
                 patch.object(runner, "_git", git_mock), \
                 patch("agentrail.afk.runner._sh", new=AsyncMock(return_value=0)), \
                 patch("agentrail.afk.runner.review_policy.classify",
                       return_value=clean_outcome), \
                 patch.object(runner, "_remove_worktree"):

                await runner._review(7)

            expected_wt = str(runner.run_dir / "worktrees" / "review-pr-7")
            calls = [c.args for c in git_mock.call_args_list]

            assert ("worktree", "add", expected_wt, "feat-x") in calls, (
                f"expected worktree add call not found in {calls}"
            )
            assert ("branch", "-f", "feat-x", "origin/feat-x") in calls, (
                f"expected branch -f call not found in {calls}"
            )

    async def test_no_switch_or_reset_on_main(self):
        """_review must never git-switch base or git-reset --hard on main."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = _make_runner(tmp)

            git_mock = _make_git_mock(stdout="")
            clean_outcome = review_policy.ReviewOutcome(
                blocking=[], advisory=[], memory_suggestions=[])

            with patch("agentrail.afk.runner.gh.pr_head_ref", return_value="feat-x"), \
                 patch.object(runner, "_git", git_mock), \
                 patch("agentrail.afk.runner._sh", new=AsyncMock(return_value=0)), \
                 patch("agentrail.afk.runner.review_policy.classify",
                       return_value=clean_outcome), \
                 patch.object(runner, "_remove_worktree"):

                await runner._review(7)

            calls = [c.args for c in git_mock.call_args_list]
            for args in calls:
                assert not (len(args) >= 2 and args[0] == "switch" and args[1] == runner.base), (
                    f"_git must not switch to base branch, but got: {args}"
                )
                assert not ("reset" in args and "--hard" in args), (
                    f"_git must not hard-reset, but got: {args}"
                )

    async def test_remove_worktree_called_for_cleanup(self):
        """Even on success, _remove_worktree must be called (finally clause)."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = _make_runner(tmp)

            git_mock = _make_git_mock(stdout="")
            clean_outcome = review_policy.ReviewOutcome(
                blocking=[], advisory=[], memory_suggestions=[])

            with patch("agentrail.afk.runner.gh.pr_head_ref", return_value="feat-x"), \
                 patch.object(runner, "_git", git_mock), \
                 patch("agentrail.afk.runner._sh", new=AsyncMock(return_value=0)), \
                 patch("agentrail.afk.runner.review_policy.classify",
                       return_value=clean_outcome), \
                 patch.object(runner, "_remove_worktree") as rm_mock:

                await runner._review(7)

            expected_wt = runner.run_dir / "worktrees" / "review-pr-7"
            rm_mock.assert_called_once_with(expected_wt)

    async def test_remove_worktree_called_even_on_sh_failure(self):
        """Cleanup must run even when _sh returns a non-zero exit code."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = _make_runner(tmp)

            git_mock = _make_git_mock(stdout="")

            with patch("agentrail.afk.runner.gh.pr_head_ref", return_value="feat-x"), \
                 patch.object(runner, "_git", git_mock), \
                 patch("agentrail.afk.runner._sh", new=AsyncMock(return_value=1)), \
                 patch.object(runner, "_remove_worktree") as rm_mock:

                result = await runner._review(7)

            assert result is None
            expected_wt = runner.run_dir / "worktrees" / "review-pr-7"
            rm_mock.assert_called_once_with(expected_wt)


class TestReviewNoneHeadRef(unittest.IsolatedAsyncioTestCase):
    """When pr_head_ref returns None, _review returns None without a worktree."""

    async def test_no_worktree_add_when_no_head_ref(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = _make_runner(tmp)

            git_mock = _make_git_mock(stdout="")

            with patch("agentrail.afk.runner.gh.pr_head_ref", return_value=None), \
                 patch.object(runner, "_git", git_mock), \
                 patch("agentrail.afk.runner._sh", new=AsyncMock(return_value=0)) as sh_mock:

                result = await runner._review(42)

            assert result is None
            calls = [c.args for c in git_mock.call_args_list]
            worktree_add_calls = [a for a in calls if "worktree" in a and "add" in a]
            assert worktree_add_calls == [], (
                f"worktree add should not be called when head_ref is None, got: {worktree_add_calls}"
            )
            sh_mock.assert_not_awaited()


class TestDeletedMethods(unittest.TestCase):
    """_prepare_for_review and _restore_main must not exist on Runner."""

    def test_prepare_for_review_is_gone(self):
        assert not hasattr(Runner, "_prepare_for_review"), (
            "_prepare_for_review must be deleted — it mutates the main checkout"
        )

    def test_restore_main_is_gone(self):
        assert not hasattr(Runner, "_restore_main"), (
            "_restore_main must be deleted — it hard-resets the main checkout"
        )
