from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.loader import (
    AcceptanceCaseError,
    load_case,
    load_cases,
)


def payload(split: str = "dev") -> dict:
    return {
        "name": "save-visible",
        "split": split,
        "corpusVersion": "v1",
        "userRequest": "make save visible",
        "sourceConversation": [{"id": "m1", "text": "save"}],
        "pinned": {"repo": "acme/app", "commit": "abc"},
        "relevantSources": ["src/save.ts:1-2"],
        "approvedContract": {
            "version": "contract-v1",
            "acceptanceCriteria": [{"id": "saved"}],
        },
        "contextPack": {
            "contentHash": "sha256:pack",
            "tokenBudget": 900,
            "citedSourceRanges": ["src/save.ts:1-2"],
        },
        "clarificationTruth": {"necessaryQuestions": []},
        "prRevisions": [{"headSha": "deadbeef", "diffIdentity": "sha256:diff"}],
        "environments": [{"id": "preview-1", "modality": "ui"}],
        "independentLabels": {
            "contract": {},
            "context": {},
            "review": {},
            "proof": {},
            "correction": {},
            "outcome": {},
        },
        "source": {"issue": 1},
    }


def write(root: Path, name: str, data: dict) -> Path:
    path = root / name
    path.mkdir()
    (path / "case.json").write_text(json.dumps(data), encoding="utf-8")
    return path


def test_loads_frozen_dev_case_and_excludes_held_out(tmp_path: Path) -> None:
    dev = write(tmp_path, "dev", payload())
    write(tmp_path, "held", payload("held-out"))

    assert load_case(dev).repo == "acme/app"
    assert [c.name for c in load_cases(tmp_path)] == ["save-visible"]
    assert len(load_cases(tmp_path, include_held_out=True)) == 2


def test_rejects_missing_independent_scorecard_or_non_exact_pr(tmp_path: Path) -> None:
    bad = payload()
    bad["independentLabels"].pop("outcome")
    path = write(tmp_path, "bad", bad)
    with pytest.raises(AcceptanceCaseError, match="scorecard"):
        load_case(path)

    bad = payload()
    bad["prRevisions"] = [{"headSha": "", "diffIdentity": ""}]
    path = write(tmp_path, "bad-pr", bad)
    with pytest.raises(AcceptanceCaseError, match="headSha"):
        load_case(path)


@pytest.mark.parametrize(
    "field, rows, message",
    [
        (
            "prRevisions",
            [
                {"headSha": "same-head", "diffIdentity": "sha256:first"},
                {"headSha": "same-head", "diffIdentity": "sha256:second"},
            ],
            "duplicate prRevisions.headSha",
        ),
        (
            "prRevisions",
            [
                {"headSha": "first-head", "diffIdentity": "sha256:same"},
                {"headSha": "second-head", "diffIdentity": "sha256:same"},
            ],
            "duplicate prRevisions.diffIdentity",
        ),
        (
            "environments",
            [
                {"id": "same-environment", "modality": "ui"},
                {"id": "same-environment", "modality": "api"},
            ],
            "duplicate environments.id",
        ),
    ],
)
def test_rejects_ambiguous_exact_bindings(
    tmp_path: Path,
    field: str,
    rows: list[dict[str, str]],
    message: str,
) -> None:
    bad = payload()
    bad[field] = rows

    with pytest.raises(AcceptanceCaseError, match=message):
        load_case(write(tmp_path, "ambiguous", bad))


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("headSha", "x" * 257, "headSha exceeds"),
        ("diffIdentity", "x" * 257, "diffIdentity exceeds"),
        ("environmentId", "x" * 257, "environments.id exceeds"),
    ],
)
def test_rejects_unbounded_exact_bindings(
    tmp_path: Path,
    field: str,
    value: str,
    message: str,
) -> None:
    bad = payload()
    if field == "environmentId":
        bad["environments"][0]["id"] = value
    else:
        bad["prRevisions"][0][field] = value

    with pytest.raises(AcceptanceCaseError, match=message):
        load_case(write(tmp_path, "unbounded", bad))


def test_direct_loaders_reject_symlinked_or_non_regular_case_paths(tmp_path: Path) -> None:
    real_case = write(tmp_path, "real-case", payload())
    linked_case = tmp_path / "linked-case"
    linked_case.symlink_to(real_case, target_is_directory=True)
    with pytest.raises(AcceptanceCaseError, match="symlinked"):
        load_case(linked_case)
    with pytest.raises(AcceptanceCaseError, match="symlinked entry"):
        load_cases(tmp_path)

    linked_case.unlink()
    case_file = real_case / "case.json"
    real_file = real_case / "real-case.json"
    case_file.rename(real_file)
    case_file.symlink_to(real_file)
    with pytest.raises(AcceptanceCaseError, match="symlinked case.json"):
        load_case(real_case)
    with pytest.raises(AcceptanceCaseError, match="symlinked case.json"):
        load_cases(tmp_path)

    case_file.unlink()
    case_file.mkdir()
    with pytest.raises(AcceptanceCaseError, match="regular file"):
        load_case(real_case)
    with pytest.raises(AcceptanceCaseError, match="regular file"):
        load_cases(tmp_path)


def test_load_cases_rejects_a_symlinked_root(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    write(corpus, "case", payload())
    linked_root = tmp_path / "linked-root"
    linked_root.symlink_to(corpus, target_is_directory=True)

    with pytest.raises(AcceptanceCaseError, match="symlinked directories"):
        load_cases(linked_root)


def test_requires_contract_version_and_bounded_cited_pack(tmp_path: Path) -> None:
    bad = payload()
    bad["approvedContract"].pop("version")
    path = write(tmp_path, "bad-contract", bad)
    with pytest.raises(AcceptanceCaseError, match="approvedContract.version"):
        load_case(path)

    bad = payload()
    bad["contextPack"]["tokenBudget"] = 0
    path = write(tmp_path, "bad-budget", bad)
    with pytest.raises(AcceptanceCaseError, match="tokenBudget"):
        load_case(path)

    bad = payload()
    bad["contextPack"]["citedSourceRanges"] = []
    path = write(tmp_path, "bad-citations", bad)
    with pytest.raises(AcceptanceCaseError, match="citedSourceRanges"):
        load_case(path)

    bad = payload()
    bad["contextPack"]["content"] = "raw repository text"
    path = write(tmp_path, "bad-custody", bad)
    with pytest.raises(AcceptanceCaseError, match="custody"):
        load_case(path)
