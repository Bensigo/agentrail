from __future__ import annotations

from agentrail.dependencies.evidence import (
    CandidateIdentity,
    DependencyEvidence,
    DependencyEvidenceDecision,
    DependencyChange,
    DependencyDecisionStatus,
    EvidenceResolution,
    EvidenceSource,
    LockResolution,
    ReleaseEvidence,
    SecurityEvidence,
    UsageEvidence,
    UsageFinding,
    EvidenceState,
)
from agentrail.guardrails import VerdictStatus, get_guardrail


def _payload(status: DependencyDecisionStatus) -> dict:
    now = "2026-08-03T10:00:00Z"
    source = EvidenceSource("release", "https://example.test/release", now, "release")
    finding = UsageFinding(EvidenceState.NOT_FOUND)
    evidence = DependencyEvidence(
        candidate=CandidateIdentity("sha256:candidate", "pkg", "1.0.0", "1.1.0", "a" * 40),
        collected_at=now,
        release=ReleaseEvidence(EvidenceResolution.RESOLVED, "1.1.0", (source,), now, canonical=True),
        usage=UsageEvidence(finding, finding, finding, finding, now),
        lock=LockResolution(EvidenceResolution.RESOLVED, direct_changes=(DependencyChange("pkg", ("1.0.0",), ("1.1.0",), "direct"),), observed_at=now),
        security=SecurityEvidence(EvidenceResolution.RESOLVED, sources=(source,), observed_at=now),
        decision=DependencyEvidenceDecision(status),
    )
    return evidence.to_dict()


def test_dependency_upgrade_guardrail_is_registered_and_blocking():
    guardrail = get_guardrail("dependency_upgrade_evidence")
    assert guardrail.blocking is True
    assert guardrail.evaluate(dependency_evidence=_payload(DependencyDecisionStatus.READY)).status is VerdictStatus.PASS
    assert guardrail.evaluate(dependency_evidence=_payload(DependencyDecisionStatus.BLOCKED)).status is VerdictStatus.FAIL
    assert guardrail.evaluate().status is VerdictStatus.FAIL
