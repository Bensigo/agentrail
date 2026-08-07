"""Admission for immutable, independently-labelled Acceptance Case corpora.

Parsing one ``case.json`` is not evidence that its labels are independent or
eligible for a held-out result. This manifest gate keeps synthetic test data
from crossing that boundary.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

from .loader import CASE_FILE, AcceptanceCase, AcceptanceCaseError, load_case

CORPUS_MANIFEST_FILE = "acceptance-corpus.json"
CORPUS_FORMAT_VERSION = 1
LabelClass = Literal["synthetic", "independent"]


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
        raise AcceptanceCorpusError(f"Acceptance Case corpus: {label} must be a non-empty string")
    return value.strip()


def _case_digest(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError as error:
        raise AcceptanceCorpusError(f"Acceptance Case corpus: missing {path.parent.name}/{CASE_FILE}") from error
    except OSError as error:
        raise AcceptanceCorpusError(f"Acceptance Case corpus: cannot read {path.parent.name}/{CASE_FILE}: {error}") from error


def _load_manifest(root: Path) -> Mapping[str, Any]:
    path = root / CORPUS_MANIFEST_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise AcceptanceCorpusError(f"Acceptance Case corpus: missing {CORPUS_MANIFEST_FILE}") from error
    except (OSError, ValueError) as error:
        raise AcceptanceCorpusError(f"Acceptance Case corpus: invalid {CORPUS_MANIFEST_FILE}: {error}") from error
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
    root = Path(root)
    manifest = _load_manifest(root)
    if manifest.get("formatVersion") != CORPUS_FORMAT_VERSION:
        raise AcceptanceCorpusError(f"Acceptance Case corpus: formatVersion must be {CORPUS_FORMAT_VERSION}")
    corpus_version = _text(manifest.get("corpusVersion"), "corpusVersion")
    label_class_raw = _text(manifest.get("labelClass"), "labelClass")
    if label_class_raw not in {"synthetic", "independent"}:
        raise AcceptanceCorpusError("Acceptance Case corpus: labelClass must be synthetic or independent")
    label_class: LabelClass = label_class_raw  # type: ignore[assignment]
    authority = _object(manifest.get("labelAuthority"), "labelAuthority")
    label_authority = {key: _text(value, f"labelAuthority.{key}") for key, value in authority.items()}
    if not label_authority:
        raise AcceptanceCorpusError("Acceptance Case corpus: labelAuthority must not be empty")
    expected_cases = _object(manifest.get("cases"), "cases")
    if not expected_cases:
        raise AcceptanceCorpusError("Acceptance Case corpus: cases must not be empty")

    cases: list[AcceptanceCase] = []
    case_digests: dict[str, str] = {}
    for name in sorted(expected_cases):
        expected_digest = _text(expected_cases[name], f"cases.{name}")
        case_path = root / name / CASE_FILE
        if _case_digest(case_path) != expected_digest:
            raise AcceptanceCorpusError(f"Acceptance Case corpus: case digest mismatch for {name}")
        case_digests[name] = expected_digest
        try:
            case = load_case(case_path.parent)
        except AcceptanceCaseError as error:
            raise AcceptanceCorpusError(str(error)) from error
        if case.name != name:
            raise AcceptanceCorpusError(f"Acceptance Case corpus: manifest case {name} does not match case name {case.name}")
        if case.corpus_version != corpus_version:
            raise AcceptanceCorpusError(f"Acceptance Case corpus: {name} has corpusVersion {case.corpus_version}, expected {corpus_version}")
        cases.append(case)

    unexpected = sorted(
        path.name for path in root.iterdir()
        if path.is_dir() and (path / CASE_FILE).is_file() and path.name not in expected_cases
    )
    if unexpected:
        raise AcceptanceCorpusError(f"Acceptance Case corpus: unmanifested case directories: {', '.join(unexpected)}")
    if require_independent_labels:
        if label_class != "independent":
            raise AcceptanceCorpusError("Acceptance Case corpus: synthetic labels cannot support held-out promotion or market claims")
        if not any(case.split == "held-out" for case in cases):
            raise AcceptanceCorpusError("Acceptance Case corpus: independent promotion requires at least one held-out Case")
    return AcceptanceCorpus(
        root=root,
        corpus_version=corpus_version,
        label_class=label_class,
        label_authority=label_authority,
        case_digests=case_digests,
        cases=tuple(cases),
    )
