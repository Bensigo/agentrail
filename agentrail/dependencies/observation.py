"""Pure, manager-neutral dependency observation.

The observer consumes only a :class:`DependencySnapshot` and injected registry
and target-selection adapters.  It does not read the checkout, invoke a
package manager, or contact a registry.  A malformed or ambiguous manifest or
lockfile is evidence failure, not an invitation to guess.

The existing pnpm detector remains the implementation for pnpm repositories;
the dispatch layer adds npm, Poetry, uv, Cargo, and Go modules while reusing
its result and candidate types.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

try:  # Python 3.11+.  No third-party parser is required by this pure module.
    import tomllib
except ImportError:  # pragma: no cover - exercised only on Python 3.9/3.10.
    tomllib = None  # type: ignore[assignment]

from agentrail.dependencies.pnpm import (
    CandidatesResult,
    DependencyCandidate,
    DependencySnapshot,
    InsufficientEvidenceResult,
    ObservationResult,
    RegistryAdapter,
    TargetVersionAdapter,
    UnchangedResult,
    UnsupportedResult,
    adapter_identity_fingerprint,
    observe_pnpm_dependencies,
)
from agentrail.dependencies.manager import (
    CARGO_ADAPTER_PROFILE,
    COMMAND_PLANS,
    NPM_ADAPTER_PROFILE,
    NPM_DEPENDENCY_KINDS,
    ManagerId,
    SupportedDetection,
    detect_dependency_manager,
    npm_save_flag,
)
from agentrail.dependencies.cargo import (
    CARGO_MANIFEST_MAX_BYTES,
    cargo_constraint_matches,
    parse_cargo_lockfile,
    stable_version,
)
from agentrail.dependencies.npm_semver import npm_constraint_matches
from agentrail.dependencies.go_modules import (
    compare_go_versions,
    go_proxy_list_url,
    parse_go_module_files,
    same_go_major_versions,
    stable_go_version,
    validate_go_module_version,
    validate_go_proxy_versions,
)
from agentrail.dependencies.strict_json import loads_strict_json


class ManagerName(str, Enum):
    NPM = "npm"
    PNPM = "pnpm"
    POETRY = "poetry"
    UV = "uv"
    CARGO = "cargo"
    GO_MODULES = "go-modules"


@dataclass(frozen=True)
class _Entry:
    package: str
    kind: str
    specifier: str
    current_version: str
    manifest_path: str
    lockfile_path: str


@dataclass(frozen=True)
class _ManagerAdapter:
    name: ManagerName
    ecosystem: str
    manifest_path: str
    lockfile_path: str


_MANAGERS = (
    _ManagerAdapter(ManagerName.PNPM, "node", "package.json", "pnpm-lock.yaml"),
    _ManagerAdapter(ManagerName.NPM, "node", "package.json", "package-lock.json"),
    _ManagerAdapter(ManagerName.POETRY, "python", "pyproject.toml", "poetry.lock"),
    _ManagerAdapter(ManagerName.UV, "python", "pyproject.toml", "uv.lock"),
    _ManagerAdapter(ManagerName.CARGO, "rust", "Cargo.toml", "Cargo.lock"),
    _ManagerAdapter(ManagerName.GO_MODULES, "go", "go.mod", "go.sum"),
)

_SEMVER = re.compile(
    r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
_NPM_PACKAGE = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
_EXACT_NPM_SEMVER = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_UNSAFE_NPM_SPECIFIER = re.compile(
    r"^(?:file|link|workspace|git\+|git|path|https?|npm):", re.IGNORECASE
)
_PYTHON_REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$")
_UV_CANONICAL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_UV_STABLE_RELEASE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_UV_DIRECT_REQUIREMENT = re.compile(
    r"^(?P<package>[a-z0-9]+(?:-[a-z0-9]+)*)>=(?P<floor>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$"
)
_UV_REQUIRES_PYTHON = re.compile(
    r"^>=3\.(?P<lower_minor>\d+)\.(?P<lower_patch>\d+),<3\.(?P<upper_minor>\d+)\.0$"
)
_UV_PYPI_REGISTRY = "https://pypi.org/simple"
_UV_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
def observe_dependencies(
    snapshot: DependencySnapshot,
    *,
    selected_dependencies: Sequence[str] = (),
    registry: RegistryAdapter,
    target_versions: TargetVersionAdapter,
    manager: Optional[str] = None,
) -> ObservationResult:
    """Dispatch pure dependency observation to the detected manager.

    ``selected_dependencies`` is empty to observe every supported direct
    dependency.  ``manager`` may pin dispatch to a known adapter; otherwise a
    repository with multiple detected managers is rejected as ambiguous.
    """

    try:
        files = _normalise_files(snapshot.files)
    except (TypeError, ValueError) as exc:
        return _insufficient(f"repository snapshot paths are invalid: {exc}")
    detected, reason = _detect_manager(files, manager)
    if detected is None:
        return _insufficient(reason) if reason.startswith("insufficient:") else _unsupported(reason)

    if detected.name is ManagerName.PNPM:
        return observe_pnpm_dependencies(
            snapshot,
            selected_dependencies=selected_dependencies,
            registry=registry,
            target_versions=target_versions,
        )

    if not isinstance(snapshot.baseline_sha, str) or not snapshot.baseline_sha.strip():
        return _insufficient("baseline SHA is missing")
    if detected.name is ManagerName.NPM:
        entries, error = _npm_entries(files, selected_dependencies)
    elif detected.name is ManagerName.UV:
        entries, error = _uv_entries(files, selected_dependencies)
    elif detected.name is ManagerName.POETRY:
        entries, error = _python_entries(files, detected.name, selected_dependencies)
    elif detected.name is ManagerName.CARGO:
        entries, error = _cargo_entries(files, selected_dependencies)
    else:
        entries, error = _go_entries(files, selected_dependencies)
    if error is not None:
        return _insufficient(error)
    return _observe_entries(
        snapshot,
        detected,
        entries,
        registry=registry,
        target_versions=target_versions,
    )


def observe_dependency_candidates(
    snapshot: DependencySnapshot,
    *,
    selected_dependencies: Sequence[str] = (),
    registry: RegistryAdapter,
    target_versions: TargetVersionAdapter,
    manager: Optional[str] = None,
) -> ObservationResult:
    """Descriptive alias for callers that use ``candidates`` terminology."""

    return observe_dependencies(
        snapshot,
        selected_dependencies=selected_dependencies,
        registry=registry,
        target_versions=target_versions,
        manager=manager,
    )


def _detect_manager(
    files: Mapping[str, str], requested: Optional[str]
) -> Tuple[Optional[_ManagerAdapter], str]:
    if requested is not None:
        requested_name = _coerce_manager_name(requested)
        if requested_name is None:
            return None, f"unsupported dependency manager: {requested}"
        adapter = next(item for item in _MANAGERS if item.name is requested_name)
        if adapter.manifest_path not in files:
            return None, f"insufficient: {adapter.manifest_path} is missing"
        if requested_name is ManagerName.NPM:
            conflict = _explicit_npm_conflict(files)
            if conflict is not None:
                return None, f"unsupported: {conflict}"
        if adapter.lockfile_path not in files:
            return None, f"insufficient: {adapter.lockfile_path} is missing"
        return adapter, ""

    detection = detect_dependency_manager(files)
    if not isinstance(detection, SupportedDetection):
        reason = detection.reason or "no supported dependency manager detected"
        if "package.json does not identify" in reason:
            return None, "insufficient: package-lock.json is missing"
        if "pyproject.toml does not identify" in reason:
            return None, "insufficient: pyproject.toml does not identify Poetry or uv"
        return None, f"unsupported: {reason}"

    manager_name = _manager_name_for_id(detection.manager_id)
    if manager_name is None:
        return None, f"unsupported: dependency manager {detection.manager_id.value} is not safely parseable"
    adapter = _manager(manager_name)
    if detection.lockfile_path is None:
        return None, f"insufficient: {adapter.lockfile_path} is missing"
    return _ManagerAdapter(
        name=adapter.name,
        ecosystem=detection.ecosystem.value,
        manifest_path=detection.manifest_path,
        lockfile_path=detection.lockfile_path,
    ), ""


def _manager(name: ManagerName) -> _ManagerAdapter:
    return next(item for item in _MANAGERS if item.name is name)


def _explicit_npm_conflict(files: Mapping[str, str]) -> Optional[str]:
    """Reject explicit npm selection when repository evidence says otherwise."""

    try:
        manifest = loads_strict_json(files["package.json"], document="package.json")
    except (KeyError, TypeError, ValueError) as exc:
        return f"package.json is malformed: {exc}"
    if not isinstance(manifest, dict):
        return "package.json must contain an object"
    declared = manifest.get("packageManager")
    if declared is not None and (
        not isinstance(declared, str) or re.fullmatch(r"npm(?:@.+)?", declared) is None
    ):
        return "explicit npm selection conflicts with the packageManager declaration"
    conflicting = next(
        (
            path
            for path in (
                "pnpm-lock.yaml",
                "yarn.lock",
                "bun.lock",
                "bun.lockb",
                "npm-shrinkwrap.json",
            )
            if path in files
        ),
        None,
    )
    if conflicting is not None:
        return f"explicit npm selection conflicts with {conflicting}"
    return None


def _coerce_manager_name(value: object) -> Optional[ManagerName]:
    if not isinstance(value, str):
        return None
    aliases = {"go": "go-modules", "go_modules": "go-modules", "gomod": "go-modules"}
    prefix = aliases.get(value, value).split("@", 1)[0]
    try:
        return ManagerName(prefix)
    except ValueError:
        return None


def _manager_name_for_id(manager_id: ManagerId) -> Optional[ManagerName]:
    try:
        return ManagerName(manager_id.value)
    except ValueError:
        return None


def _npm_entries(files: Mapping[str, str], selected: Sequence[str]) -> Tuple[Tuple[_Entry, ...], Optional[str]]:
    try:
        manifest = loads_strict_json(files["package.json"], document="package.json")
        lock = loads_strict_json(
            files["package-lock.json"], document="package-lock.json"
        )
    except (KeyError, TypeError, ValueError) as exc:
        return (), f"npm manifest or lockfile is malformed: {exc}"
    if not isinstance(manifest, dict) or not isinstance(lock, dict):
        return (), "npm manifest and lockfile must contain objects"
    if "workspaces" in manifest:
        return (), "npm package.json workspace graphs are unsupported"
    package_manager = manifest.get("packageManager")
    if not isinstance(package_manager, str) or re.fullmatch(
        r"npm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", package_manager
    ) is None:
        return (), "package.json must declare an exact npm@x.y.z"
    scripts = manifest.get("scripts")
    if not isinstance(scripts, dict) or not isinstance(scripts.get("test"), str) or not scripts["test"].strip():
        return (), "package.json must declare a non-empty test script for npm verification"
    maps, error = _node_dependency_maps(manifest)
    if error:
        return (), error
    lock_root, lock_entries, error = _npm_lock_entries(lock)
    if error:
        return (), error
    manifest_root = {
        package: (kind, specifier)
        for kind, dependencies in maps.items()
        for package, specifier in dependencies.items()
    }
    if manifest_root != lock_root:
        return (), (
            "package.json and package-lock.json direct dependency maps do not "
            "exactly match"
        )
    return _entries_from_locked_maps(
        maps,
        {package: identity[1] for package, identity in lock_root.items()},
        lock_entries,
        selected,
        "package.json",
        "package-lock.json",
        require_lock_specifiers=True,
    )


def _node_dependency_maps(manifest: Mapping[str, Any]) -> Tuple[Dict[str, Dict[str, str]], Optional[str]]:
    maps: Dict[str, Dict[str, str]] = {}
    for kind in NPM_DEPENDENCY_KINDS:
        raw = manifest.get(kind, {})
        if not isinstance(raw, dict):
            return {}, f"package.json {kind} must be an object"
        values: Dict[str, str] = {}
        for package, specifier in raw.items():
            if not isinstance(package, str) or not package or not isinstance(specifier, str) or not specifier:
                return {}, f"package.json contains malformed {kind} entries"
            if _NPM_PACKAGE.fullmatch(package) is None:
                return {}, f"npm package name is outside npm_package_lock_only_v1: {package}"
            if _UNSAFE_NPM_SPECIFIER.match(specifier):
                return {}, f"{package} uses an unsupported local or alias specifier"
            values[package] = specifier
        maps[kind] = values
    seen: Dict[str, str] = {}
    for kind, values in maps.items():
        for package in values:
            if package in seen:
                return {}, f"package appears in both {seen[package]} and {kind}: {package}"
            seen[package] = kind
    return maps, None


def _npm_lock_entries(
    lock: Mapping[str, Any],
) -> Tuple[Mapping[str, Tuple[str, str]], Mapping[str, str], Optional[str]]:
    root: Dict[str, Tuple[str, str]] = {}
    entries: Dict[str, str] = {}
    if lock.get("lockfileVersion") != 3:
        return {}, {}, "npm adapter supports package-lock.json lockfileVersion 3 only"
    if "workspaces" in lock:
        return {}, {}, "npm package-lock v3 workspace graphs are unsupported"
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        return {}, {}, "package-lock.json v3 packages must be an object"
    root_raw = packages.get("")
    if not isinstance(root_raw, dict):
        return {}, {}, "package-lock.json v3 root package is missing or malformed"
    if "workspaces" in root_raw:
        return {}, {}, "npm package-lock v3 workspace graphs are unsupported"
    root_sections: Dict[str, str] = {}
    for kind in NPM_DEPENDENCY_KINDS:
        raw = root_raw.get(kind, {})
        if not isinstance(raw, dict) or any(
            not isinstance(package, str) or not isinstance(value, str)
            for package, value in raw.items()
        ):
            return {}, {}, "package-lock.json root dependency evidence is malformed"
        for package, specifier in raw.items():
            previous = root_sections.get(package)
            if previous is not None:
                return {}, {}, (
                    "package-lock.json root dependency appears in multiple sections: "
                    f"{package} ({previous}, {kind})"
                )
            root_sections[package] = kind
            root[package] = (kind, specifier)
    for path, value in packages.items():
        if not isinstance(path, str) or not isinstance(value, dict):
            return {}, {}, "package-lock.json contains malformed package entries"
        if path == "":
            continue
        if "/node_modules/" in path:
            return {}, {}, "npm package-lock v3 nested node_modules graphs are unsupported"
        if not path.startswith("node_modules/"):
            return {}, {}, "npm package-lock v3 workspace package locations are unsupported"
        package = path[len("node_modules/") :]
        if _NPM_PACKAGE.fullmatch(package) is None:
            return {}, {}, "npm package-lock v3 package location is outside the flat root graph"
        if not isinstance(value.get("version"), str):
            return {}, {}, "npm package-lock v3 package version is missing or malformed"
        entries[package] = value["version"]
    return root, entries, None


def _entries_from_locked_maps(
    maps: Mapping[str, Mapping[str, str]],
    lock_root: Mapping[str, str],
    lock_versions: Mapping[str, str],
    selected: Sequence[str],
    manifest_path: str,
    lockfile_path: str,
    require_lock_specifiers: bool = False,
) -> Tuple[Tuple[_Entry, ...], Optional[str]]:
    all_names = {package for values in maps.values() for package in values}
    names = sorted(set(selected) if selected else all_names)
    if any(not isinstance(name, str) or not name for name in names):
        return (), "selected dependency names must be non-empty strings"
    missing = [name for name in names if name not in all_names]
    if missing:
        return (), f"selected dependency is not declared in {manifest_path}: {missing[0]}"
    entries: List[_Entry] = []
    for package in names:
        kind = next(kind for kind, values in maps.items() if package in values)
        specifier = maps[kind][package]
        if _unsupported_local_specifier(specifier):
            return (), f"{package} uses an unsupported local or alias specifier"
        if require_lock_specifiers and package not in lock_root:
            return (), f"{lockfile_path} has no root specifier evidence for {package}"
        if package in lock_root and lock_root[package] != specifier:
            return (), f"manifest and lockfile specifiers disagree for {package}"
        current = lock_versions.get(package)
        if not isinstance(current, str) or _parse_version(current) is None:
            return (), f"{lockfile_path} has no safely parseable version for {package}"
        entries.append(_Entry(package, kind, specifier, current, manifest_path, lockfile_path))
    return tuple(entries), None


def _uv_entries(
    files: Mapping[str, str], selected: Sequence[str]
) -> Tuple[Tuple[_Entry, ...], Optional[str]]:
    manifest, error = _toml_mapping(files.get("pyproject.toml", ""), "pyproject.toml")
    if error:
        return (), error
    lock, error = _toml_mapping(files.get("uv.lock", ""), "uv.lock")
    if error:
        return (), error

    project = manifest.get("project")
    if not isinstance(project, dict):
        return (), "uv pyproject.toml must contain a static [project] table"
    project_name = project.get("name")
    project_version = project.get("version")
    requires_python = project.get("requires-python")
    if not isinstance(project_name, str) or not _UV_CANONICAL_NAME.fullmatch(project_name):
        return (), "uv project name must already be normalized"
    if not isinstance(project_version, str) or _uv_release(project_version) is None:
        return (), "uv project version must be a stable numeric release"
    if not isinstance(requires_python, str) or not _uv_requires_python_is_bounded(requires_python):
        return (), "uv project requires-python must be one bounded Python 3 minor"
    dynamic = project.get("dynamic", [])
    if not isinstance(dynamic, list) or dynamic:
        return (), "uv project metadata must be static"
    optional = project.get("optional-dependencies", {})
    if not isinstance(optional, dict) or optional:
        return (), "uv v1 does not admit optional dependencies"
    groups = manifest.get("dependency-groups", {})
    if not isinstance(groups, dict) or groups:
        return (), "uv v1 does not admit dependency groups"
    tool = manifest.get("tool", {})
    if not isinstance(tool, dict):
        return (), "uv project tool configuration is malformed"
    uv_tool = tool.get("uv", {})
    if not isinstance(uv_tool, dict) or uv_tool:
        return (), "uv v1 does not admit project uv configuration"

    raw_requirements = project.get("dependencies")
    if not isinstance(raw_requirements, list) or not raw_requirements:
        return (), "uv project has no supported direct dependencies"
    requirements: Dict[str, str] = {}
    for raw_requirement in raw_requirements:
        if not isinstance(raw_requirement, str):
            return (), "uv project contains a non-text dependency"
        match = _UV_DIRECT_REQUIREMENT.fullmatch(raw_requirement)
        if match is None:
            return (), "uv dependencies must use canonical name>=X.Y.Z requirements"
        package = match.group("package")
        if package in requirements:
            return (), f"uv project declares {package} more than once"
        requirements[package] = f">={match.group('floor')}"

    if (
        not isinstance(lock.get("version"), int)
        or isinstance(lock.get("version"), bool)
        or lock.get("version") != 1
        or not isinstance(lock.get("revision"), int)
        or isinstance(lock.get("revision"), bool)
        or lock.get("revision") != 3
    ):
        return (), "uv.lock must use schema version 1 revision 3"
    if lock.get("requires-python") != requires_python:
        return (), "pyproject.toml and uv.lock requires-python disagree"
    packages = lock.get("package")
    if not isinstance(packages, list) or not packages:
        return (), "uv.lock has no supported package entries"

    root_dependencies: Optional[set[str]] = None
    locked: Dict[str, List[Mapping[str, Any]]] = {}
    for item in packages:
        if not isinstance(item, dict):
            return (), "uv.lock contains a malformed package entry"
        name = item.get("name")
        version = item.get("version")
        source = item.get("source")
        if not isinstance(name, str) or not _UV_CANONICAL_NAME.fullmatch(name):
            return (), "uv.lock package names must already be normalized"
        if not isinstance(version, str) or _uv_release(version) is None:
            return (), f"uv.lock has a non-stable version for {name}"
        if source in ({"editable": "."}, {"virtual": "."}):
            if name != project_name or version != project_version or root_dependencies is not None:
                return (), "uv.lock has invalid root project custody"
            root_dependencies = _uv_root_dependency_names(item.get("dependencies", []))
            if root_dependencies is None:
                return (), "uv.lock root dependencies are ambiguous"
            continue
        if source != {"registry": _UV_PYPI_REGISTRY}:
            return (), f"uv.lock has a non-PyPI source for {name}"
        if not _uv_distribution_hashes_are_bounded(item):
            return (), f"uv.lock has no bounded distribution hashes for {name}"
        locked.setdefault(name, []).append(item)

    if root_dependencies is None:
        return (), "uv.lock has no exact root project entry"
    if root_dependencies != set(requirements):
        return (), "pyproject.toml and uv.lock direct dependencies disagree"

    names = sorted(set(selected) if selected else requirements)
    if any(not isinstance(name, str) or not _UV_CANONICAL_NAME.fullmatch(name) for name in names):
        return (), "selected uv dependency names must already be normalized"
    missing = [name for name in names if name not in requirements]
    if missing:
        return (), f"selected dependency is not declared in pyproject.toml: {missing[0]}"

    entries: List[_Entry] = []
    for package in names:
        package_rows = locked.get(package, [])
        if len(package_rows) != 1:
            return (), f"uv.lock must contain exactly one registry version of {package}"
        current = package_rows[0]["version"]
        floor = requirements[package][2:]
        if _compare_uv_releases(current, floor) < 0:
            return (), f"uv.lock version for {package} does not satisfy pyproject.toml"
        entries.append(
            _Entry(
                package,
                "dependencies",
                requirements[package],
                current,
                "pyproject.toml",
                "uv.lock",
            )
        )
    return tuple(entries), None


def _uv_release(value: object) -> Optional[Tuple[int, int, int]]:
    if not isinstance(value, str):
        return None
    match = _UV_STABLE_RELEASE.fullmatch(value)
    if match is None:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _compare_uv_releases(left: str, right: str) -> int:
    left_release = _uv_release(left)
    right_release = _uv_release(right)
    if left_release is None or right_release is None:
        raise ValueError("uv releases must be canonical stable numeric versions")
    return (left_release > right_release) - (left_release < right_release)


def _uv_requires_python_is_bounded(value: str) -> bool:
    match = _UV_REQUIRES_PYTHON.fullmatch(value)
    if match is None:
        return False
    lower_minor = int(match.group("lower_minor"))
    upper_minor = int(match.group("upper_minor"))
    return upper_minor == lower_minor + 1


def _uv_root_dependency_names(value: object) -> Optional[set[str]]:
    if not isinstance(value, list):
        return None
    names: set[str] = set()
    for dependency in value:
        if not isinstance(dependency, dict) or set(dependency) != {"name"}:
            return None
        name = dependency.get("name")
        if not isinstance(name, str) or not _UV_CANONICAL_NAME.fullmatch(name) or name in names:
            return None
        names.add(name)
    return names


def _uv_distribution_hashes_are_bounded(item: Mapping[str, Any]) -> bool:
    distributions: List[Mapping[str, Any]] = []
    sdist = item.get("sdist")
    if sdist is not None:
        if not isinstance(sdist, dict):
            return False
        distributions.append(sdist)
    wheels = item.get("wheels", [])
    if not isinstance(wheels, list) or any(not isinstance(wheel, dict) for wheel in wheels):
        return False
    distributions.extend(wheels)
    if not distributions or len(distributions) > 256:
        return False
    for distribution in distributions:
        url = distribution.get("url")
        digest = distribution.get("hash")
        size = distribution.get("size")
        if (
            not isinstance(url, str)
            or not url.startswith("https://files.pythonhosted.org/packages/")
            or len(url) > 2_048
            or not isinstance(digest, str)
            or _UV_SHA256.fullmatch(digest) is None
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 1
        ):
            return False
    return True


def _python_entries(
    files: Mapping[str, str], manager: ManagerName, selected: Sequence[str]
) -> Tuple[Tuple[_Entry, ...], Optional[str]]:
    data, error = _toml_mapping(files.get("pyproject.toml", ""), "pyproject.toml")
    if error:
        return (), error
    lock_data, error = _toml_mapping(files.get("poetry.lock" if manager is ManagerName.POETRY else "uv.lock", ""), "Python lockfile")
    if error:
        return (), error
    maps = _python_dependency_maps(data, manager)
    if maps is None:
        return (), f"{manager.value} dependencies are not safely parseable"
    packages = lock_data.get("package")
    if not isinstance(packages, list):
        return (), f"{manager.value} lockfile has no supported package entries"
    versions: Dict[str, set] = {}
    for item in packages:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("version"), str):
            return (), f"{manager.value} lockfile contains malformed package entries"
        versions.setdefault(item["name"], set()).add(item["version"])
    locked: Dict[str, str] = {}
    for package, values in versions.items():
        if len(values) != 1:
            return (), f"{manager.value} lockfile contains multiple versions of {package}"
        locked[package] = next(iter(values))
    return _entries_from_locked_maps(
        maps,
        {},
        locked,
        selected,
        "pyproject.toml",
        "poetry.lock" if manager is ManagerName.POETRY else "uv.lock",
    )


def _python_dependency_maps(data: Mapping[str, Any], manager: ManagerName) -> Optional[Dict[str, Dict[str, str]]]:
    maps: Dict[str, Dict[str, str]] = {}
    if manager is ManagerName.POETRY:
        tool = data.get("tool")
        poetry = tool.get("poetry") if isinstance(tool, dict) else None
        if not isinstance(poetry, dict):
            return None
        sections: List[Tuple[str, Any]] = [("dependencies", poetry.get("dependencies", {})), ("devDependencies", poetry.get("dev-dependencies", {}))]
        groups = poetry.get("group", {})
        if isinstance(groups, dict):
            for group_name, group in groups.items():
                if not isinstance(group, dict):
                    return None
                sections.append((f"devDependencies:{group_name}", group.get("dependencies", {})))
        for kind, raw in sections:
            if not isinstance(raw, dict):
                return None
            values: Dict[str, str] = {}
            for package, requirement in raw.items():
                if package == "python":
                    continue
                specifier = _python_specifier(requirement)
                if specifier is None:
                    return None
                values[package] = specifier
            maps[kind] = values
    else:
        project = data.get("project")
        if not isinstance(project, dict):
            return None
        raw_requirements = project.get("dependencies", [])
        if not isinstance(raw_requirements, list):
            return None
        maps["dependencies"] = {}
        for requirement in raw_requirements:
            parsed = _parse_python_requirement(requirement)
            if parsed is None:
                return None
            package, specifier = parsed
            maps["dependencies"][package] = specifier
        optional = project.get("optional-dependencies", {})
        if not isinstance(optional, dict):
            return None
        for group, requirements in optional.items():
            if not isinstance(requirements, list):
                return None
            kind = f"optionalDependencies:{group}"
            maps[kind] = {}
            for requirement in requirements:
                parsed = _parse_python_requirement(requirement)
                if parsed is None:
                    return None
                package, specifier = parsed
                maps[kind][package] = specifier
    return maps


def _python_specifier(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        version = value.get("version")
        if isinstance(version, str) and version.strip() and not any(key in value for key in ("path", "git", "url")):
            return version.strip()
    return None


def _parse_python_requirement(value: Any) -> Optional[Tuple[str, str]]:
    if not isinstance(value, str):
        return None
    match = _PYTHON_REQUIREMENT.fullmatch(value)
    if not match or not match.group(1):
        return None
    return match.group(1), match.group(2).strip() or "*"


def _cargo_entries(files: Mapping[str, str], selected: Sequence[str]) -> Tuple[Tuple[_Entry, ...], Optional[str]]:
    """Parse supplied Cargo roots without claiming generic inventory completeness.

    A supplied ``.cargo`` path is enough to refuse the profile. Only the GitHub
    heartbeat provider currently proves its absence through a complete
    exact-SHA root listing; injected providers do not gain that custody here.
    """

    if any(path == ".cargo" or path.startswith(".cargo/") for path in files):
        return (), "Cargo v1 rejects any supplied .cargo path until repository configuration is modeled"
    manifest_text = files.get("Cargo.toml", "")
    try:
        manifest_size = len(manifest_text.encode("utf-8"))
    except (AttributeError, UnicodeEncodeError):
        return (), "Cargo.toml is not valid UTF-8 text"
    if manifest_size > CARGO_MANIFEST_MAX_BYTES:
        return (), "Cargo.toml exceeds the byte limit"
    manifest, error = _toml_mapping(manifest_text, "Cargo.toml")
    if error:
        return (), error
    if any(key in manifest for key in ("workspace", "patch", "replace", "source", "target", "dev-dependencies", "build-dependencies")):
        return (), "Cargo v1 rejects workspace, patch, replace, source, target, dev, and build dependency configuration"
    project = manifest.get("package")
    dependencies = manifest.get("dependencies")
    if not isinstance(project, dict) or not isinstance(project.get("name"), str) or stable_version(project.get("version")) is None:
        return (), "Cargo.toml must declare one stable root package"
    if not isinstance(dependencies, dict) or not dependencies:
        return (), "Cargo.toml dependencies must be a non-empty object"
    direct: Dict[str, str] = {}
    for package, requirement in dependencies.items():
        matches, constraint_error = cargo_constraint_matches(requirement, "0.0.0")
        del matches
        if not isinstance(package, str) or constraint_error is not None:
            return (), "Cargo.toml dependency must use a stable caret requirement"
        direct[package] = requirement
    try:
        graph = parse_cargo_lockfile(files.get("Cargo.lock", ""))
    except ValueError as exc:
        return (), str(exc)
    if graph.root.name != project["name"] or graph.root.version != project["version"]:
        return (), "Cargo.toml root package does not match Cargo.lock"
    if set(graph.root.dependencies) != set(direct):
        return (), "Cargo.toml direct dependencies do not exactly match the Cargo.lock root graph"
    names = sorted(set(selected) if selected else direct)
    if any(not isinstance(name, str) or not name for name in names):
        return (), "selected dependency names must be non-empty strings"
    entries: list[_Entry] = []
    for package in names:
        if package not in direct:
            return (), f"selected dependency is not declared in Cargo.toml: {package}"
        locked = graph.packages.get(package)
        if locked is None:
            return (), f"Cargo.lock has no direct resolution for {package}"
        matches, constraint_error = cargo_constraint_matches(direct[package], locked.version)
        if constraint_error is not None or not matches:
            return (), f"Cargo.lock version for {package} does not satisfy its Cargo semver constraint"
        entries.append(_Entry(package, "dependencies", direct[package], locked.version, "Cargo.toml", "Cargo.lock"))
    return tuple(entries), None


def _go_entries(files: Mapping[str, str], selected: Sequence[str]) -> Tuple[Tuple[_Entry, ...], Optional[str]]:
    try:
        parsed = parse_go_module_files(
            files.get("go.mod", ""),
            files.get("go.sum", ""),
            supplied_paths=files,
        )
    except ValueError as exc:
        return (), str(exc)
    if any(not isinstance(name, str) or not name for name in selected):
        return (), "selected dependency names must be non-empty strings"
    if len(set(selected)) != len(selected):
        return (), "selected Go dependency names must not be duplicated"
    names = sorted(selected if selected else parsed.requirements)
    for name in names:
        if name not in parsed.requirements:
            return (), f"selected dependency is not declared in go.mod: {name}"
    return tuple(
        _Entry(
            requirement.module_path,
            "dependencies",
            requirement.version,
            requirement.version,
            "go.mod",
            "go.sum",
        )
        for requirement in (parsed.requirements[name] for name in names)
    ), None


def _observe_entries(
    snapshot: DependencySnapshot,
    manager: _ManagerAdapter,
    entries: Iterable[_Entry],
    *,
    registry: RegistryAdapter,
    target_versions: TargetVersionAdapter,
) -> ObservationResult:
    candidates: List[DependencyCandidate] = []
    unchanged: List[str] = []
    for entry in entries:
        if manager.name is ManagerName.GO_MODULES:
            if stable_go_version(entry.current_version) is None:
                return _insufficient(
                    f"locked Go version for {entry.package} must be a canonical stable release"
                )
        elif _parse_version(entry.current_version) is None:
            return _insufficient(f"locked version for {entry.package} is not safely parseable")
        if manager.name is ManagerName.NPM:
            if _NPM_PACKAGE.fullmatch(entry.package) is None:
                return _insufficient(
                    f"npm package name is outside npm_package_lock_only_v1: {entry.package}"
                )
            if _EXACT_NPM_SEMVER.fullmatch(entry.current_version) is None:
                return _insufficient(
                    f"locked npm version for {entry.package} must be exact semver"
                )
            if _UNSAFE_NPM_SPECIFIER.match(entry.specifier):
                return _insufficient(
                    f"{entry.package} uses an unsupported local or alias specifier"
                )
            current_matches, constraint_error = npm_constraint_matches(
                entry.specifier, entry.current_version
            )
            if constraint_error is not None:
                return _insufficient(
                    f"unsupported npm semver constraint for {entry.package}: {constraint_error}"
                )
            if not current_matches:
                return _insufficient(
                    f"locked version for {entry.package} does not satisfy its npm semver constraint"
                )
        if manager.name is ManagerName.GO_MODULES:
            source_for = getattr(registry, "package_metadata_source_url", None)
            if not callable(source_for):
                return _insufficient(
                    f"Go registry source identity for {entry.package} is unavailable"
                )
            try:
                source_url = source_for(entry.package)
            except Exception as exc:
                return _insufficient(
                    f"Go registry source identity for {entry.package} is unavailable: {exc}"
                )
            if source_url != go_proxy_list_url(entry.package):
                return _insufficient(
                    f"Go registry source identity for {entry.package} is not canonical"
                )
        try:
            metadata = registry.package_metadata(entry.package)
        except Exception as exc:
            return _insufficient(f"registry data for {entry.package} is unavailable: {exc}")
        if metadata is None or not metadata.available_versions:
            return _insufficient(f"registry data for {entry.package} is unavailable")
        if manager.name is ManagerName.GO_MODULES:
            if metadata.yanked_versions:
                return _insufficient(
                    f"Go proxy data for {entry.package} contains unsupported yanked metadata"
                )
            try:
                proxy_versions = validate_go_proxy_versions(
                    entry.package, metadata.available_versions
                )
            except ValueError as exc:
                return _insufficient(
                    f"Go proxy data for {entry.package} is malformed: {exc}"
                )
            if entry.current_version not in proxy_versions:
                return _insufficient(
                    "Go proxy data for "
                    f"{entry.package} does not contain the exact locked current version"
                )
            available = same_go_major_versions(
                entry.current_version, proxy_versions
            )
            if not any(
                compare_go_versions(entry.current_version, version) < 0
                for version in available
            ):
                unchanged.append(entry.package)
                continue
        elif manager.name is ManagerName.UV:
            available = tuple(
                version
                for version in metadata.available_versions
                if _uv_release(version) is not None
            )
            if not available:
                return _insufficient(
                    f"registry versions for {entry.package} contain no stable numeric releases"
                )
        else:
            available = tuple(metadata.available_versions)
            if any(_parse_version(version) is None for version in available):
                return _insufficient(f"registry versions for {entry.package} are unparseable")
            if manager.name is ManagerName.NPM:
                compatible = tuple(
                    version
                    for version in available
                    if not _parse_version(version)[3]
                    and npm_constraint_matches(entry.specifier, version) == (True, None)
                )
                if not any(
                    _compare_versions(entry.current_version, version) < 0
                    for version in compatible
                ):
                    unchanged.append(entry.package)
                    continue
                available = compatible
        if manager.name is ManagerName.CARGO:
            if entry.current_version not in available:
                return _insufficient(
                    f"registry data for {entry.package} does not contain the exact locked Cargo version"
                )
            yanked = set(metadata.yanked_versions)
            if entry.current_version in yanked:
                return _insufficient(f"locked Cargo version for {entry.package} is yanked")
            available = tuple(version for version in available if version not in yanked)
            if not available:
                return _insufficient(f"registry data for {entry.package} has no non-yanked releases")
            if stable_version(entry.current_version) is None:
                return _insufficient(f"locked Cargo version for {entry.package} must be stable semver")
            current_matches, constraint_error = cargo_constraint_matches(entry.specifier, entry.current_version)
            if constraint_error is not None or not current_matches:
                return _insufficient(f"locked Cargo version for {entry.package} does not satisfy its Cargo semver constraint")
            compatible = tuple(
                version
                for version in available
                if cargo_constraint_matches(entry.specifier, version) == (True, None)
            )
            if not compatible:
                return _insufficient(f"registry data for {entry.package} has no compatible stable Cargo releases")
            available = compatible
        try:
            target = target_versions.choose_target_version(
                entry.package,
                entry.current_version,
                entry.specifier,
                available,
            )
        except Exception as exc:
            return _insufficient(f"target version for {entry.package} is unavailable: {exc}")
        if manager.name is ManagerName.GO_MODULES:
            target_is_parseable = stable_go_version(target) is not None
        else:
            target_is_parseable = _parse_version(target) is not None
        if target is None or target not in available or not target_is_parseable:
            return _insufficient(f"target version for {entry.package} is unavailable")
        if (
            manager.name is ManagerName.NPM
            and _EXACT_NPM_SEMVER.fullmatch(target) is None
        ):
            return _insufficient(
                f"target npm version for {entry.package} must be exact semver"
            )
        if manager.name is ManagerName.UV:
            floor = entry.specifier[2:]
            if _uv_release(target) is None or _compare_uv_releases(target, floor) < 0:
                return _insufficient(f"target version for {entry.package} violates pyproject.toml")
        if manager.name is ManagerName.CARGO:
            target_matches, constraint_error = cargo_constraint_matches(entry.specifier, target)
            if constraint_error is not None or not target_matches:
                return _insufficient(f"target version for {entry.package} does not satisfy its Cargo semver constraint")
        if manager.name is ManagerName.GO_MODULES:
            version_error = validate_go_module_version(entry.package, target)
            if version_error is not None:
                return _insufficient(
                    f"target Go version for {entry.package} is invalid: {version_error}"
                )
            comparison = compare_go_versions(entry.current_version, target)
        else:
            comparison = _compare_versions(entry.current_version, target)
        if comparison == 0:
            unchanged.append(entry.package)
            continue
        if comparison > 0:
            return _insufficient(f"target version for {entry.package} is older than the locked version")
        candidates.append(_make_candidate(snapshot, manager, entry, target))
    if candidates:
        return CandidatesResult(candidates=tuple(candidates), reasons=tuple(f"unchanged: {name}" for name in unchanged))
    return UnchangedResult(reasons=tuple(f"unchanged: {name}" for name in unchanged))


def _make_candidate(
    snapshot: DependencySnapshot, manager: _ManagerAdapter, entry: _Entry, target: str
) -> DependencyCandidate:
    payload = {
        "baseline_sha": snapshot.baseline_sha,
        "current_version": entry.current_version,
        "dependency_kind": entry.kind,
        "lockfile_path": entry.lockfile_path,
        "manifest_path": entry.manifest_path,
        "package": entry.package,
        "package_manager": manager.name.value,
        "specifier": entry.specifier,
        "target_version": target,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manager_id = ManagerId(manager.name.value)
    plan = COMMAND_PLANS[manager_id]
    save_flag = npm_save_flag(entry.kind) if manager.name is ManagerName.NPM else None
    render = lambda command: (
        " ".join(command)
        .replace("{dependency}", entry.package)
        .replace("{version}", target)
        .replace("{save_flag}", save_flag or "")
    )
    verification_commands = (
        (render(plan.verify),)
        if manager.name is ManagerName.NPM
        else (render(plan.install), render(plan.verify))
    )
    fingerprint = f"sha256:{digest}"
    adapter_profile = {
        ManagerName.NPM: NPM_ADAPTER_PROFILE,
        ManagerName.CARGO: CARGO_ADAPTER_PROFILE,
    }.get(manager.name)
    adapter_fingerprint = (
        adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint,
            ecosystem=manager.ecosystem,
            package_manager=manager.name.value,
            adapter_profile=adapter_profile,
        )
        if adapter_profile is not None
        else None
    )
    return DependencyCandidate(
        package=entry.package,
        dependency_kind=entry.kind,
        specifier=entry.specifier,
        current_version=entry.current_version,
        target_version=target,
        manifest_path=entry.manifest_path,
        lockfile_path=entry.lockfile_path,
        baseline_sha=snapshot.baseline_sha,
        fingerprint=fingerprint,
        ecosystem=manager.ecosystem,
        package_manager=manager.name.value,
        adapter_profile=adapter_profile,
        adapter_identity_fingerprint=adapter_fingerprint,
        verification_commands=verification_commands,
        manager_commands={
            "version": " ".join(_manager_version_command(manager_id)),
            "install": render(plan.install),
            "update": render(plan.upgrade),
        },
    )


def _manager_version_command(manager: ManagerId) -> Tuple[str, ...]:
    if manager is ManagerId.GO_MODULES:
        return ("go", "version")
    return (COMMAND_PLANS[manager].install[0], "--version")


def _toml_mapping(text: str, label: str) -> Tuple[Mapping[str, Any], Optional[str]]:
    if tomllib is None:
        return {}, f"{label} cannot be parsed on this Python runtime"
    if not isinstance(text, str):
        return {}, f"{label} is not text"
    try:
        value = tomllib.loads(text)
    except (TypeError, ValueError, tomllib.TOMLDecodeError) as exc:
        return {}, f"{label} is malformed: {exc}"
    if not isinstance(value, dict):
        return {}, f"{label} must contain a table"
    return value, None


def _normalise_files(files: Mapping[str, str]) -> Dict[str, str]:
    normalised: Dict[str, str] = {}
    for raw_path, text in files.items():
        if not isinstance(raw_path, str):
            raise ValueError("file paths must be strings")
        path = raw_path.replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        if (
            not path
            or path.startswith("/")
            or re.match(r"^[A-Za-z]:/", path)
            or ".." in path.split("/")
        ):
            raise ValueError(f"unsafe repository path: {raw_path}")
        if path in normalised:
            raise ValueError(f"repository path collision after normalization: {path}")
        normalised[path] = text
    return normalised


def _unsupported_local_specifier(specifier: str) -> bool:
    return specifier.startswith(("file:", "link:", "workspace:", "npm:", "git+", "git:", "path:", "http:"))


def _parse_version(value: str) -> Optional[Tuple[int, int, int, Tuple[str, ...]]]:
    if not isinstance(value, str):
        return None
    match = _SEMVER.fullmatch(value.strip())
    if not match:
        return None
    return (
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
        tuple(match.group(4).split(".")) if match.group(4) else (),
    )


def _normalise_version(value: str) -> str:
    return value[1:] if value.startswith("v") else value


def _compare_versions(left: str, right: str) -> int:
    a = _parse_version(left)
    b = _parse_version(right)
    assert a is not None and b is not None
    if a[:3] != b[:3]:
        return -1 if a[:3] < b[:3] else 1
    if not a[3] and not b[3]:
        return 0
    if not a[3]:
        return 1
    if not b[3]:
        return -1
    return -1 if a[3] < b[3] else (1 if a[3] > b[3] else 0)


def _insufficient(reason: str) -> InsufficientEvidenceResult:
    return InsufficientEvidenceResult(reasons=(reason.removeprefix("insufficient: "),))


def _unsupported(reason: str) -> UnsupportedResult:
    return UnsupportedResult(reasons=(reason.removeprefix("unsupported: "),))
