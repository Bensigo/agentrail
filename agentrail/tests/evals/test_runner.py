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

from agentrail.evals.arms import (
    Arm,
    Layers,
    baseline,
    full,
    full_minus,
    new_flow,
    new_flow_minus,
)
from agentrail.evals.corpus.loader import CorpusTask, HiddenTestRef
from agentrail.evals.run_record import RetryEvent, RunRecord
from agentrail.evals.runner import (
    SYNTHETIC_MODEL,
    AgentExecution,
    AnswerKeyLeak,
    SandboxAgentExecutor,
    is_network_artifact,
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

    # Optional per-phase cost ledger the executor leaves in its workdir, exactly
    # where the live run pipeline writes it (``repo/.agentrail/run/cost-events.jsonl``).
    # When set, ``execute`` drops it there so the runner's harvest reads a real
    # on-disk file — faithful to production, where the pipeline authors this file
    # and the runner must scrape it BEFORE the workdir is torn down.
    cost_events_to_write: Optional[List[dict]] = None

    # Optional gather CONTEXT MANIFEST the executor leaves in its workdir, exactly
    # where the live pipeline writes it when the gather phase runs
    # (``workdir/.agentrail-runs/host-run/gather/output.md`` — the native runner's
    # RUN_ID/log-subdir layout). When set, ``execute`` drops it there so the
    # runner's manifest harvest+score reads a real on-disk file BEFORE teardown,
    # faithful to production where the gather subagent authors this file.
    gather_manifest_to_write: Optional[str] = None

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
        if self.cost_events_to_write is not None:
            ledger = workdir / "repo" / ".agentrail" / "run" / "cost-events.jsonl"
            ledger.parent.mkdir(parents=True, exist_ok=True)
            ledger.write_text(
                "".join(json.dumps(ev) + "\n" for ev in self.cost_events_to_write),
                encoding="utf-8",
            )
        if self.gather_manifest_to_write is not None:
            manifest = (
                workdir / ".agentrail-runs" / "host-run" / "gather" / "output.md"
            )
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(self.gather_manifest_to_write, encoding="utf-8")
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


def test_arm_env_emits_new_flow_layer_toggles_and_critic_model() -> None:
    """Issue #980: the new-flow arm's env must enable the three new layers and
    supply a critic model so the pipeline builds a critic command.

    The pipeline reads ``AGENTRAIL_EVAL_LAYER_{CRITIC,BESTOFN,WARMCACHE}`` via
    ``layer_enabled`` and a critic-model env override (so the critic/best-of-N
    layers, which are opt-in, actually activate during the eval run).
    """
    from agentrail.evals.runner import _arm_env, CRITIC_MODEL_ENV

    env = _arm_env(new_flow())
    # The five base layers stay ON (new-flow = full + new layers).
    for layer in ("CONTEXT", "ROUTING", "VERIFY_GATE", "RETRY", "GUARDRAILS"):
        assert env[f"AGENTRAIL_EVAL_LAYER_{layer}"] == "1"
    # The three new layers are explicitly ON.
    assert env["AGENTRAIL_EVAL_LAYER_CRITIC"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_BESTOFN"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_WARMCACHE"] == "1"
    # A critic model is supplied so a critic command actually gets built.
    assert env[CRITIC_MODEL_ENV] == new_flow().critic_model


def test_arm_env_new_flow_minus_warmcache_turns_only_warmcache_off() -> None:
    from agentrail.evals.runner import _arm_env

    env = _arm_env(new_flow_minus("warmcache"))
    assert env["AGENTRAIL_EVAL_LAYER_WARMCACHE"] == "0"
    assert env["AGENTRAIL_EVAL_LAYER_CRITIC"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_BESTOFN"] == "1"


def test_arm_env_new_flow_minus_critic_turns_only_critic_off() -> None:
    from agentrail.evals.runner import _arm_env

    env = _arm_env(new_flow_minus("critic"))
    assert env["AGENTRAIL_EVAL_LAYER_CRITIC"] == "0"
    assert env["AGENTRAIL_EVAL_LAYER_BESTOFN"] == "1"
    assert env["AGENTRAIL_EVAL_LAYER_WARMCACHE"] == "1"


def test_arm_env_full_emits_no_new_layer_toggles_and_no_critic_model() -> None:
    """``full`` keeps today's meaning: no explicit new-layer toggles (warm-cache
    stays default-ON), and no critic model (so critic/best-of-N never activate)."""
    from agentrail.evals.runner import _arm_env, CRITIC_MODEL_ENV

    env = _arm_env(full())
    assert "AGENTRAIL_EVAL_LAYER_CRITIC" not in env
    assert "AGENTRAIL_EVAL_LAYER_BESTOFN" not in env
    assert "AGENTRAIL_EVAL_LAYER_WARMCACHE" not in env
    assert CRITIC_MODEL_ENV not in env


def test_arm_env_expansion_bridge_forces_query_expansion_on_when_layer_on() -> None:
    """Issue #1043: the expansion layer's arm flag must drive the env var the
    query-expansion STAGE actually reads.

    Unlike the other layers, the stage does NOT read the generic
    ``AGENTRAIL_EVAL_LAYER_EXPANSION`` toggle — it keys ONLY on
    ``AGENTRAIL_CONTEXT_QUERY_EXPANSION`` (via
    ``agentrail.context.expansion.query_expansion_enabled``), which defaults OFF.
    So the bridge is INVERTED versus the rerank bridge: when the layer is ON it
    forces ``AGENTRAIL_CONTEXT_QUERY_EXPANSION=1``; when the layer is OFF it
    leaves the var unset (default OFF). Without this bridge ``full`` and
    ``full-minus-expansion`` execute identically and the reported expansion
    delta is always 0.
    """
    from agentrail.evals.runner import _arm_env

    # Layer ON (in ``full``, and still ON when a DIFFERENT layer is ablated)
    # forces the stage's own env var to "1".
    assert _arm_env(full())["AGENTRAIL_CONTEXT_QUERY_EXPANSION"] == "1"
    assert _arm_env(full_minus("rerank"))["AGENTRAIL_CONTEXT_QUERY_EXPANSION"] == "1"

    # Layer OFF (baseline has every layer off; full-minus-expansion ablates just
    # this one) leaves the var unset so the stage falls back to its OFF default.
    assert "AGENTRAIL_CONTEXT_QUERY_EXPANSION" not in _arm_env(baseline())
    assert "AGENTRAIL_CONTEXT_QUERY_EXPANSION" not in _arm_env(full_minus("expansion"))


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


def test_leak_guard_raises_if_clone_subtree_contains_answer_key_dir(
    corpus_task: CorpusTask,
) -> None:
    """An answer-key DIRECTORY inside the executor's clone is a TRUE leak.

    The executor clones the full repo-under-test (which carries the eval corpus
    itself) into ``workdir/repo``. If an ``answer_key/`` directory rides into
    that clone, the agent can read the hidden tests it is graded on — the answer
    sheet, inside the exam room. The post-execute gate MUST catch this even
    though it lives under the clone subtree: a directory named after the
    hidden-tests root is an unambiguous leak signal, never a false positive.

    (Pre-fix, the gate excluded the whole ``repo`` subtree and was blind to it.)
    """

    class CloneCarryingAnswerKeyExecutor:
        def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
            leaked = (
                workdir / "repo" / "agentrail" / "evals" / "corpus" / "other" / "answer_key"
            )
            leaked.mkdir(parents=True)
            (leaked / "test_hidden.py").write_text("def test(): assert True")
            return AgentExecution(
                diff="",
                usage=Usage(model=MODEL, input_tokens=0, output_tokens=0, cache_tokens=0),
                model=MODEL,
                gate_passed=True,
            )

    with pytest.raises(AnswerKeyLeak):
        run(corpus_task, full(), executor=CloneCarryingAnswerKeyExecutor())


def test_leak_guard_tolerates_agent_authored_test_basename_in_the_clone(
    corpus_task: CorpusTask,
) -> None:
    """An agent-authored test whose basename matches a hidden test is NOT a leak.

    Inside its clone the agent may legitimately author a test file named like
    the hidden test (the corpus tasks reverse-engineer real PRs and keep the
    test filenames). As long as the file is NOT inside an answer-key directory,
    the post-execute basename check must not false-positive on the clone subtree.
    """

    class AgentWritesOwnTestExecutor:
        def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
            d = workdir / "repo" / "agentrail" / "context" / "tests"
            d.mkdir(parents=True)
            (d / "test_hidden.py").write_text("def test(): assert True")
            return AgentExecution(
                diff="",
                usage=Usage(model=MODEL, input_tokens=0, output_tokens=0, cache_tokens=0),
                model=MODEL,
                gate_passed=True,
            )

    # Must NOT raise — the basename check excludes the clone subtree.
    record = run(corpus_task, full(), executor=AgentWritesOwnTestExecutor())
    assert record.task == "sample-task"


def test_strip_answer_keys_removes_corpus_answer_keys_from_clone(tmp_path: Path) -> None:
    """``post_checkout`` sanitisation deletes the corpus's answer-key dirs.

    Root-cause fix: the answer never enters the clone. Stripping leaves the rest
    of the corpus (task.json) and the repo's own code untouched.
    """
    from agentrail.evals.runner import _strip_answer_keys_from_clone

    clone = tmp_path / "repo"
    corpus_task_dir = clone / "agentrail" / "evals" / "corpus" / "some-task"
    answer_key = corpus_task_dir / "answer_key"
    answer_key.mkdir(parents=True)
    (answer_key / "test_secret.py").write_text("hidden")
    (corpus_task_dir / "task.json").write_text("{}")
    repo_code = clone / "agentrail" / "context" / "rerank.py"
    repo_code.parent.mkdir(parents=True)
    repo_code.write_text("code")

    _strip_answer_keys_from_clone(clone)

    assert not answer_key.exists()
    assert (corpus_task_dir / "task.json").exists()  # rest of corpus preserved
    assert repo_code.exists()  # repo code untouched


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
    module_path = Path(__file__).resolve().parents[3] / "agentrail" / "evals" / "runner.py"
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


# ---------------------------------------------------------------------------
# Clone-source resolution (#966) — a corpus task's repo SLUG must be turned
# into something git can actually clone, never passed through as the bare slug.
# ---------------------------------------------------------------------------


def test_resolve_clone_source_turns_host_slug_into_local_path(
    corpus_task: CorpusTask,
) -> None:
    """For the host-repo slug (``Bensigo/agentrail``) the resolver yields the
    LOCAL repo path, not the bare slug — git can ``clone`` a local path and the
    pinned commit is already in local history.
    """
    from agentrail.evals.runner import _resolve_clone_source

    source = _resolve_clone_source(SandboxAgentExecutor(), corpus_task)

    # Never the bare slug — that is exactly the #966 bug.
    assert source != corpus_task.repo
    assert source != "Bensigo/agentrail"
    # A real, cloneable local path: it exists on disk and is a git repo.
    src_path = Path(source)
    assert src_path.exists(), source
    assert (src_path / ".git").exists(), source


def test_resolve_clone_source_repo_url_override_wins(corpus_task: CorpusTask) -> None:
    """An injected ``repo_url`` overrides slug resolution (AC3) — the seam stays
    open for non-host-repo tasks (or tests) to point at their own clone source.
    """
    from agentrail.evals.runner import _resolve_clone_source

    override = "/some/explicit/clone/source"
    source = _resolve_clone_source(SandboxAgentExecutor(repo_url=override), corpus_task)
    assert source == override


def test_resolve_clone_source_non_host_slug_falls_back_to_https(
    corpus_task: CorpusTask,
) -> None:
    """A non-host-repo slug with no override resolves to a cloneable https URL,
    never the bare slug.
    """
    from dataclasses import replace
    from agentrail.evals.runner import _resolve_clone_source

    other = replace(corpus_task, repo="acme/widget")
    source = _resolve_clone_source(SandboxAgentExecutor(), other)
    assert source != "acme/widget"
    assert source.startswith("https://")
    assert source.endswith("acme/widget.git")


def test_execute_passes_resolved_source_not_slug_to_run_issue_on_host(
    corpus_task: CorpusTask, tmp_path: Path, monkeypatch
) -> None:
    """``execute`` must hand ``run_issue_on_host`` a cloneable source, never the
    slug — guards the exact #966 regression at the call site.
    """
    captured = {}

    def fake_run_issue_on_host(*, repo_url, ref, **kwargs):
        captured["repo_url"] = repo_url
        captured["ref"] = ref
        from agentrail.sandbox.docker_runner import RunResult

        return RunResult(status="red")

    import agentrail.sandbox.native_runner as nr

    monkeypatch.setattr(nr, "run_issue_on_host", fake_run_issue_on_host)
    monkeypatch.setattr(
        "agentrail.run.usage_capture.capture_usage", lambda *a, **k: None
    )

    workdir = tmp_path / "wd"
    workdir.mkdir()
    SandboxAgentExecutor().execute(task=corpus_task, arm=full(), workdir=workdir)

    assert captured["repo_url"] != corpus_task.repo
    assert captured["repo_url"] != "Bensigo/agentrail"
    assert captured["ref"] == corpus_task.commit


def test_execute_captures_usage_from_the_clone_not_the_bare_workdir(
    corpus_task: CorpusTask, tmp_path: Path, monkeypatch
) -> None:
    """AC3 (#989): the executor must read token usage from the path where the
    agent ACTUALLY ran — the clone at ``workdir/repo`` — NOT the bare eval
    ``workdir``.

    The agent CLI keys its transcript to its cwd. ``run_issue_on_host`` clones
    into ``workdir/repo`` and runs the agent there (``--target workdir/repo``),
    exactly mirroring production where ``capture_usage`` is passed
    ``rc.target_dir`` (the clone), not the run's parent dir. Passing the bare
    ``workdir`` looks under the wrong encoded path, finds no transcript, and the
    run falls back to a fabricated zero-token ``Usage`` — the #989 bug that made
    every arm report ``$0`` / ``dollars-per-solved = n/a``.

    This pins that ``capture_usage`` receives ``workdir/repo``. A real (non-zero)
    transcript-derived ``Usage`` then flows into the ``RunRecord``.
    """
    captured = {}

    def fake_run_issue_on_host(*, repo_url, ref, issue_ref, prompt=None, **kwargs):
        from agentrail.sandbox.docker_runner import RunResult

        return RunResult(status="green")

    real_usage = Usage(
        model=MODEL,
        input_tokens=1234,
        output_tokens=567,
        cache_tokens=0,
        cache_creation_tokens=0,
    )

    def spy_capture_usage(agent, target, since_ts):
        captured["agent"] = agent
        captured["target"] = Path(target)
        captured["since_ts"] = since_ts
        return real_usage

    import agentrail.sandbox.native_runner as nr

    monkeypatch.setattr(nr, "run_issue_on_host", fake_run_issue_on_host)
    monkeypatch.setattr(
        "agentrail.run.usage_capture.capture_usage", spy_capture_usage
    )
    # Diff capture reaches into the (non-existent) clone tree; stub it so the
    # test stays focused on the usage-capture path.
    monkeypatch.setattr(
        "agentrail.evals.runner._capture_workdir_diff", lambda *a, **k: ""
    )

    workdir = tmp_path / "agent-wd"
    workdir.mkdir()
    execution = SandboxAgentExecutor().execute(
        task=corpus_task, arm=full(), workdir=workdir
    )

    # The crux: usage is read from the clone/run path the agent used, NOT the
    # bare eval workdir.
    assert captured["target"] == workdir / "repo"
    assert captured["target"] != workdir
    assert captured["agent"] == "claude"

    # The real transcript-derived usage flows into the RunRecord (non-zero
    # tokens — not the fabricated zero fallback).
    assert execution.usage == real_usage
    assert execution.usage.input_tokens == 1234
    assert execution.usage.output_tokens == 567


def test_execute_passes_task_prompt_and_name_label_to_sandbox(
    corpus_task: CorpusTask, tmp_path: Path, monkeypatch
) -> None:
    """AC4 (#968): the production executor must hand the sandbox the corpus
    task's PROMPT (so the agent actually works on the task, not on a numbered
    GitHub issue) and the task NAME as the run label/issue_ref.
    """
    captured = {}

    def fake_run_issue_on_host(*, repo_url, ref, issue_ref, prompt=None, **kwargs):
        captured["issue_ref"] = issue_ref
        captured["prompt"] = prompt
        from agentrail.sandbox.docker_runner import RunResult

        return RunResult(status="red")

    import agentrail.sandbox.native_runner as nr

    monkeypatch.setattr(nr, "run_issue_on_host", fake_run_issue_on_host)
    monkeypatch.setattr(
        "agentrail.run.usage_capture.capture_usage", lambda *a, **k: None
    )

    workdir = tmp_path / "wd"
    workdir.mkdir()
    SandboxAgentExecutor().execute(task=corpus_task, arm=full(), workdir=workdir)

    # The task's prompt is forwarded (drives ``agentrail run prompt``).
    assert captured["prompt"] == corpus_task.prompt
    assert captured["prompt"] == "Make X work."
    # The task name is the run label.
    assert captured["issue_ref"] == corpus_task.name


def test_execute_real_clone_and_checkout_into_workdir_repo(
    corpus_task: CorpusTask, tmp_path: Path, monkeypatch
) -> None:
    """End-to-end-ish proof (AC2/AC1): drive the production executor against a
    REAL tiny local git repo as the resolved clone source and assert
    ``run_issue_on_host`` clones + checks out the pinned commit into
    ``workdir/repo`` (the #964 diff-capture contract), with NO real agent.

    We stub only the agent RUN command (``agentrail run issue ...``) so no agent
    is invoked; the clone + checkout are REAL git against a REAL local repo.
    """
    import subprocess as real_subprocess
    from dataclasses import replace

    # 1. Build a real local git repo with a known commit.
    origin = tmp_path / "origin"
    origin.mkdir()

    def git(*args):
        real_subprocess.run(
            ["git", *args], cwd=str(origin), check=True, capture_output=True, text=True
        )

    git("init", "-q")
    git("config", "user.email", "t@t.dev")
    git("config", "user.name", "t")
    (origin / "marker.txt").write_text("pinned\n", encoding="utf-8")
    git("add", "-A")
    git("commit", "-q", "-m", "pinned commit")
    pinned = real_subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(origin), capture_output=True, text=True
    ).stdout.strip()

    # 2. A task pinned at that commit; inject the local repo as the clone source.
    task = replace(corpus_task, commit=pinned)
    executor = SandboxAgentExecutor(repo_url=str(origin))

    captured = {}

    # 3. Fake ONLY the agent run command; let git clone/checkout run for real.
    #    The agent fake also SNAPSHOTS workdir/repo state (it runs AFTER the
    #    real clone+checkout, BEFORE run_issue_on_host's teardown of workdir).
    class _Runner:
        def run(self, cmd, *, cwd=None, env=None, timeout=None, **kwargs):
            if cmd[:1] == ["git"]:
                return real_subprocess.run(
                    cmd, cwd=cwd, env=env, timeout=timeout,
                    capture_output=True, text=True,
                )
            # The agent run command. By now the real clone+checkout finished,
            # so capture the clone state. #970: the eval injects the SOURCE
            # launcher, so the run command's cwd is the SOURCE tree and the
            # clone is named via ``--target`` (the agent still edits the clone
            # at workdir/repo). Read the clone path from --target.
            assert "--target" in cmd, "injected launcher must name the clone via --target"
            repo_clone = Path(cmd[cmd.index("--target") + 1])
            captured["run_cwd"] = str(cwd)
            captured["repo_clone"] = str(repo_clone)
            captured["has_git"] = (repo_clone / ".git").exists()
            captured["marker"] = (
                (repo_clone / "marker.txt").read_text()
                if (repo_clone / "marker.txt").exists()
                else None
            )
            head = real_subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=str(repo_clone),
                capture_output=True, text=True,
            )
            captured["head"] = head.stdout.strip()
            return real_subprocess.CompletedProcess(cmd, 0, "", "")

    from agentrail.sandbox import native_runner as nr

    real_run_issue_on_host = nr.run_issue_on_host

    def run_issue_on_host_with_real_git(**kwargs):
        captured["repo_url"] = kwargs["repo_url"]
        kwargs["runner"] = _Runner()
        return real_run_issue_on_host(**kwargs)

    monkeypatch.setattr(nr, "run_issue_on_host", run_issue_on_host_with_real_git)
    monkeypatch.setattr(
        "agentrail.run.usage_capture.capture_usage", lambda *a, **k: None
    )

    workdir = tmp_path / "agent-wd"
    workdir.mkdir()
    executor.execute(task=task, arm=full(), workdir=workdir)

    # The clone source was the injected local repo, NOT the slug.
    assert captured["repo_url"] == str(origin)
    # The real clone landed in workdir/repo at the pinned commit (the #964
    # diff-capture contract — clone goes into workdir/repo).
    assert captured["repo_clone"] == str(workdir / "repo")
    assert captured["has_git"], "clone must land in workdir/repo (#964)"
    assert captured["marker"] == "pinned\n"
    assert captured["head"] == pinned, "checkout must land at the pinned commit"
    # #970: the run command runs from the SOURCE tree (so source agentrail is
    # imported), NOT from the clone (which would shadow it).
    assert captured["run_cwd"] != str(workdir / "repo")


# ---------------------------------------------------------------------------
# Per-phase cost-ledger harvest (#1049 AC4).
#
# The live run pipeline writes per-phase token costs to
# ``workdir/repo/.agentrail/run/cost-events.jsonl``. The runner must harvest that
# file off the filesystem BEFORE the ``finally`` tears the workdir down — the
# only place the per-phase split exists. These prove the harvest happens at the
# right moment and degrades to an empty list when there is no ledger.
# ---------------------------------------------------------------------------


def test_run_harvests_cost_events_from_workdir_before_teardown(
    corpus_task: CorpusTask,
) -> None:
    """The runner scrapes the pipeline's per-phase ledger onto the RunRecord."""
    events = [
        {"run_id": "r1", "phase": "gather", "input_tokens": 1500,
         "output_tokens": 400, "cache_tokens": 0, "cache_creation_tokens": 600},
        {"run_id": "r1", "phase": "execute", "input_tokens": 3000,
         "output_tokens": 1000, "cache_tokens": 1200, "cache_creation_tokens": 0},
    ]
    executor = FakeExecutor(cost_events_to_write=events)

    record = run(corpus_task, full(), executor=executor)

    assert record.cost_events == events
    # The workdir the ledger lived in is gone — harvest happened before teardown.
    assert executor.invoked_with_workdir is not None
    assert not executor.invoked_with_workdir.exists()


def test_run_cost_events_empty_when_no_ledger(corpus_task: CorpusTask) -> None:
    """No pipeline ledger (e.g. a synthetic run) → an empty list, never a crash."""
    record = run(corpus_task, full(), executor=FakeExecutor())
    assert record.cost_events == []


# ---------------------------------------------------------------------------
# Gather manifest harvest + file-picking score (#1049 AC4, precision half).
#
# When the gather phase runs it writes a CONTEXT MANIFEST at
# ``workdir/.agentrail-runs/host-run/gather/output.md``. The runner must harvest
# that file BEFORE teardown and score its picks against the task's
# ``requiredContext`` answer key. These prove the score is attached correctly and
# that a missing manifest reads as ``None`` (undefined), never a fabricated 0.
# The corpus fixture's answer key is ``["agentrail/evals/runner.py"]``.
# ---------------------------------------------------------------------------


def test_run_scores_the_gather_manifest_against_the_answer_key(
    corpus_task: CorpusTask,
) -> None:
    """A manifest picking the required file scores precision 1.0, recall 1.0."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- agentrail/evals/runner.py:1-40 — the answer-key file\n"
        "Checked, not relevant:\n"
        "- checked agentrail/evals/spine.py — orchestration, not the change\n"
    )
    executor = FakeExecutor(gather_manifest_to_write=manifest)

    record = run(corpus_task, full(), executor=executor)

    assert record.gather_score is not None
    assert record.gather_score.selected_paths == ["agentrail/evals/runner.py"]
    assert record.gather_score.required_paths == ["agentrail/evals/runner.py"]
    assert record.gather_score.intersection == 1
    assert record.gather_score.precision == 1.0
    assert record.gather_score.recall == 1.0
    # The workdir the manifest lived in is gone — harvest happened before teardown.
    assert executor.invoked_with_workdir is not None
    assert not executor.invoked_with_workdir.exists()


def test_run_gather_score_captures_a_wrong_pick(corpus_task: CorpusTask) -> None:
    """A manifest picking the WRONG file scores precision 0.0, recall 0.0 (a real miss)."""
    manifest = (
        "CONTEXT MANIFEST\n"
        "Relevant files:\n"
        "- agentrail/evals/spine.py:1-10 — wrong pick, not the answer key\n"
    )
    record = run(corpus_task, full(), executor=FakeExecutor(gather_manifest_to_write=manifest))

    assert record.gather_score is not None
    assert record.gather_score.intersection == 0
    assert record.gather_score.precision == 0.0  # 1 pick, 0 correct
    assert record.gather_score.recall == 0.0  # real answer key, 0 hits


def test_run_gather_score_none_when_no_manifest(corpus_task: CorpusTask) -> None:
    """No gather phase (no manifest) → ``gather_score`` is None, never a fake 0."""
    record = run(corpus_task, full(), executor=FakeExecutor())
    assert record.gather_score is None


def test_run_gather_score_none_when_manifest_empty(corpus_task: CorpusTask) -> None:
    """A header-only manifest (gatherer found nothing) is undefined, not a run.

    An all-whitespace/empty manifest text yields no picks; the runner treats that
    as 'the gatherer did not produce a usable manifest' → None, matching the
    None-vs-0.0 discipline (this is distinct from a manifest that names a file the
    answer key rejects, which is a real 0.0 above).
    """
    record = run(corpus_task, full(), executor=FakeExecutor(gather_manifest_to_write="   \n\n"))
    assert record.gather_score is None


# ---------------------------------------------------------------------------
# Network-artifact marker at capture (issue #1033).
#
# The <synthetic> model id is the ECONNRESET synthetic-fallback marker: a run
# with no diff, $0 cost, and solved=0 that is a NETWORK artifact, not a real
# 0% score. runner.py single-sources both the constant and the predicate so the
# spine/reporter never re-spell the literal.
# ---------------------------------------------------------------------------


def test_synthetic_model_constant_is_the_marker():
    """The single-sourced marker literal is exactly ``<synthetic>``."""
    assert SYNTHETIC_MODEL == "<synthetic>"


def test_is_network_artifact_true_only_for_synthetic_marker():
    """Only the ``<synthetic>`` marker is a network artifact."""
    assert is_network_artifact(SYNTHETIC_MODEL) is True
    assert is_network_artifact("<synthetic>") is True


def test_is_network_artifact_false_for_real_models_and_none():
    """Real models — and an unset/None model — are NOT network artifacts.

    A genuine failed run keeps its real model id and stays counted; only the
    ECONNRESET fallback (which overwrites model with the marker) is excluded.
    """
    assert is_network_artifact(MODEL) is False
    assert is_network_artifact("claude-opus-4-8") is False
    assert is_network_artifact("") is False
    assert is_network_artifact(None) is False
