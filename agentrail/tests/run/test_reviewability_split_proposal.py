from __future__ import annotations

from agentrail.run.reviewability import ReviewabilityBudget, evaluate_reviewability, make_diff_evidence
from agentrail.tests.run.test_reviewability_integration import _environment


def test_over_budget_changes_return_actionable_split_guidance_with_reasons() -> None:
    diff = make_diff_evidence(
        base_sha="base-123",
        head_sha="head-456",
        changed_files=("src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"),
        additions=80,
        deletions=30,
    )
    decision = evaluate_reviewability(
        diff,
        _environment(),
        ReviewabilityBudget(max_changed_files=3, max_changed_lines=100, max_risk_score=3),
    )

    assert decision.status == "split_recommended"
    assert decision.split_recommended is True
    assert decision.proof_complete is False
    assert decision.recommendation.startswith("Split the change into smaller independently verifiable pull requests")
    assert "non-lockfile changed files 4 exceed budget 3" in decision.recommendation
    assert "non-lockfile changed lines 110 exceed budget 100" in decision.recommendation
    assert "advisory only" in decision.recommendation
    assert "child issues" in decision.recommendation
    assert "queue entries" in decision.recommendation


def test_in_budget_changes_keep_the_existing_output_behavior() -> None:
    decision = evaluate_reviewability(make_diff_evidence(base_sha="base-123", head_sha="head-456"), _environment())

    assert decision.status == "reviewable"
    assert decision.split_recommended is False
    assert decision.proof_complete is True
    assert decision.recommendation == "Evidence is complete within the configured reviewability budget."
