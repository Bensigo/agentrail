"""Tests for the eval reporter module (issue #934).

Fixture-driven and deterministic, mirroring the corpus-loader tests. Each test
fixes a set of repetition records and asserts on the reporter's observable
output: per-arm solve-rate, spread, token totals, dollars-per-solved-task, the
pricing-parity guarantee, the all-failure no-divide-by-zero guard, the markdown
content (failures/ties/spread), and the Postgres-writer invocation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agentrail.run.pricing import cost_usd
from agentrail.run.usage_capture import Usage

from agentrail.evals.pricing_adapter import usage_cost
from agentrail.evals.reporter import (
    ArmReport,
    RepetitionRecord,
    aggregate,
    render_markdown,
    write_reports,
)


# Use a model that is in the canonical price table so cost_usd is exact
# (no estimate path). claude-sonnet-4-5 is present per tests/context/test_pricing.
MODEL = "claude-sonnet-4-5"


def _usage(
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_tokens: int = 0,
    cache_creation_tokens: int = 0,
    model: str = MODEL,
) -> Usage:
    return Usage(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_tokens=cache_tokens,
        cache_creation_tokens=cache_creation_tokens,
    )


def _rep(
    task: str,
    arm: str,
    solved: bool,
    usage: Usage,
    *,
    gate_passed: bool = False,
    false_green: bool = False,
) -> RepetitionRecord:
    return RepetitionRecord(
        task=task,
        arm=arm,
        solved=solved,
        usage=usage,
        gate_passed=gate_passed,
        false_green=false_green,
    )


# ---------------------------------------------------------------------------
# AC2: pricing parity — the adapter delegates to the single-source module.
# ---------------------------------------------------------------------------

class PricingParityTests:
    pass


def test_pricing_adapter_parity_with_cost_usd():
    """The eval's dollar figure for a usage equals cost_usd for the same usage."""
    usage = _usage(
        input_tokens=12_345,
        output_tokens=6_789,
        cache_tokens=2_000,
        cache_creation_tokens=1_500,
    )
    assert usage_cost(usage) == cost_usd(usage)


def test_pricing_adapter_parity_zero_usage():
    usage = _usage()
    assert usage_cost(usage) == cost_usd(usage) == 0.0


def test_pricing_adapter_parity_across_models():
    for model in ("claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-6"):
        usage = _usage(input_tokens=100_000, output_tokens=50_000, model=model)
        assert usage_cost(usage) == cost_usd(usage), model


# ---------------------------------------------------------------------------
# AC1: correct per-arm solve-rate, spread, token totals, $-per-solved.
# ---------------------------------------------------------------------------

def test_aggregate_solve_rate_and_token_totals():
    # One arm "full", two tasks, two reps each.
    # task-a: solved, solved  -> task solve fraction 1.0
    # task-b: solved, failed  -> task solve fraction 0.5
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "full", True, u),
        _rep("task-a", "full", True, u),
        _rep("task-b", "full", True, u),
        _rep("task-b", "full", False, u),
    ]
    reports = aggregate(records)
    assert len(reports) == 1
    r = reports[0]
    assert r.arm == "full"
    assert r.repetitions == 4
    assert r.solved_count == 3
    assert r.failed_count == 1
    # solve-rate over all repetitions = 3/4
    assert r.solve_rate == pytest.approx(0.75)
    # token totals summed across every repetition
    assert r.total_input_tokens == 4 * 1000
    assert r.total_output_tokens == 4 * 500
    assert r.total_tokens == 4 * 1500


def test_aggregate_spread_is_stddev_of_per_task_solve_rates():
    # task-a fraction 1.0, task-b fraction 0.5 -> population stddev = 0.25
    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u),
        _rep("task-a", "full", True, u),
        _rep("task-b", "full", True, u),
        _rep("task-b", "full", False, u),
    ]
    r = aggregate(records)[0]
    assert r.spread == pytest.approx(0.25)


def test_aggregate_dollars_per_solved():
    # 4 reps each costing C; 3 solved. $/solved = total_cost / 3.
    u = _usage(input_tokens=1000, output_tokens=500)
    per_rep = cost_usd(u)
    records = [
        _rep("task-a", "full", True, u),
        _rep("task-a", "full", True, u),
        _rep("task-b", "full", True, u),
        _rep("task-b", "full", False, u),
    ]
    r = aggregate(records)[0]
    assert r.total_cost_usd == pytest.approx(4 * per_rep)
    assert r.dollars_per_solved == pytest.approx((4 * per_rep) / 3)


def test_aggregate_multiple_arms_sorted_and_ties_counted():
    u = _usage(input_tokens=1000)
    records = [
        # baseline: 1 of 2 solved on a single task -> tie within task
        _rep("task-a", "baseline", True, u),
        _rep("task-a", "baseline", False, u),
        # full: 2 of 2 solved
        _rep("task-a", "full", True, u),
        _rep("task-a", "full", True, u),
    ]
    reports = aggregate(records)
    arms = [r.arm for r in reports]
    # deterministic order (sorted by arm name)
    assert arms == sorted(arms)
    by_arm = {r.arm: r for r in reports}
    assert by_arm["baseline"].solve_rate == pytest.approx(0.5)
    assert by_arm["full"].solve_rate == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# AC3: all-failure arm -> zero solved, defined non-crashing $-per-solved.
# ---------------------------------------------------------------------------

def test_all_failure_arm_no_divide_by_zero():
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "broken", False, u),
        _rep("task-b", "broken", False, u),
    ]
    r = aggregate(records)[0]
    assert r.solved_count == 0
    assert r.solve_rate == pytest.approx(0.0)
    # must be defined and not raise; None is the agreed "undefined" sentinel
    assert r.dollars_per_solved is None
    # but the raw cost is still reported (cheap failures are visible)
    assert r.total_cost_usd == pytest.approx(2 * cost_usd(u))


def test_empty_records_returns_empty():
    assert aggregate([]) == []


# ---------------------------------------------------------------------------
# Objective Gate false-green probe (issue #940).
#   false_green_rate = (gate_passed AND NOT solved) / (gate_passed)
#   - sourced from the scorer's per-run false_green flag, carried on the record
#   - None (not 0.0) when NO run's gate passed (undefined denominator)
# ---------------------------------------------------------------------------


def test_false_green_rate_known_counts_per_arm():
    """AC1: (gate-passed AND hidden-failed) / (gate-passed), per arm."""
    u = _usage(input_tokens=1000)
    records = [
        # full: 4 gate-passed runs; 1 of them is a false-green -> 1/4 = 0.25
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-b", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-b", "full", False, u, gate_passed=True, false_green=True),
        # one run whose gate did NOT pass: excluded from BOTH numerator and
        # denominator (it cannot be a false-green by the scorer's definition).
        _rep("task-c", "full", False, u, gate_passed=False, false_green=False),
    ]
    r = aggregate(records)[0]
    assert r.arm == "full"
    assert r.gate_passed_count == 4
    assert r.false_green_count == 1
    assert r.false_green_rate == pytest.approx(0.25)


def test_false_green_rate_per_arm_distinct():
    """Per-arm: two arms with different false-green rates aggregate separately."""
    u = _usage(input_tokens=1000)
    records = [
        # baseline: 2 gate-passed, both false-green -> 1.0
        _rep("task-a", "baseline", False, u, gate_passed=True, false_green=True),
        _rep("task-a", "baseline", False, u, gate_passed=True, false_green=True),
        # full: 2 gate-passed, none false-green -> 0.0
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
    ]
    by_arm = {r.arm: r for r in aggregate(records)}
    assert by_arm["baseline"].false_green_rate == pytest.approx(1.0)
    assert by_arm["full"].false_green_rate == pytest.approx(0.0)


def test_false_green_rate_zero_is_distinct_from_none():
    """AC2: 0.0 (gate passed, never false-green) is NOT the same as None."""
    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-b", "full", True, u, gate_passed=True, false_green=False),
    ]
    r = aggregate(records)[0]
    assert r.gate_passed_count == 2
    assert r.false_green_count == 0
    # Defined and exactly 0.0 — the gate passed but never lied.
    assert r.false_green_rate == 0.0
    assert r.false_green_rate is not None


def test_false_green_rate_none_when_no_gate_passed():
    """AC2: no gate-passed runs -> rate is None (undefined denominator)."""
    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", False, u, gate_passed=False, false_green=False),
        _rep("task-b", "full", True, u, gate_passed=False, false_green=False),
    ]
    r = aggregate(records)[0]
    assert r.gate_passed_count == 0
    assert r.false_green_count == 0
    # Undefined denominator -> None, DISTINCT from a 0.0 rate.
    assert r.false_green_rate is None


def test_false_green_rate_sourced_from_scorer_verdict():
    """AC3: the rate derives from the scorer's false_green flag carried through.

    Build the RepetitionRecord the way the spine does — straight from a
    ``Verdict`` produced by ``scorer.score`` — and assert the scorer's
    ``false_green=True`` propagates into the reporter's count. This guards
    against the reporter forking the false-green definition.
    """
    from agentrail.evals.run_record import RunRecord
    from agentrail.evals.scorer import score

    u = _usage(input_tokens=1000)
    # A gate-passed run whose hidden tests FAILED -> scorer flags false_green.
    run = RunRecord(
        task="task-a",
        arm="full",
        diff="",
        model=MODEL,
        usage=u,
        wall_time_s=0.0,
        gate_passed=True,
    )
    verdict = score(run, hidden_tests_passed=False)
    assert verdict.false_green is True  # the scorer's single-source truth

    # Mirror spine.run_spine's record construction.
    rep = RepetitionRecord(
        task=verdict.task,
        arm=verdict.arm,
        solved=verdict.solved,
        usage=u,
        gate_passed=verdict.gate_passed,
        false_green=verdict.false_green,
    )
    r = aggregate([rep])[0]
    assert r.false_green_count == 1
    assert r.gate_passed_count == 1
    assert r.false_green_rate == pytest.approx(1.0)


def test_false_green_rate_surfaced_in_markdown():
    """The probe appears in the rendered report."""
    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-b", "full", False, u, gate_passed=True, false_green=True),
    ]
    md = render_markdown(aggregate(records), generated_at="2026-06-23").lower()
    assert "false-green" in md


def test_false_green_rate_in_arm_metric_rows():
    """The probe flows into the Postgres-ready rows (so the console can show it)."""
    from agentrail.evals.reporter import arm_metric_rows

    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-b", "full", False, u, gate_passed=True, false_green=True),
    ]
    rows = arm_metric_rows(aggregate(records), run_id="r1")
    row = rows[0]
    assert row["false_green_rate"] == pytest.approx(0.5)
    assert row["false_green_count"] == 1
    assert row["gate_passed_count"] == 2


def test_false_green_rate_none_flows_to_rows():
    """AC2 in rows: undefined-denominator case carries None, not 0.0."""
    from agentrail.evals.reporter import arm_metric_rows

    u = _usage(input_tokens=1000)
    records = [_rep("task-a", "full", False, u, gate_passed=False, false_green=False)]
    rows = arm_metric_rows(aggregate(records), run_id="r1")
    assert rows[0]["false_green_rate"] is None


# ---------------------------------------------------------------------------
# AC4: markdown report includes failures, ties, and spread (not only wins).
# ---------------------------------------------------------------------------

def test_render_markdown_includes_failures_ties_spread():
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "baseline", True, u),
        _rep("task-a", "baseline", False, u),
        _rep("task-b", "full", False, u),
        _rep("task-b", "full", False, u),
    ]
    reports = aggregate(records)
    md = render_markdown(reports, generated_at="2026-06-23")
    low = md.lower()
    # honesty rails: failures, ties, spread surfaced explicitly
    assert "fail" in low
    assert "spread" in low
    assert "tie" in low
    # domain language
    assert "solve-rate" in low
    assert "dollars-per-solved-task" in low
    # arms appear by name (raw-agent baseline + full)
    assert "baseline" in low
    assert "full" in low
    # the all-failure arm must render an explicit undefined marker, never a crash
    assert "n/a" in low or "undefined" in low


def test_render_markdown_all_failure_arm_does_not_crash():
    u = _usage(input_tokens=1000)
    records = [_rep("task-a", "broken", False, u)]
    md = render_markdown(aggregate(records), generated_at="2026-06-23")
    assert "broken" in md
    assert "2026-06-23" in md


# ---------------------------------------------------------------------------
# AC5: writer is invoked with the right per-arm rows (fake/in-memory writer).
# ---------------------------------------------------------------------------

class _FakeWriter:
    """In-memory MetricsWriter that records the rows it was handed."""

    def __init__(self) -> None:
        self.rows: list = []

    def write_arm_metrics(self, rows) -> bool:
        self.rows = list(rows)
        return True


def test_write_reports_invokes_writer_with_per_arm_rows():
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "baseline", True, u),
        _rep("task-a", "baseline", False, u),
        _rep("task-b", "full", True, u),
        _rep("task-b", "full", True, u),
    ]
    reports = aggregate(records)
    writer = _FakeWriter()
    ok = write_reports(reports, writer, run_id="run-xyz")
    assert ok is True
    assert len(writer.rows) == 2
    by_arm = {row["arm"]: row for row in writer.rows}
    # the rows carry the SAME per-arm numbers as the ArmReport
    base = by_arm["baseline"]
    assert base["run_id"] == "run-xyz"
    assert base["solve_rate"] == pytest.approx(0.5)
    assert base["solved_count"] == 1
    assert base["repetitions"] == 2
    assert base["total_tokens"] == 2 * 1500
    full = by_arm["full"]
    assert full["solve_rate"] == pytest.approx(1.0)
    assert full["dollars_per_solved"] is not None


def test_write_reports_all_failure_row_has_none_dollars_per_solved():
    u = _usage(input_tokens=1000)
    records = [_rep("task-a", "broken", False, u)]
    writer = _FakeWriter()
    write_reports(aggregate(records), writer, run_id="r1")
    assert writer.rows[0]["dollars_per_solved"] is None


# ---------------------------------------------------------------------------
# Integration: a sample dated report rendered to disk under reports/.
# ---------------------------------------------------------------------------

def test_write_markdown_report_creates_dated_file(tmp_path):
    from agentrail.evals.reporter import write_markdown_report

    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "baseline", True, u),
        _rep("task-b", "full", False, u),
    ]
    reports = aggregate(records)
    path = write_markdown_report(reports, reports_dir=tmp_path, date="2026-06-23")
    assert path.exists()
    assert "2026-06-23" in path.name
    text = path.read_text(encoding="utf-8")
    assert "solve-rate" in text.lower()
