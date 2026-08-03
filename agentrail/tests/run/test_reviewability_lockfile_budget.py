from agentrail.run.reviewability import ReviewabilityBudget, evaluate_reviewability, make_diff_evidence
from agentrail.tests.run.test_reviewability_integration import _environment


def test_reviewability_budget_applies_to_non_lockfile_scope_and_reports_lockfile_churn() -> None:
    diff = make_diff_evidence(
        base_sha="base",
        head_sha="head",
        changed_files=("package.json", "pnpm-lock.yaml"),
        additions=1004,
        deletions=4,
        lockfile_additions=1000,
        lockfile_deletions=0,
    )

    decision = evaluate_reviewability(
        diff,
        _environment(),
        ReviewabilityBudget(max_changed_files=1, max_changed_lines=10, max_risk_score=1),
    )

    assert decision.status == "reviewable"
    payload = diff.to_dict()
    assert payload["lockfileChangedLines"] == 1000
    assert payload["nonLockfileChangedLines"] == 8
