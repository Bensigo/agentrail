"""Gather token-reduction + cache-hit report (issue #1049 AC4).

The measurement half of the JIT context-gatherer workstream. The gather BUILD
(#1084-#1087) and the gather eval ARM (#1110 — ``full-plus-gather``, env
``AGENTRAIL_JIT_GATHER=1`` + ``AGENTRAIL_EVAL_GATHER_MODEL``) already land; this
module is the falsifiable EVIDENCE that the phase does what #1023 AC4 claims:

    - **TOTAL tokens ≈ flat.** The gather phase adds a cheap read-only pass, but
      it shrinks the executor's injected context by the same order it spends, so
      the sum across phases should NOT balloon when gather is ON.
    - **EXECUTE-phase context DROPS materially.** The whole point of the JIT
      gatherer is that the deterministic manifest replaces a fat retrieval pack,
      so the executor phase's *context* tokens (``input_tokens + cache_tokens``)
      come back smaller with gather ON than with it OFF.
    - **CACHE-HIT evidence.** AC1 requires the manifest to be byte-identical
      across test-author/execute/verify, which lets the warm ``shared_task_prefix``
      cache actually HIT — surfaced as ``cache_tokens > 0`` on the execute/verify
      phases (a cold, thrashed cache would read ``cache_tokens == 0``).

Input is the per-phase cost ledger the pipeline writes,
``.agentrail/run/cost-events.jsonl`` — one JSON line per phase, produced by
:func:`agentrail.run.cost_push.build_cost_record`
(``run_id``/``phase``/``input_tokens``/``output_tokens``/``cache_tokens``/
``cache_creation_tokens`` …). Each event is attributed to an eval ARM either by
an explicit ``run_id -> arm`` map or by an ``arm`` field carried on the event
(the shape a live per-arm eval ledger would write), so the report can pair
``full`` against ``full-plus-gather``.

Design rules (mirroring :mod:`agentrail.evals.probes` /
:mod:`agentrail.evals.pack_scorer`):

- **Pure arithmetic over the ledger.** No sandbox, no network. The only IO is
  :func:`load_cost_events` reading the ledger file; everything else is a pure
  function of the parsed events, so the truth-critical aggregation is trivially
  fixture-testable (no real agent run).
- **Tolerant parse.** The ledger is an append-only, best-effort artifact that can
  be partially written; blank/malformed lines are skipped (matching
  ``agentrail.sandbox.docker_runner.sum_cost_ledger``), missing token fields
  default to 0. A run never crashes on a torn ledger.
- **Honest, never fabricated.** With no ledger (or no ``full`` / ``full-plus-gather``
  pair in it) the head-to-head is ``None`` and the markdown renders an explicit
  "not available — needs a live run" note, never a fake 0.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Mapping, Optional, Sequence, Set

if TYPE_CHECKING:  # pragma: no cover - typing only, no runtime import cycle
    from agentrail.evals.run_record import RunRecord


# The executor phase whose *context* tokens the gatherer is meant to shrink. The
# pipeline records every execute attempt (execute, execute-2, …) under the base
# ``phase`` string ``"execute"`` (``build_cost_record(rc.run_id, phase, …)`` with
# the base name), so summing phase == "execute" captures the whole executor spend.
EXECUTE_PHASE = "execute"

# The phases whose warm ``shared_task_prefix`` cache the byte-stable manifest
# lets HIT (AC1). A cache read (``cache_tokens > 0``) on either is the falsifiable
# evidence that the prefix identity held across phases; a cold/thrashed cache
# reads 0. The gather phase itself is a fresh read-only pass, so it is NOT a
# warm-cache phase.
WARM_CACHE_PHASES = ("execute", "verify")

# The A/B pair this report exists to compare (issue #1110 arm names).
GATHER_OFF_ARM = "full"
GATHER_ON_ARM = "full-plus-gather"

# The AC4 precision-half bar (#1023 AC4, verbatim): the gatherer must point at
# the RIGHT files — "precision >= 0.7 AT recall >= 0.85". Both floors must hold on
# the gather arm's POOLED score for the precision half to pass.
AC4_PRECISION_FLOOR = 0.7
AC4_RECALL_FLOOR = 0.85


@dataclass(frozen=True)
class CostEvent:
    """One phase's entry from the cost ledger (``cost-events.jsonl``).

    Mirrors the subset of :func:`agentrail.run.cost_push.build_cost_record` this
    report needs. ``arm`` is OPTIONAL: the pipeline's ledger does not carry it, so
    it is ``None`` for a raw ledger and attribution comes from an explicit
    ``run_id -> arm`` map; a per-arm eval ledger MAY tag each event with its arm,
    in which case attribution can read it straight off the event.
    """

    run_id: str
    phase: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0
    cache_creation_tokens: int = 0
    arm: Optional[str] = None

    @property
    def total_tokens(self) -> int:
        """All four token buckets summed — the phase's full token footprint."""
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_tokens
            + self.cache_creation_tokens
        )

    @property
    def context_tokens(self) -> int:
        """The phase's *context* tokens: prompt input + warm-cache read.

        ``input_tokens + cache_tokens`` — the two buckets that carry injected
        context into the model (fresh prompt bytes and cache-read bytes). Output
        and cache-WRITE are excluded: they are the model's response and the cost
        of seeding the cache, not context handed to the executor.
        """
        return self.input_tokens + self.cache_tokens


def _as_int(value: object) -> int:
    """Coerce a ledger field to an int; non-numeric (or bool) → 0."""
    if isinstance(value, bool):  # bool is an int subclass — never a token count
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def load_cost_events(path: Path) -> List[CostEvent]:
    """Parse a ``cost-events.jsonl`` ledger into :class:`CostEvent` records.

    Tolerant by design (the ledger is append-only + best-effort): a missing file
    yields ``[]``; blank lines and lines that are not a JSON object are skipped;
    an event with no ``run_id``/``phase`` is skipped (it cannot be attributed);
    missing token fields default to 0. Never raises on a torn ledger.
    """
    path = Path(path)
    if not path.is_file():
        return []
    events: List[CostEvent] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(obj, dict):
                continue
            run_id = obj.get("run_id")
            phase = obj.get("phase")
            if not run_id or not phase:
                continue
            arm = obj.get("arm")
            events.append(
                CostEvent(
                    run_id=str(run_id),
                    phase=str(phase),
                    input_tokens=_as_int(obj.get("input_tokens")),
                    output_tokens=_as_int(obj.get("output_tokens")),
                    cache_tokens=_as_int(obj.get("cache_tokens")),
                    cache_creation_tokens=_as_int(obj.get("cache_creation_tokens")),
                    arm=str(arm) if arm else None,
                )
            )
    return events


@dataclass(frozen=True)
class ArmTokenReport:
    """Per-arm token aggregate across every phase of every run for that arm.

    - ``total_tokens`` — all four token buckets summed across ALL phases. The
      "should be ≈ flat with gather ON" number (#1023 AC4): the gather phase adds
      spend but shrinks the executor, so the total should not balloon.
    - ``execute_context_tokens`` — ``input_tokens + cache_tokens`` summed over the
      EXECUTE phase only. The "should drop materially with gather ON" number: the
      manifest replaces the fat pack, so the executor sees less context.
    - ``warm_cache_tokens`` — ``cache_tokens`` summed over the execute+verify
      phases. Cache-HIT evidence for the AC1 byte-stable-manifest warm-cache claim.
    - ``cache_hit`` — ``warm_cache_tokens > 0``: True iff the warm prefix actually
      hit on at least one execute/verify phase (a cold cache reads 0).
    - ``run_count`` — distinct ``run_id``s attributed to this arm (reps × tasks).
    """

    arm: str
    run_count: int
    total_tokens: int
    execute_context_tokens: int
    warm_cache_tokens: int
    cache_hit: bool


def _attribute(
    event: CostEvent, arm_by_run_id: Optional[Mapping[str, str]]
) -> Optional[str]:
    """Resolve an event's arm: explicit map first, else the event's own ``arm``.

    Returns ``None`` when the event cannot be attributed (its run_id is absent
    from the map, or it carries no ``arm``) — such events are dropped from the
    aggregate rather than silently folded into a wrong arm.
    """
    if arm_by_run_id is not None:
        return arm_by_run_id.get(event.run_id)
    return event.arm


def aggregate_gather_tokens(
    events: Sequence[CostEvent],
    *,
    arm_by_run_id: Optional[Mapping[str, str]] = None,
) -> List[ArmTokenReport]:
    """Aggregate ledger events into one :class:`ArmTokenReport` per arm.

    Attribution (see :func:`_attribute`): when ``arm_by_run_id`` is given, an
    event's arm is ``arm_by_run_id[event.run_id]`` (events with an unmapped
    run_id are dropped); otherwise the event's own ``arm`` field is used (events
    with no ``arm`` are dropped). Deterministic: arms are returned sorted by name.
    """
    totals: Dict[str, int] = defaultdict(int)
    execute_context: Dict[str, int] = defaultdict(int)
    warm_cache: Dict[str, int] = defaultdict(int)
    run_ids: Dict[str, Set[str]] = defaultdict(set)

    for event in events:
        arm = _attribute(event, arm_by_run_id)
        if arm is None:
            continue
        totals[arm] += event.total_tokens
        run_ids[arm].add(event.run_id)
        if event.phase == EXECUTE_PHASE:
            execute_context[arm] += event.context_tokens
        if event.phase in WARM_CACHE_PHASES:
            warm_cache[arm] += event.cache_tokens

    return [
        ArmTokenReport(
            arm=arm,
            run_count=len(run_ids[arm]),
            total_tokens=totals[arm],
            execute_context_tokens=execute_context[arm],
            warm_cache_tokens=warm_cache[arm],
            cache_hit=warm_cache[arm] > 0,
        )
        for arm in sorted(totals)
    ]


@dataclass(frozen=True)
class GatherTokenDelta:
    """``full-plus-gather`` vs ``full`` head-to-head on the three AC4 metrics.

    Every delta is ``ON`` (``full-plus-gather``) minus ``OFF`` (``full``) on the
    SAME ledger, so each is falsifiable:

    - ``total_tokens_delta`` — should be ≈ 0 (flat). A large positive delta means
      the gather phase ADDED net tokens instead of trading them.
    - ``execute_context_delta`` — should be NEGATIVE (a material drop). A zero or
      positive delta means the manifest did not shrink the executor's context —
      the layer failed its purpose.
    - ``off_cache_hit`` / ``on_cache_hit`` — the AC1 warm-cache evidence for each
      arm (``cache_tokens > 0`` on execute/verify). Carried per-arm, not deltaed:
      a hit is a boolean fact about each run, not a quantity to subtract.
    """

    off_arm: str
    on_arm: str

    off_total_tokens: int
    on_total_tokens: int
    total_tokens_delta: int

    off_execute_context_tokens: int
    on_execute_context_tokens: int
    execute_context_delta: int

    off_cache_hit: bool
    on_cache_hit: bool
    off_warm_cache_tokens: int
    on_warm_cache_tokens: int

    @property
    def execute_context_dropped(self) -> bool:
        """True iff the gather-ON executor context is strictly below gather-OFF."""
        return self.execute_context_delta < 0


def gather_token_delta(
    reports: Sequence[ArmTokenReport],
    *,
    off_arm: str = GATHER_OFF_ARM,
    on_arm: str = GATHER_ON_ARM,
) -> Optional[GatherTokenDelta]:
    """The ``full-plus-gather`` vs ``full`` delta, or ``None`` when an arm is absent.

    Returns ``None`` (undefined — never a fabricated row) unless BOTH the
    ``full`` and ``full-plus-gather`` arms are present in *reports*. Each delta is
    ``on`` minus ``off``.
    """
    by_arm = {r.arm: r for r in reports}
    off = by_arm.get(off_arm)
    on = by_arm.get(on_arm)
    if off is None or on is None:
        return None
    return GatherTokenDelta(
        off_arm=off_arm,
        on_arm=on_arm,
        off_total_tokens=off.total_tokens,
        on_total_tokens=on.total_tokens,
        total_tokens_delta=on.total_tokens - off.total_tokens,
        off_execute_context_tokens=off.execute_context_tokens,
        on_execute_context_tokens=on.execute_context_tokens,
        execute_context_delta=on.execute_context_tokens - off.execute_context_tokens,
        off_cache_hit=off.cache_hit,
        on_cache_hit=on.cache_hit,
        off_warm_cache_tokens=off.warm_cache_tokens,
        on_warm_cache_tokens=on.warm_cache_tokens,
    )


# ---------------------------------------------------------------------------
# Markdown rendering (honesty rail: an absent ledger renders "not available",
# never a fabricated 0). The section header ALWAYS renders so the report reader
# can see the metric exists and why it is or is not populated.
# ---------------------------------------------------------------------------

_SECTION_TITLE = "# Gather token-reduction + cache-hit (#1049 AC4)"


def _fmt_signed(value: int) -> str:
    return f"{value:+d}"


def render_gather_token_markdown(
    reports: Sequence[ArmTokenReport],
    *,
    delta: Optional[GatherTokenDelta] = None,
) -> str:
    """Render the per-arm token table + the ``full`` vs ``full-plus-gather`` delta.

    ``reports`` is the per-arm aggregate; ``delta`` is the head-to-head (pass the
    :func:`gather_token_delta` output, or leave ``None`` and it is derived from
    *reports*). When the ``full`` / ``full-plus-gather`` pair is absent the delta
    block renders an explicit "not available — needs a live run" note.
    """
    if delta is None:
        delta = gather_token_delta(reports)

    lines: List[str] = []
    lines.append(_SECTION_TITLE)
    lines.append("")
    lines.append(
        "Token evidence for the JIT context gatherer, read from the per-phase "
        "cost ledger (`.agentrail/run/cost-events.jsonl`). TOTAL tokens should be "
        "≈ **flat** with gather ON (the phase trades tokens, it does not add "
        "them); EXECUTE-phase context (`input_tokens + cache_tokens`) should "
        "**drop materially** (the manifest replaces the fat pack); and a warm "
        "**cache-hit** (`cache_tokens > 0` on execute/verify) is the AC1 "
        "byte-stable-manifest evidence."
    )
    lines.append("")

    if not reports:
        lines.append(
            "_Not available: no cost ledger events were supplied. Real numbers "
            "need a live `agentrail evals run --arm full --arm full-plus-gather` "
            "that writes a per-arm cost ledger; the report logic is fixture-verified._"
        )
        lines.append("")
        return "\n".join(lines)

    lines.append(
        "| Arm | Runs | Total tokens | Execute-phase context | Warm-cache tokens "
        "| Cache-hit |"
    )
    lines.append("| --- | ---: | ---: | ---: | ---: | :---: |")
    for r in reports:
        lines.append(
            f"| {r.arm} | {r.run_count} | {r.total_tokens} "
            f"| {r.execute_context_tokens} | {r.warm_cache_tokens} "
            f"| {'yes' if r.cache_hit else 'no'} |"
        )
    lines.append("")

    lines.append("## full vs full-plus-gather")
    lines.append("")
    if delta is None:
        lines.append(
            "_Not available: this ledger does not carry BOTH the `full` and "
            "`full-plus-gather` arms (run `--arm full --arm full-plus-gather` to "
            "populate this)._"
        )
        lines.append("")
        return "\n".join(lines)

    lines.append(
        "Each delta is `full-plus-gather` minus `full` on the SAME ledger. Lower "
        "is better for execute-phase context (a negative delta is the win); total "
        "tokens should stay ≈ flat."
    )
    lines.append("")
    lines.append("| Metric | full | full-plus-gather | Delta (on - off) |")
    lines.append("| --- | ---: | ---: | ---: |")
    lines.append(
        f"| Total tokens | {delta.off_total_tokens} | {delta.on_total_tokens} "
        f"| {_fmt_signed(delta.total_tokens_delta)} |"
    )
    lines.append(
        f"| Execute-phase context | {delta.off_execute_context_tokens} "
        f"| {delta.on_execute_context_tokens} "
        f"| {_fmt_signed(delta.execute_context_delta)} |"
    )
    lines.append(
        f"| Warm-cache tokens (execute+verify) | {delta.off_warm_cache_tokens} "
        f"| {delta.on_warm_cache_tokens} "
        f"| {_fmt_signed(delta.on_warm_cache_tokens - delta.off_warm_cache_tokens)} |"
    )
    lines.append(
        f"| Cache-hit | {'yes' if delta.off_cache_hit else 'no'} "
        f"| {'yes' if delta.on_cache_hit else 'no'} | — |"
    )
    lines.append("")
    verdict = (
        "Executor context DROPPED with gather ON (the layer earns its place)."
        if delta.execute_context_dropped
        else "Executor context did NOT drop with gather ON — FLAGGED: the "
        "manifest did not shrink the executor's context."
    )
    lines.append(f"**{verdict}**")
    lines.append("")
    return "\n".join(lines)


def render_gather_report_from_ledger(
    ledger_path: Optional[Path],
    *,
    arm_by_run_id: Optional[Mapping[str, str]] = None,
) -> str:
    """End-to-end: read a ledger path and render the markdown section.

    The convenience the spine wires in. A ``None`` / missing / empty ledger
    renders the honest "not available — needs a live run" note (never a fake 0),
    so the section is ALWAYS present in the report and self-explains why it is or
    is not populated.
    """
    events = load_cost_events(ledger_path) if ledger_path is not None else []
    reports = aggregate_gather_tokens(events, arm_by_run_id=arm_by_run_id)
    return render_gather_token_markdown(reports)


# ---------------------------------------------------------------------------
# Precision half (#1049 AC4) — "did the gatherer point at the RIGHT files?"
#
# The token half above answers "did gather shrink the executor's context?". This
# half answers the OTHER half of AC4: precision/recall of the gatherer's picks
# against each task's ``requiredContext`` answer key. Unlike the token half (which
# round-trips a cost ledger file), these scores are already computed per-run and
# attached to ``RunRecord.gather_score`` by the runner — so this reads them
# straight from the in-memory records the spine collected. Pure arithmetic; the
# only "IO" is iterating records.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ArmPrecisionReport:
    """Per-arm POOLED gather file-picking accuracy over a run of the eval.

    Pooled (micro-averaged), NOT a mean of per-run ratios: a mean would weight a
    task with 1 required file the same as one with 20. So we sum the raw counts
    across every scored run in the arm and divide ONCE — the honest aggregate.

    - ``run_count`` — scored runs in this arm (records whose gatherer produced a
      manifest; runs where gather did not run are absent, never counted as 0).
    - ``total_intersection`` / ``total_selected`` / ``total_required`` — summed
      correct picks / total picks / total answer-key files across those runs.
    - ``precision`` — ``total_intersection / total_selected``; ``None`` when the
      arm's gatherers selected nothing at all (0/0 undefined, never a fake 0.0).
    - ``recall`` — ``total_intersection / total_required``; a real value (incl.
      ``0.0``) whenever the arm has ≥1 scored run (answer keys are non-empty).
    """

    arm: str
    run_count: int
    total_intersection: int
    total_selected: int
    total_required: int
    precision: Optional[float]
    recall: Optional[float]

    @property
    def meets_ac4(self) -> bool:
        """True iff this arm's pooled score clears BOTH AC4 floors."""
        return (
            self.precision is not None
            and self.recall is not None
            and self.precision >= AC4_PRECISION_FLOOR
            and self.recall >= AC4_RECALL_FLOOR
        )


def aggregate_gather_precision(
    records: Sequence["RunRecord"],
) -> List[ArmPrecisionReport]:
    """Pool per-run gather scores into one :class:`ArmPrecisionReport` per arm.

    Only records whose ``gather_score`` is set contribute — a ``None`` score means
    the gatherer did not run that arm, which is EXCLUDED (never folded in as a
    zero). Arms are returned sorted by name for a deterministic report.
    """
    inter: Dict[str, int] = defaultdict(int)
    selected: Dict[str, int] = defaultdict(int)
    required: Dict[str, int] = defaultdict(int)
    runs: Dict[str, int] = defaultdict(int)

    for rec in records:
        score = getattr(rec, "gather_score", None)
        if score is None:
            continue
        arm = rec.arm
        runs[arm] += 1
        inter[arm] += score.intersection
        selected[arm] += len(score.selected_paths)
        required[arm] += len(score.required_paths)

    reports: List[ArmPrecisionReport] = []
    for arm in sorted(runs):
        tot_sel = selected[arm]
        tot_req = required[arm]
        reports.append(
            ArmPrecisionReport(
                arm=arm,
                run_count=runs[arm],
                total_intersection=inter[arm],
                total_selected=tot_sel,
                total_required=tot_req,
                precision=(inter[arm] / tot_sel) if tot_sel > 0 else None,
                recall=(inter[arm] / tot_req) if tot_req > 0 else None,
            )
        )
    return reports


_PRECISION_SECTION_TITLE = "# Gather file-picking precision (#1049 AC4)"


def _fmt_ratio(value: Optional[float]) -> str:
    """Two-decimal ratio, or ``n/a`` for an undefined (``None``) score."""
    return "n/a" if value is None else f"{value:.2f}"


def render_gather_precision_markdown(
    reports: Sequence[ArmPrecisionReport],
) -> str:
    """Render the per-arm precision/recall table + the AC4 pass/fail verdict.

    The verdict reads the gather arm (``full-plus-gather``): it PASSES when that
    arm's pooled precision ≥ 0.7 AND recall ≥ 0.85. With no scored gather runs the
    section renders an explicit "not available — needs a live run" note (never a
    fabricated 0), so the section is ALWAYS present and self-explains its state.
    """
    lines: List[str] = []
    lines.append(_PRECISION_SECTION_TITLE)
    lines.append("")
    lines.append(
        "Did the JIT gatherer point at the RIGHT files? Each gather run's CONTEXT "
        "MANIFEST picks (the union of its \"Relevant files:\" and \"Pinned "
        "symbols:\" sections) are scored against the task's `requiredContext` "
        "answer key, then POOLED per arm. AC4 (#1023) requires the gather arm to "
        f"reach **precision ≥ {AC4_PRECISION_FLOOR:.2f} at recall ≥ "
        f"{AC4_RECALL_FLOOR:.2f}**."
    )
    lines.append("")

    if not reports:
        lines.append(
            "_Not available: no run carried a gather score. Real numbers need a "
            "live `agentrail evals run --arm full-plus-gather` (the gather arm "
            "writes a CONTEXT MANIFEST the runner scores); the scoring logic is "
            "fixture-verified._"
        )
        lines.append("")
        return "\n".join(lines)

    lines.append(
        "| Arm | Gather runs | Precision | Recall | Correct picks | Selected "
        "| Required |"
    )
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for r in reports:
        lines.append(
            f"| {r.arm} | {r.run_count} | {_fmt_ratio(r.precision)} "
            f"| {_fmt_ratio(r.recall)} | {r.total_intersection} "
            f"| {r.total_selected} | {r.total_required} |"
        )
    lines.append("")

    on = next((r for r in reports if r.arm == GATHER_ON_ARM), None)
    if on is None:
        lines.append(
            f"_AC4 verdict not available: this run has no `{GATHER_ON_ARM}` arm "
            f"(run `--arm {GATHER_ON_ARM}` to populate it)._"
        )
        lines.append("")
        return "\n".join(lines)

    if on.meets_ac4:
        verdict = (
            f"Gatherer CLEARS AC4: pooled precision {_fmt_ratio(on.precision)} "
            f"(≥ {AC4_PRECISION_FLOOR:.2f}) at recall {_fmt_ratio(on.recall)} "
            f"(≥ {AC4_RECALL_FLOOR:.2f}) on `{on.arm}` — it points at the right files."
        )
    else:
        verdict = (
            f"Gatherer MISSES AC4 — FLAGGED: pooled precision "
            f"{_fmt_ratio(on.precision)} / recall {_fmt_ratio(on.recall)} on "
            f"`{on.arm}` does not clear precision ≥ {AC4_PRECISION_FLOOR:.2f} at "
            f"recall ≥ {AC4_RECALL_FLOOR:.2f}. Do NOT turn the gather flag on."
        )
    lines.append(f"**{verdict}**")
    lines.append("")
    return "\n".join(lines)


def render_gather_precision_from_records(
    records: Sequence["RunRecord"],
) -> str:
    """End-to-end: pool the records' gather scores and render the markdown section.

    The convenience the spine wires in, paired with
    :func:`render_gather_report_from_ledger` for the token half. Records without a
    gather score contribute nothing; an all-empty input renders the honest "not
    available — needs a live run" note (never a fake 0).
    """
    return render_gather_precision_markdown(aggregate_gather_precision(records))


__all__ = [
    "EXECUTE_PHASE",
    "WARM_CACHE_PHASES",
    "GATHER_OFF_ARM",
    "GATHER_ON_ARM",
    "CostEvent",
    "load_cost_events",
    "ArmTokenReport",
    "aggregate_gather_tokens",
    "GatherTokenDelta",
    "gather_token_delta",
    "render_gather_token_markdown",
    "render_gather_report_from_ledger",
    # Precision half (#1049 AC4) — "did the gatherer pick the RIGHT files?"
    "AC4_PRECISION_FLOOR",
    "AC4_RECALL_FLOOR",
    "ArmPrecisionReport",
    "aggregate_gather_precision",
    "render_gather_precision_markdown",
    "render_gather_precision_from_records",
]
