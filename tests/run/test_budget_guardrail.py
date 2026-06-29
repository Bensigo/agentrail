"""Tests for budget guardrail in agentrail/run/pipeline.py.

AC1: Two-phase run with budget below phase-1 cost stops before phase 2,
     pushes budget_exceeded failure, exits non-zero.
AC2: Under-budget run runs both phases unaffected.
     Zero/absent budget = unlimited (both phases run).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch

from agentrail.run.pipeline import run_issue


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_target(tmp_dir: str) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    # The verification spine is ON BY DEFAULT (MVP), so a successful run reaches
    # GREEN only on a genuine red→green trail: the sentinel-file verify is RED at
    # the baseline and turned GREEN by the execute phase (the stub creates the
    # sentinel on its execute call). The flow is test-author → execute.
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {target / 'impl_done'}"})
    )
    return target


def _stub_run_with_timeout(return_code: int, output_text: str = "agent output",
                           sentinel: Path | None = None):
    """Stub for run_with_timeout. When ``sentinel`` is given, it is created on the
    SECOND call (the execute phase, after test-author) so the red→green trail is
    genuine and the spine-on gate reaches GREEN."""
    def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        _stub.calls.append(argv)
        output_file.write_text(output_text)
        if sentinel is not None and len(_stub.calls) == 2:
            sentinel.write_text("x")
        return return_code
    _stub.calls = []
    return _stub


COMMON_PATCHES = [
    "agentrail.run.pipeline.ctx.issue_resolution_text",
    "agentrail.run.pipeline.skills.resolve_skills",
    "agentrail.run.pipeline.ctx.build_issue_context_pack",
    "agentrail.run.pipeline.ctx.context_pack_summary",
    "agentrail.run.pipeline.ctx.context_selected_snippets",
    "agentrail.run.pipeline.ctx.context_retrieval_metadata",
    "agentrail.run.pipeline.prompts.common_header",
    "agentrail.run.pipeline.prompts.format_skill_resolution",
    "agentrail.run.pipeline.prompts.issue_base_prompt",
    "agentrail.run.pipeline.prompts.issue_run_phase_prompt",
    "agentrail.run.pipeline.push_cost_event",
    "agentrail.run.pipeline.push_agent_activity",
    "agentrail.run.pipeline.push_context_pack",
    "agentrail.run.pipeline.state_mod.update_run_state",
    "agentrail.run.pipeline.state_mod.render_state_summary",
    "subprocess.run",
]


def _apply_common_patches(test_case, target: Path):
    """Start all common patches and return the mocks dict."""
    import os
    mocks = {}
    for p in COMMON_PATCHES:
        m = patch(p)
        mock = m.start()
        test_case.addCleanup(m.stop)
        mocks[p] = mock

    # Disable cost-reduction eval layers so budget tests stay focused on the
    # budget guardrail and are not affected by diff enforcement retries or
    # best-of-N loops (which change the expected run_with_timeout call count).
    env_patch = patch.dict(os.environ, {
        "AGENTRAIL_EVAL_LAYER_DIFF_ONLY_ENFORCE": "0",
        "AGENTRAIL_EVAL_LAYER_BESTOFN": "0",
    })
    env_patch.start()
    test_case.addCleanup(env_patch.stop)

    mocks["agentrail.run.pipeline.ctx.issue_resolution_text"].return_value = "Fix it."
    mocks["agentrail.run.pipeline.skills.resolve_skills"].return_value = {
        "resolved": [], "autoSkills": True, "maxAutoSkills": 4,
        "unavailable": [], "registryPath": "", "targetDir": str(target),
    }
    mocks["agentrail.run.pipeline.ctx.build_issue_context_pack"].return_value = None
    mocks["agentrail.run.pipeline.ctx.context_pack_summary"].return_value = ""
    mocks["agentrail.run.pipeline.ctx.context_selected_snippets"].return_value = ""
    mocks["agentrail.run.pipeline.ctx.context_retrieval_metadata"].return_value = {}
    mocks["agentrail.run.pipeline.prompts.common_header"].return_value = ""
    mocks["agentrail.run.pipeline.prompts.format_skill_resolution"].return_value = ""
    mocks["agentrail.run.pipeline.prompts.issue_base_prompt"].return_value = "base"
    mocks["agentrail.run.pipeline.prompts.issue_run_phase_prompt"].return_value = "prompt"
    mocks["agentrail.run.pipeline.state_mod.render_state_summary"].return_value = ""
    # subprocess.run used for gh label check — return no labels
    mocks["subprocess.run"].return_value = MagicMock(returncode=0, stdout="")
    return mocks


# ---------------------------------------------------------------------------
# AC1: over-budget stops before execute, pushes budget_exceeded, exits non-zero
# ---------------------------------------------------------------------------

class TestBudgetExceededAfterPlan(unittest.TestCase):

    def test_over_budget_stops_before_execute(self):
        """Phase-1 cost exceeds budget → execute never runs, failure pushed, rc != 0."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            mocks = _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(0)
            # capture_usage returns a fake usage object; cost_usd returns 1.50
            mock_usage = MagicMock()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=1.50) as mock_cost, \
                 patch("agentrail.run.pipeline.push_failure_event") as mock_push:

                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    budget_usd=1.00,  # budget < phase-1 cost of 1.50
                )

            # Should exit non-zero
            self.assertNotEqual(rc, 0)
            # Only the plan phase should have run (one run_with_timeout call)
            self.assertEqual(len(stub.calls), 1)
            # push_failure_event called with budget_exceeded
            mock_push.assert_called_once()
            args = mock_push.call_args
            self.assertEqual(args[1]["failure_type"] if args[1] else args[0][2], "budget_exceeded")


# ---------------------------------------------------------------------------
# AC2a: under-budget — both phases run, no failure push
# ---------------------------------------------------------------------------

class TestUnderBudget(unittest.TestCase):

    def test_under_budget_both_phases_run(self):
        """Cost below budget → both spine phases (test-author + execute) run,
        no failure push, gate green."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            mocks = _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
            mock_usage = MagicMock()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=0.25), \
                 patch("agentrail.run.pipeline.push_failure_event") as mock_push:

                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    budget_usd=1.00,  # budget > cumulative cost (0.25 after plan)
                )

            self.assertEqual(rc, 0)
            # Both plan and execute phases ran
            self.assertEqual(len(stub.calls), 2)
            # No budget_exceeded event pushed
            for c in mock_push.call_args_list:
                a = c[1] if c[1] else {}
                self.assertNotEqual(a.get("failure_type", c[0][2] if c[0] else ""), "budget_exceeded")


# ---------------------------------------------------------------------------
# AC2b: zero budget = unlimited — both phases run
# ---------------------------------------------------------------------------

class TestZeroBudgetIsUnlimited(unittest.TestCase):

    def test_zero_budget_is_unlimited(self):
        """budget_usd=0 (default) → no cap, both phases run regardless of cost."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            mocks = _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
            mock_usage = MagicMock()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=999.99), \
                 patch("agentrail.run.pipeline.push_failure_event") as mock_push:

                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    # budget_usd not passed → defaults to 0.0 (unlimited)
                )

            self.assertEqual(rc, 0)
            self.assertEqual(len(stub.calls), 2)
            for c in mock_push.call_args_list:
                a = c[1] if c[1] else {}
                self.assertNotEqual(a.get("failure_type", c[0][2] if c[0] else ""), "budget_exceeded")


class TestNegativeBudgetRejected(unittest.TestCase):
    """P2 regression (PR #525 review): float('-1.5') parses, so the sign
    needs its own check — a negative budget must be a usage error, not
    silently treated as unlimited."""

    def test_negative_budget_raises_usage_error(self) -> None:
        from agentrail.cli.commands.run import parse_run_options, UsageError
        with self.assertRaises(UsageError):
            parse_run_options(["--budget-usd", "-1.5"])


# ---------------------------------------------------------------------------
# Default budget from config: budgets.per_issue_usd (flag > config > 0)
# ---------------------------------------------------------------------------

def _write_config(target: Path, config: dict) -> None:
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "config.json").write_text(json.dumps(config))


class TestDefaultBudgetFromConfig(unittest.TestCase):
    """Default per-issue budget read from budgets.per_issue_usd in
    .agentrail/config.json when --budget-usd is not given."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "target"
        self.target.mkdir(parents=True)

    def test_config_default_applied_when_no_flag(self) -> None:
        from agentrail.cli.commands.run import RunOptions, effective_budget
        _write_config(self.target, {"budgets": {"per_issue_usd": 5.0}})
        opts = RunOptions(target=str(self.target))
        self.assertEqual(effective_budget(opts), 5.0)

    def test_flag_overrides_config_default(self) -> None:
        from agentrail.cli.commands.run import effective_budget, parse_run_options
        _write_config(self.target, {"budgets": {"per_issue_usd": 5.0}})
        opts = parse_run_options(["--target", str(self.target), "--budget-usd", "2.5"])
        self.assertEqual(effective_budget(opts), 2.5)

    def test_flag_zero_disables_cap_despite_config(self) -> None:
        from agentrail.cli.commands.run import effective_budget, parse_run_options
        _write_config(self.target, {"budgets": {"per_issue_usd": 5.0}})
        opts = parse_run_options(["--target", str(self.target), "--budget-usd", "0"])
        self.assertEqual(effective_budget(opts), 0.0)

    def test_no_flag_no_config_is_uncapped(self) -> None:
        from agentrail.cli.commands.run import RunOptions, effective_budget
        opts = RunOptions(target=str(self.target))
        self.assertEqual(effective_budget(opts), 0.0)

    def test_numeric_string_in_config_is_accepted(self) -> None:
        from agentrail.cli.commands.run import resolve_default_budget
        _write_config(self.target, {"budgets": {"per_issue_usd": "3.5"}})
        self.assertEqual(resolve_default_budget(str(self.target)), 3.5)


class TestBadConfigBudgetIgnoredWithWarning(unittest.TestCase):
    """Non-numeric or negative budgets.per_issue_usd warns to stderr and is
    treated as uncapped — a bad config must never crash a run."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "target"
        self.target.mkdir(parents=True)

    def _resolve(self, raw) -> tuple:
        import io
        from contextlib import redirect_stderr
        from agentrail.cli.commands.run import resolve_default_budget
        _write_config(self.target, {"budgets": {"per_issue_usd": raw}})
        err = io.StringIO()
        with redirect_stderr(err):
            value = resolve_default_budget(str(self.target))
        return value, err.getvalue()

    def test_non_numeric_value_warns_and_is_ignored(self) -> None:
        value, err = self._resolve("five dollars")
        self.assertEqual(value, 0.0)
        self.assertIn("budgets.per_issue_usd", err)

    def test_negative_value_warns_and_is_ignored(self) -> None:
        value, err = self._resolve(-3)
        self.assertEqual(value, 0.0)
        self.assertIn("budgets.per_issue_usd", err)

    def test_boolean_value_warns_and_is_ignored(self) -> None:
        value, err = self._resolve(True)
        self.assertEqual(value, 0.0)
        self.assertIn("budgets.per_issue_usd", err)

    def test_null_value_is_silently_uncapped(self) -> None:
        value, err = self._resolve(None)
        self.assertEqual(value, 0.0)
        self.assertEqual(err, "")


if __name__ == "__main__":
    unittest.main()
