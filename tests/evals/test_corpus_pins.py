"""Falsifiable proof that every corpus v0 task is pinned to a PRE-FIX commit (#954).

The corpus's value depends on one property: the agent's work must be *required*.
If ``task.commit`` pins the merge commit of the PR that shipped the fix, then the
solution source is already on disk at that commit, an EMPTY diff passes the hidden
tests, and the eval measures nothing (#954, surfaced during #952's AC3).

This module drives the production :class:`ProductionHiddenTestRunner` over every
corpus v0 task with two diff cases and asserts the bar:

* **AC1** — with an EMPTY diff at ``task.commit`` the runner returns ``False``
  (the solution is *not* there yet; the agent's work is genuinely required).
* **AC2** — with the actual merged-PR diff (the source files the fix changed,
  computed as ``git diff <task.commit> <source.mergeCommit> -- <source paths>``)
  applied at ``task.commit`` the runner returns ``True`` (reproducing the change
  solves the hidden tests).

Together these falsify a mis-pin: a task pinned to the fix commit fails AC1
(empty diff already green); a task pinned too far back, or whose solving diff is
entangled with unrelated changes, fails AC2 (the reconstructed diff won't apply
or won't pass). The loop passing on all 11 is the issue's bar.

These tests clone real commits and run pytest subprocesses, so they are slow by
design (each task materializes a fresh git workspace at its pinned commit).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agentrail.evals.corpus.loader import CorpusTask, load_corpus
from agentrail.evals.hidden_tests import ProductionHiddenTestRunner, _default_repo_root
from agentrail.evals.run_record import RunRecord
from agentrail.run.usage_capture import Usage


# The pinning rule under test: a task's solving diff is the change the fix PR
# made to *agent-producible source* — everything under ``agentrail/`` that the
# fix touched, EXCEPT the eval harness itself (the answer key lives there and is
# mounted by the runner, never produced by the agent).
_SOURCE_PREFIX = "agentrail/"
_EXCLUDE_PREFIX = "agentrail/evals/"

MODEL = "claude-sonnet-4-5"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _repo_root() -> Path:
    """The host repo whose objects the runner clones (same discovery it uses)."""
    return _default_repo_root()


def _git(*cmd: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *cmd],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )


def _commit_available(sha: str, repo_root: Path) -> bool:
    """True iff ``sha`` is a resolvable commit object in this checkout.

    CI does a shallow clone without full history, so the pre-fix pins and their
    fix commits may be absent. These tests need real history to be meaningful;
    when it isn't there we SKIP (honest — reported as skipped, not passed),
    while a full-history checkout (local / nightly) verifies all 11 fully.
    """
    return _git("cat-file", "-e", f"{sha}^{{commit}}", cwd=repo_root).returncode == 0


def _require_commits(task: CorpusTask, repo_root: Path) -> None:
    fix = task.source.get("mergeCommit", "")
    missing = [
        sha for sha in (task.commit, fix) if not sha or not _commit_available(sha, repo_root)
    ]
    if missing:
        pytest.skip(
            f"{task.name}: required commit(s) not in this checkout "
            f"(shallow clone) — run with full git history to verify the pin"
        )


def _run_record_for(task: CorpusTask, *, diff: str) -> RunRecord:
    """Build the spine's only handoff — a RunRecord carrying the agent's diff."""
    return RunRecord(
        task=task.name,
        arm="full",
        diff=diff,
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


def _solving_source_paths(task: CorpusTask, repo_root: Path) -> list[str]:
    """The agent-producible source paths the fix PR changed.

    ``git diff --name-only <pin> <fix>`` restricted to ``agentrail/`` source,
    excluding the eval harness (where the hidden answer key lives — the runner
    mounts it, the agent never ships it).
    """
    fix = task.source["mergeCommit"]
    names = _git(
        "diff", "--name-only", task.commit, fix, cwd=repo_root
    ).stdout.split()
    return [
        n
        for n in names
        if n.startswith(_SOURCE_PREFIX) and not n.startswith(_EXCLUDE_PREFIX)
    ]


def _solving_diff(task: CorpusTask, repo_root: Path) -> str:
    """The merged-PR diff for ``task``, scoped to agent-producible source.

    Computed as ``git diff <task.commit> <fix> -- <source paths>``. Applied at
    ``task.commit`` this reproduces exactly the implementation the fix shipped,
    so the hidden tests must pass (AC2).
    """
    fix = task.source["mergeCommit"]
    paths = _solving_source_paths(task, repo_root)
    assert paths, f"{task.name}: fix {fix} changed no agentrail source files"
    result = _git("diff", task.commit, fix, "--", *paths, cwd=repo_root)
    assert result.returncode == 0, (
        f"{task.name}: git diff failed: {result.stderr.strip()}"
    )
    assert result.stdout.strip(), f"{task.name}: solving diff is empty"
    return result.stdout


# ---------------------------------------------------------------------------
# The corpus loop — one parametrized case per task so a failure names the task.
# ---------------------------------------------------------------------------

# Include the held-out split (#941): the pin-falsifiability proof is about
# corpus integrity, so it must cover EVERY task — held-out tasks need a clean
# parent-of-fix pin just as much as dev-set tasks. The held-out *exclusion* is a
# dev-run policy, not a corpus-validity policy.
_CORPUS = load_corpus(include_held_out=True)
_TASK_IDS = [t.name for t in _CORPUS]


@pytest.fixture(scope="module")
def runner() -> ProductionHiddenTestRunner:
    return ProductionHiddenTestRunner()


@pytest.mark.parametrize("task", _CORPUS, ids=_TASK_IDS)
def test_empty_diff_fails_at_pinned_commit(
    task: CorpusTask, runner: ProductionHiddenTestRunner
) -> None:
    """AC1: an EMPTY diff at the pinned commit must NOT solve the task.

    If this fails, the pin is the fix commit (or later) and the solution is
    already on disk — the eval would measure nothing.
    """
    _require_commits(task, _repo_root())
    record = _run_record_for(task, diff="")
    solved = runner.run_hidden_tests(task=task, run_record=record)
    assert solved is False, (
        f"{task.name}: empty diff at {task.commit[:12]} already passes the hidden "
        f"tests — the pin is not pre-fix (the agent's work is not required)."
    )


@pytest.mark.parametrize("task", _CORPUS, ids=_TASK_IDS)
def test_solving_diff_passes_at_pinned_commit(
    task: CorpusTask, runner: ProductionHiddenTestRunner
) -> None:
    """AC2: the actual merged-PR diff at the pinned commit MUST solve the task.

    If this fails, the pin is too far back (diff won't apply cleanly) or the
    fix is entangled with unrelated changes — i.e. the pin is not a clean
    parent-of-fix and the task is not falsifiable.
    """
    repo_root = _repo_root()
    _require_commits(task, repo_root)
    diff = _solving_diff(task, repo_root)
    record = _run_record_for(task, diff=diff)
    solved = runner.run_hidden_tests(task=task, run_record=record)
    assert solved is True, (
        f"{task.name}: reproducing the fix diff at {task.commit[:12]} did NOT "
        f"pass the hidden tests — pin is not a clean parent-of-fix."
    )


def _first_easy_task() -> CorpusTask:
    """The first ``easy`` corpus v0 task, by stable name order.

    The end-to-end capture proof only needs ONE real task; ``easy`` keeps the
    materialised solving change small and fast to apply.
    """
    for task in _CORPUS:
        if task.difficulty == "easy":
            return task
    return _CORPUS[0]


def test_captured_agent_diff_solves_a_real_corpus_task_end_to_end() -> None:
    """AC3 (#964): route a REAL task's solving change through the CAPTURE path.

    This is the end-to-end proof the live runner now measures something: rather
    than feeding the pre-computed ``_solving_diff`` straight to the runner (which
    only proves the pin), we materialise the agent's solving change as
    working-tree edits in a sandbox-shaped workdir (``workdir/repo`` cloned at
    the pinned commit, exactly as ``run_issue_on_host`` lays it out), then run
    the PRODUCTION capture helper ``_capture_workdir_diff`` over it — the same
    code path ``SandboxAgentExecutor.execute`` uses — and assert:

    * the captured diff applied via the real ``ProductionHiddenTestRunner``
      yields ``solved=True`` (the agent's work reaches the scorer), and
    * an EMPTY agent change yields ``solved=False`` (no false green).

    Most corpus tasks ADD A NEW FILE, so this also exercises the new-file gotcha
    on real corpus data: a naive ``git diff <base>`` would drop the added source
    file and the task would still report 0%.
    """
    import shutil
    import tempfile

    from agentrail.evals.runner import _capture_workdir_diff

    repo_root = _repo_root()
    task = _first_easy_task()
    _require_commits(task, repo_root)

    solving = _solving_diff(task, repo_root)

    workdir = Path(tempfile.mkdtemp(prefix="agentrail-eval-run-"))
    try:
        # Lay the workdir out the way the real sandbox does: clone at the pinned
        # commit into ``workdir/repo`` (run_issue_on_host's ``repo_dir``).
        repo_dir = workdir / "repo"
        clone = _git(
            "clone", "--quiet", "--local", "--no-hardlinks",
            str(repo_root), str(repo_dir), cwd=Path.cwd(),
        )
        assert clone.returncode == 0, clone.stderr
        co = _git(
            "-c", "advice.detachedHead=false", "checkout", "--quiet",
            task.commit, cwd=repo_dir,
        )
        assert co.returncode == 0, co.stderr

        # The "agent" performs the solving change: apply the merged-PR diff to
        # the working tree, left UNCOMMITTED (mirrors how the real agent leaves
        # its work for the objective gate to read).
        apply = subprocess.run(
            ["git", "apply", "--whitespace=nowarn"],
            cwd=str(repo_dir),
            input=solving,
            capture_output=True,
            text=True,
        )
        assert apply.returncode == 0, f"solving diff did not apply: {apply.stderr}"

        # The fix under test: capture the agent's net change from the workdir.
        captured = _capture_workdir_diff(workdir, base_ref=task.commit)
        assert captured.strip(), "capture produced an EMPTY diff for a solved task"
        # Most corpus fixes add a new source file — prove the capture kept it.
        # (At least one of the solving source paths is a NEW file in the patch.)
        # Not asserted strictly per-task, but the round-trip below proves it.

        runner = ProductionHiddenTestRunner()
        solved = runner.run_hidden_tests(
            task=task, run_record=_run_record_for(task, diff=captured)
        )
        assert solved is True, (
            f"{task.name}: the CAPTURED agent diff did not solve the task — the "
            f"live runner would still report 0%."
        )

        # And the empty-change control: a no-op agent scores False.
        empty_workdir = Path(tempfile.mkdtemp(prefix="agentrail-eval-run-"))
        try:
            empty_repo = empty_workdir / "repo"
            _git(
                "clone", "--quiet", "--local", "--no-hardlinks",
                str(repo_root), str(empty_repo), cwd=Path.cwd(),
            )
            _git(
                "-c", "advice.detachedHead=false", "checkout", "--quiet",
                task.commit, cwd=empty_repo,
            )
            empty_captured = _capture_workdir_diff(empty_workdir, base_ref=task.commit)
            assert empty_captured == "", "untouched workdir produced a non-empty diff"
            solved_empty = runner.run_hidden_tests(
                task=task, run_record=_run_record_for(task, diff=empty_captured)
            )
            assert solved_empty is False, (
                f"{task.name}: an EMPTY agent change scored solved — false green."
            )
        finally:
            shutil.rmtree(empty_workdir, ignore_errors=True)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def test_no_task_pins_its_own_fix_commit() -> None:
    """Guard the rule directly: ``commit`` must never equal ``source.mergeCommit``.

    A pure-data check (no clone) so a regression is caught instantly, before the
    slow loop above. The pin must be the PARENT of the fix, never the fix itself.
    """
    for task in _CORPUS:
        fix = task.source.get("mergeCommit")
        assert fix, f"{task.name}: source.mergeCommit missing (needed for provenance)"
        assert task.commit != fix, (
            f"{task.name}: commit pins the fix merge {fix[:12]} itself — pin the "
            f"parent-of-fix so an empty diff fails."
        )
