"""Tests for the production :class:`HiddenTestRunner` (issue #952).

Covers AC1-AC5 of #952. The headline test is AC3: against a REAL corpus v0
task (``output-format-enforcer``), reconstruct the merged-PR diff that
shipped the solution and prove the runner returns ``True``; against an empty
diff at the same task, prove it returns ``False``. This is the first time the
eval harness can produce a real green.

The AC4 timeout test uses a deliberately-hanging hidden test and proves the
runner returns ``False`` within a few seconds (never hangs the spine).

The AC2 path-isolation test asserts the workspace prefix is distinct from the
runner's agent-workdir prefix, so no path the agent saw can collide with the
hidden-test workspace.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from agentrail.evals.corpus.loader import CorpusTask, HiddenTestRef, load_task
from agentrail.evals.hidden_tests import (
    DEFAULT_TIMEOUT_S,
    HIDDEN_TESTS_SUBPATH,
    ProductionHiddenTestRunner,
)
from agentrail.evals.run_record import RunRecord
from agentrail.evals.spine import HiddenTestRunner, UnimplementedHiddenTestRunner
from agentrail.run.usage_capture import Usage


MODEL = "claude-sonnet-4-5"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _empty_usage() -> Usage:
    return Usage(
        model=MODEL,
        input_tokens=0,
        output_tokens=0,
        cache_tokens=0,
        cache_creation_tokens=0,
    )


def _run_record_for(task: CorpusTask, *, diff: str) -> RunRecord:
    return RunRecord(
        task=task.name,
        arm="full",
        diff=diff,
        model=MODEL,
        usage=_empty_usage(),
        wall_time_s=0.0,
        gate_passed=True,
    )


def _git(*cmd: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *cmd],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )


def _make_stub_repo(tmp_path: Path) -> tuple[Path, str, str]:
    """Initialise a tiny git repo with one commit.

    Returns ``(repo_root, initial_commit_sha, second_commit_sha)``. The second
    commit adds ``agentrail/run/sample.py`` with a ``add(a, b)`` function so
    the stub answer-key test can import and call it.
    """
    repo = tmp_path / "stub-repo"
    repo.mkdir()
    _git("init", "--quiet", "--initial-branch=main", cwd=repo).check_returncode()
    _git("config", "user.email", "test@example.com", cwd=repo)
    _git("config", "user.name", "Test", cwd=repo)
    _git("config", "commit.gpgsign", "false", cwd=repo)
    # commit 1: empty package layout, no implementation.
    (repo / "agentrail").mkdir()
    (repo / "agentrail" / "__init__.py").write_text("", encoding="utf-8")
    (repo / "agentrail" / "run").mkdir()
    (repo / "agentrail" / "run" / "__init__.py").write_text("", encoding="utf-8")
    (repo / "pyproject.toml").write_text(
        '[project]\nname = "stub"\nversion = "0"\n', encoding="utf-8"
    )
    _git("add", ".", cwd=repo).check_returncode()
    _git("commit", "--quiet", "-m", "init", cwd=repo).check_returncode()
    first = _git("rev-parse", "HEAD", cwd=repo).stdout.strip()

    # commit 2: ship the sample module so the diff parent->head adds it.
    (repo / "agentrail" / "run" / "sample.py").write_text(
        "def add(a, b):\n    return a + b\n", encoding="utf-8"
    )
    _git("add", "agentrail/run/sample.py", cwd=repo).check_returncode()
    _git("commit", "--quiet", "-m", "add sample", cwd=repo).check_returncode()
    second = _git("rev-parse", "HEAD", cwd=repo).stdout.strip()
    return repo, first, second


def _make_task(
    *,
    name: str,
    repo_root: Path,
    commit: str,
    task_dir: Path,
    hidden_files: dict[str, str],
) -> CorpusTask:
    """Construct a :class:`CorpusTask` rooted at ``task_dir``.

    ``hidden_files`` maps filename -> contents. The function writes them under
    ``task_dir/answer_key/`` and returns a validated, loaded :class:`CorpusTask`.
    """
    answer = task_dir / "answer_key"
    answer.mkdir(parents=True)
    visible = task_dir / "workdir"
    visible.mkdir(parents=True)
    (visible / "README.md").write_text(f"# {name}\n", encoding="utf-8")
    for filename, contents in hidden_files.items():
        (answer / filename).write_text(contents, encoding="utf-8")
    task_json = {
        "name": name,
        "repo": str(repo_root),
        "commit": commit,
        "prompt": f"Solve {name}.",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {
            "root": "answer_key",
            "files": list(hidden_files.keys()),
        },
        "requiredContext": ["agentrail/run/sample.py"],
        "difficulty": "easy",
    }
    (task_dir / "task.json").write_text(json.dumps(task_json), encoding="utf-8")
    return load_task(task_dir)


# ---------------------------------------------------------------------------
# AC1 — Protocol-compliant; returns real bool.
# ---------------------------------------------------------------------------


def test_ac1_production_runner_satisfies_hidden_test_runner_protocol() -> None:
    """The production runner is duck-typed against :class:`HiddenTestRunner`.

    The Protocol is structural (no ABC inheritance), so we assert isinstance
    via runtime_checkable semantics by checking the method exists with the
    right signature. We also assert annotated typing.
    """
    runner = ProductionHiddenTestRunner()
    assert hasattr(runner, "run_hidden_tests")
    # Method signature matches the Protocol (keyword-only task + run_record).
    import inspect

    sig = inspect.signature(runner.run_hidden_tests)
    assert set(sig.parameters.keys()) == {"task", "run_record"}
    for name, param in sig.parameters.items():
        assert param.kind == inspect.Parameter.KEYWORD_ONLY, name


def test_ac1_returns_real_bool_on_missing_workspace(tmp_path: Path) -> None:
    """``run_hidden_tests`` returns ``False`` (real bool) on materialize failure.

    Point the runner at a directory that is NOT a git repo, then call against
    a stub task. The clone step fails, the runner fails closed.
    """
    not_a_repo = tmp_path / "not-a-repo"
    not_a_repo.mkdir()
    runner = ProductionHiddenTestRunner(repo_root=not_a_repo, timeout_s=5.0)

    task_dir = tmp_path / "task"
    task = _make_task(
        name="t1",
        repo_root=not_a_repo,
        commit="deadbeef",
        task_dir=task_dir,
        hidden_files={"test_x.py": "def test_x():\n    assert True\n"},
    )
    record = _run_record_for(task, diff="")
    out = runner.run_hidden_tests(task=task, run_record=record)
    assert out is False
    assert type(out) is bool


# ---------------------------------------------------------------------------
# AC2 — workspace path is distinct from any path the agent saw.
# ---------------------------------------------------------------------------


def test_ac2_workspace_prefix_distinct_from_agent_workdir_prefix() -> None:
    """The workspace prefix is structurally different from the agent's workdir.

    ``agentrail.evals.runner.run`` uses ``tempfile.mkdtemp(prefix='agentrail-eval-run-')``.
    ``ProductionHiddenTestRunner`` uses a different prefix
    (``'agentrail-eval-hiddentest-'``) so the two paths cannot collide even
    on the same ``$TMPDIR``.
    """
    runner = ProductionHiddenTestRunner()
    assert runner.workspace_prefix != "agentrail-eval-run-"
    assert "hiddentest" in runner.workspace_prefix


def test_ac2_workspace_path_is_unique_per_call_and_cleaned_up(tmp_path: Path) -> None:
    """Each ``run_hidden_tests`` gets a fresh tempdir, and we remove it after.

    Spy the workspace path by stubbing the materialize step to record it. We
    do that by subclassing and overriding ``_materialize_workspace`` to record
    the workspace path and then noop (so we can also assert the workspace dir
    was removed in the ``finally``).
    """
    seen: list[Path] = []

    class RecordingRunner(ProductionHiddenTestRunner):
        def _materialize_workspace(self, repo_root, commit, workspace):  # noqa: ANN001
            seen.append(Path(workspace))
            # Make the workspace look like a minimal git repo so the apply step
            # (no-op since diff is empty) and copy step succeed.
            (workspace / ".git").mkdir()
            (workspace / "tests").mkdir(exist_ok=True)

        def _run_pytest(self, workspace, test_paths):  # noqa: ANN001
            return True  # short-circuit; we're testing path uniqueness only.

    runner = RecordingRunner(timeout_s=5.0)

    repo_root = tmp_path / "fake-repo"
    repo_root.mkdir()
    task_dir = tmp_path / "task-ac2"
    task = _make_task(
        name="t-ac2",
        repo_root=repo_root,
        commit="dead",
        task_dir=task_dir,
        hidden_files={"test_x.py": "def test_x(): assert True\n"},
    )
    record = _run_record_for(task, diff="")

    # Two calls → two distinct workspace paths, both cleaned up.
    assert runner.run_hidden_tests(task=task, run_record=record) is True
    assert runner.run_hidden_tests(task=task, run_record=record) is True
    assert len(seen) == 2
    assert seen[0] != seen[1]
    for path in seen:
        assert not path.exists(), f"workspace {path} was not cleaned up"


# ---------------------------------------------------------------------------
# AC3 — Stub-repo proof: diff that ships the solution → True; empty → False.
# ---------------------------------------------------------------------------


def test_ac3_stub_repo_solving_diff_passes_empty_diff_fails(tmp_path: Path) -> None:
    """End-to-end with a stub repo: solving diff → True, empty diff → False.

    Stand up a tiny git repo, take the diff that adds ``sample.py``, and feed
    it through the runner against a hidden test that imports + calls
    ``sample.add``. This is the AC3 mechanism proof in a hermetic test
    (independent of the real corpus, which we cover separately).
    """
    repo, parent_commit, head_commit = _make_stub_repo(tmp_path)

    # The "merged-PR diff": parent -> head, scoped to the file the PR shipped.
    diff = subprocess.run(
        ["git", "diff", parent_commit, head_commit, "--", "agentrail/run/sample.py"],
        cwd=str(repo),
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "+def add" in diff

    # The hidden test asserts the implementation behaves correctly.
    hidden_test = (
        "from agentrail.run.sample import add\n"
        "\n"
        "def test_add():\n"
        "    assert add(2, 3) == 5\n"
    )

    task_dir = tmp_path / "task-ac3"
    task = _make_task(
        name="stub-add",
        repo_root=repo,
        commit=parent_commit,  # workspace materialized at PRE-solution commit.
        task_dir=task_dir,
        hidden_files={"test_add.py": hidden_test},
    )

    runner = ProductionHiddenTestRunner(repo_root=repo, timeout_s=60.0)

    # With the solving diff applied → hidden tests pass (real True).
    solved_record = _run_record_for(task, diff=diff)
    assert runner.run_hidden_tests(task=task, run_record=solved_record) is True

    # With an empty diff → the implementation is missing → hidden tests fail.
    empty_record = _run_record_for(task, diff="")
    assert runner.run_hidden_tests(task=task, run_record=empty_record) is False


def test_ac3_real_corpus_output_format_enforcer_end_to_end(tmp_path: Path) -> None:
    """AC3 proof against the REAL corpus task ``output-format-enforcer``.

    The corpus task pins ``commit=8324ef38722f`` (the FIX commit), but at that
    state ``output_enforcer.py`` is already on disk and an empty diff would
    pass — that's the corpus's intended invariant once the agent's role is
    done. For this test (the eval-spine canary), we instead point the runner
    at the PARENT of the file's introduction commit (PR #789 = ``52823c5``,
    parent = ``52823c5^``). At that state ``output_enforcer.py`` does NOT
    exist, so:

    - empty diff → ``from agentrail.run.output_enforcer import ...`` fails →
      hidden tests fail → runner returns ``False``.
    - ``git diff 52823c5^ 52823c5 -- agentrail/run/output_enforcer.py``
      (the merged-PR diff for the file) is applied → file appears → hidden
      tests pass → runner returns ``True``.

    This is the first end-to-end demonstration that the eval harness can
    produce a real green from a real corpus task.

    Skipped if the host repo doesn't have the commit (e.g. a fresh shallow
    clone in CI without history) — the test makes its precondition explicit
    rather than passing-by-skip silently.
    """
    repo_root = _walk_to_repo_root(Path(__file__))
    if repo_root is None:
        pytest.skip("could not locate host repo .git")

    solution_commit = "52823c555ccb60c4802acb318d11ed0c24ca37e8"
    parent_commit = solution_commit + "^"

    rev_parse = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "--verify", parent_commit],
        capture_output=True,
        text=True,
    )
    if rev_parse.returncode != 0:
        pytest.skip(f"host repo missing parent commit {parent_commit}")
    parent_sha = rev_parse.stdout.strip()

    diff = subprocess.run(
        ["git", "-C", str(repo_root), "diff",
         parent_commit, solution_commit,
         "--", "agentrail/run/output_enforcer.py"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "new file mode" in diff, "expected new-file diff"
    assert "all_changes_new_or_rename" in diff

    # Build a CorpusTask pointing at the REAL hidden test for the task, but
    # with the commit corrected to the file's pre-introduction parent. We
    # construct it directly (not from disk) so we don't mutate the corpus.
    corpus_root = repo_root / "agentrail" / "evals" / "corpus" / "output-format-enforcer"
    if not (corpus_root / "answer_key" / "test_output_enforcer.py").is_file():
        pytest.skip("corpus task output-format-enforcer not present in checkout")

    task = CorpusTask(
        name="output-format-enforcer",
        repo="Bensigo/agentrail",
        commit=parent_sha,
        prompt="(see corpus task)",
        agent_visible_root="workdir",
        hidden_tests=HiddenTestRef(
            root="answer_key",
            files=["test_output_enforcer.py"],
            base_dir=corpus_root,
        ),
        required_context=["agentrail/run/output_enforcer.py"],
        difficulty="easy",
        source={"pr": 789, "mergeCommit": solution_commit},
        task_dir=corpus_root,
    )

    runner = ProductionHiddenTestRunner(repo_root=repo_root, timeout_s=180.0)

    # Solving diff → real True. This is the canary.
    solved = _run_record_for(task, diff=diff)
    assert runner.run_hidden_tests(task=task, run_record=solved) is True

    # Empty diff → real False (output_enforcer.py is absent at parent commit).
    empty = _run_record_for(task, diff="")
    assert runner.run_hidden_tests(task=task, run_record=empty) is False


def _walk_to_repo_root(start: Path) -> Path | None:
    for parent in [start, *start.parents]:
        if (parent / ".git").exists():
            return parent
    return None


# ---------------------------------------------------------------------------
# AC4 — wall-clock timeout: hanging hidden test returns False fast.
# ---------------------------------------------------------------------------


def test_ac4_hanging_hidden_test_returns_false_within_timeout(tmp_path: Path) -> None:
    """A hidden test that never returns is killed within ``timeout_s``.

    Stand up the stub repo, ship a hidden test that does ``while True: pass``,
    feed it the solving diff (so the import + collection succeed), and assert
    the runner returns False quickly. The timeout is set to 3s so the test
    itself runs in well under 15s on a loaded machine.
    """
    repo, parent_commit, head_commit = _make_stub_repo(tmp_path)
    diff = subprocess.run(
        ["git", "diff", parent_commit, head_commit, "--", "agentrail/run/sample.py"],
        cwd=str(repo),
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    hanging = (
        "from agentrail.run.sample import add\n"
        "\n"
        "def test_hang():\n"
        "    while True:\n"
        "        pass\n"
    )

    task_dir = tmp_path / "task-ac4"
    task = _make_task(
        name="hangy",
        repo_root=repo,
        commit=parent_commit,
        task_dir=task_dir,
        hidden_files={"test_hang.py": hanging},
    )

    timeout = 3.0
    runner = ProductionHiddenTestRunner(repo_root=repo, timeout_s=timeout)

    record = _run_record_for(task, diff=diff)
    start = time.monotonic()
    out = runner.run_hidden_tests(task=task, run_record=record)
    elapsed = time.monotonic() - start
    assert out is False
    # Generous ceiling: the runner spawns a subprocess + cleans up. Even on a
    # slow CI box the timeout itself dominates; 15s gives plenty of headroom.
    assert elapsed < 15.0, f"runner took {elapsed:.1f}s; timeout was {timeout}s"


# ---------------------------------------------------------------------------
# AC5 — spine's default HiddenTestRunner is the production implementation.
# ---------------------------------------------------------------------------


def test_ac5_run_spine_default_hidden_runner_is_production(monkeypatch, tmp_path: Path) -> None:
    """When called without ``hidden_test_runner``, ``run_spine`` constructs the production runner.

    We don't actually want to run pytest in this test — we only want to prove
    the DEFAULT plumbing. So we monkeypatch ``ProductionHiddenTestRunner`` to
    record its construction and return a fake whose ``run_hidden_tests``
    returns False without any IO. Then we run a tiny spine call with NO
    ``hidden_test_runner`` kwarg and assert our recorder fired.
    """
    constructed: list[object] = []

    class FakeProd:
        def __init__(self, *args, **kwargs):
            constructed.append((args, kwargs))

        def run_hidden_tests(self, *, task, run_record):  # noqa: ANN001
            return False

    monkeypatch.setattr(
        "agentrail.evals.hidden_tests.ProductionHiddenTestRunner", FakeProd
    )

    # Build a one-task corpus on disk so the spine has something to drive.
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    task_dir = corpus / "alpha"
    answer = task_dir / "answer_key"
    visible = task_dir / "workdir"
    answer.mkdir(parents=True)
    visible.mkdir(parents=True)
    (answer / "test_x.py").write_text("def test_x(): assert True\n", encoding="utf-8")
    (visible / "README.md").write_text("# alpha\n", encoding="utf-8")
    (task_dir / "task.json").write_text(json.dumps({
        "name": "alpha",
        "repo": "Bensigo/agentrail",
        "commit": "deadbeef",
        "prompt": "do",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {"root": "answer_key", "files": ["test_x.py"]},
        "requiredContext": ["x"],
        "difficulty": "easy",
    }), encoding="utf-8")

    from agentrail.evals.arms import baseline
    from agentrail.evals.runner import AgentExecution
    from agentrail.evals.spine import SpineConfig, run_spine

    class SmokeExec:
        def execute(self, *, task, arm, workdir):  # noqa: ANN001
            return AgentExecution(
                diff="",
                usage=_empty_usage(),
                model=arm.model,
                gate_passed=False,
                retries=[],
            )

    run_spine(
        SpineConfig(arms=[baseline()], reps=1, corpus_root=corpus),
        executor=SmokeExec(),
        # NO hidden_test_runner — exercise the new default.
        reports_dir=tmp_path / "reports",
        date="2026-06-23",
    )

    assert constructed, "spine did not construct the production HiddenTestRunner by default"


def test_ac5_cli_default_uses_production_runner() -> None:
    """The CLI ``run_evals`` constructs the production runner outside ``--smoke``.

    We don't actually run the CLI here (that would clone + pytest). We just
    inspect the source/import wiring to prove the default path is the
    production runner — a structural assertion, not behavioural.
    """
    import agentrail.cli.commands.evals as evals_cli

    assert hasattr(evals_cli, "ProductionHiddenTestRunner")
    # And the import is from the right module.
    assert evals_cli.ProductionHiddenTestRunner is ProductionHiddenTestRunner


# ---------------------------------------------------------------------------
# Defaults / smoke
# ---------------------------------------------------------------------------


def test_default_timeout_is_sane() -> None:
    """Default timeout is bounded — not unbounded, not zero."""
    assert 1.0 <= DEFAULT_TIMEOUT_S <= 600.0
    runner = ProductionHiddenTestRunner()
    assert runner.timeout_s == DEFAULT_TIMEOUT_S


def test_hidden_tests_subpath_is_under_tests_dir() -> None:
    """The hidden tests are dropped under ``tests/`` for pytest discovery.

    Importantly, the subpath is namespaced (``_eval_hidden``) so it cannot
    collide with a real test path the agent might have shipped.
    """
    parts = HIDDEN_TESTS_SUBPATH.parts
    assert parts[0] == "tests"
    assert parts[1].startswith("_")


# ---------------------------------------------------------------------------
# gate_output plumbing (#1169 AC3) — cap helper + verbatim pytest text.
# ---------------------------------------------------------------------------


def test_cap_gate_output_keeps_the_tail_and_marks_truncation() -> None:
    """``_cap_gate_output`` caps oversized gate output while keeping the TAIL.

    pytest prints its failure summary and tracebacks LAST, so truncating the
    HEAD of an oversized capture (and marking that a cut happened) preserves
    the actionable part of a gate's output; anything already under the cap
    is returned unchanged.
    """
    from agentrail.evals.hidden_tests import (
        _cap_gate_output,
        _GATE_OUTPUT_TRUNCATION_MARKER,
        _MAX_GATE_OUTPUT_CHARS,
    )

    short = "1 passed in 0.01s"
    capped_short = _cap_gate_output(short)
    assert capped_short == short
    assert _GATE_OUTPUT_TRUNCATION_MARKER not in capped_short

    text = ("x" * _MAX_GATE_OUTPUT_CHARS) + "THE-TAIL-SENTINEL"
    capped = _cap_gate_output(text)
    assert capped.startswith(_GATE_OUTPUT_TRUNCATION_MARKER)
    assert capped.endswith("THE-TAIL-SENTINEL")
    assert capped == _GATE_OUTPUT_TRUNCATION_MARKER + text[-_MAX_GATE_OUTPUT_CHARS:]


def test_with_output_returns_verbatim_pytest_failure_output(tmp_path: Path) -> None:
    """``run_hidden_tests_with_output`` carries REAL pytest text as gate_output.

    Production seam for #1169 AC3: a per-rep forensics record's
    ``gate_output`` must show what pytest actually printed, not a fabricated
    summary. Mirrors ``test_ac3_stub_repo_solving_diff_passes_empty_diff_fails``
    but drives the tuple-returning method with the empty diff (the failing
    branch). With no diff applied, ``agentrail/run/sample.py`` was never
    shipped, so the hidden test fails at IMPORT time: pytest reports this as
    a collection ERROR ("1 error"), not an assertion FAILURE ("1 failed").
    The assertions below were pinned by running this exact scenario and
    reading the real captured output, not by assumption.
    """
    repo, parent_commit, _head_commit = _make_stub_repo(tmp_path)

    hidden_test = (
        "from agentrail.run.sample import add\n"
        "\n"
        "def test_add():\n"
        "    assert add(2, 3) == 5\n"
    )

    task_dir = tmp_path / "task-with-output"
    task = _make_task(
        name="stub-add-with-output",
        repo_root=repo,
        commit=parent_commit,  # workspace materialized at PRE-solution commit.
        task_dir=task_dir,
        hidden_files={"test_add.py": hidden_test},
    )

    runner = ProductionHiddenTestRunner(repo_root=repo, timeout_s=60.0)
    empty_record = _run_record_for(task, diff="")
    passed, output = runner.run_hidden_tests_with_output(task=task, run_record=empty_record)

    assert passed is False
    assert isinstance(output, str)
    # The _run_pytest formatting prefix — proves this came from the real
    # subprocess capture, not a hand-built string.
    assert "stdout:" in output
    # Real pytest evidence: a collection error (see docstring for why it's
    # "error" and not "failed" in this particular empty-diff scenario), the
    # concrete exception, and the hidden test's own name.
    assert "error" in output
    assert "ModuleNotFoundError" in output
    assert "test_add" in output


def test_with_output_error_branch_names_the_failure(tmp_path: Path) -> None:
    """Error branches still produce a human-readable, non-fabricated gate_output.

    Mirrors the not-a-repo setup in
    ``test_ac1_returns_real_bool_on_missing_workspace``, but through
    ``run_hidden_tests_with_output``: the materialize step fails before
    pytest ever runs, so ``gate_output`` must still name WHICH step failed
    and why — otherwise a crashed clone and a real hidden-test failure would
    be indistinguishable when read back out of a forensics record.
    """
    not_a_repo = tmp_path / "not-a-repo"
    not_a_repo.mkdir()
    runner = ProductionHiddenTestRunner(repo_root=not_a_repo, timeout_s=5.0)

    task_dir = tmp_path / "task"
    task = _make_task(
        name="t1",
        repo_root=not_a_repo,
        commit="deadbeef",
        task_dir=task_dir,
        hidden_files={"test_x.py": "def test_x():\n    assert True\n"},
    )
    record = _run_record_for(task, diff="")
    passed, output = runner.run_hidden_tests_with_output(task=task, run_record=record)

    assert passed is False
    assert isinstance(output, str)
    assert "materialize failed" in output
