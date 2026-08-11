from __future__ import annotations

import base64
import json
from dataclasses import replace
from pathlib import Path

import pytest

import agentrail.dependencies.evidence as evidence_module

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
    collect_and_write_dependency_evidence,
    dependency_gate_input,
    evaluate_dependency_evidence,
    resolve_npm_lock_transition,
    resolve_cargo_lock_transition,
    load_dependency_evidence_for_gate,
    resolve_pnpm_lock_transition,
    scan_usage_evidence,
    security_evidence_from_advisory_payload,
    write_dependency_evidence,
)
from agentrail.dependencies.pnpm import DependencySnapshot
from agentrail.dependencies.go_modules import GO_MODULES_OBSERVATION_PROFILE
from agentrail.dependencies.manager import CARGO_ADAPTER_PROFILE, NPM_ADAPTER_PROFILE, PNPM_ADAPTER_PROFILE
from agentrail.dependencies.pnpm import adapter_identity_fingerprint


NOW = "2026-08-03T10:00:00Z"


def _candidate() -> DependencyCandidate:
    fingerprint = "sha256:candidate-1580"
    return DependencyCandidate(
        package="lodash",
        dependency_kind="dependencies",
        specifier="^4.17.21",
        current_version="4.17.21",
        target_version="4.17.22",
        manifest_path="package.json",
        lockfile_path="pnpm-lock.yaml",
        baseline_sha="a" * 40,
        fingerprint=fingerprint,
        adapter_profile=PNPM_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint,
            ecosystem="node",
            package_manager="pnpm",
            adapter_profile=PNPM_ADAPTER_PROFILE,
        ),
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


def _cargo_candidate() -> DependencyCandidate:
    fingerprint = "sha256:cargo-candidate"
    return DependencyCandidate(
        package="serde", dependency_kind="dependencies", specifier="^1.0.203",
        current_version="1.0.203", target_version="1.0.204",
        manifest_path="Cargo.toml", lockfile_path="Cargo.lock", baseline_sha="a" * 40,
        fingerprint=fingerprint, ecosystem="rust", package_manager="cargo",
        adapter_profile=CARGO_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint, ecosystem="rust", package_manager="cargo",
            adapter_profile=CARGO_ADAPTER_PROFILE,
        ),
    )


def _cargo_lock(serde_version: str, *, helper_version: str = "1.0.0", helper_source: str = "registry+https://github.com/rust-lang/crates.io-index") -> str:
    return f'''version = 3

[[package]]
name = "demo"
version = "0.1.0"
dependencies = ["serde"]

[[package]]
name = "serde"
version = "{serde_version}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "{'a' * 64}"
dependencies = ["helper"]

[[package]]
name = "helper"
version = "{helper_version}"
source = "{helper_source}"
checksum = "{'b' * 64}"
'''


def test_cargo_lock_transition_proves_a_reachable_crates_io_graph() -> None:
    resolution = resolve_cargo_lock_transition(
        _cargo_candidate(),
        baseline_lockfile=_cargo_lock("1.0.203"),
        target_lockfile=_cargo_lock("1.0.204", helper_version="1.1.0"),
        observed_at=NOW,
    )

    assert resolution.resolution is EvidenceResolution.RESOLVED
    assert resolution.direct_changes == (
        DependencyChange("serde", ("1.0.203",), ("1.0.204",), "direct"),
    )
    assert resolution.transitive_changes == (
        DependencyChange("helper", ("1.0.0",), ("1.1.0",), "transitive"),
    )


def test_cargo_lock_transition_refuses_noncanonical_provenance() -> None:
    resolution = resolve_cargo_lock_transition(
        _cargo_candidate(),
        baseline_lockfile=_cargo_lock("1.0.203"),
        target_lockfile=_cargo_lock("1.0.204", helper_source="git+https://example.invalid/helper"),
        observed_at=NOW,
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "name crates.io" in resolution.reason


@pytest.mark.parametrize(
    ("target", "reason"),
    [
        (_cargo_lock("2.0.0"), "direct transition"),
        (_cargo_lock("1.0.204").replace('dependencies = ["serde"]', 'dependencies = ["serde", "helper"]', 1), "root dependency graph"),
        (_cargo_lock("1.0.204").replace('checksum = "' + "b" * 64 + '"', 'checksum = "' + "c" * 64 + '"'), "metadata or provenance"),
    ],
)
def test_cargo_lock_transition_refuses_constraint_root_and_checksum_drift(target, reason) -> None:
    resolution = resolve_cargo_lock_transition(
        _cargo_candidate(), baseline_lockfile=_cargo_lock("1.0.203"),
        target_lockfile=target, observed_at=NOW,
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert reason in resolution.reason


def test_cargo_lock_transition_refuses_a_candidate_target_outside_its_constraint() -> None:
    candidate = replace(_cargo_candidate(), target_version="2.0.0")
    resolution = resolve_cargo_lock_transition(
        candidate, baseline_lockfile=_cargo_lock("1.0.203"),
        target_lockfile=_cargo_lock("2.0.0"), observed_at=NOW,
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "stable caret constraint" in resolution.reason


def _cargo_release() -> ReleaseEvidence:
    return ReleaseEvidence(
        EvidenceResolution.RESOLVED, "1.0.204",
        (EvidenceSource("crates.io:serde@1.0.204", "https://crates.io/api/v1/crates/serde/1.0.204", NOW, "release"),),
        NOW, canonical=True,
    )


def _cargo_security() -> SecurityEvidence:
    return SecurityEvidence(
        EvidenceResolution.RESOLVED,
        sources=(EvidenceSource("osv:crates.io:serde@1.0.204", "https://api.osv.dev/v1/query", NOW, "security"),),
        observed_at=NOW,
    )


def test_cargo_resolver_and_forged_payload_remain_blocked_at_both_evidence_gates() -> None:
    lock = resolve_cargo_lock_transition(
        _cargo_candidate(), baseline_lockfile=_cargo_lock("1.0.203"),
        target_lockfile=_cargo_lock("1.0.204"), observed_at=NOW,
    )
    evidence = collect_dependency_evidence(
        _cargo_candidate(), release=_Provider(_cargo_release()), usage=_Provider(_usage()),
        lock=_Provider(lock), security=_Provider(_cargo_security()), observed_at=NOW,
    )
    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert "candidate adapter capability is unavailable" in evidence.decision.blocking_reasons
    assert dependency_gate_input(evidence.to_dict()) == (
        False, "dependency evidence adapter capability is unavailable",
    )

    synthetic_lock = LockResolution(
        EvidenceResolution.RESOLVED,
        direct_changes=(DependencyChange("serde", ("1.0.203",), ("1.0.204",), "direct"),),
        observed_at=NOW,
    )
    blocked_lock = collect_dependency_evidence(
        _cargo_candidate(), release=_Provider(_cargo_release()), usage=_Provider(_usage()),
        lock=_Provider(synthetic_lock), security=_Provider(_cargo_security()), observed_at=NOW,
    )
    assert blocked_lock.decision.status is DependencyDecisionStatus.BLOCKED
    assert "candidate adapter capability is unavailable" in blocked_lock.decision.blocking_reasons

    forged = json.loads(json.dumps(evidence.to_dict()))
    forged["decision"] = {
        "status": "ready", "proofComplete": True, "blockingReasons": [],
        "waivedReasons": [], "waiver": None,
    }
    assert dependency_gate_input(forged) == (
        False, "dependency evidence adapter capability is unavailable",
    )


def test_go_observation_and_forged_ready_payload_remain_blocked_at_both_evidence_gates() -> None:
    fingerprint = "sha256:go-candidate"
    candidate = DependencyCandidate(
        package="github.com/acme/lib",
        dependency_kind="dependencies",
        specifier="v1.2.3",
        current_version="v1.2.3",
        target_version="v1.3.0",
        manifest_path="go.mod",
        lockfile_path="go.sum",
        baseline_sha="a" * 40,
        fingerprint=fingerprint,
        ecosystem="go",
        package_manager="go-modules",
        adapter_profile=GO_MODULES_OBSERVATION_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint,
            ecosystem="go",
            package_manager="go-modules",
            adapter_profile=GO_MODULES_OBSERVATION_PROFILE,
        ),
    )
    release = ReleaseEvidence(
        EvidenceResolution.RESOLVED,
        "v1.3.0",
        (
            EvidenceSource(
                "proxy.golang.org:github.com/acme/lib@v1.3.0",
                "https://proxy.golang.org/github.com/acme/lib/@v/v1.3.0.info",
                NOW,
                "release",
            ),
        ),
        NOW,
        canonical=True,
    )
    lock = LockResolution(
        EvidenceResolution.RESOLVED,
        direct_changes=(
            DependencyChange(
                "github.com/acme/lib",
                ("v1.2.3",),
                ("v1.3.0",),
                "direct",
            ),
        ),
        observed_at=NOW,
    )
    security = SecurityEvidence(
        EvidenceResolution.RESOLVED,
        sources=(
            EvidenceSource(
                "osv:Go:github.com/acme/lib@v1.3.0",
                "https://api.osv.dev/v1/query",
                NOW,
                "security",
            ),
        ),
        observed_at=NOW,
    )

    evidence = collect_dependency_evidence(
        candidate,
        release=_Provider(release),
        usage=_Provider(_usage()),
        lock=_Provider(lock),
        security=_Provider(security),
        observed_at=NOW,
    )

    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert "candidate adapter capability is unavailable" in evidence.decision.blocking_reasons
    assert dependency_gate_input(evidence.to_dict()) == (
        False,
        "dependency evidence adapter capability is unavailable",
    )

    forged = json.loads(json.dumps(evidence.to_dict()))
    forged["decision"] = {
        "status": "ready",
        "proofComplete": True,
        "blockingReasons": [],
        "waivedReasons": [],
        "waiver": None,
    }
    assert dependency_gate_input(forged) == (
        False,
        "dependency evidence adapter capability is unavailable",
    )


class _Provider:
    def __init__(self, value):
        self.value = value

    def resolve(self, candidate):
        return self.value

    def inspect(self, candidate):
        return self.value


class _RaisingProvider:
    def __init__(self, message: str = "network down") -> None:
        self.message = message

    def resolve(self, candidate):
        raise RuntimeError(self.message)

    def inspect(self, candidate):
        raise RuntimeError(self.message)


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
    assert payload["schemaVersion"] == 2
    assert payload["candidateFingerprint"] == "sha256:candidate-1580"
    assert payload["candidate"]["currentVersion"] == "4.17.21"
    assert payload["release"]["sources"][0]["identifier"] == "lodash-v4.17.22"
    assert payload["release"]["sources"][0]["observedAt"] == NOW
    assert evidence.decision.status is DependencyDecisionStatus.READY
    assert dependency_gate_input(payload) == (
        True,
        "candidate compatibility, usage, lock, release, and security evidence is complete",
    )


def test_in_memory_evaluator_binds_release_and_direct_change_to_candidate() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )
    direct = evidence.lock.direct_changes[0]
    tampered = (
        replace(evidence, release=replace(evidence.release, version="9.9.9")),
        replace(
            evidence,
            lock=replace(
                evidence.lock,
                direct_changes=(replace(direct, package="other-package"),),
            ),
        ),
        replace(
            evidence,
            lock=replace(
                evidence.lock,
                direct_changes=(replace(direct, from_versions=("0.0.1",)),),
            ),
        ),
        replace(
            evidence,
            lock=replace(
                evidence.lock,
                direct_changes=(replace(direct, to_versions=("9.9.9",)),),
            ),
        ),
        replace(
            evidence,
            lock=replace(
                evidence.lock,
                direct_changes=(replace(direct, scope="transitive"),),
            ),
        ),
        replace(
            evidence,
            lock=replace(evidence.lock, direct_changes=(direct, direct)),
        ),
    )

    for item in tampered:
        decision = evaluate_dependency_evidence(item)

        assert decision.status is DependencyDecisionStatus.BLOCKED
        assert any(
            "candidate" in reason or "exactly" in reason
            for reason in decision.blocking_reasons
        )


def test_in_memory_evaluator_rejects_malformed_transitive_change_rows() -> None:
    transitive = DependencyChange(
        "helper", ("1.0.0",), ("1.1.0",), "transitive"
    )
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(replace(_resolved_lock(), transitive_changes=(transitive,))),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )
    assert evidence.decision.status is DependencyDecisionStatus.READY

    malformed = (
        ("garbage",),
        (replace(transitive, package=""),),
        (replace(transitive, from_versions=(1,)),),
        (replace(transitive, scope="direct"),),
        (replace(transitive, package="lodash"),),
        (transitive, transitive),
        (replace(transitive, to_versions=("1.0.0",)),),
        (replace(transitive, from_versions=(), to_versions=()),),
        (replace(transitive, from_versions=("1.0.0", "1.0.0")),),
    )
    for changes in malformed:
        decision = evaluate_dependency_evidence(
            replace(evidence, lock=replace(evidence.lock, transitive_changes=changes))
        )

        assert decision.status is DependencyDecisionStatus.BLOCKED
        assert (
            "target lock transitive changes are malformed"
            in decision.blocking_reasons
        )


def test_in_memory_evaluator_validates_sources_and_candidate_bound_advisories() -> None:
    source = _source("osv")
    transitive = DependencyChange(
        "helper", ("1.0.0",), ("1.1.0",), "transitive"
    )
    security = SecurityEvidence(
        EvidenceResolution.RESOLVED,
        advisories=(
            SecurityAdvisory("GHSA-helper", "helper", "low", False, source),
        ),
        sources=(source,),
        observed_at=NOW,
    )
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(replace(_resolved_lock(), transitive_changes=(transitive,))),
        security=_Provider(security),
        observed_at=NOW,
    )
    assert evidence.decision.status is DependencyDecisionStatus.READY

    advisory = evidence.security.advisories[0]
    unrelated_source = _source("other-osv")
    tampered_security = (
        replace(
            evidence.security,
            sources=(EvidenceSource(123, None, NOW, "security"),),
        ),
        replace(
            evidence.security,
            advisories=(replace(advisory, advisory_id=""),),
        ),
        replace(
            evidence.security,
            advisories=(replace(advisory, severity=""),),
        ),
        replace(
            evidence.security,
            advisories=(replace(advisory, severity="HIGH"),),
        ),
        replace(
            evidence.security,
            advisories=(replace(advisory, package="unrelated"),),
        ),
        replace(
            evidence.security,
            advisories=(replace(advisory, introduced=None),),
        ),
        replace(
            evidence.security,
            advisories=(replace(advisory, source=unrelated_source),),
        ),
    )
    for security_evidence in tampered_security:
        decision = evaluate_dependency_evidence(
            replace(evidence, security=security_evidence)
        )

        assert decision.status is DependencyDecisionStatus.BLOCKED
        assert any(
            "security advisory" in reason
            for reason in decision.blocking_reasons
        )

    typed_release_source = EvidenceSource("release", None, 123, "release")
    release_decision = evaluate_dependency_evidence(
        replace(
            evidence,
            release=replace(evidence.release, sources=(typed_release_source,)),
        )
    )
    assert release_decision.status is DependencyDecisionStatus.BLOCKED
    assert (
        "release evidence has no valid canonical source and timestamp"
        in release_decision.blocking_reasons
    )


def test_in_memory_and_serialized_gates_reject_noop_candidate_transition() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )
    noop = replace(
        evidence,
        candidate=replace(
            evidence.candidate,
            current_version=evidence.candidate.target_version,
        ),
        lock=replace(
            evidence.lock,
            direct_changes=(
                replace(
                    evidence.lock.direct_changes[0],
                    from_versions=(evidence.candidate.target_version,),
                ),
            ),
        ),
    )

    decision = evaluate_dependency_evidence(noop)
    payload = noop.to_dict()
    payload["decision"] = evidence.decision.to_dict()
    valid, reason = dependency_gate_input(payload)

    assert decision.status is DependencyDecisionStatus.BLOCKED
    assert "candidate dependency transition is a no-op" in decision.blocking_reasons
    assert valid is False
    assert reason == "dependency evidence candidate transition is a no-op"


def test_serialized_gate_binds_release_and_direct_change_to_candidate() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    def payload() -> dict:
        return json.loads(json.dumps(evidence.to_dict()))

    release = payload()
    release["release"]["version"] = "9.9.9"
    package = payload()
    package["lock"]["directChanges"][0]["package"] = "other-package"
    before = payload()
    before["lock"]["directChanges"][0]["fromVersions"] = ["0.0.1"]
    after = payload()
    after["lock"]["directChanges"][0]["toVersions"] = ["9.9.9"]
    scope = payload()
    scope["lock"]["directChanges"][0]["scope"] = "transitive"
    count = payload()
    count["lock"]["directChanges"].append(
        dict(count["lock"]["directChanges"][0])
    )

    for item in (release, package, before, after, scope, count):
        valid, reason = dependency_gate_input(item)

        assert valid is False
        assert "candidate" in reason or "exactly one" in reason


def test_serialized_gate_rejects_malformed_transitive_change_rows() -> None:
    transitive = DependencyChange(
        "helper", ("1.0.0",), ("1.1.0",), "transitive"
    )
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(replace(_resolved_lock(), transitive_changes=(transitive,))),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    def payload() -> dict:
        return json.loads(json.dumps(evidence.to_dict()))

    malformed = []
    garbage = payload()
    garbage["lock"]["transitiveChanges"] = ["garbage"]
    malformed.append(garbage)
    for field, value in (
        ("package", ""),
        ("fromVersions", [1]),
        ("scope", "direct"),
        ("package", "lodash"),
        ("toVersions", ["1.0.0"]),
        ("fromVersions", []),
    ):
        item = payload()
        item["lock"]["transitiveChanges"][0][field] = value
        if field == "fromVersions" and value == []:
            item["lock"]["transitiveChanges"][0]["toVersions"] = []
        malformed.append(item)
    duplicate = payload()
    duplicate["lock"]["transitiveChanges"].append(
        dict(duplicate["lock"]["transitiveChanges"][0])
    )
    malformed.append(duplicate)
    duplicate_version = payload()
    duplicate_version["lock"]["transitiveChanges"][0]["fromVersions"] = [
        "1.0.0",
        "1.0.0",
    ]
    malformed.append(duplicate_version)

    for item in malformed:
        valid, reason = dependency_gate_input(item)

        assert valid is False
        assert reason == "target lock transitive changes are malformed"


def test_serialized_gate_validates_release_and_security_source_contracts() -> None:
    source = _source("osv")
    transitive = DependencyChange(
        "helper", ("1.0.0",), ("1.1.0",), "transitive"
    )
    security = SecurityEvidence(
        EvidenceResolution.RESOLVED,
        advisories=(
            SecurityAdvisory("GHSA-helper", "helper", "low", False, source),
        ),
        sources=(source,),
        observed_at=NOW,
    )
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(replace(_resolved_lock(), transitive_changes=(transitive,))),
        security=_Provider(security),
        observed_at=NOW,
    )
    assert evidence.decision.status is DependencyDecisionStatus.READY

    def payload() -> dict:
        return json.loads(json.dumps(evidence.to_dict()))

    typed_release = payload()
    typed_release["release"]["sources"][0]["observedAt"] = 123
    valid, reason = dependency_gate_input(typed_release)
    assert valid is False
    assert reason == "release evidence has no valid canonical source"

    tampered = []
    empty_source = payload()
    empty_source["security"]["sources"] = [{}]
    tampered.append(empty_source)
    for field, value in (
        ("severity", ""),
        ("severity", "HIGH"),
        ("package", "unrelated"),
        ("introduced", "false"),
    ):
        item = payload()
        item["security"]["advisories"][0][field] = value
        tampered.append(item)
    source_mismatch = payload()
    source_mismatch["security"]["advisories"][0]["source"] = {
        "identifier": "other-osv",
        "url": "https://registry.example/other-osv",
        "observedAt": NOW,
        "kind": "release",
    }
    tampered.append(source_mismatch)

    for item in tampered:
        valid, reason = dependency_gate_input(item)

        assert valid is False
        assert "security advisory" in reason


def test_serialized_gate_binds_duplicate_top_level_candidate_identity() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    tampered = []
    for field in (
        "candidateFingerprint",
        "adapterProfile",
        "adapterIdentityFingerprint",
    ):
        payload = json.loads(json.dumps(evidence.to_dict()))
        payload[field] = "tampered"
        tampered.append(payload)

    for payload in tampered:
        valid, reason = dependency_gate_input(payload)

        assert valid is False
        assert reason == "dependency evidence top-level candidate identity is mismatched"


def test_serialized_gate_rejects_non_string_candidate_identity_and_versions() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    mirrored_fields = {
        "package": None,
        "currentVersion": None,
        "targetVersion": None,
        "baselineSha": None,
        "fingerprint": "candidateFingerprint",
        "adapterProfile": "adapterProfile",
        "adapterIdentityFingerprint": "adapterIdentityFingerprint",
    }
    for nested, top_level in mirrored_fields.items():
        payload = json.loads(json.dumps(evidence.to_dict()))
        payload["candidate"][nested] = 123
        if top_level is not None:
            payload[top_level] = 123
        if nested == "package":
            payload["lock"]["directChanges"][0]["package"] = 123
        elif nested == "currentVersion":
            payload["lock"]["directChanges"][0]["fromVersions"] = [123]
        elif nested == "targetVersion":
            payload["release"]["version"] = 123
            payload["lock"]["directChanges"][0]["toVersions"] = [123]

        valid, reason = dependency_gate_input(payload)

        assert valid is False
        assert reason == "dependency evidence candidate identity is incomplete"

    for top_level in (
        "candidateFingerprint",
        "adapterProfile",
        "adapterIdentityFingerprint",
    ):
        payload = json.loads(json.dumps(evidence.to_dict()))
        payload[top_level] = 123

        valid, reason = dependency_gate_input(payload)

        assert valid is False
        assert reason == "dependency evidence top-level candidate identity is incomplete"

    for field in ("fromVersions", "toVersions"):
        payload = json.loads(json.dumps(evidence.to_dict()))
        payload["lock"]["directChanges"][0][field] = [123]

        valid, reason = dependency_gate_input(payload)

        assert valid is False
        assert reason == "target lock direct change does not exactly match the candidate"


def test_legacy_v1_evidence_is_readable_but_cannot_authorize_current_work() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )
    legacy = json.loads(json.dumps(evidence.to_dict()))
    legacy["schemaVersion"] = 1

    valid, reason = dependency_gate_input(legacy)

    assert legacy["candidate"]["fingerprint"] == evidence.candidate.fingerprint
    assert valid is False
    assert "unsupported" in reason
    assert "regenerate" in reason
    assert "schemaVersion 2" in reason


def test_evidence_refuses_cross_profile_replay_even_with_legacy_fingerprint_unchanged() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )
    replayed_identity = replace(
        evidence.candidate,
        adapter_profile=NPM_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=evidence.candidate.fingerprint,
            ecosystem="node",
            package_manager="pnpm",
            adapter_profile=NPM_ADAPTER_PROFILE,
        ),
    )
    replayed = replace(evidence, candidate=replayed_identity)

    decision = evaluate_dependency_evidence(replayed)
    payload = replayed.to_dict()
    payload["decision"] = evidence.decision.to_dict()
    valid, reason = dependency_gate_input(payload)

    assert decision.status is DependencyDecisionStatus.BLOCKED
    assert any("adapter profile" in item for item in decision.blocking_reasons)
    assert valid is False
    assert "adapter profile" in reason


def test_provider_failures_become_not_verifiable_and_block() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_RaisingProvider(),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    assert evidence.release.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert any("not_verifiable" in reason for reason in evidence.decision.blocking_reasons)


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


def test_nested_package_manifest_duplicate_peer_key_is_unknown_and_blocks() -> None:
    snapshot = DependencySnapshot(
        files={
            "package.json": json.dumps({"dependencies": {"lodash": "^4.17.21"}}),
            "packages/plugin/package.json": (
                '{"peerDependencies":{"lodash":"^4.17.0"},'
                '"peerDependencies":{"lodash":"^5.0.0"}}'
            ),
        },
        baseline_sha="a" * 40,
    )

    usage = scan_usage_evidence(
        snapshot, "lodash", context_complete=True, observed_at=NOW
    )
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(usage),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    assert usage.peer_usage.status is EvidenceState.UNKNOWN
    assert "duplicate JSON key" in usage.peer_usage.detail
    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert any("not_verifiable" in reason for reason in evidence.decision.blocking_reasons)


def test_incomplete_context_is_unknown_not_not_found() -> None:
    snapshot = DependencySnapshot(
        files={"package.json": '{"dependencies":{"lodash":"^4.17.21"}}'},
        baseline_sha="a" * 40,
    )
    usage = scan_usage_evidence(snapshot, "lodash", context_complete=False, observed_at=NOW)
    assert usage.direct_imports.status is EvidenceState.UNKNOWN
    assert usage.config_references.status is EvidenceState.UNKNOWN
    assert usage.workspace_usage.status is EvidenceState.UNKNOWN


def test_ambiguous_usage_blocks_as_not_verifiable() -> None:
    evidence = collect_dependency_evidence(
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage(status=EvidenceState.UNKNOWN)),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        observed_at=NOW,
    )

    assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
    assert any("not_verifiable" in reason for reason in evidence.decision.blocking_reasons)


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


def _npm_entry(package: str, version: str, **extra: object) -> dict[str, object]:
    return {
        "version": version,
        "resolved": f"https://registry.npmjs.org/{package}/-/{package.rsplit('/', 1)[-1]}-{version}.tgz",
        "integrity": "sha512-" + base64.b64encode(b"f" * 64).decode("ascii"),
        **extra,
    }


def test_npm_lock_transition_requires_the_approved_direct_target() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40, fingerprint="sha256:npm",
        package_manager="npm",
    )
    baseline = json.dumps({
        "lockfileVersion": 3,
        "packages": {"": {"dependencies": {"lodash": "^4.17.21"}}, "node_modules/lodash": _npm_entry("lodash", "4.17.21")},
    })
    target = json.dumps({
        "lockfileVersion": 3,
        "packages": {"": {"dependencies": {"lodash": "^4.17.21"}}, "node_modules/lodash": _npm_entry("lodash", "4.17.22")},
    })

    resolved = resolve_npm_lock_transition(candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW)
    missing = resolve_npm_lock_transition(candidate, baseline_lockfile=baseline, target_lockfile=baseline, observed_at=NOW)

    assert resolved.resolution is EvidenceResolution.RESOLVED
    assert resolved.direct_changes == (DependencyChange("lodash", ("4.17.21",), ("4.17.22",), "direct"),)
    assert missing.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "must resolve exactly lodash@4.17.22" in missing.reason


def test_npm_lock_transition_refuses_non_v3_lockfiles() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40, fingerprint="sha256:npm-v2",
        package_manager="npm",
    )
    lockfile = json.dumps({"lockfileVersion": 2, "packages": {}})

    resolution = resolve_npm_lock_transition(
        candidate, baseline_lockfile=lockfile, target_lockfile=lockfile, observed_at=NOW
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "lockfileVersion 3 only" in resolution.reason


def test_npm_lock_transition_refuses_nested_react_helper_graph_instead_of_partial_peer_evidence() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40, fingerprint="sha256:npm-nested",
        package_manager="npm",
    )
    baseline = json.dumps({
        "lockfileVersion": 3,
        "packages": {"": {"dependencies": {"lodash": "^4.17.21"}}, "node_modules/lodash": _npm_entry("lodash", "4.17.21")},
    })
    target = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.22"),
            "node_modules/react": _npm_entry("react", "18.3.0"),
            "node_modules/react/node_modules/helper": _npm_entry("helper", "2.0.0"),
        },
    })

    resolution = resolve_npm_lock_transition(
        candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "nested node_modules graphs are unsupported" in resolution.reason


def test_npm_lock_transition_refuses_duplicate_root_kind_in_baseline_and_target() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-root-duplicate", package_manager="npm",
    )
    baseline_data = {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.21"),
        },
    }
    target_data = {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.22"),
        },
    }
    for phase in ("baseline", "target"):
        baseline = json.loads(json.dumps(baseline_data))
        target = json.loads(json.dumps(target_data))
        selected = baseline if phase == "baseline" else target
        selected["packages"][""]["devDependencies"] = {"lodash": "^4.17.21"}

        resolution = resolve_npm_lock_transition(
            candidate,
            baseline_lockfile=json.dumps(baseline),
            target_lockfile=json.dumps(target),
            observed_at=NOW,
        )

        assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
        assert "multiple sections" in resolution.reason


def test_npm_lock_transition_requires_exact_direct_version_sets(monkeypatch) -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-direct-exact", package_manager="npm",
    )

    def entries(*versions: str):
        return {
            f"lodash@{version}": evidence_module._LockedEntry("lodash", version)
            for version in versions
        }

    cases = (
        ((), ("4.17.22",), "baseline"),
        (("4.17.20",), ("4.17.22",), "baseline"),
        (("4.17.21",), ("4.17.22", "4.17.23"), "target"),
    )
    for baseline_versions, target_versions, phase in cases:
        def parse(text: str):
            versions = baseline_versions if text == "baseline" else target_versions
            return entries(*versions), {
                "lodash": ("dependencies", "^4.17.21")
            }

        monkeypatch.setattr(evidence_module, "_parse_npm_lock_entries", parse)
        resolution = resolve_npm_lock_transition(
            candidate,
            baseline_lockfile="baseline",
            target_lockfile="target",
            observed_at=NOW,
        )

        assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
        assert f"{phase} npm lockfile must resolve exactly" in resolution.reason


def test_npm_lock_transition_refuses_incomplete_required_edges_in_both_graphs() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-required-edges", package_manager="npm",
    )

    def lock(direct_version: str, requirement: str | None = None, helper: str | None = None) -> dict:
        packages = {
            "": {"dependencies": {"lodash": "^4.17.21"}},
            "node_modules/lodash": _npm_entry("lodash", direct_version),
        }
        if requirement is not None:
            packages["node_modules/plugin"] = _npm_entry(
                "plugin", "1.0.0", dependencies={"helper": requirement}
            )
        if helper is not None:
            packages["node_modules/helper"] = _npm_entry("helper", helper)
        return {"lockfileVersion": 3, "packages": packages}

    invalid = (
        ("^1.0.0", None, "is absent"),
        ("^1.0.0", "2.0.0", "does not satisfy"),
        ("latest", "1.0.0", "unsupported range"),
    )
    for phase in ("baseline", "target"):
        for requirement, helper, reason in invalid:
            baseline = lock("4.17.21")
            target = lock("4.17.22")
            selected = baseline if phase == "baseline" else target
            selected.update(lock(
                "4.17.21" if phase == "baseline" else "4.17.22",
                requirement,
                helper,
            ))

            resolution = resolve_npm_lock_transition(
                candidate,
                baseline_lockfile=json.dumps(baseline),
                target_lockfile=json.dumps(target),
                observed_at=NOW,
            )

            assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
            assert reason in resolution.reason


def test_npm_lock_transition_refuses_missing_root_dev_dependency_in_both_graphs() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-root-dev-edge", package_manager="npm",
    )

    def lock(direct_version: str, *, include_helper: bool) -> dict:
        packages = {
            "": {
                "dependencies": {"lodash": "^4.17.21"},
                "devDependencies": {"helper": "^1.0.0"},
            },
            "node_modules/lodash": _npm_entry("lodash", direct_version),
        }
        if include_helper:
            packages["node_modules/helper"] = _npm_entry("helper", "1.0.0")
        return {"lockfileVersion": 3, "packages": packages}

    for phase in ("baseline", "target"):
        baseline = lock("4.17.21", include_helper=phase != "baseline")
        target = lock("4.17.22", include_helper=phase != "target")

        resolution = resolve_npm_lock_transition(
            candidate,
            baseline_lockfile=json.dumps(baseline),
            target_lockfile=json.dumps(target),
            observed_at=NOW,
        )

        assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
        assert "<root> -> helper is absent" in resolution.reason


def test_npm_lock_transition_validates_present_nested_optional_edges_in_both_graphs() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-optional-edges", package_manager="npm",
    )

    def lock(direct_version: str) -> dict:
        return {
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"lodash": "^4.17.21"}},
                "node_modules/lodash": _npm_entry(
                    "lodash",
                    direct_version,
                    optionalDependencies={"helper": "^1.0.0"},
                ),
                "node_modules/helper": _npm_entry("helper", "1.0.0"),
            },
        }

    for phase in ("baseline", "target"):
        for mutation, expected in (
            ([], "dependency metadata is malformed"),
            ({"helper": "^2.0.0"}, "optional dependency edge"),
        ):
            baseline = lock("4.17.21")
            target = lock("4.17.22")
            selected = baseline if phase == "baseline" else target
            selected["packages"]["node_modules/lodash"][
                "optionalDependencies"
            ] = mutation

            resolution = resolve_npm_lock_transition(
                candidate,
                baseline_lockfile=json.dumps(baseline),
                target_lockfile=json.dumps(target),
                observed_at=NOW,
            )

            assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
            assert expected in resolution.reason


def test_npm_lock_transition_allows_an_absent_nested_optional_target() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-optional-absent", package_manager="npm",
    )

    def lock(direct_version: str) -> str:
        return json.dumps({
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"lodash": "^4.17.21"}},
                "node_modules/lodash": _npm_entry(
                    "lodash",
                    direct_version,
                    optionalDependencies={"platform-helper": "^1.0.0"},
                ),
            },
        })

    resolution = resolve_npm_lock_transition(
        candidate,
        baseline_lockfile=lock("4.17.21"),
        target_lockfile=lock("4.17.22"),
        observed_at=NOW,
    )

    assert resolution.resolution is EvidenceResolution.RESOLVED


def test_npm_lock_transition_refuses_orphan_flat_entries_in_both_graphs() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-orphan", package_manager="npm",
    )

    def lock(direct_version: str) -> dict:
        return {
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"lodash": "^4.17.21"}},
                "node_modules/lodash": _npm_entry("lodash", direct_version),
            },
        }

    for phase in ("baseline", "target"):
        baseline = lock("4.17.21")
        target = lock("4.17.22")
        selected = baseline if phase == "baseline" else target
        selected["packages"]["node_modules/orphan"] = _npm_entry(
            "orphan", "1.0.0"
        )

        resolution = resolve_npm_lock_transition(
            candidate,
            baseline_lockfile=json.dumps(baseline),
            target_lockfile=json.dumps(target),
            observed_at=NOW,
        )

        assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
        assert "unreachable package entries: orphan" in resolution.reason


def test_npm_lock_transition_refuses_same_version_provenance_mutation() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-provenance-transition", package_manager="npm",
    )

    def lock(direct_version: str) -> dict:
        return {
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"lodash": "^4.17.21"}},
                "node_modules/lodash": _npm_entry(
                    "lodash",
                    direct_version,
                    dependencies={"helper": "^1.0.0"},
                ),
                "node_modules/helper": _npm_entry("helper", "1.0.0"),
            },
        }

    baseline = lock("4.17.21")
    target = lock("4.17.22")
    target["packages"]["node_modules/helper"]["integrity"] = (
        "sha512-" + base64.b64encode(b"g" * 64).decode("ascii")
    )

    resolution = resolve_npm_lock_transition(
        candidate,
        baseline_lockfile=json.dumps(baseline),
        target_lockfile=json.dumps(target),
        observed_at=NOW,
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "provenance changed for unchanged helper@1.0.0" in resolution.reason


def test_npm_lock_transition_refuses_unchanged_package_metadata_mutation() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-metadata-transition", package_manager="npm",
    )

    def lock(direct_version: str, field: str) -> dict:
        return {
            "lockfileVersion": 3,
            "packages": {
                "": {
                    "dependencies": {
                        "lodash": "^4.17.21",
                        "helper": "^1.0.0",
                        "leaf": "^1.0.0",
                    },
                },
                "node_modules/lodash": _npm_entry("lodash", direct_version),
                "node_modules/helper": _npm_entry(
                    "helper", "1.0.0", **{field: {"leaf": "^1.0.0"}}
                ),
                "node_modules/leaf": _npm_entry("leaf", "1.0.0"),
            },
        }

    for field in ("dependencies", "optionalDependencies", "peerDependencies"):
        for mutation in ({}, {"leaf": ">=1.0.0 <2.0.0"}):
            baseline = lock("4.17.21", field)
            target = lock("4.17.22", field)
            target["packages"]["node_modules/helper"][field] = mutation

            resolution = resolve_npm_lock_transition(
                candidate,
                baseline_lockfile=json.dumps(baseline),
                target_lockfile=json.dumps(target),
                observed_at=NOW,
            )

            assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
            assert (
                "metadata or provenance changed for unchanged helper@1.0.0"
                in resolution.reason
            )


def test_npm_lock_transition_custodies_candidate_and_other_root_directs() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-root-transition", package_manager="npm",
    )

    def lock(
        direct_version: str,
        *,
        helper_kind: str | None = None,
        helper_specifier: str = "^1.0.0",
        helper_version: str = "1.0.0",
    ) -> dict:
        root = {"dependencies": {"lodash": "^4.17.21"}}
        packages = {
            "": root,
            "node_modules/lodash": _npm_entry("lodash", direct_version),
        }
        if helper_kind is not None:
            root.setdefault(helper_kind, {})["helper"] = helper_specifier
            packages["node_modules/helper"] = _npm_entry(
                "helper", helper_version
            )
        return {"lockfileVersion": 3, "packages": packages}

    baseline = lock("4.17.21")
    target = lock("4.17.22")
    target["packages"][""]["devDependencies"] = {
        "lodash": target["packages"][""]["dependencies"].pop("lodash")
    }
    kind_moved = resolve_npm_lock_transition(
        candidate,
        baseline_lockfile=json.dumps(baseline),
        target_lockfile=json.dumps(target),
        observed_at=NOW,
    )
    assert kind_moved.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "dependency kind does not match lodash" in kind_moved.reason

    cases = (
        (lock("4.17.21"), lock("4.17.22", helper_kind="dependencies")),
        (lock("4.17.21", helper_kind="dependencies"), lock("4.17.22")),
        (
            lock("4.17.21", helper_kind="dependencies"),
            lock(
                "4.17.22",
                helper_kind="dependencies",
                helper_version="1.1.0",
            ),
        ),
        (
            lock("4.17.21", helper_kind="dependencies"),
            lock(
                "4.17.22",
                helper_kind="dependencies",
                helper_specifier=">=1.0.0 <2.0.0",
            ),
        ),
        (
            lock("4.17.21", helper_kind="dependencies"),
            lock("4.17.22", helper_kind="devDependencies"),
        ),
    )
    for baseline, target in cases:
        resolution = resolve_npm_lock_transition(
            candidate,
            baseline_lockfile=json.dumps(baseline),
            target_lockfile=json.dumps(target),
            observed_at=NOW,
        )

        assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
        assert "outside the candidate: helper" in resolution.reason


def test_npm_lock_transition_refuses_non_registry_or_missing_integrity_provenance() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40, fingerprint="sha256:npm-provenance",
        package_manager="npm",
    )
    baseline = json.dumps({
        "lockfileVersion": 3,
        "packages": {"": {"dependencies": {"lodash": "^4.17.21"}}, "node_modules/lodash": _npm_entry("lodash", "4.17.21")},
    })
    target = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21"}},
            "node_modules/lodash": {"version": "4.17.22", "resolved": "https://mirror.invalid/lodash.tgz"},
        },
    })

    resolution = resolve_npm_lock_transition(
        candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW
    )

    assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
    assert "registry.npmjs.org package/version with a 64-byte sha512 integrity" in resolution.reason


def test_npm_lock_transition_binds_canonical_scoped_and_unscoped_tarball_urls() -> None:
    for package in ("lodash", "@acme/widget"):
        candidate = DependencyCandidate(
            package=package, dependency_kind="dependencies", specifier="^1.2.3",
            current_version="1.2.3", target_version="1.2.4", manifest_path="package.json",
            lockfile_path="package-lock.json", baseline_sha="a" * 40,
            fingerprint=f"sha256:{package}", package_manager="npm",
        )
        baseline = json.dumps({
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {package: "^1.2.3"}},
                f"node_modules/{package}": _npm_entry(package, "1.2.3"),
            },
        })
        target = json.dumps({
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {package: "^1.2.3"}},
                f"node_modules/{package}": _npm_entry(package, "1.2.4"),
            },
        })

        resolution = resolve_npm_lock_transition(
            candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW
        )

        assert resolution.resolution is EvidenceResolution.RESOLVED


def test_npm_lock_transition_refuses_wrong_tarball_identity_and_non_sha512_length() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-strict-provenance", package_manager="npm",
    )
    baseline = json.dumps({
        "lockfileVersion": 3,
        "packages": {"": {"dependencies": {"lodash": "^4.17.21"}}, "node_modules/lodash": _npm_entry("lodash", "4.17.21")},
    })
    invalid_entries = (
        _npm_entry(
            "lodash", "4.17.22",
            resolved="https://registry.npmjs.org/lodash/-/lodash-9.9.9.tgz",
        ),
        _npm_entry(
            "lodash", "4.17.22",
            integrity="sha512-" + base64.b64encode(b"f" * 63).decode("ascii"),
        ),
    )
    for entry in invalid_entries:
        target = json.dumps({
            "lockfileVersion": 3,
            "packages": {"": {"dependencies": {"lodash": "^4.17.21"}}, "node_modules/lodash": entry},
        })
        resolution = resolve_npm_lock_transition(
            candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW
        )
        assert resolution.resolution is EvidenceResolution.NOT_VERIFIABLE
        assert "exact registry.npmjs.org package/version" in resolution.reason


def test_npm_lock_transition_reports_target_peer_conflicts() -> None:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40, fingerprint="sha256:npm-peer",
        package_manager="npm",
    )
    baseline = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21", "plugin": "^1.0.0"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.21"),
            "node_modules/plugin": _npm_entry(
                "plugin", "1.0.0", peerDependencies={"lodash": "^5.0.0"}
            ),
        },
    })
    target = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21", "plugin": "^1.0.0"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.22"),
            "node_modules/plugin": _npm_entry("plugin", "1.0.0", peerDependencies={"lodash": "^5.0.0"}),
        },
    })

    resolution = resolve_npm_lock_transition(
        candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW
    )

    assert resolution.resolution is EvidenceResolution.RESOLVED
    assert len(resolution.peer_conflicts) == 1
    assert resolution.peer_conflicts[0].package == "plugin"


def _npm_peer_resolution(requirement: str, resolved_version: str) -> LockResolution:
    candidate = DependencyCandidate(
        package="lodash", dependency_kind="dependencies", specifier="^4.17.21",
        current_version="4.17.21", target_version="4.17.22", manifest_path="package.json",
        lockfile_path="package-lock.json", baseline_sha="a" * 40,
        fingerprint="sha256:npm-peer-range", package_manager="npm",
    )
    baseline = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21", "plugin": "^1.0.0"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.21"),
            "node_modules/peer-lib": _npm_entry("peer-lib", resolved_version),
            "node_modules/plugin": _npm_entry(
                "plugin", "1.0.0", peerDependencies={"peer-lib": requirement}
            ),
        },
    })
    target = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21", "plugin": "^1.0.0"}},
            "node_modules/lodash": _npm_entry("lodash", "4.17.22"),
            "node_modules/peer-lib": _npm_entry("peer-lib", resolved_version),
            "node_modules/plugin": _npm_entry("plugin", "1.0.0", peerDependencies={"peer-lib": requirement}),
        },
    })
    return resolve_npm_lock_transition(
        candidate, baseline_lockfile=baseline, target_lockfile=target, observed_at=NOW
    )


def test_npm_peer_caret_uses_zero_major_semantics() -> None:
    compatible = _npm_peer_resolution("^0.2.3", "0.2.9")
    incompatible = _npm_peer_resolution("^0.2.3", "0.9.0")

    assert compatible.peer_conflicts == ()
    assert len(incompatible.peer_conflicts) == 1
    assert incompatible.peer_conflicts[0].resolved == "0.9.0"


def test_npm_peer_tags_and_unknown_syntax_fail_closed() -> None:
    for requirement in ("latest", "release-channel", "workspace:*"):
        resolution = _npm_peer_resolution(requirement, "1.2.3")

        assert len(resolution.peer_conflicts) == 1
        assert "peer range is unsupported" in resolution.peer_conflicts[0].detail


def test_npm_peer_prerelease_requires_matching_identity() -> None:
    exact = _npm_peer_resolution("1.2.3-beta.1", "1.2.3-beta.1")
    different = _npm_peer_resolution("1.2.3-beta.1", "1.2.3-beta.2")
    stable_range = _npm_peer_resolution(">=1.2.3 <2.0.0", "1.3.0-beta.1")

    assert exact.peer_conflicts == ()
    assert len(different.peer_conflicts) == 1
    assert len(stable_range.peer_conflicts) == 1


def test_npm_peer_comparator_ranges_match_only_inside_the_range() -> None:
    compatible = _npm_peer_resolution(">=1.2.3 <2.0.0", "1.9.9")
    incompatible = _npm_peer_resolution(">=1.2.3 <2.0.0", "2.0.0")

    assert compatible.peer_conflicts == ()
    assert len(incompatible.peer_conflicts) == 1


def test_high_and_critical_new_advisories_block_even_with_explicit_waiver() -> None:
    for severity in ("high", "critical"):
        source = _source(f"GHSA-{severity}")
        advisory = SecurityEvidence(
            EvidenceResolution.RESOLVED,
            advisories=(
                SecurityAdvisory(
                    f"GHSA-{severity}",
                    "lodash",
                    severity,
                    True,
                    source,
                ),
            ),
            sources=(source,),
            observed_at=NOW,
        )
        evidence = collect_dependency_evidence(
            _candidate(),
            release=_Provider(_resolved_release()),
            usage=_Provider(_usage()),
            lock=_Provider(_resolved_lock()),
            security=_Provider(advisory),
            waiver=EvidenceWaiver("waiver-1", "user-1", "reviewed", NOW, ("release",)),
            observed_at=NOW,
        )
        assert evidence.decision.status is DependencyDecisionStatus.BLOCKED
        assert any(f"{severity} security advisory" in reason for reason in evidence.decision.blocking_reasons)


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


def test_collect_and_write_dependency_evidence_persists_the_gate_artifact(tmp_path: Path) -> None:
    metadata = tmp_path / "run.json"
    metadata.write_text("{}\n")
    artifact = tmp_path / "dependency_evidence.json"

    evidence = collect_and_write_dependency_evidence(
        artifact,
        _candidate(),
        release=_Provider(_resolved_release()),
        usage=_Provider(_usage()),
        lock=_Provider(_resolved_lock()),
        security=_Provider(_resolved_security()),
        waiver=EvidenceWaiver("waiver-4", "human-7", "manual signoff", NOW, ("release",)),
        observed_at=NOW,
        metadata_path=metadata,
    )

    stored = json.loads(artifact.read_text())
    run = json.loads(metadata.read_text())
    assert evidence.decision.waiver is not None
    assert stored["decision"]["waiver"]["id"] == "waiver-4"
    assert run["dependencyEvidence"]["decision"]["waiver"]["id"] == "waiver-4"
    assert run["dependencyEvidenceFile"] == str(artifact)


def test_missing_dependency_artifact_loads_as_an_explicit_invalid_payload(tmp_path: Path) -> None:
    payload = load_dependency_evidence_for_gate(tmp_path)
    assert payload["invalid"] == "dependency evidence file is missing"
