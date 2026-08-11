"""Strict source-only custody for one deliberately narrow NuGet graph.

The profile accepts the supplied text of one root SDK-style ``.csproj`` and a
co-located ``packages.lock.json`` version 1.  It validates a conservative,
unconditional PackageReference subset and the lock file's internally closed
single-target graph.  It does not inspect a repository, evaluate MSBuild,
authenticate nuget.org, verify package artifacts or signatures, assess
security, choose an update, resolve a target version, or expose a command.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
import hashlib
import re
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple
import xml.etree.ElementTree as ET

from agentrail.dependencies.strict_json import loads_strict_json


NUGET_LOCKFILE_PATH = "packages.lock.json"
NUGET_PROFILE = "nuget_csproj_packages_lock_v1"
NUGET_PROJECT_SDK = "Microsoft.NET.Sdk"
NUGET_PROJECT_MAX_BYTES = 256 * 1024
NUGET_LOCK_MAX_BYTES = 8 * 1024 * 1024
NUGET_XML_MAX_DEPTH = 4
NUGET_XML_MAX_ELEMENTS = 4_096
NUGET_JSON_MAX_DEPTH = 16
NUGET_MAX_DIRECT_REFERENCES = 2_000
NUGET_MAX_PACKAGES = 20_000
NUGET_MAX_EDGES = 100_000
NUGET_VERSION_COMPONENT_MAX_DIGITS = 9
NUGET_UNRESOLVED_EVIDENCE = (
    "nuget_org_package_authenticity",
    "package_artifact_and_signature_verification",
    "package_security_status",
    "repository_inventory_and_config_absence",
    "runtime_and_msbuild_reproduction",
    "target_update_selection_and_resolution",
)

_STABLE_VERSION = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)
_TARGET_FRAMEWORK = re.compile(r"^net(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_PACKAGE_ID = re.compile(r"^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*$")
_LOCK_REQUEST = re.compile(r"^\[((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)), \)$")
_FORBIDDEN_XML_DECLARATION = re.compile(
    r"<\s*!\s*(?:DOCTYPE|ENTITY|\[CDATA\[)",
    re.IGNORECASE,
)
_COMMENT_OR_PROCESSING_INSTRUCTION = re.compile(r"<!--|<\s*\?")
_XML_WHITESPACE = " \t\r\n"


@dataclass(frozen=True, order=True)
class NuGetPackageReference:
    package_id: str
    canonical_id: str
    version: str


@dataclass(frozen=True)
class NuGetProject:
    sdk: str
    target_framework: str


@dataclass(frozen=True, order=True)
class NuGetLockedDependency:
    package_id: str
    canonical_id: str
    minimum_version: str


@dataclass(frozen=True)
class NuGetLockedPackage:
    package_id: str
    canonical_id: str
    dependency_type: str
    requested: Optional[str]
    requested_version: Optional[str]
    resolved_version: str
    content_hash: str
    dependencies: Tuple[NuGetLockedDependency, ...]


@dataclass(frozen=True)
class NuGetSourceProfile:
    project: NuGetProject
    direct_dependencies: Tuple[NuGetPackageReference, ...]
    packages: Mapping[str, NuGetLockedPackage]
    project_sha256: str
    lock_sha256: str
    profile: str = field(default=NUGET_PROFILE, init=False)
    lockfile_path: str = field(default=NUGET_LOCKFILE_PATH, init=False)
    graph_status: str = field(default="internally_closed", init=False)
    evidence_status: str = field(default="syntax_and_custody_only", init=False)
    authority: str = field(default="none", init=False)
    unresolved_evidence: Tuple[str, ...] = field(
        default=NUGET_UNRESOLVED_EVIDENCE,
        init=False,
    )


def parse_nuget_source_profile(
    project_text: object,
    lock_text: object,
) -> NuGetSourceProfile:
    """Validate one supplied SDK project and its supplied NuGet lock graph.

    The result binds the exact UTF-8 source bytes to a non-operational,
    immutable representation.  Repository placement and external trust remain
    unresolved because this pure parser receives no inventory or registry
    receipt.
    """

    project_bytes = _bounded_utf8(
        project_text,
        document="SDK project",
        limit=NUGET_PROJECT_MAX_BYTES,
    )
    lock_bytes = _bounded_utf8(
        lock_text,
        document=NUGET_LOCKFILE_PATH,
        limit=NUGET_LOCK_MAX_BYTES,
    )
    assert isinstance(project_text, str)
    assert isinstance(lock_text, str)

    project, direct_dependencies = _parse_project(project_text)
    try:
        lock_document = loads_strict_json(
            lock_text,
            document=NUGET_LOCKFILE_PATH,
        )
    except RecursionError as exc:
        raise ValueError(f"{NUGET_LOCKFILE_PATH} exceeds the nesting limit") from exc
    _validate_json_depth(lock_document)
    packages = _parse_lockfile(
        lock_document,
        target_framework=project.target_framework,
        direct_dependencies=direct_dependencies,
    )

    return NuGetSourceProfile(
        project=project,
        direct_dependencies=direct_dependencies,
        packages=MappingProxyType(dict(sorted(packages.items()))),
        project_sha256=hashlib.sha256(project_bytes).hexdigest(),
        lock_sha256=hashlib.sha256(lock_bytes).hexdigest(),
    )


def stable_nuget_version(value: object) -> Optional[Tuple[int, int, int]]:
    """Return the tuple for the profile's bounded stable version subset."""

    if not isinstance(value, str) or len(value) > 32:
        return None
    matched = _STABLE_VERSION.fullmatch(value)
    if matched is None:
        return None
    parts = matched.groups()
    if any(len(part) > NUGET_VERSION_COMPONENT_MAX_DIGITS for part in parts):
        return None
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


def canonical_nuget_package_id(value: object) -> str:
    """Validate an ASCII NuGet ID and return its case-insensitive key."""

    if not isinstance(value, str) or not value or len(value) > 100:
        raise ValueError("NuGet package ID is missing or exceeds the length limit")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("NuGet package ID must use the canonical ASCII subset") from exc
    if _PACKAGE_ID.fullmatch(value) is None:
        raise ValueError(
            "NuGet package ID must contain canonical alphanumeric segments separated by dot or dash"
        )
    return value.lower()


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


def _parse_project(
    text: str,
) -> Tuple[NuGetProject, Tuple[NuGetPackageReference, ...]]:
    if text.startswith("\ufeff"):
        raise ValueError("SDK project must not contain a byte-order mark")
    if _COMMENT_OR_PROCESSING_INSTRUCTION.search(text):
        raise ValueError("SDK project comments and processing instructions are unsupported")
    if _FORBIDDEN_XML_DECLARATION.search(text):
        raise ValueError("SDK project contains a DTD, entity declaration, or CDATA section")
    if "&" in text:
        raise ValueError("SDK project entity references are unsupported")
    try:
        root = ET.fromstring(text)
    except (ET.ParseError, RecursionError, TypeError, ValueError) as exc:
        raise ValueError(f"SDK project XML is malformed: {exc}") from exc

    _validate_xml_shape(root)
    if root.tag != "Project" or set(root.attrib) != {"Sdk"}:
        raise ValueError("NuGet v1 requires one unnamespaced SDK-style Project root")
    if root.attrib["Sdk"] != NUGET_PROJECT_SDK:
        raise ValueError(f"NuGet v1 supports only Sdk={NUGET_PROJECT_SDK}")

    children = list(root)
    if (
        not children
        or children[0].tag != "PropertyGroup"
        or sum(child.tag == "PropertyGroup" for child in children) != 1
        or any(child.tag not in {"PropertyGroup", "ItemGroup"} for child in children)
        or any(child.tag == "PropertyGroup" for child in children[1:])
    ):
        raise ValueError(
            "NuGet v1 requires one leading TargetFramework PropertyGroup followed by PackageReference ItemGroups"
        )

    property_group = children[0]
    if property_group.attrib or [child.tag for child in property_group] != ["TargetFramework"]:
        raise ValueError(
            "NuGet v1 rejects conditions, TargetFrameworks, runtime identifiers, central package management, properties, and indirection"
        )
    target_framework = _leaf_text(
        property_group[0],
        label="TargetFramework",
        allow_attributes=False,
    )
    _validate_target_framework(target_framework)

    item_groups = children[1:]
    if not item_groups:
        raise ValueError("NuGet v1 requires at least one PackageReference ItemGroup")
    references: Dict[str, NuGetPackageReference] = {}
    for item_group in item_groups:
        if item_group.attrib or not list(item_group):
            raise ValueError("NuGet v1 ItemGroups must be unconditional and non-empty")
        for element in item_group:
            if element.tag != "PackageReference":
                raise ValueError(
                    "NuGet v1 rejects imports, targets, UsingTask, Exec, project references, and unknown items"
                )
            reference = _parse_package_reference(element)
            if reference.canonical_id in references:
                raise ValueError(
                    "SDK project contains a duplicate or case-colliding PackageReference: "
                    + reference.package_id
                )
            references[reference.canonical_id] = reference
            if len(references) > NUGET_MAX_DIRECT_REFERENCES:
                raise ValueError("SDK project exceeds the direct PackageReference limit")

    return (
        NuGetProject(
            sdk=NUGET_PROJECT_SDK,
            target_framework=target_framework,
        ),
        tuple(references[key] for key in sorted(references)),
    )


def _validate_xml_shape(root: ET.Element) -> None:
    count = 0
    pending = [(root, 1)]
    while pending:
        element, depth = pending.pop()
        count += 1
        if count > NUGET_XML_MAX_ELEMENTS:
            raise ValueError("SDK project exceeds the XML element limit")
        if depth > NUGET_XML_MAX_DEPTH:
            raise ValueError("SDK project exceeds the XML depth limit")
        if not isinstance(element.tag, str) or element.tag.startswith("{"):
            raise ValueError("SDK project contains a namespace or non-element node")
        if _contains_non_xml_whitespace(element.tail):
            raise ValueError("SDK project contains mixed trailing text")
        children = list(element)
        if children and _contains_non_xml_whitespace(element.text):
            raise ValueError("SDK project contains mixed element text")
        pending.extend((child, depth + 1) for child in reversed(children))


def _leaf_text(
    element: ET.Element,
    *,
    label: str,
    allow_attributes: bool,
) -> str:
    if (not allow_attributes and element.attrib) or list(element):
        raise ValueError(f"SDK project {label} must be literal plain text")
    if (
        not isinstance(element.text, str)
        or not element.text
        or element.text != element.text.strip(_XML_WHITESPACE)
    ):
        raise ValueError(f"SDK project {label} must be canonical non-empty text")
    return element.text


def _contains_non_xml_whitespace(value: Optional[str]) -> bool:
    return isinstance(value, str) and bool(value.strip(_XML_WHITESPACE))


def _validate_target_framework(value: str) -> None:
    matched = _TARGET_FRAMEWORK.fullmatch(value)
    if matched is None or any(len(part) > 3 for part in matched.groups()):
        raise ValueError(
            "NuGet v1 TargetFramework must be one unconditional canonical netMAJOR.MINOR target"
        )


def _parse_package_reference(element: ET.Element) -> NuGetPackageReference:
    if list(element) or _contains_non_xml_whitespace(element.text):
        raise ValueError(
            "NuGet v1 PackageReference requires literal Include and Version attributes; child Version nodes are unsupported"
        )
    if set(element.attrib) != {"Include", "Version"}:
        raise ValueError(
            "NuGet v1 PackageReference requires only literal Include and Version attributes; Condition, Update, Remove, and metadata are unsupported"
        )
    package_id = element.attrib["Include"]
    canonical_id = canonical_nuget_package_id(package_id)
    version = element.attrib["Version"]
    if stable_nuget_version(version) is None:
        raise ValueError(
            "NuGet PackageReference version must be an exact bounded stable MAJOR.MINOR.PATCH release"
        )
    return NuGetPackageReference(
        package_id=package_id,
        canonical_id=canonical_id,
        version=version,
    )


def _validate_json_depth(value: object) -> None:
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if depth > NUGET_JSON_MAX_DEPTH:
            raise ValueError(f"{NUGET_LOCKFILE_PATH} exceeds the nesting limit")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)


def _parse_lockfile(
    value: object,
    *,
    target_framework: str,
    direct_dependencies: Tuple[NuGetPackageReference, ...],
) -> Dict[str, NuGetLockedPackage]:
    document = _require_object(
        value,
        keys={"version", "dependencies"},
        context=NUGET_LOCKFILE_PATH,
    )
    if type(document["version"]) is not int or document["version"] != 1:
        raise ValueError(f"{NUGET_LOCKFILE_PATH} version must be integer 1")
    frameworks = document["dependencies"]
    if not isinstance(frameworks, dict) or len(frameworks) != 1:
        raise ValueError(
            f"{NUGET_LOCKFILE_PATH} must contain exactly one target framework graph"
        )
    lock_target, raw_packages = next(iter(frameworks.items()))
    if lock_target != target_framework:
        raise ValueError(
            f"{NUGET_LOCKFILE_PATH} target must exactly match the project TargetFramework"
        )
    if not isinstance(raw_packages, dict) or not raw_packages:
        raise ValueError(f"{NUGET_LOCKFILE_PATH} target has no package graph")
    if len(raw_packages) > NUGET_MAX_PACKAGES:
        raise ValueError(f"{NUGET_LOCKFILE_PATH} exceeds the package limit")

    packages: Dict[str, NuGetLockedPackage] = {}
    for package_id, raw_package in raw_packages.items():
        canonical_id = canonical_nuget_package_id(package_id)
        if canonical_id in packages:
            raise ValueError(
                f"{NUGET_LOCKFILE_PATH} contains a duplicate or case-colliding package: {package_id}"
            )
        packages[canonical_id] = _parse_locked_package(
            package_id,
            canonical_id,
            raw_package,
        )

    _bind_direct_dependencies(direct_dependencies, packages)
    _validate_graph(direct_dependencies, packages)
    return packages


def _parse_locked_package(
    package_id: str,
    canonical_id: str,
    value: object,
) -> NuGetLockedPackage:
    if not isinstance(value, dict):
        raise ValueError(f"NuGet lock package {package_id} must be an object")
    dependency_type = value.get("type")
    common_keys = {"type", "resolved", "contentHash"}
    allowed_keys = common_keys | {"dependencies"}
    requested: Optional[str] = None
    requested_version: Optional[str] = None
    if dependency_type == "Direct":
        allowed_keys.add("requested")
        actual_keys = set(value)
        if actual_keys != allowed_keys and actual_keys != allowed_keys - {"dependencies"}:
            raise ValueError(
                f"NuGet direct lock package {package_id} has unknown or missing fields"
            )
        requested = value["requested"]
        if not isinstance(requested, str):
            raise ValueError(f"NuGet direct lock package {package_id} requested value is not text")
        matched = _LOCK_REQUEST.fullmatch(requested)
        if matched is None or stable_nuget_version(matched.group(1)) is None:
            raise ValueError(
                f"NuGet direct lock package {package_id} requested value is not the canonical lock serialization of a stable literal version"
            )
        requested_version = matched.group(1)
    elif dependency_type == "Transitive":
        actual_keys = set(value)
        if actual_keys != allowed_keys and actual_keys != common_keys:
            raise ValueError(
                f"NuGet transitive lock package {package_id} has unknown or missing fields"
            )
    else:
        raise ValueError(
            f"NuGet lock package {package_id} type must be Direct or Transitive"
        )

    resolved_version = value["resolved"]
    if stable_nuget_version(resolved_version) is None:
        raise ValueError(
            f"NuGet lock package {package_id} resolved version must be an exact bounded stable MAJOR.MINOR.PATCH release"
        )
    content_hash = _canonical_sha512_content_hash(
        value["contentHash"],
        package_id=package_id,
    )
    dependencies = _parse_locked_dependencies(
        value.get("dependencies", {}),
        package_id=package_id,
    )
    return NuGetLockedPackage(
        package_id=package_id,
        canonical_id=canonical_id,
        dependency_type=dependency_type,
        requested=requested,
        requested_version=requested_version,
        resolved_version=resolved_version,
        content_hash=content_hash,
        dependencies=dependencies,
    )


def _parse_locked_dependencies(
    value: object,
    *,
    package_id: str,
) -> Tuple[NuGetLockedDependency, ...]:
    if not isinstance(value, dict):
        raise ValueError(f"NuGet lock package {package_id} dependencies must be an object")
    if len(value) > NUGET_MAX_EDGES:
        raise ValueError(f"NuGet lock package {package_id} exceeds the dependency-edge limit")
    dependencies: Dict[str, NuGetLockedDependency] = {}
    for dependency_id, minimum_version in value.items():
        canonical_id = canonical_nuget_package_id(dependency_id)
        if canonical_id in dependencies:
            raise ValueError(
                f"NuGet lock package {package_id} contains duplicate or case-colliding dependency edges"
            )
        if stable_nuget_version(minimum_version) is None:
            raise ValueError(
                f"NuGet dependency edge {package_id} -> {dependency_id} must use a bounded stable minimum version"
            )
        dependencies[canonical_id] = NuGetLockedDependency(
            package_id=dependency_id,
            canonical_id=canonical_id,
            minimum_version=minimum_version,
        )
    return tuple(dependencies[key] for key in sorted(dependencies))


def _canonical_sha512_content_hash(value: object, *, package_id: str) -> str:
    if not isinstance(value, str) or len(value) != 88 or not value.endswith("=="):
        raise ValueError(
            f"NuGet lock package {package_id} contentHash must be canonical base64 SHA-512 syntax"
        )
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(
            f"NuGet lock package {package_id} contentHash must be canonical base64 SHA-512 syntax"
        ) from exc
    if len(decoded) != 64 or base64.b64encode(decoded).decode("ascii") != value:
        raise ValueError(
            f"NuGet lock package {package_id} contentHash must be canonical base64 SHA-512 syntax"
        )
    return value


def _bind_direct_dependencies(
    direct_dependencies: Sequence[NuGetPackageReference],
    packages: Mapping[str, NuGetLockedPackage],
) -> None:
    declared = {dependency.canonical_id: dependency for dependency in direct_dependencies}
    locked_direct = {
        key: package
        for key, package in packages.items()
        if package.dependency_type == "Direct"
    }
    missing = sorted(set(declared) - set(locked_direct))
    if missing:
        raise ValueError(
            f"{NUGET_LOCKFILE_PATH} is missing a direct project PackageReference: {missing[0]}"
        )
    extra = sorted(set(locked_direct) - set(declared))
    if extra:
        raise ValueError(
            f"{NUGET_LOCKFILE_PATH} contains an extra direct package: {extra[0]}"
        )
    for canonical_id, reference in declared.items():
        locked = locked_direct[canonical_id]
        expected_requested = f"[{reference.version}, )"
        if (
            locked.requested != expected_requested
            or locked.requested_version != reference.version
            or locked.resolved_version != reference.version
        ):
            raise ValueError(
                f"{NUGET_LOCKFILE_PATH} direct package {locked.package_id} does not exactly bind the literal project version"
            )


def _validate_graph(
    direct_dependencies: Sequence[NuGetPackageReference],
    packages: Mapping[str, NuGetLockedPackage],
) -> None:
    edge_count = 0
    for package in packages.values():
        edge_count += len(package.dependencies)
        if edge_count > NUGET_MAX_EDGES:
            raise ValueError(f"{NUGET_LOCKFILE_PATH} exceeds the dependency-edge limit")
        for dependency in package.dependencies:
            child = packages.get(dependency.canonical_id)
            if child is None:
                raise ValueError(
                    f"{NUGET_LOCKFILE_PATH} references a missing package: {dependency.package_id}"
                )
            minimum = stable_nuget_version(dependency.minimum_version)
            resolved = stable_nuget_version(child.resolved_version)
            assert minimum is not None and resolved is not None
            if resolved < minimum:
                raise ValueError(
                    f"{NUGET_LOCKFILE_PATH} resolves {child.package_id} below the dependency edge minimum"
                )

    direct_ids = tuple(dependency.canonical_id for dependency in direct_dependencies)
    reachable = _reachable_packages(direct_ids, packages)
    orphaned = sorted(set(packages) - reachable)
    if orphaned:
        raise ValueError(
            f"{NUGET_LOCKFILE_PATH} contains an unreachable package: {orphaned[0]}"
        )
    _reject_cycles(direct_ids, packages)


def _reachable_packages(
    direct_ids: Sequence[str],
    packages: Mapping[str, NuGetLockedPackage],
) -> set[str]:
    reachable: set[str] = set()
    pending = list(direct_ids)
    while pending:
        canonical_id = pending.pop()
        if canonical_id in reachable:
            continue
        reachable.add(canonical_id)
        pending.extend(
            dependency.canonical_id
            for dependency in packages[canonical_id].dependencies
        )
    return reachable


def _reject_cycles(
    direct_ids: Sequence[str],
    packages: Mapping[str, NuGetLockedPackage],
) -> None:
    state: Dict[str, int] = {}
    for root_id in direct_ids:
        if state.get(root_id) == 2:
            continue
        state[root_id] = 1
        stack = [(root_id, iter(packages[root_id].dependencies))]
        while stack:
            package_id, dependencies = stack[-1]
            try:
                dependency_id = next(dependencies).canonical_id
            except StopIteration:
                state[package_id] = 2
                stack.pop()
                continue
            dependency_state = state.get(dependency_id, 0)
            if dependency_state == 1:
                raise ValueError(
                    f"{NUGET_LOCKFILE_PATH} contains a dependency cycle at {dependency_id}"
                )
            if dependency_state == 0:
                state[dependency_id] = 1
                stack.append(
                    (dependency_id, iter(packages[dependency_id].dependencies))
                )


def _require_object(
    value: object,
    *,
    keys: set[str],
    context: str,
) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(
            f"{context} must contain exactly: {', '.join(sorted(keys))}"
        )
    return value


__all__ = [
    "NUGET_LOCKFILE_PATH",
    "NUGET_PROFILE",
    "NUGET_PROJECT_SDK",
    "NUGET_UNRESOLVED_EVIDENCE",
    "NuGetLockedDependency",
    "NuGetLockedPackage",
    "NuGetPackageReference",
    "NuGetProject",
    "NuGetSourceProfile",
    "canonical_nuget_package_id",
    "parse_nuget_source_profile",
    "stable_nuget_version",
]
