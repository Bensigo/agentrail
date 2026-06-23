"""Pure, deterministic loader + validator for frozen corpus tasks.

Layout (one directory per task under ``agentrail/evals/corpus/``):

    agentrail/evals/corpus/<task_id>/
        task.json          # the task record (validated by this module)
        answer_key/        # hidden test suite (the answer key), stored
            test_*.py      #   SEPARATELY from the agent-visible working tree

``task.json`` schema (all fields required unless noted):

    {
      "name": "<task id>",                # display/lookup id
      "repo": "Bensigo/agentrail",        # repository the task is pinned to
      "commit": "<merge sha>",            # commit the repo is pinned at
      "prompt": "<issue / task text>",    # what the agent is asked to do
      "agentVisibleRoot": "workdir",      # rel path the agent works in (the
                                          #   tree it sees); the answer key
                                          #   must NOT live under this path
      "hiddenTests": {                    # reference to the hidden answer key
        "root": "answer_key",            #   rel dir holding the hidden tests
        "files": ["test_x.py", ...]      #   the hidden test file(s)
      },
      "requiredContext": ["path", ...],   # ground-truth required-context set
      "difficulty": "easy|medium|hard",   # difficulty tag (required-context scatter proxy)
      "source": {                         # provenance (optional but recommended)
        "pr": 791,
        "issue": 770,
        "mergeCommit": "<sha>"
      }
    }

Validation mirrors ``agentrail/context/evaluation.py``: malformed records raise
a ``CorpusError`` naming the offending field.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# Difficulty is proxied by required-context scatter (PRD "Honesty rails").
DIFFICULTY_TAGS = ("easy", "medium", "hard")

TASK_FILE = "task.json"


class CorpusError(RuntimeError):
    """Raised when a corpus task definition is malformed."""


@dataclass(frozen=True)
class HiddenTestRef:
    """Reference to a task's hidden test suite (the answer key)."""

    root: str
    files: List[str]
    base_dir: Path

    @property
    def paths(self) -> List[Path]:
        """Absolute paths to each hidden test file."""
        return [self.base_dir / self.root / name for name in self.files]


@dataclass(frozen=True)
class CorpusTask:
    """A single validated, frozen corpus task.

    Exposes everything the eval spine needs: repo+commit, prompt, the
    hidden-test reference, the required-context set, and the difficulty tag.
    """

    name: str
    repo: str
    commit: str
    prompt: str
    agent_visible_root: str
    hidden_tests: HiddenTestRef
    required_context: List[str]
    difficulty: str
    # Honesty rail (#941): held-out tasks are reserved from the dev set so the
    # harness is never tuned against them. Optional in task.json (defaults
    # False); excluded from ``load_corpus`` unless ``include_held_out=True``.
    held_out: bool = False
    source: Dict[str, Any] = field(default_factory=dict)
    task_dir: Optional[Path] = None

    @property
    def agent_visible_path(self) -> Path:
        """Absolute path of the working tree handed to the agent."""
        assert self.task_dir is not None
        return self.task_dir / self.agent_visible_root

    @property
    def hidden_test_paths(self) -> List[Path]:
        """Absolute paths to the hidden test files (the answer key)."""
        return self.hidden_tests.paths


def corpus_root() -> Path:
    """Directory holding the frozen corpus tasks (this package's dir)."""
    return Path(__file__).resolve().parent


def _require_str(record: Dict[str, Any], field_name: str, *, where: str) -> str:
    value = record.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise CorpusError(f"corpus task {where}: field '{field_name}' must be a non-empty string")
    return value


def _string_list(value: Any, field_name: str, *, where: str) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise CorpusError(f"corpus task {where}: field '{field_name}' must be an array of non-empty strings")
    return list(value)


def _parse_task(record: Any, *, base_dir: Path, where: str) -> CorpusTask:
    if not isinstance(record, dict):
        raise CorpusError(f"corpus task {where}: task.json must be a JSON object")

    name = _require_str(record, "name", where=where)
    repo = _require_str(record, "repo", where=where)
    commit = _require_str(record, "commit", where=where)
    prompt = _require_str(record, "prompt", where=where)
    agent_visible_root = _require_str(record, "agentVisibleRoot", where=where)

    # --- hidden-test reference (the answer key) ---------------------------
    hidden = record.get("hiddenTests")
    if not isinstance(hidden, dict):
        raise CorpusError(
            f"corpus task {where}: field 'hiddenTests' is required and must be an object "
            f"with 'root' and 'files'"
        )
    hidden_root = _require_str(hidden, "root", where=f"{where} hiddenTests")
    hidden_files = _string_list(hidden.get("files"), "files", where=f"{where} hiddenTests")
    if not hidden_files:
        raise CorpusError(
            f"corpus task {where}: field 'hiddenTests.files' must list at least one hidden test file"
        )

    # Answer-key separation: the hidden tests must NOT live under the
    # agent-visible working tree, or the answer key would leak (AC3).
    visible = PurePosix(agent_visible_root)
    answer = PurePosix(hidden_root)
    if answer == visible or answer.is_relative_to_compat(visible):
        raise CorpusError(
            f"corpus task {where}: hidden tests (root '{hidden_root}') must be stored "
            f"separately from the agent-visible working tree (root '{agent_visible_root}'); "
            f"the answer key must not live under the path handed to the agent"
        )

    hidden_ref = HiddenTestRef(root=hidden_root, files=hidden_files, base_dir=base_dir)

    # Every referenced hidden test file must resolve to a real file (AC4).
    for path in hidden_ref.paths:
        if not path.is_file():
            raise CorpusError(
                f"corpus task {where}: hidden test reference does not resolve to a real file: {path}"
            )

    # --- required-context set --------------------------------------------
    required_context = _string_list(record.get("requiredContext"), "requiredContext", where=where)
    if not required_context:
        raise CorpusError(
            f"corpus task {where}: field 'requiredContext' is required and must list "
            f"at least one ground-truth required-context source"
        )

    # --- difficulty tag --------------------------------------------------
    difficulty = record.get("difficulty")
    if not isinstance(difficulty, str) or difficulty not in DIFFICULTY_TAGS:
        raise CorpusError(
            f"corpus task {where}: field 'difficulty' must be one of "
            f"{', '.join(DIFFICULTY_TAGS)} (got {difficulty!r})"
        )

    # --- held-out split flag (honesty rail, #941) ------------------------
    # Optional; defaults False. Must be a real bool when present (a string
    # "true" is a configuration mistake that would silently keep a held-out
    # task in the dev set).
    held_out_raw = record.get("heldOut", False)
    if not isinstance(held_out_raw, bool):
        raise CorpusError(
            f"corpus task {where}: field 'heldOut' must be a boolean when present "
            f"(got {held_out_raw!r})"
        )

    source = record.get("source") or {}
    if not isinstance(source, dict):
        raise CorpusError(f"corpus task {where}: field 'source' must be an object when present")

    return CorpusTask(
        name=name,
        repo=repo,
        commit=commit,
        prompt=prompt,
        agent_visible_root=agent_visible_root,
        hidden_tests=hidden_ref,
        required_context=required_context,
        difficulty=difficulty,
        held_out=held_out_raw,
        source=source,
        task_dir=base_dir,
    )


class PurePosix:
    """Minimal forward-slash path helper for answer-key containment checks.

    Used instead of ``pathlib.PurePosixPath`` only to provide an
    ``is_relative_to``-style check that works on all supported Python versions.
    """

    def __init__(self, raw: str) -> None:
        # Normalize: strip leading "./" and trailing slashes, split on "/".
        parts = [p for p in raw.replace("\\", "/").split("/") if p not in ("", ".")]
        self.parts = tuple(parts)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, PurePosix) and self.parts == other.parts

    def __hash__(self) -> int:
        return hash(self.parts)

    def is_relative_to_compat(self, other: "PurePosix") -> bool:
        if not other.parts:
            return True
        return self.parts[: len(other.parts)] == other.parts


def load_task(task_dir: Path) -> CorpusTask:
    """Load and validate a single corpus task from its directory."""
    task_dir = Path(task_dir)
    task_path = task_dir / TASK_FILE
    where = f"'{task_dir.name}'"
    try:
        parsed = json.loads(task_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise CorpusError(f"corpus task {where}: missing {TASK_FILE} at {task_path}") from error
    except Exception as error:
        raise CorpusError(f"corpus task {where}: invalid {TASK_FILE}: {error}") from error
    return _parse_task(parsed, base_dir=task_dir, where=where)


def load_corpus(
    root: Optional[Path] = None, *, include_held_out: bool = False
) -> List[CorpusTask]:
    """Load every valid task under the corpus directory, sorted by name.

    Pure and deterministic: a task directory is any subdirectory containing a
    ``task.json``. Order is stable (sorted by directory name) so repeated loads
    return identical results.

    Honesty rail (#941): tasks flagged ``heldOut`` in their ``task.json`` are
    EXCLUDED by default so the harness is never developed against them. Pass
    ``include_held_out=True`` to include the full corpus (the explicit,
    deliberate "score the held-out split" path).
    """
    base = Path(root) if root is not None else corpus_root()
    task_dirs = sorted(
        (child for child in base.iterdir() if child.is_dir() and (child / TASK_FILE).is_file()),
        key=lambda path: path.name,
    )
    tasks = [load_task(task_dir) for task_dir in task_dirs]
    if include_held_out:
        return tasks
    return [task for task in tasks if not task.held_out]
