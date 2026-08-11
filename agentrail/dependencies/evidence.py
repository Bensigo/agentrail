"""Fail-closed evidence for dependency upgrade proposals.

The dependency detector deliberately stops at a candidate.  This module is the
next stage: it records the evidence needed to decide whether that candidate is
ready for the policy-controlled proposal and approval boundary. Evidence never
grants managed execution capability; in particular, npm remains
observation/proposal-only and its managed execution path refuses.

The providers are injected on purpose.  Release-note, code-graph, lockfile and
advisory retrieval can use GitHub, a local index, pnpm, or a test fixture, but
the decision contract never performs I/O and never treats a model summary as
source evidence.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Protocol, Sequence, Tuple
from urllib.parse import urlsplit

from agentrail.dependencies.cargo import cargo_constraint_matches, parse_cargo_lockfile
from agentrail.dependencies.manager import ADAPTER_PROFILE_IDS, CARGO_ADAPTER_PROFILE, NPM_DEPENDENCY_KINDS
from agentrail.dependencies.npm_semver import npm_constraint_matches
from agentrail.dependencies.pnpm import (
    DependencyCandidate,
    DependencySnapshot,
    adapter_identity_fingerprint,
)
from agentrail.dependencies.strict_json import loads_strict_json
from agentrail.shared.json import read_json, write_json


_NPM_PACKAGE = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")


class EvidenceState(str, Enum):
    PROVEN = "proven"
    NOT_FOUND = "not_found"
    UNKNOWN = "unknown"


class EvidenceResolution(str, Enum):
    RESOLVED = "resolved"
    UNKNOWN = "unknown"
    NOT_VERIFIABLE = "not_verifiable"


class DependencyDecisionStatus(str, Enum):
    READY = "ready"
    BLOCKED = "blocked"


_SECURITY_SEVERITIES = frozenset({"low", "moderate", "medium", "high", "critical"})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _as_tuple(values: Iterable[object]) -> Tuple[str, ...]:
    return tuple(str(value) for value in values if str(value).strip())


@dataclass(frozen=True)
class CandidateIdentity:
    fingerprint: str
    package: str
    current_version: str
    target_version: str
    baseline_sha: str
    ecosystem: str = ""
    package_manager: str = ""
    adapter_profile: Optional[str] = None
    adapter_identity_fingerprint: Optional[str] = None

    @classmethod
    def from_candidate(cls, candidate: DependencyCandidate) -> "CandidateIdentity":
        return cls(
            fingerprint=candidate.fingerprint,
            package=candidate.package,
            current_version=candidate.current_version,
            target_version=candidate.target_version,
            baseline_sha=candidate.baseline_sha,
            ecosystem=getattr(candidate, "ecosystem", ""),
            package_manager=getattr(candidate, "package_manager", ""),
            adapter_profile=getattr(candidate, "adapter_profile", None),
            adapter_identity_fingerprint=getattr(
                candidate, "adapter_identity_fingerprint", None
            ),
        )

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "fingerprint": self.fingerprint,
            "package": self.package,
            "currentVersion": self.current_version,
            "targetVersion": self.target_version,
            "baselineSha": self.baseline_sha,
            "ecosystem": self.ecosystem,
            "packageManager": self.package_manager,
            "adapterProfile": self.adapter_profile,
            "adapterIdentityFingerprint": self.adapter_identity_fingerprint,
        }


@dataclass(frozen=True)
class EvidenceSource:
    identifier: str
    url: Optional[str]
    observed_at: str
    kind: str

    def valid(self) -> bool:
        if (
            not isinstance(self.identifier, str)
            or (self.url is not None and not isinstance(self.url, str))
            or not isinstance(self.observed_at, str)
            or not isinstance(self.kind, str)
        ):
            return False
        return (
            bool(self.identifier.strip() or (self.url and self.url.strip()))
            and bool(self.observed_at.strip())
            and bool(self.kind.strip())
        )

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "identifier": self.identifier,
            "url": self.url,
            "observedAt": self.observed_at,
            "kind": self.kind,
        }


def _serialized_evidence_source_valid(source: Any) -> bool:
    """Validate the serialized form without coercing attacker-controlled types."""

    if not isinstance(source, Mapping):
        return False
    identifier = source.get("identifier")
    url = source.get("url")
    observed_at = source.get("observedAt")
    kind = source.get("kind")
    if (
        not isinstance(identifier, str)
        or (url is not None and not isinstance(url, str))
        or not isinstance(observed_at, str)
        or not isinstance(kind, str)
    ):
        return False
    return (
        bool(identifier.strip() or (url and url.strip()))
        and bool(observed_at.strip())
        and bool(kind.strip())
    )


@dataclass(frozen=True)
class ReleaseEvidence:
    resolution: EvidenceResolution
    version: str
    sources: Tuple[EvidenceSource, ...] = ()
    observed_at: str = ""
    canonical: bool = False
    summary: Optional[str] = None
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "resolution": self.resolution.value,
            "version": self.version,
            "sources": [source.to_dict() for source in self.sources],
            "observedAt": self.observed_at,
            "canonical": self.canonical,
            "summary": self.summary,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class UsageFinding:
    status: EvidenceState
    paths: Tuple[str, ...] = ()
    source_ids: Tuple[str, ...] = ()
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "paths": list(self.paths),
            "sourceIds": list(self.source_ids),
            "detail": self.detail,
        }


@dataclass(frozen=True)
class UsageEvidence:
    direct_imports: UsageFinding
    config_references: UsageFinding
    peer_usage: UsageFinding
    workspace_usage: UsageFinding
    observed_at: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "directImports": self.direct_imports.to_dict(),
            "configReferences": self.config_references.to_dict(),
            "peerUsage": self.peer_usage.to_dict(),
            "workspaceUsage": self.workspace_usage.to_dict(),
            "observedAt": self.observed_at,
        }


@dataclass(frozen=True)
class DependencyChange:
    package: str
    from_versions: Tuple[str, ...]
    to_versions: Tuple[str, ...]
    scope: str  # direct | transitive

    def to_dict(self) -> Dict[str, Any]:
        return {
            "package": self.package,
            "fromVersions": list(self.from_versions),
            "toVersions": list(self.to_versions),
            "scope": self.scope,
        }


@dataclass(frozen=True)
class PeerConflict:
    package: str
    peer: str
    required: str
    resolved: Optional[str]
    detail: str

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "package": self.package,
            "peer": self.peer,
            "required": self.required,
            "resolved": self.resolved,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class LockResolution:
    resolution: EvidenceResolution
    direct_changes: Tuple[DependencyChange, ...] = ()
    transitive_changes: Tuple[DependencyChange, ...] = ()
    peer_conflicts: Tuple[PeerConflict, ...] = ()
    observed_at: str = ""
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "resolution": self.resolution.value,
            "directChanges": [change.to_dict() for change in self.direct_changes],
            "transitiveChanges": [change.to_dict() for change in self.transitive_changes],
            "peerConflicts": [conflict.to_dict() for conflict in self.peer_conflicts],
            "observedAt": self.observed_at,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class SecurityAdvisory:
    advisory_id: str
    package: str
    severity: str
    introduced: Optional[bool]
    source: EvidenceSource
    summary: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.advisory_id,
            "package": self.package,
            "severity": self.severity,
            "introduced": self.introduced,
            "source": self.source.to_dict(),
            "summary": self.summary,
        }


@dataclass(frozen=True)
class SecurityEvidence:
    resolution: EvidenceResolution
    advisories: Tuple[SecurityAdvisory, ...] = ()
    sources: Tuple[EvidenceSource, ...] = ()
    observed_at: str = ""
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "resolution": self.resolution.value,
            "advisories": [advisory.to_dict() for advisory in self.advisories],
            "sources": [source.to_dict() for source in self.sources],
            "observedAt": self.observed_at,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class EvidenceWaiver:
    waiver_id: str
    actor: str
    reason: str
    approved_at: str
    scope: Tuple[str, ...]

    def valid(self) -> bool:
        return all(
            value.strip() for value in (self.waiver_id, self.actor, self.reason, self.approved_at)
        ) and bool(self.scope)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.waiver_id,
            "actor": self.actor,
            "reason": self.reason,
            "approvedAt": self.approved_at,
            "scope": list(self.scope),
        }


@dataclass(frozen=True)
class DependencyEvidenceDecision:
    status: DependencyDecisionStatus
    blocking_reasons: Tuple[str, ...] = ()
    waived_reasons: Tuple[str, ...] = ()
    waiver: Optional[EvidenceWaiver] = None

    @property
    def proof_complete(self) -> bool:
        return self.status is DependencyDecisionStatus.READY

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "proofComplete": self.proof_complete,
            "blockingReasons": list(self.blocking_reasons),
            "waivedReasons": list(self.waived_reasons),
            "waiver": self.waiver.to_dict() if self.waiver else None,
        }


@dataclass(frozen=True)
class DependencyEvidence:
    candidate: CandidateIdentity
    collected_at: str
    release: ReleaseEvidence
    usage: UsageEvidence
    lock: LockResolution
    security: SecurityEvidence
    decision: DependencyEvidenceDecision

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": "dependency-upgrade-evidence",
            "schemaVersion": 2,
            "candidate": self.candidate.to_dict(),
            "candidateFingerprint": self.candidate.fingerprint,
            "adapterProfile": self.candidate.adapter_profile,
            "adapterIdentityFingerprint": self.candidate.adapter_identity_fingerprint,
            "collectedAt": self.collected_at,
            "release": self.release.to_dict(),
            "usage": self.usage.to_dict(),
            "lock": self.lock.to_dict(),
            "security": self.security.to_dict(),
            "decision": self.decision.to_dict(),
        }


class ReleaseEvidenceProvider(Protocol):
    def resolve(self, candidate: CandidateIdentity) -> ReleaseEvidence: ...


class UsageEvidenceProvider(Protocol):
    def inspect(self, candidate: CandidateIdentity) -> UsageEvidence: ...


class LockResolutionProvider(Protocol):
    def resolve(self, candidate: CandidateIdentity) -> LockResolution: ...


class SecurityEvidenceProvider(Protocol):
    def inspect(self, candidate: CandidateIdentity) -> SecurityEvidence: ...


def _failure_release(reason: str, observed_at: str) -> ReleaseEvidence:
    return ReleaseEvidence(
        EvidenceResolution.NOT_VERIFIABLE,
        "",
        observed_at=observed_at,
        reason=f"release evidence is not_verifiable: {reason}",
    )


def _failure_usage(reason: str, observed_at: str) -> UsageEvidence:
    finding = UsageFinding(EvidenceState.UNKNOWN, detail=f"usage evidence is not_verifiable: {reason}")
    return UsageEvidence(finding, finding, finding, finding, observed_at)


def _failure_lock(reason: str, observed_at: str) -> LockResolution:
    return LockResolution(
        EvidenceResolution.NOT_VERIFIABLE,
        observed_at=observed_at,
        reason=f"target lock resolution is not_verifiable: {reason}",
    )


def _failure_security(reason: str, observed_at: str) -> SecurityEvidence:
    return SecurityEvidence(
        EvidenceResolution.NOT_VERIFIABLE,
        observed_at=observed_at,
        reason=f"security advisory data is not_verifiable: {reason}",
    )


def collect_dependency_evidence(
    candidate: DependencyCandidate | CandidateIdentity,
    *,
    release: ReleaseEvidenceProvider,
    usage: UsageEvidenceProvider,
    lock: LockResolutionProvider,
    security: SecurityEvidenceProvider,
    waiver: Optional[EvidenceWaiver] = None,
    observed_at: Optional[str] = None,
) -> DependencyEvidence:
    """Collect all four evidence families and make one fail-closed decision."""
    identity = candidate if isinstance(candidate, CandidateIdentity) else CandidateIdentity.from_candidate(candidate)
    timestamp = observed_at or _now_iso()
    try:
        release_evidence = release.resolve(identity)
    except Exception as exc:  # provider failures are evidence failures, never passes
        release_evidence = _failure_release(f"provider failure: {type(exc).__name__}", timestamp)
    if not isinstance(release_evidence, ReleaseEvidence):
        release_evidence = _failure_release("release provider returned malformed evidence", timestamp)
    try:
        usage_evidence = usage.inspect(identity)
    except Exception as exc:
        usage_evidence = _failure_usage(f"provider failure: {type(exc).__name__}", timestamp)
    if not isinstance(usage_evidence, UsageEvidence) or not all(
        isinstance(finding, UsageFinding)
        for finding in (
            getattr(usage_evidence, "direct_imports", None),
            getattr(usage_evidence, "config_references", None),
            getattr(usage_evidence, "peer_usage", None),
            getattr(usage_evidence, "workspace_usage", None),
        )
    ):
        usage_evidence = _failure_usage("usage provider returned malformed evidence", timestamp)
    try:
        lock_evidence = lock.resolve(identity)
    except Exception as exc:
        lock_evidence = _failure_lock(f"provider failure: {type(exc).__name__}", timestamp)
    if not isinstance(lock_evidence, LockResolution):
        lock_evidence = _failure_lock("lock provider returned malformed evidence", timestamp)
    try:
        security_evidence = security.inspect(identity)
    except Exception as exc:
        security_evidence = _failure_security(f"provider failure: {type(exc).__name__}", timestamp)
    if not isinstance(security_evidence, SecurityEvidence):
        security_evidence = _failure_security("security provider returned malformed evidence", timestamp)

    evidence = DependencyEvidence(
        candidate=identity,
        collected_at=timestamp,
        release=release_evidence,
        usage=usage_evidence,
        lock=lock_evidence,
        security=security_evidence,
        decision=DependencyEvidenceDecision(DependencyDecisionStatus.BLOCKED),
    )
    return DependencyEvidence(
        candidate=evidence.candidate,
        collected_at=evidence.collected_at,
        release=evidence.release,
        usage=evidence.usage,
        lock=evidence.lock,
        security=evidence.security,
        decision=evaluate_dependency_evidence(evidence, waiver=waiver),
    )


def evaluate_dependency_evidence(
    evidence: DependencyEvidence,
    *,
    waiver: Optional[EvidenceWaiver] = None,
) -> DependencyEvidenceDecision:
    """Return the only decision allowed to feed the Objective Gate.

    A waiver is never inferred.  It must be a complete, explicit record and it
    can cover only ``unknown:<family>`` findings.  ``not_verifiable`` data,
    peer conflicts, and newly introduced high/critical advisories always block;
    a human cannot turn unavailable security data into proof.
    """
    reasons: list[str] = []
    waived: list[str] = []
    valid_waiver = waiver if waiver and waiver.valid() else None

    def maybe_block(key: str, reason: str, *, waivable: bool = False) -> None:
        if waivable and valid_waiver and key in valid_waiver.scope:
            waived.append(reason)
        else:
            reasons.append(reason)

    if not evidence.candidate.fingerprint.strip():
        reasons.append("candidate fingerprint is missing")
    if evidence.candidate.current_version == evidence.candidate.target_version:
        reasons.append("candidate dependency transition is a no-op")
    expected_profile = ADAPTER_PROFILE_IDS.get(
        (evidence.candidate.ecosystem, evidence.candidate.package_manager)
    )
    if expected_profile is None:
        reasons.append("candidate adapter capability is unavailable")
    elif evidence.candidate.adapter_profile != expected_profile:
        reasons.append("candidate adapter profile is missing or mismatched")
    else:
        try:
            expected_adapter_fingerprint = adapter_identity_fingerprint(
                candidate_fingerprint=evidence.candidate.fingerprint,
                ecosystem=evidence.candidate.ecosystem,
                package_manager=evidence.candidate.package_manager,
                adapter_profile=expected_profile,
            )
        except ValueError:
            expected_adapter_fingerprint = None
        if (
            expected_adapter_fingerprint is None
            or evidence.candidate.adapter_identity_fingerprint
            != expected_adapter_fingerprint
        ):
            reasons.append("candidate adapter identity fingerprint is missing or mismatched")

    if evidence.release.resolution is not EvidenceResolution.RESOLVED:
        reason = evidence.release.reason or f"release evidence is {evidence.release.resolution.value}"
        maybe_block("release", reason, waivable=evidence.release.resolution is EvidenceResolution.UNKNOWN)
    if evidence.release.resolution is EvidenceResolution.RESOLVED:
        release_sources_valid = (
            isinstance(evidence.release.sources, tuple)
            and bool(evidence.release.sources)
            and all(
                isinstance(source, EvidenceSource) and source.valid()
                for source in evidence.release.sources
            )
        )
        if evidence.release.canonical is not True or not release_sources_valid:
            reasons.append("release evidence has no valid canonical source and timestamp")
        if evidence.release.version != evidence.candidate.target_version:
            reasons.append("release evidence target does not match the candidate")

    for name, finding in (
        ("direct imports", evidence.usage.direct_imports),
        ("config references", evidence.usage.config_references),
        ("peer usage", evidence.usage.peer_usage),
        ("workspace usage", evidence.usage.workspace_usage),
    ):
        if finding.status is EvidenceState.UNKNOWN:
            detail = f": {finding.detail}" if finding.detail else ""
            maybe_block(
                f"usage:{name}",
                f"{name} usage evidence is not_verifiable{detail}",
                waivable=True,
            )

    if evidence.lock.resolution is not EvidenceResolution.RESOLVED:
        reasons.append(evidence.lock.reason or f"target lock resolution is {evidence.lock.resolution.value}")
    elif evidence.lock.direct_changes != (
        DependencyChange(
            evidence.candidate.package,
            (evidence.candidate.current_version,),
            (evidence.candidate.target_version,),
            "direct",
        ),
    ):
        reasons.append("target lock direct change does not exactly match the candidate")
    if evidence.lock.resolution is EvidenceResolution.RESOLVED:
        transitive_packages: set[str] = set()
        transitive_valid = isinstance(evidence.lock.transitive_changes, tuple)
        if transitive_valid:
            for change in evidence.lock.transitive_changes:
                if (
                    not isinstance(change, DependencyChange)
                    or not isinstance(change.package, str)
                    or not change.package.strip()
                    or not isinstance(change.from_versions, tuple)
                    or not isinstance(change.to_versions, tuple)
                    or any(
                        not isinstance(version, str) or not version.strip()
                        for version in (*change.from_versions, *change.to_versions)
                    )
                    or (not change.from_versions and not change.to_versions)
                    or set(change.from_versions) == set(change.to_versions)
                    or len(set(change.from_versions)) != len(change.from_versions)
                    or len(set(change.to_versions)) != len(change.to_versions)
                    or change.scope != "transitive"
                    or change.package == evidence.candidate.package
                    or change.package in transitive_packages
                ):
                    transitive_valid = False
                    break
                transitive_packages.add(change.package)
        if not transitive_valid:
            reasons.append("target lock transitive changes are malformed")
    if evidence.lock.peer_conflicts:
        reasons.extend(
            f"peer conflict: {conflict.package} requires {conflict.peer} {conflict.required}, "
            f"resolved {conflict.resolved or 'missing'}"
            for conflict in evidence.lock.peer_conflicts
        )

    if evidence.security.resolution is not EvidenceResolution.RESOLVED:
        reasons.append(evidence.security.reason or f"security advisory data is {evidence.security.resolution.value}")
    else:
        sources_valid = (
            isinstance(evidence.security.sources, tuple)
            and bool(evidence.security.sources)
            and all(
                isinstance(source, EvidenceSource) and source.valid()
                for source in evidence.security.sources
            )
        )
        if not sources_valid:
            reasons.append("security advisory source is missing or invalid")
        allowed_advisory_packages = {evidence.candidate.package}
        if transitive_valid:
            allowed_advisory_packages.update(transitive_packages)
        if not isinstance(evidence.security.advisories, tuple):
            reasons.append("security advisory data is malformed")
        else:
            for advisory in evidence.security.advisories:
                valid_advisory = (
                    isinstance(advisory, SecurityAdvisory)
                    and isinstance(advisory.advisory_id, str)
                    and bool(advisory.advisory_id.strip())
                    and isinstance(advisory.package, str)
                    and bool(advisory.package.strip())
                    and advisory.package in allowed_advisory_packages
                    and isinstance(advisory.severity, str)
                    and advisory.severity in _SECURITY_SEVERITIES
                    and isinstance(advisory.introduced, bool)
                    and isinstance(advisory.source, EvidenceSource)
                    and advisory.source.valid()
                    and advisory.source in evidence.security.sources
                )
                if not valid_advisory:
                    reasons.append("security advisory data is malformed or not candidate-bound")
                    continue
                if advisory.introduced and advisory.severity in {"high", "critical"}:
                    reasons.append(
                        f"new {advisory.severity} security advisory {advisory.advisory_id} affects {advisory.package}"
                    )

    if waiver and not valid_waiver:
        reasons.append("explicit evidence waiver is malformed")

    return DependencyEvidenceDecision(
        status=DependencyDecisionStatus.READY if not reasons else DependencyDecisionStatus.BLOCKED,
        blocking_reasons=tuple(dict.fromkeys(reasons)),
        waived_reasons=tuple(dict.fromkeys(waived)),
        waiver=valid_waiver,
    )


_IMPORT_RE = re.compile(
    r"(?:from\s+|import\s+|require\s*\(\s*|#include\s*[<\"])[\"']([^\"']+)[\"']",
    re.MULTILINE,
)


def _matches_package(specifier: str, package: str) -> bool:
    return specifier == package or specifier.startswith(package + "/")


def _is_source_path(path: str) -> bool:
    return Path(path).suffix.lower() in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".php", ".cs", ".cpp", ".c", ".h"}


def _is_config_path(path: str) -> bool:
    name = Path(path).name.lower()
    return (
        "config" in name
        or name in {"tsconfig.json", "jsconfig.json", ".npmrc", ".nvmrc"}
        or Path(path).suffix.lower() in {".yaml", ".yml", ".toml"}
    )


def _package_manifests(files: Mapping[str, str]) -> Tuple[list[Tuple[str, Mapping[str, Any]]], Optional[str]]:
    manifests: list[Tuple[str, Mapping[str, Any]]] = []
    for path, text in files.items():
        if Path(path).name != "package.json":
            continue
        if not isinstance(text, str):
            return [], f"{path} is not text"
        try:
            parsed = loads_strict_json(text, document=path)
        except (TypeError, ValueError) as exc:
            return [], f"{path} is malformed: {exc}"
        if not isinstance(parsed, dict):
            return [], f"{path} must contain an object"
        manifests.append((path, parsed))
    return manifests, None


def scan_usage_evidence(
    snapshot: DependencySnapshot,
    package: str,
    *,
    context_complete: bool = False,
    code_graph: Optional[Mapping[str, Any]] = None,
    observed_at: Optional[str] = None,
) -> UsageEvidence:
    """Inspect deterministic source/config/manifests and optional graph edges.

    Missing files are ``unknown`` unless the caller explicitly says the context
    inventory is complete.  This prevents a small metadata-only pack from being
    mistaken for proof that a package has no callers.
    """
    timestamp = observed_at or _now_iso()
    files = {str(path).replace("\\", "/"): text for path, text in snapshot.files.items()}
    manifests, manifest_error = _package_manifests(files)
    if manifest_error:
        unknown = UsageFinding(EvidenceState.UNKNOWN, detail=manifest_error)
        return UsageEvidence(unknown, unknown, unknown, unknown, timestamp)

    direct_paths: set[str] = set()
    graph_source_ids: set[str] = set()
    graph_seen = False
    if code_graph is not None:
        edges = code_graph.get("edges")
        if not isinstance(edges, list):
            unknown = UsageFinding(EvidenceState.UNKNOWN, detail="code graph edges are unavailable")
            return UsageEvidence(unknown, unknown, unknown, unknown, timestamp)
        for edge in edges:
            if not isinstance(edge, Mapping):
                return UsageEvidence(
                    UsageFinding(EvidenceState.UNKNOWN, detail="code graph contains malformed edge data"),
                    UsageFinding(EvidenceState.UNKNOWN, detail="code graph contains malformed edge data"),
                    UsageFinding(EvidenceState.UNKNOWN, detail="code graph contains malformed edge data"),
                    UsageFinding(EvidenceState.UNKNOWN, detail="code graph contains malformed edge data"),
                    timestamp,
                )
            specifier = str(edge.get("importSpecifier") or edge.get("specifier") or "")
            if specifier and _matches_package(specifier, package):
                graph_seen = True
                if edge.get("deterministic", True) is not True:
                    return UsageEvidence(
                        UsageFinding(EvidenceState.UNKNOWN, detail="package import came from non-deterministic graph enrichment"),
                        UsageFinding(EvidenceState.UNKNOWN, detail="package import came from non-deterministic graph enrichment"),
                        UsageFinding(EvidenceState.UNKNOWN, detail="package import came from non-deterministic graph enrichment"),
                        UsageFinding(EvidenceState.UNKNOWN, detail="package import came from non-deterministic graph enrichment"),
                        timestamp,
                    )
                direct_paths.add(str(edge.get("path") or edge.get("sourcePath") or "<graph>"))
                source_id = edge.get("sourceId")
                if source_id:
                    graph_source_ids.add(str(source_id))

    for path, text in files.items():
        if not isinstance(text, str):
            unknown = UsageFinding(EvidenceState.UNKNOWN, detail=f"{path} is not text")
            return UsageEvidence(unknown, unknown, unknown, unknown, timestamp)
        if _is_source_path(path):
            for match in _IMPORT_RE.finditer(text):
                if _matches_package(match.group(1), package):
                    direct_paths.add(path)

    source_files = [path for path in files if _is_source_path(path)]
    direct_status = EvidenceState.PROVEN if direct_paths else (EvidenceState.PROVEN if graph_seen else (EvidenceState.NOT_FOUND if context_complete else EvidenceState.UNKNOWN))
    direct = UsageFinding(direct_status, tuple(sorted(direct_paths)), tuple(sorted(graph_source_ids)), "deterministic imports and graph edges")

    config_paths = [path for path in files if _is_config_path(path)]
    config_paths_found = tuple(sorted(path for path in config_paths if package in str(files[path])))
    config = UsageFinding(
        EvidenceState.PROVEN if config_paths_found else (EvidenceState.NOT_FOUND if config_paths or context_complete else EvidenceState.UNKNOWN),
        config_paths_found,
        detail="configuration references scanned",
    )

    peer_paths: list[str] = []
    for path, manifest in manifests:
        peers = manifest.get("peerDependencies", {})
        if isinstance(peers, dict) and package in peers:
            peer_paths.append(path)
        elif peers is not None and not isinstance(peers, dict):
            unknown = UsageFinding(EvidenceState.UNKNOWN, detail=f"{path}.peerDependencies is malformed")
            return UsageEvidence(direct, config, unknown, unknown, timestamp)
    peer = UsageFinding(
        EvidenceState.PROVEN if peer_paths else EvidenceState.NOT_FOUND,
        tuple(sorted(peer_paths)),
        detail="workspace manifests inspected",
    )

    workspace_file = next((path for path in files if Path(path).name == "pnpm-workspace.yaml"), None)
    workspace_manifests = [path for path, _ in manifests if path != "package.json"]
    workspace_paths: list[str] = []
    for path, manifest in manifests:
        if path == "package.json":
            continue
        for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            values = manifest.get(section, {})
            if isinstance(values, dict) and package in values:
                workspace_paths.append(path)
            elif values is not None and not isinstance(values, dict):
                unknown = UsageFinding(EvidenceState.UNKNOWN, detail=f"{path}.{section} is malformed")
                return UsageEvidence(direct, config, peer, unknown, timestamp)
    if workspace_file and not isinstance(files[workspace_file], str):
        workspace = UsageFinding(EvidenceState.UNKNOWN, detail="pnpm workspace file is not text")
    elif workspace_paths:
        workspace = UsageFinding(EvidenceState.PROVEN, tuple(sorted(set(workspace_paths))), detail="package is used by a workspace manifest")
    elif workspace_file or workspace_manifests:
        workspace = UsageFinding(EvidenceState.NOT_FOUND, detail="workspace manifests inspected")
    else:
        workspace = UsageFinding(EvidenceState.NOT_FOUND if context_complete else EvidenceState.UNKNOWN, detail="workspace inventory is unavailable")

    # Keep the local variable intentional: a complete graph/source inventory
    # must not be silently inferred merely because one source file was present.
    _ = source_files
    return UsageEvidence(direct, config, peer, workspace, timestamp)


@dataclass(frozen=True)
class _LockedEntry:
    package: str
    version: str
    dependencies: Mapping[str, str] = field(default_factory=dict)
    peer_dependencies: Mapping[str, str] = field(default_factory=dict)
    optional_dependencies: Mapping[str, str] = field(default_factory=dict)
    resolved: Optional[str] = None
    integrity: Optional[str] = None


def _yaml_key(value: str) -> str:
    value = value.strip()
    if value.startswith(("'", '"')) and value[-1:] == value[0]:
        value = value[1:-1]
    return value.replace("''", "'")


def _yaml_scalar(value: str) -> str:
    value = value.split(" #", 1)[0].strip()
    if value.startswith(("'", '"')) and value[-1:] == value[0]:
        return value[1:-1]
    return value


def _package_from_locator(locator: str) -> Tuple[str, str]:
    clean = locator.lstrip("/").split("(", 1)[0]
    marker = clean.rfind("@")
    if marker <= 0:
        raise ValueError(f"lockfile locator has no version: {locator}")
    return clean[:marker], clean[marker + 1:]


def _parse_lock_entries(text: str) -> Dict[str, _LockedEntry]:
    if not isinstance(text, str):
        raise ValueError("pnpm lockfile is not text")
    version_match = re.search(r"^lockfileVersion:\s*['\"]?([0-9]+)", text, re.MULTILINE)
    if not version_match or int(version_match.group(1)) not in {5, 6, 9}:
        raise ValueError("unsupported or missing pnpm lockfile version")
    entries: Dict[str, Dict[str, Any]] = {}
    section: Optional[str] = None
    locator: Optional[str] = None
    nested: Optional[str] = None
    for number, line in enumerate(text.splitlines(), 1):
        if "\t" in line:
            raise ValueError(f"pnpm lockfile contains tabs at line {number}")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0 and stripped.endswith(":"):
            section = stripped[:-1]
            locator = None
            nested = None
            continue
        if section not in {"packages", "snapshots"}:
            continue
        if indent == 2 and stripped.endswith(":"):
            locator = _yaml_key(stripped[:-1])
            entries.setdefault(locator, {"dependencies": {}, "peerDependencies": {}})
            nested = None
            continue
        if indent == 4 and stripped.endswith(":") and locator:
            key = stripped[:-1]
            nested = key if key in {"dependencies", "optionalDependencies", "peerDependencies"} else None
            continue
        if indent == 6 and ":" in stripped and locator and nested:
            key, value = stripped.split(":", 1)
            entries[locator][nested][_yaml_key(key)] = _yaml_scalar(value)

    parsed: Dict[str, _LockedEntry] = {}
    for locator, data in entries.items():
        try:
            package, version = _package_from_locator(locator)
        except ValueError:
            continue
        dependencies = dict(data.get("dependencies") or {})
        peer_dependencies = dict(data.get("peerDependencies") or {})
        key = f"{package}@{version}"
        parsed[key] = _LockedEntry(package, version, dependencies, peer_dependencies)
    if not parsed and ("packages:" in text or "snapshots:" in text):
        # An empty lock is valid; the caller will decide whether the candidate
        # itself is missing. Do not invent a package from a malformed line.
        return {}
    return parsed


def _pnpm_version_parts(value: str) -> Optional[Tuple[int, int, int]]:
    match = re.fullmatch(r"(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value.strip())
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))) if match else None


def _pnpm_satisfies(version: str, requirement: str) -> bool:
    """Retain the existing pnpm peer policy; npm has a stricter profile."""

    actual = _pnpm_version_parts(version)
    if actual is None:
        return False
    requirement = requirement.strip()
    if requirement in {"*", "latest"}:
        return True
    exact = _pnpm_version_parts(requirement)
    if exact:
        return actual == exact
    match = re.fullmatch(r"([~^])?(\d+)(?:\.(\d+))?(?:\.(\d+))?", requirement)
    if not match:
        return False
    prefix, major, minor, patch = match.groups()
    base = (int(major), int(minor or 0), int(patch or 0))
    if prefix == "~":
        return actual[0:2] == base[0:2] and actual >= base
    if prefix == "^":
        return actual[0] == base[0] and actual >= base
    if minor is None:
        return actual[0] == base[0]
    if patch is None:
        return actual[0:2] == base[0:2]
    return actual == base


def _pnpm_peer_conflicts(entries: Mapping[str, _LockedEntry]) -> Tuple[PeerConflict, ...]:
    versions_by_package: Dict[str, Tuple[str, ...]] = {}
    for entry in entries.values():
        versions_by_package[entry.package] = tuple(
            sorted(set(versions_by_package.get(entry.package, ())) | {entry.version})
        )
    conflicts: list[PeerConflict] = []
    for entry in entries.values():
        for peer, requirement in entry.peer_dependencies.items():
            resolved = versions_by_package.get(peer, ())
            if not resolved:
                conflicts.append(
                    PeerConflict(
                        entry.package,
                        peer,
                        requirement,
                        None,
                        "peer package is absent from target lockfile",
                    )
                )
            elif not any(_pnpm_satisfies(version, requirement) for version in resolved):
                conflicts.append(
                    PeerConflict(
                        entry.package,
                        peer,
                        requirement,
                        ", ".join(resolved),
                        "target lockfile does not satisfy the peer range",
                    )
                )
    return tuple(conflicts)


def _npm_peer_conflicts(entries: Mapping[str, _LockedEntry]) -> Tuple[PeerConflict, ...]:
    """Evaluate every target peer through the fail-closed npm semver subset."""

    versions_by_package: Dict[str, Tuple[str, ...]] = {}
    for entry in entries.values():
        versions_by_package[entry.package] = tuple(
            sorted(set(versions_by_package.get(entry.package, ())) | {entry.version})
        )
    conflicts: list[PeerConflict] = []
    for entry in entries.values():
        for peer, requirement in entry.peer_dependencies.items():
            resolved = versions_by_package.get(peer, ())
            if not resolved:
                conflicts.append(
                    PeerConflict(
                        entry.package,
                        peer,
                        requirement,
                        None,
                        "peer package is absent from target lockfile",
                    )
                )
                continue
            evaluations = tuple(
                npm_constraint_matches(requirement, version) for version in resolved
            )
            error = next(
                (message for _, message in evaluations if message is not None), None
            )
            if error is not None:
                conflicts.append(
                    PeerConflict(
                        entry.package,
                        peer,
                        requirement,
                        ", ".join(resolved),
                        f"peer range is unsupported: {error}",
                    )
                )
            elif not any(matches is True for matches, _ in evaluations):
                conflicts.append(
                    PeerConflict(
                        entry.package,
                        peer,
                        requirement,
                        ", ".join(resolved),
                        "target lockfile does not satisfy the peer range",
                    )
                )
    return tuple(conflicts)


def _npm_dependency_graph_error(
    entries: Mapping[str, _LockedEntry],
    root_dependencies: Mapping[str, str],
) -> Optional[str]:
    """Prove every admitted root and required package edge resolves once.

    The root mapping combines dependencies, devDependencies,
    optionalDependencies, and peerDependencies because all four can produce an
    npm v1 candidate. npm may legitimately omit an optional package on a given
    platform, but this platform-neutral evidence profile cannot prove why it
    was omitted, so absence remains not-verifiable rather than being guessed
    safe. Nested package optionalDependencies may be absent, but a present
    optional target must resolve exactly once and satisfy its declared range.
    Every admitted flat entry must also be reachable from the root through a
    required, present optional, or present peer edge.
    """

    versions_by_package: Dict[str, Tuple[str, ...]] = {}
    for entry in entries.values():
        versions_by_package[entry.package] = tuple(
            sorted(set(versions_by_package.get(entry.package, ())) | {entry.version})
        )
    edges = (("<root>", root_dependencies),) + tuple(
        (entry.package, entry.dependencies) for entry in entries.values()
    )
    for source, dependencies in edges:
        for package, requirement in dependencies.items():
            resolved = versions_by_package.get(package, ())
            if not resolved:
                return f"npm dependency edge {source} -> {package} is absent from the flat lock graph"
            if len(resolved) != 1:
                return (
                    f"npm dependency edge {source} -> {package} resolves ambiguously: "
                    f"{', '.join(resolved)}"
                )
            matches, error = npm_constraint_matches(requirement, resolved[0])
            if error is not None:
                return (
                    f"npm dependency edge {source} -> {package} has an unsupported "
                    f"range: {error}"
                )
            if matches is not True:
                return (
                    f"npm dependency edge {source} -> {package} does not satisfy "
                    f"{requirement}: {resolved[0]}"
                )
    for entry in entries.values():
        for package, requirement in entry.optional_dependencies.items():
            resolved = versions_by_package.get(package, ())
            if not resolved:
                # npm explicitly permits an optional dependency to be omitted.
                continue
            if len(resolved) != 1:
                return (
                    f"npm optional dependency edge {entry.package} -> {package} "
                    f"resolves ambiguously: {', '.join(resolved)}"
                )
            matches, error = npm_constraint_matches(requirement, resolved[0])
            if error is not None:
                return (
                    f"npm optional dependency edge {entry.package} -> {package} "
                    f"has an unsupported range: {error}"
                )
            if matches is not True:
                return (
                    f"npm optional dependency edge {entry.package} -> {package} "
                    f"does not satisfy {requirement}: {resolved[0]}"
                )

    entries_by_package = {entry.package: entry for entry in entries.values()}
    reachable = set(root_dependencies)
    pending = list(root_dependencies)
    while pending:
        package = pending.pop()
        entry = entries_by_package.get(package)
        if entry is None:
            continue
        neighbors = set(entry.dependencies)
        neighbors.update(
            optional
            for optional in entry.optional_dependencies
            if optional in entries_by_package
        )
        neighbors.update(
            peer for peer in entry.peer_dependencies if peer in entries_by_package
        )
        for neighbor in neighbors - reachable:
            reachable.add(neighbor)
            pending.append(neighbor)
    orphaned = sorted(set(entries_by_package) - reachable)
    if orphaned:
        return (
            "npm flat lock graph contains unreachable package entries: "
            + ", ".join(orphaned)
        )
    return None


def resolve_pnpm_lock_transition(
    candidate: DependencyCandidate | CandidateIdentity,
    *,
    baseline_lockfile: str,
    target_lockfile: str,
    observed_at: Optional[str] = None,
) -> LockResolution:
    """Compare baseline/target pnpm lock entries without mutating the repo."""
    identity = candidate if isinstance(candidate, CandidateIdentity) else CandidateIdentity.from_candidate(candidate)
    timestamp = observed_at or _now_iso()
    try:
        baseline = _parse_lock_entries(baseline_lockfile)
        target = _parse_lock_entries(target_lockfile)
    except (TypeError, ValueError) as exc:
        return _failure_lock(str(exc), timestamp)

    target_versions = sorted({entry.version for entry in target.values() if entry.package == identity.package})
    if identity.target_version not in target_versions:
        return _failure_lock(f"target lockfile does not resolve {identity.package}@{identity.target_version}", timestamp)

    direct_before = tuple(sorted({entry.version for entry in baseline.values() if entry.package == identity.package}))
    direct_after = tuple(target_versions)
    direct = DependencyChange(identity.package, direct_before or (identity.current_version,), direct_after, "direct")
    transitive: list[DependencyChange] = []
    packages = sorted({entry.package for entry in baseline.values()} | {entry.package for entry in target.values()})
    for package in packages:
        if package == identity.package:
            continue
        before = tuple(sorted({entry.version for entry in baseline.values() if entry.package == package}))
        after = tuple(sorted({entry.version for entry in target.values() if entry.package == package}))
        if before != after:
            transitive.append(DependencyChange(package, before, after, "transitive"))

    return LockResolution(
        resolution=EvidenceResolution.RESOLVED,
        direct_changes=(direct,),
        transitive_changes=tuple(transitive),
        peer_conflicts=_pnpm_peer_conflicts(target),
        observed_at=timestamp,
    )


def resolve_cargo_lock_transition(
    candidate: DependencyCandidate | CandidateIdentity,
    *,
    baseline_lockfile: str,
    target_lockfile: str,
    observed_at: Optional[str] = None,
) -> LockResolution:
    """Prove a Cargo v1 transition without running Cargo.

    The pure parser checks one bounded reachable graph in each supplied
    lockfile. This function compares their fields; it does not authenticate
    Cargo checksums or make the result eligible for the evidence gate.
    """
    identity = candidate if isinstance(candidate, CandidateIdentity) else CandidateIdentity.from_candidate(candidate)
    timestamp = observed_at or _now_iso()
    if identity.ecosystem != "rust" or identity.package_manager != "cargo" or identity.adapter_profile != CARGO_ADAPTER_PROFILE:
        return _failure_lock("candidate is not bound to the Cargo v1 adapter profile", timestamp)
    if not isinstance(candidate, DependencyCandidate):
        return _failure_lock("Cargo lock transition requires the original dependency candidate", timestamp)
    if candidate.dependency_kind != "dependencies":
        return _failure_lock("Cargo v1 supports root dependencies only", timestamp)
    for version in (identity.current_version, identity.target_version):
        matches, error = cargo_constraint_matches(candidate.specifier, version)
        if error is not None or not matches:
            return _failure_lock("Cargo candidate version does not satisfy its stable caret constraint", timestamp)
    try:
        baseline = parse_cargo_lockfile(baseline_lockfile)
        target = parse_cargo_lockfile(target_lockfile)
    except (TypeError, ValueError) as exc:
        return _failure_lock(str(exc), timestamp)
    if baseline.root.name != target.root.name or baseline.root.version != target.root.version:
        return _failure_lock("Cargo.lock root package changed outside the candidate", timestamp)
    if tuple(sorted(baseline.root.dependencies)) != tuple(sorted(target.root.dependencies)):
        return _failure_lock("Cargo.lock root dependency graph changed outside the candidate", timestamp)
    if identity.package not in baseline.root.dependencies:
        return _failure_lock(f"Cargo.lock root does not depend on {identity.package}", timestamp)
    before = baseline.packages.get(identity.package)
    after = target.packages.get(identity.package)
    if before is None or after is None:
        return _failure_lock(f"Cargo.lock has no direct resolution for {identity.package}", timestamp)
    if before.version != identity.current_version or after.version != identity.target_version:
        return _failure_lock(f"Cargo.lock direct transition does not exactly match {identity.package}", timestamp)
    for package in baseline.root.dependencies:
        if package == identity.package:
            continue
        left, right = baseline.packages[package], target.packages[package]
        if left != right:
            return _failure_lock(f"Cargo.lock root direct dependency changed outside the candidate: {package}", timestamp)
    shared = set(baseline.packages) & set(target.packages)
    for package in sorted(shared):
        if package == identity.package:
            continue
        left, right = baseline.packages[package], target.packages[package]
        if left.version == right.version and left != right:
            return _failure_lock(f"Cargo.lock metadata or provenance changed for unchanged {package}@{left.version}", timestamp)
    transitive: list[DependencyChange] = []
    for package in sorted(set(baseline.packages) | set(target.packages)):
        if package == identity.package:
            continue
        left = baseline.packages.get(package)
        right = target.packages.get(package)
        before_versions = (left.version,) if left else ()
        after_versions = (right.version,) if right else ()
        if before_versions != after_versions:
            transitive.append(DependencyChange(package, before_versions, after_versions, "transitive"))
    return LockResolution(
        resolution=EvidenceResolution.RESOLVED,
        direct_changes=(DependencyChange(identity.package, (before.version,), (after.version,), "direct"),),
        transitive_changes=tuple(transitive),
        observed_at=timestamp,
    )


def _npm_package_provenance_is_canonical(
    *, package: str, version: str, resolved: object, integrity: object
) -> bool:
    if not isinstance(resolved, str) or not isinstance(integrity, str):
        return False
    parsed = urlsplit(resolved)
    tarball_name = f"{package.rsplit('/', 1)[-1]}-{version}.tgz"
    expected_path = f"/{package}/-/{tarball_name}"
    if (
        parsed.scheme != "https"
        or parsed.netloc != "registry.npmjs.org"
        or parsed.path != expected_path
        or parsed.query
        or parsed.fragment
    ):
        return False
    if not integrity.startswith("sha512-"):
        return False
    encoded = integrity[len("sha512-") :]
    try:
        digest = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(digest) == 64


def _parse_npm_lock_entries(
    text: str,
) -> Tuple[Dict[str, _LockedEntry], Dict[str, Tuple[str, str]]]:
    """Parse the direct package evidence needed from npm package-lock v3.

    This intentionally accepts only the JSON lockfile formats that carry a
    resolved package version.  A malformed or incomplete lock never becomes a
    guessed npm candidate.
    """

    if not isinstance(text, str):
        raise ValueError("npm lockfile is not text")
    try:
        lock = loads_strict_json(text, document="package-lock.json")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"npm lockfile is malformed: {exc}") from exc
    if not isinstance(lock, dict) or lock.get("lockfileVersion") != 3:
        raise ValueError("npm adapter supports package-lock.json lockfileVersion 3 only")
    if "workspaces" in lock:
        raise ValueError("npm package-lock v3 workspace graphs are unsupported")

    entries: Dict[str, _LockedEntry] = {}
    root: Dict[str, Tuple[str, str]] = {}
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("npm package-lock v3 packages must be an object")
    root_data = packages.get("")
    if not isinstance(root_data, dict):
        raise ValueError("npm package-lock v3 root package is missing or malformed")
    if "workspaces" in root_data:
        raise ValueError("npm package-lock v3 workspace graphs are unsupported")
    root_sections: Dict[str, str] = {}
    for section in NPM_DEPENDENCY_KINDS:
        values = root_data.get(section, {})
        if not isinstance(values, dict) or any(
            not isinstance(name, str) or not isinstance(specifier, str)
            for name, specifier in values.items()
        ):
            raise ValueError("npm lockfile root dependency evidence is malformed")
        for name, specifier in values.items():
            previous = root_sections.get(name)
            if previous is not None:
                raise ValueError(
                    "npm lockfile root dependency appears in multiple sections: "
                    f"{name} ({previous}, {section})"
                )
            root_sections[name] = section
            root[name] = (section, specifier)
    for path, item in packages.items():
        if not isinstance(path, str) or not isinstance(item, dict):
            raise ValueError("npm lockfile contains malformed package entries")
        if path == "":
            continue
        # npm may represent nested package locations and workspace members in
        # this map.  The v1 adapter only proves the one flat, root install
        # graph.  Silently dropping either kind would make its transitive and
        # peer evidence incomplete, so reject instead of reporting a partial
        # graph as complete.
        if "/node_modules/" in path:
            raise ValueError("npm package-lock v3 nested node_modules graphs are unsupported")
        if not path.startswith("node_modules/"):
            raise ValueError("npm package-lock v3 workspace package locations are unsupported")
        package = path[len("node_modules/") :]
        if _NPM_PACKAGE.fullmatch(package) is None:
            raise ValueError("npm package-lock v3 package location is outside the flat root graph")
        version = item.get("version")
        if not package or not isinstance(version, str):
            raise ValueError("npm lockfile has an unparseable resolved package")
        resolved = item.get("resolved")
        integrity = item.get("integrity")
        if not _npm_package_provenance_is_canonical(
            package=package,
            version=version,
            resolved=resolved,
            integrity=integrity,
        ):
            raise ValueError(
                "npm package-lock v3 package provenance must bind the exact registry.npmjs.org package/version with a 64-byte sha512 integrity"
            )
        dependencies = item.get("dependencies", {})
        optional_dependencies = item.get("optionalDependencies", {})
        peers = item.get("peerDependencies", {})
        if (
            not isinstance(dependencies, dict)
            or not isinstance(optional_dependencies, dict)
            or not isinstance(peers, dict)
        ):
            raise ValueError("npm lockfile dependency metadata is malformed")
        if any(
            not isinstance(name, str) or not isinstance(value, str)
            for mapping in (dependencies, optional_dependencies, peers)
            for name, value in mapping.items()
        ):
            raise ValueError("npm lockfile dependency metadata is malformed")
        entries[f"{package}@{version}"] = _LockedEntry(
            package=package,
            version=version,
            dependencies=dict(dependencies),
            peer_dependencies=dict(peers),
            optional_dependencies=dict(optional_dependencies),
            resolved=resolved,
            integrity=integrity,
        )
    graph_error = _npm_dependency_graph_error(
        entries,
        {package: identity[1] for package, identity in root.items()},
    )
    if graph_error is not None:
        raise ValueError(graph_error)
    return entries, root


def resolve_npm_lock_transition(
    candidate: DependencyCandidate | CandidateIdentity,
    *,
    baseline_lockfile: str,
    target_lockfile: str,
    target_specifier: Optional[str] = None,
    observed_at: Optional[str] = None,
) -> LockResolution:
    """Prove an npm lock transition contains the approved direct target."""

    identity = candidate if isinstance(candidate, CandidateIdentity) else CandidateIdentity.from_candidate(candidate)
    expected_specifier = candidate.specifier if isinstance(candidate, DependencyCandidate) else None
    expected_kind = candidate.dependency_kind if isinstance(candidate, DependencyCandidate) else None
    timestamp = observed_at or _now_iso()
    try:
        baseline, baseline_root = _parse_npm_lock_entries(baseline_lockfile)
        target, target_root = _parse_npm_lock_entries(target_lockfile)
    except (TypeError, ValueError) as exc:
        return _failure_lock(str(exc), timestamp)
    if expected_kind not in NPM_DEPENDENCY_KINDS:
        return _failure_lock("npm candidate dependency kind is missing or unsupported", timestamp)
    baseline_direct = baseline_root.get(identity.package)
    target_direct = target_root.get(identity.package)
    if (
        baseline_direct is None
        or target_direct is None
        or baseline_direct[0] != expected_kind
        or target_direct[0] != expected_kind
    ):
        return _failure_lock(
            f"npm lockfile dependency kind does not match {identity.package}",
            timestamp,
        )
    baseline_other_root = {
        package: root_identity
        for package, root_identity in baseline_root.items()
        if package != identity.package
    }
    target_other_root = {
        package: root_identity
        for package, root_identity in target_root.items()
        if package != identity.package
    }
    if baseline_other_root != target_other_root:
        changed = sorted(
            set(baseline_other_root) ^ set(target_other_root)
            | {
                package
                for package in set(baseline_other_root) & set(target_other_root)
                if baseline_other_root[package] != target_other_root[package]
            }
        )
        return _failure_lock(
            "npm lockfile root direct dependency identity changed outside the "
            f"candidate: {', '.join(changed)}",
            timestamp,
        )
    for key in sorted(set(baseline) & set(target)):
        before = baseline[key]
        after = target[key]
        if before != after:
            return _failure_lock(
                f"npm lockfile metadata or provenance changed for unchanged {key}",
                timestamp,
            )
    if expected_specifier is not None and baseline_direct[1] != expected_specifier:
        return _failure_lock(f"baseline npm lockfile specifier does not match {identity.package}", timestamp)
    expected_target_specifier = target_specifier or expected_specifier
    if (
        expected_target_specifier is not None
        and target_direct[1] != expected_target_specifier
    ):
        return _failure_lock(f"target npm lockfile specifier does not match {identity.package}", timestamp)
    for package in sorted(baseline_other_root):
        baseline_versions_for_package = tuple(
            sorted(
                entry.version
                for entry in baseline.values()
                if entry.package == package
            )
        )
        target_versions_for_package = tuple(
            sorted(
                entry.version
                for entry in target.values()
                if entry.package == package
            )
        )
        if baseline_versions_for_package != target_versions_for_package:
            return _failure_lock(
                "npm lockfile root direct dependency version changed outside "
                f"the candidate: {package}",
                timestamp,
            )
    baseline_versions = tuple(
        sorted(
            {
                entry.version
                for entry in baseline.values()
                if entry.package == identity.package
            }
        )
    )
    if baseline_versions != (identity.current_version,):
        return _failure_lock(
            "baseline npm lockfile must resolve exactly "
            f"{identity.package}@{identity.current_version}",
            timestamp,
        )
    target_versions = tuple(
        sorted(
            {
                entry.version
                for entry in target.values()
                if entry.package == identity.package
            }
        )
    )
    if target_versions != (identity.target_version,):
        return _failure_lock(
            "target npm lockfile must resolve exactly "
            f"{identity.package}@{identity.target_version}",
            timestamp,
        )

    direct = DependencyChange(
        identity.package, baseline_versions, target_versions, "direct"
    )
    transitive: list[DependencyChange] = []
    for package in sorted({entry.package for entry in baseline.values()} | {entry.package for entry in target.values()}):
        if package == identity.package:
            continue
        before = tuple(sorted({entry.version for entry in baseline.values() if entry.package == package}))
        after = tuple(sorted({entry.version for entry in target.values() if entry.package == package}))
        if before != after:
            transitive.append(DependencyChange(package, before, after, "transitive"))

    return LockResolution(
        resolution=EvidenceResolution.RESOLVED,
        direct_changes=(direct,),
        transitive_changes=tuple(transitive),
        peer_conflicts=_npm_peer_conflicts(target),
        observed_at=timestamp,
    )


def security_evidence_from_advisory_payload(
    payload: Mapping[str, Any],
    *,
    package: str,
    source: EvidenceSource,
    observed_at: Optional[str] = None,
) -> SecurityEvidence:
    """Convert a structured advisory response into fail-closed evidence.

    The provider must supply whether an advisory is newly introduced.  If that
    comparison is absent, the result is ``not_verifiable`` rather than a green
    result based on a summary or an empty field.
    """
    timestamp = observed_at or _now_iso()
    if not isinstance(payload, Mapping) or not isinstance(payload.get("vulnerabilities"), list):
        return _failure_security("advisory response is malformed", timestamp)
    advisories: list[SecurityAdvisory] = []
    for item in payload["vulnerabilities"]:
        if not isinstance(item, Mapping):
            return _failure_security("advisory response contains malformed vulnerability data", timestamp)
        advisory_id = str(item.get("id") or item.get("ghsa") or "").strip()
        severity = str(item.get("severity") or (item.get("database_specific") or {}).get("severity") or "").strip().lower()
        introduced = item.get("introduced")
        if not advisory_id or severity not in {"low", "moderate", "medium", "high", "critical"} or not isinstance(introduced, bool):
            return _failure_security(f"advisory {advisory_id or '<unknown>'} is missing canonical severity or introduction evidence", timestamp)
        advisories.append(SecurityAdvisory(
            advisory_id=advisory_id,
            package=str(item.get("package") or package),
            severity=severity,
            introduced=introduced,
            source=source,
            summary=str(item.get("summary") or ""),
        ))
    if not source.valid():
        return _failure_security("advisory source identifier, URL, or timestamp is missing", timestamp)
    return SecurityEvidence(
        resolution=EvidenceResolution.RESOLVED,
        advisories=tuple(advisories),
        sources=(source,),
        observed_at=timestamp,
    )


def write_dependency_evidence(
    path: Path,
    evidence: DependencyEvidence,
    *,
    metadata_path: Optional[Path] = None,
) -> None:
    """Persist the bounded artifact and expose it in run metadata."""
    payload = evidence.to_dict()
    write_json(path, payload)
    if metadata_path is None:
        return
    metadata = read_json(metadata_path) if metadata_path.exists() else {}
    metadata["dependencyEvidence"] = payload
    metadata["dependencyEvidenceFile"] = str(path)
    write_json(metadata_path, metadata)


def collect_and_write_dependency_evidence(
    path: Path,
    candidate: DependencyCandidate | CandidateIdentity,
    *,
    release: ReleaseEvidenceProvider,
    usage: UsageEvidenceProvider,
    lock: LockResolutionProvider,
    security: SecurityEvidenceProvider,
    waiver: Optional[EvidenceWaiver] = None,
    observed_at: Optional[str] = None,
    metadata_path: Optional[Path] = None,
) -> DependencyEvidence:
    """Collect dependency evidence and persist the bounded artifact.

    This is the pre-implementation stage: it uses injected providers, fails
    closed on provider errors, writes ``dependency_evidence.json``, and returns
    the evidence object that should feed the Objective Gate seam.
    """
    evidence = collect_dependency_evidence(
        candidate,
        release=release,
        usage=usage,
        lock=lock,
        security=security,
        waiver=waiver,
        observed_at=observed_at,
    )
    write_dependency_evidence(path, evidence, metadata_path=metadata_path)
    return evidence


def load_dependency_evidence_for_gate(run_dir: Path) -> Dict[str, Any]:
    """Load the dependency evidence artifact for the Objective Gate seam.

    Missing or unreadable artifacts are converted into an explicit invalid
    payload so the gate fails closed instead of silently skipping the evidence.
    """
    path = Path(run_dir) / "dependency_evidence.json"
    if not path.exists():
        return {"invalid": "dependency evidence file is missing"}
    try:
        return read_json(path)
    except Exception as exc:  # noqa: BLE001 - explicit fail-closed seam
        return {"invalid": f"dependency evidence could not be read: {type(exc).__name__}"}


def dependency_gate_input(payload: Mapping[str, Any]) -> Tuple[bool, str]:
    """Validate the serialized decision before it enters the Objective Gate."""

    def nonempty_string(value: Any) -> bool:
        return isinstance(value, str) and bool(value.strip())

    if not isinstance(payload, Mapping):
        return False, "dependency evidence is not an object"
    if payload.get("kind") not in {"dependency-upgrade-evidence", "pnpm-dependency-upgrade-evidence"}:
        return False, "dependency evidence schema is unsupported"
    if payload.get("schemaVersion") != 2:
        return False, (
            "dependency evidence schema is unsupported; regenerate current "
            "schemaVersion 2 evidence"
        )
    candidate = payload.get("candidate")
    required_candidate = (
        "fingerprint",
        "package",
        "currentVersion",
        "targetVersion",
        "baselineSha",
        "ecosystem",
        "packageManager",
        "adapterProfile",
        "adapterIdentityFingerprint",
    )
    if not isinstance(candidate, Mapping) or any(
        not nonempty_string(candidate.get(field)) for field in required_candidate
    ):
        return False, "dependency evidence candidate identity is incomplete"
    duplicated_identity = (
        ("candidateFingerprint", "fingerprint"),
        ("adapterProfile", "adapterProfile"),
        ("adapterIdentityFingerprint", "adapterIdentityFingerprint"),
    )
    if any(
        not nonempty_string(payload.get(top_level))
        for top_level, _nested in duplicated_identity
    ):
        return False, "dependency evidence top-level candidate identity is incomplete"
    if any(
        payload.get(top_level) != candidate.get(nested)
        for top_level, nested in duplicated_identity
    ):
        return False, "dependency evidence top-level candidate identity is mismatched"
    if candidate["currentVersion"] == candidate["targetVersion"]:
        return False, "dependency evidence candidate transition is a no-op"
    expected_profile = ADAPTER_PROFILE_IDS.get(
        (candidate["ecosystem"], candidate["packageManager"])
    )
    if expected_profile is None:
        return False, "dependency evidence adapter capability is unavailable"
    if candidate["adapterProfile"] != expected_profile:
        return False, "dependency evidence adapter profile is mismatched"
    try:
        expected_adapter_fingerprint = adapter_identity_fingerprint(
            candidate_fingerprint=candidate["fingerprint"],
            ecosystem=candidate["ecosystem"],
            package_manager=candidate["packageManager"],
            adapter_profile=expected_profile,
        )
    except ValueError:
        return False, "dependency evidence adapter identity is invalid"
    if candidate["adapterIdentityFingerprint"] != expected_adapter_fingerprint:
        return False, "dependency evidence adapter identity fingerprint is mismatched"

    release = payload.get("release")
    if not isinstance(release, Mapping) or release.get("resolution") != EvidenceResolution.RESOLVED.value:
        return False, "release evidence is not resolved"
    sources = release.get("sources")
    if not isinstance(sources, list) or not sources or any(
        not _serialized_evidence_source_valid(source)
        for source in sources
    ) or release.get("canonical") is not True or not nonempty_string(release.get("version")):
        return False, "release evidence has no valid canonical source"
    if release.get("version") != candidate["targetVersion"]:
        return False, "release evidence target does not match the candidate"

    usage = payload.get("usage")
    if not isinstance(usage, Mapping):
        return False, "usage evidence is missing"
    for field_name in ("directImports", "configReferences", "peerUsage", "workspaceUsage"):
        finding = usage.get(field_name)
        if not isinstance(finding, Mapping) or finding.get("status") not in {state.value for state in EvidenceState}:
            return False, f"{field_name} usage evidence is malformed"
        if finding.get("status") == EvidenceState.UNKNOWN.value:
            return False, f"{field_name} usage evidence is unknown"

    lock = payload.get("lock")
    if not isinstance(lock, Mapping) or lock.get("resolution") != EvidenceResolution.RESOLVED.value:
        return False, "target lock resolution is not resolved"
    direct_changes = lock.get("directChanges")
    if not isinstance(direct_changes, list) or len(direct_changes) != 1:
        return False, "target lock resolution must contain exactly one direct change"
    direct_change = direct_changes[0]
    if not isinstance(direct_change, Mapping) or (
        direct_change.get("package") != candidate["package"]
        or direct_change.get("fromVersions") != [candidate["currentVersion"]]
        or direct_change.get("toVersions") != [candidate["targetVersion"]]
        or direct_change.get("scope") != "direct"
    ):
        return False, "target lock direct change does not exactly match the candidate"
    transitive_changes = lock.get("transitiveChanges")
    if not isinstance(transitive_changes, list) or not isinstance(lock.get("peerConflicts"), list):
        return False, "target lock resolution is incomplete"
    transitive_packages: set[str] = set()
    for change in transitive_changes:
        if not isinstance(change, Mapping):
            return False, "target lock transitive changes are malformed"
        package = change.get("package")
        from_versions = change.get("fromVersions")
        to_versions = change.get("toVersions")
        if (
            not nonempty_string(package)
            or not isinstance(from_versions, list)
            or not isinstance(to_versions, list)
            or any(not nonempty_string(version) for version in from_versions)
            or any(not nonempty_string(version) for version in to_versions)
            or (not from_versions and not to_versions)
            or set(from_versions) == set(to_versions)
            or len(set(from_versions)) != len(from_versions)
            or len(set(to_versions)) != len(to_versions)
            or change.get("scope") != "transitive"
            or package == candidate["package"]
            or package in transitive_packages
        ):
            return False, "target lock transitive changes are malformed"
        transitive_packages.add(package)
    if lock.get("peerConflicts"):
        return False, "target lock resolution contains peer conflicts"

    security = payload.get("security")
    if not isinstance(security, Mapping) or security.get("resolution") != EvidenceResolution.RESOLVED.value:
        return False, "security advisory data is not resolved"
    security_sources = security.get("sources")
    if (
        not isinstance(security_sources, list)
        or not security_sources
        or any(
            not _serialized_evidence_source_valid(source)
            for source in security_sources
        )
    ):
        return False, "security advisory source is missing or invalid"
    advisories = security.get("advisories")
    if not isinstance(advisories, list):
        return False, "security advisory data is malformed"
    allowed_advisory_packages = {candidate["package"], *transitive_packages}
    for advisory in advisories:
        if not isinstance(advisory, Mapping):
            return False, "security advisory data is malformed or not candidate-bound"
        advisory_source = advisory.get("source")
        severity = advisory.get("severity")
        if (
            not nonempty_string(advisory.get("id"))
            or not nonempty_string(advisory.get("package"))
            or advisory.get("package") not in allowed_advisory_packages
            or not isinstance(severity, str)
            or severity not in _SECURITY_SEVERITIES
            or not isinstance(advisory.get("introduced"), bool)
            or not _serialized_evidence_source_valid(advisory_source)
            or advisory_source not in security_sources
        ):
            return False, "security advisory data is malformed or not candidate-bound"
        if advisory["introduced"] and severity in {"high", "critical"}:
            return False, f"new {severity} security advisory blocks upgrade"
    decision = payload.get("decision")
    if not isinstance(decision, Mapping):
        return False, "dependency evidence decision is missing"
    if decision.get("status") != DependencyDecisionStatus.READY.value or decision.get("proofComplete") is not True:
        reasons = decision.get("blockingReasons")
        if isinstance(reasons, list) and reasons:
            return False, "; ".join(str(reason) for reason in reasons)
        return False, "dependency evidence is not ready"
    return True, "candidate compatibility, usage, lock, release, and security evidence is complete"


__all__ = [
    "CandidateIdentity",
    "DependencyChange",
    "DependencyDecisionStatus",
    "DependencyEvidence",
    "DependencyEvidenceDecision",
    "EvidenceResolution",
    "EvidenceSource",
    "EvidenceState",
    "EvidenceWaiver",
    "LockResolution",
    "PeerConflict",
    "ReleaseEvidence",
    "SecurityAdvisory",
    "SecurityEvidence",
    "UsageEvidence",
    "UsageFinding",
    "collect_dependency_evidence",
    "collect_and_write_dependency_evidence",
    "dependency_gate_input",
    "evaluate_dependency_evidence",
    "load_dependency_evidence_for_gate",
    "resolve_pnpm_lock_transition",
    "resolve_npm_lock_transition",
    "resolve_cargo_lock_transition",
    "scan_usage_evidence",
    "security_evidence_from_advisory_payload",
    "write_dependency_evidence",
]
