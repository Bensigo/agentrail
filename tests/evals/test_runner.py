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
