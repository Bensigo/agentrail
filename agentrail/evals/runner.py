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

import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Protocol

from agentrail.run.usage_capture import Usage

from agentrail.evals.arms import Arm
from agentrail.evals.corpus.loader import CorpusTask
from agentrail.evals.run_record import RetryEvent, RunRecord


# ---------------------------------------------------------------------------
# Network-artifact marker (issue #1033) — SINGLE SOURCE for the whole spine.
# ---------------------------------------------------------------------------
#
# The executor emits ``<synthetic>`` as the run's ``model`` when the agent call
# hit a network fault (ECONNRESET) and fell back to a synthetic no-op run: no
# diff was produced, $0 was spent, and the run scores solved=0. That 0 is a
# NETWORK ARTIFACT, not a real "the agent tried and failed" 0% — folding it into
# solve-rate or dollars-per-solved would silently depress both with noise the
# harness never actually measured. So the marker is RECOGNIZED here at capture
# and the artifact is EXCLUDED from every aggregate downstream (reporter.py).
#
# It lives on ``RunRecord.model`` (the LOCKED contract already carries ``model``,
# so nothing is added to that contract). The string and its predicate are
# single-sourced here so the runner, spine, and reporter never drift on what
# counts as a network artifact.
SYNTHETIC_MODEL = "<synthetic>"


def is_network_artifact(model: Optional[str]) -> bool:
    """True iff ``model`` marks a run as an ECONNRESET synthetic-fallback.

    Such a run produced no diff and spent $0; its solved=0 is a network
    artifact, not a real score, so aggregates must EXCLUDE it (issue #1033).
    ``None`` / any real model name returns ``False`` (a real, counted run).
    """
    return model == SYNTHETIC_MODEL


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
    - ``gate_failure_reason`` (#994) — a short note on WHY the gate did not pass
      (``None`` when it passed or no reason was captured). Diagnostic only.
    - ``precision_at_budget`` / ``citation_coverage`` (#994) — context-pack
      quality metrics for the run's retrieval, when the executor can surface
      them (``None`` otherwise — the live sandbox executor does not yet).
    """

    diff: str
    usage: Usage
    model: str
    gate_passed: bool
    retries: List[RetryEvent] = field(default_factory=list)
    # Diagnostic fields (#994) — Optional/None defaults keep the fake faithful
    # without forcing every test fake to supply them.
    gate_failure_reason: Optional[str] = None
    precision_at_budget: Optional[float] = None
    citation_coverage: Optional[float] = None


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


# The executor clones the FULL repo under test into this subdir of the workdir
# and the agent works there (``SandboxAgentExecutor.execute`` →
# ``run_dir_factory=lambda: workdir``, ``run_path = workdir / "repo"``). That
# clone is a legitimate full checkout, so the agent may author its OWN test file
# whose BASENAME matches a hidden test (the corpus tasks reverse-engineer real
# merged PRs and keep the test filenames). So the post-execute *basename* check
# excludes this subtree to avoid false-positiving on agent-authored tests. The
# *directory* check still scans it: a dir named after the hidden-tests root is
# never something the agent legitimately creates — it is the corpus's own
# answer-key dir riding in on the clone, a TRUE leak (the answer is stripped out
# in ``_strip_answer_keys_from_clone`` post_checkout; this check is the net
# behind it). Kept in sync with ``SandboxAgentExecutor``'s clone dir.
_EXECUTOR_CLONE_SUBDIR = "repo"


def _assert_no_answer_key_in_workdir(
    task: CorpusTask,
    *,
    workdir: Path,
    basename_exclude_subdirs: frozenset = frozenset(),
) -> None:
    """Hard guard: the task's hidden tests must not appear inside ``workdir``.

    This is the AC3 leak guard. It checks two things:

    1. No directory matching ``task.hidden_tests.root`` exists at any depth
       under ``workdir``. This ALWAYS scans the whole workdir — including the
       executor's clone subtree — because a directory named after the
       hidden-tests root is an unambiguous leak signal that the agent never
       legitimately produces (a sloppy materialisation that copied the whole
       task dir, or the corpus's own ``answer_key/`` riding in on the clone).
    2. None of the hidden test files (by basename) appear anywhere under
       ``workdir``, EXCEPT under ``basename_exclude_subdirs``.

    A violation raises :class:`AnswerKeyLeak`. The runner calls this both
    *before* invoking the executor (so the agent never sees the answer key) and
    *after* the run (so an executor that wrote one into the workdir is
    detected too).

    ``basename_exclude_subdirs`` names top-level subdirectories of ``workdir``
    to skip for the BASENAME check ONLY. The post-execute gate passes the
    executor's clone dir here: a full repo checkout where the agent may
    legitimately author a same-named test file, so matching by basename there
    would false-positive. The directory check is NOT subject to this exclusion —
    it is false-positive-free and must see the clone. See
    :data:`_EXECUTOR_CLONE_SUBDIR`.
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
            if rel.parts and rel.parts[0] in basename_exclude_subdirs:
                continue
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
        # the AGENT-VISIBLE tree (e.g. by reaching outside its sandbox), and
        # that the corpus answer keys really were stripped from the full-repo
        # clone (the directory check scans the clone too — see below). We exclude
        # the clone subtree from the BASENAME check only: that checkout is where
        # the agent may legitimately author a same-named test file, so matching
        # by basename there would false-positive. The directory check is NOT
        # excluded — a dir named after the hidden-tests root is a true leak
        # wherever it sits (see _EXECUTOR_CLONE_SUBDIR).
        _assert_no_answer_key_in_workdir(
            task,
            workdir=workdir,
            basename_exclude_subdirs=frozenset({_EXECUTOR_CLONE_SUBDIR}),
        )

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
            # Diagnostic fields (#994) — thread straight off the execution; they
            # stay None when the executor did not surface them.
            gate_failure_reason=execution.gate_failure_reason,
            precision_at_budget=execution.precision_at_budget,
            citation_coverage=execution.citation_coverage,
            # Routing-audit field (Finding 4, measurement only): the baseline /
            # default model this run WOULD have used had routing not acted is the
            # arm's pinned model. ``execution.model`` (above) is the resolved
            # model after any routing escalation; recording ``arm.model`` here
            # lets the audit attribute the routing $-delta vs baseline and report
            # explicitly when routing never diverged. INSTRUMENT only — this does
            # not influence which model the run actually used.
            baseline_model=arm.model,
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
        #
        # #970: the autonomous loop's sandbox launches the npm-published
        # ``agentrail`` binary on PATH, which has no ``run prompt`` — so the eval
        # never reached the agent ("Unknown option: prompt"). Inject the CURRENT
        # SOURCE under test as the launcher: run ``python -m agentrail.cli.main``
        # with cwd == the source repo root (so ``import agentrail`` resolves to
        # source, not the clone which would shadow it) and PYTHONPATH == source
        # root as a belt-and-braces. The agent still edits the CLONE because the
        # launcher passes ``--target <clone>`` (native_runner sets that when the
        # launcher is injected), so #964 diff-capture + #966 clone/SHA-checkout
        # are untouched. AGENTRAIL_ALLOW_SOURCE_RUN=1 lets ``run prompt`` proceed
        # in the source checkout.
        source_root = _host_repo_root()
        agentrail_cmd = [sys.executable, "-m", "agentrail.cli.main"]
        run_env = {
            "PYTHONPATH": _prepend_pythonpath(str(source_root), env),
            "AGENTRAIL_ALLOW_SOURCE_RUN": "1",
        }

        result = native_runner.run_issue_on_host(
            repo_url=clone_source,
            ref=task.commit,
            issue_ref=task.name,
            workspace_id="eval",
            env=env,
            model=arm.model,
            prompt=task.prompt,
            agentrail_cmd=agentrail_cmd,
            run_cwd=str(source_root),
            run_env=run_env,
            run_dir_factory=lambda: workdir,
            post_checkout=_prepare_eval_clone,
            publish_pr=False,
        )

        # #989: capture usage from where the agent ACTUALLY ran — the clone at
        # ``workdir/repo`` — NOT the bare eval ``workdir``. ``run_issue_on_host``
        # clones the pinned ref into ``workdir/repo`` and runs the agent there
        # (``--target workdir/repo``), so the claude CLI keys its transcript to
        # that path. This mirrors production, where ``pipeline.py`` passes
        # ``rc.target_dir`` (the clone) to ``capture_usage``. Passing the bare
        # ``workdir`` looked under the wrong encoded transcript path, found
        # nothing, and fell back to a fabricated zero-token Usage — making every
        # arm report ``$0`` / dollars-per-solved ``n/a``. Must match the ``repo``
        # subdir ``native_runner.run_issue_on_host`` clones into.
        run_path = workdir / "repo"
        usage = capture_usage("claude", run_path, since_ts) or Usage(
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
        diff = _capture_workdir_diff(
            workdir, base_ref=task.commit, label=task.name, source_repo=source_root,
        )
        # The agent pushes its run branch into the local source repo (origin);
        # capture reads it above, then we delete it so eval runs don't litter the
        # source repo with one branch per task.
        _cleanup_pushed_branch(source_root, task.name)

        # #994: derive a human-readable gate-failure reason so a failed run is
        # diagnosable in the report. ``result.status`` is the production
        # RunResult status ∈ {"green","red","error"}; empty diff means the agent
        # produced nothing to test. None when the gate passed (nothing to explain).
        gate_failure_reason: Optional[str]
        if result.status == "green":
            gate_failure_reason = None
        elif not diff.strip():
            gate_failure_reason = "no diff (agent produced no change)"
        elif result.status == "error":
            gate_failure_reason = "run errored"
        else:  # "red" (or any non-green, non-error status)
            gate_failure_reason = "tests didn't pass / gate red"

        # TODO(#994): surface context-pack quality (precision_at_budget /
        # citation_coverage) here. They are computed live by
        # ``agentrail.context.pack_quality.compute_pack_quality`` inside the
        # retrieval path (``context/retrieval.py``), but ``run_issue_on_host``'s
        # ``RunResult`` does not yet plumb the context-pack metadata back out of
        # the sandbox. Until that seam exists, leave them None (undefined),
        # which the reporter renders as "n/a" — distinct from a measured 0.0.
        return AgentExecution(
            diff=diff,
            usage=usage,
            model=usage.model or arm.model,
            gate_passed=(result.status == "green"),
            retries=[],
            gate_failure_reason=gate_failure_reason,
            precision_at_budget=None,
            citation_coverage=None,
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


# ---------------------------------------------------------------------------
# Objective-Gate config seeding (#993 follow-up) — make every pinned commit
# verifiable.
# ---------------------------------------------------------------------------

# The verify command the seeded ``.agentrail/config.json`` declares. It mirrors
# AgentRail's own in-repo ``.agentrail/verify.sh`` design: drive the Red-Green
# Proof from the test file(s) this change touched (the acceptance test the agent
# authors during the run), not the whole suite — the whole suite drags in
# environment-dependent tests that false-red a fresh clone.
#
# The classification (what counts as a proof, when a change may go green) is
# DELEGATED to the single source of truth, ``agentrail.run.verify_gate.main`` —
# the same gate AgentRail uses in production. That module reds a TEST-ONLY diff
# (test files changed but no proof-requiring source): running an agent's own
# self-confirming test in isolation, with no real source under it, is a
# false-green vector (it greenlit the run while the hidden spec failed). Bash
# can only see "a test file changed" and cannot make that distinction, so we no
# longer re-implement the classifier in bash. The bash fallback (for a repo
# under test that does not ship the agentrail package) carries the SAME
# test-only-red guard. Self-contained and idempotent.
_SEEDED_VERIFY_SH = """\
#!/usr/bin/env bash
# Seeded by the AgentRail eval harness for corpus tasks whose pinned commit
# predates .agentrail/config.json. Delegates classification to the production
# Objective Gate (agentrail.run.verify_gate) so a test-only diff cannot pass.
set -uo pipefail

unset AGENTRAIL_SERVER_BASE_URL AGENTRAIL_SERVER_API_KEY AGENTRAIL_SERVER_REPOSITORY_ID

# Single source of truth: the production verify gate. It collects the change set,
# reds a test-only diff (no source under proof), reds source-without-test, greens
# docs/config-only, and runs the changed tests only when source+test are present.
if python3 -c 'import agentrail.run.verify_gate' >/dev/null 2>&1; then
  exec python3 -m agentrail.run.verify_gate
fi

# Fallback for a repo under test without the agentrail package — preserves the
# same anti-false-green rule: a test-only change (no non-test .py source) reds.
tests=$(git status --porcelain | awk '{print $NF}' \\
  | grep -E '(^|/)(test_.*|.*_test)\\.py$' | sort -u || true)
source=$(git status --porcelain | awk '{print $NF}' \\
  | grep -E '\\.py$' | grep -Ev '(^|/)(test_.*|.*_test)\\.py$' | sort -u || true)

if [ -z "$tests" ]; then
  echo "verify: no changed test files — nothing to prove (red)" >&2
  exit 1
fi
if [ -z "$source" ]; then
  echo "verify: only test files changed (no source under proof) — not a Red-Green Proof (red)" >&2
  exit 1
fi

echo "verify: running changed tests:" >&2
echo "$tests" | sed 's/^/  /' >&2
exec python3 -m pytest -q -p no:cacheprovider $tests
"""

_SEEDED_CONFIG_JSON = (
    '{\n'
    '  "schemaVersion": 1,\n'
    '  "verify": "bash .agentrail/verify.sh"\n'
    '}\n'
)


def _seed_agentrail_config(repo_dir: Path) -> None:
    """Seed ``.agentrail/config.json`` (+ verify.sh) into a clone that lacks one.

    The eval clones each corpus task's repo at its pinned ``fixParent`` commit and
    runs the agent there; the Objective Gate then reads ``.agentrail/config.json``
    from THAT clone to learn the verify command. Several pinned commits predate
    that file (the corpus is seeded from historical merged PRs), so the gate sees
    ZERO declared verify checks and is ALWAYS red — the task can never reach green
    no matter what the agent writes. That is a direct cause of the 0% solve rate.

    This is the eval harness making every pinned tree verifiable, matching the
    config the repo carries at HEAD. It is invoked as ``run_issue_on_host``'s
    ``post_checkout`` hook (after checkout, before the agent runs).

    Idempotent and non-destructive: if the clone ALREADY ships a
    ``.agentrail/config.json`` (the commit was after the file landed), we leave it
    untouched so the task's own verify policy wins. We only seed when it is absent.
    """
    cfg = repo_dir / ".agentrail" / "config.json"
    if cfg.exists():
        return  # the pinned commit already declares its own verify policy.
    agentrail_dir = repo_dir / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    verify_sh = agentrail_dir / "verify.sh"
    # Only seed verify.sh if the config we're writing points at it AND it's not
    # already provided (e.g. a commit that shipped verify.sh but not config.json).
    if not verify_sh.exists():
        verify_sh.write_text(_SEEDED_VERIFY_SH, encoding="utf-8")
        verify_sh.chmod(0o755)
    cfg.write_text(_SEEDED_CONFIG_JSON, encoding="utf-8")


# The corpus lives inside the repo under test at this subpath, and each task
# stores its hidden tests in an ``answer_key/`` directory. When the executor
# clones the FULL agentrail repo into the workdir, that clone carries the entire
# corpus — including EVERY task's ``answer_key/`` — into the agent-visible tree.
# That is the ROOT CAUSE of the AC3 leak: the answer sheet rides in on the clone.
# We strip those directories at clone-prep time so the answer never reaches the
# agent in the first place (the gate-2 directory check is the net behind this).
_CORPUS_SUBPATH = ("agentrail", "evals", "corpus")
_ANSWER_KEY_DIRNAME = "answer_key"


def _strip_answer_keys_from_clone(repo_dir: Path) -> None:
    """Remove the corpus's ``answer_key/`` dirs from a freshly checked-out clone.

    The executor clones the whole repo under test (which contains the eval
    corpus) into the agent-visible workdir. Every corpus task keeps its hidden
    tests under ``agentrail/evals/corpus/<task>/answer_key/``, so without this
    the agent could read the answer sheet straight off the clone. We delete those
    directories before the agent runs. Scoped to the corpus subtree so we never
    touch a directory the repo legitimately named ``answer_key`` elsewhere.

    No-op when the clone carries no corpus (a different repo under test).
    """
    corpus_root = repo_dir.joinpath(*_CORPUS_SUBPATH)
    if not corpus_root.is_dir():
        return
    for answer_key in sorted(corpus_root.rglob(_ANSWER_KEY_DIRNAME)):
        if answer_key.is_dir():
            shutil.rmtree(answer_key, ignore_errors=True)


def _prepare_eval_clone(repo_dir: Path) -> None:
    """Post-checkout hook: make a clone safe + verifiable for the agent to work in.

    Composes the two clone-prep steps run after checkout and before the agent:
    seed a verify policy (:func:`_seed_agentrail_config`) and strip the corpus
    answer keys that ride in on a full-repo clone
    (:func:`_strip_answer_keys_from_clone`).
    """
    _seed_agentrail_config(repo_dir)
    _strip_answer_keys_from_clone(repo_dir)


def _prepend_pythonpath(source_root: str, env: dict) -> str:
    """Build a ``PYTHONPATH`` that puts the eval's SOURCE root first (#970).

    The injected launcher runs ``python -m agentrail.cli.main`` with cwd == the
    source root, so ``import agentrail`` already resolves to source. Prepending
    the source root to PYTHONPATH is belt-and-braces so the source wins even if
    the child's cwd were ever changed. Any existing PYTHONPATH (from the arm env
    or the process) is preserved after the source root.
    """
    existing = env.get("PYTHONPATH") or os.environ.get("PYTHONPATH") or ""
    parts = [source_root] + [p for p in existing.split(os.pathsep) if p]
    return os.pathsep.join(parts)


# The env var the new-flow arm sets to supply the cheap critic model (issue
# #980). ``resolve_critic_command`` reads it as a fallback when no
# ``models.critic`` is configured, so the eval can opt the critic / best-of-N
# layers in without writing config into the cloned task repo.
CRITIC_MODEL_ENV = "AGENTRAIL_EVAL_CRITIC_MODEL"


def _arm_env(arm: Arm) -> dict:
    """Translate an :class:`Arm` into the env vars the sandbox/run pipeline reads.

    The layer on/off flags map to ``AGENTRAIL_EVAL_LAYER_<NAME>=0|1`` so the
    pipeline can switch each layer at the same seam regardless of how it is
    wired internally. This keeps the eval coupling shallow: turning a layer off
    is a config switch, not a code branch.

    The NEW-flow layers (issue #980) ride the SAME seam: each of
    ``arm.extra_layers`` (critic / bestofn / warmcache) emits its own
    ``AGENTRAIL_EVAL_LAYER_<NAME>`` toggle, and a pinned ``arm.critic_model`` is
    forwarded via :data:`CRITIC_MODEL_ENV` so the pipeline builds a critic
    command (the trigger the opt-in critic / best-of-N layers need). ``full`` /
    ``baseline`` carry no extra layers and no critic model, so their env (and
    behaviour) is byte-identical to before.
    """
    flags = arm.layers.as_dict()
    env = {
        "AGENTRAIL_MODEL": arm.model,
        "AGENTRAIL_TEMPERATURE": f"{arm.temperature}",
    }
    for name, on in flags.items():
        env[f"AGENTRAIL_EVAL_LAYER_{name.upper()}"] = "1" if on else "0"
    # NEW-flow layer toggles (only present when the arm declares them, so ``full``
    # leaves warm-cache at its default-ON and never opts critic/best-of-N in).
    for name, on in arm.extra_layers.items():
        env[f"AGENTRAIL_EVAL_LAYER_{name.upper()}"] = "1" if on else "0"
    if arm.critic_model:
        env[CRITIC_MODEL_ENV] = arm.critic_model
    # Rerank-layer bridge (#1029): the ``AGENTRAIL_EVAL_LAYER_RERANK`` toggle
    # above is the arm-declaration seam, but NOTHING in the run pipeline reads
    # it — the deterministic rerank stage is toggled by
    # ``agentrail.context.rerank.rerank_enabled``, which keys ONLY on
    # ``AGENTRAIL_CONTEXT_RERANK`` (default ON). Without this bridge ``full`` and
    # ``full-minus-rerank`` execute IDENTICALLY and the reported rerank delta is
    # always 0 (the ablation is a no-op). So translate the arm's rerank flag into
    # the toggle the stage actually reads: OFF → ``AGENTRAIL_CONTEXT_RERANK=0``
    # (so ``rerank_enabled()`` returns False); ON → leave it at its default (do
    # not force ``=1``, so a caller's own override still composes). Only the
    # base-layer rerank flag drives this — ``rerank`` is a base layer, never an
    # extra_layer, so ``flags`` is the single source.
    if "rerank" in flags and not flags["rerank"]:
        env["AGENTRAIL_CONTEXT_RERANK"] = "0"
    # Expansion-layer bridge (#1043): mirror of the rerank bridge, INVERTED. The
    # ``AGENTRAIL_EVAL_LAYER_EXPANSION`` toggle above is the arm seam, but the
    # query-expansion stage keys ONLY on ``AGENTRAIL_CONTEXT_QUERY_EXPANSION`` via
    # ``agentrail.context.expansion.query_expansion_enabled`` (default OFF).
    # Because the default is OFF (opposite of rerank), the bridge forces the ON
    # direction: ON -> ``AGENTRAIL_CONTEXT_QUERY_EXPANSION=1``; OFF -> leave unset
    # (default OFF, and a caller's override still composes). Without this bridge
    # ``full`` and ``full-minus-expansion`` execute IDENTICALLY and the reported
    # expansion delta is always 0 (the ablation is a no-op).
    if flags.get("expansion"):
        env["AGENTRAIL_CONTEXT_QUERY_EXPANSION"] = "1"
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


def _cleanup_pushed_branch(source_repo: Path, label: str) -> None:
    """Delete the run branch the agent pushed into the local source repo.

    The prompt-run convention (``agentrail/run/prompts.py``) tells the agent to
    push ``agentrail/issue-<label>`` to ``origin``. For an eval clone, ``origin``
    IS the local source repo, so each run otherwise leaves a branch behind in it.
    Best-effort: never raise into the run.
    """
    try:
        subprocess.run(
            ["git", "branch", "-D", f"agentrail/issue-{label}"],
            cwd=str(source_repo), capture_output=True, text=True,
        )
    except OSError:  # pragma: no cover - git missing
        pass


def _capture_workdir_diff(
    workdir: Path, *, base_ref: str, label: Optional[str] = None,
    source_repo: Optional[Path] = None,
) -> str:
    """Return the agent's NET change vs ``base_ref`` as a unified-diff string.

    The net change is everything the agent did relative to the pinned base
    commit: committed changes, uncommitted edits, AND newly-created (untracked)
    files.

    Crucially, the agent often COMMITS its work onto a run branch
    (``agentrail/issue-<label>``) and leaves the clone's ``HEAD`` back at the
    base commit. In that state ``git diff --cached <base>`` sees NOTHING (the
    index matches base), which silently dropped the agent's solution and scored
    a correct run ``solved=0`` (a false negative). So we look for the agent's
    work in three places, in order:

      1. the staged/uncommitted tree (``git add -A`` then ``--cached`` diff) —
         catches edits + newly-added files the agent left uncommitted;
      2. the run branch ``agentrail/issue-<label>`` — catches work the agent
         committed onto its branch even when ``HEAD`` is left at base;
      3. ``HEAD`` itself — catches work committed when ``HEAD`` is ahead of base.

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

    def _diff(*rev: str) -> str:
        # ``--no-color``/``--no-ext-diff`` keep the patch machine-applicable
        # regardless of host git config; ``--binary`` lets binary changes
        # round-trip through ``git apply``.
        result = _git("diff", "--no-color", "--no-ext-diff", "--binary", *rev)
        return result.stdout if result.returncode == 0 else ""

    try:
        # 1. Staged/uncommitted work. ``git add -A`` stages newly-added
        #    (untracked) files so they appear in ``--cached`` diff output.
        _git("add", "-A")
        staged = _diff("--cached", base_ref)
        if staged.strip():
            return staged

        # 2. Work the agent COMMITTED to its run branch (HEAD may be left at
        #    base, in which case the index diff above is empty). The prompt-run
        #    convention names the branch ``agentrail/issue-<label>``.
        if label:
            branch = f"agentrail/issue-{label}"
            if _git("rev-parse", "--verify", "--quiet", branch).returncode == 0:
                committed = _diff(base_ref, branch)
                if committed.strip():
                    return committed

        # 3. Work committed on the current HEAD (HEAD ahead of base).
        head_diff = _diff(base_ref, "HEAD")
        if head_diff.strip():
            return head_diff

        # 4. Work the agent PUSHED to origin. The prompt-run convention pushes
        #    the run branch to ``origin``, and an eval clone's ``origin`` IS the
        #    local source repo — so the agent's work lands as
        #    ``agentrail/issue-<label>`` THERE, not in the clone's local state
        #    (which is exactly why strategies 1–3 came up empty and every real
        #    eval run scored a correct solution as ``solved=0``).
        if label and source_repo is not None:
            branch = f"agentrail/issue-{label}"
            src = subprocess.run(
                ["git", "diff", "--no-color", "--no-ext-diff", "--binary",
                 base_ref, branch],
                cwd=str(source_repo), capture_output=True, text=True,
            )
            if src.returncode == 0 and src.stdout.strip():
                return src.stdout

        return ""
    except (OSError, ValueError):  # pragma: no cover - git missing / bad args
        return ""


__all__ = [
    "AgentExecution",
    "AgentExecutor",
    "AnswerKeyLeak",
    "CRITIC_MODEL_ENV",
    "SandboxAgentExecutor",
    "run",
]
