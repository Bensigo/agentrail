"""Default per-issue budget for ``agentrail afk``.

Precedence: explicit --budget-per-issue (0 disables the cap) >
budgets.per_issue_usd in .agentrail/config.json > 0 (uncapped). The runner
always forwards the resolved value as --budget-usd so an explicit 0 reaches
`run issue` and overrides the worktree's config copy.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from agentrail.afk.runner import Runner
from agentrail.afk.state import AfkState, EnqueueIssue, Store
from agentrail.cli.commands.afk import _parse, run_afk


class ParseBudgetTests(unittest.TestCase):
    def test_no_flag_is_not_explicit(self) -> None:
        opts = _parse([])
        self.assertEqual(opts["budget_per_issue"], 0.0)
        self.assertFalse(opts["budget_explicit"])

    def test_flag_sets_value_and_explicit(self) -> None:
        opts = _parse(["--budget-per-issue", "2.5"])
        self.assertEqual(opts["budget_per_issue"], 2.5)
        self.assertTrue(opts["budget_explicit"])

    def test_flag_zero_is_explicit(self) -> None:
        opts = _parse(["--budget-per-issue", "0"])
        self.assertEqual(opts["budget_per_issue"], 0.0)
        self.assertTrue(opts["budget_explicit"])


class RunAfkBudgetPrecedenceTests(unittest.TestCase):
    """run_afk resolves the effective budget before constructing the Runner."""

    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.target = Path(self.td.name)
        ar = self.target / ".agentrail"
        ar.mkdir()
        (ar / "config.json").write_text(json.dumps({"budgets": {"per_issue_usd": 5.0}}))

    def _run(self, extra_args: list) -> MagicMock:
        """Run run_afk with everything external mocked; return the Runner mock."""
        issues = [{"number": 1, "title": "t", "url": ""}]
        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run") as sp_mock, \
                patch("agentrail.cli.commands.afk.build_store"), \
                patch("agentrail.cli.commands.afk.Runner") as runner_mock, \
                patch("agentrail.cli.commands.afk.asyncio.run",
                      return_value=MagicMock(completed=1, failed=0)), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=([], None)) as resolve_mock:
            gh_mock.list_queue_issues.return_value = issues
            sp_mock.return_value = MagicMock(returncode=0, stdout="")  # clean tree, no origin match
            rc = run_afk(["--target", str(self.target)] + extra_args)
            self.assertEqual(rc, 0)
            # Budget precedence is what this test class covers; the hosted-repo
            # quarantine guard (#1271) is exercised separately in
            # test_afk_hosted_repo_quarantine.py. Explicitly stub it here (rather
            # than relying on subprocess.run's generic mock returncode) so this
            # suite never depends on Mock attribute defaults, and never risks a
            # real DB lookup regardless of environment.
            resolve_mock.assert_not_called()
        return runner_mock

    def _runner_budget(self, runner_mock: MagicMock) -> float:
        return runner_mock.call_args.kwargs["budget_per_issue"]

    def test_config_default_applied_when_no_flag(self) -> None:
        runner_mock = self._run([])
        self.assertEqual(self._runner_budget(runner_mock), 5.0)

    def test_flag_overrides_config_default(self) -> None:
        runner_mock = self._run(["--budget-per-issue", "2"])
        self.assertEqual(self._runner_budget(runner_mock), 2.0)

    def test_flag_zero_disables_cap_despite_config(self) -> None:
        runner_mock = self._run(["--budget-per-issue", "0"])
        self.assertEqual(self._runner_budget(runner_mock), 0.0)

    def test_bad_config_value_is_ignored(self) -> None:
        (self.target / ".agentrail" / "config.json").write_text(
            json.dumps({"budgets": {"per_issue_usd": "lots"}}))
        runner_mock = self._run([])
        self.assertEqual(self._runner_budget(runner_mock), 0.0)


class RunnerForwardsBudgetTests(unittest.TestCase):
    """_implement always forwards --budget-usd (even 0) so an explicit zero
    overrides any budgets.per_issue_usd in the worktree's config copy."""

    def _implement_cmd(self, budget: float) -> list:
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        tmp = Path(td.name)
        (tmp / "main").mkdir()
        store = Store(AfkState(concurrency=1, max_retries=1,
                               max_review_rounds=1, slots={0: None}))
        # _implement now dispatches RecordCost(number=1), which requires the
        # issue to exist in state. In the real flow the issue is always enqueued
        # before _implement runs; seed it here so this unit test mirrors that.
        store.dispatch(EnqueueIssue(number=1, title="t", url="http://x/1"))
        runner = Runner(
            target=tmp / "main", engine="claude", base="main", concurrency=1,
            afk_label="afk", queue_labels=["ready"], run_dir=tmp / "run",
            store=store, budget_per_issue=budget,
        )
        sh_mock = AsyncMock(return_value=0)
        with patch.object(Runner, "_setup_worktree"), \
                patch("agentrail.afk.runner._sh", sh_mock), \
                patch("agentrail.context.snapshot_push.load_link", return_value=None):
            ok = asyncio.run(runner._implement(0, 1))
        self.assertTrue(ok)
        return sh_mock.call_args.args[0]

    def test_positive_budget_forwarded(self) -> None:
        cmd = self._implement_cmd(3.0)
        self.assertIn("--budget-usd", cmd)
        self.assertEqual(cmd[cmd.index("--budget-usd") + 1], "3.0")

    def test_zero_budget_still_forwarded(self) -> None:
        cmd = self._implement_cmd(0.0)
        self.assertIn("--budget-usd", cmd)
        self.assertEqual(cmd[cmd.index("--budget-usd") + 1], "0.0")


if __name__ == "__main__":
    unittest.main()
