"""Fail-closed evidence for an approved pnpm dependency upgrade.

The dependency detector deliberately stops at a candidate.  This module is the
next, still pre-implementation, stage: it records the evidence needed to decide
whether that candidate is safe to hand to the factory.

The providers are injected on purpose.  Release-note, code-graph, lockfile and
advisory retrieval can use GitHub, a local index, pnpm, or a test fixture, but
the decision contract never performs I/O and never treats a model summary as
source evidence.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Protocol, Sequence, Tuple

from agentrail.dependencies.pnpm import DependencyCandidate, DependencySnapshot
from agentrail.shared.json import read_json, write_json


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
        )

    def to_dict(self) -> Dict[str, str]:
        return {
            "fingerprint": self.fingerprint,
            "package": self.package,
            "currentVersion": self.current_version,
            "targetVersion": self.target_version,
            "baselineSha": self.baseline_sha,
            "ecosystem": self.ecosystem,
            "packageManager": self.package_manager,
        }


@dataclass(frozen=True)
class EvidenceSource:
    identifier: str
    url: Optional[str]
    observed_at: str
    kind: str

    def valid(self) -> bool:
        return bool(self.identifier.strip() or (self.url and self.url.strip())) and bool(self.observed_at.strip())

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "identifier": self.identifier,
            "url": self.url,
            "observedAt": self.observed_at,
            "kind": self.kind,
        }


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
            "schemaVersion": 1,
            "candidate": self.candidate.to_dict(),
            "candidateFingerprint": self.candidate.fingerprint,
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

    if evidence.release.resolution is not EvidenceResolution.RESOLVED:
        reason = evidence.release.reason or f"release evidence is {evidence.release.resolution.value}"
        maybe_block("release", reason, waivable=evidence.release.resolution is EvidenceResolution.UNKNOWN)
    if evidence.release.resolution is EvidenceResolution.RESOLVED:
        if not evidence.release.canonical or not evidence.release.sources or not all(source.valid() for source in evidence.release.sources):
            reasons.append("release evidence has no valid canonical source and timestamp")

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
    elif not evidence.lock.direct_changes:
        reasons.append("target lock resolution has no direct change")
    if evidence.lock.resolution is EvidenceResolution.RESOLVED and not isinstance(evidence.lock.transitive_changes, tuple):
        reasons.append("target lock resolution is malformed")
    if evidence.lock.peer_conflicts:
        reasons.extend(
            f"peer conflict: {conflict.package} requires {conflict.peer} {conflict.required}, "
            f"resolved {conflict.resolved or 'missing'}"
            for conflict in evidence.lock.peer_conflicts
        )

    if evidence.security.resolution is not EvidenceResolution.RESOLVED:
        reasons.append(evidence.security.reason or f"security advisory data is {evidence.security.resolution.value}")
    elif not evidence.security.sources or not all(source.valid() for source in evidence.security.sources):
        reasons.append("security advisory source is missing or invalid")
    for advisory in evidence.security.advisories:
        severity = advisory.severity.strip().lower()
        if advisory.introduced is None:
            reasons.append(f"security advisory {advisory.advisory_id} introduction status is unknown")
        elif advisory.introduced and severity in {"high", "critical"}:
            reasons.append(
                f"new {severity} security advisory {advisory.advisory_id} affects {advisory.package}"
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
            parsed = json.loads(text)
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


def _version_parts(value: str) -> Optional[Tuple[int, int, int]]:
    match = re.fullmatch(r"(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value.strip())
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))) if match else None


def _satisfies(version: str, requirement: str) -> bool:
    actual = _version_parts(version)
    if actual is None:
        return False
    requirement = requirement.strip()
    if requirement in {"*", "latest"}:
        return True
    exact = _version_parts(requirement)
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

    versions_by_package: Dict[str, Tuple[str, ...]] = {}
    for entry in target.values():
        versions_by_package.setdefault(entry.package, tuple())
        versions_by_package[entry.package] = tuple(sorted(set(versions_by_package[entry.package]) | {entry.version}))
    conflicts: list[PeerConflict] = []
    for entry in target.values():
        for peer, requirement in entry.peer_dependencies.items():
            resolved = versions_by_package.get(peer, ())
            if not resolved:
                conflicts.append(PeerConflict(entry.package, peer, requirement, None, "peer package is absent from target lockfile"))
            elif not any(_satisfies(version, requirement) for version in resolved):
                conflicts.append(PeerConflict(entry.package, peer, requirement, ", ".join(resolved), "target lockfile does not satisfy the peer range"))

    return LockResolution(
        resolution=EvidenceResolution.RESOLVED,
        direct_changes=(direct,),
        transitive_changes=tuple(transitive),
        peer_conflicts=tuple(conflicts),
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
    if not isinstance(payload, Mapping):
        return False, "dependency evidence is not an object"
    if payload.get("kind") not in {"dependency-upgrade-evidence", "pnpm-dependency-upgrade-evidence"} or payload.get("schemaVersion") != 1:
        return False, "dependency evidence schema is unsupported"
    candidate = payload.get("candidate")
    required_candidate = ("fingerprint", "package", "currentVersion", "targetVersion", "baselineSha")
    if not isinstance(candidate, Mapping) or any(not str(candidate.get(field) or "").strip() for field in required_candidate):
        return False, "dependency evidence candidate identity is incomplete"

    release = payload.get("release")
    if not isinstance(release, Mapping) or release.get("resolution") != EvidenceResolution.RESOLVED.value:
        return False, "release evidence is not resolved"
    sources = release.get("sources")
    if not isinstance(sources, list) or not sources or any(
        not isinstance(source, Mapping)
        or not str(source.get("identifier") or source.get("url") or "").strip()
        or not str(source.get("observedAt") or "").strip()
        for source in sources
    ) or release.get("canonical") is not True or not str(release.get("version") or "").strip():
        return False, "release evidence has no valid canonical source"

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
    if not isinstance(lock.get("directChanges"), list) or not lock.get("directChanges"):
        return False, "target lock resolution has no direct change"
    if not isinstance(lock.get("transitiveChanges"), list) or not isinstance(lock.get("peerConflicts"), list):
        return False, "target lock resolution is incomplete"
    if lock.get("peerConflicts"):
        return False, "target lock resolution contains peer conflicts"

    security = payload.get("security")
    if not isinstance(security, Mapping) or security.get("resolution") != EvidenceResolution.RESOLVED.value:
        return False, "security advisory data is not resolved"
    if not isinstance(security.get("sources"), list) or not security.get("sources"):
        return False, "security advisory source is missing"
    advisories = security.get("advisories")
    if not isinstance(advisories, list):
        return False, "security advisory data is malformed"
    for advisory in advisories:
        if not isinstance(advisory, Mapping) or not isinstance(advisory.get("introduced"), bool):
            return False, "security advisory introduction status is unknown"
        if advisory.get("introduced") and str(advisory.get("severity") or "").lower() in {"high", "critical"}:
            return False, f"new {str(advisory.get('severity')).lower()} security advisory blocks upgrade"
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
    "scan_usage_evidence",
    "security_evidence_from_advisory_payload",
    "write_dependency_evidence",
]
