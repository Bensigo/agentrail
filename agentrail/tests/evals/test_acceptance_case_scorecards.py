from __future__ import annotations

import pytest

from agentrail.evals.acceptance_case.scorecards import AcceptanceObservation, aggregate


def observation(**overrides):
    provenance = {
        "caseVersion": "case-v1",
        "corpusVersion": "corpus-v1",
        "repository": "acme/app",
        "repositoryCommit": "base",
        "contractVersion": "contract-v1",
        "model": "builder-v1",
        "configVersion": "config-v1",
        "promptVersion": "prompt-v1",
        "guardrailVersion": "guardrail-v1",
        "contextPackHash": "sha256:pack",
        "contextPackTokenBudget": "900",
        "prHead": "deadbeef",
        "diffIdentity": "sha256:diff",
        "environmentId": "preview-1",
        "artifactRefs": "artifact-1",
        "scorerVersion": "scorer-v1",
        "outcomeSource": "independent-label-v1",
    }
    base = dict(
        case="case-1",
        arm="full-jace-loop",
        scorecard="proof",
        segment="ui",
        evidence_class="offline",
        independent_truth=True,
        jace_claim=True,
        provenance=provenance,
    )
    base.update(overrides)
    if base["arm"] in {"agent-alone", "contract-only"} and "provenance" not in overrides:
        base["provenance"] = base["provenance"].copy()
        base["provenance"]["contextPackHash"] = "none"
        base["provenance"]["contextPackTokenBudget"] = "none"
    return AcceptanceObservation(**base)


def test_preserves_unscored_and_false_green_denominators():
    report = aggregate(
        [
            observation(),
            observation(independent_truth=False, jace_claim=True),
            observation(independent_truth=None, jace_claim=None),
        ]
    )
    assert report["full-jace-loop:offline:proof:ui"] == {
        "total": 3,
        "scored": 2,
        "unscored": 1,
        "claim_true": 2,
        "truth_true": 1,
        "false_green": 1,
        "false_block": 0,
    }


def test_never_blends_ablations_into_one_scorecard_bucket():
    report = aggregate([observation(arm="agent-alone"), observation(arm="full-jace-loop")])
    assert set(report) == {
        "agent-alone:offline:proof:ui",
        "full-jace-loop:offline:proof:ui",
    }


def test_rejects_factory_arm_or_missing_lineage():
    with pytest.raises(ValueError, match="arm"):
        observation(arm="full")
    with pytest.raises(ValueError, match="provenance"):
        observation(provenance={})


def test_requires_exact_complete_lineage_and_arm_appropriate_pack_identity():
    incomplete = observation().provenance.copy()
    incomplete.pop("prHead")
    with pytest.raises(ValueError, match="complete"):
        observation(provenance=incomplete)

    with pytest.raises(ValueError, match="non-pack"):
        observation(arm="agent-alone", provenance=observation().provenance)

    baseline_provenance = observation().provenance.copy()
    baseline_provenance["contextPackHash"] = "none"
    baseline_provenance["contextPackTokenBudget"] = "none"
    assert observation(arm="agent-alone", provenance=baseline_provenance).arm == "agent-alone"
