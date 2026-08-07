import json
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.loader import AcceptanceCaseError, load_case, load_cases


def payload(split: str = "dev") -> dict:
    return {"name":"save-visible","split":split,"corpusVersion":"v1","userRequest":"make save visible","sourceConversation":[{"id":"m1","text":"save"}],"pinned":{"repo":"acme/app","commit":"abc"},"relevantSources":["src/save.ts:1-2"],"approvedContract":{"version":"contract-v1","acceptanceCriteria":[{"id":"saved"}]},"contextPack":{"contentHash":"sha256:pack","tokenBudget":900,"citedSourceRanges":["src/save.ts:1-2"]},"clarificationTruth":{"necessaryQuestions":[]},"prRevisions":[{"headSha":"deadbeef","diffIdentity":"sha256:diff"}],"environments":[{"id":"preview-1","modality":"ui"}],"independentLabels":{"contract":{},"context":{},"review":{},"proof":{},"correction":{},"outcome":{}},"source":{"issue":1}}

def write(root: Path, name: str, data: dict) -> Path:
    path = root / name; path.mkdir(); (path / "case.json").write_text(json.dumps(data)); return path

def test_loads_frozen_dev_case_and_excludes_held_out(tmp_path: Path) -> None:
    dev = write(tmp_path, "dev", payload()); write(tmp_path, "held", payload("held-out"))
    assert load_case(dev).repo == "acme/app"
    assert [c.name for c in load_cases(tmp_path)] == ["save-visible"]
    assert len(load_cases(tmp_path, include_held_out=True)) == 2

def test_rejects_missing_independent_scorecard_or_non_exact_pr(tmp_path: Path) -> None:
    bad = payload(); bad["independentLabels"].pop("outcome"); path = write(tmp_path, "bad", bad)
    with pytest.raises(AcceptanceCaseError, match="scorecard"): load_case(path)
    bad = payload(); bad["prRevisions"] = [{"headSha":"", "diffIdentity":""}]; path = write(tmp_path, "bad-pr", bad)
    with pytest.raises(AcceptanceCaseError, match="headSha"): load_case(path)


def test_requires_contract_version_and_bounded_cited_pack(tmp_path: Path) -> None:
    bad = payload(); bad["approvedContract"].pop("version"); path = write(tmp_path, "bad-contract", bad)
    with pytest.raises(AcceptanceCaseError, match="approvedContract.version"): load_case(path)
    bad = payload(); bad["contextPack"]["tokenBudget"] = 0; path = write(tmp_path, "bad-budget", bad)
    with pytest.raises(AcceptanceCaseError, match="tokenBudget"): load_case(path)
    bad = payload(); bad["contextPack"]["citedSourceRanges"] = []; path = write(tmp_path, "bad-citations", bad)
    with pytest.raises(AcceptanceCaseError, match="citedSourceRanges"): load_case(path)
    bad = payload(); bad["contextPack"]["content"] = "raw repository text"; path = write(tmp_path, "bad-custody", bad)
    with pytest.raises(AcceptanceCaseError, match="custody"): load_case(path)
