"""Tests for Independent Review visibility (issue #1270, PR (1)).

The verify/critic seat is the crux of "not vibe coding". It silently does not
run on a default single-model install (no config change needed to reproduce —
this repo's own live config lacks ``models.verify``), and the run proceeds on
the executor's own test results only, with nothing anywhere recording that
this happened. This PR does not change WHEN the seat runs (no behavior change
to phase selection) — it makes that state visible and, on the hosted fleet,
mandatory:

* AC1: every hosted run's record shows an independent-review verdict — a
  hosted run (``AGENTRAIL_HOSTED=1``) with no distinct reviewer model refuses
  to start at all (fatal, before any phase runs); one with a distinct model
  proceeds and its run.json ends up with ``independentReview: "active"``.
* AC2: a single-model local run prints an unmissable warning in the run header
  and the same reason lands in run.json's ``independentReview`` field.

Covers both the pure reason/message helpers directly, and the wiring into
``run_issue`` end-to-end (mirrors the harness shape of
``tests/run/test_budget_guardrail.py``).
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run import pipeline
from agentrail.run.pipeline import run_issue


# ---------------------------------------------------------------------------
# Pure helpers: is_hosted_run
# ---------------------------------------------------------------------------

class IsHostedRunTests(unittest.TestCase):
    def test_absent_is_not_hosted(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(pipeline.AGENTRAIL_HOSTED_ENV, None)
            self.assertFalse(pipeline.is_hosted_run())

    def test_explicit_one_is_hosted(self) -> None:
        with patch.dict(os.environ, {pipeline.AGENTRAIL_HOSTED_ENV: "1"}):
            self.assertTrue(pipeline.is_hosted_run())

    def test_explicit_zero_is_not_hosted(self) -> None:
        with patch.dict(os.environ, {pipeline.AGENTRAIL_HOSTED_ENV: "0"}):
            self.assertFalse(pipeline.is_hosted_run())

    def test_arbitrary_value_is_not_hosted(self) -> None:
        """Opt-in-only convention (same as jit_gather_enabled): only an
        explicit "1" counts, so a stray/typo'd value never accidentally
        treats a developer's own machine as the hosted fleet."""
        with patch.dict(os.environ, {pipeline.AGENTRAIL_HOSTED_ENV: "true"}):
            self.assertFalse(pipeline.is_hosted_run())


# ---------------------------------------------------------------------------
# Pure helpers: independent_review_metadata_value
# ---------------------------------------------------------------------------

class IndependentReviewMetadataValueTests(unittest.TestCase):
    def test_active_passes_through(self) -> None:
        self.assertEqual(pipeline.independent_review_metadata_value("active"), "active")

    def test_skipped_no_distinct_model_reformatted(self) -> None:
        self.assertEqual(
            pipeline.independent_review_metadata_value("skipped_no_distinct_model"),
            "skipped:no_distinct_model",
        )

    def test_skipped_layer_off_reformatted(self) -> None:
        self.assertEqual(
            pipeline.independent_review_metadata_value("skipped_layer_off"),
            "skipped:layer_off",
        )

    def test_skipped_explicit_command_reformatted(self) -> None:
        self.assertEqual(
            pipeline.independent_review_metadata_value("skipped_explicit_command"),
            "skipped:explicit_command",
        )


# ---------------------------------------------------------------------------
# Pure helpers: warning / fatal message content (AC1/AC2 — names the reason
# AND the exact config that fixes it)
# ---------------------------------------------------------------------------

class IndependentReviewMessageContentTests(unittest.TestCase):
    def test_warning_names_missing_verify_config(self) -> None:
        msg = pipeline._independent_review_warning("claude", "skipped_no_distinct_model")
        self.assertIn("WARNING", msg)
        self.assertIn("runners.claude.models.verify", msg)

    def test_fatal_names_missing_verify_config(self) -> None:
        msg = pipeline._independent_review_fatal_message("claude", "skipped_no_distinct_model")
        self.assertIn("FATAL", msg)
        self.assertIn("runners.claude.models.verify", msg)

    def test_warning_names_layer_override_for_layer_off(self) -> None:
        msg = pipeline._independent_review_warning("claude", "skipped_layer_off")
        self.assertIn("VERIFY_GATE", msg)

    def test_warning_names_command_flag_for_explicit_command(self) -> None:
        msg = pipeline._independent_review_warning("claude", "skipped_explicit_command")
        self.assertIn("--command", msg)

    def test_agent_name_is_interpolated(self) -> None:
        msg = pipeline._independent_review_warning("codex", "skipped_no_distinct_model")
        self.assertIn("runners.codex.models.verify", msg)


# ---------------------------------------------------------------------------
# End-to-end wiring: run_issue (mirrors tests/run/test_budget_guardrail.py)
# ---------------------------------------------------------------------------

def _make_target(tmp_dir: str) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    # Verification spine ON BY DEFAULT (MVP): a successful run needs a genuine
    # red→green trail, so the sentinel-file verify is RED at baseline and
    # turned GREEN by the execute phase (flow: test-author -> execute).
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {target / 'impl_done'}"})
    )
    return target


def _stub_run_with_timeout(return_code: int, output_text: str = "agent output",
                           sentinel: Path | None = None):
    """When ``sentinel`` is given it is created on the SECOND call (execute,
    after test-author) so the red->green trail is genuine and the gate can
    reach GREEN."""
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
    mocks = {}
    for p in COMMON_PATCHES:
        m = patch(p)
        mock = m.start()
        test_case.addCleanup(m.stop)
        mocks[p] = mock

    # Keep these tests focused on independent-review visibility, unaffected by
    # unrelated cost-reduction eval layers (diff-enforce retries / best-of-N
    # would change the expected run_with_timeout call count).
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
    mocks["subprocess.run"].return_value = MagicMock(returncode=0, stdout="")
    return mocks


def _read_run_json(tmp: str) -> dict:
    """Read back run.json from the run dir. Tests in this file all pass
    ``log_dir=Path(tmp) / "runs"`` explicitly to run_issue, so that (not
    target/.agentrail/runs) is where the run directory lands."""
    runs_dir = Path(tmp) / "runs"
    run_dirs = sorted(runs_dir.iterdir())
    run_json_path = run_dirs[-1] / "run.json"
    return json.loads(run_json_path.read_text())


class HostedNoDistinctModelRefusesToStart(unittest.TestCase):
    """AC1: a hosted run with no independent reviewer configured never
    proceeds — fatal exit before any phase runs."""

    def test_hosted_and_skipped_exits_nonzero_before_any_phase(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            stub = _stub_run_with_timeout(0)
            err = io.StringIO()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch.dict(os.environ, {"AGENTRAIL_HOSTED": "1"}), \
                 redirect_stderr(err):
                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    independent_review_status="skipped_no_distinct_model",
                )

            self.assertNotEqual(rc, 0)
            self.assertEqual(len(stub.calls), 0, "no phase should have run")
            self.assertIn("FATAL", err.getvalue())
            self.assertIn("runners.claude.models.verify", err.getvalue())

    def test_hosted_and_skipped_layer_off_also_refuses(self) -> None:
        """Any non-active status is fatal on hosted, not just the
        no-distinct-model case."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            stub = _stub_run_with_timeout(0)
            err = io.StringIO()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch.dict(os.environ, {"AGENTRAIL_HOSTED": "1"}), \
                 redirect_stderr(err):
                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    independent_review_status="skipped_layer_off",
                )

            self.assertNotEqual(rc, 0)
            self.assertEqual(len(stub.calls), 0)


class HostedActiveProceeds(unittest.TestCase):
    """AC1: a hosted run WITH a distinct reviewer model proceeds normally and
    its run.json records the active verdict."""

    def test_hosted_and_active_runs_to_completion_and_records_active(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=MagicMock()), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=0.0), \
                 patch.dict(os.environ, {"AGENTRAIL_HOSTED": "1"}):
                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    independent_review_status="active",
                )

            self.assertEqual(rc, 0)
            self.assertEqual(len(stub.calls), 2, "test-author + execute should both run")
            data = _read_run_json(tmp)
            self.assertEqual(data["independentReview"], "active")


class LocalSkipWarnsAndRecords(unittest.TestCase):
    """AC2: a local (non-hosted) single-model run is NOT blocked — it prints
    the loud warning and still finishes, with the reason recorded."""

    def test_local_skip_prints_warning_proceeds_and_records_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
            out = io.StringIO()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=MagicMock()), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=0.0), \
                 patch.dict(os.environ, {}, clear=False), \
                 redirect_stdout(out):
                os.environ.pop("AGENTRAIL_HOSTED", None)
                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    independent_review_status="skipped_no_distinct_model",
                )

            # Not blocked: the run still completes.
            self.assertEqual(rc, 0)
            self.assertEqual(len(stub.calls), 2)
            self.assertIn("WARNING", out.getvalue())
            self.assertIn("runners.claude.models.verify", out.getvalue())
            data = _read_run_json(tmp)
            self.assertEqual(data["independentReview"], "skipped:no_distinct_model")


class LocalActiveIsSilent(unittest.TestCase):
    """No behavior change when the seat IS active: no warning, no fatal
    exit, and run.json simply says "active" — byte-identical run shape."""

    def test_local_active_prints_no_warning_and_records_active(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
            out = io.StringIO()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=MagicMock()), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=0.0), \
                 patch.dict(os.environ, {}, clear=False), \
                 redirect_stdout(out):
                os.environ.pop("AGENTRAIL_HOSTED", None)
                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    independent_review_status="active",
                )

            self.assertEqual(rc, 0)
            self.assertNotIn("WARNING", out.getvalue())
            self.assertNotIn("independent review", out.getvalue().lower())
            data = _read_run_json(tmp)
            self.assertEqual(data["independentReview"], "active")

    def test_default_param_value_is_active_unchanged_call_sites(self) -> None:
        """Callers that never pass independent_review_status (any pre-#1270
        direct caller) default to "active" — no warning, no fatal exit, the
        pre-existing behavior is exactly preserved."""
        with tempfile.TemporaryDirectory() as tmp:
            target = _make_target(tmp)
            _apply_common_patches(self, target)
            stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
            out = io.StringIO()

            with patch("agentrail.run.pipeline.run_with_timeout", stub), \
                 patch("agentrail.run.pipeline.capture_usage", return_value=MagicMock()), \
                 patch("agentrail.run.pipeline.cost_usd", return_value=0.0), \
                 patch.dict(os.environ, {}, clear=False), \
                 redirect_stdout(out):
                os.environ.pop("AGENTRAIL_HOSTED", None)
                rc = run_issue(
                    target, 42,
                    agent="claude", command="claude -p",
                    repo_dir=target,
                    log_dir=Path(tmp) / "runs",
                    # independent_review_status intentionally omitted
                )

            self.assertEqual(rc, 0)
            self.assertNotIn("WARNING", out.getvalue())
            data = _read_run_json(tmp)
            self.assertEqual(data["independentReview"], "active")


if __name__ == "__main__":
    unittest.main()
