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
from agentrail.dependencies.manager import PNPM_ADAPTER_PROFILE
from agentrail.dependencies.pnpm import adapter_identity_fingerprint


def _payload(status: DependencyDecisionStatus) -> dict:
    now = "2026-08-03T10:00:00Z"
    source = EvidenceSource("release", "https://example.test/release", now, "release")
    finding = UsageFinding(EvidenceState.NOT_FOUND)
    fingerprint = "sha256:candidate"
    evidence = DependencyEvidence(
        candidate=CandidateIdentity(
            fingerprint, "pkg", "1.0.0", "1.1.0", "a" * 40,
            ecosystem="node",
            package_manager="pnpm",
            adapter_profile=PNPM_ADAPTER_PROFILE,
            adapter_identity_fingerprint=adapter_identity_fingerprint(
                candidate_fingerprint=fingerprint,
                ecosystem="node",
                package_manager="pnpm",
                adapter_profile=PNPM_ADAPTER_PROFILE,
            ),
        ),
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


def test_dependency_upgrade_guardrail_states_exact_manager_authority_boundary():
    description = get_guardrail("dependency_upgrade_evidence").description

    assert "pnpm is the sole managed execution adapter" in description
    assert "npm, Yarn Berry 4 root projects, and uv" in description
    assert "are external-builder-only" in description
    assert "watcher candidates do not by themselves become canonical accepted evidence" in description
    assert "Yarn has no Python watcher candidate" in description
    assert "uv's legacy watcher candidate remains noncanonical" in description
    assert "Cargo and Go Modules are bounded observation-only parser foundations" in description
    assert "excluded from evidence gates and Pack eligibility" in description
    assert "go.sum checksums are syntax-checked provided baseline material" in description
    assert "not authenticated checksum-database or proxy receipts" in description
    assert "Bun remains detected-only and unsupported" in description
