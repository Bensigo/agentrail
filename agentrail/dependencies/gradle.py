"""Strict source-only custody for one deliberately narrow Gradle graph.

The v1 profile accepts supplied text for one root Groovy ``build.gradle``, the
root ``gradle.lockfile``, ``gradle/wrapper/gradle-wrapper.properties``, and a
profile-owned ``jace-gradle-resolution-v1.json`` artifact.  It uses a tiny
line grammar; it never evaluates Groovy, invokes Gradle, authenticates remote
bytes, discovers repository configuration, or grants execution/evidence
authority.

Successful parsing proves only that the supplied UTF-8 bytes are mutually
bound and internally consistent.  In particular, absence of settings files,
buildSrc, version catalogs, subprojects, composite builds, init scripts, and
other configuration remains unresolved without a separate inventory receipt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import re
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional, Tuple

from agentrail.dependencies.strict_json import loads_strict_json


GRADLE_BUILD_PATH = "build.gradle"
GRADLE_LOCK_PATH = "gradle.lockfile"
GRADLE_WRAPPER_PROPERTIES_PATH = "gradle/wrapper/gradle-wrapper.properties"
GRADLE_RESOLUTION_ARTIFACT_PATH = "jace-gradle-resolution-v1.json"
GRADLE_RESOLUTION_PROFILE = "jace-gradle-resolution-v1"
GRADLE_CENTRAL_REPOSITORY = "https://repo.maven.apache.org/maven2"
GRADLE_REQUIRED_SOURCE_PATHS = (
    GRADLE_BUILD_PATH,
    GRADLE_LOCK_PATH,
    GRADLE_WRAPPER_PROPERTIES_PATH,
    GRADLE_RESOLUTION_ARTIFACT_PATH,
)

GRADLE_BUILD_MAX_BYTES = 256 * 1024
GRADLE_BUILD_MAX_LINES = 32
GRADLE_LOCK_MAX_BYTES = 8 * 1024 * 1024
GRADLE_LOCK_MAX_PACKAGES = 20_000
GRADLE_WRAPPER_PROPERTIES_MAX_BYTES = 16 * 1024
GRADLE_WRAPPER_PROPERTIES_MAX_LINES = 32
GRADLE_RESOLUTION_MAX_BYTES = 8 * 1024 * 1024
GRADLE_RESOLUTION_MAX_PACKAGES = 20_000
GRADLE_RESOLUTION_MAX_EDGES = 100_000
GRADLE_JSON_MAX_DEPTH = 16
GRADLE_INVENTORY_MAX_PATHS = 100_000
GRADLE_INVENTORY_MAX_BYTES = 8 * 1024 * 1024

GRADLE_UNRESOLVED_EVIDENCE = (
    "full_repository_inventory_and_configuration_absence",
    "gradle_wrapper_jar_and_distribution_authenticity",
    "maven_central_pom_and_artifact_authenticity",
    "gradle_runtime_and_configuration_resolution_reproduction",
    "target_update_selection_and_target_resolution",
    "security_evaluation",
)

_GROUP = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
_ARTIFACT = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_STABLE_VERSION = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)
_BUILD_DEPENDENCY = re.compile(r"^    implementation '([^']+)'$")
_WRAPPER_DISTRIBUTION_URL = re.compile(
    r"^https\\://services\.gradle\.org/distributions/gradle-"
    r"(?P<version>8\.(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2}))?)"
    r"-bin\.zip$"
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SHA512 = re.compile(r"^[0-9a-f]{128}$")
_SUPPORTED_CONFIGURATIONS = {
    "compile": ("compileClasspath", "runtimeClasspath"),
    "runtime": ("runtimeClasspath",),
}
_LOCK_HEADER = (
    "# This is a Gradle generated file for dependency locking.",
    "# Manual edits can break the build and are not advised.",
    "# This file is expected to be part of source control.",
)
_WRAPPER_PROPERTY_KEYS = {
    "distributionBase",
    "distributionPath",
    "distributionSha256Sum",
    "distributionUrl",
    "networkTimeout",
    "validateDistributionUrl",
    "zipStoreBase",
    "zipStorePath",
}


@dataclass(frozen=True, order=True)
class GradleCoordinate:
    group: str
    artifact: str
    version: str

    @property
    def key(self) -> str:
        return f"{self.group}:{self.artifact}:{self.version}"


@dataclass(frozen=True)
class GradleRoot:
    directory: str = "."
    project_path: str = ":"


@dataclass(frozen=True)
class GradleDependencyDeclaration:
    coordinate: GradleCoordinate
    configuration: str = "implementation"


@dataclass(frozen=True)
class GradleLockEntry:
    coordinate: GradleCoordinate
    configurations: Tuple[str, ...]


@dataclass(frozen=True)
class GradleWrapper:
    version: str
    distribution_url: str
    distribution_sha256: str


@dataclass(frozen=True)
class GradleResolvedPackage:
    coordinate: GradleCoordinate
    scope: str
    configurations: Tuple[str, ...]
    dependencies: Tuple[GradleCoordinate, ...]
    pom_url: str
    pom_sha512: str
    artifact_url: str
    artifact_sha512: str


@dataclass(frozen=True)
class GradleSourceProfile:
    root: GradleRoot
    direct_dependencies: Tuple[GradleDependencyDeclaration, ...]
    lock_entries: Mapping[str, GradleLockEntry]
    packages: Mapping[str, GradleResolvedPackage]
    wrapper: GradleWrapper
    source_sha256: Mapping[str, str]
    wrapper_jar_sha256: Optional[str]
    repository: str
    profile: str = field(default=GRADLE_RESOLUTION_PROFILE, init=False)
    resolution_artifact_path: str = field(
        default=GRADLE_RESOLUTION_ARTIFACT_PATH,
        init=False,
    )
    evidence_status: str = field(default="syntax_and_custody_only", init=False)
    authority: str = field(default="none", init=False)
    unresolved_evidence: Tuple[str, ...] = field(
        default=GRADLE_UNRESOLVED_EVIDENCE,
        init=False,
    )


def parse_gradle_source_profile(
    build_gradle_text: object,
    lockfile_text: object,
    wrapper_properties_text: object,
    resolution_text: object,
) -> GradleSourceProfile:
    """Validate four supplied texts without evaluating or invoking Gradle."""

    source_bytes = {
        GRADLE_BUILD_PATH: _bounded_utf8(
            build_gradle_text,
            document=GRADLE_BUILD_PATH,
            limit=GRADLE_BUILD_MAX_BYTES,
        ),
        GRADLE_LOCK_PATH: _bounded_utf8(
            lockfile_text,
            document=GRADLE_LOCK_PATH,
            limit=GRADLE_LOCK_MAX_BYTES,
        ),
        GRADLE_WRAPPER_PROPERTIES_PATH: _bounded_utf8(
            wrapper_properties_text,
            document=GRADLE_WRAPPER_PROPERTIES_PATH,
            limit=GRADLE_WRAPPER_PROPERTIES_MAX_BYTES,
        ),
        GRADLE_RESOLUTION_ARTIFACT_PATH: _bounded_utf8(
            resolution_text,
            document=GRADLE_RESOLUTION_ARTIFACT_PATH,
            limit=GRADLE_RESOLUTION_MAX_BYTES,
        ),
    }
    assert isinstance(build_gradle_text, str)
    assert isinstance(lockfile_text, str)
    assert isinstance(wrapper_properties_text, str)
    assert isinstance(resolution_text, str)

    declared = _parse_build_gradle(build_gradle_text)
    lock_entries = _parse_lockfile(lockfile_text)
    wrapper = _parse_wrapper_properties(wrapper_properties_text)
    try:
        document = loads_strict_json(
            resolution_text,
            document=GRADLE_RESOLUTION_ARTIFACT_PATH,
        )
    except RecursionError as exc:
        raise ValueError(
            f"{GRADLE_RESOLUTION_ARTIFACT_PATH} exceeds the nesting limit"
        ) from exc
    _validate_json_depth(document)

    source_sha256 = {
        path: hashlib.sha256(value).hexdigest()
        for path, value in source_bytes.items()
    }
    return _parse_resolution(
        document,
        declared=declared,
        lock_entries=lock_entries,
        wrapper=wrapper,
        source_sha256=source_sha256,
    )


def gradle_inventory_refusal(paths: object) -> Optional[str]:
    """Refuse unsupported paths in a separately supplied inventory receipt.

    ``None`` means only that the *supplied* path list fits this tiny profile.
    It does not prove that the receipt is complete, authentic, or repository
    bound; that evidence lane remains unresolved by this module.
    """

    if not isinstance(paths, (list, tuple)):
        return "Gradle inventory receipt paths must be a bounded list"
    if len(paths) > GRADLE_INVENTORY_MAX_PATHS:
        return "Gradle inventory receipt exceeds the path limit"

    total_bytes = 0
    normalized = []
    seen = set()
    seen_casefolded = set()
    for path in paths:
        if not isinstance(path, str):
            return "Gradle inventory receipt contains a non-text path"
        try:
            encoded = path.encode("utf-8")
        except UnicodeEncodeError:
            return "Gradle inventory receipt contains a non-UTF-8 path"
        total_bytes += len(encoded)
        if total_bytes > GRADLE_INVENTORY_MAX_BYTES:
            return "Gradle inventory receipt exceeds the byte limit"
        if (
            not path
            or path.startswith("/")
            or "\\" in path
            or "\x00" in path
            or path.startswith("./")
            or path.endswith("/")
            or any(part in {"", ".", ".."} for part in path.split("/"))
        ):
            return "Gradle inventory receipt contains a non-canonical path"
        folded = path.casefold()
        if path in seen or folded in seen_casefolded:
            return "Gradle inventory receipt contains duplicate or case-ambiguous paths"
        seen.add(path)
        seen_casefolded.add(folded)
        normalized.append(path)

    if normalized != sorted(normalized):
        return "Gradle inventory receipt paths must be sorted"
    missing = sorted(set(GRADLE_REQUIRED_SOURCE_PATHS) - seen)
    if missing:
        return "Gradle inventory receipt is missing required path: " + missing[0]

    for path in normalized:
        folded = path.casefold()
        parts = folded.split("/")
        name = parts[-1]
        if name == "build.gradle.kts":
            return "Gradle v1 rejects Kotlin build scripts"
        if name in {"settings.gradle", "settings.gradle.kts"}:
            return "Gradle settings and composite-build configuration remain unsupported"
        if "buildsrc" in parts:
            return "Gradle buildSrc configuration remains unsupported"
        if folded == "gradle/libs.versions.toml":
            return "Gradle version catalogs remain unsupported"
        if name == "gradle.properties":
            return "Gradle automatically consumed gradle.properties configuration remains unsupported"
        if folded == "gradle/verification-metadata.xml" or folded.endswith(
            "/gradle/verification-metadata.xml"
        ):
            return "Gradle dependency verification metadata remains unsupported"
        if name in {"build.gradle", "gradle.lockfile"} and path not in {
            GRADLE_BUILD_PATH,
            GRADLE_LOCK_PATH,
        }:
            return "Gradle subprojects and nested locks remain unsupported"
    return None


def _bounded_utf8(value: object, *, document: str, limit: int) -> bytes:
    if not isinstance(value, str):
        raise ValueError(f"{document} is not text")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{document} is not valid UTF-8 text") from exc
    if len(encoded) > limit:
        raise ValueError(f"{document} exceeds the byte limit")
    return encoded


def _canonical_lines(
    text: str,
    *,
    document: str,
    max_lines: int,
    allow_blank: bool,
) -> Tuple[str, ...]:
    if not text.endswith("\n"):
        raise ValueError(f"{document} must end with one LF newline")
    if text.startswith("\ufeff") or "\r" in text or "\x00" in text or "\t" in text:
        raise ValueError(f"{document} must use canonical UTF-8 LF text")
    lines = tuple(text[:-1].split("\n"))
    if not lines or len(lines) > max_lines:
        raise ValueError(f"{document} exceeds the line limit")
    if any(line.endswith(" ") for line in lines):
        raise ValueError(f"{document} contains trailing whitespace")
    if not allow_blank and any(not line for line in lines):
        raise ValueError(f"{document} contains an empty row")
    return lines


def _parse_build_gradle(text: str) -> Tuple[GradleDependencyDeclaration, ...]:
    lines = _canonical_lines(
        text,
        document=GRADLE_BUILD_PATH,
        max_lines=GRADLE_BUILD_MAX_LINES,
        allow_blank=True,
    )
    expected = (
        "plugins {",
        "    id 'java'",
        "}",
        "",
        "repositories {",
        "    mavenCentral()",
        "}",
        "",
        "dependencies {",
    )
    locking = (
        "}",
        "",
        "dependencyLocking {",
        "    lockMode = LockMode.STRICT",
        "}",
        "",
        "configurations {",
        "    compileClasspath {",
        "        resolutionStrategy.activateDependencyLocking()",
        "    }",
        "    runtimeClasspath {",
        "        resolutionStrategy.activateDependencyLocking()",
        "    }",
        "}",
    )
    if len(lines) != 24 or lines[:9] != expected or lines[10:] != locking:
        raise ValueError(
            "build.gradle must use only the canonical java plugin, mavenCentral, "
            "one literal implementation dependency, and strict locking for only "
            "compileClasspath and runtimeClasspath"
        )
    matched = _BUILD_DEPENDENCY.fullmatch(lines[9])
    if matched is None:
        raise ValueError(
            "build.gradle implementation must be one single-quoted literal coordinate"
        )
    coordinate = _coordinate_from_key(
        matched.group(1),
        context="build.gradle implementation dependency",
    )
    return (GradleDependencyDeclaration(coordinate=coordinate),)


def _parse_lockfile(text: str) -> Mapping[str, GradleLockEntry]:
    lines = _canonical_lines(
        text,
        document=GRADLE_LOCK_PATH,
        max_lines=GRADLE_LOCK_MAX_PACKAGES + len(_LOCK_HEADER) + 1,
        allow_blank=False,
    )
    if len(lines) < len(_LOCK_HEADER) + 2 or lines[: len(_LOCK_HEADER)] != _LOCK_HEADER:
        raise ValueError("gradle.lockfile must contain the canonical Gradle lock header")
    if lines[-1] != "empty=":
        raise ValueError("gradle.lockfile must end with the canonical empty= row")
    package_rows = lines[len(_LOCK_HEADER) : -1]
    if not package_rows:
        raise ValueError("gradle.lockfile has no locked external packages")
    if len(package_rows) > GRADLE_LOCK_MAX_PACKAGES:
        raise ValueError("gradle.lockfile exceeds the package limit")

    entries: Dict[str, GradleLockEntry] = {}
    versions_by_ga: Dict[Tuple[str, str], str] = {}
    for row in package_rows:
        if row.count("=") != 1:
            raise ValueError("gradle.lockfile contains a malformed lock row")
        raw_coordinate, raw_configurations = row.split("=", 1)
        coordinate = _coordinate_from_key(
            raw_coordinate,
            context="gradle.lockfile coordinate",
        )
        configurations = tuple(raw_configurations.split(","))
        if configurations not in set(_SUPPORTED_CONFIGURATIONS.values()):
            raise ValueError(
                f"gradle.lockfile {coordinate.key} has unsupported or non-canonical configurations"
            )
        if coordinate.key in entries:
            raise ValueError(f"gradle.lockfile contains duplicate package: {coordinate.key}")
        ga = (coordinate.group, coordinate.artifact)
        prior = versions_by_ga.get(ga)
        if prior is not None and prior != coordinate.version:
            raise ValueError(
                f"gradle.lockfile contains multiple versions for {coordinate.group}:{coordinate.artifact}"
            )
        versions_by_ga[ga] = coordinate.version
        entries[coordinate.key] = GradleLockEntry(
            coordinate=coordinate,
            configurations=configurations,
        )

    if list(entries) != sorted(entries):
        raise ValueError("gradle.lockfile package rows must be sorted by canonical coordinate")
    return MappingProxyType(dict(entries))


def _parse_wrapper_properties(text: str) -> GradleWrapper:
    lines = _canonical_lines(
        text,
        document=GRADLE_WRAPPER_PROPERTIES_PATH,
        max_lines=GRADLE_WRAPPER_PROPERTIES_MAX_LINES,
        allow_blank=False,
    )
    properties: Dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            raise ValueError("Gradle wrapper properties contain a malformed row")
        key, value = line.split("=", 1)
        if not key or not value or key != key.strip() or value != value.strip():
            raise ValueError("Gradle wrapper properties must be canonical non-empty key/value rows")
        if key in properties:
            raise ValueError(f"Gradle wrapper properties contain duplicate key: {key}")
        properties[key] = value
    if set(properties) != _WRAPPER_PROPERTY_KEYS:
        raise ValueError(
            "Gradle wrapper properties must contain exactly the supported distribution and cache keys"
        )
    fixed = {
        "distributionBase": "GRADLE_USER_HOME",
        "distributionPath": "wrapper/dists",
        "networkTimeout": "10000",
        "validateDistributionUrl": "true",
        "zipStoreBase": "GRADLE_USER_HOME",
        "zipStorePath": "wrapper/dists",
    }
    for key, expected in fixed.items():
        if properties[key] != expected:
            raise ValueError(f"Gradle wrapper property {key} must be {expected}")
    matched = _WRAPPER_DISTRIBUTION_URL.fullmatch(properties["distributionUrl"])
    if matched is None:
        raise ValueError(
            "Gradle wrapper distributionUrl must be the credential-free canonical HTTPS "
            "services.gradle.org URL for an exact stable Gradle 8.x bin distribution"
        )
    checksum = properties["distributionSha256Sum"]
    if _SHA256.fullmatch(checksum) is None:
        raise ValueError(
            "Gradle wrapper distributionSha256Sum must be lowercase 64-hex SHA-256"
        )
    return GradleWrapper(
        version=matched.group("version"),
        distribution_url=properties["distributionUrl"].replace("\\:", ":", 1),
        distribution_sha256=checksum,
    )


def _validate_json_depth(value: object) -> None:
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if depth > GRADLE_JSON_MAX_DEPTH:
            raise ValueError(
                f"{GRADLE_RESOLUTION_ARTIFACT_PATH} exceeds the nesting limit"
            )
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)


def _parse_resolution(
    value: object,
    *,
    declared: Tuple[GradleDependencyDeclaration, ...],
    lock_entries: Mapping[str, GradleLockEntry],
    wrapper: GradleWrapper,
    source_sha256: Mapping[str, str],
) -> GradleSourceProfile:
    document = _require_object(
        value,
        keys={
            "schemaVersion",
            "profile",
            "sourceSha256",
            "repository",
            "complete",
            "root",
            "directDependencies",
            "wrapperJarSha256",
            "packages",
        },
        context=GRADLE_RESOLUTION_ARTIFACT_PATH,
    )
    if type(document["schemaVersion"]) is not int or document["schemaVersion"] != 1:
        raise ValueError("Gradle resolution schemaVersion must be integer 1")
    if document["profile"] != GRADLE_RESOLUTION_PROFILE:
        raise ValueError("Gradle resolution profile is unsupported")
    _validate_source_digests(document["sourceSha256"], source_sha256=source_sha256)
    if document["repository"] != GRADLE_CENTRAL_REPOSITORY:
        raise ValueError("Gradle v1 supports the canonical Maven Central repository only")
    if document["complete"] is not True:
        raise ValueError("Gradle resolution must explicitly claim a complete reachable graph")

    root = _parse_root(document["root"])
    direct_value = document["directDependencies"]
    if not isinstance(direct_value, list) or len(direct_value) != 1:
        raise ValueError("Gradle resolution must contain the one direct build.gradle dependency")
    resolved_direct = (_parse_direct_dependency(direct_value[0]),)
    if resolved_direct != declared:
        raise ValueError("Gradle resolution direct declaration does not match build.gradle")

    wrapper_jar_sha256 = document["wrapperJarSha256"]
    if wrapper_jar_sha256 is not None and (
        not isinstance(wrapper_jar_sha256, str)
        or _SHA256.fullmatch(wrapper_jar_sha256) is None
    ):
        raise ValueError("Gradle wrapper JAR digest claim must be null or lowercase SHA-256")

    packages_value = document["packages"]
    if not isinstance(packages_value, list) or not packages_value:
        raise ValueError("Gradle resolution has no external package graph")
    if len(packages_value) > GRADLE_RESOLUTION_MAX_PACKAGES:
        raise ValueError("Gradle resolution exceeds the package limit")

    packages: Dict[str, GradleResolvedPackage] = {}
    versions_by_ga: Dict[Tuple[str, str], str] = {}
    edge_count = 0
    for raw_package in packages_value:
        package = _parse_package(raw_package)
        key = package.coordinate.key
        if key in packages:
            raise ValueError(f"Gradle resolution contains duplicate package: {key}")
        ga = (package.coordinate.group, package.coordinate.artifact)
        prior = versions_by_ga.get(ga)
        if prior is not None and prior != package.coordinate.version:
            raise ValueError(
                f"Gradle resolution contains multiple versions for {ga[0]}:{ga[1]}"
            )
        versions_by_ga[ga] = package.coordinate.version
        packages[key] = package
        edge_count += len(package.dependencies)
        if edge_count > GRADLE_RESOLUTION_MAX_EDGES:
            raise ValueError("Gradle resolution exceeds the dependency-edge limit")

    if list(packages) != sorted(packages):
        raise ValueError("Gradle resolution packages must be sorted by canonical coordinate")
    direct_key = declared[0].coordinate.key
    direct_package = packages.get(direct_key)
    if (
        direct_package is None
        or direct_package.scope != "compile"
        or direct_package.configurations != _SUPPORTED_CONFIGURATIONS["compile"]
    ):
        raise ValueError(
            "Gradle resolution does not bind the implementation dependency to its compile/runtime package"
        )

    if set(lock_entries) != set(packages):
        missing = sorted(set(packages) - set(lock_entries))
        extra = sorted(set(lock_entries) - set(packages))
        key = missing[0] if missing else extra[0]
        raise ValueError(f"Gradle lock and resolution package sets do not match: {key}")

    for key, package in packages.items():
        if lock_entries[key].configurations != package.configurations:
            raise ValueError(
                f"Gradle lock and resolution configurations do not match for {key}"
            )
        dependency_keys = [dependency.key for dependency in package.dependencies]
        if dependency_keys != sorted(dependency_keys) or len(dependency_keys) != len(
            set(dependency_keys)
        ):
            raise ValueError(
                f"Gradle resolution dependencies for {key} are not canonical and unique"
            )
        missing_edges = [dependency for dependency in dependency_keys if dependency not in packages]
        if missing_edges:
            raise ValueError(
                f"Gradle resolution references a missing external package: {missing_edges[0]}"
            )
        if key in dependency_keys:
            raise ValueError(f"Gradle resolution contains a self-edge: {key}")
        if package.scope == "runtime":
            widened = [dependency for dependency in dependency_keys if packages[dependency].scope == "compile"]
            if widened:
                raise ValueError(
                    "Gradle resolution scope/configuration widens from runtime to compile: "
                    + widened[0]
                )

    reachable = _reachable_packages(direct_key, packages)
    orphaned = sorted(set(packages) - reachable)
    if orphaned:
        raise ValueError(f"Gradle resolution contains an unreachable package: {orphaned[0]}")
    _reject_cycles(direct_key, packages)

    return GradleSourceProfile(
        root=root,
        direct_dependencies=declared,
        lock_entries=MappingProxyType(dict(lock_entries)),
        packages=MappingProxyType(dict(packages)),
        wrapper=wrapper,
        source_sha256=MappingProxyType(dict(source_sha256)),
        wrapper_jar_sha256=wrapper_jar_sha256,
        repository=GRADLE_CENTRAL_REPOSITORY,
    )


def _validate_source_digests(value: object, *, source_sha256: Mapping[str, str]) -> None:
    expected_paths = {
        GRADLE_BUILD_PATH,
        GRADLE_LOCK_PATH,
        GRADLE_WRAPPER_PROPERTIES_PATH,
    }
    digests = _require_object(
        value,
        keys=expected_paths,
        context="Gradle resolution sourceSha256",
    )
    for path in sorted(expected_paths):
        digest = digests[path]
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise ValueError(f"Gradle resolution digest for {path} must be lowercase SHA-256")
        if digest != source_sha256[path]:
            raise ValueError(f"Gradle resolution is not bound to the exact {path} bytes")


def _parse_root(value: object) -> GradleRoot:
    root = _require_object(
        value,
        keys={"directory", "projectPath"},
        context="Gradle resolution root",
    )
    if root["directory"] != "." or root["projectPath"] != ":":
        raise ValueError("Gradle v1 supports exactly one local root at directory . and project path :")
    return GradleRoot()


def _parse_direct_dependency(value: object) -> GradleDependencyDeclaration:
    dependency = _require_object(
        value,
        keys={"group", "artifact", "version", "configuration"},
        context="Gradle resolution direct dependency",
    )
    if dependency["configuration"] != "implementation":
        raise ValueError("Gradle v1 supports one direct implementation dependency only")
    return GradleDependencyDeclaration(
        coordinate=_coordinate(
            dependency["group"],
            dependency["artifact"],
            dependency["version"],
            context="Gradle resolution direct dependency",
        )
    )


def _parse_package(value: object) -> GradleResolvedPackage:
    package = _require_object(
        value,
        keys={
            "group",
            "artifact",
            "version",
            "scope",
            "configurations",
            "dependencies",
            "pom",
            "artifactFile",
        },
        context="Gradle resolution package",
    )
    coordinate = _coordinate(
        package["group"],
        package["artifact"],
        package["version"],
        context="Gradle resolution package",
    )
    scope = package["scope"]
    if not isinstance(scope, str) or scope not in _SUPPORTED_CONFIGURATIONS:
        raise ValueError(f"Gradle resolution package {coordinate.key} has an unsupported scope")
    configurations_value = package["configurations"]
    if not isinstance(configurations_value, list) or any(
        not isinstance(item, str) for item in configurations_value
    ):
        raise ValueError(
            f"Gradle resolution package {coordinate.key} configurations must be strings"
        )
    configurations = tuple(configurations_value)
    if configurations != _SUPPORTED_CONFIGURATIONS[scope]:
        raise ValueError(
            f"Gradle resolution package {coordinate.key} has a scope/configuration mismatch"
        )
    dependencies_value = package["dependencies"]
    if not isinstance(dependencies_value, list) or any(
        not isinstance(item, str) for item in dependencies_value
    ):
        raise ValueError(
            f"Gradle resolution package {coordinate.key} dependencies must be coordinate strings"
        )
    dependencies = tuple(
        _coordinate_from_key(
            item,
            context=f"Gradle resolution dependency edge from {coordinate.key}",
        )
        for item in dependencies_value
    )
    pom_url, pom_sha512 = _parse_artifact_claim(
        package["pom"],
        coordinate=coordinate,
        extension="pom",
        context=f"Gradle resolution POM claim for {coordinate.key}",
    )
    artifact_url, artifact_sha512 = _parse_artifact_claim(
        package["artifactFile"],
        coordinate=coordinate,
        extension="jar",
        context=f"Gradle resolution artifact claim for {coordinate.key}",
    )
    return GradleResolvedPackage(
        coordinate=coordinate,
        scope=scope,
        configurations=configurations,
        dependencies=dependencies,
        pom_url=pom_url,
        pom_sha512=pom_sha512,
        artifact_url=artifact_url,
        artifact_sha512=artifact_sha512,
    )


def _coordinate(group: object, artifact: object, version: object, *, context: str) -> GradleCoordinate:
    if not isinstance(group, str) or len(group) > 128 or _GROUP.fullmatch(group) is None:
        raise ValueError(f"{context} group must be canonical lowercase ASCII")
    if (
        not isinstance(artifact, str)
        or len(artifact) > 128
        or _ARTIFACT.fullmatch(artifact) is None
    ):
        raise ValueError(f"{context} artifact must be canonical lowercase ASCII")
    if not isinstance(version, str) or len(version) > 32:
        raise ValueError(f"{context} version is unsupported")
    matched = _STABLE_VERSION.fullmatch(version)
    if matched is None or any(len(component) > 9 for component in matched.groups()):
        raise ValueError(
            f"{context} version must be an exact bounded stable MAJOR.MINOR.PATCH release"
        )
    return GradleCoordinate(group=group, artifact=artifact, version=version)


def _coordinate_from_key(value: str, *, context: str) -> GradleCoordinate:
    parts = value.split(":")
    if len(parts) != 3:
        raise ValueError(f"{context} is not a canonical group:artifact:version coordinate")
    coordinate = _coordinate(parts[0], parts[1], parts[2], context=context)
    if coordinate.key != value:
        raise ValueError(f"{context} is not canonical")
    return coordinate


def _parse_artifact_claim(
    value: object,
    *,
    coordinate: GradleCoordinate,
    extension: str,
    context: str,
) -> Tuple[str, str]:
    claim = _require_object(value, keys={"url", "sha512"}, context=context)
    expected_url = _central_url(coordinate, extension=extension)
    if claim["url"] != expected_url:
        raise ValueError(f"{context} must use the canonical Maven Central URL")
    if not isinstance(claim["sha512"], str) or _SHA512.fullmatch(claim["sha512"]) is None:
        raise ValueError(f"{context} must contain a lowercase SHA-512 syntax claim")
    return expected_url, claim["sha512"]


def _central_url(coordinate: GradleCoordinate, *, extension: str) -> str:
    group_path = coordinate.group.replace(".", "/")
    filename = f"{coordinate.artifact}-{coordinate.version}.{extension}"
    return (
        f"{GRADLE_CENTRAL_REPOSITORY}/{group_path}/{coordinate.artifact}/"
        f"{coordinate.version}/{filename}"
    )


def _require_object(value: object, *, keys: set, context: str) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{context} must contain exactly: {', '.join(sorted(keys))}")
    return value


def _reachable_packages(
    root_key: str,
    packages: Mapping[str, GradleResolvedPackage],
) -> set:
    reachable = set()
    pending = [root_key]
    while pending:
        key = pending.pop()
        if key in reachable:
            continue
        reachable.add(key)
        pending.extend(dependency.key for dependency in packages[key].dependencies)
    return reachable


def _reject_cycles(
    root_key: str,
    packages: Mapping[str, GradleResolvedPackage],
) -> None:
    state: Dict[str, int] = {root_key: 1}
    stack = [(root_key, iter(packages[root_key].dependencies))]
    while stack:
        key, dependencies = stack[-1]
        try:
            dependency_key = next(dependencies).key
        except StopIteration:
            state[key] = 2
            stack.pop()
            continue
        dependency_state = state.get(dependency_key, 0)
        if dependency_state == 1:
            raise ValueError(f"Gradle resolution contains a dependency cycle at {dependency_key}")
        if dependency_state == 0:
            state[dependency_key] = 1
            stack.append((dependency_key, iter(packages[dependency_key].dependencies)))


__all__ = [
    "GRADLE_BUILD_PATH",
    "GRADLE_CENTRAL_REPOSITORY",
    "GRADLE_LOCK_PATH",
    "GRADLE_REQUIRED_SOURCE_PATHS",
    "GRADLE_RESOLUTION_ARTIFACT_PATH",
    "GRADLE_RESOLUTION_PROFILE",
    "GRADLE_UNRESOLVED_EVIDENCE",
    "GRADLE_WRAPPER_PROPERTIES_PATH",
    "GradleCoordinate",
    "GradleDependencyDeclaration",
    "GradleLockEntry",
    "GradleResolvedPackage",
    "GradleRoot",
    "GradleSourceProfile",
    "GradleWrapper",
    "gradle_inventory_refusal",
    "parse_gradle_source_profile",
]
