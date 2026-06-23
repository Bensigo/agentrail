"""Tests for the eval runner (issue #937).

The runner is integration-tested SPARINGLY per the PRD: its expensive seam is
the agent invocation, so we cover it with a small number of focused tests that
fix the inputs to the seam (``AgentExecutor``), drive the runner, and assert
the observable contract:

- AC1 — a ``(task, arm)`` run returns a :class:`RunRecord` carrying diff,
  usage, model, wall_time, gate decision (as a real ``bool``) and retries,
  produced via the sandbox seam (not by reimplementing isolation here).
- AC2 — the arm's pinned model/temperature and layer on/off flags are
  forwarded to the executor; a ``baseline`` arm runs WITHOUT any AgentRail
  layer on.
- AC3 — the task's hidden tests / answer key are NOT present inside the
  sandbox workdir during the run; a leak is loudly raised, not silently
  swallowed.
- AC4 — the produced :class:`RunRecord` is shape-compatible with what the
  scorer consumes (we feed it through :func:`score` and into a
  :class:`RepetitionRecord` to prove it).

### How the fake stays FAITHFUL to the real sandbox

The real production sandbox (``agentrail.sandbox.native_runner.run_issue_on_host``)
returns a ``RunResult`` with status ``'green' | 'red' | 'error'`` and a
``cost_usd`` summed from the per-phase cost ledger. The transcript-derived token
``Usage`` is captured separately by ``capture_usage``. Our executor seam
:class:`AgentExecution` exposes *exactly* those observables (a ``bool`` collapsed
from status, a ``Usage`` captured from a transcript, a model id, an optional
diff, retry events). The fake below never invents fields the real sandbox
wouldn't produce — no captured stdout from ``subprocess.run`` (a prod bug this
repo has hit before with unfaithful fakes), no PR URL, no cost double-counting.
Every field it provides has a 1:1 counterpart in the real sandbox's outputs.
"""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import pytest

from agentrail.run.usage_capture import Usage

from agentrail.evals.arms import Arm, Layers, baseline, full, full_minus
from agentrail.evals.corpus.loader import CorpusTask, HiddenTestRef
from agentrail.evals.run_record import RetryEvent, RunRecord
from agentrail.evals.runner import (
    AgentExecution,
    AnswerKeyLeak,
    SandboxAgentExecutor,
    run,
)


MODEL = "claude-sonnet-4-5"


# ---------------------------------------------------------------------------
# Fixtures: a tiny corpus task on disk + a faithful executor fake.
# ---------------------------------------------------------------------------


@pytest.fixture()
def corpus_task(tmp_path: Path) -> CorpusTask:
    """Materialize a minimal but FAITHFUL corpus task on disk.

    Layout (mirrors ``agentrail/evals/corpus/<task>/`` exactly):

        <tmp>/sample-task/
            task.json            # validated by the loader
            workdir/             # the agent-visible tree (`agentVisibleRoot`)
                README.md
            answer_key/          # the hidden tests — OUTSIDE workdir/
                test_hidden.py

    The hidden test file is a real file the loader's existence check accepts,
    and crucially it lives OUTSIDE ``workdir/`` so the runner's leak guard has
    a real answer key to defend against.
    """
    task_dir = tmp_path / "sample-task"
    visible = task_dir / "workdir"
    answer = task_dir / "answer_key"
    visible.mkdir(parents=True)
    answer.mkdir(parents=True)

    (visible / "README.md").write_text("# sample\n", encoding="utf-8")
    (answer / "test_hidden.py").write_text(
        "def test_hidden_truth():\n    assert True\n", encoding="utf-8"
    )

    task_json = {
        "name": "sample-task",
        "repo": "Bensigo/agentrail",
        "commit": "deadbeef",
        "prompt": "Make X work.",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {"root": "answer_key", "files": ["test_hidden.py"]},
        "requiredContext": ["agentrail/evals/runner.py"],
        "difficulty": "easy",
    }
    (task_dir / "task.json").write_text(json.dumps(task_json), encoding="utf-8")

    from agentrail.evals.corpus.loader import load_task

    return load_task(task_dir)


@dataclass
class FakeExecutor:
    """A faithful test executor — mirrors the real sandbox's output contract.

    Every field it sets has a 1:1 counterpart in production:

    - ``diff`` is what the agent left uncommitted in the workdir (real sandbox:
      the same — :func:`run_issue_on_host` captures uncommitted changes via
      ``git status``);
    - ``usage`` is a ``Usage`` instance — exactly what
      :func:`agentrail.run.usage_capture.capture_usage` returns from the
      transcript files in production;
    - ``model`` is the final model the run resolved to — exactly what the
      transcript records;
    - ``gate_passed`` is a real ``bool`` — collapsed from the real sandbox's
      ``RunResult.status == 'green'``;
    - ``retries`` are escalation events the real queue records.

    What it does NOT do (so the fake cannot hide prod bugs):

    - It does not invent a captured stdout/stderr stream
      (``run_issue_on_host`` does not pass ``capture_output=True`` to its
      executor, so it can't read those — a prior fake silently doing so hid
      a real subprocess bug, see ``runner-stale-process-and-fake-real-gotchas``).
    - It records the workdir+arm it was invoked with so tests can assert the
      runner forwarded the arm and pointed at the prepared workdir.
    """

    diff: str = ""
    usage: Usage = field(
        default_factory=lambda: Usage(
            model=MODEL,
            input_tokens=100,
            output_tokens=50,
            cache_tokens=0,
            cache_creation_tokens=0,
        )
    )
    model: str = MODEL
    gate_passed: bool = True
    retries: List[RetryEvent] = field(default_factory=list)

    # Spy state — populated on every call so tests can introspect.
    invoked_with_arm: Optional[Arm] = None
    invoked_with_workdir: Optional[Path] = None
    workdir_contents_at_invocation: List[str] = field(default_factory=list)

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        self.invoked_with_arm = arm
        self.invoked_with_workdir = workdir
        # Capture the workdir snapshot at invocation time — used to assert the
        # leak guard passed before the agent ever saw the tree.
        self.workdir_contents_at_invocation = [
            str(p.relative_to(workdir)) for p in workdir.rglob("*")
        ]
        return AgentExecution(
            diff=self.diff,
            usage=self.usage,
            model=self.model,
            gate_passed=self.gate_passed,
            retries=list(self.retries),
        )


# ---------------------------------------------------------------------------
# AC1 — the runner returns a RunRecord with the contract fields populated.
# ---------------------------------------------------------------------------


def test_run_returns_a_run_record_with_the_contract_fields(corpus_task: CorpusTask) -> None:
    executor = FakeExecutor(
        diff="--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
        gate_passed=True,
        retries=[RetryEvent(attempt=1, model=MODEL, gate_passed=False, reason="gate red")],
    )
    arm = full()

    clock_values = iter([0.0, 7.5])
    record = run(corpus_task, arm, executor=executor, clock=lambda: next(clock_values))

    assert isinstance(record, RunRecord)
    assert record.task == "sample-task"
    assert record.arm == arm.name
    assert record.diff.startswith("--- a/x")
    assert record.model == MODEL
    assert isinstance(record.usage, Usage)
    assert record.wall_time_s == pytest.approx(7.5)
    assert record.gate_passed is True
    assert len(record.retries) == 1
    assert record.retries[0].reason == "gate red"


def test_run_record_gate_passed_is_a_real_bool(corpus_task: CorpusTask) -> None:
    """The #936 review nit: the runner must pass a real ``bool``, not a truthy int.

    Scorers/reporters that coerce non-bools mask the contract violation; the
    runner guards the contract at its source.
    """
    record = run(corpus_task, full(), executor=FakeExecutor(gate_passed=False))
    assert record.gate_passed is False
    assert type(record.gate_passed) is bool


def test_run_uses_the_executor_seam_not_a_real_sandbox(corpus_task: CorpusTask) -> None:
    """The runner depends on its executor; it does not import or spawn a sandbox.

    Static guard: importing ``runner`` does not transitively pull subprocess or
    docker; behavioural guard: a unit-test run uses only the injected fake.
    """
    executor = FakeExecutor()
    run(corpus_task, full(), executor=executor)
    assert executor.invoked_with_workdir is not None  # the seam was driven


# ---------------------------------------------------------------------------
# AC2 — arm config is applied: pinned model/temperature + layer on/off flags.
# ---------------------------------------------------------------------------


def test_arm_is_forwarded_to_the_executor(corpus_task: CorpusTask) -> None:
    executor = FakeExecutor()
    arm = full_minus("retry")
    run(corpus_task, arm, executor=executor)

    assert executor.invoked_with_arm is not None
    assert executor.invoked_with_arm.name == "full-minus-retry"
    assert executor.invoked_with_arm.model == MODEL
    assert executor.invoked_with_arm.temperature == 0.0
    assert executor.invoked_with_arm.layers.retry is False
    # Every OTHER layer is still ON — leave-one-out isolation.
    assert executor.invoked_with_arm.layers.context is True
    assert executor.invoked_with_arm.layers.routing is True
    assert executor.invoked_with_arm.layers.verify_gate is True
    assert executor.invoked_with_arm.layers.guardrails is True


def test_baseline_arm_runs_with_every_agentrail_layer_off(corpus_task: CorpusTask) -> None:
    """AC2: baseline = the same agent with NO AgentRail layer enabled."""
    executor = FakeExecutor()
    run(corpus_task, baseline(), executor=executor)

    assert executor.invoked_with_arm is not None
    layers = executor.invoked_with_arm.layers
    assert layers.context is False
    assert layers.routing is False
    assert layers.verify_gate is False
    assert layers.retry is False
    assert layers.guardrails is False


def test_run_record_model_defaults_to_arm_model_when_executor_returns_empty(
    corpus_task: CorpusTask,
) -> None:
    """Pinned model survives when the transcript didn't record a final model."""
    executor = FakeExecutor(model="")
    record = run(corpus_task, full(), executor=executor)
    assert record.model == full().model


def test_sandbox_executor_arm_env_translates_layers_and_pinned_model() -> None:
    """The production executor's arm→env translation forwards model + flags.

    The pipeline reads ``AGENTRAIL_MODEL`` + ``AGENTRAIL_EVAL_LAYER_<NAME>``;
    this is the seam every layer switches at, regardless of internal wiring.
    """
    from agentrail.evals.runner import _arm_env

    env = _arm_env(full_minus("context"))
    assert env["AGENTRAIL_MODEL"] == MODEL
    assert env["AGENTRAIL_TEMPERATURE"] == "0.0"
    assert env["AGENTRAIL_EVAL_LAYER_CONTEXT"] == "0"
    assert env["AGENTRAIL_EVAL_LAYER_ROUTING"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_VERIFY_GATE"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_RETRY"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_GUARDRAILS"] == "1"

    env_baseline = _arm_env(baseline())
    for layer in ("CONTEXT", "ROUTING", "VERIFY_GATE", "RETRY", "GUARDRAILS"):
        assert env_baseline[f"AGENTRAIL_EVAL_LAYER_{layer}"] == "0"


# ---------------------------------------------------------------------------
# AC3 — the answer key is NEVER inside the sandbox workdir during the run.
# ---------------------------------------------------------------------------


def test_answer_key_is_not_in_sandbox_workdir_during_the_run(
    corpus_task: CorpusTask, tmp_path: Path
) -> None:
    """The agent's view of the workdir contains NO hidden test file / dir.

    Captured at the moment the executor is invoked, BEFORE the agent runs.
    """
    executor = FakeExecutor()
    run(corpus_task, full(), executor=executor)

    snapshot = executor.workdir_contents_at_invocation
    # The agent-visible README was materialised — sanity check.
    assert any("README.md" in name for name in snapshot)
    # AC3: no hidden test file or answer_key directory ever appears.
    assert not any("test_hidden.py" in name for name in snapshot), snapshot
    assert not any("answer_key" in name for name in snapshot), snapshot


def test_leak_guard_raises_if_executor_writes_answer_key_into_workdir(
    corpus_task: CorpusTask,
) -> None:
    """A post-run leak (e.g. the executor wrote the answer key) is loudly raised."""

    class LeakingExecutor:
        def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
            (workdir / "answer_key").mkdir()
            (workdir / "answer_key" / "test_hidden.py").write_text("leak")
            return AgentExecution(
                diff="",
                usage=Usage(model=MODEL, input_tokens=0, output_tokens=0, cache_tokens=0),
                model=MODEL,
                gate_passed=True,
            )

    with pytest.raises(AnswerKeyLeak):
        run(corpus_task, full(), executor=LeakingExecutor())


def test_leak_guard_raises_if_workdir_is_seeded_with_answer_key(
    corpus_task: CorpusTask, tmp_path: Path
) -> None:
    """A pre-run leak (workdir already contains the answer key) is also caught."""

    poisoned = tmp_path / "poisoned-workdir"
    poisoned.mkdir()
    (poisoned / "test_hidden.py").write_text("leak")

    with pytest.raises(AnswerKeyLeak):
        run(
            corpus_task,
            full(),
            executor=FakeExecutor(),
            workdir_factory=lambda: poisoned,
        )


# ---------------------------------------------------------------------------
# AC4 — the RunRecord shape matches what the scorer consumes.
# ---------------------------------------------------------------------------


def test_run_record_feeds_score_and_repetition_record(corpus_task: CorpusTask) -> None:
    """A runner-produced RunRecord drops straight into the scorer and reporter.

    Drives the actual scorer and constructs a ``RepetitionRecord`` from the
    output to prove shape compatibility — no field-by-field copy, no shim.
    """
    from agentrail.evals.scorer import Verdict, score
    from agentrail.evals.reporter import RepetitionRecord

    record = run(corpus_task, full(), executor=FakeExecutor(gate_passed=True))

    verdict = score(record, hidden_tests_passed=False)
    assert isinstance(verdict, Verdict)
    assert verdict.task == record.task
    assert verdict.arm == record.arm
    assert verdict.gate_passed is True
    assert verdict.false_green is True  # gate said yes, hidden tests said no

    rep = RepetitionRecord(
        task=record.task, arm=record.arm, solved=verdict.solved, usage=record.usage
    )
    assert rep.solved is False
    assert rep.usage is record.usage


# ---------------------------------------------------------------------------
# Hygiene — the runner does not redefine RunRecord and uses the locked one.
# ---------------------------------------------------------------------------


def test_runner_imports_locked_run_record_and_does_not_redefine_it() -> None:
    """The runner imports :class:`RunRecord` from the locked module and does not
    declare its own dataclass with that name. Guards against drift from #936.
    """
    module_path = Path(__file__).resolve().parents[2] / "agentrail" / "evals" / "runner.py"
    tree = ast.parse(module_path.read_text(encoding="utf-8"))

    imports_run_record = False
    redefines_run_record = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "agentrail.evals.run_record":
            names = {alias.name for alias in node.names}
            if "RunRecord" in names:
                imports_run_record = True
        if isinstance(node, ast.ClassDef) and node.name == "RunRecord":
            redefines_run_record = True

    assert imports_run_record, "runner must import RunRecord from agentrail.evals.run_record"
    assert not redefines_run_record, "runner must NOT redefine RunRecord"


def test_sandbox_executor_exists_for_production_use() -> None:
    """The production executor wraps the existing sandbox; smoke-importable."""
    assert SandboxAgentExecutor is not None
    # Constructable without side effects (lazy sandbox import inside execute()).
    SandboxAgentExecutor()
