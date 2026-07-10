"""Tests for the gather token-reduction + cache-hit report (issue #1049 AC4).

Everything here is fixture-driven: a synthetic ``cost-events.jsonl`` with KNOWN
per-phase tokens for the ``full`` (gather OFF) and ``full-plus-gather`` (gather
ON) arms. No real agent run, no sandbox, no network. The tests assert the
reporter computes TOTAL tokens, EXECUTE-phase context, and the CACHE-HIT flag
correctly for both arms, and that the gather-ON executor context comes back
strictly below gather-OFF (the #1023 AC4 claim the report is built to falsify).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

from agentrail.evals.gather_report import (
    ArmTokenReport,
    CostEvent,
    GATHER_OFF_ARM,
    GATHER_ON_ARM,
    aggregate_gather_tokens,
    gather_token_delta,
    load_cost_events,
    render_gather_report_from_ledger,
    render_gather_token_markdown,
)


# ---------------------------------------------------------------------------
# The synthetic fixture. Numbers are chosen so the story is faithful AND every
# derived metric is hand-checkable:
#
#   full (gather OFF): fat retrieval pack → big EXECUTE context; no gather phase.
#   full-plus-gather:  cheap gather phase + a byte-stable manifest → the EXECUTE
#                      context shrinks, and the gather-phase spend is tuned so the
#                      TOTAL across phases stays ≈ flat (exactly equal here).
#
# Both arms carry cache reads on execute/verify (warm-cache HIT). Each event is a
# ``build_cost_record`` dict shape: run_id / phase / *_tokens (+ an ``arm`` tag a
# per-arm eval ledger would write).
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


# full (gather OFF), run "run-off":
#   test-author: 1200+200+300+800 = 2500
#   execute:     9000+1500+1000+0 = 11500   (context = input 9000 + cache 1000 = 10000)
#   verify:      1500+200+500+0   = 2200
#   TOTAL = 16200 ; execute-context = 10000 ; warm-cache = 1000+500 = 1500 (HIT)
_OFF_EVENTS = [
    _evt("run-off", "test-author", inp=1200, out=200, cache=300, cache_creation=800, arm=GATHER_OFF_ARM),
    _evt("run-off", "execute", inp=9000, out=1500, cache=1000, cache_creation=0, arm=GATHER_OFF_ARM),
    _evt("run-off", "verify", inp=1500, out=200, cache=500, cache_creation=0, arm=GATHER_OFF_ARM),
]

# full-plus-gather (gather ON), run "run-on":
#   gather:      1500+2000+0+3000 = 6500
#   test-author: 800+200+300+500  = 1800
#   execute:     3000+1500+1200+0 = 5700    (context = input 3000 + cache 1200 = 4200)
#   verify:      1500+200+500+0   = 2200
#   TOTAL = 16200 ; execute-context = 4200 ; warm-cache = 1200+500 = 1700 (HIT)
_ON_EVENTS = [
    _evt("run-on", "gather", inp=1500, out=2000, cache=0, cache_creation=3000, arm=GATHER_ON_ARM),
    _evt("run-on", "test-author", inp=800, out=200, cache=300, cache_creation=500, arm=GATHER_ON_ARM),
    _evt("run-on", "execute", inp=3000, out=1500, cache=1200, cache_creation=0, arm=GATHER_ON_ARM),
    _evt("run-on", "verify", inp=1500, out=200, cache=500, cache_creation=0, arm=GATHER_ON_ARM),
]

_OFF_TOTAL = 16200
_OFF_EXECUTE_CONTEXT = 10000
_OFF_WARM_CACHE = 1500

_ON_TOTAL = 16200
_ON_EXECUTE_CONTEXT = 4200
_ON_WARM_CACHE = 1700


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


def _by_arm(reports: List[ArmTokenReport]) -> Dict[str, ArmTokenReport]:
    return {r.arm: r for r in reports}


# ---------------------------------------------------------------------------
# load_cost_events — tolerant parse.
# ---------------------------------------------------------------------------


def test_missing_ledger_file_returns_empty(tmp_path: Path) -> None:
    assert load_cost_events(tmp_path / "does-not-exist.jsonl") == []


def test_load_tolerates_torn_ledger(tmp_path: Path) -> None:
    """Blank lines, non-JSON, non-object, and un-attributable lines are skipped."""
    ledger = tmp_path / "cost-events.jsonl"
    ledger.write_text(
        "\n"  # blank
        + json.dumps(_evt("r1", "execute", inp=100, cache=5, arm="full")) + "\n"
        + "not json at all\n"  # malformed
        + "[1, 2, 3]\n"  # valid JSON but not an object
        + json.dumps({"phase": "execute", "input_tokens": 9}) + "\n"  # no run_id
        + json.dumps({"run_id": "r2"}) + "\n"  # no phase
        + json.dumps(_evt("r1", "verify", inp=7, arm="full")) + "\n",
        encoding="utf-8",
    )
    events = load_cost_events(ledger)
    assert [(e.run_id, e.phase) for e in events] == [("r1", "execute"), ("r1", "verify")]
    # Missing token fields default to 0; present ones parse.
    assert events[0].input_tokens == 100
    assert events[0].cache_tokens == 5
    assert events[0].output_tokens == 0


def test_cost_event_derived_token_properties() -> None:
    e = CostEvent(
        run_id="r", phase="execute",
        input_tokens=100, output_tokens=20, cache_tokens=30, cache_creation_tokens=40,
    )
    assert e.total_tokens == 190          # all four buckets
    assert e.context_tokens == 130        # input + cache only


# ---------------------------------------------------------------------------
# aggregate_gather_tokens — per-arm totals, both attribution paths.
# ---------------------------------------------------------------------------


def test_aggregate_by_arm_field_computes_all_metrics() -> None:
    events = _events_from_rows(_OFF_EVENTS + _ON_EVENTS)
    reports = _by_arm(aggregate_gather_tokens(events))

    off = reports[GATHER_OFF_ARM]
    assert off.run_count == 1
    assert off.total_tokens == _OFF_TOTAL
    assert off.execute_context_tokens == _OFF_EXECUTE_CONTEXT
    assert off.warm_cache_tokens == _OFF_WARM_CACHE
    assert off.cache_hit is True

    on = reports[GATHER_ON_ARM]
    assert on.run_count == 1
    assert on.total_tokens == _ON_TOTAL
    assert on.execute_context_tokens == _ON_EXECUTE_CONTEXT
    assert on.warm_cache_tokens == _ON_WARM_CACHE
    assert on.cache_hit is True

    # The headline AC4 assertion: gather-ON executor context < gather-OFF.
    assert on.execute_context_tokens < off.execute_context_tokens


def test_aggregate_by_run_id_map_matches_arm_field(tmp_path: Path) -> None:
    """A raw (untagged) ledger + an explicit run_id->arm map yields the same result."""
    ledger = _write_ledger(
        tmp_path / "ledger.jsonl",
        # Strip the ``arm`` tag so attribution MUST come from the map.
        [{k: v for k, v in r.items() if k != "arm"} for r in (_OFF_EVENTS + _ON_EVENTS)],
    )
    events = load_cost_events(ledger)
    assert all(e.arm is None for e in events)  # no arm tag on any event

    reports = _by_arm(
        aggregate_gather_tokens(
            events, arm_by_run_id={"run-off": GATHER_OFF_ARM, "run-on": GATHER_ON_ARM}
        )
    )
    assert reports[GATHER_OFF_ARM].execute_context_tokens == _OFF_EXECUTE_CONTEXT
    assert reports[GATHER_ON_ARM].execute_context_tokens == _ON_EXECUTE_CONTEXT
    assert reports[GATHER_ON_ARM].total_tokens == _ON_TOTAL


def test_unattributable_events_are_dropped() -> None:
    """Events whose run_id is not in the map (and carry no arm) never land in an arm."""
    events = [CostEvent(run_id="mystery", phase="execute", input_tokens=999)]
    # Map does not mention "mystery" → dropped, no arm produced.
    assert aggregate_gather_tokens(events, arm_by_run_id={"other": "full"}) == []
    # No map and no arm tag → also dropped.
    assert aggregate_gather_tokens(events) == []


def test_multiple_runs_sum_and_count_per_arm() -> None:
    """Two runs of the same arm sum their tokens and count as two runs."""
    events = [
        CostEvent(run_id="a", phase="execute", input_tokens=100, cache_tokens=10, arm="full"),
        CostEvent(run_id="b", phase="execute", input_tokens=200, cache_tokens=20, arm="full"),
    ]
    (report,) = aggregate_gather_tokens(events)
    assert report.arm == "full"
    assert report.run_count == 2
    assert report.execute_context_tokens == (100 + 10) + (200 + 20)
    assert report.total_tokens == 110 + 220


def test_cold_cache_reads_no_hit() -> None:
    """A run with zero cache reads on execute/verify → cache_hit False (not fabricated)."""
    events = [
        CostEvent(run_id="c", phase="execute", input_tokens=500, cache_tokens=0, arm="full"),
        CostEvent(run_id="c", phase="verify", input_tokens=100, cache_tokens=0, arm="full"),
    ]
    (report,) = aggregate_gather_tokens(events)
    assert report.warm_cache_tokens == 0
    assert report.cache_hit is False


# ---------------------------------------------------------------------------
# gather_token_delta — full vs full-plus-gather head-to-head.
# ---------------------------------------------------------------------------


def _fixture_reports() -> List[ArmTokenReport]:
    return aggregate_gather_tokens(_events_from_rows(_OFF_EVENTS + _ON_EVENTS))


def test_delta_full_vs_full_plus_gather() -> None:
    delta = gather_token_delta(_fixture_reports())
    assert delta is not None
    assert delta.off_arm == GATHER_OFF_ARM
    assert delta.on_arm == GATHER_ON_ARM

    # TOTAL ≈ flat (exactly equal on this fixture).
    assert delta.off_total_tokens == _OFF_TOTAL
    assert delta.on_total_tokens == _ON_TOTAL
    assert delta.total_tokens_delta == 0

    # EXECUTE context drops materially (the win): on - off is strongly negative.
    assert delta.on_execute_context_tokens < delta.off_execute_context_tokens
    assert delta.execute_context_delta == _ON_EXECUTE_CONTEXT - _OFF_EXECUTE_CONTEXT
    assert delta.execute_context_delta < 0
    assert delta.execute_context_dropped is True

    # CACHE-HIT evidence on both arms.
    assert delta.off_cache_hit is True
    assert delta.on_cache_hit is True


def test_delta_none_when_an_arm_is_absent() -> None:
    # Only the OFF arm present → no pair → None (never a fabricated row).
    off_only = [r for r in _fixture_reports() if r.arm == GATHER_OFF_ARM]
    assert gather_token_delta(off_only) is None


# ---------------------------------------------------------------------------
# Markdown rendering — real numbers, verdict, and the honest not-available note.
# ---------------------------------------------------------------------------


def test_render_contains_numbers_and_drop_verdict() -> None:
    md = render_gather_token_markdown(_fixture_reports())
    assert "Gather token-reduction + cache-hit (#1049 AC4)" in md
    assert GATHER_OFF_ARM in md and GATHER_ON_ARM in md
    # Per-arm execute-context numbers appear.
    assert str(_OFF_EXECUTE_CONTEXT) in md
    assert str(_ON_EXECUTE_CONTEXT) in md
    # The signed execute-context delta and the drop verdict.
    assert f"{_ON_EXECUTE_CONTEXT - _OFF_EXECUTE_CONTEXT:+d}" in md
    assert "DROPPED with gather ON" in md


def test_render_not_available_when_no_events() -> None:
    md = render_gather_token_markdown([])
    assert "Not available" in md
    assert "need a live" in md
    # No fabricated zero table.
    assert "| Arm | Runs |" not in md


def test_render_from_ledger_end_to_end(tmp_path: Path) -> None:
    ledger = _write_ledger(tmp_path / "cost-events.jsonl", _OFF_EVENTS + _ON_EVENTS)
    md = render_gather_report_from_ledger(ledger)
    assert GATHER_OFF_ARM in md and GATHER_ON_ARM in md
    assert "DROPPED with gather ON" in md


def test_render_from_ledger_none_path_is_not_available() -> None:
    md = render_gather_report_from_ledger(None)
    assert "Not available" in md
    assert "need a live" in md
