"""Tests for the memory-lane token-delta report (#1039/#1071 measurement half).

Everything here is fixture-driven: a synthetic ``cost-events.jsonl`` with KNOWN
per-phase tokens for the memory-lane-OFF and memory-lane-ON arms. No real agent
run, no sandbox, no network. The tests assert the reducer computes per-arm TOTAL
tokens (and execute-phase context) correctly for both arms, that
``memory_lane_token_delta`` yields the right ON-minus-OFF delta AND the right
``tokens_saved_by_lane`` — with the fixture tuned so the ON arm spends FEWER
tokens, i.e. ``tokens_saved_by_lane`` is positive, the direction the onboarding
before/after story predicts — and (the part #1216 never wired up) that
``render_memory_report_from_ledger`` actually renders the section: populated
with real numbers when both arms are present, and an honest ``n/a`` — never a
fabricated 0 — when the ledger is missing or carries only one arm.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

import pytest

from agentrail.evals.memory_report import (
    MEMORY_LANE_OFF_ARM,
    MEMORY_LANE_ON_ARM,
    CostEvent,
    MemoryArmTokenReport,
    MemoryLaneTokenDelta,
    aggregate_memory_tokens,
    load_cost_events,
    memory_lane_token_delta,
    render_memory_lane_token_markdown,
    render_memory_report_from_ledger,
)


# ---------------------------------------------------------------------------
# The synthetic fixture. Numbers are chosen so the before/after story is
# faithful AND every derived metric is hand-checkable:
#
#   memory-lane OFF: two baseline runs, no memory lane in the pack.
#   memory-lane ON:  two runs with the workspace memory lane injected — the
#                    onboarded context means less re-discovery, so BOTH the total
#                    and the execute-phase context come back LOWER than OFF.
#
# Each event is a ``build_cost_record`` dict shape: run_id / phase / *_tokens
# (+ an ``arm`` tag a per-arm eval ledger would write).
# ---------------------------------------------------------------------------


def _evt(
    run_id: str,
    phase: str,
    *,
    inp: int = 0,
    out: int = 0,
    cache: int = 0,
    cache_creation: int = 0,
    arm: str,
) -> dict:
    """One cost-ledger line (the ``build_cost_record`` subset the report reads)."""
    return {
        "run_id": run_id,
        "phase": phase,
        "input_tokens": inp,
        "output_tokens": out,
        "cache_tokens": cache,
        "cache_creation_tokens": cache_creation,
        "arm": arm,
    }


# memory-lane OFF ("full-minus-memory_lane"):
#   run off-1:
#     execute:     8000+1000+500+0 = 9500   (context = input 8000 + cache 500 = 8500)
#     verify:      1000+200+0+0    = 1200
#   run off-2:
#     execute:     6000+800+200+0  = 7000   (context = input 6000 + cache 200 = 6200)
#     test-author: 500+100+0+300   = 900
#   TOTAL = 9500+1200+7000+900 = 18600 ; execute-context = 8500+6200 = 14700 ; runs = 2
_OFF_EVENTS = [
    _evt("off-1", "execute", inp=8000, out=1000, cache=500, cache_creation=0, arm=MEMORY_LANE_OFF_ARM),
    _evt("off-1", "verify", inp=1000, out=200, cache=0, cache_creation=0, arm=MEMORY_LANE_OFF_ARM),
    _evt("off-2", "execute", inp=6000, out=800, cache=200, cache_creation=0, arm=MEMORY_LANE_OFF_ARM),
    _evt("off-2", "test-author", inp=500, out=100, cache=0, cache_creation=300, arm=MEMORY_LANE_OFF_ARM),
]

# memory-lane ON ("full"):
#   run on-1:
#     execute:     5000+900+400+0 = 6300    (context = input 5000 + cache 400 = 5400)
#     verify:      900+200+0+0    = 1100
#   run on-2:
#     execute:     4000+700+100+0 = 4800    (context = input 4000 + cache 100 = 4100)
#     test-author: 400+100+0+200  = 700
#   TOTAL = 6300+1100+4800+700 = 12900 ; execute-context = 5400+4100 = 9500 ; runs = 2
_ON_EVENTS = [
    _evt("on-1", "execute", inp=5000, out=900, cache=400, cache_creation=0, arm=MEMORY_LANE_ON_ARM),
    _evt("on-1", "verify", inp=900, out=200, cache=0, cache_creation=0, arm=MEMORY_LANE_ON_ARM),
    _evt("on-2", "execute", inp=4000, out=700, cache=100, cache_creation=0, arm=MEMORY_LANE_ON_ARM),
    _evt("on-2", "test-author", inp=400, out=100, cache=0, cache_creation=200, arm=MEMORY_LANE_ON_ARM),
]

_OFF_TOTAL = 18600
_OFF_EXECUTE_CONTEXT = 14700
_OFF_RUNS = 2

_ON_TOTAL = 12900
_ON_EXECUTE_CONTEXT = 9500
_ON_RUNS = 2

# ON spends fewer tokens than OFF → the lane SAVED tokens (positive).
_TOTAL_DELTA = _ON_TOTAL - _OFF_TOTAL  # ON - OFF = -5700
_TOKENS_SAVED = _OFF_TOTAL - _ON_TOTAL  # OFF - ON = +5700
_EXECUTE_CONTEXT_DELTA = _ON_EXECUTE_CONTEXT - _OFF_EXECUTE_CONTEXT  # -5200
_EXECUTE_CONTEXT_SAVED = _OFF_EXECUTE_CONTEXT - _ON_EXECUTE_CONTEXT  # +5200

_ARM_BY_RUN_ID = {
    "off-1": MEMORY_LANE_OFF_ARM,
    "off-2": MEMORY_LANE_OFF_ARM,
    "on-1": MEMORY_LANE_ON_ARM,
    "on-2": MEMORY_LANE_ON_ARM,
}


def _write_ledger(path: Path, rows: List[dict]) -> Path:
    path.write_text(
        "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8"
    )
    return path


def _events_from_rows(rows: List[dict]) -> List[CostEvent]:
    """Build :class:`CostEvent`s from ledger-dict rows (the ``_evt`` shape)."""
    return [
        CostEvent(
            run_id=r["run_id"],
            phase=r["phase"],
            input_tokens=r["input_tokens"],
            output_tokens=r["output_tokens"],
            cache_tokens=r["cache_tokens"],
            cache_creation_tokens=r["cache_creation_tokens"],
            arm=r.get("arm"),
        )
        for r in rows
    ]


def _by_arm(reports: List[MemoryArmTokenReport]) -> Dict[str, MemoryArmTokenReport]:
    return {r.arm: r for r in reports}


# ---------------------------------------------------------------------------
# aggregate_memory_tokens — per-arm totals, both attribution paths.
# ---------------------------------------------------------------------------


def test_aggregate_by_arm_field_computes_totals() -> None:
    reports = _by_arm(aggregate_memory_tokens(_events_from_rows(_OFF_EVENTS + _ON_EVENTS)))

    off = reports[MEMORY_LANE_OFF_ARM]
    assert off.run_count == _OFF_RUNS
    assert off.total_tokens == _OFF_TOTAL
    assert off.execute_context_tokens == _OFF_EXECUTE_CONTEXT

    on = reports[MEMORY_LANE_ON_ARM]
    assert on.run_count == _ON_RUNS
    assert on.total_tokens == _ON_TOTAL
    assert on.execute_context_tokens == _ON_EXECUTE_CONTEXT

    # The before/after headline: memory-lane ON spends fewer tokens than OFF.
    assert on.total_tokens < off.total_tokens


def test_aggregate_by_run_id_map_matches_arm_field(tmp_path: Path) -> None:
    """A raw (untagged) ledger + an explicit run_id->arm map yields the same totals."""
    ledger = _write_ledger(
        tmp_path / "cost-events.jsonl",
        # Strip the ``arm`` tag so attribution MUST come from the map.
        [{k: v for k, v in r.items() if k != "arm"} for r in (_OFF_EVENTS + _ON_EVENTS)],
    )
    events = load_cost_events(ledger)
    assert all(e.arm is None for e in events)  # no arm tag on any event

    reports = _by_arm(aggregate_memory_tokens(events, arm_by_run_id=_ARM_BY_RUN_ID))
    assert reports[MEMORY_LANE_OFF_ARM].total_tokens == _OFF_TOTAL
    assert reports[MEMORY_LANE_OFF_ARM].execute_context_tokens == _OFF_EXECUTE_CONTEXT
    assert reports[MEMORY_LANE_ON_ARM].total_tokens == _ON_TOTAL
    assert reports[MEMORY_LANE_ON_ARM].execute_context_tokens == _ON_EXECUTE_CONTEXT


def test_unattributable_events_are_dropped() -> None:
    """Events whose run_id is not in the map (and carry no arm) never land in an arm."""
    events = [CostEvent(run_id="mystery", phase="execute", input_tokens=999)]
    assert aggregate_memory_tokens(events, arm_by_run_id={"other": "full"}) == []
    assert aggregate_memory_tokens(events) == []


def test_multiple_runs_sum_and_count_per_arm() -> None:
    """Two runs of the same arm sum their tokens and count as two runs."""
    events = [
        CostEvent(run_id="a", phase="execute", input_tokens=100, cache_tokens=10, arm="full"),
        CostEvent(run_id="b", phase="execute", input_tokens=200, cache_tokens=20, arm="full"),
    ]
    (report,) = aggregate_memory_tokens(events)
    assert report.arm == "full"
    assert report.run_count == 2
    assert report.total_tokens == 110 + 220
    assert report.execute_context_tokens == (100 + 10) + (200 + 20)


def test_execute_context_counts_execute_phase_only() -> None:
    """Only the EXECUTE phase feeds execute_context_tokens; other phases don't."""
    events = [
        CostEvent(run_id="r", phase="execute", input_tokens=1000, cache_tokens=100, arm="full"),
        CostEvent(run_id="r", phase="verify", input_tokens=9999, cache_tokens=9999, arm="full"),
    ]
    (report,) = aggregate_memory_tokens(events)
    assert report.execute_context_tokens == 1000 + 100  # verify excluded


# ---------------------------------------------------------------------------
# memory_lane_token_delta — OFF vs ON head-to-head, saving stated both ways.
# ---------------------------------------------------------------------------


def _fixture_reports() -> List[MemoryArmTokenReport]:
    return aggregate_memory_tokens(_events_from_rows(_OFF_EVENTS + _ON_EVENTS))


def test_delta_off_vs_on_and_tokens_saved() -> None:
    delta = memory_lane_token_delta(_fixture_reports())
    assert delta is not None
    assert delta.off_arm == MEMORY_LANE_OFF_ARM
    assert delta.on_arm == MEMORY_LANE_ON_ARM

    # Per-arm totals are carried so the number is auditable.
    assert delta.off_run_count == _OFF_RUNS
    assert delta.on_run_count == _ON_RUNS
    assert delta.off_total_tokens == _OFF_TOTAL
    assert delta.on_total_tokens == _ON_TOTAL

    # ON minus OFF (gather convention): negative because the lane helped.
    assert delta.total_tokens_delta == _TOTAL_DELTA
    assert delta.total_tokens_delta == -5700
    assert delta.total_tokens_delta < 0

    # tokens_saved_by_lane = OFF - ON: positive = the lane reduced tokens.
    assert delta.tokens_saved_by_lane == _TOKENS_SAVED
    assert delta.tokens_saved_by_lane == 5700
    assert delta.tokens_saved_by_lane > 0
    # The two views are exact negatives of each other.
    assert delta.tokens_saved_by_lane == -delta.total_tokens_delta
    assert delta.lane_reduced_tokens is True

    # Execute-phase context tells the same before/after story.
    assert delta.execute_context_delta == _EXECUTE_CONTEXT_DELTA
    assert delta.execute_context_saved_by_lane == _EXECUTE_CONTEXT_SAVED
    assert delta.execute_context_saved_by_lane > 0


def test_delta_arm_name_agnostic_caller_names_the_arms() -> None:
    """Caller-supplied arm names drive the delta (the report is arm-name-agnostic)."""
    events = [
        CostEvent(run_id="b1", phase="execute", input_tokens=1000, arm="baseline"),
        CostEvent(run_id="t1", phase="execute", input_tokens=600, arm="treatment"),
    ]
    reports = aggregate_memory_tokens(events)
    delta = memory_lane_token_delta(reports, off_arm="baseline", on_arm="treatment")
    assert delta is not None
    assert delta.off_arm == "baseline" and delta.on_arm == "treatment"
    assert delta.off_total_tokens == 1000
    assert delta.on_total_tokens == 600
    assert delta.total_tokens_delta == -400
    assert delta.tokens_saved_by_lane == 400
    assert delta.lane_reduced_tokens is True


def test_delta_negative_saving_when_lane_costs_more() -> None:
    """If the ON arm spends MORE, tokens_saved is negative and lane_reduced is False."""
    events = [
        CostEvent(run_id="o", phase="execute", input_tokens=1000, arm=MEMORY_LANE_OFF_ARM),
        CostEvent(run_id="n", phase="execute", input_tokens=1500, arm=MEMORY_LANE_ON_ARM),
    ]
    delta = memory_lane_token_delta(aggregate_memory_tokens(events))
    assert delta is not None
    assert delta.total_tokens_delta == 500
    assert delta.tokens_saved_by_lane == -500
    assert delta.lane_reduced_tokens is False


def test_delta_none_when_an_arm_is_absent() -> None:
    # Only the OFF arm present → no pair → None (never a fabricated row).
    off_only = [r for r in _fixture_reports() if r.arm == MEMORY_LANE_OFF_ARM]
    assert memory_lane_token_delta(off_only) is None


def test_delta_from_ledger_end_to_end(tmp_path: Path) -> None:
    """Read a written ledger and reduce it to the OFF-vs-ON saving, end to end."""
    ledger = _write_ledger(tmp_path / "cost-events.jsonl", _OFF_EVENTS + _ON_EVENTS)
    reports = aggregate_memory_tokens(load_cost_events(ledger))
    delta = memory_lane_token_delta(reports)
    assert delta is not None
    assert delta.tokens_saved_by_lane == _TOKENS_SAVED
    assert delta.total_tokens_delta == _TOTAL_DELTA


def test_arm_report_and_delta_are_frozen() -> None:
    """The report rows are immutable once computed."""
    rep = MemoryArmTokenReport(arm="full", run_count=1, total_tokens=1, execute_context_tokens=1)
    with pytest.raises(Exception):
        rep.total_tokens = 0  # type: ignore[misc]

    delta = memory_lane_token_delta(_fixture_reports())
    assert isinstance(delta, MemoryLaneTokenDelta)
    with pytest.raises(Exception):
        delta.tokens_saved_by_lane = 0  # type: ignore[misc]


# ---------------------------------------------------------------------------
# render_memory_report_from_ledger — the wiring #1216 never landed. This is
# the actual bug fix under test: the reducer above was correct but had no
# call site, so no eval report ever showed a memory-lane number. These assert
# the render function (a) reads a real ledger and renders real numbers with
# BOTH arms present, (b) never fabricates a 0 when the ledger is empty/missing,
# and (c) never fabricates a 0 when only ONE of the two arms is present either
# — always "n/a", with the sample basis (which arms/counts ARE there) visible.
# ---------------------------------------------------------------------------


def test_render_from_ledger_not_available_without_a_ledger() -> None:
    text = render_memory_report_from_ledger(None)
    assert "Memory-lane token effect (#1039/#1071)" in text
    assert "n/a" in text and "not available" in text
    # Never a fabricated number.
    assert "18600" not in text and "12900" not in text


def test_render_from_ledger_not_available_for_missing_file(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist.jsonl"
    text = render_memory_report_from_ledger(missing)
    assert "n/a" in text and "not available" in text


def test_render_from_ledger_populated_with_both_arms(tmp_path: Path) -> None:
    ledger = _write_ledger(tmp_path / "cost-events.jsonl", _OFF_EVENTS + _ON_EVENTS)
    text = render_memory_report_from_ledger(ledger)

    assert "Memory-lane token effect (#1039/#1071)" in text
    assert MEMORY_LANE_OFF_ARM in text
    assert MEMORY_LANE_ON_ARM in text
    # Real numbers appear — the sample basis, not a bare unexplained number.
    assert str(_OFF_TOTAL) in text
    assert str(_ON_TOTAL) in text
    assert f"{_OFF_RUNS} run" in text or str(_OFF_RUNS) in text
    assert "REDUCED tokens" in text
    # The delta section is populated, not an n/a note.
    assert "n/a" not in text.split("## full-minus-memory_lane vs full", 1)[1]


def test_render_from_ledger_na_when_only_off_arm_present(tmp_path: Path) -> None:
    """Only the OFF arm ran (no ON arm anywhere) -> honest n/a, never a fake 0."""
    ledger = _write_ledger(tmp_path / "cost-events.jsonl", _OFF_EVENTS)
    text = render_memory_report_from_ledger(ledger)

    assert MEMORY_LANE_OFF_ARM in text
    # Never fabricate a delta/tokens-saved number when the ON arm is absent.
    assert "n/a" in text
    delta_section = text.split("## full-minus-memory_lane vs full", 1)[1]
    assert "n/a" in delta_section
    # The sample basis is still shown: which arm(s) ARE present.
    assert MEMORY_LANE_OFF_ARM in delta_section
    assert "REDUCED tokens" not in text


def test_render_from_ledger_na_when_only_on_arm_present(tmp_path: Path) -> None:
    """Only the ON arm ran -> also an honest n/a (not just the OFF-missing case)."""
    ledger = _write_ledger(tmp_path / "cost-events.jsonl", _ON_EVENTS)
    text = render_memory_report_from_ledger(ledger)

    assert MEMORY_LANE_ON_ARM in text
    delta_section = text.split("## full-minus-memory_lane vs full", 1)[1]
    assert "n/a" in delta_section


def test_render_markdown_matches_render_from_ledger(tmp_path: Path) -> None:
    """render_memory_lane_token_markdown + explicit reports == the ledger convenience."""
    ledger = _write_ledger(tmp_path / "cost-events.jsonl", _OFF_EVENTS + _ON_EVENTS)
    via_ledger = render_memory_report_from_ledger(ledger)
    via_direct = render_memory_lane_token_markdown(
        aggregate_memory_tokens(load_cost_events(ledger))
    )
    assert via_ledger == via_direct
