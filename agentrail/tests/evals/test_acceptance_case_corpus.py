"""Admission tests for frozen Acceptance Case corpus provenance."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.corpus import AcceptanceCorpusError, load_acceptance_case_corpus


def _case(name: str, split: str) -> dict[str, object]:
    return {
        "name": name,
        "split": split,
        "corpusVersion": "v1",
        "userRequest": "Show the saved state.",
        "sourceConversation": [{"id": "m1", "text": "Show save state"}],
        "pinned": {"repo": "example/frozen-app", "commit": "frozen-commit"},
        "relevantSources": ["src/save.tsx:1-20"],
        "approvedContract": {"version": "contract-v1", "acceptanceCriteria": [{"id": "saved", "text": "Saved state is visible"}]},
        "contextPack": {"contentHash": "sha256:pack", "tokenBudget": 900, "citedSourceRanges": ["src/save.tsx:1-20"]},
        "clarificationTruth": {"necessaryQuestions": []},
        "prRevisions": [{"headSha": "head-sha", "diffIdentity": "sha256:diff"}],
        "environments": [{"id": "preview-1", "modality": "ui"}],
        "independentLabels": {"contract": {}, "context": {}, "review": {}, "proof": {}, "correction": {}, "outcome": {}},
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
    (root / "acceptance-corpus.json").write_text(json.dumps({
        "formatVersion": 1,
        "corpusVersion": "v1",
        "labelClass": label_class,
        "labelAuthority": {"id": "human-review-board", "version": "2026-08"},
        "cases": digests,
    }, sort_keys=True), encoding="utf-8")


def test_loads_a_frozen_independent_dev_and_held_out_corpus(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="independent")

    corpus = load_acceptance_case_corpus(tmp_path, require_independent_labels=True)

    assert corpus.label_class == "independent"
    assert corpus.label_authority["id"] == "human-review-board"
    assert [(case.name, case.split) for case in corpus.cases] == [("dev-save", "dev"), ("held-save", "held-out")]


def test_synthetic_fixture_cannot_be_used_for_promotion_or_market_claims(tmp_path: Path) -> None:
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
