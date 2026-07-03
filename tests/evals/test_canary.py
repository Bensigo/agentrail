"""Tests for the nightly eval canary (issue #1041).

The canary is the scheduled-Action entrypoint. It adds exactly three policies on
top of the already-built spine, and each is tested here with faithful fakes (no
network, no sandbox), mirroring ``tests/evals/test_spine.py``:

  - **Fail-closed auth** (PRD §5): missing server link ⇒ raise / non-zero exit.
  - **Dated report** (AC1): the canary produces ``eval-report-YYYY-MM-DD.md``,
    reusing the spine's writer (so it carries strata + per-component cost +
    network-artifact counts, AC2), and EXCLUDES ``<synthetic>`` reps.
  - **Telemetry not dark** (AC3): per-arm rows are pushed via the writer bound to
    the validated link target; a validated-but-failed push is surfaced.

Plus a dependency-free structural check of the scheduled workflow YAML
(``.github/workflows/eval-canary.yml``): a GitHub Action file is invisible to the
Python test job, so we assert its schedule/trigger/steps/fail-closed wiring here.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import pytest

from agentrail.evals.arms import Arm, baseline, full
from agentrail.evals.canary import (
    CANARY_TASKS,
    CanaryAuthError,
    CanaryResult,
    run_canary,
)
from agentrail.evals.corpus.loader import CorpusTask, load_task
from agentrail.evals.run_record import RunRecord
from agentrail.evals.runner import SYNTHETIC_MODEL, AgentExecution
from agentrail.evals.spine import run_spine
from agentrail.run.usage_capture import Usage


MODEL = "claude-sonnet-4-5"


# ---------------------------------------------------------------------------
# A tiny corpus holding one task per difficulty stratum, matching the shape the
# real corpus uses. Faithful: task.json + a separately-stored answer key.
# ---------------------------------------------------------------------------


def _write_task(root: Path, name: str, *, difficulty: str) -> CorpusTask:
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
        "requiredContext": ["agentrail/evals/canary.py"],
        "difficulty": difficulty,
    }
    (task_dir / "task.json").write_text(json.dumps(task_json), encoding="utf-8")
    return load_task(task_dir)


@pytest.fixture()
def canary_corpus(tmp_path: Path) -> Path:
    """A corpus whose task NAMES match the real CANARY_TASKS, one per stratum."""
    root = tmp_path / "corpus"
    root.mkdir()
    difficulties = ("easy", "medium", "hard")
    for name, difficulty in zip(CANARY_TASKS, difficulties):
        _write_task(root, name, difficulty=difficulty)
    return root


@pytest.fixture()
def reports_dir(tmp_path: Path) -> Path:
    return tmp_path / "reports"


# ---------------------------------------------------------------------------
# Faithful fakes for the injectable seams.
# ---------------------------------------------------------------------------


@dataclass
class FakeExecutor:
    """Faithful executor — matches SandboxAgentExecutor's AgentExecution shape.

    Can be programmed to emit a ``<synthetic>`` (ECONNRESET-fallback) execution
    for a specific (task, arm) so the canary's report exercises the #1033
    exclusion end-to-end through the REAL spine/reporter.
    """

    gate_passed: bool = True
    # (task, arm) whose run should be marked a network artifact (synthetic).
    synthetic_for: Sequence[tuple] = field(default_factory=tuple)

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        if (task.name, arm.name) in set(self.synthetic_for):
            # Faithful ECONNRESET fallback: model == SYNTHETIC_MODEL, empty diff,
            # zero usage — exactly what the runner records on a network artifact.
            return AgentExecution(
                diff="",
                usage=Usage(
                    model=SYNTHETIC_MODEL,
                    input_tokens=0,
                    output_tokens=0,
                    cache_tokens=0,
                    cache_creation_tokens=0,
                ),
                model=SYNTHETIC_MODEL,
                gate_passed=False,
                retries=[],
            )
        return AgentExecution(
            diff="",
            usage=Usage(
                model=arm.model,
                input_tokens=100,
                output_tokens=50,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            model=arm.model,
            gate_passed=bool(self.gate_passed),
            retries=[],
        )


@dataclass
class FakeHiddenTestRunner:
    """Faithful hidden-test runner — returns a real bool per (task, arm)."""

    default: bool = True

    def run_hidden_tests(self, *, task: CorpusTask, run_record: RunRecord) -> bool:
        return bool(self.default)


class CapturingMetricsWriter:
    """Captures the rows the canary pushes (AC3 telemetry-not-dark)."""

    def __init__(self, ok: bool = True) -> None:
        self.rows: List[dict] = []
        self.calls = 0
        self._ok = ok

    def write_arm_metrics(self, rows: Sequence[dict]) -> bool:
        self.calls += 1
        self.rows.extend(list(rows))
        return self._ok


def _link(_target: Path) -> Dict[str, str]:
    """A configured link loader (auth present)."""
    return {
        "base_url": "https://example.test",
        "api_key": "k",
        "repository_id": "r",
    }


def _no_link(_target: Path) -> None:
    """An UNconfigured link loader (auth absent) — the fail-closed case."""
    return None


# ---------------------------------------------------------------------------
# Fail-closed auth (PRD §5): missing link ⇒ CanaryAuthError, nothing runs.
# ---------------------------------------------------------------------------


def test_fails_closed_when_auth_link_absent(canary_corpus: Path, reports_dir: Path) -> None:
    """No server link ⇒ raise CanaryAuthError BEFORE any spine/executor work."""
    executor = FakeExecutor()

    def _explode_spine(*args, **kwargs):  # pragma: no cover - must NOT be called
        raise AssertionError("spine ran despite missing auth — NOT fail-closed")

    with pytest.raises(CanaryAuthError):
        run_canary(
            target=reports_dir,
            corpus_root=canary_corpus,
            reports_dir=reports_dir,
            link_loader=_no_link,
            executor=executor,
            hidden_test_runner=FakeHiddenTestRunner(),
            metrics_writer=CapturingMetricsWriter(),
            spine_runner=_explode_spine,
        )


def test_fail_closed_does_not_fall_through_to_unauthenticated_run(
    canary_corpus: Path, reports_dir: Path
) -> None:
    """The fail-closed path writes NO report — it never silently runs partial."""
    with pytest.raises(CanaryAuthError):
        run_canary(
            target=reports_dir,
            corpus_root=canary_corpus,
            reports_dir=reports_dir,
            link_loader=_no_link,
            executor=FakeExecutor(),
            hidden_test_runner=FakeHiddenTestRunner(),
        )
    # No dated report should have been produced by the aborted run.
    assert not reports_dir.exists() or not list(reports_dir.glob("eval-report-*.md"))


# ---------------------------------------------------------------------------
# AC1 — produces a dated report on its own (name carries the run date).
# ---------------------------------------------------------------------------


def test_produces_dated_report(canary_corpus: Path, reports_dir: Path) -> None:
    result = run_canary(
        target=reports_dir,
        corpus_root=canary_corpus,
        reports_dir=reports_dir,
        date="2026-07-03",
        link_loader=_link,
        executor=FakeExecutor(),
        hidden_test_runner=FakeHiddenTestRunner(),
        metrics_writer=CapturingMetricsWriter(),
        spine_runner=run_spine,  # REAL spine — genuinely writes the report.
    )
    assert isinstance(result, CanaryResult)
    assert result.report_path is not None
    assert result.report_path.name == "eval-report-2026-07-03.md"
    assert result.report_path.is_file()
    assert result.run_id == "canary-2026-07-03"


# ---------------------------------------------------------------------------
# AC2 — the report carries strata + per-component cost + network-artifact
#       counts (reused from the spine, exercised through the real reporter).
# ---------------------------------------------------------------------------


def test_report_contains_strata_and_cost_and_network_artifacts(
    canary_corpus: Path, reports_dir: Path
) -> None:
    # Mark ONE (task, arm) as a synthetic ECONNRESET fallback so the network-
    # artifact section renders (it only appears when there is something to
    # disclose, #1033 AC4).
    executor = FakeExecutor(synthetic_for=[("objective-gate-unified", "full")])
    result = run_canary(
        target=reports_dir,
        corpus_root=canary_corpus,
        reports_dir=reports_dir,
        date="2026-07-03",
        link_loader=_link,
        executor=executor,
        hidden_test_runner=FakeHiddenTestRunner(),
        metrics_writer=CapturingMetricsWriter(),
        spine_runner=run_spine,
    )
    text = result.report_path.read_text(encoding="utf-8")
    # Strata (AC2): the difficulty-stratified breakdown, with all three strata.
    assert "## Difficulty-stratified breakdown" in text
    for difficulty in ("easy", "medium", "hard"):
        assert difficulty in text
    # Per-component cost (AC2): the four-component cost breakdown section.
    assert "## Cost breakdown" in text
    assert "Cache-read $" in text
    # Network-artifact counts (AC2): the #1033 exclusion disclosure.
    assert "Network artifacts (excluded from all metrics):" in text


def test_synthetic_reps_excluded_from_scoring(
    canary_corpus: Path, reports_dir: Path
) -> None:
    """A <synthetic> rep must NOT count as a real (failed) score (#1033 reuse)."""
    # Make EVERY rep of the hard task's `full` arm synthetic, and solve the rest.
    executor = FakeExecutor(
        gate_passed=True,
        synthetic_for=[("objective-gate-unified", "full")],
    )
    result = run_canary(
        target=reports_dir,
        corpus_root=canary_corpus,
        reports_dir=reports_dir,
        date="2026-07-03",
        reps=2,
        link_loader=_link,
        executor=executor,
        hidden_test_runner=FakeHiddenTestRunner(default=True),
        metrics_writer=CapturingMetricsWriter(),
        spine_runner=run_spine,
    )
    # The `full` arm's report must EXCLUDE the 2 synthetic hard-task reps from
    # its counted repetitions (3 tasks * 2 reps = 6, minus 2 synthetic = 4).
    full_report = next(r for r in result.spine_result.arm_reports if r.arm == "full")
    assert full_report.network_artifact_count == 2
    assert full_report.repetitions == 4  # synthetic reps not counted as reps
    # And none of the excluded reps drag solve-rate down as a fake failure: the
    # 4 counted reps were all solved.
    assert full_report.solved_count == 4


# ---------------------------------------------------------------------------
# AC3 — canary telemetry is NOT dark: rows are pushed and persist is surfaced.
# ---------------------------------------------------------------------------


def test_pushes_telemetry_not_dark(canary_corpus: Path, reports_dir: Path) -> None:
    writer = CapturingMetricsWriter(ok=True)
    result = run_canary(
        target=reports_dir,
        corpus_root=canary_corpus,
        reports_dir=reports_dir,
        date="2026-07-03",
        link_loader=_link,
        executor=FakeExecutor(),
        hidden_test_runner=FakeHiddenTestRunner(),
        metrics_writer=writer,
        spine_runner=run_spine,
    )
    # The writer was actually called with per-arm rows (not the silent-skip path).
    assert writer.calls == 1
    assert writer.rows, "canary pushed no telemetry rows — the live lane is dark"
    arms_pushed = {row.get("arm") for row in writer.rows}
    assert {"baseline", "full"} <= arms_pushed
    # Every row is tagged with the canary run id so the gate can find these runs.
    assert all(row.get("run_id") == "canary-2026-07-03" for row in writer.rows)
    assert result.persist_ok is True


def test_failed_push_after_valid_link_is_surfaced(
    canary_corpus: Path, reports_dir: Path
) -> None:
    """A validated link whose ingest returns non-202 ⇒ persist_ok False (AC3)."""
    writer = CapturingMetricsWriter(ok=False)
    result = run_canary(
        target=reports_dir,
        corpus_root=canary_corpus,
        reports_dir=reports_dir,
        date="2026-07-03",
        link_loader=_link,
        executor=FakeExecutor(),
        hidden_test_runner=FakeHiddenTestRunner(),
        metrics_writer=writer,
        spine_runner=run_spine,
    )
    assert writer.calls == 1  # push WAS attempted (not dark)
    assert result.persist_ok is False  # ...but honestly reported as failed


# ---------------------------------------------------------------------------
# AC4 — bounded, documented corpus subset (one task per difficulty stratum).
# ---------------------------------------------------------------------------


def test_canary_tasks_are_one_per_difficulty_stratum() -> None:
    """The bounded subset is exactly three tasks, one per real difficulty."""
    from agentrail.evals.corpus.loader import load_corpus

    corpus = {t.name: t for t in load_corpus()}
    # All canary tasks exist in the real corpus...
    for name in CANARY_TASKS:
        assert name in corpus, f"canary task {name!r} missing from the real corpus"
    # ...and they cover exactly the three difficulty strata (bounded cost + full
    # strata rendering).
    difficulties = sorted(corpus[name].difficulty for name in CANARY_TASKS)
    assert difficulties == ["easy", "hard", "medium"]
    # None of them is held-out (the canary must never run against a reserved task).
    for name in CANARY_TASKS:
        assert corpus[name].held_out is False


def test_canary_restricts_to_the_bounded_subset(
    canary_corpus: Path, reports_dir: Path
) -> None:
    """The canary runs ONLY the bounded subset — no full-corpus blowout."""
    seen_tasks: set = set()

    real_executor = FakeExecutor()

    class RecordingExecutor:
        def execute(self, *, task, arm, workdir):
            seen_tasks.add(task.name)
            return real_executor.execute(task=task, arm=arm, workdir=workdir)

    run_canary(
        target=reports_dir,
        corpus_root=canary_corpus,
        reports_dir=reports_dir,
        date="2026-07-03",
        link_loader=_link,
        executor=RecordingExecutor(),
        hidden_test_runner=FakeHiddenTestRunner(),
        metrics_writer=CapturingMetricsWriter(),
        spine_runner=run_spine,
    )
    assert seen_tasks == set(CANARY_TASKS)


# ---------------------------------------------------------------------------
# The scheduled workflow YAML — a GitHub Action file is invisible to the Python
# test job, so assert its schedule/trigger/steps/fail-closed wiring here.
# ---------------------------------------------------------------------------


def _workflow_path() -> Path:
    # tests/evals/test_canary.py -> repo root -> .github/workflows/eval-canary.yml
    return (
        Path(__file__).resolve().parents[2]
        / ".github"
        / "workflows"
        / "eval-canary.yml"
    )


def test_workflow_file_exists_and_is_separate_from_ci() -> None:
    path = _workflow_path()
    assert path.is_file(), "the scheduled canary workflow file must exist"
    # It must be a SEPARATE file — ci.yml must not be the canary carrier.
    assert path.name == "eval-canary.yml"


def test_workflow_has_schedule_dispatch_and_fail_closed_steps() -> None:
    """Structural checks that hold with or without PyYAML installed."""
    text = _workflow_path().read_text(encoding="utf-8")
    # Scheduled trigger (AC1) + a nightly cron.
    assert "schedule:" in text
    assert "cron:" in text
    # Manual trigger for verification.
    assert "workflow_dispatch:" in text
    # Runs the canary subcommand (reuse, not a new engine).
    assert "evals canary" in text
    # Fail-closed auth: the three required server secrets are wired as env.
    assert "AGENTRAIL_SERVER_BASE_URL" in text
    assert "AGENTRAIL_SERVER_API_KEY" in text
    assert "AGENTRAIL_SERVER_REPOSITORY_ID" in text


def test_workflow_parses_as_yaml_when_pyyaml_available() -> None:
    """If PyYAML is present, assert the parsed structure (schedule/steps)."""
    yaml = pytest.importorskip("yaml")
    doc = yaml.safe_load(_workflow_path().read_text(encoding="utf-8"))
    # NOTE: YAML parses the bare `on:` key as boolean True, so accept either.
    triggers = doc.get("on", doc.get(True))
    assert triggers is not None, "workflow has no trigger block"
    assert "schedule" in triggers
    assert "workflow_dispatch" in triggers
    schedule = triggers["schedule"]
    assert isinstance(schedule, list) and schedule
    assert "cron" in schedule[0]
    # A single job with real steps that run the canary.
    jobs = doc["jobs"]
    assert jobs, "workflow has no jobs"
    job = next(iter(jobs.values()))
    steps = job["steps"]
    joined = json.dumps(steps)
    assert "evals canary" in joined
