"""Closed Cargo lockfile profile primitives.

This module is deliberately data-only. It validates the syntax and internal
consistency of one supplied root Cargo lock graph; it neither authenticates a
checksum nor invokes Cargo or discovers configuration outside the snapshot.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Dict, Mapping, Tuple

try:
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None  # type: ignore[assignment]


CARGO_CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
CARGO_MANIFEST_MAX_BYTES = 256 * 1024
CARGO_LOCK_MAX_BYTES = 8 * 1024 * 1024
CARGO_LOCK_MAX_PACKAGES = 20_000
CARGO_LOCK_MAX_EDGES = 100_000
CARGO_NAME_MAX_LENGTH = 64
CARGO_VERSION_MAX_LENGTH = 128
CARGO_VERSION_COMPONENT_MAX_DIGITS = 16
CARGO_MAX_SAFE_INTEGER = 9_007_199_254_740_991
CARGO_STABLE_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_CARGO_ROOT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_CARGO_REGISTRY_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_CARGO_WINDOWS_RESERVED = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.IGNORECASE
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class CargoLockedPackage:
    name: str
    version: str
    dependencies: Tuple[str, ...]
    source: str | None
    checksum: str | None


@dataclass(frozen=True)
class CargoLockGraph:
    root: CargoLockedPackage
    packages: Mapping[str, CargoLockedPackage]


def stable_version(value: object) -> Tuple[int, int, int] | None:
    if not isinstance(value, str) or len(value) > CARGO_VERSION_MAX_LENGTH:
        return None
    matched = CARGO_STABLE_SEMVER.fullmatch(value)
    if matched is None:
        return None
    parts = matched.groups()
    if any(len(part) > CARGO_VERSION_COMPONENT_MAX_DIGITS for part in parts):
        return None
    parsed = tuple(int(part) for part in parts)
    if any(part > CARGO_MAX_SAFE_INTEGER for part in parsed):
        return None
    return parsed[0], parsed[1], parsed[2]


def cargo_root_package_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= CARGO_NAME_MAX_LENGTH
        and _CARGO_ROOT_NAME.fullmatch(value) is not None
        and _CARGO_WINDOWS_RESERVED.fullmatch(value) is None
    )


def cargo_registry_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= CARGO_NAME_MAX_LENGTH
        and _CARGO_REGISTRY_NAME.fullmatch(value) is not None
        and _CARGO_WINDOWS_RESERVED.fullmatch(value) is None
    )


def cargo_normalized_name(value: str) -> str:
    return value.replace("_", "-")


def cargo_constraint_matches(requirement: object, version: object) -> Tuple[bool, str | None]:
    """Accept only the v1 stable caret subset of Cargo's requirement grammar."""
    if not isinstance(requirement, str):
        return False, "Cargo dependency requirement is not text"
    actual_floor = stable_version(requirement[1:]) if requirement.startswith("^") else None
    actual = stable_version(version)
    if actual_floor is None or actual is None:
        return False, "Cargo v1 supports only stable ^MAJOR.MINOR.PATCH requirements and releases"
    lower = actual_floor
    if actual < lower:
        return False, None
    major, minor, patch = lower
    controlling_component = major if major else (minor if minor else patch)
    if controlling_component >= CARGO_MAX_SAFE_INTEGER:
        return False, "Cargo caret upper bound exceeds the cross-runtime safe-integer limit"
    upper = (major + 1, 0, 0) if major else ((0, minor + 1, 0) if minor else (0, 0, patch + 1))
    return actual < upper, None


def parse_cargo_lockfile(text: object) -> CargoLockGraph:
    if not isinstance(text, str):
        raise ValueError("Cargo.lock is not text")
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError("Cargo.lock is not valid UTF-8 text") from exc
    if size > CARGO_LOCK_MAX_BYTES:
        raise ValueError("Cargo.lock exceeds the byte limit")
    if tomllib is None:
        raise ValueError("Cargo.lock cannot be parsed on this Python runtime")
    try:
        document = tomllib.loads(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Cargo.lock is malformed: {exc}") from exc
    if not isinstance(document, dict) or set(document) != {"version", "package"}:
        raise ValueError("Cargo.lock contains unsupported top-level fields")
    if document.get("version") not in {3, 4}:
        raise ValueError("Cargo v1 supports Cargo.lock version 3 or 4 only")
    raw_packages = document.get("package")
    if not isinstance(raw_packages, list) or not raw_packages:
        raise ValueError("Cargo.lock has no package entries")
    if len(raw_packages) > CARGO_LOCK_MAX_PACKAGES:
        raise ValueError("Cargo.lock exceeds the package limit")

    packages: Dict[str, CargoLockedPackage] = {}
    normalized_packages: set[str] = set()
    roots: list[CargoLockedPackage] = []
    edge_count = 0
    for raw in raw_packages:
        if not isinstance(raw, dict):
            raise ValueError("Cargo.lock contains malformed package entries")
        source, checksum = raw.get("source"), raw.get("checksum")
        is_root = source is None and checksum is None
        allowed_keys = {"name", "version", "dependencies"} if is_root else {
            "name", "version", "source", "checksum", "dependencies"
        }
        required_keys = {"name", "version"} if is_root else {
            "name", "version", "source", "checksum"
        }
        if not required_keys.issubset(raw):
            raise ValueError("Cargo.lock registry package is missing source or checksum fields")
        if not set(raw).issubset(allowed_keys):
            raise ValueError("Cargo.lock package entry contains unsupported fields")
        name, version = raw.get("name"), raw.get("version")
        name_is_valid = cargo_root_package_name(name) if is_root else cargo_registry_name(name)
        if not name_is_valid or stable_version(version) is None:
            raise ValueError("Cargo.lock package name or version is unsupported")
        dependencies = raw.get("dependencies", [])
        if not isinstance(dependencies, list) or any(not isinstance(value, str) for value in dependencies):
            raise ValueError("Cargo.lock dependency graph is malformed")
        edge_count += len(dependencies)
        if edge_count > CARGO_LOCK_MAX_EDGES:
            raise ValueError("Cargo.lock exceeds the dependency-edge limit")
        dependency_names: list[str] = []
        for value in dependencies:
            dependency = value
            if not cargo_registry_name(dependency):
                raise ValueError("Cargo.lock dependency graph has an unsupported edge")
            dependency_names.append(dependency)
        if len(set(dependency_names)) != len(dependency_names):
            raise ValueError("Cargo.lock dependency graph has duplicate edges")
        package = CargoLockedPackage(name, version, tuple(dependency_names), source, checksum)
        if is_root:
            roots.append(package)
        elif source != CARGO_CRATES_IO_SOURCE or not isinstance(checksum, str) or _SHA256.fullmatch(checksum) is None:
            raise ValueError("Cargo.lock registry entries must name crates.io and contain a 64-hex checksum field")
        else:
            normalized = cargo_normalized_name(name)
            if name in packages or normalized in normalized_packages:
                raise ValueError(f"Cargo.lock has multiple resolutions for {name}")
            packages[name] = package
            normalized_packages.add(normalized)
    if len(roots) != 1:
        raise ValueError("Cargo.lock must contain exactly one local root package")
    root = roots[0]
    if root.name in packages or cargo_normalized_name(root.name.lower()) in normalized_packages:
        raise ValueError("Cargo.lock root package conflicts with a registry package")
    for package in [root, *packages.values()]:
        missing = sorted(set(package.dependencies) - set(packages))
        if missing:
            raise ValueError("Cargo.lock dependency graph references an unresolved package: " + missing[0])
    reachable = {root.name}
    pending = [root]
    while pending:
        current = pending.pop()
        for dependency in current.dependencies:
            if dependency not in reachable:
                reachable.add(dependency)
                pending.append(packages[dependency])
    orphaned = sorted(set(packages) - reachable)
    if orphaned:
        raise ValueError("Cargo.lock dependency graph contains unreachable package entries: " + orphaned[0])
    return CargoLockGraph(root=root, packages=packages)
