"""Immutable input fingerprints for a single eval run.

The report is a decision record, not merely a rendered scorecard.  These
fingerprints identify the exact code, configuration, frozen corpus, hidden
answer key, scorer, and gate implementation that produced it. They deliberately
use content hashes rather than a git revision alone: a dirty checkout is identified
honestly instead of being mistaken for its last commit.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class EvalProvenance:
    """Six required content-addressed inputs for a promotable eval report."""

    code_sha256: str
    config_sha256: str
    corpus_sha256: str
    answer_key_sha256: str
    scorer_sha256: str
    gate_sha256: str

    def as_rows(self) -> tuple[tuple[str, str], ...]:
        return (
            ("Code", self.code_sha256),
            ("Config", self.config_sha256),
            ("Corpus", self.corpus_sha256),
            ("Answer key", self.answer_key_sha256),
            ("Scorer", self.scorer_sha256),
            ("Gate", self.gate_sha256),
        )


_CYCLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$")
_EVAL_CYCLE_STATUSES = frozenset(
    {"proposed", "running", "rejected", "promoted", "held"}
)


@dataclass(frozen=True)
class EvalCycle:
    """Immutable recursive eval-cycle metadata carried by persisted reports."""

    cycle_id: str | None
    parent_cycle_id: str | None
    hypothesis: str | None
    changed_layers: tuple[str, ...]
    declared_budget_usd: str | None
    status: str | None

    def issues(self) -> tuple[str, ...]:
        issues: list[str] = []
        if not _valid_cycle_id(self.cycle_id):
            issues.append("cycle id missing or malformed")
        if self.parent_cycle_id is not None and not _valid_cycle_id(self.parent_cycle_id):
            issues.append("parent id is malformed")
        if self.parent_cycle_id == self.cycle_id and self.cycle_id is not None:
            issues.append("parent id must not equal cycle id")
        if not _has_text(self.hypothesis):
            issues.append("hypothesis missing")
        if not self.changed_layers:
            issues.append("changed layers missing")
        elif any(not _has_text(layer) for layer in self.changed_layers):
            issues.append("changed layers contain blanks")
        if _parse_budget(self.declared_budget_usd) is None:
            issues.append("declared budget missing or invalid")
        if self.status not in _EVAL_CYCLE_STATUSES:
            issues.append(
                "status missing or invalid "
                f"(expected one of: {', '.join(sorted(_EVAL_CYCLE_STATUSES))})"
            )
        return tuple(issues)

    @property
    def promotion_grade(self) -> str:
        return "HOLD" if self.issues() else "METADATA_COMPLETE"

    def as_render_rows(self) -> tuple[tuple[str, str], ...]:
        hold_reason = (
            "valid immutable metadata supplied"
            if not self.issues()
            else "; ".join(self.issues())
        )
        return (
            ("Promotion grade", f"{self.promotion_grade} — {hold_reason}"),
            ("Cycle ID", self.cycle_id or "missing"),
            ("Parent cycle ID", self.parent_cycle_id or "none"),
            ("Hypothesis", _markdown_cell(self.hypothesis or "missing")),
            (
                "Changed layers",
                _markdown_cell(
                    ", ".join(layer for layer in self.changed_layers if layer)
                    or "missing"
                ),
            ),
            ("Declared budget", _format_budget(self.declared_budget_usd)),
            ("Status", self.status or "missing"),
        )


def _hash_files(files: Iterable[Path], *, relative_to: Path) -> str:
    """Hash path names and bytes in a deterministic, unambiguous stream."""
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: item.relative_to(relative_to).as_posix()):
        relative = path.relative_to(relative_to).as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _has_text(value: str | None) -> bool:
    return value is not None and bool(value.strip())


def _valid_cycle_id(value: str | None) -> bool:
    return value is not None and bool(_CYCLE_ID_PATTERN.fullmatch(value))


def _parse_budget(value: str | None) -> Decimal | None:
    if value is None or not value.strip():
        return None
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        return None
    if parsed.is_nan() or parsed.is_infinite() or parsed < 0:
        return None
    return parsed


def _format_budget(value: str | None) -> str:
    parsed = _parse_budget(value)
    return "missing" if parsed is None else f"${parsed.normalize()}"


def _markdown_cell(value: str) -> str:
    """Keep untrusted cycle text inside one rendered markdown table cell."""
    return (
        value.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("\r", " ")
        .replace("\n", " ")
    )


def _python_sources(root: Path) -> list[Path]:
    """All shipped Python except mutable/generated eval outputs and corpus data."""
    return [
        path
        for path in root.rglob("*.py")
        if "__pycache__" not in path.parts
        and path.relative_to(root).parts[:2] != ("evals", "reports")
        and path.relative_to(root).parts[:2] != ("evals", "corpus")
    ]


def _corpus_files(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file() and "__pycache__" not in path.parts]


def _answer_key_files(root: Path) -> list[Path]:
    """Declared hidden-test files only; report their hash without content."""
    files: list[Path] = []
    for manifest in root.rglob("task.json"):
        try:
            record = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        hidden = record.get("hiddenTests") if isinstance(record, dict) else None
        if not isinstance(hidden, dict):
            continue
        hidden_root = hidden.get("root")
        hidden_files = hidden.get("files")
        if not isinstance(hidden_root, str) or not isinstance(hidden_files, list):
            continue
        for filename in hidden_files:
            if not isinstance(filename, str):
                continue
            candidate = (manifest.parent / hidden_root / filename).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            if candidate.is_file():
                files.append(candidate)
    return files


def _config_payload(config: Any) -> Mapping[str, Any]:
    """Canonical representation of the eval invocation."""
    arms = []
    for arm in config.arms:
        # ``Arm.extra_layers`` may be an immutable mappingproxy.  ``asdict``
        # deep-copies it and raises, so construct only the declared scalar
        # inputs explicitly instead of relying on a serializer with a broader
        # contract than the configuration actually has.
        arms.append(
            {
                "name": arm.name,
                "layers": asdict(arm.layers),
                "model": arm.model,
                "temperature": arm.temperature,
                "extra_layers": dict(sorted(arm.extra_layers.items())),
                "critic_model": arm.critic_model,
                "gather_model": arm.gather_model,
                "retrieval_max_tokens": arm.retrieval_max_tokens,
            }
        )
    return {
        "arms": arms,
        "reps": config.reps,
        "task_filter": list(config.task_filter) if config.task_filter is not None else None,
        "include_held_out": config.include_held_out,
        "held_out_family": config.held_out_family,
        "concurrency": config.concurrency,
        "pack_index_root": str(config.pack_index_root) if config.pack_index_root else None,
        "cost_ledger_path": str(config.cost_ledger_path) if config.cost_ledger_path else None,
    }


def build_eval_provenance(*, config: Any, package_root: Path, corpus_root: Path) -> EvalProvenance:
    """Build immutable fingerprints from the real sources used by one run."""
    package_root = package_root.resolve()
    corpus_root = corpus_root.resolve()
    config_bytes = json.dumps(
        _config_payload(config), sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")
    return EvalProvenance(
        code_sha256=_hash_files(_python_sources(package_root), relative_to=package_root),
        config_sha256=hashlib.sha256(config_bytes).hexdigest(),
        corpus_sha256=_hash_files(_corpus_files(corpus_root), relative_to=corpus_root),
        answer_key_sha256=_hash_files(
            _answer_key_files(corpus_root), relative_to=corpus_root
        ),
        scorer_sha256=_hash_files(
            [package_root / "evals" / "scorer.py", package_root / "evals" / "run_record.py"],
            relative_to=package_root,
        ),
        gate_sha256=_hash_files(
            [
                package_root / "evals" / "hidden_tests.py",
                package_root / "evals" / "runner.py",
                package_root / "run" / "objective_gate.py",
            ],
            relative_to=package_root,
        ),
    )
