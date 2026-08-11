"""Strict source-only custody for one deliberately narrow Maven graph.

Maven has no native authoritative lockfile.  This module therefore accepts a
supplied ``pom.xml`` text only when it is paired with a profile-owned
``jace-maven-resolution-v1.json`` artifact that is bound to the exact POM
bytes.  Parsing proves syntax and internal graph custody only: it does not
prove that either text came from a committed root file, authenticate Maven
Central, reproduce Maven's runtime resolution, choose an update target, invoke
Maven, or grant any execution/evidence authority.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import re
from types import MappingProxyType
from typing import Any, Dict, Mapping, Tuple
import xml.etree.ElementTree as ET

from agentrail.dependencies.strict_json import loads_strict_json


MAVEN_RESOLUTION_ARTIFACT_PATH = "jace-maven-resolution-v1.json"
MAVEN_RESOLUTION_PROFILE = "jace-maven-resolution-v1"
MAVEN_CENTRAL_REPOSITORY = "https://repo.maven.apache.org/maven2"
MAVEN_POM_MAX_BYTES = 256 * 1024
MAVEN_RESOLUTION_MAX_BYTES = 8 * 1024 * 1024
MAVEN_XML_MAX_DEPTH = 8
MAVEN_XML_MAX_ELEMENTS = 64
MAVEN_JSON_MAX_DEPTH = 16
MAVEN_RESOLUTION_MAX_PACKAGES = 20_000
MAVEN_RESOLUTION_MAX_EDGES = 100_000
MAVEN_UNRESOLVED_EVIDENCE = (
    "committed_root_source_inventory",
    "maven_central_pom_and_artifact_authenticity",
    "maven_runtime_resolution_reproduction",
    "target_update_selection_and_target_resolution",
)

_POM_NAMESPACE = "http://maven.apache.org/POM/4.0.0"
_XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance"
_SCHEMA_LOCATION_ATTRIBUTE = f"{{{_XSI_NAMESPACE}}}schemaLocation"
_SCHEMA_LOCATIONS = {
    f"{_POM_NAMESPACE} https://maven.apache.org/xsd/maven-4.0.0.xsd",
    f"{_POM_NAMESPACE} http://maven.apache.org/xsd/maven-4.0.0.xsd",
}
_SUPPORTED_XML_DECLARATION = re.compile(
    r"\A<\?xml[ \t]+version=(?P<version_quote>['\"])1\.0(?P=version_quote)"
    r"[ \t]+encoding=(?P<encoding_quote>['\"])UTF-8(?P=encoding_quote)[ \t]*\?>"
)
_XML_DECLARATION_MARKER = re.compile(r"<\?xml(?:[ \t\r\n]|\?>)", re.IGNORECASE)
_FORBIDDEN_XML_DECLARATION = re.compile(
    r"<\s*!\s*(?:DOCTYPE|ENTITY|\[CDATA\[)",
    re.IGNORECASE,
)
_GROUP_ID = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
_ARTIFACT_ID = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_STABLE_VERSION = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SHA512 = re.compile(r"^[0-9a-f]{128}$")
_SUPPORTED_SCOPES = {"compile", "runtime"}


@dataclass(frozen=True, order=True)
class MavenCoordinate:
    group_id: str
    artifact_id: str
    version: str

    @property
    def key(self) -> str:
        return f"{self.group_id}:{self.artifact_id}:{self.version}"


@dataclass(frozen=True)
class MavenProject:
    coordinate: MavenCoordinate
    packaging: str = "jar"


@dataclass(frozen=True)
class MavenDependencyDeclaration:
    coordinate: MavenCoordinate
    scope: str


@dataclass(frozen=True)
class MavenResolvedPackage:
    coordinate: MavenCoordinate
    scope: str
    dependencies: Tuple[MavenCoordinate, ...]
    pom_url: str
    pom_sha512: str
    artifact_url: str
    artifact_sha512: str


@dataclass(frozen=True)
class MavenSourceProfile:
    root: MavenProject
    direct_dependencies: Tuple[MavenDependencyDeclaration, ...]
    packages: Mapping[str, MavenResolvedPackage]
    pom_sha256: str
    repository: str
    profile: str = field(default=MAVEN_RESOLUTION_PROFILE, init=False)
    resolution_artifact_path: str = field(default=MAVEN_RESOLUTION_ARTIFACT_PATH, init=False)
    evidence_status: str = field(default="syntax_and_custody_only", init=False)
    authority: str = field(default="none", init=False)
    unresolved_evidence: Tuple[str, ...] = field(default=MAVEN_UNRESOLVED_EVIDENCE, init=False)


def parse_maven_source_profile(pom_text: object, resolution_text: object) -> MavenSourceProfile:
    """Validate one supplied POM and its exact, profile-owned resolution claim.

    The returned graph is intentionally non-operational.  In particular, this
    API exposes no managed command and makes no external authenticity claim.
    """

    pom_bytes = _bounded_utf8(pom_text, document="pom.xml", limit=MAVEN_POM_MAX_BYTES)
    resolution_bytes = _bounded_utf8(
        resolution_text,
        document=MAVEN_RESOLUTION_ARTIFACT_PATH,
        limit=MAVEN_RESOLUTION_MAX_BYTES,
    )
    assert isinstance(pom_text, str)
    assert isinstance(resolution_text, str)

    project, declared = _parse_pom(pom_text)
    try:
        document = loads_strict_json(
            resolution_text,
            document=MAVEN_RESOLUTION_ARTIFACT_PATH,
        )
    except RecursionError as exc:
        raise ValueError(f"{MAVEN_RESOLUTION_ARTIFACT_PATH} exceeds the nesting limit") from exc
    _validate_json_depth(document)

    return _parse_resolution(
        document,
        project=project,
        declared=declared,
        pom_sha256=hashlib.sha256(pom_bytes).hexdigest(),
        resolution_size=len(resolution_bytes),
    )


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


def _tag(name: str) -> str:
    return f"{{{_POM_NAMESPACE}}}{name}"


def _parse_pom(text: str) -> Tuple[MavenProject, Tuple[MavenDependencyDeclaration, ...]]:
    declaration = _XML_DECLARATION_MARKER.search(text)
    if declaration is not None:
        supported = _SUPPORTED_XML_DECLARATION.match(text)
        if supported is None or declaration.start() != 0:
            raise ValueError(
                "pom.xml XML declaration must be version 1.0 with explicit UTF-8 encoding"
            )
        if _XML_DECLARATION_MARKER.search(text, supported.end()) is not None:
            raise ValueError("pom.xml contains multiple XML declarations")
    if _FORBIDDEN_XML_DECLARATION.search(text):
        raise ValueError("pom.xml contains a DTD, entity, or CDATA declaration")
    try:
        root = ET.fromstring(text)
    except (ET.ParseError, TypeError, ValueError) as exc:
        raise ValueError(f"pom.xml is malformed: {exc}") from exc
    if root.tag != _tag("project"):
        raise ValueError("pom.xml must contain one Maven 4.0.0 namespaced project")
    if root.attrib:
        if set(root.attrib) != {_SCHEMA_LOCATION_ATTRIBUTE}:
            raise ValueError("pom.xml project attributes are unsupported")
        if root.attrib[_SCHEMA_LOCATION_ATTRIBUTE] not in _SCHEMA_LOCATIONS:
            raise ValueError("pom.xml has a non-canonical schema location")

    _validate_xml_shape(root)
    children = list(root)
    child_names = [child.tag for child in children]
    required_prefix = [_tag("modelVersion"), _tag("groupId"), _tag("artifactId"), _tag("version")]
    if child_names[:4] != required_prefix:
        raise ValueError("pom.xml project coordinates must be explicit, unique, and in canonical order")
    cursor = 4
    packaging = "jar"
    if cursor < len(children) and children[cursor].tag == _tag("packaging"):
        packaging = _leaf_text(children[cursor], "project packaging")
        cursor += 1
    if packaging != "jar":
        raise ValueError("Maven v1 supports jar packaging only")
    if child_names[cursor:] != [_tag("dependencies")]:
        raise ValueError(
            "Maven v1 rejects parent, modules, profiles, properties, dependency management, "
            "repositories, plugins, build extensions, conditions, and unknown project elements"
        )

    if _leaf_text(children[0], "modelVersion") != "4.0.0":
        raise ValueError("pom.xml modelVersion must be 4.0.0")
    root_coordinate = _coordinate(
        _leaf_text(children[1], "project groupId"),
        _leaf_text(children[2], "project artifactId"),
        _leaf_text(children[3], "project version"),
        context="pom.xml project",
    )

    dependencies_element = children[cursor]
    if dependencies_element.attrib:
        raise ValueError("pom.xml dependencies attributes are unsupported")
    dependencies = list(dependencies_element)
    if len(dependencies) != 1 or dependencies[0].tag != _tag("dependency"):
        raise ValueError("Maven v1 requires exactly one direct dependency")
    dependency = dependencies[0]
    if dependency.attrib:
        raise ValueError("pom.xml dependency attributes are unsupported")
    fields = list(dependency)
    field_names = [field.tag for field in fields]
    accepted_fields = [
        [_tag("groupId"), _tag("artifactId"), _tag("version")],
        [_tag("groupId"), _tag("artifactId"), _tag("version"), _tag("scope")],
    ]
    if field_names not in accepted_fields:
        raise ValueError(
            "Maven v1 dependencies require only groupId, artifactId, exact version, "
            "and optional compile scope in canonical order"
        )
    coordinate = _coordinate(
        _leaf_text(fields[0], "dependency groupId"),
        _leaf_text(fields[1], "dependency artifactId"),
        _leaf_text(fields[2], "dependency version"),
        context="pom.xml dependency",
    )
    scope = _leaf_text(fields[3], "dependency scope") if len(fields) == 4 else "compile"
    if scope != "compile":
        raise ValueError("Maven v1 supports one direct compile dependency only")
    if coordinate == root_coordinate:
        raise ValueError("pom.xml cannot declare the root project as its own dependency")

    return (
        MavenProject(coordinate=root_coordinate, packaging=packaging),
        (MavenDependencyDeclaration(coordinate=coordinate, scope=scope),),
    )


def _validate_xml_shape(root: ET.Element) -> None:
    count = 0
    pending = [(root, 1)]
    while pending:
        element, depth = pending.pop()
        count += 1
        if count > MAVEN_XML_MAX_ELEMENTS:
            raise ValueError("pom.xml exceeds the element limit")
        if depth > MAVEN_XML_MAX_DEPTH:
            raise ValueError("pom.xml exceeds the depth limit")
        if not isinstance(element.tag, str) or not element.tag.startswith(f"{{{_POM_NAMESPACE}}}"):
            raise ValueError("pom.xml contains a foreign or unnamespaced element")
        if element.tail is not None and element.tail.strip():
            raise ValueError("pom.xml contains mixed trailing text")
        children = list(element)
        if children and element.text is not None and element.text.strip():
            raise ValueError("pom.xml contains mixed element text")
        pending.extend((child, depth + 1) for child in reversed(children))


def _leaf_text(element: ET.Element, label: str) -> str:
    if element.attrib or list(element):
        raise ValueError(f"pom.xml {label} must be plain text")
    if not isinstance(element.text, str) or not element.text or element.text != element.text.strip():
        raise ValueError(f"pom.xml {label} must be canonical non-empty text")
    return element.text


def _coordinate(group_id: object, artifact_id: object, version: object, *, context: str) -> MavenCoordinate:
    if not isinstance(group_id, str) or len(group_id) > 128 or _GROUP_ID.fullmatch(group_id) is None:
        raise ValueError(f"{context} groupId must be canonical lowercase ASCII")
    if not isinstance(artifact_id, str) or len(artifact_id) > 128 or _ARTIFACT_ID.fullmatch(artifact_id) is None:
        raise ValueError(f"{context} artifactId must be canonical lowercase ASCII")
    if not isinstance(version, str) or len(version) > 32:
        raise ValueError(f"{context} version is unsupported")
    matched = _STABLE_VERSION.fullmatch(version)
    if matched is None or any(len(component) > 9 for component in matched.groups()):
        raise ValueError(f"{context} version must be an exact bounded stable MAJOR.MINOR.PATCH release")
    return MavenCoordinate(group_id=group_id, artifact_id=artifact_id, version=version)


def _require_object(value: object, *, keys: set[str], context: str) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{context} must contain exactly: {', '.join(sorted(keys))}")
    return value


def _validate_json_depth(value: object) -> None:
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if depth > MAVEN_JSON_MAX_DEPTH:
            raise ValueError(f"{MAVEN_RESOLUTION_ARTIFACT_PATH} exceeds the nesting limit")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)


def _parse_resolution(
    value: object,
    *,
    project: MavenProject,
    declared: Tuple[MavenDependencyDeclaration, ...],
    pom_sha256: str,
    resolution_size: int,
) -> MavenSourceProfile:
    if resolution_size > MAVEN_RESOLUTION_MAX_BYTES:  # defensive: bounded before JSON parsing
        raise ValueError(f"{MAVEN_RESOLUTION_ARTIFACT_PATH} exceeds the byte limit")
    document = _require_object(
        value,
        keys={
            "schemaVersion",
            "profile",
            "pomSha256",
            "repository",
            "complete",
            "root",
            "directDependencies",
            "packages",
        },
        context=MAVEN_RESOLUTION_ARTIFACT_PATH,
    )
    if type(document["schemaVersion"]) is not int or document["schemaVersion"] != 1:
        raise ValueError("Maven resolution schemaVersion must be integer 1")
    if document["profile"] != MAVEN_RESOLUTION_PROFILE:
        raise ValueError("Maven resolution profile is unsupported")
    if not isinstance(document["pomSha256"], str) or _SHA256.fullmatch(document["pomSha256"]) is None:
        raise ValueError("Maven resolution pomSha256 must be lowercase SHA-256")
    if document["pomSha256"] != pom_sha256:
        raise ValueError("Maven resolution is not bound to the exact pom.xml bytes")
    if document["repository"] != MAVEN_CENTRAL_REPOSITORY:
        raise ValueError("Maven v1 supports the canonical Maven Central repository only")
    if document["complete"] is not True:
        raise ValueError("Maven resolution must explicitly claim a complete reachable graph")

    resolved_root = _parse_project_json(document["root"])
    if resolved_root != project:
        raise ValueError("Maven resolution root does not match pom.xml")

    direct_value = document["directDependencies"]
    if not isinstance(direct_value, list) or len(direct_value) != 1:
        raise ValueError("Maven resolution must contain the one direct pom.xml dependency")
    resolved_direct = (_parse_direct_json(direct_value[0]),)
    if resolved_direct != declared:
        raise ValueError("Maven resolution direct declaration does not match pom.xml")

    packages_value = document["packages"]
    if not isinstance(packages_value, list) or not packages_value:
        raise ValueError("Maven resolution has no package graph")
    if len(packages_value) > MAVEN_RESOLUTION_MAX_PACKAGES:
        raise ValueError("Maven resolution exceeds the package limit")

    packages: Dict[str, MavenResolvedPackage] = {}
    versions_by_ga: Dict[Tuple[str, str], str] = {}
    edge_count = 0
    for raw_package in packages_value:
        package = _parse_package_json(raw_package)
        key = package.coordinate.key
        if package.coordinate == project.coordinate:
            raise ValueError("Maven resolution cannot contain the source project root coordinate")
        if key in packages:
            raise ValueError(f"Maven resolution contains duplicate package: {key}")
        ga = (package.coordinate.group_id, package.coordinate.artifact_id)
        previous_version = versions_by_ga.get(ga)
        if previous_version is not None and previous_version != package.coordinate.version:
            raise ValueError(f"Maven resolution contains multiple versions for {ga[0]}:{ga[1]}")
        versions_by_ga[ga] = package.coordinate.version
        packages[key] = package
        edge_count += len(package.dependencies)
        if edge_count > MAVEN_RESOLUTION_MAX_EDGES:
            raise ValueError("Maven resolution exceeds the dependency-edge limit")

    package_keys = list(packages)
    if package_keys != sorted(package_keys):
        raise ValueError("Maven resolution packages must be sorted by canonical coordinate")
    direct_key = declared[0].coordinate.key
    direct_package = packages.get(direct_key)
    if direct_package is None or direct_package.scope != declared[0].scope:
        raise ValueError("Maven resolution does not bind the direct dependency to its current package and scope")

    for package in packages.values():
        dependency_keys = [dependency.key for dependency in package.dependencies]
        if dependency_keys != sorted(dependency_keys) or len(dependency_keys) != len(set(dependency_keys)):
            raise ValueError(f"Maven resolution dependencies for {package.coordinate.key} are not canonical and unique")
        missing = [key for key in dependency_keys if key not in packages]
        if missing:
            raise ValueError(f"Maven resolution references a missing package: {missing[0]}")
        if package.coordinate.key in dependency_keys:
            raise ValueError(f"Maven resolution contains a self-edge: {package.coordinate.key}")
        if package.scope == "runtime":
            widened = [key for key in dependency_keys if packages[key].scope == "compile"]
            if widened:
                raise ValueError(
                    "Maven resolution effective scope widens from runtime to compile: "
                    + widened[0]
                )

    reachable = _reachable_packages(direct_key, packages)
    orphaned = sorted(set(packages) - reachable)
    if orphaned:
        raise ValueError(f"Maven resolution contains an unreachable package: {orphaned[0]}")
    _reject_cycles(direct_key, packages)

    return MavenSourceProfile(
        root=project,
        direct_dependencies=declared,
        packages=MappingProxyType(dict(packages)),
        pom_sha256=pom_sha256,
        repository=MAVEN_CENTRAL_REPOSITORY,
    )


def _parse_project_json(value: object) -> MavenProject:
    project = _require_object(
        value,
        keys={"groupId", "artifactId", "version", "packaging"},
        context="Maven resolution root",
    )
    if project["packaging"] != "jar":
        raise ValueError("Maven resolution root packaging must be jar")
    return MavenProject(
        coordinate=_coordinate(
            project["groupId"],
            project["artifactId"],
            project["version"],
            context="Maven resolution root",
        ),
        packaging="jar",
    )


def _parse_direct_json(value: object) -> MavenDependencyDeclaration:
    dependency = _require_object(
        value,
        keys={"groupId", "artifactId", "version", "scope"},
        context="Maven resolution direct dependency",
    )
    if dependency["scope"] != "compile":
        raise ValueError("Maven resolution supports one direct compile dependency only")
    return MavenDependencyDeclaration(
        coordinate=_coordinate(
            dependency["groupId"],
            dependency["artifactId"],
            dependency["version"],
            context="Maven resolution direct dependency",
        ),
        scope="compile",
    )


def _parse_package_json(value: object) -> MavenResolvedPackage:
    package = _require_object(
        value,
        keys={
            "groupId",
            "artifactId",
            "version",
            "scope",
            "dependencies",
            "pom",
            "artifact",
        },
        context="Maven resolution package",
    )
    coordinate = _coordinate(
        package["groupId"],
        package["artifactId"],
        package["version"],
        context="Maven resolution package",
    )
    scope = package["scope"]
    if not isinstance(scope, str) or scope not in _SUPPORTED_SCOPES:
        raise ValueError(f"Maven resolution package {coordinate.key} has an unsupported effective scope")
    dependencies_value = package["dependencies"]
    if not isinstance(dependencies_value, list) or any(not isinstance(item, str) for item in dependencies_value):
        raise ValueError(f"Maven resolution package {coordinate.key} dependencies must be coordinate strings")
    dependencies = tuple(
        _coordinate_from_key(item, context=f"Maven resolution dependency edge from {coordinate.key}")
        for item in dependencies_value
    )
    pom_url, pom_sha512 = _parse_artifact_claim(
        package["pom"],
        coordinate=coordinate,
        extension="pom",
        context=f"Maven resolution POM claim for {coordinate.key}",
    )
    artifact_url, artifact_sha512 = _parse_artifact_claim(
        package["artifact"],
        coordinate=coordinate,
        extension="jar",
        context=f"Maven resolution artifact claim for {coordinate.key}",
    )
    return MavenResolvedPackage(
        coordinate=coordinate,
        scope=scope,
        dependencies=dependencies,
        pom_url=pom_url,
        pom_sha512=pom_sha512,
        artifact_url=artifact_url,
        artifact_sha512=artifact_sha512,
    )


def _coordinate_from_key(value: str, *, context: str) -> MavenCoordinate:
    parts = value.split(":")
    if len(parts) != 3:
        raise ValueError(f"{context} is not a canonical groupId:artifactId:version coordinate")
    coordinate = _coordinate(parts[0], parts[1], parts[2], context=context)
    if coordinate.key != value:
        raise ValueError(f"{context} is not canonical")
    return coordinate


def _parse_artifact_claim(
    value: object,
    *,
    coordinate: MavenCoordinate,
    extension: str,
    context: str,
) -> Tuple[str, str]:
    claim = _require_object(value, keys={"url", "sha512"}, context=context)
    expected_url = _central_url(coordinate, extension=extension)
    if claim["url"] != expected_url:
        raise ValueError(f"{context} must use the canonical Maven Central URL")
    if not isinstance(claim["sha512"], str) or _SHA512.fullmatch(claim["sha512"]) is None:
        raise ValueError(f"{context} must contain a lowercase SHA-512 claim")
    return expected_url, claim["sha512"]


def _central_url(coordinate: MavenCoordinate, *, extension: str) -> str:
    group_path = coordinate.group_id.replace(".", "/")
    filename = f"{coordinate.artifact_id}-{coordinate.version}.{extension}"
    return (
        f"{MAVEN_CENTRAL_REPOSITORY}/{group_path}/{coordinate.artifact_id}/"
        f"{coordinate.version}/{filename}"
    )


def _reachable_packages(root_key: str, packages: Mapping[str, MavenResolvedPackage]) -> set[str]:
    reachable: set[str] = set()
    pending = [root_key]
    while pending:
        key = pending.pop()
        if key in reachable:
            continue
        reachable.add(key)
        pending.extend(dependency.key for dependency in packages[key].dependencies)
    return reachable


def _reject_cycles(root_key: str, packages: Mapping[str, MavenResolvedPackage]) -> None:
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
            raise ValueError(f"Maven resolution contains a dependency cycle at {dependency_key}")
        if dependency_state == 0:
            state[dependency_key] = 1
            stack.append((dependency_key, iter(packages[dependency_key].dependencies)))


__all__ = [
    "MAVEN_CENTRAL_REPOSITORY",
    "MAVEN_RESOLUTION_ARTIFACT_PATH",
    "MAVEN_RESOLUTION_PROFILE",
    "MAVEN_UNRESOLVED_EVIDENCE",
    "MavenCoordinate",
    "MavenDependencyDeclaration",
    "MavenProject",
    "MavenResolvedPackage",
    "MavenSourceProfile",
    "parse_maven_source_profile",
]
