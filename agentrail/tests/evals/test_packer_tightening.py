"""Offline packer-tightening A/B, gated through the two-set regression gate
(issue #1225 AC2).

Exercises the FULL wiring end to end —
``tightened_packer_arms() -> run_spine(...) -> evaluate_regression(...)`` —
with a faithful in-process fake executor and the honest no-op hidden-test
runner (mirrors ``agentrail evals run --smoke``): no network, no real agent,
no cost. This is the "SMALL, cheap fixture / dry run" that proves the
mechanism runs correctly; it deliberately does NOT attempt a real,
model-calling A/B (see the CLI docstring / this issue's report for the exact
command that runs the real thing).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Sequence

import pytest

from agentrail.cli.commands.evals import SmokeFakeExecutor
from agentrail.evals.arms import full, tightened_packer_arm
from agentrail.evals.corpus.loader import CorpusTask, load_task
from agentrail.evals.packer_tightening import (
    run_packer_tightening_ab,
    render_packer_tightening_markdown,
)
from agentrail.evals.regression_gate import GateVerdict
from agentrail.evals.spine import UnimplementedHiddenTestRunner


def _write_task(root: Path, name: str) -> CorpusTask:
    task_dir = root / name
    visible = task_dir / "workdir"
    answer = task_dir / "answer_key"
    visible.mkdir(parents=True)
    answer.mkdir(parents=True)
    (visible / "README.md").write_text(f"# {name}\n", encoding="utf-8")
    (answer / "test_hidden.py").write_text(
        "def test_truth():\n    assert True\n", encoding="utf-8"
    )
    task_json = {
        "name": name,
        "repo": "Bensigo/agentrail",
        "commit": "deadbeef",
        "prompt": f"Solve {name}.",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {"root": "answer_key", "files": ["test_hidden.py"]},
        "requiredContext": ["workdir/README.md"],
        "difficulty": "easy",
        "heldOut": False,
    }
    (task_dir / "task.json").write_text(json.dumps(task_json), encoding="utf-8")
    return load_task(task_dir)


@pytest.fixture()
def corpus_root(tmp_path: Path) -> Path:
    root = tmp_path / "corpus"
    root.mkdir()
    # 3 tasks so the paired set clears the gate's min_paired_tasks=3 floor —
    # otherwise every dry run would report INSUFFICIENT_REPS regardless of
    # whether the wiring is correct, which would prove nothing.
    for name in ("alpha-task", "bravo-task", "charlie-task"):
        _write_task(root, name)
    return root


class _FakeMetricsWriter:
    """In-memory sink — proves the spine's persist step never touches the
    network during a dry run (mirrors the spy pattern in test_spine.py)."""

    def __init__(self) -> None:
        self.rows: list = []

    def write_arm_metrics(self, rows: Sequence[dict]) -> bool:
        self.rows.extend(list(rows))
        return True


def test_run_packer_tightening_ab_wires_full_vs_tightened_through_the_gate(
    corpus_root: Path, tmp_path: Path
) -> None:
    writer = _FakeMetricsWriter()

    result = run_packer_tightening_ab(
        reps=3,
        corpus_root=corpus_root,
        reports_dir=tmp_path / "reports",
        concurrency=1,
        executor=SmokeFakeExecutor(),
        hidden_test_runner=UnimplementedHiddenTestRunner(),
        metrics_writer=writer,
    )

    # The two arms actually run are the real #1225 AC2 pair, not a stand-in.
    assert result.spine_result.repetitions
    arms_run = {rep.arm for rep in result.spine_result.repetitions}
    assert arms_run == {full().name, tightened_packer_arm().name}
    # 3 tasks * 2 arms * 3 reps.
    assert len(result.spine_result.repetitions) == 18

    # The comparison is entirely the EXISTING two-set gate's own output — this
    # module invented no new statistics.
    report = result.gate_report
    assert report.baseline_arm == full().name
    assert report.candidate_arm == tightened_packer_arm().name
    assert report.verdict in (
        GateVerdict.GREEN,
        GateVerdict.RED,
        GateVerdict.INSUFFICIENT_REPS,
    )
    # Deterministic fake (never solved, identical in both arms) -> every task
    # ties, and a tie corpus this size + this saturated is confidently GREEN
    # (zero variance -> full power), not just "not enough data".
    assert report.verdict == GateVerdict.GREEN
    assert len(report.per_task_deltas) == 3
    assert all(d.is_tie for d in report.per_task_deltas)

    # The budgets actually compared are recorded (the piece the generic gate
    # report has no notion of).
    assert result.tightened_budget < result.baseline_budget


def test_run_packer_tightening_ab_reuses_the_regression_gate_verbatim(
    corpus_root: Path, tmp_path: Path
) -> None:
    """AC3 guard: this module must not compute its own pass/fail — the report
    it returns is exactly what ``evaluate_regression`` would produce given the
    same repetitions, proving no parallel gate was invented."""
    from agentrail.evals.regression_gate import evaluate_regression

    writer = _FakeMetricsWriter()
    result = run_packer_tightening_ab(
        reps=3,
        corpus_root=corpus_root,
        reports_dir=tmp_path / "reports",
        concurrency=1,
        executor=SmokeFakeExecutor(),
        hidden_test_runner=UnimplementedHiddenTestRunner(),
        metrics_writer=writer,
    )

    independently_gated = evaluate_regression(
        result.spine_result.repetitions,
        baseline_arm=full().name,
        candidate_arm=tightened_packer_arm().name,
    )
    assert result.gate_report == independently_gated


def test_render_includes_the_budgets_and_the_gate_verdict(
    corpus_root: Path, tmp_path: Path
) -> None:
    writer = _FakeMetricsWriter()
    result = run_packer_tightening_ab(
        reps=3,
        corpus_root=corpus_root,
        reports_dir=tmp_path / "reports",
        concurrency=1,
        executor=SmokeFakeExecutor(),
        hidden_test_runner=UnimplementedHiddenTestRunner(),
        metrics_writer=writer,
    )
    markdown = render_packer_tightening_markdown(result)
    assert "#1225 AC2" in markdown
    assert str(result.baseline_budget) in markdown
    assert str(result.tightened_budget) in markdown
    assert result.gate_report.verdict.value in markdown
