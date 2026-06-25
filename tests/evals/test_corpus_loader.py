"""Tests for the frozen eval corpus loader/validator (issue #932).

Mirrors the fixture-driven, deterministic style of the offline retrieval
evaluation tests. Tests fix the inputs and assert on observable output so the
loader's internals can be refactored without rewriting these tests.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.evals.corpus import (
    DIFFICULTY_TAGS,
    TASK_KIND_VALUES,
    CorpusError,
    CorpusTask,
    corpus_root,
    load_corpus,
    load_task,
)


REPO_ROOT = Path(__file__).resolve().parents[2]


def _write_task(
    tmp_path: Path,
    *,
    record: dict,
    hidden_files: dict | None = None,
    name: str = "demo-task",
) -> Path:
    """Create a task directory on disk and return it.

    ``hidden_files`` maps a relative path (under the task dir) to file contents,
    so tests can control whether the answer-key files actually exist.
    """
    task_dir = tmp_path / name
    task_dir.mkdir(parents=True, exist_ok=True)
    if hidden_files is None:
        hidden_files = {"answer_key/test_demo.py": "def test_ok():\n    assert True\n"}
    for rel, content in hidden_files.items():
        path = task_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    (task_dir / "task.json").write_text(json.dumps(record), encoding="utf-8")
    return task_dir


def _valid_record() -> dict:
    return {
        "name": "demo-task",
        "repo": "Bensigo/agentrail",
        "commit": "deadbeef1234",
        "prompt": "Do the thing the merged PR did.",
        "agentVisibleRoot": "workdir",
        "hiddenTests": {"root": "answer_key", "files": ["test_demo.py"]},
        "requiredContext": ["agentrail/example/module.py"],
        "difficulty": "medium",
        "source": {"pr": 123, "issue": 99, "mergeCommit": "deadbeef1234"},
    }


# ---------------------------------------------------------------------------
# AC1 — valid load into a typed record
# ---------------------------------------------------------------------------


def test_load_task_returns_typed_record(tmp_path: Path) -> None:
    task_dir = _write_task(tmp_path, record=_valid_record())
    task = load_task(task_dir)

    assert isinstance(task, CorpusTask)
    assert task.name == "demo-task"
    assert task.repo == "Bensigo/agentrail"
    assert task.commit == "deadbeef1234"
    assert task.prompt == "Do the thing the merged PR did."
    assert task.required_context == ["agentrail/example/module.py"]
    assert task.difficulty == "medium"
    # hidden-test reference resolves to the real file we wrote
    assert task.hidden_test_paths == [task_dir / "answer_key" / "test_demo.py"]
    assert task.hidden_test_paths[0].is_file()


def test_load_corpus_is_deterministic_and_sorted(tmp_path: Path) -> None:
    for name in ("b-task", "a-task", "c-task"):
        rec = _valid_record()
        rec["name"] = name
        _write_task(tmp_path, record=rec, name=name)

    first = [t.name for t in load_corpus(tmp_path)]
    second = [t.name for t in load_corpus(tmp_path)]
    assert first == ["a-task", "b-task", "c-task"]
    assert first == second  # deterministic


# ---------------------------------------------------------------------------
# AC2 — malformed rejection cases, each naming the offending field
# ---------------------------------------------------------------------------


def test_missing_hidden_tests_reference_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    del rec["hiddenTests"]
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="hiddenTests"):
        load_task(task_dir)


def test_empty_hidden_tests_files_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["hiddenTests"] = {"root": "answer_key", "files": []}
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="hiddenTests.files"):
        load_task(task_dir)


def test_hidden_test_file_that_does_not_exist_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["hiddenTests"] = {"root": "answer_key", "files": ["test_missing.py"]}
    # only write a different file, not the referenced one
    task_dir = _write_task(
        tmp_path,
        record=rec,
        hidden_files={"answer_key/test_present.py": "def test_x():\n    assert True\n"},
    )
    with pytest.raises(CorpusError, match="does not resolve to a real file"):
        load_task(task_dir)


def test_missing_required_context_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    del rec["requiredContext"]
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="requiredContext"):
        load_task(task_dir)


def test_empty_required_context_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["requiredContext"] = []
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="requiredContext"):
        load_task(task_dir)


def test_unknown_difficulty_tag_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["difficulty"] = "trivial"
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="difficulty"):
        load_task(task_dir)


def test_missing_difficulty_tag_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    del rec["difficulty"]
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="difficulty"):
        load_task(task_dir)


@pytest.mark.parametrize("field", ["name", "repo", "commit", "prompt", "agentVisibleRoot"])
def test_missing_core_string_field_is_rejected(tmp_path: Path, field: str) -> None:
    rec = _valid_record()
    del rec[field]
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match=field):
        load_task(task_dir)


def test_invalid_json_is_rejected(tmp_path: Path) -> None:
    task_dir = tmp_path / "broken"
    task_dir.mkdir()
    (task_dir / "answer_key").mkdir()
    (task_dir / "answer_key" / "test_demo.py").write_text("def test():\n    pass\n")
    (task_dir / "task.json").write_text("{ not valid json", encoding="utf-8")
    with pytest.raises(CorpusError, match="invalid task.json"):
        load_task(task_dir)


# ---------------------------------------------------------------------------
# AC3 — answer-key separation: hidden tests not under the agent-visible tree
# ---------------------------------------------------------------------------


def test_hidden_tests_under_agent_visible_root_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    # Place the answer key INSIDE the path handed to the agent — must be rejected.
    rec["agentVisibleRoot"] = "workdir"
    rec["hiddenTests"] = {"root": "workdir/tests", "files": ["test_demo.py"]}
    task_dir = _write_task(
        tmp_path,
        record=rec,
        hidden_files={"workdir/tests/test_demo.py": "def test():\n    assert True\n"},
    )
    with pytest.raises(CorpusError, match="separately"):
        load_task(task_dir)


def test_hidden_tests_equal_to_agent_visible_root_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["agentVisibleRoot"] = "workdir"
    rec["hiddenTests"] = {"root": "workdir", "files": ["test_demo.py"]}
    task_dir = _write_task(
        tmp_path,
        record=rec,
        hidden_files={"workdir/test_demo.py": "def test():\n    assert True\n"},
    )
    with pytest.raises(CorpusError, match="separately"):
        load_task(task_dir)


def test_answer_key_path_is_not_under_agent_visible_path_for_real_corpus() -> None:
    """For every real corpus task, the hidden-test path is NOT under the path
    handed to the agent (the core answer-key-separation invariant)."""
    tasks = load_corpus()
    assert tasks, "real corpus must not be empty"
    for task in tasks:
        visible = task.agent_visible_path.resolve()
        for hidden in task.hidden_test_paths:
            hidden = hidden.resolve()
            assert not str(hidden).startswith(str(visible) + "/"), (
                f"{task.name}: answer key {hidden} must not live under agent-visible {visible}"
            )


# ---------------------------------------------------------------------------
# AC4 / AC5 — real frozen corpus v0
# ---------------------------------------------------------------------------


def test_real_corpus_loads_and_is_well_formed() -> None:
    # Validate the WHOLE corpus (dev + held-out): well-formedness is a
    # corpus-integrity property, independent of the dev/held-out split (#941).
    tasks = load_corpus(include_held_out=True)
    assert len(tasks) >= 10, f"corpus v0 should have ~10 tasks, found {len(tasks)}"
    for task in tasks:
        assert task.difficulty in DIFFICULTY_TAGS
        assert task.required_context, f"{task.name} missing required context"
        assert task.repo == "Bensigo/agentrail"
        assert task.commit
        # each hidden-test reference resolves to a real file
        assert task.hidden_test_paths
        for path in task.hidden_test_paths:
            assert path.is_file(), f"{task.name}: hidden test {path} does not exist"
            assert path.read_text(encoding="utf-8").strip(), f"{task.name}: empty hidden test"


def test_real_corpus_difficulty_spread() -> None:
    """Difficulty stratification is real, not a single bucket."""
    tasks = load_corpus()
    tags = {t.difficulty for t in tasks}
    assert len(tags) >= 2, f"corpus should span multiple difficulty tags, got {tags}"


def test_corpus_root_points_at_committed_corpus() -> None:
    root = corpus_root()
    assert root == REPO_ROOT / "agentrail" / "evals" / "corpus"
    assert root.is_dir()


# ---------------------------------------------------------------------------
# Issue #941 — held-out split (honesty rail).
#   ``heldOut`` is an optional bool defaulting False. Held-out tasks are
#   EXCLUDED from the default load and only present when explicitly requested.
# ---------------------------------------------------------------------------


def test_held_out_defaults_false_when_absent(tmp_path: Path) -> None:
    """``heldOut`` is optional; a task without it is a normal (dev-set) task."""
    task = load_task(_write_task(tmp_path, record=_valid_record()))
    assert task.held_out is False


def test_held_out_true_loads_onto_record(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["heldOut"] = True
    task = load_task(_write_task(tmp_path, record=rec))
    assert task.held_out is True


def test_held_out_non_bool_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["heldOut"] = "yes"
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="heldOut"):
        load_task(task_dir)


def test_load_corpus_excludes_held_out_by_default(tmp_path: Path) -> None:
    """The default dev run must NOT include held-out tasks (AC1/AC3)."""
    dev = _valid_record()
    dev["name"] = "dev-task"
    _write_task(tmp_path, record=dev, name="dev-task")

    held = _valid_record()
    held["name"] = "held-task"
    held["heldOut"] = True
    _write_task(tmp_path, record=held, name="held-task")

    names = [t.name for t in load_corpus(tmp_path)]
    assert names == ["dev-task"], "held-out task must be excluded by default"


def test_load_corpus_includes_held_out_only_when_requested(tmp_path: Path) -> None:
    """An explicit flag includes held-out tasks alongside the dev set (AC1)."""
    dev = _valid_record()
    dev["name"] = "dev-task"
    _write_task(tmp_path, record=dev, name="dev-task")

    held = _valid_record()
    held["name"] = "held-task"
    held["heldOut"] = True
    _write_task(tmp_path, record=held, name="held-task")

    names = [t.name for t in load_corpus(tmp_path, include_held_out=True)]
    assert names == ["dev-task", "held-task"]


# ---------------------------------------------------------------------------
# AC3 — held-out tasks are not in the REAL default-run set.
# ---------------------------------------------------------------------------


def test_real_corpus_has_a_held_out_split() -> None:
    """The real v0 corpus reserves a non-empty held-out split (honesty rail)."""
    everything = load_corpus(include_held_out=True)
    held = [t for t in everything if t.held_out]
    assert held, "real corpus must reserve at least one held-out task"


def test_real_corpus_default_run_excludes_held_out_tasks() -> None:
    """AC3: held-out tasks are NOT in the default-run set of the real corpus."""
    default_names = {t.name for t in load_corpus()}
    held_names = {t.name for t in load_corpus(include_held_out=True) if t.held_out}
    assert held_names, "expected a non-empty held-out split to test against"
    assert default_names.isdisjoint(held_names), (
        f"held-out tasks leaked into the default run: {default_names & held_names}"
    )
    # And including them is strictly a superset.
    all_names = {t.name for t in load_corpus(include_held_out=True)}
    assert default_names | held_names == all_names


# ---------------------------------------------------------------------------
# taskKind field (issue #992)
# ---------------------------------------------------------------------------


def test_task_kind_defaults_to_implement(tmp_path: Path) -> None:
    """taskKind is optional; absent means 'implement'."""
    task = load_task(_write_task(tmp_path, record=_valid_record()))
    assert task.task_kind == "implement"


def test_task_kind_implement_loads_correctly(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["taskKind"] = "implement"
    task = load_task(_write_task(tmp_path, record=rec))
    assert task.task_kind == "implement"


def test_task_kind_abstain_loads_correctly(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["taskKind"] = "abstain"
    task = load_task(_write_task(tmp_path, record=rec))
    assert task.task_kind == "abstain"


def test_invalid_task_kind_is_rejected(tmp_path: Path) -> None:
    rec = _valid_record()
    rec["taskKind"] = "explore"
    task_dir = _write_task(tmp_path, record=rec)
    with pytest.raises(CorpusError, match="taskKind"):
        load_task(task_dir)


def test_real_corpus_task_kinds_are_valid() -> None:
    """Every task in the real corpus has a valid task_kind value."""
    tasks = load_corpus(include_held_out=True)
    for task in tasks:
        assert task.task_kind in TASK_KIND_VALUES, (
            f"{task.name}: task_kind {task.task_kind!r} is not a valid TASK_KIND_VALUES entry"
        )


def test_real_corpus_has_at_least_one_abstain_task() -> None:
    """The real corpus must include at least one abstain task (issue #992)."""
    tasks = load_corpus(include_held_out=True)
    abstain = [t for t in tasks if t.task_kind == "abstain"]
    assert abstain, "corpus must have at least one abstain task"
