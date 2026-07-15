"""Memory-lane token-delta report — before/after onboarding token effect.

The measurement half of the shared-memory / factory memory-lane workstream
(#1039/#1071): the falsifiable EVIDENCE of what injecting the workspace memory
lane into context packs does to a run's token spend. It answers ONE question:

    With the memory lane OFF vs ON, does the per-run token total move — and in
    which direction?

The intended story is that an onboarded workspace (memory lane ON) carries prior
context into the pack, so the agent re-discovers less and the run's token total
comes back LOWER than the memory-lane-OFF baseline. This module measures that
before/after by diffing the per-run token totals between the two arms.

It does NOT run the eval and it invents no numbers: it reduces the SAME per-phase
cost ledger a run already emits (``.agentrail/run/cost-events.jsonl`` — one JSON
line per phase from :func:`agentrail.run.cost_push.build_cost_record`, carrying
``run_id``/``phase``/``input_tokens``/``output_tokens``/``cache_tokens``/
``cache_creation_tokens``). Each event is attributed to an arm either by an
explicit ``run_id -> arm`` map or by an ``arm`` field carried on the event.

This is a near-copy of :mod:`agentrail.evals.gather_report`'s TOKEN half (the
proven "feature OFF vs ON, diff the tokens" reduction for the JIT gatherer),
adapted to the memory lane and written to be arm-name-agnostic: the caller passes
the off/on arm names, exactly like ``gather_token_delta`` takes ``off_arm`` /
``on_arm``. The truth-critical token-field summation is IDENTICAL to gather's —
it reuses gather_report's :class:`CostEvent` (``total_tokens`` = all four buckets,
``context_tokens`` = ``input_tokens + cache_tokens``) rather than re-deriving it,
so the two reports can never drift apart on what "tokens" means.

Design rules (mirroring gather_report / :mod:`agentrail.evals.probes`):

- **Pure arithmetic over the ledger.** No sandbox, no network. The only IO is
  :func:`load_cost_events` (reused from gather_report) reading the ledger file;
  everything else is a pure function of the parsed events, trivially
  fixture-testable (no real agent run).
- **Tolerant parse.** Inherited from gather_report's :func:`load_cost_events`:
  blank/malformed lines skipped, missing token fields default to 0, a torn
  ledger never crashes the report.
- **Honest, never fabricated.** With no ledger (or no OFF/ON pair in it) the
  head-to-head is ``None`` — never a fake 0.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence, Set

# Reuse gather_report's proven ledger primitives rather than duplicating them:
# the cost-ledger line shape and the token-field summation MUST stay identical
# across the two reports (both read the same ``cost-events.jsonl``), so importing
# them is the single source of truth for "what is a token". ``EXECUTE_PHASE`` is
# imported for the same reason — the executor phase both layers isolate.
from agentrail.evals.gather_report import (
    EXECUTE_PHASE,
    CostEvent,
    load_cost_events,
)

# The A/B pair this report exists to compare. The memory lane is a BASE layer
# (on in production by default), so the ON arm is the plain ``full`` pipeline and
# the OFF arm is ``full`` with the lane ablated — ``full-minus-memory_lane`` (the
# name ``full_minus("memory_lane")`` produces, matching the eval arm wiring).
# These are DEFAULTS only — :func:`memory_lane_token_delta` takes ``off_arm`` /
# ``on_arm`` so any A/B pair of arm names works (the report is arm-name-agnostic).
MEMORY_LANE_OFF_ARM = "full-minus-memory_lane"
MEMORY_LANE_ON_ARM = "full"


@dataclass(frozen=True)
class MemoryArmTokenReport:
    """Per-arm token aggregate across every phase of every run for that arm.

    - ``total_tokens`` — all four token buckets (input + output + cache +
      cache_creation) summed across ALL phases of ALL runs in the arm. The
      headline before/after number: memory-lane ON should come back LOWER.
    - ``execute_context_tokens`` — ``input_tokens + cache_tokens`` summed over the
      EXECUTE phase only. The memory lane is injected into the context pack, so
      the executor's *context* is exactly where a shift shows up; carried as the
      auditable secondary signal (mirrors how gather_report isolates a phase).
    - ``run_count`` — distinct ``run_id``s attributed to this arm (reps × tasks).
    """

    arm: str
    run_count: int
    total_tokens: int
    execute_context_tokens: int


def _attribute(
    event: CostEvent, arm_by_run_id: Optional[Mapping[str, str]]
) -> Optional[str]:
    """Resolve an event's arm: explicit map first, else the event's own ``arm``.

    Same rule as gather_report's attribution: returns ``None`` when the event
    cannot be attributed (its run_id is absent from the map, or it carries no
    ``arm``) — such events are dropped rather than folded into a wrong arm.
    """
    if arm_by_run_id is not None:
        return arm_by_run_id.get(event.run_id)
    return event.arm


def aggregate_memory_tokens(
    events: Sequence[CostEvent],
    *,
    arm_by_run_id: Optional[Mapping[str, str]] = None,
) -> List[MemoryArmTokenReport]:
    """Aggregate ledger events into one :class:`MemoryArmTokenReport` per arm.

    Attribution (see :func:`_attribute`): when ``arm_by_run_id`` is given, an
    event's arm is ``arm_by_run_id[event.run_id]`` (events with an unmapped
    run_id are dropped); otherwise the event's own ``arm`` field is used (events
    with no ``arm`` are dropped). The token summation is delegated to
    :class:`CostEvent` (``total_tokens`` / ``context_tokens``), so it is byte-for-
    byte the same arithmetic gather_report uses. Deterministic: arms are returned
    sorted by name.
    """
    totals: Dict[str, int] = defaultdict(int)
    execute_context: Dict[str, int] = defaultdict(int)
    run_ids: Dict[str, Set[str]] = defaultdict(set)

    for event in events:
        arm = _attribute(event, arm_by_run_id)
        if arm is None:
            continue
        totals[arm] += event.total_tokens
        run_ids[arm].add(event.run_id)
        if event.phase == EXECUTE_PHASE:
            execute_context[arm] += event.context_tokens

    return [
        MemoryArmTokenReport(
            arm=arm,
            run_count=len(run_ids[arm]),
            total_tokens=totals[arm],
            execute_context_tokens=execute_context[arm],
        )
        for arm in sorted(totals)
    ]


@dataclass(frozen=True)
class MemoryLaneTokenDelta:
    """OFF vs ON head-to-head on the same ledger, with the saving stated both ways.

    Every per-arm total is carried so the delta is fully auditable back to its
    inputs. Two views of the same shift are exposed on purpose:

    - ``total_tokens_delta`` — ``on_total - off_total`` (ON minus OFF, matching
      gather_report's delta convention). NEGATIVE means the memory lane reduced
      tokens.
    - ``tokens_saved_by_lane`` — ``off_total - on_total`` (the same magnitude,
      flipped). POSITIVE means the memory lane reduced tokens — the direction the
      onboarding story predicts. This is the headline before/after number.

    (``tokens_saved_by_lane == -total_tokens_delta`` by construction; both are
    carried so a reader never has to negate in their head.) The execute-phase
    context pair is the auditable secondary signal.
    """

    off_arm: str
    on_arm: str

    off_run_count: int
    on_run_count: int

    off_total_tokens: int
    on_total_tokens: int
    total_tokens_delta: int
    tokens_saved_by_lane: int

    off_execute_context_tokens: int
    on_execute_context_tokens: int
    execute_context_delta: int
    execute_context_saved_by_lane: int

    @property
    def lane_reduced_tokens(self) -> bool:
        """True iff the memory-lane-ON total is strictly below the OFF baseline."""
        return self.tokens_saved_by_lane > 0


def memory_lane_token_delta(
    reports: Sequence[MemoryArmTokenReport],
    *,
    off_arm: str = MEMORY_LANE_OFF_ARM,
    on_arm: str = MEMORY_LANE_ON_ARM,
) -> Optional[MemoryLaneTokenDelta]:
    """The memory-lane OFF vs ON delta, or ``None`` when an arm is absent.

    Arm-name-agnostic: the caller names the OFF and ON arms (defaults are the
    lane-off ``full-minus-memory_lane`` and lane-on ``full`` arms). Returns
    ``None`` — undefined, never a fabricated row — unless BOTH named arms are
    present in *reports*.

    Deltas are stated both ways: ``total_tokens_delta`` is ``on - off`` (ON minus
    OFF, gather_report's convention; negative = the lane helped) and
    ``tokens_saved_by_lane`` is ``off - on`` (positive = the lane reduced tokens),
    with per-arm totals carried so the number is auditable.
    """
    by_arm = {r.arm: r for r in reports}
    off = by_arm.get(off_arm)
    on = by_arm.get(on_arm)
    if off is None or on is None:
        return None
    return MemoryLaneTokenDelta(
        off_arm=off_arm,
        on_arm=on_arm,
        off_run_count=off.run_count,
        on_run_count=on.run_count,
        off_total_tokens=off.total_tokens,
        on_total_tokens=on.total_tokens,
        total_tokens_delta=on.total_tokens - off.total_tokens,
        tokens_saved_by_lane=off.total_tokens - on.total_tokens,
        off_execute_context_tokens=off.execute_context_tokens,
        on_execute_context_tokens=on.execute_context_tokens,
        execute_context_delta=(
            on.execute_context_tokens - off.execute_context_tokens
        ),
        execute_context_saved_by_lane=(
            off.execute_context_tokens - on.execute_context_tokens
        ),
    )


__all__ = [
    "EXECUTE_PHASE",
    "MEMORY_LANE_OFF_ARM",
    "MEMORY_LANE_ON_ARM",
    # Re-exported from gather_report so the memory reducer is a one-import surface.
    "CostEvent",
    "load_cost_events",
    "MemoryArmTokenReport",
    "aggregate_memory_tokens",
    "MemoryLaneTokenDelta",
    "memory_lane_token_delta",
]
