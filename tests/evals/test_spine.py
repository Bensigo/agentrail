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

from agentrail.evals.arms import Arm, baseline, full, full_minus
from agentrail.evals.corpus.loader import CorpusTask, load_task
from agentrail.evals.reporter import MetricsWriter, RepetitionRecord
from agentrail.evals.run_record import RunRecord
from agentrail.evals.runner import AgentExecution
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


def _write_task(root: Path, name: str) -> CorpusTask:
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
        "difficulty": "easy",
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

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        self.invocations.append((task.name, arm.name))
        snapshot = [p.name for p in workdir.rglob("*") if p.is_file()]
        self.workdir_snapshots.append(snapshot)
        if self.call_log is not None:
            self.call_log.append(f"exec:{task.name}:{arm.name}")
        # Real bool — never int/None. Faithful to SandboxAgentExecutor's
        # ``RunResult.status == 'green'`` collapse.
        gate = bool(self.verdicts_for.get((task.name, arm.name), self.gate_passed))
        return AgentExecution(
            diff=self.diff,
            usage=Usage(
                model=arm.model,
                input_tokens=100,
                output_tokens=50,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            model=arm.model,
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
