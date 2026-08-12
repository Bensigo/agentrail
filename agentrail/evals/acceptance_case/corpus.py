"""Admission for immutable, independently-labelled Acceptance Case corpora.

Parsing one ``case.json`` is not evidence that its labels are independent or
eligible for a held-out result. This manifest gate keeps synthetic test data
from crossing that boundary.
"""
from __future__ import annotations

import hashlib
import json
import stat
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Literal, Mapping

from .loader import (
    CASE_FILE,
    AcceptanceCase,
    AcceptanceCaseError,
    _has_control_characters,
    _resolved_directory,
    _resolved_regular_file,
    load_case,
)

CORPUS_MANIFEST_FILE = "acceptance-corpus.json"
CORPUS_FORMAT_VERSION = 1
LabelClass = Literal["synthetic", "independent"]
MAX_CASE_NAME_BYTES = 255


class AcceptanceCorpusError(RuntimeError):
    """Raised when a corpus cannot safely support the requested evaluation."""


@dataclass(frozen=True)
class AcceptanceCorpus:
    """Frozen Case inventory with explicit labelling provenance."""

    root: Path
    corpus_version: str
    label_class: LabelClass
    label_authority: Mapping[str, str]
    case_digests: Mapping[str, str]
    cases: tuple[AcceptanceCase, ...]


def _object(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AcceptanceCorpusError(f"Acceptance Case corpus: {label} must be an object")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: {label} must be a non-empty string"
        )
    return value.strip()


def _portable_case_name(value: Any) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise AcceptanceCorpusError(
            "Acceptance Case corpus: manifest case names must be portable directory basenames"
        )
    if (
        value in {".", ".."}
        or "/" in value
        or "\\" in value
        or Path(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or PureWindowsPath(value).drive
        or _has_control_characters(value)
        or len(value.encode("utf-8")) > MAX_CASE_NAME_BYTES
    ):
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: manifest case name {value!r} is not a portable directory basename"
        )
    return value


def _corpus_directory(path: Path, *, root: Path, label: str) -> Path:
    try:
        resolved = _resolved_directory(path, label)
        resolved.relative_to(root)
    except AcceptanceCaseError as error:
        raise AcceptanceCorpusError(str(error)) from error
    except ValueError as error:
        raise AcceptanceCorpusError(f"{label}: directory escapes corpus root") from error
    return resolved


def _corpus_regular_file(path: Path, *, root: Path, label: str) -> Path:
    try:
        return _resolved_regular_file(path, root=root, label=label)
    except AcceptanceCaseError as error:
        raise AcceptanceCorpusError(str(error)) from error


def _case_digest(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError as error:
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: missing {path.parent.name}/{CASE_FILE}"
        ) from error
    except OSError as error:
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: cannot read {path.parent.name}/{CASE_FILE}: {error}"
        ) from error


def _load_manifest(root: Path) -> Mapping[str, Any]:
    path = _corpus_regular_file(
        root / CORPUS_MANIFEST_FILE,
        root=root,
        label="Acceptance Case corpus",
    )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: missing {CORPUS_MANIFEST_FILE}"
        ) from error
    except (OSError, ValueError) as error:
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: invalid {CORPUS_MANIFEST_FILE}: {error}"
        ) from error
    return _object(raw, CORPUS_MANIFEST_FILE)


def load_acceptance_case_corpus(
    root: Path,
    *,
    require_independent_labels: bool = False,
) -> AcceptanceCorpus:
    """Load a frozen manifest-bound corpus and fail closed on drift.

    ``require_independent_labels`` is for held-out promotion/reporting gates.
    Synthetic fixtures remain useful for parser/unit tests, but must not become
    market or promotion evidence merely because their JSON shape is valid.
    """
    try:
        root = _resolved_directory(Path(root), "Acceptance Case corpus root")
    except AcceptanceCaseError as error:
        raise AcceptanceCorpusError(str(error)) from error
    manifest = _load_manifest(root)
    if manifest.get("formatVersion") != CORPUS_FORMAT_VERSION:
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: formatVersion must be {CORPUS_FORMAT_VERSION}"
        )
    corpus_version = _text(manifest.get("corpusVersion"), "corpusVersion")
    label_class_raw = _text(manifest.get("labelClass"), "labelClass")
    if label_class_raw not in {"synthetic", "independent"}:
        raise AcceptanceCorpusError(
            "Acceptance Case corpus: labelClass must be synthetic or independent"
        )
    label_class: LabelClass = label_class_raw  # type: ignore[assignment]
    authority = _object(manifest.get("labelAuthority"), "labelAuthority")
    label_authority = {
        key: _text(value, f"labelAuthority.{key}") for key, value in authority.items()
    }
    if not label_authority:
        raise AcceptanceCorpusError(
            "Acceptance Case corpus: labelAuthority must not be empty"
        )
    expected_cases = _object(manifest.get("cases"), "cases")
    if not expected_cases:
        raise AcceptanceCorpusError("Acceptance Case corpus: cases must not be empty")

    cases: list[AcceptanceCase] = []
    case_digests: dict[str, str] = {}
    for raw_name in sorted(expected_cases):
        name = _portable_case_name(raw_name)
        expected_digest = _text(expected_cases[name], f"cases.{name}")
        case_dir = _corpus_directory(
            root / name,
            root=root,
            label=f"Acceptance Case corpus: case directory {name!r}",
        )
        case_path_candidate = case_dir / CASE_FILE
        try:
            case_path = _corpus_regular_file(
                case_path_candidate,
                root=case_dir,
                label=f"Acceptance Case corpus: case {name!r}",
            )
        except AcceptanceCorpusError as error:
            if not case_path_candidate.exists() and not case_path_candidate.is_symlink():
                raise AcceptanceCorpusError(
                    f"Acceptance Case corpus: missing {name}/{CASE_FILE}"
                ) from error
            raise
        if _case_digest(case_path) != expected_digest:
            raise AcceptanceCorpusError(
                f"Acceptance Case corpus: case digest mismatch for {name}"
            )
        case_digests[name] = expected_digest
        try:
            case = load_case(case_dir)
        except AcceptanceCaseError as error:
            raise AcceptanceCorpusError(str(error)) from error
        if case.name != name:
            raise AcceptanceCorpusError(
                f"Acceptance Case corpus: manifest case {name} does not match case name {case.name}"
            )
        if case.corpus_version != corpus_version:
            raise AcceptanceCorpusError(
                f"Acceptance Case corpus: {name} has corpusVersion {case.corpus_version}, expected {corpus_version}"
            )
        cases.append(case)

    unexpected: list[str] = []
    for path in sorted(root.iterdir()):
        if path.is_symlink():
            raise AcceptanceCorpusError(
                f"Acceptance Case corpus: symlinked entry {path.name!r} is not allowed"
            )
        try:
            metadata = path.lstat()
        except OSError as error:
            raise AcceptanceCorpusError(
                f"Acceptance Case corpus: cannot inspect {path.name!r}: {error}"
            ) from error
        if not stat.S_ISDIR(metadata.st_mode):
            continue
        case_path = path / CASE_FILE
        if not case_path.exists() and not case_path.is_symlink():
            continue
        try:
            load_case(path)
        except AcceptanceCaseError as error:
            raise AcceptanceCorpusError(str(error)) from error
        if path.name not in expected_cases:
            unexpected.append(path.name)
    if unexpected:
        raise AcceptanceCorpusError(
            f"Acceptance Case corpus: unmanifested case directories: {', '.join(unexpected)}"
        )
    if require_independent_labels:
        if label_class != "independent":
            raise AcceptanceCorpusError(
                "Acceptance Case corpus: synthetic labels cannot support held-out promotion or market claims"
            )
        if not any(case.split == "held-out" for case in cases):
            raise AcceptanceCorpusError(
                "Acceptance Case corpus: independent promotion requires at least one held-out Case"
            )
    return AcceptanceCorpus(
        root=root,
        corpus_version=corpus_version,
        label_class=label_class,
        label_authority=label_authority,
        case_digests=case_digests,
        cases=tuple(cases),
    )
