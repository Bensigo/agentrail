"""Pure observation of dependency upgrade candidates.

This module deliberately has no filesystem, network, subprocess, or package
manager integration.  Callers provide a repository snapshot and inject the
registry and target-selection policies.  Incomplete evidence is a typed result
instead of an invented version.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Mapping, Optional, Protocol, Sequence, Tuple, Union

from agentrail.dependencies.manager import PNPM_ADAPTER_PROFILE, _normalise_snapshot
from agentrail.dependencies.source_inventory import DependencySourceInventoryReceipt


class ObservationStatus(str, Enum):
    CANDIDATES = "candidates"
    UNCHANGED = "unchanged"
    UNSUPPORTED = "unsupported"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True)
class DependencySnapshot:
    """The only repository state the detector is allowed to read."""

    files: Mapping[str, str]
    baseline_sha: str
    source_inventory_receipt: Optional[DependencySourceInventoryReceipt] = None


@dataclass(frozen=True)
class RegistryPackage:
    """Registry data already fetched by an outer adapter."""

    available_versions: Tuple[str, ...]
    yanked_versions: Tuple[str, ...] = ()


class RegistryAdapter(Protocol):
    def package_metadata(self, package: str) -> Optional[RegistryPackage]:
        """Return registry evidence, or ``None`` when it is unavailable."""


class TargetVersionAdapter(Protocol):
    def choose_target_version(
        self,
        package: str,
        current_version: str,
        specifier: str,
        available_versions: Sequence[str],
    ) -> Optional[str]:
        """Choose a target from the supplied registry evidence only."""


@dataclass(frozen=True)
class DependencyCandidate:
    package: str
    dependency_kind: str
    specifier: str
    current_version: str
    target_version: str
    manifest_path: str
    lockfile_path: str
    baseline_sha: str
    fingerprint: str
    ecosystem: str = "node"
    package_manager: str = "pnpm"
    package_manager_version: Optional[str] = None
    verification_commands: Tuple[str, ...] = ()
    manager_commands: Mapping[str, str] = field(default_factory=dict)
    adapter_profile: Optional[str] = None
    adapter_identity_fingerprint: Optional[str] = None


@dataclass(frozen=True)
class CandidatesResult:
    status: ObservationStatus = field(default=ObservationStatus.CANDIDATES, init=False)
    candidates: Tuple[DependencyCandidate, ...] = ()
    reasons: Tuple[str, ...] = ()


@dataclass(frozen=True)
class UnchangedResult:
    status: ObservationStatus = field(default=ObservationStatus.UNCHANGED, init=False)
    candidates: Tuple[DependencyCandidate, ...] = ()
    reasons: Tuple[str, ...] = ()


@dataclass(frozen=True)
class UnsupportedResult:
    status: ObservationStatus = field(default=ObservationStatus.UNSUPPORTED, init=False)
    candidates: Tuple[DependencyCandidate, ...] = ()
    reasons: Tuple[str, ...] = ()


@dataclass(frozen=True)
class InsufficientEvidenceResult:
    status: ObservationStatus = field(default=ObservationStatus.INSUFFICIENT_EVIDENCE, init=False)
    candidates: Tuple[DependencyCandidate, ...] = ()
    reasons: Tuple[str, ...] = ()


ObservationResult = Union[
    CandidatesResult,
    UnchangedResult,
    UnsupportedResult,
    InsufficientEvidenceResult,
]


@dataclass(frozen=True)
class _LockEntry:
    specifier: Optional[str] = None
    version: Optional[str] = None


@dataclass(frozen=True)
class _Version:
    major: int
    minor: int
    patch: int
    prerelease: Tuple[str, ...] = ()


_SEMVER_RE = re.compile(
    r"^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
_LOCKED_VERSION_RE = re.compile(
    r"^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:\([^)]*\))?$"
)
_SPECIFIER_VERSION_RE = re.compile(r"(?:^|[^0-9])(?:v)?(\d+)\.(\d+)\.(\d+)(?:$|[^0-9])")
_SUPPORTED_LOCKFILE_MAJORS = {5, 6, 9}
_ALTERNATE_LOCKFILES = {
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
}


def adapter_identity_fingerprint(
    *,
    candidate_fingerprint: str,
    ecosystem: str,
    package_manager: str,
    adapter_profile: str,
) -> str:
    """Bind a legacy observation fingerprint to one versioned adapter ID.

    The legacy candidate fingerprint remains unchanged because it is already
    used by live heartbeat/draft proposal custody.  This second digest prevents
    replaying that same candidate through a different execution profile.
    """

    values = (candidate_fingerprint, ecosystem, package_manager, adapter_profile)
    if any(not isinstance(value, str) or not value.strip() for value in values):
        raise ValueError("adapter identity fields must be non-empty")
    payload = {
        "adapter_identity_version": 1,
        "adapter_profile": adapter_profile,
        "candidate_fingerprint": candidate_fingerprint,
        "ecosystem": ecosystem,
        "package_manager": package_manager,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def observe_pnpm_dependencies(
    snapshot: DependencySnapshot,
    *,
    selected_dependencies: Sequence[str],
    registry: RegistryAdapter,
    target_versions: TargetVersionAdapter,
) -> ObservationResult:
    """Observe selected direct/dev pnpm dependencies without mutating state.

    The operation is fail-closed: one malformed or unverifiable selected
    dependency makes the complete result ``insufficient_evidence`` and drops
    all otherwise-valid candidates from that result.
    """

    files, snapshot_error = _normalise_snapshot(snapshot.files)
    if snapshot_error is not None:
        return _insufficient(snapshot_error)
    if not isinstance(snapshot.baseline_sha, str) or not snapshot.baseline_sha.strip():
        return _insufficient("baseline SHA is missing")

    package_text = files.get("package.json")
    if package_text is None:
        if _has_alternate_ecosystem(files):
            return _unsupported("package manager is not pnpm")
        return _insufficient("package.json is missing")

    try:
        manifest = json.loads(package_text)
    except (TypeError, ValueError) as exc:
        return _insufficient(f"package.json is malformed: {exc}")
    if not isinstance(manifest, dict):
        return _insufficient("package.json must contain an object")

    package_manager = manifest.get("packageManager")
    if package_manager is not None and not _is_pnpm_package_manager(package_manager):
        return _unsupported("package.json declares a non-pnpm package manager")
    if _has_alternate_ecosystem(files):
        return _unsupported("an alternate package-manager lockfile is present")

    lock_text = files.get("pnpm-lock.yaml")
    if lock_text is None:
        return _insufficient("pnpm-lock.yaml is missing")

    dependency_maps, manifest_error = _dependency_maps(manifest)
    if manifest_error is not None:
        return _insufficient(manifest_error)

    selected, selection_error = _selected_names(dependency_maps, selected_dependencies)
    if selection_error is not None:
        return _insufficient(selection_error)

    lock_entries, lock_specifiers, lock_error = _parse_importer(lock_text)
    if lock_error is not None:
        return _insufficient(lock_error)

    candidates: List[DependencyCandidate] = []
    unchanged: List[str] = []
    for package in selected:
        kind = _kind_for(package, dependency_maps)
        assert kind is not None  # validated by _selected_names
        specifier = dependency_maps[kind][package]
        if not _valid_specifier(specifier):
            return _insufficient(f"{package} has an unsupported or malformed version specifier")

        entry = lock_entries.get(kind, {}).get(package)
        if entry is None or entry.version is None:
            return _insufficient(f"pnpm lockfile has no version evidence for {package}")
        if entry.specifier is not None and entry.specifier != specifier:
            return _insufficient(f"manifest and lockfile specifiers disagree for {package}")
        if entry.specifier is None and lock_specifiers.get(kind, {}).get(package) not in (None, specifier):
            return _insufficient(f"manifest and lockfile specifiers disagree for {package}")

        current_version = _parse_locked_version(entry.version)
        if current_version is None:
            return _insufficient(f"pnpm lockfile version for {package} is unparseable")

        try:
            metadata = registry.package_metadata(package)
        except Exception as exc:  # adapters turn unavailable external data into evidence failure
            return _insufficient(f"registry data for {package} is unavailable: {exc}")
        if metadata is None or not metadata.available_versions:
            return _insufficient(f"registry data for {package} is unavailable")
        available = tuple(metadata.available_versions)
        if any(_parse_semver(version) is None for version in available):
            return _insufficient(f"registry versions for {package} are unparseable")

        try:
            target_version = target_versions.choose_target_version(
                package,
                current_version,
                specifier,
                available,
            )
        except Exception as exc:
            return _insufficient(f"target version for {package} is unavailable: {exc}")
        if target_version is None or target_version not in available:
            return _insufficient(f"target version for {package} is unavailable")

        comparison = _compare_versions(current_version, target_version)
        if comparison == 0:
            unchanged.append(package)
            continue
        if comparison > 0:
            return _insufficient(f"target version for {package} is older than the locked version")

        candidates.append(
            _make_candidate(
                package=package,
                dependency_kind=kind,
                specifier=specifier,
                current_version=current_version,
                target_version=target_version,
                baseline_sha=snapshot.baseline_sha,
            )
        )

    if candidates:
        return CandidatesResult(candidates=tuple(candidates), reasons=tuple(f"unchanged: {name}" for name in unchanged))
    return UnchangedResult(reasons=tuple(f"unchanged: {name}" for name in unchanged))


def _has_alternate_ecosystem(files: Mapping[str, str]) -> bool:
    return any(path in files for path in _ALTERNATE_LOCKFILES)


def _is_pnpm_package_manager(value: object) -> bool:
    return isinstance(value, str) and (value == "pnpm" or value.startswith("pnpm@"))


def _dependency_maps(manifest: Mapping[str, object]) -> Tuple[Dict[str, Dict[str, str]], Optional[str]]:
    maps: Dict[str, Dict[str, str]] = {}
    for kind in ("dependencies", "devDependencies"):
        raw = manifest.get(kind, {})
        if not isinstance(raw, dict):
            return {}, f"package.json {kind} must be an object"
        parsed: Dict[str, str] = {}
        for package, specifier in raw.items():
            if not isinstance(package, str) or not package or not isinstance(specifier, str) or not specifier:
                return {}, f"package.json contains malformed {kind} entries"
            parsed[package] = specifier
        maps[kind] = parsed
    overlap = set(maps["dependencies"]).intersection(maps["devDependencies"])
    if overlap:
        return {}, f"package appears in both dependency sections: {sorted(overlap)[0]}"
    return maps, None


def _selected_names(
    dependency_maps: Mapping[str, Mapping[str, str]], selected: Sequence[str]
) -> Tuple[Tuple[str, ...], Optional[str]]:
    all_names = set(dependency_maps["dependencies"]).union(dependency_maps["devDependencies"])
    names = sorted(set(selected) if selected else all_names)
    if any(not isinstance(name, str) or not name for name in names):
        return (), "selected dependency names must be non-empty strings"
    missing = [name for name in names if name not in all_names]
    if missing:
        return (), f"selected dependency is not declared in package.json: {missing[0]}"
    return tuple(names), None


def _kind_for(package: str, dependency_maps: Mapping[str, Mapping[str, str]]) -> Optional[str]:
    for kind in ("dependencies", "devDependencies"):
        if package in dependency_maps[kind]:
            return kind
    return None


def _valid_specifier(specifier: str) -> bool:
    if specifier.startswith(("workspace:", "file:", "link:", "npm:")):
        return False
    return _SPECIFIER_VERSION_RE.search(specifier) is not None


def _parse_semver(value: str) -> Optional[_Version]:
    if not isinstance(value, str):
        return None
    match = _SEMVER_RE.fullmatch(value.strip())
    if not match:
        return None
    prerelease = tuple(match.group(4).split(".")) if match.group(4) else ()
    return _Version(int(match.group(1)), int(match.group(2)), int(match.group(3)), prerelease)


def _parse_locked_version(value: str) -> Optional[str]:
    if not isinstance(value, str):
        return None
    match = _LOCKED_VERSION_RE.fullmatch(value.strip())
    if not match:
        return None
    version = f"{match.group(1)}.{match.group(2)}.{match.group(3)}"
    return f"{version}-{match.group(4)}" if match.group(4) else version


def _compare_versions(left: str, right: str) -> int:
    a = _parse_semver(left)
    b = _parse_semver(right)
    assert a is not None and b is not None
    numeric_a = (a.major, a.minor, a.patch)
    numeric_b = (b.major, b.minor, b.patch)
    if numeric_a != numeric_b:
        return -1 if numeric_a < numeric_b else 1
    if not a.prerelease and not b.prerelease:
        return 0
    if not a.prerelease:
        return 1
    if not b.prerelease:
        return -1
    return -1 if a.prerelease < b.prerelease else (1 if a.prerelease > b.prerelease else 0)


def _make_candidate(
    *,
    package: str,
    dependency_kind: str,
    specifier: str,
    current_version: str,
    target_version: str,
    baseline_sha: str,
) -> DependencyCandidate:
    payload = {
        "baseline_sha": baseline_sha,
        "current_version": current_version,
        "dependency_kind": dependency_kind,
        "lockfile_path": "pnpm-lock.yaml",
        "manifest_path": "package.json",
        "package_manager": "pnpm",
        "package": package,
        "specifier": specifier,
        "target_version": target_version,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    fingerprint = f"sha256:{digest}"
    adapter_fingerprint = adapter_identity_fingerprint(
        candidate_fingerprint=fingerprint,
        ecosystem="node",
        package_manager="pnpm",
        adapter_profile=PNPM_ADAPTER_PROFILE,
    )
    return DependencyCandidate(
        package=package,
        dependency_kind=dependency_kind,
        specifier=specifier,
        current_version=current_version,
        target_version=target_version,
        manifest_path="package.json",
        lockfile_path="pnpm-lock.yaml",
        baseline_sha=baseline_sha,
        fingerprint=fingerprint,
        ecosystem="node",
        package_manager="pnpm",
        adapter_profile=PNPM_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_fingerprint,
        verification_commands=("pnpm install --frozen-lockfile", "pnpm test"),
        manager_commands={
            "version": "pnpm --version",
            "install": "pnpm install --frozen-lockfile",
            "update": f"pnpm update --lockfile-only --ignore-scripts {package}@{target_version}",
        },
    )


def _parse_importer(
    text: str,
) -> Tuple[Dict[str, Dict[str, _LockEntry]], Dict[str, Dict[str, str]], Optional[str]]:
    """Parse the small importer subset needed for direct/dev observations.

    This is intentionally conservative rather than a general YAML parser.  It
    understands pnpm importer layouts from lockfile versions 5/6/9 and rejects
    malformed values instead of guessing through arbitrary YAML.
    """

    if not isinstance(text, str):
        return {}, {}, "pnpm-lock.yaml is not text"
    lines = text.splitlines()
    lockfile_version: Optional[str] = None
    importers_seen = False
    root_importer = False
    legacy_section_seen = False
    entries: Dict[str, Dict[str, _LockEntry]] = {"dependencies": {}, "devDependencies": {}}
    specifiers: Dict[str, Dict[str, str]] = {"dependencies": {}, "devDependencies": {}}
    section: Optional[str] = None
    current_package: Optional[str] = None

    for line_number, line in enumerate(lines, start=1):
        if "\t" in line:
            return {}, {}, f"pnpm-lock.yaml contains tabs at line {line_number}"
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        key, value, valid = _mapping_line(stripped)
        if not valid:
            return {}, {}, f"pnpm-lock.yaml has malformed mapping at line {line_number}"

        if indent == 0:
            if key == "lockfileVersion":
                lockfile_version = _scalar(value)
            elif key == "importers":
                importers_seen = True
            elif root_importer:
                break
            elif not importers_seen:
                section = key if key in ("dependencies", "devDependencies", "specifiers") else None
                current_package = None
                if section is not None:
                    legacy_section_seen = True
                    if value not in ("", "{}"):
                        return {}, {}, f"pnpm-lock.yaml section {key} is malformed at line {line_number}"
            continue

        if not importers_seen:
            continue
        if indent == 2:
            if key == ".":
                root_importer = True
                section = None
                current_package = None
                if value not in ("", "{}"):
                    return {}, {}, f"pnpm-lock.yaml root importer is malformed at line {line_number}"
            elif root_importer:
                break
            elif not importers_seen and section is not None:
                current_package = key
                if section == "specifiers":
                    parsed = _scalar(value)
                    if not parsed:
                        return {}, {}, f"pnpm-lock.yaml specifier for {key} is missing"
                    specifiers["dependencies"].setdefault(key, parsed)
                    specifiers["devDependencies"].setdefault(key, parsed)
                else:
                    parsed = _scalar(value) if value else None
                    if value and parsed is None:
                        return {}, {}, f"pnpm-lock.yaml entry for {key} is malformed at line {line_number}"
                    entries[section][key] = _LockEntry(version=parsed)
            continue
        if not root_importer:
            continue

        if indent == 4:
            section = key if key in ("dependencies", "devDependencies", "specifiers") else None
            current_package = None
            if value not in ("", "{}"):
                return {}, {}, f"pnpm-lock.yaml section {key} is malformed at line {line_number}"
            continue
        if indent == 6 and section is not None:
            current_package = key
            if section == "specifiers":
                parsed = _scalar(value)
                if not parsed:
                    return {}, {}, f"pnpm-lock.yaml specifier for {key} is missing"
                specifiers["dependencies"].setdefault(key, parsed)
                specifiers["devDependencies"].setdefault(key, parsed)
            else:
                parsed = _scalar(value) if value else None
                if value and parsed is None:
                    return {}, {}, f"pnpm-lock.yaml entry for {key} is malformed at line {line_number}"
                entries[section][key] = _LockEntry(version=parsed)
            continue
        if indent == 8 and section in ("dependencies", "devDependencies") and current_package is not None:
            if key not in ("specifier", "version"):
                continue
            parsed = _scalar(value)
            if not parsed:
                return {}, {}, f"pnpm-lock.yaml {key} for {current_package} is missing"
            old = entries[section].get(current_package, _LockEntry())
            entries[section][current_package] = _LockEntry(
                specifier=parsed if key == "specifier" else old.specifier,
                version=parsed if key == "version" else old.version,
            )
        if indent == 4 and not importers_seen and section in ("dependencies", "devDependencies") and current_package is not None:
            if key not in ("specifier", "version"):
                continue
            parsed = _scalar(value)
            if not parsed:
                return {}, {}, f"pnpm-lock.yaml {key} for {current_package} is missing"
            old = entries[section].get(current_package, _LockEntry())
            entries[section][current_package] = _LockEntry(
                specifier=parsed if key == "specifier" else old.specifier,
                version=parsed if key == "version" else old.version,
            )

    if lockfile_version is None:
        return {}, {}, "pnpm-lock.yaml lockfileVersion is missing"
    version_match = re.fullmatch(r"(\d+)(?:\.\d+)?", lockfile_version)
    if not version_match or int(version_match.group(1)) not in _SUPPORTED_LOCKFILE_MAJORS:
        return {}, {}, "pnpm-lock.yaml lockfileVersion is unsupported or malformed"
    if not importers_seen:
        if int(version_match.group(1)) not in (5, 6) or not legacy_section_seen:
            return {}, {}, "pnpm-lock.yaml has no supported root importer evidence"
    elif not root_importer:
        return {}, {}, "pnpm-lock.yaml has no root importer evidence"
    return entries, specifiers, None


def _mapping_line(line: str) -> Tuple[str, str, bool]:
    if ":" not in line:
        return "", "", False
    raw_key, raw_value = line.split(":", 1)
    key = raw_key.strip()
    if not key:
        return "", "", False
    if (key.startswith("'") and key.endswith("'")) or (key.startswith('"') and key.endswith('"')):
        key = key[1:-1]
    return key, raw_value.strip(), True


def _scalar(value: str) -> Optional[str]:
    if not value:
        return None
    if value.startswith(("{", "[")):
        return None
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if value.startswith('"') and value.endswith('"'):
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return parsed if isinstance(parsed, str) else None
    return value


def _insufficient(reason: str) -> InsufficientEvidenceResult:
    return InsufficientEvidenceResult(reasons=(reason,))


def _unsupported(reason: str) -> UnsupportedResult:
    return UnsupportedResult(reasons=(reason,))
