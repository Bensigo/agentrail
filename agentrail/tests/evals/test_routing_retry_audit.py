"""Tests for the routing/retry VALUE audit (Finding 4 — measurement only).

These cover the attribution probes that answer the blunt value question the
intrinsic regret/lift probes do not:

- **Routing attribution**: did routing change the model from the recorded
  baseline/default, and if it NEVER diverged, report that explicitly ("had no
  chance to act") rather than as a measured zero.
- **Retry attribution**: how many retries flipped a failure INTO a success
  (wins) vs how many just burned cost (unsolved burns).

Fixture-driven and deterministic, mirroring ``test_probes.py``. Dollars are
asserted EXACTLY against ``usage_cost`` (never hard-coded). Backward-compat is
covered: a record lacking the new ``baseline_model`` field is excluded from
routing attribution (None baseline) rather than crashing, and the audit
renderers fall back to honest "not available"/"no chance to act" copy.
"""

from __future__ import annotations

import pytest

from agentrail.run.usage_capture import Usage

from agentrail.evals.pricing_adapter import usage_cost
from agentrail.evals.run_record import RetryEvent, RunRecord
from agentrail.evals.probes import (
    RetryAttributionReport,
    RoutingAttributionReport,
    ScoredRun,
    retry_attribution,
    routing_attribution,
)
from agentrail.evals.reporter import render_routing_retry_audit_markdown


# Models present in the canonical price table, with a clear cheap/expensive gap.
CHEAP_MODEL = "claude-haiku-4-5"
EXPENSIVE_MODEL = "claude-opus-4-5"


def _usage(
    *,
    model: str,
    input_tokens: int = 1000,
    output_tokens: int = 1000,
    cache_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> Usage:
    return Usage(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_tokens=cache_tokens,
        cache_creation_tokens=cache_creation_tokens,
    )


def _run(
    *,
    task: str,
    arm: str,
    model: str,
    usage: Usage,
    gate_passed: bool = True,
    retries=None,
    baseline_model=None,
) -> RunRecord:
    return RunRecord(
        task=task,
        arm=arm,
        diff="",
        model=model,
        usage=usage,
        wall_time_s=1.0,
        gate_passed=gate_passed,
        retries=list(retries or []),
        baseline_model=baseline_model,
    )


def _scored(run: RunRecord, solved: bool) -> ScoredRun:
    return ScoredRun(run=run, solved=solved)


# ---------------------------------------------------------------------------
# Routing attribution
# ---------------------------------------------------------------------------


def test_routing_diverged_counts_runs_and_spend():
    """A run whose final model differs from baseline is counted as diverged, and
    its realised dollars are attributed to routing's choice."""
    usage = _usage(model=EXPENSIVE_MODEL)
    # baseline (default) is the cheap model; routing escalated to the expensive
    # one — recorded as the run's resolved model.
    run = _run(
        task="t1",
        arm="full",
        model=EXPENSIVE_MODEL,
        usage=usage,
        baseline_model=CHEAP_MODEL,
    )
    report = routing_attribution([_scored(run, solved=True)])

    assert report.runs_with_baseline == 1
    assert report.runs_diverged == 1
    assert report.runs_at_baseline == 0
    assert report.had_chance_to_act is True
    assert report.spent_when_diverged_usd == pytest.approx(usage_cost(usage))
    # No per-run baseline token usage exists -> signed delta stays undefined.
    assert report.net_delta_usd is None


def test_routing_never_diverged_reports_no_chance_to_act():
    """When routing never changes the model from baseline it must report 'had no
    chance to act' (zero divergences), NOT a measured zero-value verdict."""
    runs = [
        _scored(
            _run(
                task="t1",
                arm="full",
                model=CHEAP_MODEL,
                usage=_usage(model=CHEAP_MODEL),
                baseline_model=CHEAP_MODEL,
            ),
            solved=True,
        ),
        _scored(
            _run(
                task="t2",
                arm="full",
                model=EXPENSIVE_MODEL,
                usage=_usage(model=EXPENSIVE_MODEL),
                baseline_model=EXPENSIVE_MODEL,
            ),
            solved=False,
        ),
    ]
    report = routing_attribution(runs)

    assert report.runs_with_baseline == 2
    assert report.runs_diverged == 0
    assert report.runs_at_baseline == 2
    assert report.had_chance_to_act is False
    assert report.spent_when_diverged_usd == pytest.approx(0.0)

    # The rendered report makes the "no chance to act" case explicit.
    md = render_routing_retry_audit_markdown(routing=report, retry=None)
    assert "no chance to act" in md.lower()


def test_routing_divergence_uses_final_model_after_escalation():
    """Divergence is measured against the FINAL (post-escalation) model — a retry
    that escalated to a different model counts as a divergence even if the first
    attempt's model equalled baseline."""
    run = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=_usage(model=EXPENSIVE_MODEL),
        baseline_model=CHEAP_MODEL,
        retries=[RetryEvent(attempt=2, model=EXPENSIVE_MODEL, gate_passed=True)],
    )
    # final_model == EXPENSIVE_MODEL (from the last retry) != baseline CHEAP_MODEL.
    report = routing_attribution([_scored(run, solved=True)])
    assert report.runs_diverged == 1
    assert report.had_chance_to_act is True


def test_routing_attribution_skips_records_without_baseline():
    """Old records lacking baseline_model (None) are excluded from attribution
    entirely — not counted, not crashed."""
    run = _run(
        task="t1",
        arm="full",
        model=EXPENSIVE_MODEL,
        usage=_usage(model=EXPENSIVE_MODEL),
        baseline_model=None,  # back-compat: field absent on old records
    )
    report = routing_attribution([_scored(run, solved=True)])
    assert report.runs_with_baseline == 0
    assert report.runs_diverged == 0
    assert report.had_chance_to_act is False

    # Renderer must say "not available" (no run carried a baseline), not crash.
    md = render_routing_retry_audit_markdown(routing=report, retry=None)
    assert "not available" in md.lower()


def test_routing_attribution_empty_set():
    report = routing_attribution([])
    assert report.runs_with_baseline == 0
    assert report.runs_diverged == 0
    assert report.had_chance_to_act is False
    assert report.spent_when_diverged_usd == pytest.approx(0.0)
    assert report.net_delta_usd is None


# ---------------------------------------------------------------------------
# Retry attribution
# ---------------------------------------------------------------------------


def test_retry_that_flipped_failure_to_success_counts_as_win():
    """A run that retried, ended solved, and whose first attempt's gate did not
    pass is a WIN (the retry flipped failure into success)."""
    run = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=_usage(model=CHEAP_MODEL),
        retries=[
            RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False),
            RetryEvent(attempt=2, model=EXPENSIVE_MODEL, gate_passed=True),
        ],
    )
    report = retry_attribution([_scored(run, solved=True)])
    assert report.runs_with_retries == 1
    assert report.wins == 1
    assert report.burns == 0
    assert report.cost_burned_usd == pytest.approx(0.0)


def test_retry_that_burned_cost_with_no_win_counts_as_burn():
    """A run that retried but ended unsolved is a BURN: its realised cost is the
    money spent across attempts that never produced a solve."""
    usage = _usage(model=EXPENSIVE_MODEL)
    run = _run(
        task="t1",
        arm="full",
        model=EXPENSIVE_MODEL,
        usage=usage,
        retries=[RetryEvent(attempt=1, model=EXPENSIVE_MODEL, gate_passed=False)],
    )
    report = retry_attribution([_scored(run, solved=False)])
    assert report.runs_with_retries == 1
    assert report.wins == 0
    assert report.burns == 1
    assert report.cost_burned_usd == pytest.approx(usage_cost(usage))


def test_retry_redundant_solve_is_neither_win_nor_burn():
    """A run that retried but would have solved on the first attempt (first
    attempt's gate already passed) is neither a win nor a burn."""
    run = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=_usage(model=CHEAP_MODEL),
        retries=[RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=True)],
    )
    report = retry_attribution([_scored(run, solved=True)])
    assert report.runs_with_retries == 1
    assert report.wins == 0
    assert report.burns == 0
    assert report.cost_burned_usd == pytest.approx(0.0)


def test_retry_attribution_ignores_runs_without_retries():
    run = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=_usage(model=CHEAP_MODEL),
        retries=[],
    )
    report = retry_attribution([_scored(run, solved=False)])
    assert report.runs_with_retries == 0
    assert report.wins == 0
    assert report.burns == 0
    assert report.cost_burned_usd == pytest.approx(0.0)


def test_retry_attribution_mixed_set_aggregates_wins_and_burns():
    win = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=_usage(model=CHEAP_MODEL),
        retries=[RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False)],
    )
    burn_usage = _usage(model=EXPENSIVE_MODEL)
    burn = _run(
        task="t2",
        arm="full",
        model=EXPENSIVE_MODEL,
        usage=burn_usage,
        retries=[RetryEvent(attempt=1, model=EXPENSIVE_MODEL, gate_passed=False)],
    )
    report = retry_attribution([_scored(win, solved=True), _scored(burn, solved=False)])
    assert report.runs_with_retries == 2
    assert report.wins == 1
    assert report.burns == 1
    assert report.cost_burned_usd == pytest.approx(usage_cost(burn_usage))


# ---------------------------------------------------------------------------
# Rendering / back-compat
# ---------------------------------------------------------------------------


def test_render_audit_surfaces_both_sections():
    routing = routing_attribution(
        [
            _scored(
                _run(
                    task="t1",
                    arm="full",
                    model=EXPENSIVE_MODEL,
                    usage=_usage(model=EXPENSIVE_MODEL),
                    baseline_model=CHEAP_MODEL,
                ),
                solved=True,
            )
        ]
    )
    retry = retry_attribution(
        [
            _scored(
                _run(
                    task="t1",
                    arm="full",
                    model=CHEAP_MODEL,
                    usage=_usage(model=CHEAP_MODEL),
                    retries=[
                        RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False)
                    ],
                ),
                solved=True,
            )
        ]
    )
    md = render_routing_retry_audit_markdown(routing=routing, retry=retry)
    assert "# Routing/retry value audit" in md
    assert "## Routing attribution (vs baseline model)" in md
    assert "## Retry attribution (wins vs burned cost)" in md
    assert "Runs where routing changed the model: 1" in md
    assert "wins): 1" in md


def test_render_audit_none_reports_render_not_available():
    md = render_routing_retry_audit_markdown(routing=None, retry=None)
    assert md.lower().count("not available") >= 2


def test_old_record_without_baseline_field_constructs_with_default():
    """Positional/legacy construction without baseline_model still works and the
    field defaults to None (back-compat with pre-Finding-4 records)."""
    rec = RunRecord(
        task="t1",
        arm="full",
        diff="",
        model=CHEAP_MODEL,
        usage=_usage(model=CHEAP_MODEL),
        wall_time_s=1.0,
        gate_passed=True,
    )
    assert rec.baseline_model is None
    # And such a record is simply skipped by routing attribution.
    report = routing_attribution([_scored(rec, solved=True)])
    assert report.runs_with_baseline == 0
