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

import pytest

from agentrail.evals.gather_report import (
    AC4_PRECISION_FLOOR,
    AC4_RECALL_FLOOR,
    ArmPrecisionReport,
    ArmTokenReport,
    CostEvent,
    GATHER_OFF_ARM,
    GATHER_ON_ARM,
    GatherCoverage,
    aggregate_gather_precision,
    aggregate_gather_tokens,
    gather_precision_coverage,
    gather_token_delta,
    load_cost_events,
    render_gather_precision_from_records,
    render_gather_precision_markdown,
    render_gather_report_from_ledger,
    render_gather_token_markdown,
    render_per_run_gather_details,
)
from agentrail.evals.run_record import (
    NO_GRADEABLE_ORACLE_REASON,
    GatherScore,
    RunRecord,
)
from agentrail.run.usage_capture import Usage


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


# ===========================================================================
# Precision half (#1049 AC4) — "did the gatherer pick the RIGHT files?"
#
# Also fixture-driven: hand-built RunRecords carrying a GatherScore, pooled per
# arm and rendered. The runner produces these from a real manifest + answer key
# (covered in test_runner.py); here we pin the POOLED micro-average and the AC4
# verdict, which is the truth-critical arithmetic.
# ===========================================================================


def _gscore(*, selected: List[str], required: List[str]) -> GatherScore:
    """A GatherScore with intersection/precision/recall derived from the sets.

    Mirrors what the runner builds via ``pack_precision_recall`` so the fixture
    can never disagree with the real scorer: precision ``None`` on 0 picks (0/0
    undefined), recall a real value against the always-non-empty answer key.
    """
    inter = len(set(selected) & set(required))
    precision = (inter / len(selected)) if selected else None
    recall = (inter / len(required)) if required else None
    return GatherScore(
        precision=precision,
        recall=recall,
        selected_paths=sorted(set(selected)),
        required_paths=sorted(set(required)),
        intersection=inter,
    )


def _ungraded(*, selected: List[str], dropped: List[str]) -> GatherScore:
    """An UNGRADEABLE GatherScore — no oracle file existed at the checkout.

    Mirrors what the runner builds when the existence filter empties the oracle:
    raw picks preserved, filtered oracle empty, every oracle entry dropped, and
    precision/recall both ``None`` behind an explicit reason.
    """
    return GatherScore(
        precision=None,
        recall=None,
        selected_paths=sorted(set(selected)),
        required_paths=[],
        intersection=0,
        dropped_oracle_paths=sorted(set(dropped)),
        ungraded_reason=NO_GRADEABLE_ORACLE_REASON,
    )


def _run(arm: str, gather_score, task: str = "t") -> RunRecord:
    """A minimal RunRecord in ``arm`` carrying (or not) a gather score."""
    return RunRecord(
        task=task,
        arm=arm,
        diff="",
        model="m",
        usage=Usage("m", 1, 1, 0, 0),
        wall_time_s=1.0,
        gate_passed=True,
        gather_score=gather_score,
    )


def test_aggregate_pools_micro_average_not_mean_of_ratios() -> None:
    """Pooled precision/recall sum raw counts, not average per-run ratios.

    run1 picks {a,b,c} against {a,b,c} → 3/3 each.
    run2 picks {a,b,c,d} against {a,b,c,e} → 3/4 each.
    Pooled: inter 6, selected 7, required 7 → 6/7 each. A naive mean of ratios
    would give (1.0 + 0.75)/2 = 0.875 ≠ 6/7 ≈ 0.857 — this pins the micro-average.
    """
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b", "c"], required=["a", "b", "c"])),
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b", "c", "d"], required=["a", "b", "c", "e"])),
    ]
    reports = aggregate_gather_precision(records)

    assert len(reports) == 1
    rep = reports[0]
    assert rep.arm == GATHER_ON_ARM
    assert rep.run_count == 2
    assert rep.total_intersection == 6
    assert rep.total_selected == 7
    assert rep.total_required == 7
    assert rep.precision == 6 / 7
    assert rep.recall == 6 / 7
    # 6/7 ≈ 0.857 clears both floors → passes AC4.
    assert rep.meets_ac4 is True


def test_aggregate_excludes_runs_without_a_gather_score() -> None:
    """A ``None`` gather score (gatherer did not run) contributes nothing.

    NOT counted as a zero-precision run — it is simply absent from the pool, so a
    ``full`` arm with no gather phase never appears in the precision report.
    """
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a"], required=["a"])),
        _run("full", None),
        _run("full", None),
    ]
    reports = aggregate_gather_precision(records)

    assert [r.arm for r in reports] == [GATHER_ON_ARM]
    assert reports[0].run_count == 1


def test_aggregate_arms_sorted_for_deterministic_report() -> None:
    """Multiple scored arms come back sorted by name."""
    records = [
        _run("zeta-arm", _gscore(selected=["a"], required=["a"])),
        _run("alpha-arm", _gscore(selected=["a"], required=["a"])),
    ]
    assert [r.arm for r in aggregate_gather_precision(records)] == [
        "alpha-arm",
        "zeta-arm",
    ]


def test_precision_is_none_when_gatherer_selected_nothing() -> None:
    """Picked-nothing pools to precision None (0/0), recall a real 0.0."""
    records = [_run(GATHER_ON_ARM, _gscore(selected=[], required=["a", "b"]))]
    rep = aggregate_gather_precision(records)[0]

    assert rep.total_selected == 0
    assert rep.precision is None  # 0/0 undefined — never a fabricated 0.0
    assert rep.recall == 0.0  # real answer key, zero hits
    assert rep.meets_ac4 is False


def test_render_precision_pass_verdict() -> None:
    """A gather arm clearing both floors renders the CLEARS-AC4 verdict."""
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b", "c"], required=["a", "b", "c"])),
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b", "c", "d"], required=["a", "b", "c", "e"])),
    ]
    md = render_gather_precision_from_records(records)

    assert "CLEARS AC4" in md
    assert GATHER_ON_ARM in md
    assert f"{AC4_PRECISION_FLOOR:.2f}" in md
    assert f"{AC4_RECALL_FLOOR:.2f}" in md


def test_render_precision_flagged_when_recall_below_floor() -> None:
    """Precision high but recall below floor → FLAGGED, and the 'do NOT turn on'."""
    # pooled inter 8, selected 10, required 10 → p 0.8 (ok), r 0.8 (< 0.85).
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b", "c", "d", "e"], required=["a", "b", "c", "d"])),
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b", "c", "d", "e"], required=["a", "b", "c", "d", "f", "g"])),
    ]
    md = render_gather_precision_from_records(records)

    assert "MISSES AC4" in md and "FLAGGED" in md
    assert "Do NOT turn the gather flag on" in md


def test_render_precision_no_records_is_not_available() -> None:
    """No scored run → honest 'not available — needs a live run' (never a fake 0)."""
    md = render_gather_precision_from_records([_run("full", None)])

    assert "Not available" in md
    assert "live" in md
    # No table header, no fabricated verdict.
    assert "| Arm | Gather runs |" not in md
    assert "CLEARS AC4" not in md
    assert "MISSES AC4" not in md


def test_render_precision_verdict_absent_when_no_gather_arm() -> None:
    """Scored runs exist but none is the gather arm → verdict is explicitly n/a."""
    records = [_run("some-other-arm", _gscore(selected=["a"], required=["a"]))]
    md = render_gather_precision_from_records(records)

    # The arm's row still renders...
    assert "some-other-arm" in md
    # ...but the AC4 verdict cannot be pronounced without the gather arm.
    assert "verdict not available" in md
    assert "CLEARS AC4" not in md
    assert "MISSES AC4" not in md


def test_arm_precision_report_is_frozen() -> None:
    """The report row is immutable — a scored arm can't be mutated after the fact."""
    rep = ArmPrecisionReport(
        arm=GATHER_ON_ARM,
        run_count=1,
        total_intersection=1,
        total_selected=1,
        total_required=1,
        precision=1.0,
        recall=1.0,
    )
    with pytest.raises(Exception):
        rep.precision = 0.0  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Oracle-fairness coverage: ungradeable runs are EXCLUDED from the pool but
# made VISIBLE — a coverage line next to the AC4 verdict and a per-run detail
# section, so a pooled number over a subset of runs can never masquerade as
# full-corpus coverage (and past runs stay auditable from their raw picks).
# ---------------------------------------------------------------------------


def test_aggregate_excludes_ungradeable_scores_from_pooling() -> None:
    """A run with no gradeable oracle contributes NOTHING to the pooled numbers.

    Folding it in as a zero would recreate the structural-zero measurement
    artifact the existence filter exists to remove — it is simply absent, just
    like a run where the gatherer never ran.
    """
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a", "b"], required=["a", "b"])),
        _run(GATHER_ON_ARM, _ungraded(selected=["x", "y", "z"], dropped=["fix-made.py"])),
    ]
    reports = aggregate_gather_precision(records)

    assert len(reports) == 1
    rep = reports[0]
    assert rep.run_count == 1  # the ungradeable run is not counted
    assert rep.total_selected == 2  # its 3 picks never entered the pool
    assert rep.precision == 1.0
    assert rep.recall == 1.0


def test_gather_precision_coverage_counts_and_names_ungradeable_tasks() -> None:
    """Coverage = scored vs gradeable runs + sorted unique ungradeable task names.

    Records without any gather score (the gatherer did not run) are outside
    both counts.
    """
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a"], required=["a"]), task="good-task"),
        _run(GATHER_ON_ARM, _ungraded(selected=["x"], dropped=["gone.py"]), task="zeta-task"),
        _run(GATHER_ON_ARM, _ungraded(selected=[], dropped=["gone.py"]), task="alpha-task"),
        _run("full", None, task="no-gather-task"),
    ]
    cov = gather_precision_coverage(records)

    assert cov.scored_runs == 3
    assert cov.gradeable_runs == 1
    assert cov.ungradeable_tasks == ["alpha-task", "zeta-task"]


def test_render_coverage_line_near_the_verdict() -> None:
    """The rendered section carries 'gradeable runs X/Y' + the ungradeable tasks."""
    records = [
        _run(GATHER_ON_ARM, _gscore(selected=["a"], required=["a"])),
        _run(GATHER_ON_ARM, _gscore(selected=["b"], required=["b"])),
        _run(GATHER_ON_ARM, _ungraded(selected=["x"], dropped=["gone.py"]), task="unfair-task"),
    ]
    md = render_gather_precision_from_records(records)

    assert "gradeable runs 2/3" in md
    assert "tasks with no gradeable oracle: `unfair-task`" in md
    # And the verdict is still pronounced from the 2 gradeable runs.
    assert "CLEARS AC4" in md


def test_render_coverage_line_reads_none_when_all_gradeable() -> None:
    records = [_run(GATHER_ON_ARM, _gscore(selected=["a"], required=["a"]))]
    md = render_gather_precision_from_records(records)

    assert "gradeable runs 1/1" in md
    assert "tasks with no gradeable oracle: none" in md


def test_render_all_ungradeable_shows_coverage_not_a_fake_zero() -> None:
    """Every scored run ungradeable → no pooled table, no verdict, coverage shown."""
    records = [
        _run(GATHER_ON_ARM, _ungraded(selected=["x"], dropped=["gone.py"]), task="unfair-task"),
    ]
    md = render_gather_precision_from_records(records)

    assert "Not available" in md
    assert "no scored run had a gradeable oracle" in md
    assert "gradeable runs 0/1" in md
    assert "`unfair-task`" in md
    assert "| Arm | Gather runs |" not in md
    assert "CLEARS AC4" not in md and "MISSES AC4" not in md


def test_per_run_details_render_picks_oracle_and_dropped() -> None:
    """The per-run section shows raw picks, the filtered oracle, and dropped entries."""
    records = [
        _run(
            GATHER_ON_ARM,
            _gscore(selected=["a.py", "b.py"], required=["a.py"]),
            task="graded-task",
        ),
        _run(
            GATHER_ON_ARM,
            _ungraded(selected=["x.py"], dropped=["fix-made.py"]),
            task="unfair-task",
        ),
        _run("full", None, task="no-gather-task"),
    ]
    md = render_gather_precision_from_records(records)

    assert "## Per-run gather picks" in md
    # Graded run: precision 1/2, recall 1/1, picks + oracle listed.
    assert "`graded-task`" in md
    assert "precision 0.50, recall 1.00" in md
    assert "picked: `a.py`, `b.py`" in md
    assert "oracle: `a.py`" in md
    # Ungraded run: explicit reason + the dropped oracle entry.
    assert "`unfair-task`" in md
    assert f"UNGRADED ({NO_GRADEABLE_ORACLE_REASON})" in md
    assert "dropped (absent at checkout): `fix-made.py`" in md
    # A record whose gatherer never ran renders no bullet.
    assert "no-gather-task" not in md


def test_per_run_details_empty_when_nothing_scored() -> None:
    """No scored run → no per-run section at all (not an empty header)."""
    assert render_per_run_gather_details([_run("full", None)]) == ""
    md = render_gather_precision_from_records([_run("full", None)])
    assert "## Per-run gather picks" not in md


def test_gather_coverage_is_frozen() -> None:
    """Coverage is immutable once computed."""
    cov = GatherCoverage(scored_runs=2, gradeable_runs=1, ungradeable_tasks=["t"])
    with pytest.raises(Exception):
        cov.scored_runs = 3  # type: ignore[misc]
