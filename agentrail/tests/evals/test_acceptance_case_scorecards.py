import pytest
from agentrail.evals.acceptance_case.scorecards import AcceptanceObservation, aggregate

def observation(**overrides):
    base = dict(case="case-1", arm="full-jace-loop", scorecard="proof", segment="ui", evidence_class="offline", independent_truth=True, jace_claim=True, provenance={"caseVersion":"v1","scorerVersion":"s1"})
    base.update(overrides); return AcceptanceObservation(**base)

def test_preserves_unscored_and_false_green_denominators():
    report = aggregate([observation(), observation(independent_truth=False, jace_claim=True), observation(independent_truth=None, jace_claim=None)])
    assert report["offline:proof:ui"] == {"total":3,"scored":2,"unscored":1,"claim_true":2,"truth_true":1,"false_green":1,"false_block":0}

def test_rejects_factory_arm_or_missing_lineage():
    with pytest.raises(ValueError, match="arm"): observation(arm="full")
    with pytest.raises(ValueError, match="provenance"): observation(provenance={})
