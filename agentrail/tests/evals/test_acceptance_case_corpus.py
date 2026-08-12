"""Admission tests for frozen Acceptance Case corpus provenance."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.corpus import (
    AcceptanceCorpusError,
    load_acceptance_case_corpus,
)


def _case(name: str, split: str) -> dict[str, object]:
    return {
        "name": name,
        "split": split,
        "corpusVersion": "v1",
        "userRequest": "Show the saved state.",
        "sourceConversation": [{"id": "m1", "text": "Show save state"}],
        "pinned": {"repo": "example/frozen-app", "commit": "frozen-commit"},
        "relevantSources": ["src/save.tsx:1-20"],
        "approvedContract": {
            "version": "contract-v1",
            "acceptanceCriteria": [{"id": "saved", "text": "Saved state is visible"}],
        },
        "contextPack": {
            "contentHash": "sha256:pack",
            "tokenBudget": 900,
            "citedSourceRanges": ["src/save.tsx:1-20"],
        },
        "clarificationTruth": {"necessaryQuestions": []},
        "prRevisions": [{"headSha": "head-sha", "diffIdentity": "sha256:diff"}],
        "environments": [{"id": "preview-1", "modality": "ui"}],
        "independentLabels": {
            "contract": {},
            "context": {},
            "review": {},
            "proof": {},
            "correction": {},
            "outcome": {},
        },
        "source": {"kind": "synthetic-test-fixture"},
    }


def _write_corpus(root: Path, label_class: str = "synthetic") -> None:
    digests: dict[str, str] = {}
    for name, split in (("dev-save", "dev"), ("held-save", "held-out")):
        path = root / name
        path.mkdir()
        case_path = path / "case.json"
        case_path.write_text(json.dumps(_case(name, split), sort_keys=True), encoding="utf-8")
        digests[name] = hashlib.sha256(case_path.read_bytes()).hexdigest()
    (root / "acceptance-corpus.json").write_text(
        json.dumps(
            {
                "formatVersion": 1,
                "corpusVersion": "v1",
                "labelClass": label_class,
                "labelAuthority": {
                    "id": "human-review-board",
                    "version": "2026-08",
                },
                "cases": digests,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def _manifest(root: Path) -> dict[str, object]:
    return json.loads((root / "acceptance-corpus.json").read_text(encoding="utf-8"))


def _write_manifest(root: Path, manifest: dict[str, object]) -> None:
    (root / "acceptance-corpus.json").write_text(
        json.dumps(manifest, sort_keys=True),
        encoding="utf-8",
    )


def test_loads_a_frozen_independent_dev_and_held_out_corpus(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="independent")

    corpus = load_acceptance_case_corpus(tmp_path, require_independent_labels=True)

    assert corpus.label_class == "independent"
    assert corpus.label_authority["id"] == "human-review-board"
    assert [(case.name, case.split) for case in corpus.cases] == [
        ("dev-save", "dev"),
        ("held-save", "held-out"),
    ]


def test_synthetic_fixture_cannot_be_used_for_promotion_or_market_claims(
    tmp_path: Path,
) -> None:
    _write_corpus(tmp_path, label_class="synthetic")

    assert load_acceptance_case_corpus(tmp_path).label_class == "synthetic"
    with pytest.raises(AcceptanceCorpusError, match="synthetic labels"):
        load_acceptance_case_corpus(tmp_path, require_independent_labels=True)


def test_rejects_case_drift_and_unmanifested_cases(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="independent")
    (tmp_path / "dev-save" / "case.json").write_text("{}", encoding="utf-8")
    with pytest.raises(AcceptanceCorpusError, match="digest mismatch"):
        load_acceptance_case_corpus(tmp_path)

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    _write_corpus(fresh, label_class="independent")
    extra = fresh / "extra"
    extra.mkdir()
    (extra / "case.json").write_text(json.dumps(_case("extra", "dev")), encoding="utf-8")
    with pytest.raises(AcceptanceCorpusError, match="unmanifested"):
        load_acceptance_case_corpus(fresh)


def test_rejects_a_manifest_entry_without_its_frozen_case_file(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="independent")
    (tmp_path / "held-save" / "case.json").unlink()

    with pytest.raises(AcceptanceCorpusError, match="missing held-save/case.json"):
        load_acceptance_case_corpus(tmp_path)


@pytest.mark.parametrize(
    "case_name",
    [
        ".",
        "..",
        "../outside",
        "nested/case",
        r"nested\case",
        "/absolute",
        r"C:\absolute",
        "control\nname",
    ],
)
def test_rejects_non_portable_manifest_case_names(
    tmp_path: Path,
    case_name: str,
) -> None:
    _write_corpus(tmp_path, label_class="independent")
    manifest = _manifest(tmp_path)
    digest = next(iter(manifest["cases"].values()))
    manifest["cases"] = {case_name: digest}
    _write_manifest(tmp_path, manifest)

    with pytest.raises(AcceptanceCorpusError, match="portable directory basename"):
        load_acceptance_case_corpus(tmp_path)


def test_rejects_symlinked_corpus_root_case_directory_and_case_file(tmp_path: Path) -> None:
    real_root = tmp_path / "real-root"
    real_root.mkdir()
    _write_corpus(real_root, label_class="independent")
    linked_root = tmp_path / "linked-root"
    linked_root.symlink_to(real_root, target_is_directory=True)
    with pytest.raises(AcceptanceCorpusError, match="symlinked directories"):
        load_acceptance_case_corpus(linked_root)

    case_dir = real_root / "dev-save"
    real_case_dir = real_root / "dev-save-real"
    case_dir.rename(real_case_dir)
    case_dir.symlink_to(real_case_dir, target_is_directory=True)
    with pytest.raises(AcceptanceCorpusError, match="symlinked directories"):
        load_acceptance_case_corpus(real_root)

    case_dir.unlink()
    real_case_dir.rename(case_dir)
    case_file = case_dir / "case.json"
    real_case_file = case_dir / "case-real.json"
    case_file.rename(real_case_file)
    case_file.symlink_to(real_case_file)
    with pytest.raises(AcceptanceCorpusError, match="symlinked case.json"):
        load_acceptance_case_corpus(real_root)


def test_rejects_symlinked_manifest_and_non_regular_case_file(tmp_path: Path) -> None:
    manifest_root = tmp_path / "manifest-root"
    manifest_root.mkdir()
    _write_corpus(manifest_root, label_class="independent")
    manifest = manifest_root / "acceptance-corpus.json"
    real_manifest = manifest_root / "manifest-real.json"
    manifest.rename(real_manifest)
    manifest.symlink_to(real_manifest)
    with pytest.raises(AcceptanceCorpusError, match="symlinked acceptance-corpus.json"):
        load_acceptance_case_corpus(manifest_root)

    case_root = tmp_path / "case-root"
    case_root.mkdir()
    _write_corpus(case_root, label_class="independent")
    case_file = case_root / "dev-save" / "case.json"
    case_file.unlink()
    case_file.mkdir()
    with pytest.raises(AcceptanceCorpusError, match="regular file"):
        load_acceptance_case_corpus(case_root)
