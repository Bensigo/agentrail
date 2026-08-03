from __future__ import annotations

import json
from pathlib import Path

from agentrail.dependencies.evidence import (
    CandidateIdentity,
    DependencyCandidate,
    DependencyChange,
    DependencyDecisionStatus,
    EvidenceResolution,
    EvidenceSource,
    EvidenceState,
    EvidenceWaiver,
    LockResolution,
    ReleaseEvidence,
    SecurityEvidence,
    SecurityAdvisory,
    UsageEvidence,
    UsageFinding,
    collect_dependency_evidence,
    dependency_gate_input,
    evaluate_dependency_evidence,
    resolve_pnpm_lock_transition,
    scan_usage_evidence,
    security_evidence_from_advisory_payload,
    write_dependency_evidence,
)
from agentrail.dependencies.pnpm import DependencySnapshot


NOW = "2026-08-03T10:00:00Z"


def _candidate() -> DependencyCandidate:
    return DependencyCandidate(
        package="lodash",
        dependency_kind="dependencies",
        specifier="^4.17.21",
        current_version="4.17.21",
        target_version="4.17.22",
        manifest_path="package.json",
        lockfile_path="pnpm-lock.yaml",
        baseline_sha="a" * 40,
        fingerprint="sha256:candidate-1580",
    )


def _source(identifier: str = "lodash-v4.17.22") -> EvidenceSource:
    return EvidenceSource(identifier, f"https://registry.example/{identifier}", NOW, "release")


def _usage(*, status: EvidenceState = EvidenceState.NOT_FOUND) -> UsageEvidence:
    finding = UsageFinding(status, detail="fixture")
    return UsageEvidence(finding, finding, finding, finding, NOW)


def _resolved_release() -> ReleaseEvidence:
    return ReleaseEvidence(
        EvidenceResolution.RESOLVED,
        "4.17.22",
        (_source(),),
        NOW,
        canonical=True,
        summary="summary is not used as proof",
    )


def _resolved_lock() -> LockResolution:
    return LockResolution(
        EvidenceResolution.RESOLVED,
        direct_changes=(DependencyChange("lodash", ("4.17.21",), ("4.17.22",), "direct"),),
        observed_at=NOW,
    )


def _resolved_security() -> SecurityEvidence:
    return SecurityEvidence(EvidenceResolution.RESOLVED, sources=(_source("osv-query"),), observed_at=NOW)


class _Provider:
    def __init__(self, value):
        self.value = value

    def resolve(self, candidate):
        return self.value

    def inspect(self, candidate):
        return self.value


def test_collect_records_candidate_sources_timestamps_and_ready_decision() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    payload = evidence.to_dict()
    assert payload["candidateFingerprint"] == "sha256:candidate-1580"
    assert payload["candidate"]["currentVersion"] == "4.17.21"
    assert payload["release"]["sources"][0]["identifier"] == "lodash-v4.17.22"
    assert payload["release"]["sources"][0]["observedAt"] == NOW
    assert evidence.decision.status is DependencyDecisionStatus.READY
    assert dependency_gate_input(payload) == (
        True,
        "candidate compatibility, usage, lock, release, and security evidence is complete",
    )


def test_usage_reports_direct_config_peer_and_workspace_findings() -> None:
    snapshot = DependencySnapshot(
        files={
            "package.json": json.dumps({"dependencies": {"lodash": "^4.17.21"}}),
            "src/index.ts": 'import chunk from "lodash/chunk";\n',
            "vite.config.ts": 'export default { optimizeDeps: { include: ["lodash"] } };\n',
            "packages/plugin/package.json": json.dumps({"peerDependencies": {"lodash": "^4.17.0"}}),
            "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        },
        baseline_sha="a" * 40,
    )
    usage = scan_usage_evidence(snapshot, "lodash", context_complete=True, observed_at=NOW)

    assert usage.direct_imports.status is EvidenceState.PROVEN
    assert usage.config_references.status is EvidenceState.PROVEN
    assert usage.peer_usage.status is EvidenceState.PROVEN
    assert usage.workspace_usage.status is EvidenceState.PROVEN
    assert "src/index.ts" in usage.direct_imports.paths


def test_incomplete_context_is_unknown_not_not_found() -> None:
    snapshot = DependencySnapshot(
        files={"package.json": '{"dependencies":{"lodash":"^4.17.21"}}'},
        baseline_sha="a" * 40,
    )
    usage = scan_usage_evidence(snapshot, "lodash", context_complete=False, observed_at=NOW)
    assert usage.direct_imports.status is EvidenceState.UNKNOWN
    assert usage.config_references.status is EvidenceState.UNKNOWN
    assert usage.workspace_usage.status is EvidenceState.UNKNOWN


def test_lock_transition_captures_direct_transitive_and_peer_conflicts() -> None:
    baseline = """lockfileVersion: '9.0'\n\npackages:\n  lodash@4.17.21:\n    resolution: {integrity: sha}\n  react@18.2.0:\n    resolution: {integrity: sha}\nsnapshots:\n  lodash@4.17.21:\n  react@18.2.0:\n    peerDependencies:\n      lodash: ^4.17.21\n"""
    target = """lockfileVersion: '9.0'\n\npackages:\n  lodash@4.17.22:\n    resolution: {integrity: sha}\n  react@18.3.0:\n    resolution: {integrity: sha}\n    peerDependencies:\n      lodash: ^4.17.99\nsnapshots:\n  lodash@4.17.22:\n  react@18.3.0:\n    peerDependencies:\n      lodash: ^4.17.99\n"""
    lock = resolve_pnpm_lock_transition(_candidate(), baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW)

    assert lock.resolution is EvidenceResolution.RESOLVED
    assert lock.direct_changes[0].from_versions == ("4.17.21",)
    assert lock.direct_changes[0].to_versions == ("4.17.22",)
    assert lock.transitive_changes[0].package == "react"
    assert lock.peer_conflicts[0].peer == "lodash"

    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()), usage=_Provider(_usage()),
        lock=_Provider(lock), security=_Provider(_resolved_security()), observed_at=NOW,
    )
    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert any("peer conflict" in reason for reason in evidence.decision.blocking_reasons)


def test_malformed_target_lock_is_not_verifiable_and_blocks() -> None:
    lock = resolve_pnpm_lock_transition(
        _candidate(), baseline_lockfile="lockfileVersion: '9.0'\npackages: {}\n", target_lockfile="not yaml", observed_at=NOW,
    )
    assert lock.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "unsupported" in lock.reason


def test_high_and_critical_new_advisories_block_even_with_explicit_waiver() -> None:
    advisory = SecurityEvidence(
        EvidenceResolution.RESOLVED,
        advisories=(
            SecurityAdvisory(
                "GHSA-high", "lodash", "high", True, _source("GHSA-high"),
            ),
        ),
        sources=(_source("osv"),),
        observed_at=NOW,
    )
    evidence = collect_dependency_evidence(
        _candidate(), release=_Provider(_resolved_release()), usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()), security=_Provider(advisory),
        waiver=EvidenceWaiver("waiver-1", "user-1", "reviewed", NOW, ("release",)), observed_at=NOW,
    )
    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert any("high security advisory" in reason for reason in evidence.decision.blocking_reasons)


def test_unknown_release_requires_explicit_visible_waiver_but_unavailable_does_not() -> None:
    unknown_release = ReleaseEvidence(EvidenceResolution.UNKNOWN, "4.17.22", observed_at=NOW, reason="release notes not found")
    common = dict(release=_Provider(unknown_release), usage=_Provider(_usage()), lock=_Provider(_resolved_lock()), security=_Provider(_resolved_security()))
    blocked = collect_dependency_evidence(_candidate(), **common, observed_at=NOW)
    assert blocked.decision.status is DependencyDecisionStatus.BLOCKED
    assert blocked.decision.waiver is None

    waived = collect_dependency_evidence(
        _candidate(), **common,
        waiver=EvidenceWaiver("waiver-2", "human-1", "release page unavailable; reviewed manually", NOW, ("release",)),
        observed_at=NOW,
    )
    assert waived.decision.status is DependencyDecisionStatus.READY
    assert waived.decision.waiver is not None
    assert waived.decision.waived_reasons == ("release notes not found",)

    unavailable = ReleaseEvidence(EvidenceResolution.NOT_VERIFIABLE, "", observed_at=NOW, reason="network failure")
    still_blocked = collect_dependency_evidence(
        _candidate(), release=_Provider(unavailable), usage=_Provider(_usage()), lock=_Provider(_resolved_lock()), security=_Provider(_resolved_security()),
        waiver=EvidenceWaiver("waiver-3", "human-1", "try anyway", NOW, ("release",)), observed_at=NOW,
    )
    assert still_blocked.decision.status is DependencyDecisionStatus.BLOCKED
    assert "network failure" in still_blocked.decision.blocking_reasons


def test_security_payload_requires_canonical_fields_and_introduction_evidence() -> None:
    malformed = security_evidence_from_advisory_payload(
        {"vulnerabilities": [{"id": "GHSA-1", "severity": "high"}]},
        package="lodash", source=_source("osv"), observed_at=NOW,
    )
    assert malformed.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "introduction evidence" in malformed.reason


def test_persistence_exposes_artifact_and_metadata(tmp_path: Path) -> None:
    evidence = collect_dependency_evidence(
        _candidate(), release=_Provider(_resolved_release()), usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()), security=_Provider(_resolved_security()), observed_at=NOW,
    )
    metadata = tmp_path / "run.json"
    metadata.write_text("{}\n")
    artifact = tmp_path / "dependency_evidence.json"
    write_dependency_evidence(artifact, evidence, metadata_path=metadata)

    stored = json.loads(artifact.read_text())
    run = json.loads(metadata.read_text())
    assert stored["decision"]["proofComplete"] is True
    assert run["dependencyEvidence"]["candidateFingerprint"] == "sha256:candidate-1580"
    assert run["dependencyEvidenceFile"] == str(artifact)
