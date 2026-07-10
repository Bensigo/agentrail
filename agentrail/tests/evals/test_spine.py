"""Tests for the eval spine (issue #938).

Covers AC1-AC5 with faithful fakes for the two seams the spine depends on:
the ``AgentExecutor`` (runner-side) and the ``HiddenTestRunner`` (scorer-side).
The fakes mirror the production output contracts exactly — no invented fields,
no captured stdout/stderr, real ``bool`` returns.

Key adversarial guard: AC2 — the answer key must NOT appear in the agent's
sandbox workdir during the agent run, and the hidden-test runner must only
execute AFTER the agent's run has fully returned. Both halves are asserted
below (the spatial half by introspection at ``execute``-time, the temporal
half by ordered call logging).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import pytest

from agentrail.evals.arms import Arm, baseline, full, full_minus, gather_arm, gather_arms
from agentrail.evals.corpus.loader import CorpusTask, load_task
from agentrail.evals.probes import (
    ScoredRun,
    retry_lift,
    routing_cost_regret,
)
from agentrail.evals.reporter import MetricsWriter, RepetitionRecord
from agentrail.evals.run_record import RetryEvent, RunRecord
from agentrail.evals.runner import SYNTHETIC_MODEL, AgentExecution
from agentrail.evals.scorer import Verdict
from agentrail.evals.spine import (
    HiddenTestRunner,
    SpineConfig,
    UnimplementedHiddenTestRunner,
    resolve_arm,
    run_spine,
)
from agentrail.run.usage_capture import Usage


MODEL = "claude-sonnet-4-5"


# ---------------------------------------------------------------------------
# Fixtures: a tiny corpus root holding two faithful tasks.
# ---------------------------------------------------------------------------


def _write_task(
    root: Path,
    name: str,
    *,
    difficulty: str = "easy",
    held_out: bool = False,
) -> CorpusTask:
    task_dir = root / name
    visible = task_dir / "workdir"
    answer = task_dir / "answer_key"
    visible.mkdir(parents=True)
    answer.mkdir(parents=True)
    (visible / "README.md").write_text(f"# {name}\n", encoding="utf-8")
    # The "answer key" content — must never appear inside ``visible/`` and must
    # never be touched during the agent run.
    (answer / "test_hidden.py").write_text(
        "ANSWER_KEY_SECRET = 'mounting this means scoring leaked'\n"
        "def test_truth():\n    assert True\n",
        encoding="utf-8",
    )
    task_json = {
        "name": name,
        "repo": "Bensigo/agentrail",
        "commit": "deadbeef",
        "prompt": f"Solve {name}.",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {"root": "answer_key", "files": ["test_hidden.py"]},
        "requiredContext": ["agentrail/evals/spine.py"],
        "difficulty": difficulty,
        "heldOut": held_out,
    }
    (task_dir / "task.json").write_text(json.dumps(task_json), encoding="utf-8")
    return load_task(task_dir)


@pytest.fixture()
def corpus_root(tmp_path: Path) -> Path:
    root = tmp_path / "corpus"
    root.mkdir()
    _write_task(root, "alpha-task")
    _write_task(root, "bravo-task")
    return root


@pytest.fixture()
def reports_dir(tmp_path: Path) -> Path:
    return tmp_path / "reports"


# ---------------------------------------------------------------------------
# Faithful fakes for the two seams.
# ---------------------------------------------------------------------------


@dataclass
class SpyExecutor:
    """Faithful executor — matches :class:`SandboxAgentExecutor` output exactly.

    Spy state:
        - ``invocations`` — ordered list of (task_name, arm_name) the executor was
          called with.  Tests assert ordering against ``HiddenTestSpy.invocations``
          to prove temporal separation (every executor call precedes any hidden
          test call for the SAME (task, arm, rep)).
        - ``workdir_snapshots`` — for each call, a list of file basenames present
          in the agent's workdir when ``execute`` was invoked.  Tests assert no
          answer-key file appears here (the spatial half of AC2 / AC3).
    """

    gate_passed: bool = True
    diff: str = ""
    invocations: List[tuple] = field(default_factory=list)
    workdir_snapshots: List[List[str]] = field(default_factory=list)
    # Caller can pre-program a (task, arm)-keyed verdict so the spine produces
    # a mixed solved/failed distribution and the report has real numbers.
    verdicts_for: Dict[tuple, bool] = field(default_factory=dict)

    # Strictly-ordered call log shared with hidden-test spy. Filled by tests.
    call_log: Optional[List[str]] = None

    # Caller can pre-program per-arm cost events (arm name -> list of per-phase
    # event dicts, WITHOUT the ``arm`` field). ``execute`` writes them into the
    # workdir exactly where the live run pipeline leaves them, so the runner
    # harvests them off the filesystem before teardown — the real cost seam.
    cost_events_for: Dict[str, List[dict]] = field(default_factory=dict)

    # Caller can pre-program a per-arm gather CONTEXT MANIFEST (arm name ->
    # manifest text). ``execute`` writes it where the live gather phase leaves it
    # (``workdir/.agentrail-runs/host-run/gather/output.md``), so the runner
    # harvests+scores it before teardown — the real file-picking seam (#1049 AC4).
    gather_manifest_for: Dict[str, str] = field(default_factory=dict)

    # Caller can force a resolved model per arm (arm name -> model id). Used to
    # simulate a <synthetic> network-artifact run — the model the real capture
    # overwrites on ECONNRESET fallback. Defaults to the arm's pinned model.
    model_for: Dict[str, str] = field(default_factory=dict)

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        self.invocations.append((task.name, arm.name))
        snapshot = [p.name for p in workdir.rglob("*") if p.is_file()]
        self.workdir_snapshots.append(snapshot)
        if self.call_log is not None:
            self.call_log.append(f"exec:{task.name}:{arm.name}")
        events = self.cost_events_for.get(arm.name)
        if events:
            ledger = workdir / "repo" / ".agentrail" / "run" / "cost-events.jsonl"
            ledger.parent.mkdir(parents=True, exist_ok=True)
            ledger.write_text(
                "".join(json.dumps(ev) + "\n" for ev in events),
                encoding="utf-8",
            )
        manifest = self.gather_manifest_for.get(arm.name)
        if manifest is not None:
            out = workdir / ".agentrail-runs" / "host-run" / "gather" / "output.md"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(manifest, encoding="utf-8")
        # Real bool — never int/None. Faithful to SandboxAgentExecutor's
        # ``RunResult.status == 'green'`` collapse.
        gate = bool(self.verdicts_for.get((task.name, arm.name), self.gate_passed))
        model = self.model_for.get(arm.name, arm.model)
        return AgentExecution(
            diff=self.diff,
            usage=Usage(
                model=model,
                input_tokens=100,
                output_tokens=50,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            model=model,
            gate_passed=gate,
            retries=[],
        )


@dataclass
class HiddenTestSpy:
    """Faithful hidden-test runner — returns a real ``bool`` per (task, arm)."""

    # (task, arm) -> hidden_tests_passed
    outcomes: Dict[tuple, bool] = field(default_factory=dict)
    invocations: List[tuple] = field(default_factory=list)
    # Records the workdirs / files it was handed (always the run_record only;
    # the spine never gives it access to the agent's workdir).
    seen_diffs: List[str] = field(default_factory=list)
    call_log: Optional[List[str]] = None
    default: bool = False

    def run_hidden_tests(self, *, task: CorpusTask, run_record: RunRecord) -> bool:
        self.invocations.append((task.name, run_record.arm))
        self.seen_diffs.append(run_record.diff)
        if self.call_log is not None:
            self.call_log.append(f"hidden:{task.name}:{run_record.arm}")
        return bool(self.outcomes.get((task.name, run_record.arm), self.default))


class FakeMetricsWriter:
    """Captures rows so AC4 can assert what was persisted (no real Postgres)."""

    def __init__(self) -> None:
        self.rows: List[dict] = []
        self.calls = 0

    def write_arm_metrics(self, rows: Sequence[dict]) -> bool:
        self.calls += 1
        self.rows.extend(list(rows))
        return True


# ---------------------------------------------------------------------------
# AC1 — One spine call drives baseline + full at configurable N≥5 reps,
#       pinning + recording model and temperature on every run.
# ---------------------------------------------------------------------------


def test_ac1_runs_baseline_and_full_at_configurable_n_reps(corpus_root: Path, reports_dir: Path) -> None:
    executor = SpyExecutor()
    hidden = HiddenTestSpy()
    config = SpineConfig(arms=[baseline(), full()], reps=5, corpus_root=corpus_root)

    result = run_spine(
        config,
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # 2 tasks * 2 arms * 5 reps = 20
    assert len(result.repetitions) == 20
    assert len(executor.invocations) == 20
    # Model is RECORDED on every run (AC1).
    for rep in result.repetitions:
        assert rep.usage.model == MODEL


def test_ac1_arm_pin_propagates_to_run_record(corpus_root: Path, reports_dir: Path) -> None:
    executor = SpyExecutor()
    hidden = HiddenTestSpy()
    # Use a non-default arm to confirm the spine isn't hardcoded to baseline/full.
    config = SpineConfig(arms=[full_minus("context")], reps=2, corpus_root=corpus_root)

    result = run_spine(
        config,
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    assert {a.arm for a in result.arm_reports} == {"full-minus-context"}


def test_reps_below_one_is_rejected(corpus_root: Path, reports_dir: Path) -> None:
    with pytest.raises(ValueError):
        run_spine(
            SpineConfig(arms=[baseline()], reps=0, corpus_root=corpus_root),
            executor=SpyExecutor(),
            hidden_test_runner=HiddenTestSpy(),
            metrics_writer=FakeMetricsWriter(),
            reports_dir=reports_dir,
        )


# ---------------------------------------------------------------------------
# AC2 — the anti-false-green guard. Two halves:
#
#   (spatial) the answer key file is NOT in the agent's workdir at execute-time.
#   (temporal) the hidden-test runner runs STRICTLY AFTER the agent's run.
# ---------------------------------------------------------------------------


def test_ac2_spatial_answer_key_absent_in_workdir_during_agent_run(
    corpus_root: Path, reports_dir: Path
) -> None:
    """During ``executor.execute``, no hidden test file is present in the workdir."""
    executor = SpyExecutor()
    hidden = HiddenTestSpy()

    run_spine(
        SpineConfig(arms=[baseline(), full()], reps=2, corpus_root=corpus_root),
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # Every snapshot captured at execute() time MUST NOT contain the answer
    # key file basename. This is the spatial guard (AC3 + AC2 spatial half).
    for snapshot in executor.workdir_snapshots:
        assert "test_hidden.py" not in snapshot, (
            "answer key leaked into agent's workdir during execute(): "
            f"{snapshot}"
        )


def test_ac2_temporal_hidden_tests_strictly_after_agent_run(
    corpus_root: Path, reports_dir: Path
) -> None:
    """Each hidden-test call follows the executor call for the same (task, arm, rep).

    The shared call_log records the EXACT interleaving the spine produced. For
    every (task, arm) repetition, the executor MUST log first; the hidden-test
    runner MUST log right after, never before. This proves the runner.run(...)
    call returned FULLY before any answer-key path was reached.
    """
    call_log: List[str] = []
    executor = SpyExecutor(call_log=call_log)
    hidden = HiddenTestSpy(call_log=call_log)

    run_spine(
        SpineConfig(arms=[baseline(), full()], reps=2, corpus_root=corpus_root),
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # Pair-wise check: log must alternate exec -> hidden, never the reverse.
    assert len(call_log) % 2 == 0
    for i in range(0, len(call_log), 2):
        assert call_log[i].startswith("exec:"), call_log
        assert call_log[i + 1].startswith("hidden:"), call_log
        # And they must be for the SAME (task, arm).
        _, t_exec, a_exec = call_log[i].split(":")
        _, t_hidden, a_hidden = call_log[i + 1].split(":")
        assert (t_exec, a_exec) == (t_hidden, a_hidden), call_log


def test_ac2_hidden_runner_non_bool_return_is_rejected(corpus_root: Path, reports_dir: Path) -> None:
    """Scorer review nit, enforced at the spine boundary: non-bool surfaces here."""

    class BrokenHidden:
        def run_hidden_tests(self, *, task, run_record):
            return 1  # truthy int, NOT a real bool

    with pytest.raises(TypeError):
        run_spine(
            SpineConfig(arms=[baseline()], reps=1, corpus_root=corpus_root),
            executor=SpyExecutor(),
            hidden_test_runner=BrokenHidden(),
            metrics_writer=FakeMetricsWriter(),
            reports_dir=reports_dir,
        )


# ---------------------------------------------------------------------------
# AC3 — dated markdown report under agentrail/evals/reports/ shows baseline vs
#       full solve-rate with spread + $/solved.
# ---------------------------------------------------------------------------


def test_ac3_dated_markdown_report_has_solve_rate_spread_and_dollars(
    corpus_root: Path, reports_dir: Path
) -> None:
    # Pre-program a mixed verdict distribution so the report has signal.
    hidden = HiddenTestSpy(
        outcomes={
            # baseline solves alpha 1/3 reps, never bravo
            ("alpha-task", "baseline"): True,
            # full solves both consistently
            ("alpha-task", "full"): True,
            ("bravo-task", "full"): True,
        },
        default=False,
    )

    # Override per-task-arm reps by using a SpyExecutor that always succeeds at
    # the gate (gate_passed is irrelevant to solved — only hidden tests are).
    executor = SpyExecutor()

    config = SpineConfig(arms=[baseline(), full()], reps=3, corpus_root=corpus_root)

    result = run_spine(
        config,
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    assert result.report_path is not None
    text = result.report_path.read_text(encoding="utf-8")
    assert "baseline" in text and "full" in text
    assert "Solve-rate" in text
    assert "Spread" in text
    assert "Dollars-per-solved-task" in text
    # Date in the file name.
    assert "eval-report-2026-06-23.md" == result.report_path.name


def test_ac3_default_reports_dir_lives_under_evals_reports(corpus_root: Path, tmp_path: Path) -> None:
    from agentrail.evals.reporter import default_reports_dir

    expected = default_reports_dir()
    assert expected.parts[-2:] == ("evals", "reports")


# ---------------------------------------------------------------------------
# AC4 — the SAME numbers go to Postgres via MetricsWriter.
# ---------------------------------------------------------------------------


def test_ac4_metrics_writer_rows_match_arm_reports(corpus_root: Path, reports_dir: Path) -> None:
    writer = FakeMetricsWriter()
    hidden = HiddenTestSpy(
        outcomes={
            ("alpha-task", "full"): True,
            ("bravo-task", "full"): True,
        },
        default=False,
    )

    result = run_spine(
        SpineConfig(arms=[baseline(), full()], reps=2, corpus_root=corpus_root),
        executor=SpyExecutor(),
        hidden_test_runner=hidden,
        metrics_writer=writer,
        reports_dir=reports_dir,
        date="2026-06-23",
        run_id="run-42",
    )

    # Same row count as arms.
    assert len(writer.rows) == len(result.arm_reports)
    by_arm = {row["arm"]: row for row in writer.rows}
    for r in result.arm_reports:
        row = by_arm[r.arm]
        assert row["repetitions"] == r.repetitions
        assert row["solved_count"] == r.solved_count
        assert row["solve_rate"] == r.solve_rate
        assert row["spread"] == r.spread
        assert row["dollars_per_solved"] == r.dollars_per_solved
        assert row["run_id"] == "run-42"


# ---------------------------------------------------------------------------
# Objective Gate false-green probe (issue #940): the scorer's per-run
# false_green flag is carried onto the RepetitionRecord and into the report.
# ---------------------------------------------------------------------------


def test_false_green_flag_propagates_from_verdict_to_record(
    corpus_root: Path, reports_dir: Path
) -> None:
    """A gate-passed run whose hidden tests fail must surface as a false-green.

    The executor passes the gate (gate_passed=True) but the hidden-test runner
    returns False -> the scorer flags false_green=True. The spine must carry
    that scorer flag onto the RepetitionRecord (not re-derive it) and the
    reporter must count it.
    """
    executor = SpyExecutor(gate_passed=True)  # gate passes for every run
    hidden = HiddenTestSpy(default=False)     # but hidden tests always fail

    result = run_spine(
        SpineConfig(arms=[baseline()], reps=1, task_filter=["alpha-task"], corpus_root=corpus_root),
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # The verdict says false-green; the record must echo it verbatim.
    (verdict,) = result.verdicts
    (rep,) = result.repetitions
    assert verdict.false_green is True
    assert rep.false_green is verdict.false_green
    assert rep.gate_passed is verdict.gate_passed

    # And it lands in the aggregate: 1 gate-passed, 1 false-green -> rate 1.0.
    (report,) = result.arm_reports
    assert report.gate_passed_count == 1
    assert report.false_green_count == 1
    assert report.false_green_rate == pytest.approx(1.0)


def test_false_green_rate_none_when_gate_never_passes(
    corpus_root: Path, reports_dir: Path
) -> None:
    """No gate-passed run in the spine -> defined None rate, never a crash."""
    executor = SpyExecutor(gate_passed=False)  # gate fails every run
    hidden = HiddenTestSpy(default=False)

    result = run_spine(
        SpineConfig(arms=[baseline()], reps=2, task_filter=["alpha-task"], corpus_root=corpus_root),
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )
    (report,) = result.arm_reports
    assert report.gate_passed_count == 0
    assert report.false_green_count == 0
    assert report.false_green_rate is None


# ---------------------------------------------------------------------------
# AC5 — corpus + arm selection flags route through to the spine.
# ---------------------------------------------------------------------------


def test_ac5_task_filter_subsets_corpus(corpus_root: Path, reports_dir: Path) -> None:
    executor = SpyExecutor()

    run_spine(
        SpineConfig(
            arms=[baseline()],
            reps=1,
            task_filter=["alpha-task"],
            corpus_root=corpus_root,
        ),
        executor=executor,
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # Only alpha-task ran.
    assert {name for (name, _arm) in executor.invocations} == {"alpha-task"}


def test_ac5_unknown_task_raises(corpus_root: Path, reports_dir: Path) -> None:
    with pytest.raises(ValueError):
        run_spine(
            SpineConfig(
                arms=[baseline()],
                reps=1,
                task_filter=["nope"],
                corpus_root=corpus_root,
            ),
            executor=SpyExecutor(),
            hidden_test_runner=HiddenTestSpy(),
            metrics_writer=FakeMetricsWriter(),
            reports_dir=reports_dir,
        )


def test_ac5_resolve_arm_accepts_full_minus_layer() -> None:
    arm = resolve_arm("full-minus-context")
    assert arm.name == "full-minus-context"
    assert arm.layers.context is False
    # And the other layers are still on.
    assert arm.layers.verify_gate is True


def test_ac5_resolve_arm_rejects_unknown_spec() -> None:
    with pytest.raises(ValueError):
        resolve_arm("garbage")


def test_resolve_arm_accepts_new_flow() -> None:
    """Issue #980 AC4: the new-flow arm name is CLI-selectable via --arm."""
    arm = resolve_arm("new-flow")
    assert arm.name == "new-flow"
    # base layers on + the three new layers enabled + a critic model supplied.
    assert all(arm.layers.as_dict().values())
    assert arm.extra_layers["critic"] is True
    assert arm.extra_layers["bestofn"] is True
    assert arm.extra_layers["warmcache"] is True
    assert arm.critic_model


def test_resolve_arm_accepts_new_flow_minus_layer() -> None:
    arm = resolve_arm("new-flow-minus-warmcache")
    assert arm.name == "new-flow-minus-warmcache"
    assert arm.extra_layers["warmcache"] is False
    assert arm.extra_layers["critic"] is True
    assert arm.extra_layers["bestofn"] is True


# ---------------------------------------------------------------------------
# Default production HiddenTestRunner returns a real ``bool`` (honest no-op).
# ---------------------------------------------------------------------------


def test_unimplemented_hidden_test_runner_returns_real_false(corpus_root: Path) -> None:
    runner = UnimplementedHiddenTestRunner()
    from agentrail.evals.corpus.loader import load_corpus

    tasks = load_corpus(corpus_root)
    record = RunRecord(
        task=tasks[0].name,
        arm="baseline",
        diff="",
        model=MODEL,
        usage=Usage(
            model=MODEL,
            input_tokens=0,
            output_tokens=0,
            cache_tokens=0,
            cache_creation_tokens=0,
        ),
        wall_time_s=0.0,
        gate_passed=True,
    )
    out = runner.run_hidden_tests(task=tasks[0], run_record=record)
    assert out is False
    assert type(out) is bool


# ---------------------------------------------------------------------------
# CLI wiring — the spine is reachable via ``agentrail evals run``.
# ---------------------------------------------------------------------------


def test_cli_evals_run_smoke_drives_spine(corpus_root: Path, reports_dir: Path, capsys) -> None:
    """Tiny --reps 1 smoke run against the smoke executor.

    Proves the CLI is plumbed all the way through to the spine and a markdown
    report is written. Uses ``--smoke`` so we don't spawn the production
    sandbox in tests, AND ``--corpus``/``--task`` to keep it tiny.
    """
    from agentrail.cli.commands.evals import run_evals

    # Point ``--corpus`` at our two-task corpus and restrict to one task.
    rc = run_evals([
        "run",
        "--corpus", str(corpus_root),
        "--task", "alpha-task",
        "--reps", "1",
        "--reports-dir", str(reports_dir),
        "--smoke",
    ])
    out = capsys.readouterr().out
    assert rc == 0
    assert "Eval run id:" in out
    assert "arm=baseline" in out
    assert "arm=full" in out
    assert "Postgres persist:" in out


def test_cli_evals_run_ablation_runs_full_leave_one_out_set(
    corpus_root: Path, reports_dir: Path, capsys
) -> None:
    """``--ablation`` runs baseline, full, and one full-minus-<layer> per layer.

    Proves the enumerable arms registry reaches the spine so per-layer deltas
    have every arm they need (issue #939).
    """
    from agentrail.cli.commands.evals import run_evals
    from agentrail.evals.arms import LAYER_NAMES

    rc = run_evals([
        "run",
        "--corpus", str(corpus_root),
        "--task", "alpha-task",
        "--reps", "1",
        "--reports-dir", str(reports_dir),
        "--ablation",
        "--smoke",
    ])
    out = capsys.readouterr().out
    assert rc == 0
    assert "arm=baseline" in out
    assert "arm=full" in out
    for layer in LAYER_NAMES:
        assert f"arm=full-minus-{layer}" in out
    # The dated markdown report carries the per-layer ablation delta section.
    report = next(reports_dir.glob("eval-report-*.md"))
    text = report.read_text(encoding="utf-8").lower()
    assert "per-layer ablation deltas" in text
    assert "delta" in text


# ---------------------------------------------------------------------------
# Issue #941 — honesty rails at the spine boundary.
#   (1) held-out tasks are excluded from the default run; an explicit flag
#       includes them.
#   (2) each rep's difficulty is threaded onto the RepetitionRecord from the
#       CorpusTask, so the reporter can stratify.
# ---------------------------------------------------------------------------


@pytest.fixture()
def split_corpus_root(tmp_path: Path) -> Path:
    """A corpus with one dev task and one held-out task, spanning difficulty."""
    root = tmp_path / "split-corpus"
    root.mkdir()
    _write_task(root, "dev-task", difficulty="easy", held_out=False)
    _write_task(root, "held-task", difficulty="hard", held_out=True)
    return root


def test_spine_excludes_held_out_tasks_by_default(
    split_corpus_root: Path, reports_dir: Path
) -> None:
    """AC1/AC3: the default spine run never touches the held-out task."""
    executor = SpyExecutor()
    hidden = HiddenTestSpy()
    result = run_spine(
        SpineConfig(arms=[full()], reps=1, corpus_root=split_corpus_root),
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )
    seen = {task for task, _arm in executor.invocations}
    assert seen == {"dev-task"}
    assert all(rep.task == "dev-task" for rep in result.repetitions)


def test_spine_includes_held_out_when_requested(
    split_corpus_root: Path, reports_dir: Path
) -> None:
    """AC1: the explicit include flag adds the held-out task to the run set."""
    executor = SpyExecutor()
    hidden = HiddenTestSpy()
    result = run_spine(
        SpineConfig(
            arms=[full()],
            reps=1,
            corpus_root=split_corpus_root,
            include_held_out=True,
        ),
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )
    seen = {task for task, _arm in executor.invocations}
    assert seen == {"dev-task", "held-task"}


def test_spine_threads_difficulty_into_repetition_records(
    split_corpus_root: Path, reports_dir: Path
) -> None:
    """AC2: each RepetitionRecord carries its CorpusTask's difficulty."""
    result = run_spine(
        SpineConfig(
            arms=[full()],
            reps=1,
            corpus_root=split_corpus_root,
            include_held_out=True,
        ),
        executor=SpyExecutor(),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )
    by_task = {rep.task: rep.difficulty for rep in result.repetitions}
    assert by_task == {"dev-task": "easy", "held-task": "hard"}
    # The reporter then has real strata to break out.
    strata = {s.difficulty for r in result.arm_reports for s in r.strata}
    assert strata == {"easy", "hard"}


# ---------------------------------------------------------------------------
# Issue #960 — thread per-rep RunRecords through the spine so the routing
# cost-regret + retry-lift probes surface in the LIVE dated report (no longer
# "not available"), computed from real RunRecords.
# ---------------------------------------------------------------------------


# Models present in the canonical price table with a clear cheap/expensive gap,
# so routing cost-regret is a real, non-zero dollar figure.
CHEAP_MODEL = "claude-haiku-4-5"
EXPENSIVE_MODEL = "claude-opus-4-5"


@dataclass
class ModelRetryExecutor:
    """Faithful executor producing a KNOWN model/retry mix per (task, arm).

    Mirrors :class:`SandboxAgentExecutor`'s output contract EXACTLY: a real
    ``Usage`` (model pinned per (task, arm)), a real ``bool`` gate decision, the
    resolved model, an empty diff, and real :class:`RetryEvent`s. Nothing
    invented beyond the contract.

    Configured by ``plan``: ``(task, arm) -> (model, gate_passed, retries)``.
    """

    plan: Dict[tuple, tuple] = field(default_factory=dict)

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        model, gate_passed, retries = self.plan[(task.name, arm.name)]
        return AgentExecution(
            diff="",
            usage=Usage(
                model=model,
                input_tokens=1000,
                output_tokens=500,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            model=model,
            gate_passed=bool(gate_passed),
            retries=list(retries),
        )


def _drive_probe_spine(corpus_root: Path, reports_dir: Path):
    """Drive one spine run with a known model/retry/solved mix.

    Returns ``(result, scored_runs_expected)`` where ``scored_runs_expected`` is
    the join built independently from the test's own plan, so the test can assert
    the spine's threaded ``scored_runs`` and the rendered numbers against the
    probe functions directly.
    """
    # alpha solved cheaply on first attempt (the floor); alpha solved expensively
    # with a retry that DID flip it (retry lift); bravo retried but never solved
    # (wasted-retry cost).
    plan = {
        ("alpha-task", "baseline"): (
            CHEAP_MODEL,
            True,
            [],
        ),
        ("alpha-task", "full"): (
            EXPENSIVE_MODEL,
            True,
            # first attempt's gate failed, the retry flipped it -> retry-attributed
            [RetryEvent(attempt=1, model=EXPENSIVE_MODEL, gate_passed=False, reason="gate red")],
        ),
        ("bravo-task", "baseline"): (
            CHEAP_MODEL,
            False,
            [RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False, reason="gate red")],
        ),
        ("bravo-task", "full"): (
            EXPENSIVE_MODEL,
            False,
            [],
        ),
    }
    # Hidden-test outcomes mirror the "solved" intent of the plan above.
    hidden = HiddenTestSpy(
        outcomes={
            ("alpha-task", "baseline"): True,
            ("alpha-task", "full"): True,
            ("bravo-task", "baseline"): False,
            ("bravo-task", "full"): False,
        },
        default=False,
    )
    executor = ModelRetryExecutor(plan=plan)
    config = SpineConfig(arms=[baseline(), full()], reps=1, corpus_root=corpus_root)
    result = run_spine(
        config,
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-24",
    )
    return result


def test_issue960_spine_carries_scored_runs(corpus_root: Path, reports_dir: Path) -> None:
    """The spine threads a ScoredRun (RunRecord + solved) per rep on the result."""
    result = _drive_probe_spine(corpus_root, reports_dir)
    assert hasattr(result, "scored_runs")
    # 2 tasks * 2 arms * 1 rep = 4 scored runs.
    assert len(result.scored_runs) == 4
    for sr in result.scored_runs:
        assert isinstance(sr, ScoredRun)
        assert isinstance(sr.run, RunRecord)
        assert isinstance(sr.solved, bool)
    # solved must match the join (alpha solves, bravo fails).
    by_key = {(sr.run.task, sr.run.arm): sr.solved for sr in result.scored_runs}
    assert by_key == {
        ("alpha-task", "baseline"): True,
        ("alpha-task", "full"): True,
        ("bravo-task", "baseline"): False,
        ("bravo-task", "full"): False,
    }
    # Models recorded from the executor (routing input).
    by_model = {(sr.run.task, sr.run.arm): sr.run.model for sr in result.scored_runs}
    assert by_model[("alpha-task", "baseline")] == CHEAP_MODEL
    assert by_model[("alpha-task", "full")] == EXPENSIVE_MODEL


def test_issue960_ac1_dated_report_shows_routing_and_retry_probes(
    corpus_root: Path, reports_dir: Path
) -> None:
    """AC1: the dated report's probe section is populated, not 'not available'."""
    result = _drive_probe_spine(corpus_root, reports_dir)
    assert result.report_path is not None
    text = result.report_path.read_text(encoding="utf-8")

    # The probe section headers are present.
    assert "Routing cost-regret" in text
    assert "Retry lift" in text
    # And they are NOT the "not available" placeholders.
    assert "Not available: this report carries no per-run records" not in text
    # Real figures surface.
    assert "Total routing cost-regret:" in text
    assert "With-retry solve-rate:" in text
    assert "Wasted-retry cost:" in text


def test_issue960_ac2_rendered_numbers_match_probe_functions(
    corpus_root: Path, reports_dir: Path
) -> None:
    """AC2: rendered numbers equal probes.routing_cost_regret / retry_lift."""
    result = _drive_probe_spine(corpus_root, reports_dir)
    scored = list(result.scored_runs)

    expected_routing = routing_cost_regret(scored)
    expected_retry = retry_lift(scored)

    from agentrail.evals.reporter import _fmt_usd, _fmt_rate_pct

    text = result.report_path.read_text(encoding="utf-8")

    # Routing total regret string must appear verbatim.
    assert (
        f"Total routing cost-regret: {_fmt_usd(expected_routing.total_regret_usd)}"
        in text
    )
    # Retry lift numbers must appear verbatim.
    assert (
        f"With-retry solve-rate: {_fmt_rate_pct(expected_retry.with_retry_solve_rate)}"
        in text
    )
    assert (
        f"First-attempt-only solve-rate: "
        f"{_fmt_rate_pct(expected_retry.first_attempt_solve_rate)}" in text
    )
    assert f"Retry lift: {_fmt_rate_pct(expected_retry.lift)}" in text
    assert (
        f"Wasted-retry cost: {_fmt_usd(expected_retry.wasted_retry_cost_usd)}" in text
    )

    # Sanity: the fixture exercises real regret (expensive solved alpha vs cheap
    # floor) and real wasted-retry (bravo baseline retried but never solved).
    assert expected_routing.total_regret_usd > 0.0
    assert expected_retry.wasted_retry_cost_usd > 0.0
    assert expected_retry.lift is not None and expected_retry.lift > 0.0


def test_issue960_ac3_no_regression_existing_sections_still_render(
    corpus_root: Path, reports_dir: Path
) -> None:
    """AC3: all existing report sections still present alongside the probes."""
    result = _drive_probe_spine(corpus_root, reports_dir)
    text = result.report_path.read_text(encoding="utf-8")

    # Headline + honesty-rail sections (must not regress).
    assert "Per-arm summary" in text
    assert "Solve-rate" in text
    assert "Spread" in text
    assert "Dollars-per-solved-task" in text
    assert "Per-layer ablation deltas" in text
    assert "Difficulty-stratified breakdown" in text
    assert "Failures, ties, and spread" in text
    assert "Objective Gate false-green rate" in text
    # Guardrail catch-rate (the probe that already rendered) still present.
    assert "Guardrail injection-corpus catch-rate" in text


# ---------------------------------------------------------------------------
# Concurrency — independent (task, arm, rep) units run in parallel so a full
# corpus run finishes in ~the slowest single unit instead of the SUM of all
# units. Correctness (same verdicts, deterministic order) must be preserved.
# ---------------------------------------------------------------------------


@dataclass
class _BlockingExecutor:
    """Executor that records how many calls are in-flight at once.

    Each ``execute`` increments a shared counter, briefly blocks, then
    decrements — so ``max_in_flight`` reveals the real parallelism the spine
    achieved. Faithful to the production output contract (real Usage + bool).
    """

    _lock: "object"
    in_flight: int = 0
    max_in_flight: int = 0

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        import time

        with self._lock:
            self.in_flight += 1
            if self.in_flight > self.max_in_flight:
                self.max_in_flight = self.in_flight
        # Hold the slot long enough that genuinely-parallel units overlap.
        time.sleep(0.05)
        with self._lock:
            self.in_flight -= 1
        return AgentExecution(
            diff="",
            usage=Usage(
                model=arm.model,
                input_tokens=10,
                output_tokens=5,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            model=arm.model,
            gate_passed=True,
            retries=[],
        )


def test_concurrency_runs_units_in_parallel(corpus_root: Path, reports_dir: Path) -> None:
    import threading

    executor = _BlockingExecutor(_lock=threading.Lock())
    hidden = HiddenTestSpy(default=True)
    # 2 tasks * 2 arms * 2 reps = 8 units, 4 at a time.
    config = SpineConfig(
        arms=[baseline(), full()], reps=2, corpus_root=corpus_root, concurrency=4
    )

    result = run_spine(
        config,
        executor=executor,
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    assert len(result.repetitions) == 8
    # The whole point: more than one unit was actually in flight at once.
    assert executor.max_in_flight > 1


def test_concurrency_preserves_order_and_verdicts(corpus_root: Path, reports_dir: Path) -> None:
    """A parallel run yields the SAME repetition order + verdicts as a serial one."""
    arms = [baseline(), full()]
    # Deterministic, mixed solved/failed distribution keyed by (task, arm).
    outcomes = {
        ("alpha-task", "baseline"): True,
        ("alpha-task", "full"): True,
        ("bravo-task", "baseline"): False,
        ("bravo-task", "full"): True,
    }

    def _run(concurrency: int):
        executor = SpyExecutor()
        hidden = HiddenTestSpy(outcomes=outcomes, default=False)
        config = SpineConfig(
            arms=arms, reps=3, corpus_root=corpus_root, concurrency=concurrency
        )
        return run_spine(
            executor=executor,
            hidden_test_runner=hidden,
            metrics_writer=FakeMetricsWriter(),
            reports_dir=reports_dir,
            date="2026-06-23",
            config=config,
        )

    serial = _run(1)
    parallel = _run(4)

    serial_seq = [(r.task, r.arm, r.solved) for r in serial.repetitions]
    parallel_seq = [(r.task, r.arm, r.solved) for r in parallel.repetitions]
    assert parallel_seq == serial_seq
    # And the aggregate numbers match exactly.
    serial_rates = {a.arm: a.solve_rate for a in serial.arm_reports}
    parallel_rates = {a.arm: a.solve_rate for a in parallel.arm_reports}
    assert parallel_rates == serial_rates


# ---------------------------------------------------------------------------
# Resilience — an interrupted or partially-failing run must STILL yield a
# scorecard for whatever completed, instead of all-or-nothing zero output.
# ---------------------------------------------------------------------------


def test_report_is_checkpointed_after_each_unit(corpus_root: Path, reports_dir: Path) -> None:
    """The dated report is rewritten as units complete, not only at the end.

    A spy hidden-test runner asserts the report file already exists and holds
    the first task's row WHILE the second task is still being scored — proving
    the on-disk scorecard tracks progress (so a kill mid-run keeps partial data).
    """
    from agentrail.evals.reporter import default_reports_dir  # noqa: F401

    seen_report_sizes: List[int] = []

    class _CheckpointProbe:
        def __init__(self) -> None:
            self.calls = 0

        def run_hidden_tests(self, *, task: CorpusTask, run_record: RunRecord) -> bool:
            self.calls += 1
            # On the 2nd unit, the report from the 1st must already be on disk.
            report = reports_dir / "eval-report-2026-06-23.md"
            seen_report_sizes.append(report.stat().st_size if report.exists() else 0)
            return True

    config = SpineConfig(
        arms=[baseline()], reps=1, corpus_root=corpus_root, concurrency=1
    )
    run_spine(
        config,
        executor=SpyExecutor(),
        hidden_test_runner=_CheckpointProbe(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # Two tasks → two units. By the 2nd unit's scoring, a report already existed
    # on disk with content (the 1st unit's checkpoint).
    assert len(seen_report_sizes) == 2
    assert seen_report_sizes[1] > 0


def test_one_failing_unit_does_not_abort_the_run(corpus_root: Path, reports_dir: Path) -> None:
    """A unit that raises is scored as an unsolved failure; the run continues."""

    class _ExplodingExecutor(SpyExecutor):
        def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
            if task.name == "alpha-task":
                raise RuntimeError("boom: simulated crash in alpha-task")
            return super().execute(task=task, arm=arm, workdir=workdir)

    hidden = HiddenTestSpy(default=True)
    config = SpineConfig(
        arms=[baseline()], reps=1, corpus_root=corpus_root, concurrency=2
    )
    result = run_spine(
        config,
        executor=_ExplodingExecutor(),
        hidden_test_runner=hidden,
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-06-23",
    )

    # Both tasks are present: the crashed one as failed, the healthy one solved.
    by_task = {r.task: r.solved for r in result.repetitions}
    assert by_task == {"alpha-task": False, "bravo-task": True}


# ---------------------------------------------------------------------------
# #1029 END-TO-END: pack precision/recall are POPULATED on a real run, and the
# rerank arm actually toggles retrieval.
#
# The prior tests drive the spine with a synthetic corpus_root whose
# ``requiredContext`` points at a file that does not exist in any built index,
# so they never exercise the offline pack scorer against real retrieval. These
# two tests close the false-green hole flagged in review:
#
#   1. A real spine run with ``pack_index_root`` set to this checkout (which has
#      a built context index) renders REAL "Pack precision"/"Pack recall" rows
#      in the markdown report — not ``n/a``. This proves Blocker 1 is wired: the
#      pack scores are computed in the run loop and threaded through BOTH
#      write_markdown_report call sites.
#
#   2. The ``full`` (rerank ON) and ``full-minus-rerank`` (rerank OFF) arms
#      produce a genuinely DIFFERENT cited set for the same task. This proves
#      Blocker 2 is wired: the arm's rerank flag actually reaches the retrieval
#      stage (via AGENTRAIL_CONTEXT_RERANK), so the ablation is not a no-op.
#
# Both need the real ~70MB index, so they SKIP (never silently pass) when the
# checkout has no built index — e.g. a CI runner that did not build one.
# ---------------------------------------------------------------------------


def _repo_root_with_index() -> Optional[Path]:
    """This git checkout's root, iff it carries a built context index.

    Returns ``None`` when the root can't be resolved or has no index, so the
    e2e tests below can ``skip`` honestly rather than pass without exercising
    real retrieval.
    """
    import subprocess

    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    root = Path(out.stdout.strip())
    if not root:
        return None
    if not (root / ".agentrail" / "context" / "index" / "index.json").is_file():
        return None
    return root


def test_e2e_pack_precision_recall_populated_on_real_run(reports_dir: Path) -> None:
    """A real spine run with ``pack_index_root`` renders numbers, not ``n/a``.

    Drives the ACTUAL spine over one real bundled corpus task with the ``full``
    and ``full-minus-rerank`` arms and ``pack_index_root`` set to this checkout.
    The offline pack scorer runs real retrieval against the built index and the
    report's rerank section shows measured Pack precision/recall — the exact
    thing that rendered ``n/a`` on every real eval before this fix.
    """
    root = _repo_root_with_index()
    if root is None:
        pytest.skip("no built context index in this checkout; pack scoring is n/a")

    config = SpineConfig(
        arms=[full(), full_minus("rerank")],
        reps=1,
        # One real bundled task (its requiredContext resolves against this
        # checkout, which is what the index covers). Keeps retrieval to a
        # single query per arm.
        task_filter=["context-rerank"],
        corpus_root=None,  # bundled corpus v0
        pack_index_root=root,
        concurrency=1,
    )

    result = run_spine(
        config,
        executor=SpyExecutor(),
        hidden_test_runner=HiddenTestSpy(default=True),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-03",
    )

    assert result.report_path is not None
    text = result.report_path.read_text(encoding="utf-8")

    # The rerank section exists and its precision/recall rows carry MEASURED
    # values, not the undefined sentinel. _fmt_ratio renders a defined ratio as
    # "0.xxx" and an undefined one as "n/a".
    assert "## Rerank arm (full vs full-minus-rerank)" in text
    pack_lines = [
        ln for ln in text.splitlines() if ln.startswith("| Pack precision |")
    ]
    recall_lines = [
        ln for ln in text.splitlines() if ln.startswith("| Pack recall |")
    ]
    assert pack_lines, f"no Pack precision row in report:\n{text}"
    assert recall_lines, f"no Pack recall row in report:\n{text}"
    # Both the `full` and `full-minus-rerank` cells must be measured numbers.
    # (The row is "| Pack precision | <full> | <ablation> | <delta> |".)
    full_p, ablation_p = pack_lines[0].split("|")[2:4]
    full_r, ablation_r = recall_lines[0].split("|")[2:4]
    for cell in (full_p, ablation_p, full_r, ablation_r):
        assert cell.strip() != "n/a", (
            "pack precision/recall rendered n/a on a real run with a built "
            f"index — Blocker 1 not wired. Row cells: {pack_lines[0]!r} / "
            f"{recall_lines[0]!r}"
        )


def test_e2e_rerank_flag_toggles_the_cited_set() -> None:
    """`full` (rerank ON) and `full-minus-rerank` (OFF) cite a DIFFERENT set.

    This is the falsifiability guarantee for the #1029 rerank arm: if the arm's
    rerank flag did NOT reach the retrieval stage, both arms would retrieve the
    identical pack and every precision/recall delta would be a hard zero (a
    no-op ablation). Driving the real offline scorer for both arms and asserting
    the cited sets differ proves the AGENTRAIL_CONTEXT_RERANK bridge is live.
    """
    root = _repo_root_with_index()
    if root is None:
        pytest.skip("no built context index in this checkout; retrieval unavailable")

    from agentrail.context.index import load_index
    from agentrail.evals.corpus.loader import load_corpus
    from agentrail.evals.pack_scoring import _cited_paths

    task = next(t for t in load_corpus() if t.name == "context-rerank")
    index = load_index(root)

    # Hold expansion OFF for BOTH arms so this stays a clean rerank-only
    # ablation — expansion is a separate retrieval seam, pinned on its own by
    # test_cited_paths_scopes_expansion_env_per_arm below.
    cited_on = _cited_paths(root, task.prompt, rerank=True, expansion=False, index=index)
    cited_off = _cited_paths(root, task.prompt, rerank=False, expansion=False, index=index)

    # Retrieval returned something for both (guard against an empty-index no-op
    # that would make the sets trivially "equal" as two empty lists).
    assert cited_on, "rerank-ON retrieval returned no cited paths"
    assert cited_off, "rerank-OFF retrieval returned no cited paths"
    # The whole point of the ablation: turning rerank off changes the pack.
    assert cited_on != cited_off, (
        "rerank ON and OFF produced an IDENTICAL cited set — the arm's rerank "
        "flag is not reaching the retrieval stage (no-op ablation)"
    )


def test_cited_paths_scopes_expansion_env_per_arm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_cited_paths` writes the expansion env token per arm, then restores it.

    The offline pack scorer mutates the CURRENT process env (unlike the runner's
    fresh subprocess), so it must write BOTH directions explicitly — ``"1"`` for
    the ``full`` arm, ``"0"`` for ``full-minus-expansion`` — never "set for on,
    unset for off". Otherwise an inherited ``AGENTRAIL_CONTEXT_QUERY_EXPANSION=1``
    (e.g. from an AFK env) would leak into the minus-expansion arm and silently
    turn the recall ablation into a no-op. This pins the env token retrieval sees
    at call time plus the restoration afterward. The retrieval call is faked, so
    it needs no built index and runs everywhere — not just where a ~70MB index
    exists (unlike the two e2e tests above, which skip without one).
    """
    import os

    from agentrail.evals.pack_scoring import _cited_paths

    captured: List[Dict[str, Optional[str]]] = []

    def fake_query_context(root, query, **kwargs):  # noqa: ANN001, ANN202
        # Record what retrieval would actually read at call time.
        captured.append(
            {
                "expansion": os.environ.get("AGENTRAIL_CONTEXT_QUERY_EXPANSION"),
                "rerank": os.environ.get("AGENTRAIL_CONTEXT_RERANK"),
            }
        )
        # Mirror the real return shape so the path/citation dedup runs too.
        return {"results": [{"path": "a.py"}, {"citation": "b.py"}, {"path": "a.py"}]}

    # `_cited_paths` imports query_context lazily from this module, so patching
    # the source attribute is what the late `from ... import` binds to.
    monkeypatch.setattr(
        "agentrail.context.retrieval.query_context", fake_query_context
    )

    # --- Scenario A: an ambient truthy value is present (the leak case). ---
    monkeypatch.setenv("AGENTRAIL_CONTEXT_QUERY_EXPANSION", "1")

    off = _cited_paths(Path("."), "q", rerank=True, expansion=False, index={})
    on = _cited_paths(Path("."), "q", rerank=False, expansion=True, index={})

    # The minus-expansion arm OVERRODE the inherited "1" to "0" at call time —
    # this is the whole point: without it the ablation is a silent no-op.
    assert captured[0]["expansion"] == "0"
    assert captured[1]["expansion"] == "1"
    # rerank moved in lockstep through the same overrides dict.
    assert captured[0]["rerank"] == "1"
    assert captured[1]["rerank"] == "0"
    # Ambient value restored after each scoped call (never leaked a flag).
    assert os.environ["AGENTRAIL_CONTEXT_QUERY_EXPANSION"] == "1"
    # The cited list still parses path|citation and de-dups, preserving order.
    assert off == ["a.py", "b.py"]
    assert on == ["a.py", "b.py"]

    # --- Scenario B: NO ambient value (proves restore = pop, not leave "1"). ---
    captured.clear()
    monkeypatch.delenv("AGENTRAIL_CONTEXT_QUERY_EXPANSION", raising=False)

    _cited_paths(Path("."), "q", rerank=True, expansion=True, index={})

    assert captured[0]["expansion"] == "1"
    # Restored to ABSENT — scoping did not leak a global flag into the process.
    assert "AGENTRAIL_CONTEXT_QUERY_EXPANSION" not in os.environ


# ---------------------------------------------------------------------------
# Gather token-reduction + cache-hit report (#1049 AC4) — the spine appends the
# section to the dated report. Without a ledger it renders the honest
# "not available" note; with an arm-tagged ledger it renders real numbers.
# ---------------------------------------------------------------------------


def test_gather_report_section_renders_not_available_without_ledger(
    corpus_root: Path, reports_dir: Path
) -> None:
    result = run_spine(
        SpineConfig(arms=[baseline(), full()], reps=1, corpus_root=corpus_root),
        executor=SpyExecutor(),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )
    text = result.report_path.read_text(encoding="utf-8")
    # The section always renders so it is discoverable...
    assert "Gather token-reduction + cache-hit (#1049 AC4)" in text
    # ...and honestly says it needs a live run (never a fabricated 0).
    assert "Not available" in text and "need a live" in text


def test_gather_report_section_populated_with_arm_tagged_ledger(
    corpus_root: Path, reports_dir: Path, tmp_path: Path
) -> None:
    # Drive real cost events through the whole seam — the executor leaves a
    # per-phase ledger in its workdir (exactly where the live pipeline does),
    # the runner harvests it before teardown, the spine tags each row with the
    # arm and appends to the aggregate ledger, and the report reads that.
    #
    # full (gather OFF): fat execute context. full-plus-gather (ON): a small
    # gather phase, then a shrunk execute context.
    ledger = tmp_path / "cost-events.jsonl"
    cost_events_for = {
        "full": [
            {"run_id": "off", "phase": "execute", "input_tokens": 9000,
             "output_tokens": 1000, "cache_tokens": 1000, "cache_creation_tokens": 0},
            {"run_id": "off", "phase": "verify", "input_tokens": 1000,
             "output_tokens": 100, "cache_tokens": 500, "cache_creation_tokens": 0},
        ],
        "full-plus-gather": [
            {"run_id": "on", "phase": "gather", "input_tokens": 1500,
             "output_tokens": 400, "cache_tokens": 0, "cache_creation_tokens": 600},
            {"run_id": "on", "phase": "execute", "input_tokens": 3000,
             "output_tokens": 1000, "cache_tokens": 1200, "cache_creation_tokens": 0},
            {"run_id": "on", "phase": "verify", "input_tokens": 1000,
             "output_tokens": 100, "cache_tokens": 500, "cache_creation_tokens": 0},
        ],
    }

    result = run_spine(
        SpineConfig(
            arms=gather_arms(),
            reps=1,
            # One task per arm so execute-context sums stay 10000 / 4200 rather
            # than doubling across the two-task corpus.
            task_filter=["alpha-task"],
            corpus_root=corpus_root,
            cost_ledger_path=ledger,
        ),
        executor=SpyExecutor(cost_events_for=cost_events_for),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )
    text = result.report_path.read_text(encoding="utf-8")
    assert "Gather token-reduction + cache-hit (#1049 AC4)" in text
    assert "full-plus-gather" in text
    # Execute-context: OFF 10000 (9000+1000) vs ON 4200 (3000+1200) → dropped.
    assert "10000" in text and "4200" in text
    assert "DROPPED with gather ON" in text

    # The spine truncated the caller's path then re-filled it from harvested
    # per-run events, each stamped with its arm — 2 full rows, 3 gather rows.
    ledger_rows = [
        json.loads(line)
        for line in ledger.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(ledger_rows) == 5
    assert sum(1 for r in ledger_rows if r["arm"] == "full") == 2
    assert sum(1 for r in ledger_rows if r["arm"] == "full-plus-gather") == 3


def test_gather_ledger_skips_network_artifact_runs(
    corpus_root: Path, reports_dir: Path, tmp_path: Path
) -> None:
    """A <synthetic> (ECONNRESET) run must NOT pollute the cost ledger.

    Its token counts are a network artifact, not a real measurement — letting
    them into the aggregate would fake a token delta. The spine gates the append
    on ``not network_artifact``; here the gather arm falls back to synthetic, so
    only the real ``full`` arm's rows survive.
    """
    ledger = tmp_path / "cost-events.jsonl"
    cost_events_for = {
        "full": [
            {"run_id": "off", "phase": "execute", "input_tokens": 9000,
             "output_tokens": 1000, "cache_tokens": 1000, "cache_creation_tokens": 0},
        ],
        "full-plus-gather": [
            {"run_id": "on", "phase": "execute", "input_tokens": 3000,
             "output_tokens": 1000, "cache_tokens": 1200, "cache_creation_tokens": 0},
        ],
    }

    run_spine(
        SpineConfig(
            arms=gather_arms(),
            reps=1,
            task_filter=["alpha-task"],
            corpus_root=corpus_root,
            cost_ledger_path=ledger,
        ),
        # The gather arm's run degraded to the synthetic network-artifact marker.
        executor=SpyExecutor(
            cost_events_for=cost_events_for,
            model_for={"full-plus-gather": SYNTHETIC_MODEL},
        ),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )

    ledger_rows = [
        json.loads(line)
        for line in ledger.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    # Only the real (full) arm's row survives; the synthetic run was skipped.
    assert [r["arm"] for r in ledger_rows] == ["full"]


def test_gather_ledger_append_is_thread_safe_under_concurrency(
    corpus_root: Path, reports_dir: Path, tmp_path: Path
) -> None:
    """Concurrent runs append to the shared ledger without losing rows.

    The two-task corpus × two arms at concurrency 2 drives overlapping appends;
    the spine's lock must serialize them so every harvested row lands exactly
    once (2 tasks × 2 arms × 1 row = 4 rows).
    """
    ledger = tmp_path / "cost-events.jsonl"
    one_row = [
        {"run_id": "x", "phase": "execute", "input_tokens": 100,
         "output_tokens": 10, "cache_tokens": 0, "cache_creation_tokens": 0},
    ]
    cost_events_for = {"full": one_row, "full-plus-gather": one_row}

    run_spine(
        SpineConfig(
            arms=gather_arms(),
            reps=1,
            corpus_root=corpus_root,  # both alpha-task and bravo-task
            cost_ledger_path=ledger,
            concurrency=2,
        ),
        executor=SpyExecutor(cost_events_for=cost_events_for),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )

    ledger_rows = [
        line for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    # 2 tasks × 2 arms × 1 row each — none lost, none torn by interleaved writes.
    assert len(ledger_rows) == 4
    parsed = [json.loads(line) for line in ledger_rows]
    assert sum(1 for r in parsed if r["arm"] == "full") == 2
    assert sum(1 for r in parsed if r["arm"] == "full-plus-gather") == 2


# ---------------------------------------------------------------------------
# Gather file-picking PRECISION section (#1049 AC4, precision half) — the spine
# appends it right after the token section, rendered from the in-memory
# RunRecords' ``gather_score`` (no file plumbing). Without a scored run it renders
# the honest "not available" note; with a manifest it renders the AC4 verdict.
# ---------------------------------------------------------------------------


def test_gather_precision_section_not_available_without_a_scored_run(
    corpus_root: Path, reports_dir: Path
) -> None:
    """No gather phase ran → the precision section says it needs a live run."""
    result = run_spine(
        SpineConfig(arms=[baseline(), full()], reps=1, corpus_root=corpus_root),
        executor=SpyExecutor(),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )
    text = result.report_path.read_text(encoding="utf-8")
    # The precision section always renders so it is discoverable...
    assert "Gather file-picking precision (#1049 AC4)" in text
    # ...and honestly says it needs a live run (never a fabricated 0 or verdict).
    assert "Not available: no run carried a gather score" in text
    assert "CLEARS AC4" not in text
    assert "MISSES AC4" not in text


def test_gather_precision_section_renders_ac4_verdict_from_manifest(
    corpus_root: Path, reports_dir: Path
) -> None:
    """A gather manifest picking the required file → the precision section PASSES.

    The gather arm's executor leaves a CONTEXT MANIFEST naming the task's single
    required file (``agentrail/evals/spine.py``); the runner scores it (precision
    1.0, recall 1.0) onto the RunRecord, and the spine pools it into the section.
    """
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- agentrail/evals/spine.py:1-40 — the answer-key file\n"
        "Checked, not relevant:\n"
        "- checked agentrail/evals/runner.py — the runner, not the change\n"
    )
    result = run_spine(
        SpineConfig(
            arms=gather_arms(),
            reps=1,
            task_filter=["alpha-task"],
            corpus_root=corpus_root,
        ),
        executor=SpyExecutor(gather_manifest_for={"full-plus-gather": manifest}),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )
    text = result.report_path.read_text(encoding="utf-8")
    assert "Gather file-picking precision (#1049 AC4)" in text
    # The gather arm picked exactly the required file → pooled 1.00 / 1.00 → PASS.
    assert "full-plus-gather" in text
    assert "CLEARS AC4" in text
    assert "MISSES AC4" not in text


def test_gather_precision_section_flags_a_wrong_manifest(
    corpus_root: Path, reports_dir: Path
) -> None:
    """A manifest picking the WRONG file → the precision section is FLAGGED.

    Guards the false-green the user forbids: the gatherer running is not enough —
    it must point at the RIGHT files, or the section must say do NOT turn it on.
    """
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- agentrail/evals/runner.py:1-10 — wrong pick, not the answer key\n"
    )
    result = run_spine(
        SpineConfig(
            arms=gather_arms(),
            reps=1,
            task_filter=["alpha-task"],
            corpus_root=corpus_root,
        ),
        executor=SpyExecutor(gather_manifest_for={"full-plus-gather": manifest}),
        hidden_test_runner=HiddenTestSpy(),
        metrics_writer=FakeMetricsWriter(),
        reports_dir=reports_dir,
        date="2026-07-09",
    )
    text = result.report_path.read_text(encoding="utf-8")
    assert "MISSES AC4" in text and "FLAGGED" in text
    assert "Do NOT turn the gather flag on" in text
