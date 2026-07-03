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

from agentrail.run.pricing import cost_breakdown, cost_usd
from agentrail.run.usage_capture import Usage

from agentrail.evals.pricing_adapter import usage_cost, usage_cost_breakdown
from agentrail.evals.reporter import (
    ArmReport,
    LayerDelta,
    RepetitionRecord,
    aggregate,
    layer_delta_rows,
    layer_deltas,
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
    difficulty: str | None = None,
    wall_time_s: float = 0.0,
) -> RepetitionRecord:
    return RepetitionRecord(
        task=task,
        arm=arm,
        solved=solved,
        usage=usage,
        gate_passed=gate_passed,
        false_green=false_green,
        difficulty=difficulty,
        wall_time_s=wall_time_s,
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
# Cost breakdown — the per-arm Total cost split into its four priced
# components. The adapter delegates to the single-source pricer (parity), the
# aggregate sums per-record breakdowns (multi-model-safe), and the markdown
# renders a "## Cost breakdown" section with n/a shares for a zero-spend arm.
# ---------------------------------------------------------------------------

def test_usage_cost_breakdown_adapter_parity():
    """The adapter's total_usd equals usage_cost and cost_usd for the same usage."""
    usage = _usage(
        input_tokens=12_345,
        output_tokens=6_789,
        cache_tokens=2_000,
        cache_creation_tokens=1_500,
    )
    bd = usage_cost_breakdown(usage)
    assert bd == cost_breakdown(usage)
    # cost_usd sums-then-divides; the breakdown divides-then-sums, so parity is
    # exact to float tolerance (not bit-identical) — the displayed total is the
    # sum of the displayed components, which is what the report needs.
    assert bd["total_usd"] == pytest.approx(usage_cost(usage), rel=1e-12)
    assert usage_cost(usage) == cost_usd(usage)


def test_aggregate_cost_components_sum_to_total():
    """Per-arm component fields sum to total_cost_usd (parity carried through aggregate)."""
    u = _usage(
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
        cache_creation_tokens=100_000,
    )
    records = [
        _rep("task-a", "full", True, u),
        _rep("task-b", "full", False, u),
    ]
    r = aggregate(records)[0]
    component_sum = (
        r.input_cost_usd
        + r.output_cost_usd
        + r.cache_read_cost_usd
        + r.cache_write_cost_usd
    )
    assert component_sum == pytest.approx(r.total_cost_usd, rel=1e-12)
    # Each component is the sum of the matching per-record breakdown component.
    bd = cost_breakdown(u)
    assert r.input_cost_usd == pytest.approx(2 * bd["input_usd"], rel=1e-12)
    assert r.output_cost_usd == pytest.approx(2 * bd["output_usd"], rel=1e-12)
    assert r.cache_read_cost_usd == pytest.approx(2 * bd["cache_read_usd"], rel=1e-12)
    assert r.cache_write_cost_usd == pytest.approx(2 * bd["cache_write_usd"], rel=1e-12)


def test_aggregate_cost_components_multi_model_arm():
    """An arm whose records use different models sums per-record breakdowns, not arm totals × one rate."""
    u_sonnet = _usage(input_tokens=1_000_000, output_tokens=500_000, model="claude-sonnet-4-5")
    u_haiku = _usage(input_tokens=1_000_000, output_tokens=500_000, model="claude-haiku-4-5")
    records = [
        _rep("task-a", "full", True, u_sonnet),
        _rep("task-a", "full", True, u_haiku),
    ]
    r = aggregate(records)[0]
    expected_input = (
        cost_breakdown(u_sonnet)["input_usd"] + cost_breakdown(u_haiku)["input_usd"]
    )
    expected_output = (
        cost_breakdown(u_sonnet)["output_usd"] + cost_breakdown(u_haiku)["output_usd"]
    )
    assert r.input_cost_usd == pytest.approx(expected_input, rel=1e-12)
    assert r.output_cost_usd == pytest.approx(expected_output, rel=1e-12)
    # Sanity: the two models price differently, so this is a real multi-model sum.
    assert cost_breakdown(u_sonnet)["input_usd"] != cost_breakdown(u_haiku)["input_usd"]


def test_cost_breakdown_section_present_in_markdown():
    """render_markdown emits a '## Cost breakdown' section with the component columns."""
    u = _usage(input_tokens=1_000_000, output_tokens=500_000, cache_tokens=200_000)
    records = [_rep("task-a", "full", True, u)]
    md = render_markdown(aggregate(records), generated_at="2026-06-23")
    assert "## Cost breakdown" in md
    assert "Cache-read $" in md
    assert "Cache-write $" in md


def test_cost_breakdown_zero_spend_arm_shows_na_shares():
    """A zero-spend arm reads as n/a shares (not 0%) — never a divide-by-zero."""
    u = _usage()  # all-zero tokens → $0 spend
    records = [_rep("task-a", "free", True, u)]
    md = render_markdown(aggregate(records), generated_at="2026-06-23")
    assert "## Cost breakdown" in md
    # The zero-spend arm's share columns are "n/a", distinct from a measured 0%.
    free_lines = [ln for ln in md.splitlines() if ln.startswith("| free ")]
    assert free_lines, "expected a cost-breakdown row for the zero-spend arm"
    assert "n/a" in free_lines[-1]


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
# Issue #939: per-layer leave-one-out ablation deltas.
#   delta(layer) = full.solve_rate - (full-minus-layer).solve_rate
#   computed over the SAME run set / scorer; None when either arm is absent.
#   delta <= 0 => flagged "candidate to fix/remove"; > 0 => "earns its place".
# ---------------------------------------------------------------------------


def _arm_report_with_solve_rate(arm: str, solve_rate: float, *, reps: int = 10) -> ArmReport:
    """Build a minimal ArmReport fixture with an exact solve_rate.

    Uses the real aggregator so the fixture exercises the production path: it
    constructs ``reps`` repetitions of a single task, of which ``solve_rate *
    reps`` are solved.
    """
    u = _usage(input_tokens=1000, output_tokens=500)
    solved = round(solve_rate * reps)
    records = [_rep("task-a", arm, i < solved, u) for i in range(reps)]
    report = aggregate(records)[0]
    assert report.solve_rate == pytest.approx(solve_rate), report.solve_rate
    return report


def test_layer_deltas_computed_as_full_minus_ablation():
    """AC3: each layer's delta = full.solve_rate - full-minus-layer.solve_rate."""
    reports = [
        _arm_report_with_solve_rate("full", 0.8),
        _arm_report_with_solve_rate("full-minus-context", 0.3),     # +0.5
        _arm_report_with_solve_rate("full-minus-routing", 0.8),     #  0.0
        _arm_report_with_solve_rate("full-minus-verify_gate", 0.9), # -0.1
        _arm_report_with_solve_rate("full-minus-retry", 0.6),       # +0.2
        _arm_report_with_solve_rate("full-minus-guardrails", 0.7),  # +0.1
    ]
    deltas = {d.layer: d for d in layer_deltas(reports)}

    assert deltas["context"].delta == pytest.approx(0.5)
    assert deltas["routing"].delta == pytest.approx(0.0)
    assert deltas["verify_gate"].delta == pytest.approx(-0.1)
    assert deltas["retry"].delta == pytest.approx(0.2)
    assert deltas["guardrails"].delta == pytest.approx(0.1)

    # Carries the source solve rates for transparency.
    assert deltas["context"].full_solve_rate == pytest.approx(0.8)
    assert deltas["context"].ablation_solve_rate == pytest.approx(0.3)


def test_layer_deltas_returns_one_per_layer_in_order():
    """One LayerDelta per documented layer, deterministic order."""
    from agentrail.evals.arms import LAYER_NAMES

    reports = [
        _arm_report_with_solve_rate("full", 0.5),
        *[
            _arm_report_with_solve_rate(f"full-minus-{layer}", 0.5)
            for layer in LAYER_NAMES
        ],
    ]
    deltas = layer_deltas(reports)
    assert [d.layer for d in deltas] == list(LAYER_NAMES)


def test_layer_delta_flags_zero_or_negative_as_candidate():
    """AC4: delta <= 0 is flagged (not earning its place); > 0 earns its place."""
    reports = [
        _arm_report_with_solve_rate("full", 0.8),
        _arm_report_with_solve_rate("full-minus-context", 0.3),      # +0.5 positive
        _arm_report_with_solve_rate("full-minus-routing", 0.8),      #  0.0 flagged
        _arm_report_with_solve_rate("full-minus-verify_gate", 0.9),  # -0.1 flagged
    ]
    deltas = {d.layer: d for d in layer_deltas(reports)}

    assert deltas["context"].earns_place is True
    assert deltas["context"].flagged is False

    # zero delta -> flagged candidate to fix/remove
    assert deltas["routing"].earns_place is False
    assert deltas["routing"].flagged is True

    # negative delta -> flagged candidate to fix/remove
    assert deltas["verify_gate"].earns_place is False
    assert deltas["verify_gate"].flagged is True


def test_layer_delta_undefined_when_full_arm_missing():
    """A missing `full` arm yields delta=None for every layer (no crash)."""
    reports = [
        _arm_report_with_solve_rate("full-minus-context", 0.3),
        _arm_report_with_solve_rate("full-minus-routing", 0.4),
    ]
    deltas = {d.layer: d for d in layer_deltas(reports)}
    assert deltas["context"].delta is None
    assert deltas["routing"].delta is None
    # An undefined delta is neither flagged nor earning its place.
    assert deltas["context"].flagged is False
    assert deltas["context"].earns_place is False


def test_layer_delta_undefined_when_ablation_arm_missing():
    """A layer with no full-minus arm in the run set yields delta=None, no crash."""
    reports = [
        _arm_report_with_solve_rate("full", 0.8),
        _arm_report_with_solve_rate("full-minus-context", 0.3),  # only context present
    ]
    deltas = {d.layer: d for d in layer_deltas(reports)}
    assert deltas["context"].delta == pytest.approx(0.5)
    # routing/retry/etc. have no ablation arm -> undefined, not a crash
    assert deltas["routing"].delta is None
    assert deltas["retry"].delta is None
    assert deltas["routing"].full_solve_rate == pytest.approx(0.8)
    assert deltas["routing"].ablation_solve_rate is None


def test_layer_deltas_rendered_in_markdown_with_flags():
    """AC3+AC4 surfaced in markdown: a delta table flagging the <=0 layer."""
    # Build via real records so render goes through aggregate -> render.
    u = _usage(input_tokens=1000, output_tokens=500)
    records = []
    # full: 8/10 solved
    for i in range(10):
        records.append(_rep("t", "full", i < 8, u))
    # full-minus-context: 3/10 -> +0.5 (earns its place)
    for i in range(10):
        records.append(_rep("t", "full-minus-context", i < 3, u))
    # full-minus-routing: 9/10 -> -0.1 (flagged)
    for i in range(10):
        records.append(_rep("t", "full-minus-routing", i < 9, u))
    reports = aggregate(records)
    md = render_markdown(reports, generated_at="2026-06-23")
    low = md.lower()
    # a per-layer delta section exists
    assert "delta" in low
    assert "per-layer" in low or "ablation" in low
    # both layers are named
    assert "context" in low
    assert "routing" in low
    # the negative-delta layer (routing) is flagged as a fix/remove candidate
    assert "fix" in low or "remove" in low or "candidate" in low
    # the positive-delta layer earns its place
    assert "earns" in low


def test_layer_delta_rows_for_persistence():
    """The deltas flatten into Postgres-ready rows (so the console can show them)."""
    reports = [
        _arm_report_with_solve_rate("full", 0.8),
        _arm_report_with_solve_rate("full-minus-context", 0.3),
        _arm_report_with_solve_rate("full-minus-routing", 0.8),  # zero -> flagged
    ]
    rows = layer_delta_rows(layer_deltas(reports), run_id="r1")
    by_layer = {row["layer"]: row for row in rows}
    assert by_layer["context"]["run_id"] == "r1"
    assert by_layer["context"]["delta"] == pytest.approx(0.5)
    assert by_layer["context"]["flagged"] is False
    assert by_layer["routing"]["delta"] == pytest.approx(0.0)
    assert by_layer["routing"]["flagged"] is True
    # missing ablation arm -> None delta carried, not 0.0 and not a crash
    assert by_layer["retry"]["delta"] is None


# ---------------------------------------------------------------------------
# Issue #980 AC3 — wall-time PER TASK in the report. ``RunRecord.wall_time_s``
# is threaded onto the RepetitionRecord; the arm report surfaces the mean
# wall-time per task. A falsifiable metric: a slower arm reads worse (it can
# come back larger), never one-sided.
# ---------------------------------------------------------------------------


def test_arm_report_mean_wall_time_per_task():
    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u, wall_time_s=10.0),
        _rep("task-a", "full", True, u, wall_time_s=20.0),
        _rep("task-b", "full", False, u, wall_time_s=30.0),
    ]
    r = aggregate(records)[0]
    # mean wall-time per (task, arm) repetition = (10 + 20 + 30) / 3 = 20.0
    assert r.mean_wall_time_s == pytest.approx(20.0)
    assert r.total_wall_time_s == pytest.approx(60.0)


def test_arm_report_mean_wall_time_zero_when_no_reps_recorded():
    """No reps -> 0.0 mean wall-time, never a divide-by-zero crash."""
    assert aggregate([]) == []
    # A single all-zero record still aggregates to 0.0.
    u = _usage(input_tokens=1)
    r = aggregate([_rep("t", "full", False, u, wall_time_s=0.0)])[0]
    assert r.mean_wall_time_s == pytest.approx(0.0)


def test_wall_time_surfaced_in_markdown():
    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u, wall_time_s=12.5),
        _rep("task-a", "full", True, u, wall_time_s=12.5),
    ]
    md = render_markdown(aggregate(records), generated_at="2026-06-23").lower()
    assert "wall-time" in md or "wall time" in md


def test_wall_time_in_arm_metric_rows():
    from agentrail.evals.reporter import arm_metric_rows

    u = _usage(input_tokens=1000)
    records = [
        _rep("task-a", "full", True, u, wall_time_s=10.0),
        _rep("task-a", "full", True, u, wall_time_s=30.0),
    ]
    rows = arm_metric_rows(aggregate(records), run_id="r1")
    assert rows[0]["mean_wall_time_s"] == pytest.approx(20.0)


# ---------------------------------------------------------------------------
# Issue #980 AC3/AC4 — the new-flow arm vs ``full`` head-to-head delta on all
# four metrics (dollars-per-solved, wall-time per task, solve-rate, false-green
# rate), each falsifiable (able to come back WORSE), PLUS the per-layer
# ablation deltas for the three new layers (critic/best-of-N/warm-cache).
# ---------------------------------------------------------------------------


def test_new_flow_vs_full_delta_on_all_four_metrics():
    from agentrail.evals.reporter import new_flow_delta

    u = _usage(input_tokens=1000, output_tokens=500)
    per_rep = cost_usd(u)
    records = [
        # full: 1/2 solved, both gate-passed, one false-green, wall-time 10/10
        _rep("t", "full", True, u, gate_passed=True, false_green=False, wall_time_s=10.0),
        _rep("t", "full", False, u, gate_passed=True, false_green=True, wall_time_s=10.0),
        # new-flow: 2/2 solved, both gate-passed, no false-green, wall-time 20/20
        _rep("t", "new-flow", True, u, gate_passed=True, false_green=False, wall_time_s=20.0),
        _rep("t", "new-flow", True, u, gate_passed=True, false_green=False, wall_time_s=20.0),
    ]
    reports = aggregate(records)
    delta = new_flow_delta(reports)
    assert delta is not None
    # solve-rate: new-flow 1.0 vs full 0.5 -> +0.5 (better)
    assert delta.solve_rate_delta == pytest.approx(0.5)
    # false-green rate: new-flow 0.0 vs full 0.5 -> -0.5 (better; lower is good)
    assert delta.false_green_rate_delta == pytest.approx(-0.5)
    # wall-time per task: new-flow 20.0 vs full 10.0 -> +10.0 (WORSE: slower).
    # This proves the metric is NOT one-sided — it came back worse here.
    assert delta.wall_time_delta == pytest.approx(10.0)
    # dollars-per-solved: full = 2*per_rep / 1 solved; new-flow = 2*per_rep / 2
    assert delta.full_dollars_per_solved == pytest.approx(2 * per_rep)
    assert delta.new_flow_dollars_per_solved == pytest.approx(per_rep)
    # delta = new-flow - full = per_rep - 2*per_rep = -per_rep (cheaper -> better)
    assert delta.dollars_per_solved_delta == pytest.approx(-per_rep)


def test_new_flow_delta_none_when_either_arm_absent():
    from agentrail.evals.reporter import new_flow_delta

    u = _usage(input_tokens=1000)
    # only full present, no new-flow
    reports = aggregate([_rep("t", "full", True, u)])
    assert new_flow_delta(reports) is None


def test_new_flow_delta_dollars_undefined_when_arm_never_solved():
    """No-divide-by-zero: an all-failure new-flow arm yields None $/solved delta."""
    from agentrail.evals.reporter import new_flow_delta

    u = _usage(input_tokens=1000)
    records = [
        _rep("t", "full", True, u),
        _rep("t", "new-flow", False, u),  # never solved
    ]
    delta = new_flow_delta(aggregate(records))
    assert delta is not None
    assert delta.new_flow_dollars_per_solved is None
    # the $/solved delta is undefined (None), never a crash
    assert delta.dollars_per_solved_delta is None


def test_new_flow_vs_full_delta_rendered_in_markdown():
    from agentrail.evals.reporter import render_markdown as _render

    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("t", "full", True, u, gate_passed=True, wall_time_s=10.0),
        _rep("t", "full", False, u, gate_passed=True, false_green=True, wall_time_s=10.0),
        _rep("t", "new-flow", True, u, gate_passed=True, wall_time_s=20.0),
        _rep("t", "new-flow", True, u, gate_passed=True, wall_time_s=20.0),
    ]
    md = _render(aggregate(records), generated_at="2026-06-23").lower()
    assert "new-flow" in md
    # all four metric names present in the head-to-head section
    assert "solve-rate" in md
    assert "false-green" in md
    assert "wall-time" in md or "wall time" in md
    assert "dollars-per-solved" in md


def test_new_flow_layer_deltas_for_the_three_new_layers():
    """AC1: each new layer (critic/best-of-N/warm-cache) has a leave-one-out
    delta = new-flow.solve_rate - new-flow-minus-<layer>.solve_rate."""
    from agentrail.evals.arms import NEW_FLOW_LAYERS
    from agentrail.evals.reporter import new_flow_layer_deltas

    reports = [
        _arm_report_with_solve_rate("new-flow", 0.9),
        _arm_report_with_solve_rate("new-flow-minus-critic", 0.4),     # +0.5
        _arm_report_with_solve_rate("new-flow-minus-bestofn", 0.9),    #  0.0 flagged
        _arm_report_with_solve_rate("new-flow-minus-warmcache", 1.0),  # -0.1 flagged
    ]
    deltas = {d.layer: d for d in new_flow_layer_deltas(reports)}
    assert [d for d in deltas] == list(NEW_FLOW_LAYERS) or set(deltas) == set(NEW_FLOW_LAYERS)
    assert deltas["critic"].delta == pytest.approx(0.5)
    assert deltas["critic"].earns_place is True
    assert deltas["bestofn"].delta == pytest.approx(0.0)
    assert deltas["bestofn"].flagged is True
    assert deltas["warmcache"].delta == pytest.approx(-0.1)
    assert deltas["warmcache"].flagged is True


def test_new_flow_layer_delta_undefined_when_arm_absent():
    from agentrail.evals.reporter import new_flow_layer_deltas

    reports = [_arm_report_with_solve_rate("new-flow-minus-critic", 0.4)]  # no new-flow
    deltas = {d.layer: d for d in new_flow_layer_deltas(reports)}
    assert deltas["critic"].delta is None
    assert deltas["critic"].flagged is False


def test_new_flow_layer_deltas_rendered_in_markdown():
    u = _usage(input_tokens=1000, output_tokens=500)
    records = []
    for i in range(10):
        records.append(_rep("t", "new-flow", i < 9, u))
    for i in range(10):
        records.append(_rep("t", "new-flow-minus-critic", i < 4, u))  # +0.5 earns
    for i in range(10):
        records.append(_rep("t", "new-flow-minus-bestofn", i < 10, u))  # -0.1 flagged
    md = render_markdown(aggregate(records), generated_at="2026-06-23").lower()
    assert "critic" in md
    assert "bestofn" in md or "best-of-n" in md


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
# #942: HttpMetricsWriter POSTs the rows to the live eval-arm-metrics ingest
# route (the write path moved from #934's deferred no-op). Failure is non-fatal.
# A faithful fake transport asserts the exact request without any network.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _rows():
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "full", True, u, gate_passed=True, false_green=False),
        _rep("task-b", "full", False, u, gate_passed=False, false_green=False),
    ]
    from agentrail.evals.reporter import arm_metric_rows

    return arm_metric_rows(aggregate(records), run_id="eval-2026-06-23")


def test_http_writer_posts_rows_to_ingest_route(monkeypatch, tmp_path):
    """A linked writer POSTs the rows to the ingest route and reports True on 202."""
    import json as _json

    from agentrail.evals.reporter import HttpMetricsWriter

    # Linked via env (the afk/CLI path): load_link reads AGENTRAIL_SERVER_*.
    monkeypatch.setenv("AGENTRAIL_SERVER_BASE_URL", "https://console.example.com")
    monkeypatch.setenv("AGENTRAIL_SERVER_API_KEY", "ar_test_key")
    monkeypatch.setenv("AGENTRAIL_SERVER_REPOSITORY_ID", "repo-123")

    captured: dict = {}

    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["auth"] = req.get_header("Authorization")
        captured["content_type"] = req.get_header("Content-type")
        captured["body"] = _json.loads(req.data.decode("utf-8"))
        return _FakeResponse(202)

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    rows = _rows()
    writer = HttpMetricsWriter(target=tmp_path)
    ok = writer.write_arm_metrics(rows)

    assert ok is True
    assert captured["url"] == (
        "https://console.example.com/api/v1/ingest/eval-arm-metrics"
    )
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer ar_test_key"
    assert captured["content_type"] == "application/json"
    # The exact reporter rows are posted, including the None false_green_rate.
    assert captured["body"] == list(rows)
    assert captured["body"][0]["false_green_rate"] == 0.0  # gate passed, no lie
    assert captured["body"][0]["run_id"] == "eval-2026-06-23"


def test_http_writer_not_linked_returns_false_no_request(monkeypatch, tmp_path):
    """No link (no server.json / env) -> False and never a network call."""
    from agentrail.evals.reporter import HttpMetricsWriter

    for var in (
        "AGENTRAIL_SERVER_BASE_URL",
        "AGENTRAIL_SERVER_API_KEY",
        "AGENTRAIL_SERVER_REPOSITORY_ID",
    ):
        monkeypatch.delenv(var, raising=False)

    called = {"n": 0}

    def _boom(*a, **k):  # pragma: no cover - must not be reached
        called["n"] += 1
        raise AssertionError("must not POST when unlinked")

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    writer = HttpMetricsWriter(target=tmp_path)
    assert writer.write_arm_metrics(_rows()) is False
    assert called["n"] == 0


def test_http_writer_empty_rows_returns_false(tmp_path):
    """No rows -> False (nothing to persist), never a spurious success."""
    from agentrail.evals.reporter import HttpMetricsWriter

    assert HttpMetricsWriter(target=tmp_path).write_arm_metrics([]) is False


def test_http_writer_swallows_network_error(monkeypatch, tmp_path):
    """A transport exception is non-fatal: returns False, never raises."""
    from agentrail.evals.reporter import HttpMetricsWriter

    monkeypatch.setenv("AGENTRAIL_SERVER_BASE_URL", "https://console.example.com")
    monkeypatch.setenv("AGENTRAIL_SERVER_API_KEY", "ar_test_key")
    monkeypatch.setenv("AGENTRAIL_SERVER_REPOSITORY_ID", "repo-123")

    def _raise(*a, **k):
        raise OSError("connection refused")

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", _raise)

    writer = HttpMetricsWriter(target=tmp_path)
    assert writer.write_arm_metrics(_rows()) is False


# ---------------------------------------------------------------------------
# Integration: a sample dated report rendered to disk under reports/.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Issue #941: difficulty-stratified reporting.
#   Per arm, break solve-rate / cost / $-per-solved out PER difficulty stratum
#   (easy / medium / hard), IN ADDITION TO the aggregate. A single aggregate
#   hides the real story (the edge is large on hard tasks, small on easy ones).
# ---------------------------------------------------------------------------


def test_aggregate_carries_per_difficulty_strata():
    """AC2: exact per-stratum solve-rate from a mixed-difficulty fixture."""
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        # easy: 1 task, 2 reps, both solved -> 1.0
        _rep("easy-a", "full", True, u, difficulty="easy"),
        _rep("easy-a", "full", True, u, difficulty="easy"),
        # hard: 2 tasks, 1 rep each, 1 solved 1 failed -> 0.5
        _rep("hard-a", "full", True, u, difficulty="hard"),
        _rep("hard-b", "full", False, u, difficulty="hard"),
    ]
    r = aggregate(records)[0]
    # aggregate is unchanged: 3/4 solved overall
    assert r.solve_rate == pytest.approx(0.75)

    strata = {s.difficulty: s for s in r.strata}
    assert set(strata) == {"easy", "hard"}

    easy = strata["easy"]
    assert easy.repetitions == 2
    assert easy.solved_count == 2
    assert easy.solve_rate == pytest.approx(1.0)
    assert easy.total_cost_usd == pytest.approx(2 * cost_usd(u))
    assert easy.dollars_per_solved == pytest.approx((2 * cost_usd(u)) / 2)

    hard = strata["hard"]
    assert hard.repetitions == 2
    assert hard.solved_count == 1
    assert hard.solve_rate == pytest.approx(0.5)
    assert hard.dollars_per_solved == pytest.approx((2 * cost_usd(u)) / 1)


def test_strata_dollars_per_solved_undefined_when_none_solved():
    """A stratum where nothing solved reports None $/solved, never a crash."""
    u = _usage(input_tokens=1000)
    records = [
        _rep("hard-a", "full", False, u, difficulty="hard"),
        _rep("hard-b", "full", False, u, difficulty="hard"),
        _rep("easy-a", "full", True, u, difficulty="easy"),
    ]
    strata = {s.difficulty: s for s in aggregate(records)[0].strata}
    assert strata["hard"].solved_count == 0
    assert strata["hard"].dollars_per_solved is None
    assert strata["easy"].dollars_per_solved is not None


def test_strata_sorted_easy_medium_hard():
    """Strata are reported in canonical difficulty order (deterministic)."""
    u = _usage(input_tokens=1000)
    records = [
        _rep("h", "full", True, u, difficulty="hard"),
        _rep("e", "full", True, u, difficulty="easy"),
        _rep("m", "full", True, u, difficulty="medium"),
    ]
    order = [s.difficulty for s in aggregate(records)[0].strata]
    assert order == ["easy", "medium", "hard"]


def test_records_without_difficulty_produce_no_strata():
    """Back-compat: records with no difficulty (pre-#941) yield an empty strata
    list and an unchanged aggregate."""
    u = _usage(input_tokens=1000)
    records = [_rep("task-a", "full", True, u), _rep("task-a", "full", False, u)]
    r = aggregate(records)[0]
    assert r.strata == []
    assert r.solve_rate == pytest.approx(0.5)


def test_strata_surfaced_in_markdown_with_exact_numbers():
    """AC2: the per-stratum breakdown appears in the rendered report."""
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("easy-a", "full", True, u, difficulty="easy"),
        _rep("easy-a", "full", True, u, difficulty="easy"),
        _rep("hard-a", "full", True, u, difficulty="hard"),
        _rep("hard-b", "full", False, u, difficulty="hard"),
    ]
    md = render_markdown(aggregate(records), generated_at="2026-06-23")
    low = md.lower()
    # a difficulty-stratified section exists, naming the strata
    assert "difficulty" in low
    assert "easy" in low
    assert "hard" in low
    # exact per-stratum solve-rates surface (easy 100.0%, hard 50.0%)
    assert "100.0%" in md
    assert "50.0%" in md


def test_strata_in_arm_metric_rows():
    """The per-stratum numbers flow into the persistence rows (console parity)."""
    from agentrail.evals.reporter import arm_metric_rows

    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("easy-a", "full", True, u, difficulty="easy"),
        _rep("hard-a", "full", False, u, difficulty="hard"),
    ]
    rows = arm_metric_rows(aggregate(records), run_id="r1")
    by_diff = {s["difficulty"]: s for s in rows[0]["strata"]}
    assert by_diff["easy"]["solve_rate"] == pytest.approx(1.0)
    assert by_diff["hard"]["solve_rate"] == pytest.approx(0.0)
    assert by_diff["hard"]["dollars_per_solved"] is None


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


def test_write_markdown_report_forwards_pack_scores_to_rerank_section(tmp_path):
    """#1029 AC3: pack_scores threaded through write_markdown_report surface the
    rerank-arm precision/recall deltas in the written file (not dropped)."""
    from agentrail.evals.pack_scorer import ArmPackScore
    from agentrail.evals.reporter import write_markdown_report

    u = _usage(input_tokens=1000, output_tokens=500)
    # Both rerank arms present so the head-to-head section has a delta to render.
    records = [
        _rep("task-a", "full", True, u),
        _rep("task-a", "full-minus-rerank", False, u),
    ]
    reports = aggregate(records)
    pack_scores = [
        ArmPackScore(
            arm="full",
            pack_count=3,
            mean_precision=0.80,
            mean_recall=0.90,
            defined_precision_count=3,
            defined_recall_count=3,
        ),
        ArmPackScore(
            arm="full-minus-rerank",
            pack_count=3,
            mean_precision=0.50,
            mean_recall=0.60,
            defined_precision_count=3,
            defined_recall_count=3,
        ),
    ]

    path = write_markdown_report(
        reports, reports_dir=tmp_path, date="2026-06-23", pack_scores=pack_scores
    )
    text = path.read_text(encoding="utf-8")

    # The rerank section is present with the precision/recall deltas from the
    # AC2 pack scorer (both dropped 30 points when rerank was removed) — proving
    # pack_scores are forwarded rather than silently ignored.
    assert "## Rerank arm" in text
    assert text.count("-30.0%") >= 2


def test_write_markdown_report_omitting_pack_scores_renders_na(tmp_path):
    """Without pack_scores the rerank precision/recall rows render n/a, never a
    fabricated number — the back-compatible default path."""
    from agentrail.evals.reporter import write_markdown_report

    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("task-a", "full", True, u),
        _rep("task-a", "full-minus-rerank", False, u),
    ]
    reports = aggregate(records)

    path = write_markdown_report(reports, reports_dir=tmp_path, date="2026-06-23")
    text = path.read_text(encoding="utf-8")

    assert "## Rerank arm" in text
    # solve-rate delta still renders (from the ArmReports); precision/recall are
    # undefined without ground truth, so they read n/a.
    assert "n/a" in text


# ---------------------------------------------------------------------------
# Network-artifact hygiene (issue #1033): <synthetic> ECONNRESET rows are
# marked at capture and EXCLUDED from every aggregate (solve-rate, $/solved,
# per-component cost, strata), with a per-stratum artifact count surfaced and
# an all-artifact stratum rendered as "no data" rather than a real 0%.
# ---------------------------------------------------------------------------

from agentrail.evals.runner import SYNTHETIC_MODEL  # noqa: E402


def _synthetic_rep(
    task: str,
    arm: str,
    *,
    difficulty: str | None = None,
) -> RepetitionRecord:
    """A network-artifact rep: the ECONNRESET synthetic fallback.

    Mirrors what the spine builds for a run whose ``RunRecord.model`` was
    ``<synthetic>`` — solved=0, $0 usage (no real tokens), no gate pass —
    and marked ``network_artifact=True`` so the reporter excludes it.
    """
    return RepetitionRecord(
        task=task,
        arm=arm,
        solved=False,
        usage=_usage(model=SYNTHETIC_MODEL),  # $0 — no diff, no real tokens
        gate_passed=False,
        false_green=False,
        difficulty=difficulty,
        wall_time_s=0.0,
        network_artifact=True,
    )


def test_ac1_synthetic_excluded_from_solve_rate_and_dollars_per_solved():
    """AC1: mixed real/synthetic rows aggregate to the real-rows-only value.

    Two real reps (one solved, one not) plus two synthetic ECONNRESET reps.
    The arm's solve-rate and dollars-per-solved must equal what the REAL rows
    alone produce — the synthetic $0/solved=0 rows contribute nothing.
    """
    u = _usage(input_tokens=1000, output_tokens=500)
    real = [
        _rep("task-a", "full", True, u, difficulty="easy"),
        _rep("task-b", "full", False, u, difficulty="easy"),
    ]
    mixed = real + [
        _synthetic_rep("task-c", "full", difficulty="easy"),
        _synthetic_rep("task-d", "full", difficulty="easy"),
    ]

    real_only = aggregate(real)[0]
    mixed_report = aggregate(mixed)[0]

    # Aggregate over mixed == aggregate over real rows only.
    assert mixed_report.solve_rate == real_only.solve_rate == pytest.approx(0.5)
    assert mixed_report.repetitions == real_only.repetitions == 2
    assert mixed_report.solved_count == real_only.solved_count == 1
    assert mixed_report.total_cost_usd == pytest.approx(real_only.total_cost_usd)
    assert mixed_report.dollars_per_solved == pytest.approx(
        real_only.dollars_per_solved
    )
    # Per-component cost excludes the synthetic rows too.
    assert mixed_report.input_cost_usd == pytest.approx(real_only.input_cost_usd)
    assert mixed_report.output_cost_usd == pytest.approx(real_only.output_cost_usd)
    # The excluded artifacts are counted, not silently dropped.
    assert mixed_report.network_artifact_count == 2
    assert real_only.network_artifact_count == 0


def test_ac2_per_stratum_network_artifact_count_surfaced():
    """AC2: the per-stratum artifact count appears in the report + rows."""
    from agentrail.evals.reporter import arm_metric_rows

    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        _rep("easy-a", "full", True, u, difficulty="easy"),
        _rep("easy-b", "full", False, u, difficulty="easy"),
        _synthetic_rep("easy-c", "full", difficulty="easy"),
        _rep("hard-a", "full", True, u, difficulty="hard"),
    ]
    reports = aggregate(records)
    strata = {s.difficulty: s for s in reports[0].strata}
    # The easy stratum still has 2 real reps + 1 counted artifact.
    assert strata["easy"].repetitions == 2
    assert strata["easy"].network_artifact_count == 1
    assert strata["hard"].network_artifact_count == 0

    # Console parity: the count flows into the persistence rows.
    rows = arm_metric_rows(reports, run_id="r1")
    by_diff = {s["difficulty"]: s for s in rows[0]["strata"]}
    assert by_diff["easy"]["network_artifact_count"] == 1
    assert rows[0]["network_artifact_count"] == 1

    # The markdown surfaces the artifact count (a "Network artifacts" column).
    md = render_markdown(reports, generated_at="2026-06-23")
    assert "network artifact" in md.lower()


def test_ac3_all_synthetic_stratum_renders_no_data_not_zero():
    """AC3: a 100%-artifact stratum reads as n/a, never 0% / $0."""
    u = _usage(input_tokens=1000, output_tokens=500)
    records = [
        # Real reps in another stratum so the arm/report is non-empty.
        _rep("easy-a", "full", True, u, difficulty="easy"),
        # The hard stratum is ALL synthetic artifacts.
        _synthetic_rep("hard-a", "full", difficulty="hard"),
        _synthetic_rep("hard-b", "full", difficulty="hard"),
        _synthetic_rep("hard-c", "full", difficulty="hard"),
    ]
    reports = aggregate(records)
    strata = {s.difficulty: s for s in reports[0].strata}

    hard = strata["hard"]
    # No real rep -> solve-rate is UNDEFINED (None), NOT a fabricated 0.0.
    assert hard.repetitions == 0
    assert hard.solve_rate is None
    assert hard.solved_count == 0
    assert hard.total_cost_usd == pytest.approx(0.0)
    assert hard.dollars_per_solved is None
    assert hard.network_artifact_count == 3

    # Rendered: the all-artifact row says "n/a" for solve-rate, and the report
    # discloses the artifacts — it must NOT read as a real 0% solve rate.
    md = render_markdown(reports, generated_at="2026-06-23")
    assert "n/a" in md.lower()
    # The synthetic $0/solved=0 rows never drag the arm solve-rate to a real 0%.
    assert reports[0].solve_rate == pytest.approx(1.0)
    assert reports[0].network_artifact_count == 3


def test_ac4_report_byte_identical_when_no_synthetic_rows():
    """AC4: a corpus with NO synthetic rows renders byte-for-byte unchanged.

    We render the SAME record set twice: once as plain real reps, once with the
    (defaulted-False) network_artifact field constructed explicitly. Both must
    produce byte-identical markdown AND identical persistence rows — proving the
    hygiene path is inert when there is nothing to exclude, so pre-#1033 reports
    do not regress.
    """
    from agentrail.evals.reporter import arm_metric_rows

    u = _usage(input_tokens=1000, output_tokens=500)
    # A report exercising strata, solved/failed mix, ties, and cost.
    base = [
        _rep("easy-a", "full", True, u, difficulty="easy"),
        _rep("easy-a", "full", False, u, difficulty="easy"),
        _rep("hard-a", "full", True, u, difficulty="hard"),
        _rep("hard-b", "full", False, u, difficulty="hard"),
        _rep("mid-a", "baseline", True, u, difficulty="medium"),
    ]
    # Same records, but each explicitly carries network_artifact=False.
    explicit_false = [
        RepetitionRecord(
            task=r.task,
            arm=r.arm,
            solved=r.solved,
            usage=r.usage,
            gate_passed=r.gate_passed,
            false_green=r.false_green,
            difficulty=r.difficulty,
            wall_time_s=r.wall_time_s,
            network_artifact=False,
        )
        for r in base
    ]

    md_base = render_markdown(aggregate(base), generated_at="2026-06-23")
    md_explicit = render_markdown(
        aggregate(explicit_false), generated_at="2026-06-23"
    )
    assert md_base == md_explicit

    # No artifact means no extra column and no disclosure line in the markdown.
    assert "network artifact" not in md_base.lower()

    # Persistence rows are identical too (console parity holds with no artifacts).
    rows_base = arm_metric_rows(aggregate(base), run_id="r1")
    rows_explicit = arm_metric_rows(aggregate(explicit_false), run_id="r1")
    assert rows_base == rows_explicit
    # The count field is present and zero (honest, not absent).
    assert all(row["network_artifact_count"] == 0 for row in rows_base)
