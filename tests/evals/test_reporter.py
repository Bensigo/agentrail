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
) -> RepetitionRecord:
    return RepetitionRecord(
        task=task,
        arm=arm,
        solved=solved,
        usage=usage,
        gate_passed=gate_passed,
        false_green=false_green,
        difficulty=difficulty,
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
