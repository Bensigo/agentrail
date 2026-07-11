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
co-resident in time (AC2). Unit tests in ``agentrail/tests/evals/test_spine.py`` assert
both halves: a spy on the runner's executor records the workdir+contents at
``execute``-time and proves the answer key was absent; the
``HiddenTestRunner`` fake records its own invocation order and proves it ran
strictly AFTER the runner returned.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date as _date
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol, Sequence, Tuple

_log = logging.getLogger(__name__)

# Canonical contracts — imported, never redefined here (anti-false-green rule).
from agentrail.evals.arms import (
    Arm,
    baseline,
    cutoff_arm,
    full,
    full_minus,
    gather_arm,
    llm_rerank_arm,
    new_flow,
    new_flow_minus,
    symbol_packing_arm,
)
from agentrail.evals.corpus.loader import CorpusTask, load_corpus
from agentrail.evals.gather_report import (
    render_gather_precision_from_records,
    render_gather_report_from_ledger,
)
from agentrail.evals.pack_scorer import ArmPackScore
from agentrail.evals.pack_scoring import compute_pack_scores
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
    retry_attribution,
    retry_lift,
    routing_attribution,
    routing_cost_regret,
)
from agentrail.evals.reporter import (
    render_probes_markdown,
    render_routing_retry_audit_markdown,
)
from agentrail.evals.run_record import RunRecord
from agentrail.evals.runner import (
    AgentExecutor,
    SandboxAgentExecutor,
    is_network_artifact,
    run,
)
from agentrail.evals.scorer import Verdict, score
from agentrail.run.usage_capture import Usage


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

    Optional richer entrypoint (issue #1169, AC3): an implementation MAY also
    define ``run_hidden_tests_with_output(self, *, task, run_record) ->
    tuple[bool, str]``, returning the gate's verbatim stdout/stderr alongside
    the same bool. The spine duck-types this (``hasattr``) rather than adding
    it to the Protocol, so existing bool-only implementations keep working
    unchanged — ``ProductionHiddenTestRunner`` is the one production
    implementation of it today.
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
    # Offline context-pack scoring root (#1029 AC2/AC3). When set to a checkout
    # that HAS a built context index, the spine runs the deterministic retrieval
    # stage per (task, arm) — honoring each arm's rerank flag — and scores the
    # cited paths against every task's required-context answer key, so the report
    # shows REAL precision/recall (not ``n/a``) and a falsifiable rerank delta.
    # ``None`` (default) or a root with no index → pack scores are omitted and the
    # report renders ``n/a`` honestly (never a fabricated 0.0). The corpus tasks
    # are pinned to this repo, so the CLI passes the agentrail checkout root here.
    pack_index_root: Optional[Path] = None
    # Gather token-reduction + cache-hit ledger (#1049 AC4). Path to a per-phase
    # cost ledger (``.agentrail/run/cost-events.jsonl`` shape — one
    # ``build_cost_record`` JSON line per phase, tagged with its ``arm``). When
    # set and readable, the report gains a "Gather token-reduction + cache-hit"
    # section pairing ``full`` against ``full-plus-gather`` on total tokens,
    # execute-phase context, and warm-cache hits. ``None`` (default) → the section
    # renders an honest "not available — needs a live run" note (never a fake 0),
    # so existing runs are unchanged and the section is always discoverable.
    cost_ledger_path: Optional[Path] = None


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


def _append_cost_ledger_events(
    ledger_path: Path,
    events: Sequence[Dict[str, Any]],
    *,
    arm_name: str,
    task_name: str,
    rep: int,
    lock: "threading.Lock",
) -> None:
    """Append a run's per-phase cost events to the aggregate ledger, arm-tagged.

    This is the write half of the #1049 AC4 evidence rail. The runner harvested
    ``events`` (raw ``.agentrail/run/cost-events.jsonl`` lines) out of the run's
    sandbox before teardown; here we stamp each with the run's ``arm`` and append
    it to the single aggregate ledger the report reads. Tagging every line with
    ``arm`` is exactly what ``aggregate_gather_tokens`` needs to attribute tokens
    to ``full`` vs ``full-plus-gather`` WITHOUT a separate ``run_id → arm`` map.

    Issue #1169 AC2: every event is ALSO stamped with ``task`` and ``rep`` so a
    ledger line can be traced back to the exact repetition that produced it —
    the legacy ``"host-run"`` constant some events still carry may remain as a
    legacy field, but it is no longer the only identity on the line.

    Best-effort and never fatal — the ledger is diagnostic evidence, not part of
    any verdict, so an IO or serialization problem is swallowed (a warning, no
    raise) rather than sinking the eval unit. Thread-safe via ``lock`` so units
    running under ``concurrency > 1`` never interleave partial JSON lines.
    """
    if not events:
        return
    lines: List[str] = []
    for ev in events:
        rec = dict(ev)
        rec["arm"] = arm_name
        rec["task"] = task_name
        rec["rep"] = rep
        try:
            lines.append(json.dumps(rec))
        except (TypeError, ValueError):
            # A single unserializable event should not drop the rest.
            continue
    if not lines:
        return
    payload = "\n".join(lines) + "\n"
    try:
        with lock:
            with ledger_path.open("a", encoding="utf-8") as fh:
                fh.write(payload)
    except OSError as exc:
        _log.warning("could not append cost ledger events to %s: %s", ledger_path, exc)


# ---------------------------------------------------------------------------
# Per-repetition forensics record (#1169): identity, verbatim gate output,
# verdicts, per-phase cost — one JSON file per (task, arm, rep) so "what
# happened on this exact rep" never requires opening run.log or the ledger.
# ---------------------------------------------------------------------------


def _aggregate_phase_usage(cost_events: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
    """Bucket a run's harvested cost events by ``phase``, summing tokens + cost.

    Defensive by design: cost events are diagnostic evidence produced by a
    separate sandbox-side writer (``agentrail.run.cost_push.build_cost_record``),
    not a contract this module owns, so a missing/malformed field must never
    raise here. Events missing a ``phase`` are bucketed under ``"unknown"``
    rather than dropped, so their tokens/cost are never silently lost from the
    per-rep total.
    """
    usage: Dict[str, Dict[str, float]] = {}
    for ev in cost_events:
        if not isinstance(ev, dict):
            continue
        phase = ev.get("phase") or "unknown"
        if not isinstance(phase, str):
            phase = "unknown"
        bucket = usage.setdefault(phase, {"tokens": 0.0, "cost_usd": 0.0})
        tokens = ev.get("tokens")
        if isinstance(tokens, (int, float)):
            bucket["tokens"] += float(tokens)
        cost_usd = ev.get("cost_usd")
        if isinstance(cost_usd, (int, float)):
            bucket["cost_usd"] += float(cost_usd)
    return usage


def _forensics_record_path(records_dir: Path, *, task_name: str, arm_name: str, rep: int) -> Path:
    return records_dir / f"{task_name}--{arm_name}--rep{rep}.json"


def _write_forensics_record(
    records_dir: Path,
    lock: "threading.Lock",
    *,
    task_name: str,
    arm_name: str,
    rep: int,
    solved: bool,
    false_green: bool,
    synthetic: bool,
    gate_output: str,
    verdicts: Sequence[Dict[str, Any]],
    cost_events: Sequence[Dict[str, Any]],
    diff: str,
    started_at: Optional[str],
    finished_at: Optional[str],
) -> None:
    """Write one per-rep forensics record (#1169 AC1): identity, verbatim gate
    output, verdicts, per-phase cost — everything needed to answer "what
    happened on this exact rep" without opening ``run.log`` or the cost ledger.

    Best-effort and never fatal, matching ``_append_cost_ledger_events``: this
    is diagnostic evidence, not part of any verdict, so a filesystem or
    serialization problem is logged and swallowed rather than sinking an
    otherwise-valid eval unit.

    The verbatim diff (when non-empty) is written to a SIBLING ``.diff`` file
    instead of embedded in the JSON — it is arbitrary free-form text that can
    be large, and a standalone file stays diffable/greppable on its own.
    ``diff_path`` is the sibling file's name (relative to this record's own
    directory) — ``None`` (never a path to an empty file) when there was no
    diff, matching the None-vs-empty discipline used throughout this record:
    ``None`` means "not applicable", never a fabricated empty value.

    Each ``(task, arm, rep)`` is unique within one ``run_spine`` call (the
    ``units`` list has exactly one entry per combination), so concurrent units
    never target the same record file; ``lock`` exists for the same reason
    ``cost_ledger_lock`` does elsewhere in this module — cheap, obviously-
    correct serialization of a filesystem side effect, not a performance path.
    """
    try:
        with lock:
            records_dir.mkdir(parents=True, exist_ok=True)
            record_path = _forensics_record_path(
                records_dir, task_name=task_name, arm_name=arm_name, rep=rep
            )
            diff_path: Optional[Path] = None
            if diff.strip():
                diff_path = record_path.with_suffix(".diff")
            payload = {
                "task": task_name,
                "arm": arm_name,
                "rep": rep,
                "solved": solved,
                "false_green": false_green,
                "synthetic": synthetic,
                "gate_output": gate_output,
                "verdicts": list(verdicts),
                "phase_usage": _aggregate_phase_usage(cost_events),
                "diff_path": diff_path.name if diff_path is not None else None,
                "started_at": started_at,
                "finished_at": finished_at,
            }
            record_path.write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            if diff_path is not None:
                diff_path.write_text(diff, encoding="utf-8")
    except (OSError, TypeError, ValueError) as exc:
        _log.warning(
            "could not write forensics record for task=%s arm=%s rep=%s: %s",
            task_name,
            arm_name,
            rep,
            exc,
        )


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

    # Offline context-pack precision/recall (#1029 AC2/AC3). Computed ONCE up
    # front (it depends only on task prompts + the pinned repo's context index,
    # not on any agent run), then threaded into EVERY report write below so a
    # real eval populates precision/recall instead of rendering ``n/a``. The
    # driver runs the deterministic retrieval per (task, arm) honoring each arm's
    # rerank flag, so ``full`` vs ``full-minus-rerank`` yields a falsifiable pack
    # delta. Returns ``None`` (→ ``n/a``, never a fake 0.0) when no index exists
    # at ``pack_index_root`` (or it is unset) — so the default path is unchanged.
    pack_scores: Optional[List[ArmPackScore]] = None
    if config.pack_index_root is not None:
        pack_scores = compute_pack_scores(
            tasks, config.arms, root=config.pack_index_root
        )

    # Gather per-phase cost ledger (#1049 AC4). When a ledger path is configured,
    # START IT FRESH so the report reflects EXACTLY this run — a stale file from a
    # prior run would silently mix arms/runs into the token aggregates. Both arms
    # of one command (``--arm full --arm full-plus-gather``) append here, and the
    # final ``render_gather_report_from_ledger`` reads it back. The append inside
    # each unit is guarded by this lock so parallel units never interleave lines.
    cost_ledger_lock = threading.Lock()
    if config.cost_ledger_path is not None:
        try:
            config.cost_ledger_path.parent.mkdir(parents=True, exist_ok=True)
            config.cost_ledger_path.write_text("", encoding="utf-8")
        except OSError as exc:
            _log.warning(
                "could not initialise cost ledger at %s (gather AC4 evidence "
                "may be stale/absent): %s",
                config.cost_ledger_path,
                exc,
            )

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
    units: List[Tuple[CorpusTask, Arm, int]] = [
        (task, arm, rep_index)
        for task in tasks
        for arm in config.arms
        for rep_index in range(config.reps)
    ]

    def _run_unit(unit: Tuple[CorpusTask, Arm, int]):
        task, arm, rep_index = unit
        # Step 1 — runner runs to completion BEFORE any hidden-test code path
        # is reached. The runner enforces AC3 spatially (no answer key in the
        # agent's workdir); this per-unit sequencing enforces AC2 temporally.
        # Units are independent (each gets its own tempdir + isolated
        # hidden-test workspace), which is exactly why running them in parallel
        # is safe — the spatial/temporal guards hold WITHIN each unit.
        #
        # Fail-soft boundary: a real CRASH in the agent run or the hidden-test
        # execution (a hung subprocess, an OOM, a transient sandbox error on ONE
        # task) is recorded as an unsolved failure so the rest of the corpus run
        # survives — instead of one bad task aborting the whole scorecard. The
        # CONTRACT assertions below (empty model, non-bool verdict) stay FATAL:
        # those signal a defective executor/seam, a bug to surface loudly, not a
        # task to silently score 0.
        try:
            record: RunRecord = run(task, arm, executor=executor)
        except Exception as exc:  # noqa: BLE001 - survive a crashed agent run
            return _failed_unit_result(unit, exc)

        # AC1: arm pins model + temp; recorded on RunRecord via the runner.
        # Enforce that a model was recorded (the runner already takes arm.model;
        # this makes "recorded on every run" observable). No mutation — just the
        # contract assertion (FATAL — defective seam, not a task failure).
        if not record.model:
            raise RuntimeError(
                f"run for task={task.name} arm={arm.name} returned empty model "
                "— arm pin was not recorded on the RunRecord"
            )

        # Step 2 — hidden-test execution, AFTER the runner returned (fail-soft).
        # Issue #1169 AC3: prefer the richer ``run_hidden_tests_with_output``
        # entrypoint (implemented on ``ProductionHiddenTestRunner``), which ALSO
        # returns the gate's verbatim stdout/stderr — the evidence a per-rep
        # forensics record needs to answer "what did the gate print" without
        # opening run.log. This is duck-typed (``hasattr``), not a Protocol
        # change, so any ``HiddenTestRunner`` that predates #1169 and only
        # implements the original bool-only ``run_hidden_tests`` keeps working
        # unchanged — ``gate_output`` is then honestly empty rather than
        # fabricated.
        gate_output = ""
        try:
            if hasattr(hidden_test_runner, "run_hidden_tests_with_output"):
                hidden_tests_passed, gate_output = (
                    hidden_test_runner.run_hidden_tests_with_output(
                        task=task, run_record=record
                    )
                )
                if not isinstance(gate_output, str):
                    gate_output = ""
            else:
                hidden_tests_passed = hidden_test_runner.run_hidden_tests(
                    task=task, run_record=record
                )
        except Exception as exc:  # noqa: BLE001 - survive a crashed scorer run
            return _failed_unit_result(unit, exc)
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
            # Wall-time per task (#980): carry the runner's measured wall-clock
            # so the report can surface wall-time per task per arm.
            wall_time_s=record.wall_time_s,
            # Diagnostic fields (#994): carry the RunRecord's observability data
            # so the report can explain WHY a failed run failed (diff +
            # gate-failure reason) and surface per-run context-pack quality.
            diff=record.diff,
            gate_failure_reason=record.gate_failure_reason,
            precision_at_budget=record.precision_at_budget,
            citation_coverage=record.citation_coverage,
            # Network-artifact hygiene (#1033): recognise an ECONNRESET
            # synthetic-fallback run (RunRecord.model == "<synthetic>") AT
            # CAPTURE and mark the rep so the reporter EXCLUDES it from every
            # aggregate (no diff, $0; solved=0 is a network artifact, not a real
            # score). Single-sourced predicate — the spine never re-derives it.
            network_artifact=is_network_artifact(record.model),
        )
        # Gather per-phase cost evidence (#1049 AC4). Persist the run's harvested
        # cost-ledger lines (arm-tagged) to the aggregate ledger the report reads
        # — but ONLY for real runs. A ``<synthetic>`` network-artifact run spent
        # nothing and is EXCLUDED from every other aggregate; its (empty/absent)
        # ledger must not muddy the token report either, so we skip it here too,
        # single-sourcing the exclusion on the same ``network_artifact`` predicate.
        if config.cost_ledger_path is not None and not rep.network_artifact:
            _append_cost_ledger_events(
                config.cost_ledger_path,
                record.cost_events,
                arm_name=arm.name,
                task_name=task.name,
                rep=rep_index + 1,
                lock=cost_ledger_lock,
            )
        # Per-rep forensics record (#1169 AC1): identity, verbatim gate output,
        # verdicts, per-phase cost — written for EVERY rep (unlike the cost
        # ledger above, which is opt-in via ``cost_ledger_path`` and skips
        # synthetic runs) so "what happened on this exact rep" is always
        # discoverable, synthetic runs included (AC4 — recorded with
        # ``synthetic=True`` and zero-cost usage, not silently omitted).
        _write_forensics_record(
            records_dir,
            records_lock,
            task_name=task.name,
            arm_name=arm.name,
            rep=rep_index + 1,
            solved=verdict.solved,
            false_green=verdict.false_green,
            synthetic=rep.network_artifact,
            gate_output=gate_output,
            verdicts=record.verdicts,
            cost_events=record.cost_events,
            diff=record.diff,
            started_at=record.started_at,
            finished_at=record.finished_at,
        )
        # Issue #960: keep the RunRecord joined with its solved verdict (a pure
        # ScoredRun join — no new truth) so the intrinsic probes can be driven
        # from this real run instead of being dropped.
        return rep, verdict, ScoredRun(run=record, solved=verdict.solved)

    # AC3 report location is resolved UP FRONT so results can be checkpointed to
    # the dated report AS units complete — not only at the very end. A long
    # corpus run that is interrupted (killed, timed out, crashed) then still
    # leaves a scorecard for every (task, arm) that finished, instead of the
    # all-or-nothing zero output that made every prior killed run useless. The
    # final write below re-renders the complete report and appends the probes.
    date_str = date or _date.today().isoformat()
    base = Path(reports_dir) if reports_dir is not None else default_reports_dir()
    # Per-rep forensics records (#1169 AC1) live in ``run-records/<date>/`` — a
    # SIBLING of the dated markdown report inside the same reports directory,
    # so every existing test that overrides ``reports_dir`` already isolates
    # the new forensics writes too. A separate lock from ``cost_ledger_lock``:
    # the two write to different files/directories and need not serialize
    # against each other. ``_run_unit`` (defined above) and
    # ``_failed_unit_result`` (defined below) both close over these two names
    # — safe because neither is actually CALLED until the dispatch loop further
    # down, well after both are assigned here.
    records_dir = base / "run-records" / date_str
    records_lock = threading.Lock()

    def _failed_unit_result(unit: Tuple[CorpusTask, Arm, int], exc: Exception):
        # Fail-soft: a single unit raising (an unexpected crash, or a contract
        # violation from a defective executor) must NOT zero out the whole
        # corpus run. Record it as an unsolved repetition and keep going — an
        # errored task is honestly a failure, scored 0, and the other units'
        # numbers are preserved. There is no RunRecord to join, so the probe
        # ScoredRun is omitted (the probes tolerate fewer rows than reps).
        task, arm, rep_index = unit
        _log.warning("eval unit failed task=%s arm=%s: %s", task.name, arm.name, exc)
        rep = RepetitionRecord(
            task=task.name,
            arm=arm.name,
            solved=False,
            usage=Usage(
                model=arm.model,
                input_tokens=0,
                output_tokens=0,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            gate_passed=False,
            false_green=False,
            difficulty=task.difficulty,
        )
        verdict = Verdict(
            task=task.name, arm=arm.name, solved=False, gate_passed=False, false_green=False
        )
        # Per-rep forensics record (#1169): a crash still gets a record — the
        # abort message IS the "what did the gate print" answer here (there is
        # no RunRecord, so no verdicts/cost/diff/timestamps were ever
        # captured; None/empty throughout, never fabricated, matching this
        # unit's honest ``network_artifact=False`` default above).
        _write_forensics_record(
            records_dir,
            records_lock,
            task_name=task.name,
            arm_name=arm.name,
            rep=rep_index + 1,
            solved=False,
            false_green=False,
            synthetic=rep.network_artifact,
            gate_output=str(exc),
            verdicts=[],
            cost_events=[],
            diff="",
            started_at=None,
            finished_at=None,
        )
        return rep, verdict, None

    # Results are keyed by the unit's stable index so the final order is
    # deterministic regardless of completion order (parallel runs finish out of
    # order). After EACH unit lands we re-aggregate everything completed so far
    # and rewrite the dated report — the checkpoint that makes an interrupted
    # run still produce a (partial) scorecard.
    results_by_index: Dict[int, tuple] = {}

    def _checkpoint() -> None:
        done_reps = [results_by_index[i][0] for i in sorted(results_by_index)]
        if done_reps:
            # Pass the per-rep records (#994) so the checkpointed report surfaces
            # each failed run's diff + gate-failure reason + context quality.
            write_markdown_report(
                aggregate(done_reps),
                reports_dir=base,
                date=date_str,
                records=done_reps,
                # Real precision/recall (#1029) — computed once up front and
                # rendered on every checkpoint, so an interrupted run's partial
                # scorecard still carries the pack quality (None → n/a).
                pack_scores=pack_scores,
            )

    concurrency = max(1, config.concurrency)
    if concurrency == 1:
        # Strictly sequential — preserves the simplest stack for debugging and
        # keeps single-threaded runs out of a worker thread.
        for i, unit in enumerate(units):
            results_by_index[i] = _run_unit(unit)
            _checkpoint()
    else:
        # Units are independent, so fan them out. ``as_completed`` lets the
        # checkpoint fire the instant each unit finishes (not after the whole
        # batch), so the on-disk scorecard tracks progress in real time.
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            future_index = {pool.submit(_run_unit, unit): i for i, unit in enumerate(units)}
            for fut in as_completed(future_index):
                results_by_index[future_index[fut]] = fut.result()
                _checkpoint()

    results = [results_by_index[i] for i in sorted(results_by_index)]
    for rep, verdict, scored in results:
        repetitions.append(rep)
        verdicts.append(verdict)
        if scored is not None:
            scored_runs.append(scored)

    arm_reports = aggregate(repetitions)

    # Final report write — re-renders the COMPLETE scorecard (overwriting the
    # last checkpoint) so the probes section below appends to a full report.
    report_path = write_markdown_report(
        arm_reports,
        reports_dir=base,
        date=date_str,
        records=repetitions,
        # Real context-pack precision/recall + the full-vs-full-minus-rerank
        # delta (#1029 AC2/AC3) — None → n/a, never a fabricated 0.0.
        pack_scores=pack_scores,
    )

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
    # Finding 4 — routing/retry VALUE audit (measurement only). Computed from the
    # SAME scored_runs (no extra runs, no behaviour change): routing $-delta vs
    # the recorded baseline model with an explicit "had no chance to act" signal,
    # and retry win/burn counts. Appended to the SAME dated report.
    routing_audit = routing_attribution(scored_runs)
    retry_audit = retry_attribution(scored_runs)
    audit_md = render_routing_retry_audit_markdown(
        routing=routing_audit, retry=retry_audit
    )
    # Gather token-reduction + cache-hit report (#1049 AC4). Read from the
    # per-phase cost ledger (``config.cost_ledger_path``) and rendered as a
    # ``full`` vs ``full-plus-gather`` section: total tokens (≈ flat with gather
    # ON), execute-phase context (should DROP), and warm-cache hits (AC1 byte-
    # stable-manifest evidence). The section ALWAYS renders — an unset/missing
    # ledger yields an honest "not available — needs a live run" note (never a
    # fake 0), so existing runs with no ledger are unchanged but discoverable.
    gather_md = render_gather_report_from_ledger(config.cost_ledger_path)
    # Gather file-picking precision (#1049 AC4, precision half). The OTHER half of
    # AC4: did the gatherer point at the RIGHT files? Scored per run by the runner
    # (``RunRecord.gather_score``) against each task's ``requiredContext`` answer
    # key, then pooled per arm here from the SAME RunRecords this run produced (no
    # extra runs, no file plumbing). Renders the honest "not available — needs a
    # live run" note when no run carried a gather score. Appended right after the
    # token half so both AC4 numbers sit together in the SAME dated report.
    gather_precision_md = render_gather_precision_from_records(
        [sr.run for sr in scored_runs]
    )
    with report_path.open("a", encoding="utf-8") as fh:
        fh.write("\n")
        fh.write(probes_md)
        fh.write("\n")
        fh.write(audit_md)
        fh.write("\n")
        fh.write(gather_md)
        fh.write("\n")
        fh.write(gather_precision_md)

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

# Known top-level arm constructors. "full-minus-<layer>" / "new-flow-minus-
# <layer>" are handled separately so adding a layer does not touch this list.
_TOP_LEVEL_ARMS = {
    "baseline": baseline,
    "full": full,
    "new-flow": new_flow,
}

# The opt-in PLUS arms, keyed by the layer name in ``full-plus-<layer>``. These
# are default-OFF, model-dependent A/B arms that are NOT part of ``full`` (and
# NOT in ``all_arms`` / ``--ablation``); they are reachable ONLY by an explicit
# ``--arm full-plus-<layer>``. A new PLUS layer is one entry here (mirrors how a
# ``full-minus-<layer>`` arm is picked up by the ``full-minus-`` prefix branch).
_FULL_PLUS_ARMS = {
    "llm_rerank": llm_rerank_arm,
    "cutoff": cutoff_arm,
    "symbol_packing": symbol_packing_arm,
    "gather": gather_arm,
}


def resolve_arm(spec: str) -> Arm:
    """Resolve an arm spec string (CLI surface) into an :class:`Arm`.

    Accepts:
        - ``baseline``
        - ``full``
        - ``full-minus-<layer>`` (e.g. ``full-minus-context``)
        - ``full-plus-<layer>`` (opt-in PLUS arms: ``llm_rerank`` #1044,
          ``cutoff`` #1096, ``symbol_packing`` #1044 AC4, ``gather`` #1049)
        - ``new-flow`` (full + critic + best-of-N + warm-cache, issue #980)
        - ``new-flow-minus-<layer>`` (e.g. ``new-flow-minus-warmcache``)

    Raises ``ValueError`` for any other spec; ``full_minus`` / ``new_flow_minus``
    themselves raise on an unknown layer name, so a typo surfaces clearly. The
    ``new-flow-`` prefix is checked BEFORE ``full-`` even though neither overlaps,
    to keep the dispatch order explicit.
    """
    spec = spec.strip()
    if spec in _TOP_LEVEL_ARMS:
        return _TOP_LEVEL_ARMS[spec]()
    new_flow_prefix = "new-flow-minus-"
    if spec.startswith(new_flow_prefix):
        return new_flow_minus(spec[len(new_flow_prefix):])
    plus_prefix = "full-plus-"
    if spec.startswith(plus_prefix):
        layer = spec[len(plus_prefix):]
        try:
            return _FULL_PLUS_ARMS[layer]()
        except KeyError:
            raise ValueError(
                f"unknown full-plus arm layer {layer!r}; expected one of "
                f"{', '.join(_FULL_PLUS_ARMS)}"
            )
    prefix = "full-minus-"
    if spec.startswith(prefix):
        return full_minus(spec[len(prefix):])
    raise ValueError(
        f"unknown arm {spec!r}; expected 'baseline', 'full', 'full-minus-<layer>', "
        "'full-plus-<layer>', 'new-flow', or 'new-flow-minus-<layer>'"
    )


__all__ = [
    "HiddenTestRunner",
    "UnimplementedHiddenTestRunner",
    "SpineConfig",
    "SpineResult",
    "run_spine",
    "resolve_arm",
]
