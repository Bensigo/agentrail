"""The canonical **RunRecord** contract for the eval spine (issue #936).

A ``RunRecord`` is the raw, immutable result of executing one ``(task, arm)``
pair: what the agent produced and what the harness observed about that run. It
is the seam between the *runner* (issue #937), which PRODUCES it inside the
sandbox, and the *scorer* (``agentrail.evals.scorer``), which CONSUMES it
together with the task's hidden-test result to produce a verdict.

Position in the spine (PRD §"Single shared spine, many probes")::

    corpus -> arm runner -> [RunRecord] -> scorer -> repetition -> reporter

This module owns the contract on purpose: a single typed shape that the runner
must satisfy and the CLI spine (#938) populates, so the scorer's inputs are
fixed and its tests are airtight.

Design rules (kept deliberately strict so the contract cannot drift):

- **Pure data, no IO.** Constructing or inspecting a ``RunRecord`` runs no
  subprocess, sandbox, or network. The record describes a run; it does not
  perform one. This is asserted by the scorer's purity tests.
- **It carries observations, not verdicts.** The crucial field is
  ``gate_passed`` — the run's *own* **Objective Gate** decision (CONTEXT.md: the
  falsifiable "done" signal the run used to decide it was finished). It is NOT
  the eval verdict. The eval verdict is defined SOLELY by the hidden tests
  (computed by the scorer), and the gap between the two is the *false-green*
  rate the harness exists to measure. A ``RunRecord`` therefore never carries a
  ``solved`` field — that would invite conflating the gate with ground truth.
- **Usage is the production ``Usage`` shape.** ``usage`` is the same dataclass
  the live runner captures (``agentrail.run.usage_capture.Usage``) and the same
  shape ``agentrail.run.pricing.cost_usd`` prices, so eval dollars never drift
  from production dollars (CONTEXT.md single-source pricing rail).

The token-usage / model / wall-time / retry fields are recorded for the
*reporter* and for later probe slices (routing regret, retry lift). The scorer
in this slice reads only ``gate_passed`` (and treats everything else as opaque
payload), but the contract carries them now so #937/#938 have a stable target.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from agentrail.run.usage_capture import Usage


@dataclass(frozen=True)
class RetryEvent:
    """One retry/escalation event observed during a run.

    The retry loop (and model escalation) is a queue transition in production
    (CONTEXT.md **Issue Queue**): a failed attempt re-runs, optionally at a
    higher tier/model. Each attempt the harness observed is one of these, so a
    later slice can measure retry lift and wasted-retry cost without changing
    this contract.

    - ``attempt`` is the 1-based attempt index this event represents.
    - ``model`` is the model used for that attempt (escalation changes it).
    - ``gate_passed`` is that attempt's own Objective Gate decision.
    - ``reason`` is a short, free-form note (e.g. ``"gate red"`,
      ``"escalation"``) — advisory only, never parsed for the verdict.
    """

    attempt: int
    model: str
    gate_passed: bool
    reason: str = ""


@dataclass(frozen=True)
class RunRecord:
    """The raw result of one ``(task, arm)`` run — the runner's output contract.

    Carries everything downstream stages need while remaining pure data:

    - ``task`` / ``arm`` — which corpus task and which arm produced this run.
    - ``diff`` — the unified diff the agent produced (the change under test). May
      be empty when the agent produced nothing; the scorer does not inspect it
      (the hidden tests do, externally).
    - ``model`` — the (final) model the run resolved to / was pinned at.
    - ``usage`` — token usage, the production ``Usage`` shape, priced through the
      single-source pricer by the reporter.
    - ``wall_time_s`` — wall-clock duration of the run, in seconds.
    - ``gate_passed`` — the run's OWN **Objective Gate** decision. NOT the eval
      verdict. ``True`` means the run believed itself done (tests/build/lint +
      AC passed under the arm's own gate); the scorer compares this against the
      hidden-test ground truth to detect a false-green.
    - ``retries`` — the retry/escalation events observed, oldest first. Empty
      when the run succeeded (or failed) on the first attempt.

    Diagnostic fields (added in #994 so a failed run is *diagnosable* — before
    this, a non-solved run carried no reason and no context-quality signal, so
    every failure in the report was opaque). All are optional with ``None``
    defaults so existing positional callers/tests construct records unchanged,
    and ``None`` (undefined / not captured) stays distinct from a real ``0.0``:

    - ``gate_failure_reason`` — a short, human-readable note on WHY the run's
      Objective Gate did not pass (e.g. ``"tests didn't pass / gate red"``,
      ``"run errored"``, ``"no diff"``). ``None`` when the gate passed or when
      no reason was captured. Advisory only — never parsed for the verdict.
    - ``precision_at_budget`` / ``citation_coverage`` — the context-pack quality
      metrics (``agentrail.context.pack_quality.compute_pack_quality``) for the
      run's retrieval. ``None`` when not captured by the executor (the live
      sandbox executor does not yet surface them — see the TODO in
      ``runner.SandboxAgentExecutor.execute``).

    Routing-audit field (Finding 4 — measurement only, no live-loop change):

    - ``baseline_model`` — the DEFAULT/baseline model this run would have used had
      the routing layer NOT acted: the arm's pinned model (``arm.model``). The
      routing layer "diverged" on this run iff ``final_model != baseline_model``.
      Recording the baseline explicitly (rather than re-deriving it from the arm
      name in the report) lets the audit attribute the routing $-delta — what
      routing's model choice cost or saved relative to the baseline model — and,
      crucially, state explicitly when routing NEVER diverged ("had no chance to
      act"). ``None`` when not captured (old records / executors that don't
      surface it) — distinct from a captured baseline that happens to equal the
      final model.

    Per-phase cost evidence (#1049 AC4 — measurement only):

    - ``cost_events`` — the raw per-phase cost-ledger lines the run's pipeline
      wrote inside its sandbox (``.agentrail/run/cost-events.jsonl``), harvested
      by the runner BEFORE the sandbox tempdir is torn down. Each entry is one
      ``build_cost_record`` dict (``run_id``, ``phase``, and the four token
      buckets). This is the ONLY place the per-PHASE split survives the run —
      ``usage`` above is the aggregated total, which cannot answer "did the
      EXECUTE phase's context shrink?". The gather report aggregates these into
      the AC4 token-reduction + cache-hit evidence. Empty list when the executor
      wrote no ledger (e.g. a network-artifact ``<synthetic>`` fallback) or the
      harvest was skipped — distinct from "captured and zero".

    Immutability is enforced (``frozen=True``) so a record handed to the scorer
    cannot be mutated into a different verdict after the fact.
    """

    task: str
    arm: str
    diff: str
    model: str
    usage: Usage
    wall_time_s: float
    gate_passed: bool
    retries: List[RetryEvent] = field(default_factory=list)
    # Diagnostic fields (#994) — Optional/None defaults preserve positional
    # back-compat; None stays distinct from 0.0 (undefined vs. measured-zero).
    gate_failure_reason: Optional[str] = None
    precision_at_budget: Optional[float] = None
    citation_coverage: Optional[float] = None
    # Routing-audit field (Finding 4) — APPENDED last to preserve positional
    # back-compat; None when not captured (distinct from "captured and equal").
    baseline_model: Optional[str] = None
    # Per-phase cost evidence (#1049 AC4) — APPENDED last to preserve positional
    # back-compat; empty list when no ledger was harvested. Not frozen-hostile:
    # the list is built once by the runner and never mutated after construction.
    cost_events: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def attempts(self) -> int:
        """Number of attempts the run made (>= 1).

        One implicit first attempt plus one per recorded retry event. Useful for
        the retry-lift probe in a later slice; never used by the verdict.
        """
        return 1 + len(self.retries)

    @property
    def final_model(self) -> str:
        """The model of the last attempt (post-escalation), falling back to ``model``."""
        if self.retries:
            return self.retries[-1].model
        return self.model
