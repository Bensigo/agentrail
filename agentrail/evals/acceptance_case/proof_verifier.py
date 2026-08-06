"""Independent, exact-head proof validation for Acceptance Case evaluation.

This is deliberately an evaluator protocol, not Jace's runtime verifier.  It
scores only frozen fixture labels and submitted artifact metadata; it never
uses Jace's verdict as truth, executes a preview, or exposes hidden labels to a
builder.  Missing or ambiguous labels are explicitly unscored.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Tuple

from .loader import AcceptanceCase
from .runner import AcceptanceLineage

ProofModality = Literal["ui", "api", "job", "data"]
ProofVerdict = Literal["proven", "not_proven", "not_testable"]
VerificationStatus = Literal["valid", "invalid", "unscored"]
_MODALITIES = {"ui", "api", "job", "data"}
_VERDICTS = {"proven", "not_proven", "not_testable"}


@dataclass(frozen=True)
class ProofArtifact:
    """Inspectable, redacted artifact metadata only; never the raw payload."""

    ref: str
    content_type: str
    kind: str = "artifact"
    redacted: bool = False


@dataclass(frozen=True)
class CriterionProofClaim:
    """One evaluator-visible claim from a frozen builder attempt."""

    criterion_id: str
    modality: ProofModality
    verdict: ProofVerdict
    pr_head: str
    environment_id: str
    observed_behavior: str = ""
    artifacts: Tuple[ProofArtifact, ...] = ()
    response_status: Optional[int] = None
    triggered: bool = False
    authorized_readback: bool = False


@dataclass(frozen=True)
class ProofVerification:
    status: VerificationStatus
    expected_verdict: Optional[ProofVerdict]
    reason: str
    artifact_refs: Tuple[str, ...]

    @property
    def valid(self) -> bool:
        return self.status == "valid"


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _proof_label(case: AcceptanceCase, criterion_id: str) -> tuple[Optional[dict], Optional[str]]:
    raw = case.labels.get("proof")
    if not isinstance(raw, dict):
        return None, "proof labels are absent or malformed"
    criteria = raw.get("criteria")
    if not isinstance(criteria, list):
        return None, "proof labels do not declare criteria"
    matches = [row for row in criteria if isinstance(row, dict) and _text(row.get("criterionId")) == criterion_id]
    if len(matches) != 1:
        return None, "proof label is missing or ambiguous for criterion"
    return matches[0], None


def _case_has_criterion(case: AcceptanceCase, criterion_id: str) -> bool:
    criteria = case.contract.get("acceptanceCriteria")
    return isinstance(criteria, list) and any(
        isinstance(item, dict) and _text(item.get("id")) == criterion_id for item in criteria
    )


def _invalid(expected: Optional[ProofVerdict], reason: str, claim: CriterionProofClaim) -> ProofVerification:
    return ProofVerification("invalid", expected, reason, tuple(artifact.ref for artifact in claim.artifacts))


def verify_criterion_proof(
    case: AcceptanceCase,
    lineage: AcceptanceLineage,
    claim: CriterionProofClaim,
) -> ProofVerification:
    """Validate one proof claim against frozen labels and exact lineage.

    Fixture truth is ``independentLabels.proof.criteria``.  Each row requires
    ``criterionId``, ``modality``, and ``expectedVerdict``; API rows that expect
    a pass also require ``expectedStatus``.  Unlabelled criteria are unscored,
    never silently treated as proof.
    """
    criterion_id = _text(claim.criterion_id)
    if not criterion_id or not _case_has_criterion(case, criterion_id):
        return _invalid(None, "criterion is not in the approved frozen contract", claim)
    if claim.modality not in _MODALITIES or claim.verdict not in _VERDICTS:
        return _invalid(None, "claim has an unsupported proof modality or verdict", claim)
    if _text(claim.pr_head) != lineage.pr_head or _text(claim.environment_id) != lineage.environment_id:
        return _invalid(None, "proof claim is not bound to the exact evaluated PR head and environment", claim)
    environment = next((row for row in case.environments if row.get("id") == lineage.environment_id), None)
    if not environment or environment.get("modality") != claim.modality:
        return _invalid(None, "proof modality is not permitted by the frozen environment", claim)
    label, label_error = _proof_label(case, criterion_id)
    if label is None:
        return ProofVerification("unscored", None, label_error or "proof label is unavailable", tuple(a.ref for a in claim.artifacts))
    expected = label.get("expectedVerdict")
    if expected not in _VERDICTS or label.get("modality") != claim.modality:
        return ProofVerification("unscored", None, "proof label has no valid modality/verdict contract", tuple(a.ref for a in claim.artifacts))
    expected = expected  # narrow for the return contract below
    if claim.verdict != expected:
        return _invalid(expected, f"independent label expects {expected}, observed claim is {claim.verdict}", claim)
    if claim.verdict != "proven":
        if claim.verdict == "not_testable" and claim.artifacts:
            return _invalid(expected, "not_testable proof may not carry fabricated artifacts", claim)
        return ProofVerification("valid", expected, "claim matches independent non-pass label", tuple(a.ref for a in claim.artifacts))
    if not _text(claim.observed_behavior) or not claim.artifacts:
        return _invalid(expected, "proven proof requires observed behavior and inspectable artifacts", claim)
    if any(not _text(a.ref) or not _text(a.content_type) for a in claim.artifacts):
        return _invalid(expected, "proof artifacts require stable references and content types", claim)
    if claim.modality == "ui":
        if not any(a.content_type in {"image/png", "image/jpeg"} for a in claim.artifacts):
            return _invalid(expected, "UI proof requires a PNG or JPEG criterion artifact", claim)
    elif claim.modality == "api":
        expected_status = label.get("expectedStatus")
        if not isinstance(expected_status, int) or isinstance(expected_status, bool) or claim.response_status != expected_status:
            return _invalid(expected, "API proof does not match the independently labelled expected status", claim)
        if not any(a.content_type == "application/json" and a.redacted for a in claim.artifacts):
            return _invalid(expected, "API proof requires a redacted JSON request/status card", claim)
    elif claim.modality == "job":
        if not claim.triggered or not any(a.kind in {"log", "output"} for a in claim.artifacts):
            return _invalid(expected, "job proof requires a trigger and bounded log/output artifact", claim)
    elif claim.modality == "data":
        if not claim.authorized_readback or not any(a.kind == "assertion" for a in claim.artifacts):
            return _invalid(expected, "data proof requires authorized readback and an assertion artifact", claim)
    return ProofVerification("valid", expected, "claim matches frozen criterion-specific proof requirements", tuple(a.ref for a in claim.artifacts))
