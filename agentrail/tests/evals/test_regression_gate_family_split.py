"""AC3 (issue #1223): ``regression_gate.evaluate_regression`` runs UNCHANGED
against a family-held-out corpus subset.

This is the falsifiable claim behind AC3: the gate never imports, reads, or
special-cases ``family`` — ``agentrail/evals/regression_gate.py`` has ZERO
diff in this change (verified separately by ``git diff``; see the task
report). It only ever sees whatever ``RepetitionRecord``s a caller hands it.
This test proves that claim end-to-end: build a real corpus spanning two
families, use ``load_corpus(..., held_out_family=...)`` (the new #1223
surface) to get a family-reduced task set, run the UNMODIFIED
``evaluate_regression`` over reps drawn from exactly that reduced set, and
confirm it produces a correct, family-blind verdict — the excluded family's
tasks never appear in the gate's per-task evidence, and the gate needed no
code change to make that true.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

from agentrail.evals.corpus.loader import load_corpus
from agentrail.evals.regression_gate import GateVerdict, evaluate_regression
from agentrail.evals.reporter import RepetitionRecord
from agentrail.run.usage_capture import Usage

MODEL = "claude-sonnet-4-5"


def _usage(*, output_tokens: int = 500) -> Usage:
    return Usage(
        model=MODEL,
        input_tokens=1_000,
        output_tokens=output_tokens,
        cache_tokens=0,
        cache_creation_tokens=0,
    )


def _write_task(root: Path, name: str, *, family: str, difficulty: str = "easy") -> None:
    task_dir = root / name
    answer = task_dir / "answer_key"
    answer.mkdir(parents=True)
    (answer / "test_x.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")
    record = {
        "name": name,
        "repo": "Bensigo/agentrail",
        "commit": "deadbeef",
        "prompt": f"Solve {name}.",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {"root": "answer_key", "files": ["test_x.py"]},
        "requiredContext": ["agentrail/example/module.py"],
        "difficulty": difficulty,
        "family": family,
    }
    (task_dir / "task.json").write_text(json.dumps(record), encoding="utf-8")


def _reps(task: str, arm: str, solved_flags: List[bool]) -> List[RepetitionRecord]:
    return [
        RepetitionRecord(task=task, arm=arm, solved=flag, usage=_usage())
        for flag in solved_flags
    ]


def test_evaluate_regression_runs_unmodified_against_family_held_out_corpus(
    tmp_path: Path,
) -> None:
    root = tmp_path / "corpus"
    root.mkdir()
    # Two families: 'bug' (2 tasks) stays in the dev set; 'feature' (2 tasks)
    # is the family we hold out for this run.
    _write_task(root, "bug-one", family="bug")
    _write_task(root, "bug-two", family="bug")
    _write_task(root, "feature-one", family="feature")
    _write_task(root, "feature-two", family="feature")

    # AC2 surface: load the family-reduced task set.
    reduced_tasks = load_corpus(root, held_out_family="feature")
    reduced_names = {t.name for t in reduced_tasks}
    assert reduced_names == {"bug-one", "bug-two"}

    # Build reps ONLY for the reduced (family-held-out) task set — a
    # genuinely degraded candidate arm on both remaining tasks, seeded to
    # trip the gate the same way test_regression_gate.py's AC1 fixture does.
    records: List[RepetitionRecord] = []
    for name in reduced_names:
        records += _reps(name, "baseline", [True] * 5)
        records += _reps(name, "degraded", [True] * 1 + [False] * 4)

    # The UNMODIFIED gate — imported straight from its canonical home, no
    # family-aware branch anywhere in it (regression_gate.py has zero diff
    # in this change; see agentrail/evals/regression_gate.py::evaluate_regression).
    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="degraded"
    )

    # It produced a confident, correct verdict...
    assert report.verdict is GateVerdict.RED
    assert report.solve_rate.regressed is True

    # ...and its per-task evidence covers EXACTLY the family-reduced set —
    # the held-out family's tasks never reached the gate at all, because
    # load_corpus did the filtering upstream, not the gate.
    evidenced_tasks = {d.task for d in report.per_task_deltas}
    assert evidenced_tasks == reduced_names
    assert "feature-one" not in evidenced_tasks
    assert "feature-two" not in evidenced_tasks


def test_evaluate_regression_family_reduced_corpus_can_also_stay_green(
    tmp_path: Path,
) -> None:
    """Same wiring, opposite outcome: a non-regressing candidate over a
    family-reduced corpus reads GREEN — the gate's three-way verdict logic
    is exercised unchanged, not just the RED path."""
    root = tmp_path / "corpus"
    root.mkdir()
    for i in range(4):
        _write_task(root, f"refactor-{i}", family="refactor")
    for i in range(4):
        _write_task(root, f"infra-{i}", family="infra")

    reduced_tasks = load_corpus(root, held_out_family="infra")
    reduced_names = sorted(t.name for t in reduced_tasks)
    assert reduced_names == [f"refactor-{i}" for i in range(4)]

    # Fully saturated, ZERO jitter between arms (identical rep-by-rep flags):
    # two tasks solved every rep, two failed every rep. Per-task paired
    # variance is exactly 0 (no jitter to resolve), so the gate's power calc
    # hits its "any real separation is perfectly detectable" branch — a
    # confident GREEN is earnable from a handful of tasks/reps, unlike the
    # jittery mid-range fixtures elsewhere in this suite that need many more.
    records: List[RepetitionRecord] = []
    for i, name in enumerate(reduced_names):
        flags = [True] * 5 if i % 2 == 0 else [False] * 5
        records += _reps(name, "baseline", flags)
        records += _reps(name, "candidate", flags)

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )

    assert report.verdict is GateVerdict.GREEN
    evidenced_tasks = {d.task for d in report.per_task_deltas}
    assert evidenced_tasks == set(reduced_names)
    assert not any(name.startswith("infra-") for name in evidenced_tasks)
