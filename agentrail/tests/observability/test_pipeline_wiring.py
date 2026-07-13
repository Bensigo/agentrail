"""Wiring contract: flag off => pipeline makes zero Langfuse calls;
flag on => one generation per phase cost-capture, cost passed through verbatim.

Task 3 (langfuse-tracing-shadow-judge PRD, Phase 1/2 plan) wires
``agentrail.observability.tracer.RunTracer`` into
``agentrail/run/pipeline.py``'s ``_run_pipeline`` / ``run_issue_phase``.

Step 1 findings (exact seams as read in this worktree — NOT the plan's
estimated line numbers, which had drifted):

  * ``run_id`` becomes final at pipeline.py:1179-1182 (``run_id = run_id or
    (...)``), BEFORE ``write_run_metadata`` at :1194-1206. ``RunContext`` is
    constructed at :1226-1243, AFTER both — so ``rc`` always has a final
    ``run_id`` at construction time; there is no "rc built before run_id"
    case to handle.
  * The tracer is attached immediately after the ``RunContext(...)`` call
    (pipeline.py, new step "10a"), via ``rc.tracer = RunTracer.start(run_id,
    session_id=..., metadata={"agent": agent, "label": str(label)})``,
    wrapped in its own try/except.
  * There are TWO "finish" exit paths in ``_run_pipeline``, not one:
      1. the read-side injection re-screen park/block path (originally
         :1245-1293 pre-edit; a ``state_mod.update_run_state(..., "finish",
         ...)`` with ``exit_status=2`` followed by ``return 2``) — this path
         runs AFTER ``rc`` (and thus ``rc.tracer``) already exists.
      2. the normal end-of-function finish path (originally :1569-1599
         pre-edit; ``exit_status=status`` followed by ``return status``).
    Both now call ``rc.tracer.finish(<the same exit status passed to
    update_run_state>)`` in their own try/except, so a trace started for a
    parked/blocked run still gets its exit_status recorded instead of being
    left dangling.
  * The cost-capture block is pipeline.py's ``if usage:`` at (post-edit)
    ~:537, inside ``run_issue_phase``. ``usage`` there is a
    ``agentrail.run.usage_capture.Usage`` DATACLASS instance (fields:
    ``model: str``, ``input_tokens: int``, ``output_tokens: int``,
    ``cache_tokens: int``, ``cache_creation_tokens: int = 0``) — NOT a dict.
    ``RunTracer.phase_generation`` expects ``usage: dict`` (it stores it
    verbatim as ``usageDetails``), so the wiring maps the Usage dataclass's
    fields 1:1 into a dict via ``dataclasses.asdict(usage)`` rather than
    passing the dataclass instance directly (passing the raw instance would
    silently break JSON serialization at ingest time whenever a real
    Langfuse client is configured — non-fatal, but it would silently drop
    every phase generation event).
  * ``agentrail.run.pricing.cost_breakdown(usage, *, rerank_usd=0.0) ->
    Dict[str, float]`` was NOT already imported in pipeline.py (only
    ``cost_usd`` was) — added to the existing
    ``from agentrail.run.pricing import ...`` line. It takes the SAME
    ``Usage`` object as ``cost_usd`` (not a dict) and returns a flat
    category -> USD dict (``input_usd``, ``output_usd``, ``cache_read_usd``,
    ``cache_write_usd``, ``expansion_usd``, ``rerank_usd``, ``total_usd``),
    which matches ``RunTracer.phase_generation``'s ``breakdown: Optional[dict]``
    param exactly with no adaptation needed.
  * ``RunContext`` (pipeline.py) has NO ``model`` field, so the plan's literal
    ``getattr(rc, "model", None)`` for the generation's ``model`` argument
    would always be ``None``. ``usage.model`` — the model actually observed
    in the transcript for this phase — is the correct, already-available
    value and is used instead (``usage.model or None``).
  * ``RunContext`` gained a new field, ``tracer: RunTracer =
    field(default_factory=lambda: RunTracer(None, "", "", {}))``. Defaulting
    to an INERT ``RunTracer`` (client=None, so every method is a guaranteed
    no-op — see ``RunTracer._safe_emit``) rather than ``None`` means every
    call site (including ``run_issue_phase``'s cost block, and every
    existing test in ``agentrail/tests/run/test_pipeline.py`` etc. that
    builds a bare ``RunContext(...)`` without passing ``tracer=``) can call
    ``rc.tracer.phase_generation(...)`` / ``rc.tracer.finish(...)``
    unconditionally, with no ``if rc.tracer`` guard anywhere — matching the
    brief's stated contract ("set unconditionally ... so the phase code
    needs no if").

No helper function was extracted for the cost-block wiring (the brief's
Step 2 mentioned an anticipated ``_trace_phase_cost(rc, phase, usage, cost,
phase_start_ts)`` helper, but Step 3's own literal code sample wires the
call inline, matching this file's existing house style of inlining each
non-fatal telemetry step in its own try/except right next to the block it
augments — e.g. the cost ledger write two lines above it is inlined the same
way). Extracting a helper was judged an unnecessary structural change to a
"live, critical, heavily-tested file" beyond the brief's named insertion
points, so the tests below exercise the real call sites directly
(``run_issue_phase``) rather than a helper that does not exist.
"""
from __future__ import annotations

import dataclasses
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.observability import langfuse_client as lc
from agentrail.observability.tracer import RunTracer
from agentrail.run.pipeline import RunContext, run_issue_phase
from agentrail.run.pricing import cost_usd
from agentrail.run.usage_capture import Usage


# ---------------------------------------------------------------------------
# Step 2 (brief's given test): the underlying tracer contract this wiring
# depends on — flag off => the pipeline's use of RunTracer never reaches the
# transport, regardless of what pipeline.py does with it.
# ---------------------------------------------------------------------------

def test_flag_off_pipeline_never_touches_transport(monkeypatch):
    monkeypatch.delenv("AGENTRAIL_LANGFUSE_ENABLED", raising=False)

    def explode(*a, **k):
        raise AssertionError("langfuse transport called with flag off")
    monkeypatch.setattr(lc, "_request", explode)

    t = RunTracer.start("run-inert")
    t.phase_generation("execute", {"input": 1}, 0.0, None, 0.0, None)
    t.finish(0)


# ---------------------------------------------------------------------------
# Integration-shaped tests against the REAL pipeline.py seams.
# ---------------------------------------------------------------------------

def _make_target(tmp_dir: str) -> Path:
    """Minimal .agentrail/ scaffold so run_issue_phase's non-fatal side
    blocks (state update, format enforcement, activity push) have real files
    to operate on. Mirrors agentrail/tests/run/test_pipeline.py's helper of
    the same name (duplicated here rather than imported, to keep this test
    file's scope self-contained per the task's file-touch list)."""
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    (agentrail_dir / "config.json").write_text(json.dumps({}))
    return target


def _make_rc(target: Path, run_dir: Path) -> RunContext:
    return RunContext(
        target_dir=target,
        repo_dir=target,
        issue=42,
        agent="claude",
        agent_command="claude --dangerously-skip-permissions",
        run_id="run-abc123",
        run_dir=run_dir,
        started_at="2026-06-10T00:00:00Z",
        metadata_file=run_dir / "run.json",
        base_prompt="Do the thing.",
        resolution_text="Fix the bug.",
        run_context_pack_file=None,
        max_execution_attempts=5,
        agent_timeout=1800,
        failed_verification_attempts=0,
    )


def _stub_run_with_timeout(return_code: int, output_text: str = "agent output"):
    def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        output_file.write_text(output_text)
        return return_code
    return _stub


_USAGE = Usage(
    model="claude-3-5-sonnet-20241022",
    input_tokens=1000,
    output_tokens=200,
    cache_tokens=50,
    cache_creation_tokens=10,
)


class RunContextTracerDefaultTests(unittest.TestCase):
    """rc.tracer must exist and be inert by default — never None, never a
    live client — so callers built without going through _run_pipeline's
    RunTracer.start() wiring (every existing RunContext(...) construction in
    agentrail/tests/run/) stay exactly as safe as before this change."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        self.rc = _make_rc(target, Path(self._tmp.name) / "run")

    def tearDown(self):
        self._tmp.cleanup()

    def test_default_tracer_is_a_real_inert_runtracer_not_none(self):
        self.assertIsInstance(self.rc.tracer, RunTracer)

    def test_default_tracer_never_touches_transport(self):
        with patch.object(lc, "_request", side_effect=AssertionError("transport touched")):
            # No `if rc.tracer` guard anywhere in pipeline.py — these must be
            # safe to call unconditionally.
            self.rc.tracer.phase_generation(
                "execute", dataclasses.asdict(_USAGE), 0.01, None, 0.0, "m"
            )
            self.rc.tracer.finish(0)


class RunIssuePhaseFlagOffTests(unittest.TestCase):
    """flag off (AGENTRAIL_LANGFUSE_ENABLED unset) => run_issue_phase's cost
    block makes zero Langfuse network calls, end to end through the real
    ``if usage:`` cost-capture block (not just the tracer in isolation)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        self.target = target
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(target, self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.capture_usage", return_value=_USAGE)
    def test_zero_langfuse_calls_with_flag_off(
        self, mock_capture_usage, mock_summary, mock_build,
    ):
        with patch.object(lc, "_request", side_effect=AssertionError("transport touched")):
            stub = _stub_run_with_timeout(0)
            with patch("agentrail.run.pipeline.run_with_timeout", stub):
                exit_status, _ = run_issue_phase(self.rc, "execute", 1)

        self.assertEqual(exit_status, 0)


class RunIssuePhaseCostPassthroughTests(unittest.TestCase):
    """flag on => one generation-create per phase cost-capture, with the
    already-computed cost passed through VERBATIM (no recompute of usage or
    cost; cost_breakdown(usage) is a fresh but pure/deterministic call)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        self.target = target
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(target, self.run_dir)

        self._batches = []

        def fake_request(method, url, headers, data, timeout):
            self._batches.append(json.loads(data)["batch"])
            return 207, b"{}"

        self._env = patch.dict(
            "os.environ",
            {
                "AGENTRAIL_LANGFUSE_ENABLED": "1",
                "LANGFUSE_HOST": "http://localhost:3000",
                "LANGFUSE_PUBLIC_KEY": "pk",
                "LANGFUSE_SECRET_KEY": "sk",
            },
        )
        self._env.start()
        self._request_patch = patch.object(lc, "_request", fake_request)
        self._request_patch.start()

        # Simulates what _run_pipeline's step 10a does after `rc =
        # RunContext(...)`, without re-running the whole pipeline.
        self.rc.tracer = RunTracer.start(self.rc.run_id)

    def tearDown(self):
        self._request_patch.stop()
        self._env.stop()
        self._tmp.cleanup()

    def _generation_events(self):
        return [
            e for batch in self._batches for e in batch
            if e["type"] == "generation-create"
        ]

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.capture_usage", return_value=_USAGE)
    def test_generation_fires_once_per_phase_with_verbatim_cost(
        self, mock_capture_usage, mock_summary, mock_build,
    ):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        gens = self._generation_events()
        self.assertEqual(len(gens), 1)
        body = gens[0]["body"]

        expected_cost = cost_usd(_USAGE)
        self.assertEqual(body["name"], "execute")
        self.assertEqual(body["model"], _USAGE.model)
        self.assertEqual(body["traceId"], lc.deterministic_trace_id(self.rc.run_id))
        # Cost passed through verbatim: the SAME float already computed for
        # the budget guardrail (rc.cumulative_cost_usd), not recomputed.
        self.assertEqual(body["costDetails"]["total"], expected_cost)
        # usageDetails is the Usage dataclass's fields mapped 1:1, verbatim.
        self.assertEqual(body["usageDetails"], dataclasses.asdict(_USAGE))

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.capture_usage", return_value=_USAGE)
    def test_budget_guardrail_cost_accounting_unaffected_by_tracing(
        self, mock_capture_usage, mock_summary, mock_build,
    ):
        """The cost accounting the budget guardrail depends on
        (rc.cumulative_cost_usd) must be identical whether or not tracing is
        wired — tracing must never perturb it."""
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        self.assertEqual(self.rc.cumulative_cost_usd, cost_usd(_USAGE))


if __name__ == "__main__":
    unittest.main()
