"""Real-git proof that the eval runner captures the agent's actual diff (#964).

The bug this guards: ``SandboxAgentExecutor.execute`` used to hardcode
``diff=""``, so the agent's real work never reached the scorer and EVERY task
scored ``solved=False`` on the live path. The fix captures the agent's net
change from the sandbox workdir (committed + uncommitted + newly-added files)
as a unified-diff PATCH STRING, in the exact format
``ProductionHiddenTestRunner``'s ``git apply`` accepts.

These tests use REAL git — no fakes for the git/apply round-trip (AC2). The
corpus end-to-end case (AC3) lives in ``test_corpus_pins.py``'s sibling check;
here we drive the capture helper directly and round-trip it through the real
production hidden-test runner.

Coverage:

* AC1 — the capture returns a non-empty diff including NEWLY-ADDED files.
* AC2 — that diff applies cleanly via the real ``ProductionHiddenTestRunner``
  (its ``git apply``) to a fresh checkout, and the new file + the edit appear.
* AC4 — the capture produces a patch STRING only; the agent's workdir is never
  handed to the scorer. The patch is plain text, contains no absolute workdir
  path, and the round-trip materialises a SEPARATE workspace.
* No-change — an untouched workdir yields an empty diff (→ scores False).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from agentrail.evals.corpus.loader import CorpusTask, HiddenTestRef
from agentrail.evals.hidden_tests import ProductionHiddenTestRunner
from agentrail.evals.run_record import RunRecord
from agentrail.evals.runner import _capture_workdir_diff
from agentrail.run.usage_capture import Usage


MODEL = "claude-sonnet-4-5"


def _git(*cmd: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *cmd],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
    )


def _init_base_repo(repo: Path) -> str:
    """Create a real git repo with one committed file; return the base SHA."""
    repo.mkdir(parents=True, exist_ok=True)
    _git("init", "--quiet", cwd=repo)
    _git("config", "user.email", "test@agentrail.dev", cwd=repo)
    _git("config", "user.name", "Test Runner", cwd=repo)
    (repo / "module.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    _git("add", "-A", cwd=repo)
    _git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base", cwd=repo)
    return _git("rev-parse", "HEAD", cwd=repo).stdout.strip()


# ---------------------------------------------------------------------------
# AC1 — capture returns a non-empty diff INCLUDING newly-added files.
# ---------------------------------------------------------------------------


def test_capture_includes_new_files_and_edits(tmp_path: Path) -> None:
    """A workdir with a NEW file + an edit yields a non-empty patch covering both.

    This is the gotcha the issue calls out: a plain ``git diff <base>`` omits
    untracked files — exactly the corpus-v0 tasks that add a new file. The
    capture stages first, so the new file appears.
    """
    repo = tmp_path / "repo"
    base = _init_base_repo(repo)

    # The agent's work: add a NEW file and edit an existing one, left
    # UNCOMMITTED (mirrors the real sandbox where the agent leaves changes for
    # the objective gate to read via ``git status``).
    (repo / "newmod.py").write_text("def g():\n    return 2\n", encoding="utf-8")
    (repo / "module.py").write_text("def f():\n    return 42\n", encoding="utf-8")

    diff = _capture_workdir_diff(tmp_path, base_ref=base)

    assert diff.strip(), "capture returned an empty diff for a real change"
    assert "newmod.py" in diff, f"new file missing from patch:\n{diff}"
    assert "new file mode" in diff, f"new-file marker missing:\n{diff}"
    assert "return 42" in diff, f"edit missing from patch:\n{diff}"


def test_capture_handles_committed_changes(tmp_path: Path) -> None:
    """Net change vs base includes the agent's COMMITTED work too, not just dirty.

    Some agents commit their work; the base ref (the pinned commit) is the
    correct reference point regardless of whether HEAD advanced.
    """
    repo = tmp_path / "repo"
    base = _init_base_repo(repo)

    (repo / "committed_new.py").write_text("X = 1\n", encoding="utf-8")
    _git("add", "-A", cwd=repo)
    _git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "agent work", cwd=repo)

    diff = _capture_workdir_diff(tmp_path, base_ref=base)
    assert "committed_new.py" in diff, f"committed new file missing:\n{diff}"


def test_capture_empty_when_agent_did_nothing(tmp_path: Path) -> None:
    """No change → empty diff → the task correctly scores False (no false green)."""
    repo = tmp_path / "repo"
    base = _init_base_repo(repo)

    diff = _capture_workdir_diff(tmp_path, base_ref=base)
    assert diff == "", f"expected empty diff for an untouched workdir, got:\n{diff}"


def test_capture_returns_empty_for_non_git_workdir(tmp_path: Path) -> None:
    """A workdir with no git repo yields an empty diff, never an exception."""
    (tmp_path / "loose.txt").write_text("hi\n", encoding="utf-8")
    assert _capture_workdir_diff(tmp_path, base_ref="HEAD") == ""


# ---------------------------------------------------------------------------
# AC2 — the captured diff round-trips through the REAL ProductionHiddenTestRunner.
# ---------------------------------------------------------------------------


def _make_task(repo: Path, base: str, *, hidden_test_src: str) -> CorpusTask:
    """Build a CorpusTask pinned at ``base`` whose answer key is the given test.

    The hidden test lives OUTSIDE the agent-visible tree (an ``answer_key/``
    dir), as the corpus loader requires.
    """
    task_dir = repo.parent / "task"
    answer = task_dir / "answer_key"
    answer.mkdir(parents=True, exist_ok=True)
    (answer / "test_hidden.py").write_text(hidden_test_src, encoding="utf-8")

    return CorpusTask(
        name="diff-capture-task",
        repo="local",
        commit=base,
        prompt="add newmod",
        agent_visible_root="workdir",
        hidden_tests=HiddenTestRef(
            root="answer_key", files=["test_hidden.py"], base_dir=task_dir
        ),
        required_context=["module.py"],
        difficulty="easy",
        task_dir=task_dir,
    )


def test_captured_diff_round_trips_through_real_hidden_test_runner(tmp_path: Path) -> None:
    """AC2: a captured diff (with a NEW file) applies via the real runner and
    the hidden tests, which assert the new file + edit are present, PASS.

    No fakes: a real git repo for the agent's workdir, the real
    ``ProductionHiddenTestRunner`` cloning the same repo at the pinned base and
    running ``git apply`` exactly as production does.
    """
    repo = tmp_path / "repo"
    base = _init_base_repo(repo)

    # The agent ships a NEW module + edits the existing one.
    (repo / "newmod.py").write_text("def g():\n    return 2\n", encoding="utf-8")
    (repo / "module.py").write_text("def f():\n    return 42\n", encoding="utf-8")

    diff = _capture_workdir_diff(tmp_path, base_ref=base)
    assert "newmod.py" in diff

    # The hidden answer key: verifies BOTH that the new file exists (importable)
    # and that the edit landed — i.e. the patch round-tripped fully.
    hidden = (
        "import newmod, module\n"
        "def test_new_file_recreated():\n"
        "    assert newmod.g() == 2\n"
        "def test_edit_applied():\n"
        "    assert module.f() == 42\n"
    )
    task = _make_task(repo, base, hidden_test_src=hidden)

    record = RunRecord(
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

    # The runner clones ``repo`` (its .git) at ``base`` into its OWN workspace,
    # applies our patch, drops the hidden tests, and runs pytest.
    runner = ProductionHiddenTestRunner(repo_root=repo)
    solved = runner.run_hidden_tests(task=task, run_record=record)
    assert solved is True, "captured diff did not round-trip to a passing answer key"


def test_empty_capture_scores_false_through_real_runner(tmp_path: Path) -> None:
    """A no-op agent (empty captured diff) → the same answer key FAILS (no solve)."""
    repo = tmp_path / "repo"
    base = _init_base_repo(repo)

    diff = _capture_workdir_diff(tmp_path, base_ref=base)
    assert diff == ""

    hidden = (
        "import newmod\n"  # absent at base → import fails → test fails
        "def test_new_file_recreated():\n"
        "    assert newmod.g() == 2\n"
    )
    task = _make_task(repo, base, hidden_test_src=hidden)
    record = RunRecord(
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
    runner = ProductionHiddenTestRunner(repo_root=repo)
    assert runner.run_hidden_tests(task=task, run_record=record) is False


# ---------------------------------------------------------------------------
# AC4 — the capture produces a PATCH STRING only; no workdir leak.
# ---------------------------------------------------------------------------


def test_capture_is_a_patch_string_with_no_workdir_path_leak(tmp_path: Path) -> None:
    """The captured value is a plain diff string — no absolute workdir path in it.

    AC4: we hand the scorer a patch, never the live workdir. The patch uses
    git's ``a/`` ``b/`` prefixes (relative), so the agent's absolute sandbox
    path must not appear anywhere in the captured string.
    """
    repo = tmp_path / "repo"
    base = _init_base_repo(repo)
    (repo / "newmod.py").write_text("Y = 1\n", encoding="utf-8")

    diff = _capture_workdir_diff(tmp_path, base_ref=base)

    assert isinstance(diff, str)
    assert str(tmp_path) not in diff, "absolute workdir path leaked into the patch"
    assert str(repo) not in diff, "absolute repo path leaked into the patch"
    # It is a real unified diff, not a directory handle or object.
    assert diff.startswith("diff --git "), diff[:80]
