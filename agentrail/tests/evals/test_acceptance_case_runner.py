import json
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.loader import load_case
from agentrail.evals.acceptance_case.runner import acceptance_lineage, builder_input


def _case(tmp_path: Path):
    payload = {
        "name": "save-visible", "split": "dev", "corpusVersion": "v1",
        "userRequest": "make save visible", "sourceConversation": [{"id": "m1", "text": "private history"}],
        "pinned": {"repo": "acme/app", "commit": "abc"}, "relevantSources": ["src/private.ts:1-2"],
        "approvedContract": {"version": "contract-v1", "acceptanceCriteria": [{"id": "saved"}]},
        "contextPack": {"contentHash": "sha256:pack", "tokenBudget": 900, "citedSourceRanges": ["src/save.ts:1-2"]},
        "clarificationTruth": {"necessaryQuestions": ["which button?"]},
        "prRevisions": [{"headSha": "deadbeef", "diffIdentity": "sha256:diff"}],
        "environments": [{"id": "preview-1", "modality": "ui"}],
        "independentLabels": {"contract": {"hidden": True}, "context": {}, "review": {}, "proof": {}, "correction": {}, "outcome": {}},
        "source": {"issue": 1},
    }
    path = tmp_path / "case"; path.mkdir(); (path / "case.json").write_text(json.dumps(payload))
    return load_case(path)


def test_builder_inputs_expose_only_the_material_for_each_canonical_arm(tmp_path: Path) -> None:
    case = _case(tmp_path)
    alone = builder_input(case, "agent-alone")
    assert alone.user_request == "make save visible"
    assert alone.contract is None and alone.context_pack is None
    contract = builder_input(case, "contract-only")
    assert contract.contract["version"] == "contract-v1"
    assert contract.context_pack is None
    for arm in ("contract-plus-pack", "full-jace-loop"):
        pack_input = builder_input(case, arm)
        assert pack_input.contract["acceptanceCriteria"][0]["id"] == "saved"
        assert pack_input.context_pack.content_hash == "sha256:pack"
        assert pack_input.context_pack.cited_source_ranges == ("src/save.ts:1-2",)
    # The input type has no fields for conversation, labels, source oracle, or
    # repository metadata; those must remain evaluator-only material.
    assert set(alone.__dataclass_fields__) == {"arm", "user_request", "contract", "context_pack"}


def test_builder_contract_is_a_frozen_copy_and_unknown_arm_is_refused(tmp_path: Path) -> None:
    case = _case(tmp_path)
    contract = builder_input(case, "contract-only").contract
    with pytest.raises(TypeError):
        contract["version"] = "tamper"
    with pytest.raises(ValueError, match="unknown"):
        builder_input(case, "full")


def test_lineage_binds_exact_case_contract_pack_head_and_environment(tmp_path: Path) -> None:
    case = _case(tmp_path)
    lineage = acceptance_lineage(case, "full-jace-loop", pr_head="deadbeef", environment_id="preview-1")
    assert lineage.case_name == "save-visible"
    assert lineage.contract_version == "contract-v1"
    assert lineage.context_pack_hash == "sha256:pack"
    assert lineage.context_pack_token_budget == 900
    assert lineage.diff_identity == "sha256:diff"
    case.contract["version"] = "tampered-after-load"
    assert acceptance_lineage(case, "full-jace-loop", pr_head="deadbeef", environment_id="preview-1").contract_version == "contract-v1"
    bare = acceptance_lineage(case, "agent-alone", pr_head="deadbeef", environment_id="preview-1")
    assert bare.context_pack_hash is None and bare.context_pack_token_budget is None


@pytest.mark.parametrize("kwargs, message", [
    ({"pr_head": "unknown", "environment_id": "preview-1"}, "PR head"),
    ({"pr_head": "deadbeef", "environment_id": "unknown"}, "environment"),
    ({"pr_head": "", "environment_id": "preview-1"}, "exact PR head"),
])
def test_lineage_refuses_non_frozen_or_ambiguous_bindings(tmp_path: Path, kwargs: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        acceptance_lineage(_case(tmp_path), "full-jace-loop", **kwargs)
