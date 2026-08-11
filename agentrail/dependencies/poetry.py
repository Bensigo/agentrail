"""Closed Poetry root-manifest and lock-v2 custody primitives.

The parser consumes two supplied UTF-8 texts. It does not read a checkout,
discover Poetry configuration, contact a repository, emit an upgrade
candidate, or invoke Poetry. Distribution hashes are preserved as lockfile
claims; this module does not authenticate them against PyPI. It also does not
prove that the texts came from committed root files or recompute Poetry's
version-specific content hash. Those are later source-inventory boundaries.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Dict, Mapping, Optional, Tuple

try:
    import tomllib
except ImportError:  # pragma: no cover - CI and supported parsing use 3.11+.
    tomllib = None  # type: ignore[assignment]

from agentrail.dependencies.pep440 import (
    compare_stable_versions,
    parse_poetry_constraint,
    parse_stable_version,
    poetry_constraint_is_subset,
    poetry_constraint_matches,
)


POETRY_ADAPTER_PROFILE = "python:poetry:poetry_root_lock_v2_v1"
POETRY_MANIFEST_MAX_BYTES = 256 * 1024
POETRY_LOCK_MAX_BYTES = 8 * 1024 * 1024
POETRY_MAX_DIRECT_DEPENDENCIES = 2_000
POETRY_LOCK_MAX_PACKAGES = 20_000
POETRY_LOCK_MAX_FILES = 100_000
POETRY_LOCK_MAX_DEPENDENCY_EDGES = 100_000
POETRY_MAX_FILES_PER_PACKAGE = 256

_DISTRIBUTION_NAME = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$"
)
_NORMALIZE_NAME = re.compile(r"[-_.]+")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_WHEEL_TAG = r"[A-Za-z0-9](?:[A-Za-z0-9._]*[A-Za-z0-9])?"
_WHEEL_FILE = re.compile(
    r"^(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._]*[A-Za-z0-9])?)-"
    r"(?P<version>v?[0-9]+(?:\.[0-9]+)*)-"
    rf"{_WHEEL_TAG}-{_WHEEL_TAG}-{_WHEEL_TAG}\.whl$"
)
_SDIST_FILE = re.compile(
    r"^(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)-"
    r"(?P<version>v?[0-9]+(?:\.[0-9]+)*)\.tar\.gz$"
)
_LOCK_VERSIONS = {"2.0", "2.1"}
_GROUPS = {"main", "dev"}

_POETRY_METADATA_KEYS = {
    "name",
    "version",
    "description",
    "authors",
    "maintainers",
    "license",
    "readme",
    "homepage",
    "repository",
    "documentation",
    "keywords",
    "classifiers",
    "dependencies",
    "dev-dependencies",
}
_UNSUPPORTED_ROOT_KEYS = {"project", "dependency-groups", "workspace", "build-system"}
_PACKAGE_KEYS = {
    "name",
    "version",
    "description",
    "optional",
    "python-versions",
    "category",
    "groups",
    "files",
    "dependencies",
}


@dataclass(frozen=True)
class PoetryLockedFile:
    filename: str
    sha256: str
    distribution: str
    version: str
    kind: str


@dataclass(frozen=True)
class PoetryLockedPackage:
    name: str
    declared_name: str
    version: str
    groups: Tuple[str, ...]
    files: Tuple[PoetryLockedFile, ...]
    dependencies: Tuple[str, ...]


@dataclass(frozen=True)
class PoetryDirectDependency:
    name: str
    declared_name: str
    kind: str
    constraint: str
    locked_version: str


@dataclass(frozen=True)
class PoetryRootLockProfile:
    adapter_profile: str
    root_name: str
    root_version: str
    python_constraint: str
    lock_version: str
    content_hash: str
    direct_dependencies: Tuple[PoetryDirectDependency, ...]
    locked_packages: Tuple[PoetryLockedPackage, ...]


@dataclass(frozen=True)
class _ManifestDependency:
    name: str
    declared_name: str
    kind: str
    constraint: str


@dataclass(frozen=True)
class _ParsedLockedPackage:
    public: PoetryLockedPackage
    constraints: Mapping[str, str]


def normalize_pep503_name(value: object) -> str:
    """Normalize one admitted ASCII distribution name per the PEP 503 rule."""

    if not isinstance(value, str) or _DISTRIBUTION_NAME.fullmatch(value) is None:
        raise ValueError(f"unsupported Python distribution name: {value}")
    return _NORMALIZE_NAME.sub("-", value).lower()


def parse_poetry_root_lock(
    pyproject_text: object, poetry_lock_text: object
) -> PoetryRootLockProfile:
    """Parse one unambiguous legacy Poetry root and one committed lock v2."""

    manifest = _parse_toml(
        pyproject_text,
        document="pyproject.toml",
        maximum_bytes=POETRY_MANIFEST_MAX_BYTES,
    )
    lock = _parse_toml(
        poetry_lock_text,
        document="poetry.lock",
        maximum_bytes=POETRY_LOCK_MAX_BYTES,
    )
    root_name, root_version, python_constraint, direct = _parse_manifest(manifest)
    lock_version, content_hash, packages = _parse_lock(lock, python_constraint)
    packages_by_name = {package.public.name: package for package in packages}
    if root_name in packages_by_name:
        raise ValueError("poetry.lock contains a package that collides with the root project")

    public_direct: list[PoetryDirectDependency] = []
    for dependency in direct:
        locked = packages_by_name.get(dependency.name)
        if locked is None:
            raise ValueError(
                f"poetry.lock has no resolution for direct dependency: {dependency.name}"
            )
        if dependency.kind not in locked.public.groups:
            raise ValueError(
                f"poetry.lock group does not match direct dependency kind: {dependency.name}"
            )
        matches, error = poetry_constraint_matches(
            dependency.constraint, locked.public.version
        )
        if error is not None or not matches:
            raise ValueError(
                f"poetry.lock version does not satisfy the direct constraint: {dependency.name}"
            )
        public_direct.append(
            PoetryDirectDependency(
                name=dependency.name,
                declared_name=dependency.declared_name,
                kind=dependency.kind,
                constraint=dependency.constraint,
                locked_version=locked.public.version,
            )
        )

    _validate_lock_graph(packages_by_name, tuple(public_direct))
    return PoetryRootLockProfile(
        adapter_profile=POETRY_ADAPTER_PROFILE,
        root_name=root_name,
        root_version=root_version,
        python_constraint=python_constraint,
        lock_version=lock_version,
        content_hash=content_hash,
        direct_dependencies=tuple(public_direct),
        locked_packages=tuple(
            item.public for item in sorted(packages, key=lambda package: package.public.name)
        ),
    )


def _parse_manifest(
    document: Mapping[str, Any],
) -> Tuple[str, str, str, Tuple[_ManifestDependency, ...]]:
    unsafe_root = sorted(set(document) & _UNSUPPORTED_ROOT_KEYS)
    if unsafe_root:
        raise ValueError(
            "pyproject.toml uses unsupported project, workspace, dependency-group, "
            "or build metadata: " + unsafe_root[0]
        )
    tool = document.get("tool")
    poetry = tool.get("poetry") if isinstance(tool, dict) else None
    if not isinstance(poetry, dict):
        raise ValueError("pyproject.toml has no [tool.poetry] root")
    unknown = sorted(set(poetry) - _POETRY_METADATA_KEYS)
    if unknown:
        raise ValueError(
            "pyproject.toml contains unsupported Poetry metadata or configuration: "
            + unknown[0]
        )

    root_name = normalize_pep503_name(poetry.get("name"))
    root_version_value = poetry.get("version")
    if parse_stable_version(root_version_value) is None:
        raise ValueError("pyproject.toml root version is outside the stable PEP 440 subset")
    assert isinstance(root_version_value, str)

    main = poetry.get("dependencies")
    dev = poetry.get("dev-dependencies", {})
    if not isinstance(main, dict) or not isinstance(dev, dict):
        raise ValueError("Poetry direct dependency sections must be TOML tables")

    direct: list[_ManifestDependency] = []
    identities: Dict[str, str] = {}
    python_constraint: Optional[str] = None
    for kind, values in (("main", main), ("dev", dev)):
        for declared_name, raw_constraint in sorted(values.items()):
            name = normalize_pep503_name(declared_name)
            if name == "python":
                if kind != "main" or python_constraint is not None:
                    raise ValueError(
                        "Poetry Python compatibility must appear once in main dependencies"
                    )
                if not isinstance(raw_constraint, str):
                    raise ValueError("Poetry Python compatibility must be a version string")
                parse_poetry_constraint(raw_constraint)
                python_constraint = raw_constraint
                continue
            previous = identities.get(name)
            if previous is not None:
                raise ValueError(
                    "Poetry direct dependency identity appears in both "
                    f"{previous} and {kind}: {name}"
                )
            if not isinstance(raw_constraint, str):
                raise ValueError(
                    f"Poetry dependency must use a plain registry version string: {name}"
                )
            parse_poetry_constraint(raw_constraint)
            identities[name] = kind
            direct.append(
                _ManifestDependency(name, declared_name, kind, raw_constraint)
            )
            if len(direct) > POETRY_MAX_DIRECT_DEPENDENCIES:
                raise ValueError("pyproject.toml exceeds the direct dependency limit")
    if python_constraint is None:
        raise ValueError("pyproject.toml must declare one Python compatibility constraint")
    if not direct:
        raise ValueError("pyproject.toml has no admitted direct dependencies")
    return root_name, root_version_value, python_constraint, tuple(direct)


def _parse_lock(
    document: Mapping[str, Any], python_constraint: str
) -> Tuple[str, str, Tuple[_ParsedLockedPackage, ...]]:
    if set(document) != {"package", "metadata"}:
        raise ValueError("poetry.lock contains unsupported top-level metadata")
    metadata = document.get("metadata")
    if not isinstance(metadata, dict) or set(metadata) != {
        "lock-version",
        "python-versions",
        "content-hash",
    }:
        raise ValueError("poetry.lock metadata is incomplete or unsupported")
    lock_version = metadata.get("lock-version")
    if lock_version not in _LOCK_VERSIONS:
        raise ValueError("Poetry v1 supports lock format 2.0 or 2.1 only")
    if metadata.get("python-versions") != python_constraint:
        raise ValueError("poetry.lock Python compatibility does not match pyproject.toml")
    content_hash = metadata.get("content-hash")
    if not isinstance(content_hash, str) or _SHA256.fullmatch(content_hash) is None:
        raise ValueError("poetry.lock metadata must contain one lowercase SHA-256 content hash")

    raw_packages = document.get("package")
    if not isinstance(raw_packages, list) or not raw_packages:
        raise ValueError("poetry.lock has no package entries")
    if len(raw_packages) > POETRY_LOCK_MAX_PACKAGES:
        raise ValueError("poetry.lock exceeds the package limit")

    packages: list[_ParsedLockedPackage] = []
    names: set[str] = set()
    total_files = 0
    total_edges = 0
    for raw in raw_packages:
        if not isinstance(raw, dict):
            raise ValueError("poetry.lock contains a malformed package entry")
        unknown = sorted(set(raw) - _PACKAGE_KEYS)
        if unknown:
            raise ValueError(
                "poetry.lock package uses unsupported source, marker, extra, or metadata: "
                + unknown[0]
            )
        declared_name = raw.get("name")
        name = normalize_pep503_name(declared_name)
        if name in names:
            raise ValueError(f"poetry.lock contains multiple resolutions for {name}")
        names.add(name)
        version = raw.get("version")
        if parse_stable_version(version) is None:
            raise ValueError(
                f"poetry.lock version is outside the stable PEP 440 subset: {name}"
            )
        if not isinstance(raw.get("description"), str):
            raise ValueError(f"poetry.lock package description is malformed: {name}")
        if raw.get("optional") is not False:
            raise ValueError(f"poetry.lock optional packages are unsupported: {name}")
        package_python = raw.get("python-versions")
        if not isinstance(package_python, str):
            raise ValueError(f"poetry.lock package Python constraint is malformed: {name}")
        parse_poetry_constraint(package_python)
        contains_root, containment_error = poetry_constraint_is_subset(
            python_constraint, package_python
        )
        if containment_error is not None:
            raise ValueError(
                f"poetry.lock package Python containment cannot be proven: {name}: "
                + containment_error
            )
        if not contains_root:
            raise ValueError(
                f"poetry.lock package does not contain the root Python range: {name}"
            )
        groups = _parse_groups(raw, lock_version, name)
        assert isinstance(version, str)
        files = _parse_files(raw.get("files"), name, version)
        total_files += len(files)
        if total_files > POETRY_LOCK_MAX_FILES:
            raise ValueError("poetry.lock exceeds the distribution-file limit")
        constraints = _parse_locked_dependencies(raw.get("dependencies", {}), name)
        total_edges += len(constraints)
        if total_edges > POETRY_LOCK_MAX_DEPENDENCY_EDGES:
            raise ValueError("poetry.lock exceeds the dependency-edge limit")
        assert isinstance(declared_name, str)
        packages.append(
            _ParsedLockedPackage(
                public=PoetryLockedPackage(
                    name=name,
                    declared_name=declared_name,
                    version=version,
                    groups=groups,
                    files=files,
                    dependencies=tuple(sorted(constraints)),
                ),
                constraints=constraints,
            )
        )
    return lock_version, content_hash, tuple(packages)


def _parse_groups(raw: Mapping[str, Any], lock_version: str, name: str) -> Tuple[str, ...]:
    if lock_version == "2.1":
        if "category" in raw:
            raise ValueError(f"Poetry lock 2.1 package cannot use category: {name}")
        groups = raw.get("groups")
        if (
            not isinstance(groups, list)
            or not groups
            or any(not isinstance(group, str) or group not in _GROUPS for group in groups)
            or len(set(groups)) != len(groups)
        ):
            raise ValueError(f"Poetry lock 2.1 package groups are unsupported: {name}")
        return tuple(sorted(groups))
    if "groups" in raw:
        raise ValueError(f"Poetry lock 2.0 package cannot use groups: {name}")
    category = raw.get("category")
    if category not in _GROUPS:
        raise ValueError(f"Poetry lock 2.0 package category is unsupported: {name}")
    assert isinstance(category, str)
    return (category,)


def _parse_files(
    value: object, package: str, package_version: str
) -> Tuple[PoetryLockedFile, ...]:
    if (
        not isinstance(value, list)
        or not value
        or len(value) > POETRY_MAX_FILES_PER_PACKAGE
    ):
        raise ValueError(f"poetry.lock package files are missing or exceed the limit: {package}")
    files: list[PoetryLockedFile] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict) or set(raw) != {"file", "hash"}:
            raise ValueError(f"poetry.lock package file entry is malformed: {package}")
        filename = raw.get("file")
        digest = raw.get("hash")
        if (
            not isinstance(filename, str)
            or len(filename) > 512
            or not filename.isascii()
            or "/" in filename
            or "\\" in filename
            or filename in seen
        ):
            raise ValueError(f"poetry.lock package filename is unsafe or duplicated: {package}")
        if (
            not isinstance(digest, str)
            or not digest.startswith("sha256:")
            or _SHA256.fullmatch(digest[7:]) is None
        ):
            raise ValueError(f"poetry.lock package file lacks a lowercase SHA-256 hash: {package}")
        kind, distribution, artifact_version = _parse_distribution_filename(
            filename, package
        )
        if distribution != package:
            raise ValueError(
                f"poetry.lock file distribution does not match package: {package}"
            )
        if compare_stable_versions(artifact_version, package_version) != 0:
            raise ValueError(
                f"poetry.lock file version does not match package: {package}"
            )
        seen.add(filename)
        files.append(
            PoetryLockedFile(
                filename=filename,
                sha256=digest[7:],
                distribution=distribution,
                version=artifact_version,
                kind=kind,
            )
        )
    return tuple(files)


def _parse_distribution_filename(filename: str, package: str) -> Tuple[str, str, str]:
    wheel = _WHEEL_FILE.fullmatch(filename)
    sdist = _SDIST_FILE.fullmatch(filename)
    matched = wheel or sdist
    if matched is None:
        raise ValueError(
            f"poetry.lock package has an unsupported wheel or sdist filename: {package}"
        )
    distribution = normalize_pep503_name(matched.group("name"))
    version = matched.group("version")
    if parse_stable_version(version) is None:
        raise ValueError(
            f"poetry.lock package filename version is unsupported: {package}"
        )
    return "wheel" if wheel is not None else "sdist", distribution, version


def _parse_locked_dependencies(value: object, package: str) -> Dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError(f"poetry.lock dependency table is malformed: {package}")
    constraints: Dict[str, str] = {}
    for declared_name, constraint in value.items():
        name = normalize_pep503_name(declared_name)
        if name in constraints:
            raise ValueError(
                "poetry.lock dependency table has duplicate normalized identity: "
                f"{package} -> {name}"
            )
        if not isinstance(constraint, str):
            raise ValueError(
                "poetry.lock dependency markers, extras, and multiple constraints "
                f"are unsupported: {package} -> {name}"
            )
        parse_poetry_constraint(constraint)
        constraints[name] = constraint
    return constraints


def _validate_lock_graph(
    packages: Mapping[str, _ParsedLockedPackage],
    roots: Tuple[PoetryDirectDependency, ...],
) -> None:
    for package in packages.values():
        for dependency, constraint in package.constraints.items():
            if dependency == package.public.name:
                raise ValueError(f"poetry.lock dependency graph contains a self edge: {dependency}")
            target = packages.get(dependency)
            if target is None:
                raise ValueError(
                    f"poetry.lock dependency graph references an unresolved package: {dependency}"
                )
            matches, error = poetry_constraint_matches(constraint, target.public.version)
            if error is not None or not matches:
                raise ValueError(
                    "poetry.lock dependency graph constraint is not satisfied: "
                    f"{package.public.name} -> {dependency}"
                )

    reachable = {(root.name, root.kind) for root in roots}
    pending = list(reachable)
    while pending:
        name, group = pending.pop()
        package = packages[name]
        for dependency in package.public.dependencies:
            target = packages[dependency]
            if group not in target.public.groups:
                raise ValueError(
                    "poetry.lock dependency graph loses group custody: "
                    f"{name} -> {dependency} ({group})"
                )
            identity = (dependency, group)
            if identity not in reachable:
                reachable.add(identity)
                pending.append(identity)
    reached_groups: Dict[str, set[str]] = {}
    for name, group in reachable:
        reached_groups.setdefault(name, set()).add(group)
    orphaned = sorted(set(packages) - set(reached_groups))
    if orphaned:
        raise ValueError(
            "poetry.lock contains an unreachable package entry: " + orphaned[0]
        )
    for name, package in packages.items():
        if set(package.public.groups) != reached_groups[name]:
            raise ValueError(
                "poetry.lock package has group membership not proven by the root graph: "
                + name
            )


def _parse_toml(
    value: object, *, document: str, maximum_bytes: int
) -> Mapping[str, Any]:
    if not isinstance(value, str):
        raise ValueError(f"{document} is not text")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError(f"{document} is not valid UTF-8 text") from exc
    if size > maximum_bytes:
        raise ValueError(f"{document} exceeds the byte limit")
    if tomllib is None:
        raise ValueError(f"{document} cannot be parsed on this Python runtime")
    try:
        parsed = tomllib.loads(value)
    except RecursionError as exc:
        raise ValueError(f"{document} exceeds the TOML nesting limit") from exc
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{document} is malformed or contains duplicate TOML keys: {exc}"
        ) from exc
    if not isinstance(parsed, dict):  # pragma: no cover - tomllib always returns dict.
        raise ValueError(f"{document} must contain a TOML document")
    return parsed


__all__ = [
    "POETRY_ADAPTER_PROFILE",
    "POETRY_LOCK_MAX_BYTES",
    "POETRY_LOCK_MAX_DEPENDENCY_EDGES",
    "POETRY_LOCK_MAX_FILES",
    "POETRY_LOCK_MAX_PACKAGES",
    "POETRY_MANIFEST_MAX_BYTES",
    "POETRY_MAX_DIRECT_DEPENDENCIES",
    "POETRY_MAX_FILES_PER_PACKAGE",
    "PoetryDirectDependency",
    "PoetryLockedFile",
    "PoetryLockedPackage",
    "PoetryRootLockProfile",
    "normalize_pep503_name",
    "parse_poetry_root_lock",
]
