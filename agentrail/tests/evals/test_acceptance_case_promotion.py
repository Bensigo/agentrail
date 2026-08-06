from agentrail.evals.acceptance_case.promotion import MetricFloor, PromotionPolicy, evaluate_promotion
from agentrail.evals.acceptance_case.scorecards import AcceptanceObservation


def observation(**overrides):
    base = dict(
        case="held-case", arm="full-jace-loop", scorecard="proof", segment="ui",
        evidence_class="offline", independent_truth=True, jace_claim=True,
        provenance={"caseVersion": "v1", "scorerVersion": "s1"},
    )
    base.update(overrides)
    return AcceptanceObservation(**base)


def policy(*, min_scored=1, max_false_green_rate=0.0):
    return PromotionPolicy(
        floors={("proof", "ui"): MetricFloor(
            min_scored=min_scored, min_correct_rate=1.0,
            max_false_green_rate=max_false_green_rate, max_false_block_rate=0.0,
        )},
    )


def complete_arms(**overrides):
    return [observation(arm=arm, **overrides) for arm in ("agent-alone", "contract-only", "contract-plus-pack", "full-jace-loop")]


def test_promotes_only_complete_held_out_independent_evidence():
    result = evaluate_promotion(
        complete_arms() + [observation(evidence_class="production", jace_claim=False)],
        case_splits={"held-case": "held-out"}, policy=policy(),
    )
    assert result.status == "promote"
    assert result.metrics["full-jace-loop:proof:ui"]["scored"] == 1


def test_holds_for_missing_sample_or_unknown_case_split():
    result = evaluate_promotion([], case_splits={}, policy=policy())
    assert result.status == "hold"
    assert "0/1" in result.reasons[0]
    result = evaluate_promotion(complete_arms(), case_splits={}, policy=policy())
    assert result.status == "hold"
    assert "unknown case split" in result.reasons[0]


def test_rejects_measured_safety_or_quality_failure_not_just_missing_data():
    result = evaluate_promotion(
        complete_arms(independent_truth=False, jace_claim=True),
        case_splits={"held-case": "held-out"}, policy=policy(),
    )
    assert result.status == "reject"
    assert any("false-green" in reason for reason in result.reasons)


def test_validates_explicit_floors_and_canonical_arms():
    try:
        PromotionPolicy(floors={})
    except ValueError as error:
        assert "explicit" in str(error)
    else:
        raise AssertionError("missing floors must fail")
    try:
        MetricFloor(min_scored=0, min_correct_rate=0, max_false_green_rate=0, max_false_block_rate=0)
    except ValueError as error:
        assert "min_scored" in str(error)
    else:
        raise AssertionError("invalid floor must fail")
    try:
        PromotionPolicy(floors={("proof", "ui"): MetricFloor(1, 1, 0, 0)}, required_arms=("full-jace-loop",))
    except ValueError as error:
        assert "all four" in str(error)
    else:
        raise AssertionError("partial ablation cannot promote")
