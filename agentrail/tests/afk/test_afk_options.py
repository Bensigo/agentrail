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
from agentrail.run.budget_leash import DEFAULT_PER_ISSUE_BUDGET_USD


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

    def _runner_budget_source(self, runner_mock: MagicMock) -> str:
        """#1269 follow-up (2026-07-18): run_afk must also tell the Runner
        WHICH tier resolved the budget, not just the number — "flag" |
        "config" | "default". Only "default" changes what the Runner relays
        to `run issue` (see RunnerForwardsBudgetSourceTests below), but
        run_afk must compute the honest label in every case."""
        return runner_mock.call_args.kwargs["budget_source"]

    def test_config_default_applied_when_no_flag(self) -> None:
        runner_mock = self._run([])
        self.assertEqual(self._runner_budget(runner_mock), 5.0)
        self.assertEqual(self._runner_budget_source(runner_mock), "config")

    def test_flag_overrides_config_default(self) -> None:
        runner_mock = self._run(["--budget-per-issue", "2"])
        self.assertEqual(self._runner_budget(runner_mock), 2.0)
        self.assertEqual(self._runner_budget_source(runner_mock), "flag")

    def test_flag_zero_disables_cap_despite_config(self) -> None:
        runner_mock = self._run(["--budget-per-issue", "0"])
        self.assertEqual(self._runner_budget(runner_mock), 0.0)
        self.assertEqual(self._runner_budget_source(runner_mock), "flag")

    def test_bad_config_value_is_ignored(self) -> None:
        """#1269: an invalid config value falls back to the product default,
        not to uncapped — same fallback `resolve_default_budget` uses when
        the config sets nothing at all (the one shared resolution site)."""
        (self.target / ".agentrail" / "config.json").write_text(
            json.dumps({"budgets": {"per_issue_usd": "lots"}}))
        runner_mock = self._run([])
        self.assertEqual(self._runner_budget(runner_mock), DEFAULT_PER_ISSUE_BUDGET_USD)
        self.assertEqual(self._runner_budget_source(runner_mock), "default")


class RunAfkBudgetSourceNoConfigTests(unittest.TestCase):
    """Same precedence as RunAfkBudgetPrecedenceTests, but starting from a
    target with NO .agentrail/config.json at all — the genuinely-nothing-set
    case that setUp's always-present config (per_issue_usd: 5.0) never
    exercises."""

    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.target = Path(self.td.name)
        (self.target / ".agentrail").mkdir()

    def test_no_config_no_flag_is_default_source(self) -> None:
        issues = [{"number": 1, "title": "t", "url": ""}]
        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run") as sp_mock, \
                patch("agentrail.cli.commands.afk.build_store"), \
                patch("agentrail.cli.commands.afk.Runner") as runner_mock, \
                patch("agentrail.cli.commands.afk.asyncio.run",
                      return_value=MagicMock(completed=1, failed=0)), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=([], None)):
            gh_mock.list_queue_issues.return_value = issues
            sp_mock.return_value = MagicMock(returncode=0, stdout="")
            rc = run_afk(["--target", str(self.target)])
            self.assertEqual(rc, 0)

        self.assertEqual(
            runner_mock.call_args.kwargs["budget_per_issue"], DEFAULT_PER_ISSUE_BUDGET_USD,
        )
        self.assertEqual(runner_mock.call_args.kwargs["budget_source"], "default")


class RunnerForwardsBudgetTests(unittest.TestCase):
    """_implement always forwards --budget-usd (even 0) so an explicit zero
    overrides any budgets.per_issue_usd in the worktree's config copy."""

    def _implement_cmd(self, budget: float, budget_source: str = "flag") -> list:
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
            store=store, budget_per_issue=budget, budget_source=budget_source,
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


class RunnerForwardsBudgetSourceTests(unittest.TestCase):
    """#1269 follow-up (2026-07-18): the honesty relay. --budget-usd is
    ALWAYS forwarded (by design — see RunnerForwardsBudgetTests above), which
    would make `run issue`'s own parser infer source="flag" regardless of
    where AFK's number actually came from. Only the "default" case needs a
    correction: "flag" and "config" both already read, downstream, as a
    deliberate ceiling (same unembellished stop-message phrasing either way),
    so only "default" is worth the extra flag."""

    def _implement_cmd(self, budget_source: str) -> list:
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        tmp = Path(td.name)
        (tmp / "main").mkdir()
        store = Store(AfkState(concurrency=1, max_retries=1,
                               max_review_rounds=1, slots={0: None}))
        store.dispatch(EnqueueIssue(number=1, title="t", url="http://x/1"))
        runner = Runner(
            target=tmp / "main", engine="claude", base="main", concurrency=1,
            afk_label="afk", queue_labels=["ready"], run_dir=tmp / "run",
            store=store, budget_per_issue=3.0, budget_source=budget_source,
        )
        sh_mock = AsyncMock(return_value=0)
        with patch.object(Runner, "_setup_worktree"), \
                patch("agentrail.afk.runner._sh", sh_mock), \
                patch("agentrail.context.snapshot_push.load_link", return_value=None):
            ok = asyncio.run(runner._implement(0, 1))
        self.assertTrue(ok)
        return sh_mock.call_args.args[0]

    def test_default_source_forwards_budget_source_flag(self) -> None:
        cmd = self._implement_cmd("default")
        self.assertIn("--budget-source", cmd)
        self.assertEqual(cmd[cmd.index("--budget-source") + 1], "default")

    def test_flag_source_omits_budget_source_flag(self) -> None:
        cmd = self._implement_cmd("flag")
        self.assertNotIn("--budget-source", cmd)

    def test_config_source_omits_budget_source_flag(self) -> None:
        """"config" is also a deliberate choice — same stop-message phrasing
        as "flag" downstream, so AFK doesn't bother relaying it either."""
        cmd = self._implement_cmd("config")
        self.assertNotIn("--budget-source", cmd)

    def test_runner_default_budget_source_is_flag(self) -> None:
        """Runner's own constructor default (when run_afk's caller omits the
        kwarg) is "flag" — matching pre-#1269-follow-up behavior byte for
        byte: --budget-source was never forwarded before this feature
        existed."""
        from agentrail.afk.runner import Runner as _Runner
        import inspect
        sig = inspect.signature(_Runner.__init__)
        self.assertEqual(sig.parameters["budget_source"].default, "flag")


# ---------------------------------------------------------------------------
# #1278: --auto-merge CLI flag parsing + run_afk's threading into Runner.
# Mirrors ParseBudgetTests / RunAfkBudgetPrecedenceTests above exactly.
# ---------------------------------------------------------------------------


class ParseAutoMergeTests(unittest.TestCase):
    def test_no_flag_defaults_false(self) -> None:
        opts = _parse([])
        self.assertFalse(opts["auto_merge"])

    def test_flag_sets_true(self) -> None:
        opts = _parse(["--auto-merge"])
        self.assertTrue(opts["auto_merge"])


class RunAfkAutoMergeThreadingTests(unittest.TestCase):
    """run_afk threads --auto-merge straight into the Runner constructor —
    no config-file mirror (unlike --budget-per-issue): --auto-merge follows
    the simpler CLI-only-boolean precedent of --dry-run/--allow-dirty/
    --allow-hosted-repo instead."""

    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.target = Path(self.td.name)
        (self.target / ".agentrail").mkdir()

    def _run(self, extra_args: list) -> MagicMock:
        issues = [{"number": 1, "title": "t", "url": ""}]
        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run") as sp_mock, \
                patch("agentrail.cli.commands.afk.build_store"), \
                patch("agentrail.cli.commands.afk.Runner") as runner_mock, \
                patch("agentrail.cli.commands.afk.asyncio.run",
                      return_value=MagicMock(completed=1, failed=0)), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=([], None)):
            gh_mock.list_queue_issues.return_value = issues
            sp_mock.return_value = MagicMock(returncode=0, stdout="")
            rc = run_afk(["--target", str(self.target)] + extra_args)
            self.assertEqual(rc, 0)
        return runner_mock

    def test_no_flag_threads_false(self) -> None:
        runner_mock = self._run([])
        self.assertFalse(runner_mock.call_args.kwargs["auto_merge"])

    def test_flag_threads_true(self) -> None:
        runner_mock = self._run(["--auto-merge"])
        self.assertTrue(runner_mock.call_args.kwargs["auto_merge"])

    def test_runner_default_auto_merge_is_false(self) -> None:
        """Runner's own constructor default (when a caller omits the kwarg
        entirely, e.g. an older test or script) is False — the correct
        fail-safe default independent of run_afk's own wiring."""
        from agentrail.afk.runner import Runner as _Runner
        import inspect
        sig = inspect.signature(_Runner.__init__)
        self.assertEqual(sig.parameters["auto_merge"].default, False)


if __name__ == "__main__":
    unittest.main()
