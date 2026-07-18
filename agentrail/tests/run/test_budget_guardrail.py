"""Tests for budget guardrail in agentrail/run/pipeline.py.

AC1: Two-phase run with budget below phase-1 cost stops before phase 2,
     pushes budget_exceeded failure, exits non-zero.
AC2: Under-budget run runs both phases unaffected.
     Zero/absent budget = unlimited (both phases run).
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import MagicMock, call, patch

from agentrail.run.budget_leash import DEFAULT_PER_ISSUE_BUDGET_USD
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


def _stub_run_with_timeout_verify_accepts(return_code: int, sentinel: Path | None = None):
    """Like :func:`_stub_run_with_timeout`, but the verify phase's OWN output is
    a structured ACCEPT verdict. The Independent Verifier's ``parse_verdict``
    is fail-closed (no recognized verdict → REJECT), so a test that actually
    schedules a verify phase and still expects the Objective Gate to reach
    GREEN must give it something acceptable — plain "agent output" would
    fail-closed the gate for a reason unrelated to the budget guardrail."""
    def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        _stub.calls.append(argv)
        if output_file.parent.name == "verify":
            output_file.write_text('VERDICT: {"verdict": "accept", "reason": "ok"}')
        else:
            output_file.write_text("agent output")
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

    def test_no_flag_no_config_uses_product_default(self) -> None:
        """#1269: neither an explicit flag nor a config value → the product
        default cap applies (NOT uncapped — that was the bug: a real run left
        with the product's own defaults had no budget leash at all)."""
        from agentrail.cli.commands.run import RunOptions, effective_budget
        opts = RunOptions(target=str(self.target))
        self.assertEqual(effective_budget(opts), DEFAULT_PER_ISSUE_BUDGET_USD)

    def test_numeric_string_in_config_is_accepted(self) -> None:
        from agentrail.cli.commands.run import resolve_default_budget
        _write_config(self.target, {"budgets": {"per_issue_usd": "3.5"}})
        self.assertEqual(resolve_default_budget(str(self.target)), 3.5)


class TestBadConfigBudgetIgnoredWithWarning(unittest.TestCase):
    """Non-numeric or negative budgets.per_issue_usd warns to stderr and falls
    back to the product default — a bad config must never crash a run, and
    (#1269) must never silently revert to UNCAPPED either: that would defeat
    the budget leash on exactly the config that couldn't specify one."""

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

    def test_non_numeric_value_warns_and_uses_product_default(self) -> None:
        value, err = self._resolve("five dollars")
        self.assertEqual(value, DEFAULT_PER_ISSUE_BUDGET_USD)
        self.assertIn("budgets.per_issue_usd", err)

    def test_negative_value_warns_and_uses_product_default(self) -> None:
        value, err = self._resolve(-3)
        self.assertEqual(value, DEFAULT_PER_ISSUE_BUDGET_USD)
        self.assertIn("budgets.per_issue_usd", err)

    def test_boolean_value_warns_and_uses_product_default(self) -> None:
        value, err = self._resolve(True)
        self.assertEqual(value, DEFAULT_PER_ISSUE_BUDGET_USD)
        self.assertIn("budgets.per_issue_usd", err)

    def test_null_value_is_silently_treated_as_unset(self) -> None:
        """Explicit JSON null is indistinguishable from the key being absent
        entirely (both parse to Python None) — same silent product-default
        fallback, no warning (it isn't a malformed value, just not set)."""
        value, err = self._resolve(None)
        self.assertEqual(value, DEFAULT_PER_ISSUE_BUDGET_USD)
        self.assertEqual(err, "")


# ---------------------------------------------------------------------------
# #1269 PR 1: the per-phase mechanism — a breach is checked after EVERY
# phase's cost is known, not just once after test-author. The old single
# checkpoint (pipeline.py:1417, pre-#1269) only ever looked right after
# test-author; a breach that only became visible after EXECUTE's own cost
# posted would previously sail straight through to verify. These tests pin
# the breach to the EXECUTE phase specifically, so they only pass under the
# new per-phase mechanism.
# ---------------------------------------------------------------------------

class TestPerPhaseBudgetBreach(unittest.TestCase):

    def test_breach_after_execute_stops_before_verify(self):
        """Budget is fine after test-author, but execute's OWN cost tips it over
        the cap — verify (configured here, unlike the other tests in this file)
        must NEVER run, and the failure event must name the EXECUTE phase, not
        test-author."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            mocks = _apply_common_patches(self, target)

            # test-author costs 0.6 (under the 1.0 cap); execute costs another
            # 0.6, taking cumulative spend to 1.2 — over the cap. A third value
            # is provided defensively so a wrongly-run verify phase does not
            # raise StopIteration and mask the real assertion failures below.
            stub = _stub_run_with_timeout(0)
            mock_usage = MagicMock()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", side_effect=[0.6, 0.6, 0.6]), \
                 patch("agentrail.run.pipeline.push_failure_event") as mock_push:

                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    run_id="test-run-budget-execute",
                    # A configured verify phase — the other tests in this file
                    # never set one, so they cannot prove verify was actually
                    # skipped BECAUSE of the budget (there'd be nothing to run
                    # either way). This one can.
                    phase_commands={"verify": "claude -p --model strong"},
                    budget_usd=1.00,
                )

            self.assertNotEqual(rc, 0)
            # test-author + execute ran; verify must not have.
            self.assertEqual(len(stub.calls), 2)
            mock_push.assert_called_once()
            args = mock_push.call_args
            failure_type = args[1]["failure_type"] if args[1] else args[0][2]
            phase = args[1]["phase"] if args[1] else args[0][3]
            self.assertEqual(failure_type, "budget_exceeded")
            self.assertEqual(phase, "execute")

    def test_uncapped_runs_configured_verify_phase_too(self):
        """budget_usd=0 (explicitly uncapped) must not stop the run even with a
        verify phase configured and costs that would blow any real cap — the
        stronger version of the existing zero-budget test, which never
        configures a verify phase so it can't show verify surviving too."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)

            stub = _stub_run_with_timeout_verify_accepts(0, sentinel=target / "impl_done")
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
                    phase_commands={"verify": "claude -p --model strong"},
                    budget_usd=0.0,
                )

            self.assertEqual(rc, 0)
            # test-author + execute + verify all ran.
            self.assertEqual(len(stub.calls), 3)
            mock_push.assert_not_called()

    def test_breach_reason_recorded_in_run_metadata(self):
        """#1269 AC1 'reason recorded': run.json's blockedReason carries the
        phase, spend, and ceiling — not just the (non-fatal, best-effort)
        server-side failure-event push."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(0)
            mock_usage = MagicMock()
            run_id = "test-run-budget-metadata"

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=1.50), \
                 patch("agentrail.run.pipeline.push_failure_event"):

                run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    run_id=run_id,
                    budget_usd=1.00,
                )

            metadata_file = Path(tmp) / "runs" / run_id / "run.json"
            data = json.loads(metadata_file.read_text())
            reason = data.get("blockedReason", "")
            self.assertIn("test-author", reason)
            self.assertIn("1.50", reason)
            self.assertIn("1.00", reason)


# ---------------------------------------------------------------------------
# #1269 review Fix 1: structured budget marker on the TRIGGERING phase's own
# status.json — reuses the write_phase_verdict (#1181) merge pattern so a
# budget-stopped phase is distinguishable from a genuine agent failure, both
# of which otherwise write status="failed" with nothing else to tell them
# apart.
# ---------------------------------------------------------------------------

class TestBudgetMarkerOnPhaseArtifact(unittest.TestCase):

    def test_triggering_phase_status_json_carries_budget_marker(self):
        """A clean-phase breach (status==0 on its own) marks the TRIGGERING
        phase's own status.json with budgetExceeded + spent/ceiling."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(0)
            mock_usage = MagicMock()
            run_id = "test-run-budget-marker"

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=1.50), \
                 patch("agentrail.run.pipeline.push_failure_event"):

                run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    run_id=run_id,
                    budget_usd=1.00,
                )

            status_file = Path(tmp) / "runs" / run_id / "test-author" / "status.json"
            data = json.loads(status_file.read_text())
            self.assertIs(data["budgetExceeded"], True)
            self.assertEqual(data["budgetSpentUsd"], 1.50)
            self.assertEqual(data["budgetCeilingUsd"], 1.00)
            # The generic exit-code fields survive untouched alongside the marker.
            self.assertEqual(data["status"], "failed")

    def test_marker_absent_on_phase_that_completes_under_budget(self):
        """No budget stop at all -> the phase's status.json never gains the
        marker key (absent, not False)."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
            mock_usage = MagicMock()
            run_id = "test-run-budget-marker-absent"

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=0.25), \
                 patch("agentrail.run.pipeline.push_failure_event"):

                run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    run_id=run_id,
                    budget_usd=1.00,
                )

            status_file = Path(tmp) / "runs" / run_id / "test-author" / "status.json"
            data = json.loads(status_file.read_text())
            self.assertNotIn("budgetExceeded", data)


# ---------------------------------------------------------------------------
# #1269 review Fix 2: double-classification — a phase that ALREADY failed on
# its own (status != 0, e.g. a timeout) must not have that specific,
# evidence-bearing failure suppressed in favor of the generic budget message,
# even when the same cost tick also crosses the ceiling. The ceiling-crossed
# FACT is still recorded in run.json, and the run still stops (the phase's
# own non-zero status already gates every later phase off).
# ---------------------------------------------------------------------------

class TestBudgetDoesNotSuppressGenuinePhaseFailure(unittest.TestCase):

    def test_timeout_and_breach_generic_push_fires_not_budget_push(self):
        """Phase exits 124 (timeout) on its own AND the same cost tick crosses
        the ceiling: the generic timeout push must fire (with evidence); the
        budget_exceeded push must NOT; run.json still records the ceiling
        fact; the phase's own status.json gets no budgetExceeded marker
        (Fix 1 stays scoped to the CLEAN-breach case only)."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)

            stub = _stub_run_with_timeout(124, output_text="agent timed out mid-edit")
            mock_usage = MagicMock()
            run_id = "test-run-timeout-and-breach"

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=1.50), \
                 patch("agentrail.run.pipeline.push_failure_event") as mock_push:

                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    run_id=run_id,
                    budget_usd=1.00,
                )

            self.assertNotEqual(rc, 0)
            # Only test-author ran; the breach (whichever kind) stops the run
            # before execute.
            self.assertEqual(len(stub.calls), 1)

            # Exactly one failure push — the generic timeout push — never a
            # second "budget_exceeded" push for the same phase. The 17c call
            # site passes failure_type/phase positionally and evidence as a
            # kwarg, so read positional/kwargs directly rather than reusing
            # the all-positional-or-all-kwargs helper the budget-path tests
            # above use (that helper would look for "failure_type" inside a
            # kwargs dict that here only ever contains "evidence").
            mock_push.assert_called_once()
            call = mock_push.call_args
            failure_type = call.args[2]
            phase = call.args[3]
            evidence = call.kwargs.get("evidence", "")
            self.assertEqual(failure_type, "timeout")
            self.assertEqual(phase, "test-author")
            self.assertIn("agent timed out mid-edit", evidence)

            # The phase's own artifact has no budgetExceeded marker — the
            # timeout, not the budget, is this phase's recorded cause.
            status_file = Path(tmp) / "runs" / run_id / "test-author" / "status.json"
            status_data = json.loads(status_file.read_text())
            self.assertNotIn("budgetExceeded", status_data)

            # run.json still names the ceiling-crossed FACT even though it
            # was not blockedReason's cause.
            metadata_file = Path(tmp) / "runs" / run_id / "run.json"
            run_data = json.loads(metadata_file.read_text())
            self.assertTrue(run_data.get("budgetCeilingCrossed"))
            self.assertNotIn("blockedReason", run_data)


# ---------------------------------------------------------------------------
# Budget-source visibility (#1269 follow-up / #1274 / #1275, 2026-07-18):
# resolve_budget_source / effective_budget_source truth table. Mirrors
# resolve_default_budget / effective_budget's own precedence and validity
# rules exactly — the two pairs must never disagree about SOURCE while
# agreeing on VALUE.
# ---------------------------------------------------------------------------

class TestResolveBudgetSource(unittest.TestCase):
    """"config" only when budgets.per_issue_usd is a genuinely valid, usable
    number; every other case (absent, null, non-numeric, boolean, negative)
    is "default" — the exact validity split resolve_default_budget applies
    before it falls back to DEFAULT_PER_ISSUE_BUDGET_USD."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "target"
        self.target.mkdir(parents=True)

    def test_no_config_file_is_default(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        self.assertEqual(resolve_budget_source(str(self.target)), "default")

    def test_config_without_budgets_key_is_default(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"runner": {"name": "claude"}})
        self.assertEqual(resolve_budget_source(str(self.target)), "default")

    def test_valid_config_value_is_config(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": 5.0}})
        self.assertEqual(resolve_budget_source(str(self.target)), "config")

    def test_numeric_string_config_value_is_config(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": "3.5"}})
        self.assertEqual(resolve_budget_source(str(self.target)), "config")

    def test_explicit_zero_config_value_is_config(self) -> None:
        """0 is a deliberate, honored "uncapped" choice from config — still
        "config", not "default" (resolve_default_budget returns 0.0 here,
        not the product default)."""
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": 0}})
        self.assertEqual(resolve_budget_source(str(self.target)), "config")

    def test_negative_config_value_is_default(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": -3}})
        self.assertEqual(resolve_budget_source(str(self.target)), "default")

    def test_non_numeric_config_value_is_default(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": "lots"}})
        self.assertEqual(resolve_budget_source(str(self.target)), "default")

    def test_boolean_config_value_is_default(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": True}})
        self.assertEqual(resolve_budget_source(str(self.target)), "default")

    def test_null_config_value_is_default(self) -> None:
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": None}})
        self.assertEqual(resolve_budget_source(str(self.target)), "default")

    def test_silent_no_warning_on_invalid_value(self) -> None:
        """Unlike resolve_default_budget, this function never warns to
        stderr — the warning stays resolve_default_budget's job alone, so a
        call site that consults BOTH (effective_budget_source alongside
        effective_budget) never prints it twice for the same bad value."""
        from agentrail.cli.commands.run import resolve_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": "lots"}})
        err = io.StringIO()
        with redirect_stderr(err):
            resolve_budget_source(str(self.target))
        self.assertEqual(err.getvalue(), "")


class TestEffectiveBudgetSource(unittest.TestCase):
    """effective_budget_source: flag > config > default — same precedence as
    effective_budget — plus the opts.budget_source override channel that lets
    a caller (agentrail afk) state the real source honestly even when
    --budget-usd is also present."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "target"
        self.target.mkdir(parents=True)

    def test_explicit_flag_is_flag(self) -> None:
        from agentrail.cli.commands.run import effective_budget_source, parse_run_options
        opts = parse_run_options(["--target", str(self.target), "--budget-usd", "2"])
        self.assertEqual(effective_budget_source(opts), "flag")

    def test_explicit_flag_zero_is_still_flag(self) -> None:
        from agentrail.cli.commands.run import effective_budget_source, parse_run_options
        opts = parse_run_options(["--target", str(self.target), "--budget-usd", "0"])
        self.assertEqual(effective_budget_source(opts), "flag")

    def test_config_only_is_config(self) -> None:
        from agentrail.cli.commands.run import RunOptions, effective_budget_source
        _write_config(self.target, {"budgets": {"per_issue_usd": 5.0}})
        opts = RunOptions(target=str(self.target))
        self.assertEqual(effective_budget_source(opts), "config")

    def test_neither_flag_nor_config_is_default(self) -> None:
        from agentrail.cli.commands.run import RunOptions, effective_budget_source
        opts = RunOptions(target=str(self.target))
        self.assertEqual(effective_budget_source(opts), "default")

    def test_override_wins_over_explicit_flag(self) -> None:
        """The AFK-relay case: --budget-usd is present (would otherwise infer
        "flag") but --budget-source explicitly says the real source was the
        product default — the override must win."""
        from agentrail.cli.commands.run import effective_budget_source, parse_run_options
        opts = parse_run_options([
            "--target", str(self.target),
            "--budget-usd", "3",
            "--budget-source", "default",
        ])
        self.assertEqual(effective_budget_source(opts), "default")

    def test_override_wins_over_config(self) -> None:
        from agentrail.cli.commands.run import effective_budget_source, parse_run_options
        _write_config(self.target, {"budgets": {"per_issue_usd": 5.0}})
        opts = parse_run_options(["--target", str(self.target), "--budget-source", "config"])
        self.assertEqual(effective_budget_source(opts), "config")


class TestParseRunOptionsBudgetSourceFlag(unittest.TestCase):
    """--budget-source is optional and, when absent, leaves RunOptions in the
    "not overridden" state ("") that effective_budget_source computes normally
    from — a tiny, additive parser change."""

    def test_flag_absent_leaves_budget_source_empty(self) -> None:
        from agentrail.cli.commands.run import parse_run_options
        opts = parse_run_options([])
        self.assertEqual(opts.budget_source, "")

    def test_flag_sets_budget_source_verbatim(self) -> None:
        from agentrail.cli.commands.run import parse_run_options
        opts = parse_run_options(["--budget-source", "default"])
        self.assertEqual(opts.budget_source, "default")

    def test_flag_requires_a_value(self) -> None:
        from agentrail.cli.commands.run import UsageError, parse_run_options
        with self.assertRaises(UsageError):
            parse_run_options(["--budget-source"])

    def test_rejects_garbage_value(self) -> None:
        """#1269 PR2b item 3: --budget-source was silently permissive — any
        string parsed clean and just behaved as "not default" downstream
        (effective_budget_source). A typo must now raise, not silently
        degrade."""
        from agentrail.cli.commands.run import UsageError, parse_run_options
        with self.assertRaises(UsageError) as ctx:
            parse_run_options(["--budget-source", "lol"])
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("--budget-source must be flag, config, or default",
                      str(ctx.exception))

    def test_accepts_all_three_valid_sources(self) -> None:
        from agentrail.cli.commands.run import parse_run_options
        for value in ("flag", "config", "default"):
            with self.subTest(value=value):
                opts = parse_run_options(["--budget-source", value])
                self.assertEqual(opts.budget_source, value)


# ---------------------------------------------------------------------------
# Budget-source visibility: the stop message (stderr) / run.json blockedReason
# gain the resume guidance ONLY when budget_source == "default" (the
# estimate-absent backstop) — a flag or config ceiling was a deliberate
# choice someone made, so those keep the original, unembellished phrasing.
# check()'s own inputs/semantics are untouched by any of this (verified above
# by the pre-existing TestPerPhaseBudgetBreach etc., which still pass).
# ---------------------------------------------------------------------------

class TestBudgetStopMessageSourceGuidance(unittest.TestCase):

    def _run_with_source(self, tmp: str, target: Path, run_id: str, budget_source):
        stub = _stub_run_with_timeout(0)
        mock_usage = MagicMock()
        err = io.StringIO()
        kwargs = {} if budget_source is None else {"budget_source": budget_source}

        with patch("agentrail.run.pipeline.run_with_timeout", stub), \
             patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
             patch("agentrail.run.pipeline.cost_usd", return_value=1.50), \
             patch("agentrail.run.pipeline.push_failure_event"), \
             redirect_stderr(err):
            run_issue(
                target, 42,
                agent="claude", command="claude -p",
                repo_dir=target,
                log_dir=Path(tmp) / "runs",
                run_id=run_id,
                budget_usd=1.00,
                **kwargs,
            )

        metadata_file = Path(tmp) / "runs" / run_id / "run.json"
        data = json.loads(metadata_file.read_text())
        return data.get("blockedReason", ""), err.getvalue()

    def test_default_source_stop_message_carries_resume_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            reason, err = self._run_with_source(tmp, target, "test-run-src-default", "default")

        for text in (reason, err):
            self.assertIn("estimate-absent backstop", text)
            self.assertIn("not a hard limit", text)
            self.assertIn("--budget-usd", text)
            self.assertIn("budgets.per_issue_usd", text)
            self.assertIn("#1274/#1275", text)
        # the original, unembellished phrasing is still the message's prefix.
        self.assertIn("budget exceeded after test-author phase", reason)

    def test_omitted_kwarg_behaves_like_default_source(self) -> None:
        """RunContext/run_issue's own default ("default") is the same honest,
        conservative assumption as passing budget_source="default"
        explicitly — a caller that never says otherwise gets the resumable
        estimate-absent framing, not silence about the source."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            reason, err = self._run_with_source(tmp, target, "test-run-src-omitted", None)

        self.assertIn("estimate-absent backstop", reason)
        self.assertIn("estimate-absent backstop", err)

    def test_flag_source_stop_message_omits_resume_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            reason, err = self._run_with_source(tmp, target, "test-run-src-flag", "flag")

        for text in (reason, err):
            self.assertNotIn("estimate-absent backstop", text)
            self.assertNotIn("#1274/#1275", text)
        self.assertIn("budget exceeded after test-author phase", reason)

    def test_config_source_stop_message_omits_resume_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            reason, err = self._run_with_source(tmp, target, "test-run-src-config", "config")

        for text in (reason, err):
            self.assertNotIn("estimate-absent backstop", text)
            self.assertNotIn("#1274/#1275", text)
        self.assertIn("budget exceeded after test-author phase", reason)


# ---------------------------------------------------------------------------
# #1269 PR2b item 2: the pushed budget_exceeded failure event's message must
# be the SAME rc.budget_stop_reason string run.json's blockedReason gets — not
# the old plain dollar-figure budget_msg, which never named the phase and
# never carried the resume guidance. failure_type must stay "budget_exceeded"
# unconditionally (downstream consumers key on it) — only message changes.
# ---------------------------------------------------------------------------

class TestBudgetExceededPushCarriesResumeGuidance(unittest.TestCase):

    def _run_and_capture_push(self, tmp: str, target: Path, run_id: str, budget_source):
        stub = _stub_run_with_timeout(0)
        mock_usage = MagicMock()
        kwargs = {} if budget_source is None else {"budget_source": budget_source}

        with patch("agentrail.run.pipeline.run_with_timeout", stub), \
             patch("agentrail.run.pipeline.capture_usage", return_value=mock_usage), \
             patch("agentrail.run.pipeline.cost_usd", return_value=1.50), \
             patch("agentrail.run.pipeline.push_failure_event") as mock_push, \
             redirect_stderr(io.StringIO()):
            run_issue(
                target, 42,
                agent="claude", command="claude -p",
                repo_dir=target,
                log_dir=Path(tmp) / "runs",
                run_id=run_id,
                budget_usd=1.00,
                **kwargs,
            )

        metadata_file = Path(tmp) / "runs" / run_id / "run.json"
        blocked_reason = json.loads(metadata_file.read_text()).get("blockedReason", "")
        return blocked_reason, mock_push

    def test_default_source_push_message_matches_blocked_reason_with_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            blocked_reason, mock_push = self._run_and_capture_push(
                tmp, target, "test-run-push-default", "default"
            )

        mock_push.assert_called_once()
        call = mock_push.call_args
        # positional: (target_dir, run_id, failure_type, phase, message)
        self.assertEqual(call.args[2], "budget_exceeded")  # failure_type stable
        pushed_message = call.args[4]
        self.assertEqual(pushed_message, blocked_reason)
        self.assertIn("estimate-absent backstop", pushed_message)
        self.assertIn("budget exceeded after test-author phase", pushed_message)

    def test_flag_source_push_message_matches_blocked_reason_without_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            blocked_reason, mock_push = self._run_and_capture_push(
                tmp, target, "test-run-push-flag", "flag"
            )

        call = mock_push.call_args
        self.assertEqual(call.args[2], "budget_exceeded")
        pushed_message = call.args[4]
        self.assertEqual(pushed_message, blocked_reason)
        self.assertNotIn("estimate-absent backstop", pushed_message)
        self.assertIn("budget exceeded after test-author phase", pushed_message)

    def test_config_source_push_message_matches_blocked_reason_without_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            blocked_reason, mock_push = self._run_and_capture_push(
                tmp, target, "test-run-push-config", "config"
            )

        call = mock_push.call_args
        self.assertEqual(call.args[2], "budget_exceeded")
        pushed_message = call.args[4]
        self.assertEqual(pushed_message, blocked_reason)
        self.assertNotIn("estimate-absent backstop", pushed_message)


if __name__ == "__main__":
    unittest.main()
