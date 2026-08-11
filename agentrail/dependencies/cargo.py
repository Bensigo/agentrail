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
CARGO_STABLE_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_CARGO_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CARET = re.compile(r"^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


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
    if not isinstance(value, str):
        return None
    matched = CARGO_STABLE_SEMVER.fullmatch(value)
    return tuple(int(part) for part in matched.groups()) if matched else None  # type: ignore[return-value]


def cargo_constraint_matches(requirement: object, version: object) -> Tuple[bool, str | None]:
    """Accept only the v1 stable caret subset of Cargo's requirement grammar."""
    if not isinstance(requirement, str):
        return False, "Cargo dependency requirement is not text"
    matched = _CARET.fullmatch(requirement)
    actual = stable_version(version)
    if not matched or actual is None:
        return False, "Cargo v1 supports only stable ^MAJOR.MINOR.PATCH requirements and releases"
    lower = tuple(int(part) for part in matched.groups())
    if actual < lower:
        return False, None
    major, minor, patch = lower
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
    if not isinstance(document, dict) or document.get("version") not in {3, 4}:
        raise ValueError("Cargo v1 supports Cargo.lock version 3 or 4 only")
    raw_packages = document.get("package")
    if not isinstance(raw_packages, list) or not raw_packages:
        raise ValueError("Cargo.lock has no package entries")
    if len(raw_packages) > CARGO_LOCK_MAX_PACKAGES:
        raise ValueError("Cargo.lock exceeds the package limit")

    packages: Dict[str, CargoLockedPackage] = {}
    roots: list[CargoLockedPackage] = []
    edge_count = 0
    for raw in raw_packages:
        if not isinstance(raw, dict):
            raise ValueError("Cargo.lock contains malformed package entries")
        name, version = raw.get("name"), raw.get("version")
        if not isinstance(name, str) or _CARGO_NAME.fullmatch(name) is None or stable_version(version) is None:
            raise ValueError("Cargo.lock package name or version is unsupported")
        dependencies = raw.get("dependencies", [])
        if not isinstance(dependencies, list) or any(not isinstance(value, str) for value in dependencies):
            raise ValueError("Cargo.lock dependency graph is malformed")
        edge_count += len(dependencies)
        if edge_count > CARGO_LOCK_MAX_EDGES:
            raise ValueError("Cargo.lock exceeds the dependency-edge limit")
        dependency_names: list[str] = []
        for value in dependencies:
            dependency = value.split(" ", 1)[0]
            if _CARGO_NAME.fullmatch(dependency) is None:
                raise ValueError("Cargo.lock dependency graph has an unsupported edge")
            dependency_names.append(dependency)
        if len(set(dependency_names)) != len(dependency_names):
            raise ValueError("Cargo.lock dependency graph has duplicate edges")
        source, checksum = raw.get("source"), raw.get("checksum")
        package = CargoLockedPackage(name, version, tuple(dependency_names), source, checksum)
        if source is None and checksum is None:
            roots.append(package)
        elif source != CARGO_CRATES_IO_SOURCE or not isinstance(checksum, str) or _SHA256.fullmatch(checksum) is None:
            raise ValueError("Cargo.lock registry entries must name crates.io and contain a 64-hex checksum field")
        else:
            if name in packages:
                raise ValueError(f"Cargo.lock has multiple resolutions for {name}")
            packages[name] = package
    if len(roots) != 1:
        raise ValueError("Cargo.lock must contain exactly one local root package")
    root = roots[0]
    if root.name in packages:
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
