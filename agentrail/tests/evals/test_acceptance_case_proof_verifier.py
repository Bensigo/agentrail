from __future__ import annotations

import json
from pathlib import Path

from agentrail.evals.acceptance_case.loader import load_case
from agentrail.evals.acceptance_case.offline_runner import (
    BuilderAttempt,
    RunProvenance,
    run_offline_four_arm_evaluation,
)
from agentrail.evals.acceptance_case.proof_verifier import (
    CriterionProofClaim,
    ProofArtifact,
    verify_criterion_proof,
)
from agentrail.evals.acceptance_case.runner import acceptance_lineage


def _case(tmp_path: Path, *, modality: str = "ui", verdict: str = "proven"):
    payload = {
        "name": "criterion-proof",
        "split": "held-out",
        "corpusVersion": "corpus-v1",
        "userRequest": "prove one criterion",
        "sourceConversation": [{"id": "m1", "text": "request"}],
        "pinned": {"repo": "acme/app", "commit": "base"},
        "relevantSources": ["src/save.ts:1-2"],
        "approvedContract": {
            "version": "contract-v1",
            "acceptanceCriteria": [{"id": "criterion"}],
        },
        "contextPack": {
            "contentHash": "sha256:pack",
            "tokenBudget": 900,
            "citedSourceRanges": ["src/save.ts:1-2"],
        },
        "clarificationTruth": {"necessaryQuestions": []},
        "prRevisions": [{"headSha": "deadbeef", "diffIdentity": "sha256:diff"}],
        "environments": [{"id": "preview-1", "modality": modality}],
        "independentLabels": {
            "contract": {},
            "context": {},
            "review": {},
            "correction": {},
            "outcome": {},
            "proof": {
                "criteria": [
                    {
                        "criterionId": "criterion",
                        "modality": modality,
                        "expectedVerdict": verdict,
                        "expectedStatus": 200,
                    }
                ]
            },
        },
        "source": {"issue": 1},
    }
    path = tmp_path / "case"
    path.mkdir()
    (path / "case.json").write_text(json.dumps(payload), encoding="utf-8")
    case = load_case(path)
    return case, acceptance_lineage(case, "full-jace-loop", pr_head="deadbeef", environment_id="preview-1")


def test_accepts_exact_head_ui_proof_with_inspectable_screenshot(tmp_path: Path) -> None:
    case, lineage = _case(tmp_path)
    result = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "ui",
            "proven",
            "deadbeef",
            "preview-1",
            "Save confirmation is visible",
            (ProofArtifact("artifact://save", "image/png"),),
        ),
    )
    assert result.valid and result.expected_verdict == "proven"


def test_rejects_stale_or_generic_ui_proof(tmp_path: Path) -> None:
    case, lineage = _case(tmp_path)
    stale = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "ui",
            "proven",
            "other",
            "preview-1",
            "Save confirmation is visible",
            (ProofArtifact("artifact://save", "image/png"),),
        ),
    )
    smoke = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "ui",
            "proven",
            "deadbeef",
            "preview-1",
            "",
            (ProofArtifact("artifact://page-load", "image/png"),),
        ),
    )
    assert stale.status == "invalid" and "exact evaluated PR head" in stale.reason
    assert smoke.status == "invalid" and "observed behavior" in smoke.reason


def test_requires_redacted_exact_status_api_evidence(tmp_path: Path) -> None:
    case, lineage = _case(tmp_path, modality="api")
    invalid = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "api",
            "proven",
            "deadbeef",
            "preview-1",
            "API returned 200",
            (ProofArtifact("artifact://api", "application/json", redacted=False),),
            response_status=200,
        ),
    )
    valid = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "api",
            "proven",
            "deadbeef",
            "preview-1",
            "API returned 200",
            (ProofArtifact("artifact://api", "application/json", redacted=True),),
            response_status=200,
        ),
    )
    assert invalid.status == "invalid" and "redacted JSON" in invalid.reason
    assert valid.valid


def test_credits_independently_labelled_not_testable_without_artifacts(
    tmp_path: Path,
) -> None:
    case, lineage = _case(tmp_path, verdict="not_testable")
    result = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "ui",
            "not_testable",
            "deadbeef",
            "preview-1",
        ),
    )
    assert result.valid and result.expected_verdict == "not_testable"


def test_missing_or_ambiguous_hidden_truth_stays_unscored(tmp_path: Path) -> None:
    case, lineage = _case(tmp_path)
    case.labels["proof"] = {"criteria": []}
    result = verify_criterion_proof(
        case,
        lineage,
        CriterionProofClaim(
            "criterion",
            "ui",
            "proven",
            "deadbeef",
            "preview-1",
            "Visible",
            (ProofArtifact("a", "image/png"),),
        ),
    )
    assert result.status == "unscored"


def test_independent_scorer_separates_feature_outcome_from_artifact_validity(
    tmp_path: Path,
) -> None:
    from agentrail.evals.acceptance_case.proof_verifier import ProofIndependentScorer

    case, _ = _case(tmp_path)

    class Executor:
        def execute(self, builder, workspace):
            return BuilderAttempt(
                "deadbeef",
                "preview-1",
                [
                    CriterionProofClaim(
                        "criterion",
                        "ui",
                        "proven",
                        "deadbeef",
                        "preview-1",
                        "Visible",
                        (ProofArtifact("artifact://generic", "text/plain"),),
                    )
                ],
            )

    report = run_offline_four_arm_evaluation(
        [case],
        executor=Executor(),
        scorer=ProofIndependentScorer(),
        provenance=RunProvenance("model", "config", "prompt", "guardrail", "scorer", "hidden"),
    )
    outcome = report.scorecards["full-jace-loop:offline:proof:ui"]
    validity = report.scorecards["full-jace-loop:offline:proof:ui-artifact-validity"]
    assert outcome["truth_true"] == 1 and outcome["false_green"] == 0
    assert validity["truth_true"] == 0 and validity["false_green"] == 1


def test_independent_scorer_keeps_missing_hidden_proof_truth_unscored(
    tmp_path: Path,
) -> None:
    from agentrail.evals.acceptance_case.proof_verifier import ProofIndependentScorer

    case, lineage = _case(tmp_path)
    case.labels["proof"] = {"criteria": []}
    scores = list(
        ProofIndependentScorer().score(
            case,
            lineage,
            [
                CriterionProofClaim(
                    "criterion",
                    "ui",
                    "proven",
                    "deadbeef",
                    "preview-1",
                    "Visible",
                    (ProofArtifact("a", "image/png"),),
                )
            ],
        )
    )
    assert [score.independent_truth for score in scores] == [None, None]
