"""Eval **runner** — execute one ``(CorpusTask, Arm)`` in the existing sandbox (issue #937).

Position in the spine (PRD §"Single shared spine, many probes")::

    corpus -> [arm runner] -> RunRecord -> scorer -> repetition -> reporter

The runner is the seam that PRODUCES a :class:`agentrail.evals.run_record.RunRecord`
for one ``(task, arm)`` pair. It WRAPS the existing host/Docker sandbox
(``agentrail.sandbox``) — it does NOT reimplement isolation (PRD: "Wraps the
sandbox; does not reimplement isolation"). What it adds on top of the production
sandbox is the eval-specific framing:

1. **Materialize the agent-visible tree** from the corpus task into a fresh,
   isolated sandbox workdir. Only files under ``task.agent_visible_path`` are
   copied in.

2. **Answer-key leak guard** (AC3). The task's ``hidden_tests`` directory and
   every hidden test file is *asserted absent* from the sandbox workdir BEFORE
   the agent is invoked. The hidden tests live alongside the task in the corpus,
   but they must NOT enter the agent's context: the scorer mounts them later, in
   a separate slice. We fail loudly if a leak is ever detected.

3. **Apply the arm**. The arm's pinned ``model`` / ``temperature`` and the layer
   on/off flags (``Layers.context``, ``routing``, ``verify_gate``, ``retry``,
   ``guardrails``) are forwarded to the executor (AC2). A ``baseline`` arm
   (every layer OFF) runs the agent without AgentRail's context/loop layers; the
   ``full`` arm enables every layer.

4. **Assemble the RunRecord**. We import :class:`RunRecord` from
   ``agentrail.evals.run_record`` (the LOCKED contract — never redefined here)
   and populate it with the executor's diff, usage, model, the measured wall
   time, the executor's Objective-Gate ``bool`` decision, and the retry events
   observed. ``gate_passed`` is asserted to be a real ``bool`` so the scorer's
   coercion isn't relied on (#936 review nit).

Testability seam (PRD §"Testing Decisions"):

    The runner depends on the sandbox and a real agent, so it is covered by a
    *small* number of integration runs rather than fine-grained unit tests; its
    output contract (the RunRecord shape) is what the scorer tests depend on.

We keep the expensive agent invocation behind a clean ``AgentExecutor``
Protocol. The production executor (:func:`SandboxAgentExecutor`) wraps the
existing :mod:`agentrail.sandbox.native_runner` / docker runner; a test fake
implements the same Protocol and must remain FAITHFUL to that contract — it
mirrors exactly what the real sandbox returns and *nothing more*. In particular,
the fake never invents fields the real sandbox would not have populated, so
production-only bugs are not hidden behind it.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Protocol

from agentrail.run.usage_capture import Usage

from agentrail.evals.arms import Arm
from agentrail.evals.corpus.loader import CorpusTask
from agentrail.evals.run_record import RetryEvent, RunRecord


# ---------------------------------------------------------------------------
# The executor seam — the clean boundary between the runner and the sandbox.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentExecution:
    """What the executor returns after one sandboxed run.

    This is the FAITHFUL contract a test fake must mirror; nothing more, nothing
    less. It matches what the production sandbox (``native_runner`` /
    ``docker_runner``) can actually report after a run:

    - ``diff`` — the unified diff the agent produced in the sandbox workdir.
      May be empty when the agent produced nothing.
    - ``usage`` — token ``Usage`` captured from the agent's transcript by
      ``agentrail.run.usage_capture.capture_usage`` (the same shape the
      single-source pricer reads).
    - ``model`` — the (final) model the run resolved to (may differ from
      ``arm.model`` after model escalation under the routing layer).
    - ``gate_passed`` — the run's OWN **Objective Gate** decision (a real
      ``bool``: the production ``RunResult.status == "green"`` collapses to
      ``True``; ``"red"`` or ``"error"`` collapses to ``False``).
    - ``retries`` — retry/escalation events observed during the run (the queue
      transitions in the production loop). Empty when none.
    """

    diff: str
    usage: Usage
    model: str
    gate_passed: bool
    retries: List[RetryEvent] = field(default_factory=list)


class AgentExecutor(Protocol):
    """The clean seam the runner depends on.

    Implementations execute the agent on the prepared sandbox workdir under the
    arm's pinned configuration and return an :class:`AgentExecution`. They do
    not see (and must not need) the task's hidden tests — those live OUTSIDE
    ``workdir`` by AC3 construction.
    """

    def execute(
        self, *, task: CorpusTask, arm: Arm, workdir: Path
    ) -> AgentExecution:  # pragma: no cover - Protocol body
        ...


# ---------------------------------------------------------------------------
# Sandbox preparation — materialize the agent-visible tree, enforce AC3.
# ---------------------------------------------------------------------------


class AnswerKeyLeak(RuntimeError):
    """A hidden-test / answer-key file was found inside the sandbox workdir."""


def _materialize_agent_visible_tree(task: CorpusTask, *, workdir: Path) -> None:
    """Copy the agent-visible working tree into ``workdir``.

    Only the directory at ``task.agent_visible_path`` is copied; the hidden
    tests live OUTSIDE that path by corpus-loader construction (the loader
    rejects a task whose ``hiddenTests.root`` lives under ``agentVisibleRoot``,
    see ``corpus/loader.py``). If the corpus task's working tree does not exist
    on disk yet (corpus v0 ships the prompt + answer key only), we still create
    an empty ``workdir`` so the sandbox path is uniform.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    source = task.agent_visible_path
    if source.is_dir():
        # Mirror only the agent-visible subtree. ``dirs_exist_ok=True`` so a
        # caller-provided pre-existing workdir is honoured.
        shutil.copytree(source, workdir, dirs_exist_ok=True, symlinks=False)


def _assert_no_answer_key_in_workdir(task: CorpusTask, *, workdir: Path) -> None:
    """Hard guard: the task's hidden tests must not appear inside ``workdir``.

    This is the AC3 leak guard. It checks two things:

    1. No directory matching ``task.hidden_tests.root`` exists at any depth
       under ``workdir`` (so a sloppy materialisation that copied the whole
       task directory is detected).
    2. None of the hidden test files (by basename) appear anywhere under
       ``workdir``.

    A violation raises :class:`AnswerKeyLeak`. The runner calls this both
    *before* invoking the executor (so the agent never sees the answer key) and
    *after* the run (so an executor that wrote one into the workdir is
    detected too).
    """
    hidden_root_name = task.hidden_tests.root.strip("/").split("/")[-1]
    hidden_basenames = {Path(name).name for name in task.hidden_tests.files}

    workdir = workdir.resolve()
    for path in workdir.rglob("*"):
        rel = path.relative_to(workdir)
        if path.is_dir() and path.name == hidden_root_name:
            raise AnswerKeyLeak(
                f"answer key directory '{hidden_root_name}' found in sandbox workdir at {rel}"
            )
        if path.is_file() and path.name in hidden_basenames:
            raise AnswerKeyLeak(
                f"hidden test file '{path.name}' found in sandbox workdir at {rel}"
            )


# ---------------------------------------------------------------------------
# The runner — assembles a RunRecord from one (task, arm) execution.
# ---------------------------------------------------------------------------


def run(
    task: CorpusTask,
    arm: Arm,
    *,
    executor: AgentExecutor,
    workdir_factory: Optional[Callable[[], Path]] = None,
    clock: Callable[[], float] = time.monotonic,
) -> RunRecord:
    """Execute one ``(task, arm)`` run in the sandbox and return a :class:`RunRecord`.

    Args:
        task: validated :class:`CorpusTask` from the frozen corpus.
        arm: the :class:`Arm` configuration to apply (pinned model + temperature,
            layer on/off flags).
        executor: the seam that drives the agent inside the sandbox. The
            production implementation is :class:`SandboxAgentExecutor`; tests
            inject a faithful fake mirroring the same contract.
        workdir_factory: optional callable returning a fresh sandbox workdir
            path. Defaults to a tempdir; injectable for hermetic tests.
        clock: monotonic-clock callable for measuring wall time; injectable so
            tests get deterministic ``wall_time_s``.

    The runner:

    - materializes the agent-visible tree into the workdir,
    - enforces the AC3 leak guard before AND after the agent run,
    - delegates execution to the injected executor with ``arm`` applied,
    - measures wall time via ``clock``,
    - assembles and returns the :class:`RunRecord` (importing the locked
      contract from :mod:`agentrail.evals.run_record`).

    ``gate_passed`` on the returned record is always a real ``bool``.
    """
    if workdir_factory is None:
        # Default: fresh tempdir per run (production behaviour). Wrapped in a
        # nested import so the module stays cheap to import.
        import tempfile

        workdir = Path(tempfile.mkdtemp(prefix="agentrail-eval-run-"))
        owns_workdir = True
    else:
        workdir = Path(workdir_factory())
        owns_workdir = True  # the factory owns the path's existence; runner cleans up

    try:
        _materialize_agent_visible_tree(task, workdir=workdir)

        # AC3, gate 1: assert the answer key isn't in the workdir BEFORE the
        # agent ever sees it. A leak here means materialisation or test setup
        # is wrong; we fail loudly rather than silently leaking the key.
        _assert_no_answer_key_in_workdir(task, workdir=workdir)

        start = clock()
        execution = executor.execute(task=task, arm=arm, workdir=workdir)
        elapsed = max(0.0, float(clock() - start))

        # AC3, gate 2: assert the executor did not write the answer key into
        # the workdir (e.g. by reaching outside its sandbox). Belt-and-braces.
        _assert_no_answer_key_in_workdir(task, workdir=workdir)

        # The locked contract — never redefined. ``gate_passed`` MUST be bool.
        gate_passed: bool = bool(execution.gate_passed)
        # Defensive: refuse non-bool values reaching this seam to surface the
        # contract violation early (the scorer's review nit: pass real bools).
        if not isinstance(execution.gate_passed, bool):  # pragma: no cover
            raise TypeError(
                "AgentExecutor.execute must return a real bool for gate_passed; "
                f"got {type(execution.gate_passed).__name__}"
            )

        return RunRecord(
            task=task.name,
            arm=arm.name,
            diff=execution.diff,
            model=execution.model or arm.model,
            usage=execution.usage,
            wall_time_s=elapsed,
            gate_passed=gate_passed,
            retries=list(execution.retries),
        )
    finally:
        if owns_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Production executor — wraps the existing host sandbox.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SandboxAgentExecutor:
    """Production executor: invoke the agent in the existing host sandbox.

    Thin wrapper around :func:`agentrail.sandbox.native_runner.run_issue_on_host`:
    forwards the arm's pinned model and layer flags via environment variables
    the run pipeline already consumes, collapses the production ``RunResult``
    into the eval-runner's :class:`AgentExecution` shape (status → bool,
    transcript → ``Usage`` via the same ``capture_usage`` helper the production
    runner uses).

    This class is *imported but not exercised* by the unit tests: real sandbox
    integration is covered by the small number of integration runs the PRD
    asks for. Keeping the wrapper thin is deliberate — every transformation
    here would otherwise have to be mirrored in the test fake.
    """

    repo_url: str = ""

    def execute(self, *, task: CorpusTask, arm: Arm, workdir: Path) -> AgentExecution:
        """Drive the existing sandbox; collapse its output into ``AgentExecution``.

        We import the sandbox lazily so importing :mod:`agentrail.evals.runner`
        does not transitively pull in subprocess/docker code (the unit-test
        seam stays light).
        """
        # Import here (lazily) so the module stays cheap to import; native_runner
        # is referenced via the module so a test ``monkeypatch`` of
        # ``native_runner.run_issue_on_host`` is honoured at the call site.
        from agentrail.sandbox import native_runner
        from agentrail.run.usage_capture import capture_usage

        env = _arm_env(arm)
        since_ts = time.time()

        # #966: ``task.repo`` is a GitHub SLUG (``"Bensigo/agentrail"``), which
        # git cannot clone. Resolve it to a real, cloneable source BEFORE handing
        # it to the sandbox, or ``run_issue_on_host`` dies with
        # ``fatal: repository 'Bensigo/agentrail' does not exist``.
        clone_source = _resolve_clone_source(self, task)

        # #968: a corpus task is a PROMPT, not a numbered GitHub issue. Pass the
        # task's prompt so the sandbox drives ``agentrail run prompt`` (the agent
        # actually works on the task) and the task name as the run label. The
        # prompt runs the SAME pipeline + Objective Gate as a real issue.
        result = native_runner.run_issue_on_host(
            repo_url=clone_source,
            ref=task.commit,
            issue_ref=task.name,
            workspace_id="eval",
            env=env,
            model=arm.model,
            prompt=task.prompt,
            run_dir_factory=lambda: workdir,
            publish_pr=False,
        )

        usage = capture_usage("claude", workdir, since_ts) or Usage(
            model=arm.model,
            input_tokens=0,
            output_tokens=0,
            cache_tokens=0,
            cache_creation_tokens=0,
        )

        # Capture the agent's net change as a unified-diff PATCH STRING, while
        # the sandbox workdir still exists (``runner.run`` tears it down in its
        # ``finally`` AFTER this method returns). We hand the scorer a patch, not
        # the live workdir — the answer key is never co-located with the agent's
        # tree (AC4). ``run_issue_on_host`` clones the pinned ref into
        # ``workdir/repo`` and the agent works there with ``publish_pr=False``,
        # so the changes are sitting in that clone (committed AND/OR uncommitted
        # AND/OR newly-added files) when we get here.
        diff = _capture_workdir_diff(workdir, base_ref=task.commit)

        return AgentExecution(
            diff=diff,
            usage=usage,
            model=usage.model or arm.model,
            gate_passed=(result.status == "green"),
            retries=[],
        )


# ---------------------------------------------------------------------------
# Clone-source resolution (#966) — turn a corpus task's repo SLUG into something
# git can actually clone.
# ---------------------------------------------------------------------------

# The host repository this CLI ships in. The corpus is bundled inside it
# (``agentrail/evals/corpus/...``) and every task's pinned ``commit`` is already
# in this repo's local history, so the local repo is a network-free clone source.
HOST_REPO_SLUG = "Bensigo/agentrail"


def _resolve_clone_source(executor: "SandboxAgentExecutor", task: CorpusTask) -> str:
    """Resolve a corpus task's repo to a git-cloneable URL or local path.

    ``task.repo`` is a GitHub *slug* (``"owner/name"``), which git cannot clone.
    ``run_issue_on_host`` runs ``git clone <repo_url> ...`` then checks out
    ``task.commit``, so ``repo_url`` must be a real clone source. Resolution
    order:

    1. **Explicit override** — ``executor.repo_url`` wins when set. This is the
       injectable seam (AC3): a non-host-repo task (or a test) points the
       executor at its own clone source. Returned verbatim.
    2. **Host repo** — when ``task.repo`` is the host slug
       (:data:`HOST_REPO_SLUG`), resolve to the LOCAL repo path. git can clone a
       local path, and every pinned ``commit`` is already in local history, so
       the clone + checkout are network-free.
    3. **Other slug** — fall back to a cloneable ``https://github.com/<slug>.git``
       URL. (Corpus v0 is host-only; this keeps non-host tasks working without a
       hard-coded token. A private repo would need an injected ``repo_url`` per
       step 1.)

    The returned value is NEVER the bare slug — that is exactly the #966 bug.
    """
    if executor.repo_url:
        return executor.repo_url
    if task.repo == HOST_REPO_SLUG:
        return str(_host_repo_root())
    return f"https://github.com/{task.repo}.git"


def _host_repo_root() -> Path:
    """Walk up from this module to the nearest dir containing ``.git``.

    Mirrors ``agentrail.evals.hidden_tests._default_repo_root``: the corpus lives
    inside this repo, so its own ``.git`` (a dir in a normal checkout, a *file*
    in a git worktree — both satisfy ``.exists()``) is the local clone source.
    Falls back to the current working directory if no ``.git`` is found above.
    """
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / ".git").exists():
            return parent
    return Path.cwd()


def _arm_env(arm: Arm) -> dict:
    """Translate an :class:`Arm` into the env vars the sandbox/run pipeline reads.

    The layer on/off flags map to ``AGENTRAIL_EVAL_LAYER_<NAME>=0|1`` so the
    pipeline can switch each layer at the same seam regardless of how it is
    wired internally. This keeps the eval coupling shallow: turning a layer off
    is a config switch, not a code branch.
    """
    flags = arm.layers.as_dict()
    env = {
        "AGENTRAIL_MODEL": arm.model,
        "AGENTRAIL_TEMPERATURE": f"{arm.temperature}",
    }
    for name, on in flags.items():
        env[f"AGENTRAIL_EVAL_LAYER_{name.upper()}"] = "1" if on else "0"
    return env


# ---------------------------------------------------------------------------
# Diff capture — the agent's net change as a patch the hidden-test runner applies.
# ---------------------------------------------------------------------------


def _resolve_git_repo(workdir: Path) -> Optional[Path]:
    """Locate the git working tree the agent ran in, under ``workdir``.

    ``run_issue_on_host`` clones the pinned ref into ``workdir/repo`` and the
    agent works there, so that is the common case. We fall back to ``workdir``
    itself (a caller may point the executor straight at a git repo, as the
    round-trip test does). Returns ``None`` if neither is a git repo.
    """
    for candidate in (workdir / "repo", workdir):
        if (candidate / ".git").exists():
            return candidate
    return None


def _capture_workdir_diff(workdir: Path, *, base_ref: str) -> str:
    """Return the agent's NET change vs ``base_ref`` as a unified-diff string.

    The net change is everything the agent did relative to the pinned base
    commit: committed changes, uncommitted edits, AND newly-created (untracked)
    files. A plain ``git diff <base>`` omits untracked files — exactly the
    corpus-v0 tasks that ADD A NEW FILE — so we first ``git add -A`` to stage
    every change, then ``git diff --cached <base_ref>`` so the new files appear
    in the patch. Staging is in-memory index bookkeeping in a disposable clone
    that is about to be torn down; it never publishes anything.

    The produced patch is in standard ``git diff`` format (``a/`` / ``b/``
    prefixes), which is exactly what ``ProductionHiddenTestRunner._apply_diff``
    feeds to ``git apply --whitespace=nowarn`` (default ``-p1``) — so it
    round-trips cleanly, recreating added files included.

    An empty change yields an empty string (the agent did nothing → the task
    correctly scores ``solved=False``). Any git failure is swallowed and yields
    ``""`` — capture must never crash the run; an absent diff just scores False.
    """
    repo = _resolve_git_repo(workdir)
    if repo is None:
        return ""

    def _git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args],
            cwd=str(repo),
            capture_output=True,
            text=True,
        )

    try:
        # Stage everything so newly-added (untracked) files land in the index
        # and therefore in ``--cached`` diff output. ``-A`` also captures
        # deletions and modifications.
        _git("add", "-A")
        # Diff the staged tree against the pinned base. ``--no-color`` and
        # ``--no-ext-diff`` keep the output a clean, machine-applicable patch
        # regardless of the host's git config; ``--binary`` lets binary file
        # changes round-trip through ``git apply`` too.
        result = _git(
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--binary",
            "--cached",
            base_ref,
        )
    except (OSError, ValueError):  # pragma: no cover - git missing / bad args
        return ""

    if result.returncode != 0:
        return ""
    return result.stdout


__all__ = [
    "AgentExecution",
    "AgentExecutor",
    "AnswerKeyLeak",
    "SandboxAgentExecutor",
    "run",
]
