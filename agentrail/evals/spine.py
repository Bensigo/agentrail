"""Eval **spine** — drive corpus -> runner -> hidden-test scorer -> reporter (issue #938).

Position in the harness (PRD §"Single shared spine, many probes")::

    corpus -> arm runner -> [RunRecord]
                              |
                              v
                      hidden-test runner ---> hidden_tests_passed
                              |
                              v
                          scorer ---> Verdict
                              |
                              v
                      RepetitionRecord  (N reps per (task, arm))
                              |
                              v
                          reporter

This module owns ONE thing only: the temporal/spatial choreography that ties
the already-built pieces (``corpus.loader``, ``runner``, ``scorer``, ``reporter``)
together honestly. It writes no new contracts — every type it touches
(``CorpusTask``, ``Arm``, ``RunRecord``, ``Verdict``, ``RepetitionRecord``) is
imported from its canonical home.

## The anti-false-green guard at THIS layer (AC2)

The runner already enforces "no answer-key file inside the agent's sandbox
workdir" before AND after ``executor.execute`` (see
``agentrail.evals.runner._assert_no_answer_key_in_workdir``). That is the
SPATIAL half of AC2.

The spine adds the TEMPORAL half. It guarantees, by structure:

1. ``runner.run(...)`` returns *fully* before any hidden-test code path is
   reached for that repetition.  Hidden-test execution happens in a SEPARATE
   step, sequenced after the runner's tempdir teardown.
2. The hidden-test runner is the ONLY caller that may touch
   ``task.hidden_test_paths``; it is a tiny injectable seam
   (``HiddenTestRunner`` protocol) so unit tests can prove the contract with a
   faithful fake.
3. The hidden-test runner is given an ISOLATED workspace separate from the
   agent's run workdir.  Even if a defective production hidden-test runner
   tried to materialize the answer key, it would do so in a different tempdir
   than the agent saw, after the agent's tempdir has been destroyed.

The result is two non-overlapping windows on the timeline:

    [ runner.run -> executor.execute(workdir A) -> teardown(workdir A) ]
                                                          |
                                                 (returns RunRecord)
                                                          |
                                            [ hidden-test runner: workspace B
                                              copies answer key here, executes,
                                              returns bool ]

The agent and the answer key are never co-located in space (AC3) and never
co-resident in time (AC2). Unit tests in ``tests/evals/test_spine.py`` assert
both halves: a spy on the runner's executor records the workdir+contents at
``execute``-time and proves the answer key was absent; the
``HiddenTestRunner`` fake records its own invocation order and proves it ran
strictly AFTER the runner returned.
"""

from __future__ import annotations

import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date as _date
from pathlib import Path
from typing import Callable, List, Optional, Protocol, Sequence, Tuple

# Canonical contracts — imported, never redefined here (anti-false-green rule).
from agentrail.evals.arms import Arm, baseline, full, full_minus
from agentrail.evals.corpus.loader import CorpusTask, load_corpus
from agentrail.evals.reporter import (
    ArmReport,
    HttpMetricsWriter,
    MetricsWriter,
    RepetitionRecord,
    aggregate,
    default_reports_dir,
    write_markdown_report,
    write_reports,
)
from agentrail.evals.probes import (
    ScoredRun,
    guardrail_catch_rate,
    retry_lift,
    routing_cost_regret,
)
from agentrail.evals.reporter import render_probes_markdown
from agentrail.evals.run_record import RunRecord
from agentrail.evals.runner import AgentExecutor, SandboxAgentExecutor, run
from agentrail.evals.scorer import Verdict, score


# ---------------------------------------------------------------------------
# Hidden-test execution seam — the *only* place answer-key files may be read.
# ---------------------------------------------------------------------------


class HiddenTestRunner(Protocol):
    """Execute a task's hidden tests against an agent-produced run.

    By contract, this is called STRICTLY AFTER the runner has returned a
    :class:`RunRecord` for the same repetition. Implementations:

    1. Copy / materialize the hidden test files (``task.hidden_test_paths``)
       into a workspace that is SEPARATE from the agent's run workdir (already
       torn down by the runner). The workspace is the implementation's
       responsibility; the spine does not share its directory with the runner.
    2. Execute the hidden tests against the agent's produced diff (which the
       runner returns on the :class:`RunRecord`) and return a REAL ``bool``
       (``True`` for all-passed, ``False`` otherwise).

    The implementation MUST NOT mutate the ``RunRecord`` or any file inside the
    runner's (already-destroyed) workdir.
    """

    def run_hidden_tests(self, *, task: CorpusTask, run_record: RunRecord) -> bool:
        ...  # pragma: no cover - Protocol body


class UnimplementedHiddenTestRunner:
    """Default production seam — refuses to falsely persist a green.

    A real hidden-test harness needs a sandbox capable of applying the agent's
    diff to the task repo at the pinned commit and running the answer key
    against it. That sandbox wiring belongs to its own slice (a follow-up to
    #938: the spine ships the seam, not the prod runner). Returning ``True``
    here would be a false-green; returning ``False`` is the honest default.
    """

    def run_hidden_tests(self, *, task: CorpusTask, run_record: RunRecord) -> bool:
        # Honest no-op: cannot determine ground truth without a sandbox. False
        # = "not solved" — the safe direction (never claim a green we cannot
        # prove). Real ``bool`` (the scorer review nit).
        return False


# ---------------------------------------------------------------------------
# Spine configuration + orchestrator
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SpineConfig:
    """Inputs to one spine run. Pure data; no IO."""

    arms: Sequence[Arm]
    reps: int
    task_filter: Optional[Sequence[str]] = None  # None == all tasks
    corpus_root: Optional[Path] = None
    # Honesty rail (#941): held-out tasks are reserved from the default dev run
    # so the harness is never developed against them. Off by default; flip it
    # only for the deliberate "score the held-out split" pass.
    include_held_out: bool = False
    # Wall-clock lever: every ``(task, arm, rep)`` unit is FULLY independent —
    # the runner clones into its own random tempdir and the hidden-test runner
    # uses its own isolated workspace, so units share no state. Running them
    # sequentially makes total time = sum of all units (~19 min each → hours).
    # ``concurrency`` caps how many units run at once. Default 1 preserves the
    # old strictly-sequential, deterministic behavior; the CLI raises it so a
    # full corpus run finishes in roughly the slowest single unit, bounded by
    # the agent API's rate limits.
    concurrency: int = 1


@dataclass(frozen=True)
class SpineResult:
    """Observable output of one spine run.

    Held in memory and also written to disk (markdown) and to the metrics
    writer; tests assert on this in-memory representation directly.
    """

    repetitions: List[RepetitionRecord]
    verdicts: List[Verdict]
    arm_reports: List[ArmReport]
    report_path: Optional[Path] = None
    persist_ok: bool = False
    run_id: Optional[str] = None
    # Per-rep join of the runner's ``RunRecord`` with the scorer's ``solved``
    # verdict (issue #960). The intrinsic routing-regret / retry-lift probes need
    # BOTH the recorded model/usage/retries AND ground-truth solved, and no
    # single existing record carries both — so the spine threads this pure join
    # out alongside the repetition records (the RunRecord was previously dropped,
    # which is why those probes rendered "not available" in live reports).
    # Defaulted so existing constructions/tests stay valid.
    scored_runs: List[ScoredRun] = field(default_factory=list)


def _select_tasks(tasks: Sequence[CorpusTask], task_filter: Optional[Sequence[str]]) -> List[CorpusTask]:
    if not task_filter:
        return list(tasks)
    wanted = {name for name in task_filter}
    selected = [t for t in tasks if t.name in wanted]
    missing = wanted - {t.name for t in selected}
    if missing:
        raise ValueError(
            f"unknown corpus task(s): {', '.join(sorted(missing))} "
            f"(available: {', '.join(t.name for t in tasks)})"
        )
    return selected


def run_spine(
    config: SpineConfig,
    *,
    executor: AgentExecutor,
    hidden_test_runner: Optional[HiddenTestRunner] = None,
    metrics_writer: Optional[MetricsWriter] = None,
    reports_dir: Optional[Path] = None,
    date: Optional[str] = None,
    run_id: Optional[str] = None,
) -> SpineResult:
    """Drive one full eval pass: corpus → runner → hidden tests → scorer → reporter.

    Sequencing per repetition (this IS the AC2 temporal guarantee):

        1. ``runner.run(task, arm, executor=executor)`` runs to completion.
           The runner materializes a fresh tempdir, asserts the answer key is
           absent before AND after ``executor.execute``, then TEARS DOWN the
           tempdir. Only then does the call return.
        2. ONLY AFTER step 1 returns do we invoke
           ``hidden_test_runner.run_hidden_tests(task, run_record)``. The
           hidden-test runner uses its own workspace (NOT the agent's
           tempdir, which no longer exists).
        3. The bool the hidden-test runner returned is fed straight to
           ``scorer.score``. It is a REAL ``bool`` (defensive ``isinstance``
           check, fail loudly otherwise — the scorer-review nit).

    The reporter aggregates per arm, writes the dated markdown report under
    ``agentrail/evals/reports/`` (AC3), and writes the same per-arm numbers
    via ``MetricsWriter`` (AC4 — wired; persistence remains honestly disabled
    until #942 lands the ingest route, per ``HttpMetricsWriter`` policy).
    """
    if config.reps < 1:
        raise ValueError(f"reps must be >= 1; got {config.reps}")
    if not config.arms:
        raise ValueError("at least one arm is required")

    # AC5 (#952): the default HiddenTestRunner is the PRODUCTION engine that
    # apply-diffs the agent's output at the task's pinned commit and runs the
    # answer key in an isolated workspace. ``UnimplementedHiddenTestRunner``
    # remains importable (for tests that want an honest no-op) but is no
    # longer the spine's default — every CLI eval run now produces real
    # hidden-test verdicts. Tests inject a faithful spy via this kwarg.
    if hidden_test_runner is None:
        from agentrail.evals.hidden_tests import ProductionHiddenTestRunner

        hidden_test_runner = ProductionHiddenTestRunner()

    # Honesty rail (#941): held-out tasks are excluded by default; only the
    # explicit ``include_held_out`` flag pulls them into the run set.
    tasks = load_corpus(config.corpus_root, include_held_out=config.include_held_out)
    tasks = _select_tasks(tasks, config.task_filter)
    if not tasks:
        raise ValueError("no corpus tasks selected")

    repetitions: List[RepetitionRecord] = []
    verdicts: List[Verdict] = []
    # Issue #960: keep the RunRecord (which carries model + retries) joined with
    # its solved verdict, instead of dropping it. This is the data the routing
    # cost-regret and retry-lift probes need to surface in the live report.
    scored_runs: List[ScoredRun] = []

    # The ordered work-list: one entry per (task, arm, rep). Order is fixed here
    # so results re-assemble deterministically regardless of completion order —
    # ``ThreadPoolExecutor.map`` yields in submission order, so a parallel run
    # produces byte-identical repetition ordering to the sequential one.
    units: List[Tuple[CorpusTask, Arm]] = [
        (task, arm)
        for task in tasks
        for arm in config.arms
        for _rep in range(config.reps)
    ]

    def _run_unit(unit: Tuple[CorpusTask, Arm]):
        task, arm = unit
        # Step 1 — runner runs to completion BEFORE any hidden-test code path
        # is reached. The runner enforces AC3 spatially (no answer key in the
        # agent's workdir); this per-unit sequencing enforces AC2 temporally.
        # Units are independent (each gets its own tempdir + isolated
        # hidden-test workspace), which is exactly why running them in parallel
        # is safe — the spatial/temporal guards hold WITHIN each unit.
        record: RunRecord = run(task, arm, executor=executor)

        # AC1: arm pins model + temp; recorded on RunRecord via the runner.
        # Enforce that a model was recorded (the runner already takes arm.model;
        # this makes "recorded on every run" observable). No mutation — just the
        # contract assertion.
        if not record.model:
            raise RuntimeError(
                f"run for task={task.name} arm={arm.name} returned empty model "
                "— arm pin was not recorded on the RunRecord"
            )

        # Step 2 — hidden-test execution, AFTER the runner returned.
        hidden_tests_passed = hidden_test_runner.run_hidden_tests(
            task=task, run_record=record
        )
        if not isinstance(hidden_tests_passed, bool):
            # Scorer review nit, enforced at the spine boundary so the contract
            # violation surfaces here, not silently in the scorer.
            raise TypeError(
                "HiddenTestRunner.run_hidden_tests must return a real bool; "
                f"got {type(hidden_tests_passed).__name__}"
            )

        # Step 3 — scorer collapses to Verdict. Pure observation.
        verdict = score(record, hidden_tests_passed=hidden_tests_passed)
        rep = RepetitionRecord(
            task=task.name,
            arm=arm.name,
            solved=verdict.solved,
            usage=record.usage,
            # Objective Gate false-green probe (#940): carry the scorer's flags
            # VERBATIM. The reporter only COUNTS these — the false-green
            # definition is single-sourced in scorer.score, never re-derived.
            gate_passed=verdict.gate_passed,
            false_green=verdict.false_green,
            # Difficulty-stratified reporting (#941): thread the CorpusTask's
            # difficulty straight onto the record for per-stratum breakdowns.
            difficulty=task.difficulty,
        )
        # Issue #960: keep the RunRecord joined with its solved verdict (a pure
        # ScoredRun join — no new truth) so the intrinsic probes can be driven
        # from this real run instead of being dropped.
        return rep, verdict, ScoredRun(run=record, solved=verdict.solved)

    concurrency = max(1, config.concurrency)
    if concurrency == 1:
        # Strictly sequential — identical to the original behavior. Kept as a
        # distinct path so single-threaded runs never enter a worker thread
        # (preserves the simplest possible stack for debugging + test spies).
        results = [_run_unit(unit) for unit in units]
    else:
        # Units are independent, so fan them out. ``map`` preserves input order
        # and re-raises the first worker exception on iteration — same
        # fail-fast contract as the sequential path.
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            results = list(pool.map(_run_unit, units))

    for rep, verdict, scored in results:
        repetitions.append(rep)
        verdicts.append(verdict)
        scored_runs.append(scored)

    arm_reports = aggregate(repetitions)

    # AC3 — dated markdown report under agentrail/evals/reports/.
    date_str = date or _date.today().isoformat()
    base = Path(reports_dir) if reports_dir is not None else default_reports_dir()
    report_path = write_markdown_report(arm_reports, reports_dir=base, date=date_str)

    # Issue #960 — the intrinsic probes (routing cost-regret + retry lift/wasted-
    # retry cost) are now computed from the REAL RunRecords this run produced
    # (joined as ScoredRuns above), no longer dropped. The probe MATH lives in
    # ``agentrail.evals.probes``; we never re-derive it here. The guardrail
    # catch-rate runs the real guardrails against the crafted injection corpus
    # (no run records needed). The rendered section is appended to the SAME dated
    # report so the live report shows real numbers instead of "not available".
    routing = routing_cost_regret(scored_runs)
    retry = retry_lift(scored_runs)
    guardrail = guardrail_catch_rate()
    probes_md = render_probes_markdown(
        routing=routing, retry=retry, guardrail=guardrail
    )
    with report_path.open("a", encoding="utf-8") as fh:
        fh.write("\n")
        fh.write(probes_md)

    # AC4 — same per-arm numbers go via the injected MetricsWriter. Default:
    # the HttpMetricsWriter (honest no-op until #942).
    if metrics_writer is None:
        metrics_writer = HttpMetricsWriter(target=base)
    resolved_run_id = run_id or f"eval-{date_str}"
    persist_ok = bool(write_reports(arm_reports, metrics_writer, run_id=resolved_run_id))

    return SpineResult(
        repetitions=repetitions,
        verdicts=verdicts,
        arm_reports=arm_reports,
        report_path=report_path,
        persist_ok=persist_ok,
        run_id=resolved_run_id,
        scored_runs=scored_runs,
    )


# ---------------------------------------------------------------------------
# Arm resolution (CLI surface): accepts arm spec strings, validates, returns Arm.
# ---------------------------------------------------------------------------

# Known top-level arm constructors. "full-minus-<layer>" is handled separately
# so adding a layer (#arms.LAYER_NAMES) does not require touching this list.
_TOP_LEVEL_ARMS = {
    "baseline": baseline,
    "full": full,
}


def resolve_arm(spec: str) -> Arm:
    """Resolve an arm spec string (CLI surface) into an :class:`Arm`.

    Accepts:
        - ``baseline``
        - ``full``
        - ``full-minus-<layer>`` (e.g. ``full-minus-context``)

    Raises ``ValueError`` for any other spec; ``full_minus`` itself raises on
    an unknown layer name, so a typo surfaces clearly.
    """
    spec = spec.strip()
    if spec in _TOP_LEVEL_ARMS:
        return _TOP_LEVEL_ARMS[spec]()
    prefix = "full-minus-"
    if spec.startswith(prefix):
        return full_minus(spec[len(prefix):])
    raise ValueError(
        f"unknown arm {spec!r}; expected 'baseline', 'full', or 'full-minus-<layer>'"
    )


__all__ = [
    "HiddenTestRunner",
    "UnimplementedHiddenTestRunner",
    "SpineConfig",
    "SpineResult",
    "run_spine",
    "resolve_arm",
]
