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


# The explicit reason recorded on a GatherScore when NONE of the task's oracle
# entries exist at the pre-fix checkout the gatherer saw (oracle fairness): the
# run is UNGRADEABLE, so precision/recall are None — never a fabricated 0.
# "At checkout" is meant literally: the runner resolves existence from the
# clone's git tree at the task's PINNED commit (``task.commit``), not from the
# post-run working tree (which carries the agent's fix by scoring time); a
# filesystem check is only the fallback for a non-git tree. Single-sourced here
# so the runner (which stamps it) and the report/tests (which recognize it) can
# never drift on the literal.
NO_GRADEABLE_ORACLE_REASON = "no gradeable oracle at checkout"


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
class GatherScore:
    """The JIT gather phase's file-picking accuracy for ONE run (#1049 AC4).

    The gather phase (when the arm enables it) runs a cheap read-only subagent
    that reconnoiters the repo and emits a CONTEXT MANIFEST naming the files it
    judged relevant. This dataclass scores those picks against the corpus task's
    ``requiredContext`` answer key — the precision half of AC4 ("precision >= 0.7
    at recall >= 0.85"): did the gatherer point at the RIGHT files?

    **Oracle fairness.** The gatherer sees the task's PRE-FIX checkout, but
    ``requiredContext`` names the files the FIX touches — some of which may not
    exist yet at that checkout, making them structurally unpickable. So the
    runner grades against a FAIR oracle: ``readContext`` (the read-time answer
    key) when the task declares one, else ``requiredContext``, and then keeps
    only the entries that actually EXIST at the task's pinned checkout.
    Existence is resolved from the clone's git tree at ``task.commit`` — NOT
    from the post-run working tree, which by scoring time carries the agent's
    fix (so a fix-created file would look present and a fix-deleted file would
    look absent, both wrong); a filesystem check is only the fallback for a
    non-git tree. The entries filtered away are recorded
    (``dropped_oracle_paths``) so any past run can be re-graded offline without
    re-running anything.

    - ``selected_paths`` — the repo-relative paths the gatherer picked (the union
      of the manifest's "Relevant files:" and "Pinned symbols:" sections, sorted
      and de-duplicated). The RAW picks, never filtered. May be empty when the
      gatherer ran but ruled everything out.
    - ``required_paths`` — the FILTERED oracle the run was actually graded
      against (sorted): the task's ``readContext``-else-``requiredContext``
      answer key, existence-filtered at checkout. Captured alongside so the
      report can pool per-run scores WITHOUT re-reading the corpus. Empty iff
      the run is ungradeable (see ``ungraded_reason``).
    - ``dropped_oracle_paths`` — the oracle entries dropped by the existence
      filter (sorted): files absent from the pinned checkout's git tree
      (typically files the FIX produces), which no gatherer could have picked.
      Persisted per run so past runs re-grade for free.
    - ``ungraded_reason`` — ``None`` for a graded run; the explicit
      :data:`NO_GRADEABLE_ORACLE_REASON` when the existence filter emptied the
      oracle entirely. Such a score carries ``precision is None`` AND
      ``recall is None`` — clearly distinguishable from BOTH "gatherer did not
      run" (``RunRecord.gather_score is None``) and "gatherer picked nothing"
      (``precision is None`` but ``recall`` is a real ``0.0``).
    - ``intersection`` — ``|selected ∩ required|``, the count of correct picks.
      Carried explicitly so the report can compute a POOLED precision/recall
      (``sum(intersection) / sum(len(selected))`` etc.) rather than averaging
      per-run ratios, which would over-weight tasks with few required files.
    - ``precision`` — ``intersection / len(selected)``; ``None`` when the gatherer
      selected nothing (0/0 is undefined — never a fabricated ``0.0``), or when
      the run is ungradeable.
    - ``recall`` — ``intersection / len(required)``; a REAL ``0.0`` when the
      gatherer ran and found none of the (gradeable) oracle files; ``None`` only
      when the run is ungradeable (the filtered oracle is empty — 0/0).

    Note the None-vs-0.0 discipline the whole harness keeps: this object exists
    ONLY when the gatherer actually produced a manifest. A ``full`` arm with no
    gather phase carries ``RunRecord.gather_score = None`` — "the gatherer did not
    run", categorically different from "it ran and picked nothing" (which is a
    real ``recall == 0.0`` recorded here). Immutable so a scored run cannot be
    mutated into different picks after the fact.
    """

    precision: Optional[float]
    recall: Optional[float]
    selected_paths: List[str]
    required_paths: List[str]
    intersection: int
    # Oracle-fairness fields — APPENDED last to preserve positional back-compat.
    # ``dropped_oracle_paths`` records what the existence filter removed (files
    # the fix produces); ``ungraded_reason`` marks a run whose filtered oracle
    # came up empty (see :data:`NO_GRADEABLE_ORACLE_REASON`).
    dropped_oracle_paths: List[str] = field(default_factory=list)
    ungraded_reason: Optional[str] = None

    @property
    def gradeable(self) -> bool:
        """True iff this run's picks were graded against a non-empty oracle.

        Ungradeable scores (``ungraded_reason`` set / empty ``required_paths``)
        must be EXCLUDED from pooled aggregates — folding them in as zeros would
        recreate exactly the measurement artifact the existence filter removes.
        """
        return self.ungraded_reason is None and bool(self.required_paths)


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

    Gather file-picking accuracy (#1049 AC4 — the precision half, measurement
    only):

    - ``gather_score`` — a :class:`GatherScore` scoring the gather phase's
      CONTEXT MANIFEST (the files it judged relevant) against the task's FAIR
      oracle (``readContext`` when declared, else ``requiredContext``,
      existence-filtered to what exists at the checkout the gatherer saw):
      precision/recall of the picks, harvested by the runner from the sandbox
      BEFORE teardown. ``None`` when the gatherer did
      not run this arm (no manifest was produced) — categorically different from
      a manifest that selected nothing, which is recorded as a real
      ``recall == 0.0`` inside the score. This is the ONLY signal that answers
      "did the JIT gatherer point at the RIGHT files?"; the cost half above
      answers "did it shrink the executor's context?" — AC4 needs both.

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
    # Gather file-picking accuracy (#1049 AC4, precision half) — APPENDED last to
    # preserve positional back-compat. ``None`` when the gatherer did not run this
    # arm (no manifest); a real 0.0-recall score when it ran and missed. Built
    # once by the runner from the harvested manifest and never mutated after.
    gather_score: Optional[GatherScore] = None

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
