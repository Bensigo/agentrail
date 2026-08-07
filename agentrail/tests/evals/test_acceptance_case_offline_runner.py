import json
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.loader import ARMS, load_case
from agentrail.evals.acceptance_case.offline_runner import (
    BuilderAttempt,
    RunProvenance,
    ScoredAttempt,
    run_offline_four_arm_evaluation,
)
from agentrail.evals.acceptance_case.promotion import MetricFloor, PromotionPolicy


def _case(tmp_path: Path):
    payload = {
        "name": "save-visible", "split": "held-out", "corpusVersion": "corpus-v1",
        "userRequest": "make save visible", "sourceConversation": [{"id": "m1", "text": "hidden chat"}],
        "pinned": {"repo": "acme/app", "commit": "base"}, "relevantSources": ["src/private.ts:1-2"],
        "approvedContract": {"version": "contract-v1", "acceptanceCriteria": [{"id": "saved"}]},
        "contextPack": {"contentHash": "sha256:pack", "tokenBudget": 900, "citedSourceRanges": ["src/save.ts:1-2"]},
        "clarificationTruth": {"necessaryQuestions": []},
        "prRevisions": [{"headSha": "deadbeef", "diffIdentity": "sha256:diff"}],
        "environments": [{"id": "preview-1", "modality": "ui"}],
        "independentLabels": {"contract": {}, "context": {}, "review": {}, "proof": {}, "correction": {}, "outcome": {}},
        "source": {"issue": 1},
    }
    path = tmp_path / "case"; path.mkdir(); (path / "case.json").write_text(json.dumps(payload))
    return load_case(path)


class _Executor:
    def __init__(self):
        self.inputs = []

    def execute(self, builder, workspace):
        self.inputs.append((builder, workspace))
        return BuilderAttempt("deadbeef", "preview-1", {"arm": builder.arm})


class _Scorer:
    def score(self, case, lineage, attempt):
        assert attempt == {"arm": lineage.arm}
        return [ScoredAttempt("proof", "ui", True, True, "artifact-1")]


def _provenance():
    return RunProvenance(
        model="builder-v1", config_version="config-v1", prompt_version="prompt-v1",
        guardrail_version="guardrail-v1", scorer_version="scorer-v1", outcome_source="hidden-label-v1",
    )


def _policy():
    return PromotionPolicy({("proof", "ui"): MetricFloor(1, 1, 0, 0)})


def test_runs_all_four_arms_without_leaking_evaluator_only_case_data(tmp_path: Path) -> None:
    case = _case(tmp_path); executor = _Executor()
    report = run_offline_four_arm_evaluation(
        [case], executor=executor, scorer=_Scorer(),
        provenance=_provenance(), promotion_policy=_policy(),
    )
    assert [builder.arm for builder, _ in executor.inputs] == list(ARMS)
    assert set(executor.inputs[0][0].__dataclass_fields__) == {"arm", "user_request", "contract", "context_pack"}
    assert executor.inputs[0][0].contract is None and executor.inputs[0][0].context_pack is None
    assert executor.inputs[1][0].contract["version"] == "contract-v1" and executor.inputs[1][0].context_pack is None
    assert executor.inputs[2][0].context_pack.content_hash == "sha256:pack"
    assert "full-jace-loop:offline:proof:ui" in report.scorecards
    assert report.promotion.status == "promote"
    assert all(item.provenance["prHead"] == "deadbeef" for item in report.observations)
    assert all(item.provenance["environmentId"] == "preview-1" for item in report.observations)
    assert report.observations[0].provenance["contextPackHash"] == "none"
    assert report.observations[-1].provenance["contextPackHash"] == "sha256:pack"


def test_refuses_an_attempt_outside_the_frozen_case(tmp_path: Path) -> None:
    case = _case(tmp_path)
    class _BadExecutor:
        def execute(self, builder, workspace):
            return BuilderAttempt("not-frozen", "preview-1", {"arm": builder.arm})
    with pytest.raises(ValueError, match="not a frozen"):
        run_offline_four_arm_evaluation([case], executor=_BadExecutor(), scorer=_Scorer(), provenance=_provenance())
