"""Closed Composer v2 root-manifest and lock syntax custody.

The parser consumes two supplied UTF-8 texts.  It does not discover files,
recompute Composer's content hash, invoke Composer, contact Packagist, fetch a
distribution, or traverse the transitive dependency graph recorded in lock
package metadata.  A returned profile therefore has no evidence, Pack, or
execution authority.  It preserves exact-file custody and a deliberately
small, fail-closed Composer-v2 syntax subset only.

Composer lock files do not contain a literal lock-format field.  This profile
admits only the Composer-2 shape carrying a canonical stable 2.x
``plugin-api-version`` and labels that bounded syntax shape as lock format 2.
That does not attest the Composer binary or runtime which produced the text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import ipaddress
import math
import re
from typing import Any, Dict, Mapping, Optional, Tuple
from urllib.parse import urlsplit

from agentrail.dependencies.strict_json import loads_strict_json


COMPOSER_PROFILE = "php:composer:root_lock_v2_syntax_v1"
COMPOSER_MANIFEST_MAX_BYTES = 256 * 1024
COMPOSER_LOCK_MAX_BYTES = 8 * 1024 * 1024
COMPOSER_JSON_MAX_DEPTH = 32
COMPOSER_MANIFEST_MAX_JSON_VALUES = 10_000
COMPOSER_LOCK_MAX_JSON_VALUES = 500_000
COMPOSER_LOCK_MAX_PACKAGES = 20_000
COMPOSER_LOCK_MAX_REQUIREMENTS_PER_PACKAGE = 2_000
COMPOSER_DIST_URL_MAX_BYTES = 2_048
COMPOSER_REFERENCE_MAX_BYTES = 128

COMPOSER_GRAPH_STATUS_UNRESOLVED = "unresolved"
COMPOSER_GRAPH_REASON = (
    "lock package requirement constraints are bounded opaque text and are "
    "semantically unparsed; dependency edges are not traversed, so reachability, "
    "completeness, duplicate-edge semantics, and orphan status are unresolved"
)
COMPOSER_UNRESOLVED_LANES = (
    "committed_root_source_inventory",
    "composer_content_hash_recomputation",
    "packagist_repository_authenticity",
    "distribution_artifact_integrity",
    "transitive_dependency_graph_and_lock_resolution",
    "target_version_selection_and_target_lock_resolution",
    "security_advisory_evaluation",
    "composer_runtime_and_command_safety",
    "build_or_no_build_proof",
    "acceptance_evidence_and_context_pack_authority",
)

_PACKAGE_PART = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
_PACKAGE_NAME = re.compile(rf"^{_PACKAGE_PART}/{_PACKAGE_PART}$")
_PLATFORM_NAME = re.compile(
    r"^(?:php(?:-64bit)?|hhvm|ext-[a-z0-9]+(?:[._-][a-z0-9]+)*|"
    r"lib-[a-z0-9]+(?:[._-][a-z0-9]+)*|"
    r"composer-(?:plugin|runtime)-api)$"
)
_STABLE_VERSION = re.compile(
    r"^(?P<prefix>v)?(?P<major>0|[1-9][0-9]*)\."
    r"(?P<minor>0|[1-9][0-9]*)\."
    r"(?P<patch>0|[1-9][0-9]*)$"
)
_DIRECT_CONSTRAINT = re.compile(
    r"^(?P<operator>\^|~)?(?P<version>v?(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$"
)
_CONTENT_HASH = re.compile(r"^[0-9a-f]{32}$")
_REFERENCE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_SHASUM = re.compile(r"^(?:|[0-9a-f]{40})$")
_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_RFC3986_PATH = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@/\-]+$")
_RESERVED_HOST_SUFFIXES = (
    ".example",
    ".internal",
    ".invalid",
    ".local",
    ".localhost",
    ".test",
)

_ROOT_KEYS = {
    "name",
    "type",
    "require",
    "require-dev",
    "minimum-stability",
    "prefer-stable",
    "config",
}
_LOCK_KEYS = {
    "_readme",
    "content-hash",
    "packages",
    "packages-dev",
    "aliases",
    "minimum-stability",
    "stability-flags",
    "prefer-stable",
    "prefer-lowest",
    "platform",
    "platform-dev",
    "plugin-api-version",
}
_PACKAGE_KEYS = {
    "name",
    "version",
    "source",
    "dist",
    "require",
    "require-dev",
    "suggest",
    "type",
    "autoload",
    "autoload-dev",
    "notification-url",
    "license",
    "authors",
    "description",
    "homepage",
    "keywords",
    "support",
    "funding",
    "time",
    "abandoned",
    "bin",
}
_AMBIGUOUS_PACKAGE_KEYS = {
    "replace",
    "provide",
    "conflict",
    "extra",
    "scripts",
    "target-dir",
    "include-path",
    "transport-options",
}


@dataclass(frozen=True)
class ComposerSourceFileCustody:
    """Content identity for one exact supplied root-file text."""

    path: str
    sha256: str
    byte_count: int


@dataclass(frozen=True)
class ComposerDistributionClaim:
    """Syntactically admitted lockfile distribution fields, not integrity proof."""

    kind: str
    url: str
    reference: str
    shasum: str


@dataclass(frozen=True)
class ComposerSourceClaim:
    """Syntactically admitted VCS fields, not repository authenticity proof."""

    kind: str
    url: str
    reference: str


@dataclass(frozen=True)
class ComposerLockedPackage:
    """One stable package row from a lock lane, without graph semantics."""

    name: str
    version: str
    lane: str
    package_type: str
    source: Optional[ComposerSourceClaim]
    distribution: ComposerDistributionClaim


@dataclass(frozen=True)
class ComposerDirectPackage:
    """The sole root-selected package and its matching stable lock release."""

    name: str
    lane: str
    constraint: str
    locked_version: str


@dataclass(frozen=True)
class ComposerGraphProvenance:
    status: str
    reason: str


@dataclass(frozen=True)
class ComposerRootLockProfile:
    """Frozen syntax/custody result with deliberately absent authority."""

    root_name: Optional[str]
    root_type: Optional[str]
    direct_package: ComposerDirectPackage
    locked_packages: Tuple[ComposerLockedPackage, ...]
    content_hash_claim: str
    plugin_api_version: str
    file_custody: Tuple[ComposerSourceFileCustody, ...]
    graph_provenance: ComposerGraphProvenance
    profile: str = field(default=COMPOSER_PROFILE, init=False)
    lock_format: int = field(default=2, init=False)
    evidence_status: str = field(default="syntax_and_custody_only", init=False)
    authority: str = field(default="none", init=False)
    unresolved_lanes: Tuple[str, ...] = field(
        default=COMPOSER_UNRESOLVED_LANES, init=False
    )


@dataclass(frozen=True)
class _ParsedConstraint:
    spelling: str
    operator: str
    release: Tuple[int, int, int]


def parse_composer_root_lock(
    composer_json_text: object, composer_lock_text: object
) -> ComposerRootLockProfile:
    """Parse one supplied root ``composer.json`` and Composer-v2 lock text.

    The API has no filesystem, network, subprocess, registry, evidence, Pack,
    or execution seam.  Exact root-file placement and commit custody remain an
    explicit unresolved lane owned by a later source-inventory boundary.
    """

    manifest, manifest_bytes = _bounded_json(
        composer_json_text,
        document="composer.json",
        byte_limit=COMPOSER_MANIFEST_MAX_BYTES,
        value_limit=COMPOSER_MANIFEST_MAX_JSON_VALUES,
    )
    lock, lock_bytes = _bounded_json(
        composer_lock_text,
        document="composer.lock",
        byte_limit=COMPOSER_LOCK_MAX_BYTES,
        value_limit=COMPOSER_LOCK_MAX_JSON_VALUES,
    )

    root_name, root_type, lane, direct_name, constraint = _parse_manifest(manifest)
    (
        content_hash,
        plugin_api_version,
        locked_packages,
    ) = _parse_lock(lock, selected_lane=lane, root_name=root_name)

    matches = [package for package in locked_packages if package.name == direct_name]
    if len(matches) != 1:
        raise ValueError(
            "composer.lock must contain exactly one matching selected package entry"
        )
    locked = matches[0]
    if locked.lane != lane:
        raise ValueError("composer.lock places the selected package in the wrong lane")
    if not _constraint_matches(constraint, locked.version):
        raise ValueError(
            "composer.lock selected version does not satisfy the root constraint"
        )

    return ComposerRootLockProfile(
        root_name=root_name,
        root_type=root_type,
        direct_package=ComposerDirectPackage(
            name=direct_name,
            lane=lane,
            constraint=constraint.spelling,
            locked_version=locked.version,
        ),
        locked_packages=locked_packages,
        content_hash_claim=content_hash,
        plugin_api_version=plugin_api_version,
        file_custody=(
            ComposerSourceFileCustody(
                path="composer.json",
                sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                byte_count=len(manifest_bytes),
            ),
            ComposerSourceFileCustody(
                path="composer.lock",
                sha256=hashlib.sha256(lock_bytes).hexdigest(),
                byte_count=len(lock_bytes),
            ),
        ),
        graph_provenance=ComposerGraphProvenance(
            status=COMPOSER_GRAPH_STATUS_UNRESOLVED,
            reason=COMPOSER_GRAPH_REASON,
        ),
    )


def _bounded_json(
    value: object, *, document: str, byte_limit: int, value_limit: int
) -> Tuple[object, bytes]:
    if not isinstance(value, str):
        raise ValueError(f"{document} is not text")
    if len(value) > byte_limit:
        raise ValueError(f"{document} exceeds the byte limit")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{document} is not valid UTF-8 text") from exc
    if len(encoded) > byte_limit:
        raise ValueError(f"{document} exceeds the byte limit")
    try:
        parsed = loads_strict_json(value, document=document)
    except RecursionError as exc:
        raise ValueError(f"{document} exceeds the nesting limit") from exc
    _validate_json_shape(
        parsed,
        document=document,
        depth_limit=COMPOSER_JSON_MAX_DEPTH,
        value_limit=value_limit,
    )
    return parsed, encoded


def _validate_json_shape(
    value: object, *, document: str, depth_limit: int, value_limit: int
) -> None:
    count = 0
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > value_limit:
            raise ValueError(f"{document} exceeds the JSON value limit")
        if depth > depth_limit:
            raise ValueError(f"{document} exceeds the nesting limit")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ValueError(f"{document} contains a non-finite JSON number")


def _require_object(value: object, *, document: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{document} root must be a JSON object")
    return value


def _canonical_package_name(value: object, *, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value.encode("utf-8")) > 255
        or _PACKAGE_NAME.fullmatch(value) is None
    ):
        raise ValueError(f"{context} must use one canonical lowercase vendor/name")
    return value


def _stable_release(value: object, *, context: str) -> Tuple[int, int, int]:
    if not isinstance(value, str):
        raise ValueError(f"{context} must be an exact stable v?MAJOR.MINOR.PATCH release")
    matched = _STABLE_VERSION.fullmatch(value)
    if matched is None:
        raise ValueError(f"{context} must be an exact stable v?MAJOR.MINOR.PATCH release")
    components = matched.group("major", "minor", "patch")
    if any(len(component) > 9 for component in components):
        raise ValueError(f"{context} stable release exceeds the numeric bound")
    return tuple(int(component) for component in components)  # type: ignore[return-value]


def _parse_constraint(value: object) -> _ParsedConstraint:
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("Composer direct constraint is unsupported")
    matched = _DIRECT_CONSTRAINT.fullmatch(value)
    if matched is None:
        raise ValueError(
            "Composer direct constraint must be exact, ^, or ~ over one stable "
            "v?MAJOR.MINOR.PATCH release"
        )
    release = _stable_release(
        matched.group("version"), context="Composer direct constraint"
    )
    return _ParsedConstraint(
        spelling=value,
        operator=matched.group("operator") or "exact",
        release=release,
    )


def _constraint_matches(constraint: _ParsedConstraint, version: str) -> bool:
    actual = _stable_release(version, context="composer.lock package version")
    lower = constraint.release
    if constraint.operator == "exact":
        return actual == lower
    if actual < lower:
        return False
    major, minor, patch = lower
    if constraint.operator == "~":
        upper = (major, minor + 1, 0)
    elif major:
        upper = (major + 1, 0, 0)
    elif minor:
        upper = (0, minor + 1, 0)
    else:
        upper = (0, 0, patch + 1)
    return actual < upper


def _parse_manifest(
    value: object,
) -> Tuple[Optional[str], Optional[str], str, str, _ParsedConstraint]:
    document = _require_object(value, document="composer.json")
    unknown = sorted(set(document) - _ROOT_KEYS)
    if unknown:
        raise ValueError(
            "composer.json contains an unsupported root field: " + unknown[0]
        )

    root_name_value = document.get("name")
    root_name = (
        _canonical_package_name(root_name_value, context="composer.json root name")
        if root_name_value is not None
        else None
    )
    root_type_value = document.get("type")
    if root_type_value is not None and (
        not isinstance(root_type_value, str)
        or root_type_value not in {"project", "library"}
    ):
        raise ValueError(
            "composer.json root type must be project or library; plugins and custom "
            "installers are unsupported"
        )
    root_type = root_type_value if isinstance(root_type_value, str) else None

    if document.get("minimum-stability", "stable") != "stable":
        raise ValueError("composer.json minimum-stability must remain at stable")
    if document.get("prefer-stable", False) is not False:
        raise ValueError("composer.json prefer-stable must remain at its false default")
    _parse_config(document.get("config", {}))

    direct: list[Tuple[str, str, _ParsedConstraint]] = []
    for lane in ("require", "require-dev"):
        section = document.get(lane, {})
        if not isinstance(section, dict):
            raise ValueError(f"composer.json {lane} must be a JSON object")
        for raw_name, raw_constraint in section.items():
            name = _canonical_package_name(
                raw_name, context=f"composer.json {lane} package name"
            )
            direct.append((lane, name, _parse_constraint(raw_constraint)))
    if len(direct) != 1:
        raise ValueError(
            "composer.json must select exactly one direct package in require or require-dev"
        )
    lane, name, constraint = direct[0]
    if root_name == name:
        raise ValueError("composer.json cannot require its own root package")
    return root_name, root_type, lane, name, constraint


def _parse_config(value: object) -> None:
    if not isinstance(value, dict):
        raise ValueError("composer.json config must be a JSON object")
    unknown = sorted(set(value) - {"allow-plugins"})
    if unknown:
        if unknown[0] == "platform":
            raise ValueError("composer.json config.platform overrides are unsupported")
        raise ValueError("composer.json contains unsupported Composer config: " + unknown[0])
    if "allow-plugins" not in value:
        return
    allow_plugins = value["allow-plugins"]
    if allow_plugins is False:
        return
    if isinstance(allow_plugins, dict) and not allow_plugins:
        return
    raise ValueError("composer.json config.allow-plugins must be false or empty")


def _parse_lock(
    value: object, *, selected_lane: str, root_name: Optional[str]
) -> Tuple[str, str, Tuple[ComposerLockedPackage, ...]]:
    document = _require_object(value, document="composer.lock")
    unknown = sorted(set(document) - _LOCK_KEYS)
    missing = sorted(_LOCK_KEYS - set(document))
    if unknown:
        if unknown[0] == "platform-overrides":
            raise ValueError("composer.lock platform-overrides are unsupported")
        raise ValueError("composer.lock contains an unsupported top-level field: " + unknown[0])
    if missing:
        raise ValueError("composer.lock is missing required v2 field: " + missing[0])

    readme = document["_readme"]
    if (
        not isinstance(readme, list)
        or not readme
        or len(readme) > 8
        or any(not isinstance(line, str) or len(line) > 512 for line in readme)
    ):
        raise ValueError("composer.lock _readme is malformed")
    content_hash = document["content-hash"]
    if not isinstance(content_hash, str) or _CONTENT_HASH.fullmatch(content_hash) is None:
        raise ValueError("composer.lock content-hash must be 32 lowercase hexadecimal characters")
    plugin_api_version = document["plugin-api-version"]
    parsed_plugin_api = _stable_release(
        plugin_api_version, context="composer.lock plugin-api-version"
    )
    if (
        parsed_plugin_api[0] != 2
        or not isinstance(plugin_api_version, str)
        or plugin_api_version.startswith("v")
    ):
        raise ValueError("composer.lock is not the admitted Composer v2 lock shape")
    if document["aliases"] != []:
        raise ValueError("composer.lock aliases are unsupported")
    if document["minimum-stability"] != "stable":
        raise ValueError("composer.lock minimum-stability must remain at stable")
    if document["stability-flags"] != {}:
        raise ValueError("composer.lock stability-flags must be empty")
    if document["prefer-stable"] is not False:
        raise ValueError("composer.lock prefer-stable must remain false")
    if document["prefer-lowest"] is not False:
        raise ValueError("composer.lock prefer-lowest must remain false")
    if document["platform"] != {} or document["platform-dev"] != {}:
        raise ValueError("composer.lock platform requirements are unsupported")

    raw_packages = document["packages"]
    raw_dev_packages = document["packages-dev"]
    if not isinstance(raw_packages, list) or not isinstance(raw_dev_packages, list):
        raise ValueError("composer.lock package lanes must be JSON arrays")
    if len(raw_packages) + len(raw_dev_packages) > COMPOSER_LOCK_MAX_PACKAGES:
        raise ValueError("composer.lock exceeds the package-count limit")
    other_lane = "require-dev" if selected_lane == "require" else "require"
    other_rows = raw_dev_packages if selected_lane == "require" else raw_packages
    if other_rows:
        raise ValueError(
            "composer.lock contains package rows in the undeclared root lane: "
            + other_lane
        )

    parsed: list[ComposerLockedPackage] = []
    identities: Dict[str, str] = {}
    for lane, rows in (("require", raw_packages), ("require-dev", raw_dev_packages)):
        lane_packages = [_parse_lock_package(row, lane=lane) for row in rows]
        order = [(package.name, package.version) for package in lane_packages]
        if order != sorted(order):
            raise ValueError(f"composer.lock {lane} package rows must be sorted")
        for package in lane_packages:
            if root_name is not None and package.name == root_name:
                raise ValueError(
                    "composer.lock package identity collides with the root package: "
                    + package.name
                )
            previous = identities.get(package.name)
            if previous is not None:
                raise ValueError(
                    "composer.lock duplicates or case-collides package identity: "
                    + package.name
                )
            identities[package.name] = lane
            parsed.append(package)
    if not parsed:
        raise ValueError("composer.lock has no package rows")
    assert isinstance(plugin_api_version, str)
    return content_hash, plugin_api_version, tuple(parsed)


def _parse_lock_package(value: object, *, lane: str) -> ComposerLockedPackage:
    if not isinstance(value, dict):
        raise ValueError("composer.lock contains a malformed package row")
    ambiguous = sorted(set(value) & _AMBIGUOUS_PACKAGE_KEYS)
    if ambiguous:
        if ambiguous[0] == "source":
            raise ValueError(
                "composer.lock source/dist selection is ambiguous; the v1 profile "
                "admits dist-only rows"
            )
        raise ValueError(
            "composer.lock package contains unsupported resolution ambiguity: "
            + ambiguous[0]
        )
    unknown = sorted(set(value) - _PACKAGE_KEYS)
    if unknown:
        raise ValueError("composer.lock package contains an unsupported field: " + unknown[0])
    missing = sorted({"name", "version", "dist", "type"} - set(value))
    if missing:
        raise ValueError("composer.lock package is missing required field: " + missing[0])

    name = _canonical_package_name(value["name"], context="composer.lock package name")
    version_value = value["version"]
    _stable_release(version_value, context="composer.lock package version")
    assert isinstance(version_value, str)
    if value["type"] != "library":
        raise ValueError(
            "composer.lock package type must be library; plugins and custom "
            "installers are unsupported"
        )
    requirement_maps = []
    for key in ("require", "require-dev"):
        if key in value:
            requirements = value[key]
            if not isinstance(requirements, dict):
                raise ValueError(f"composer.lock package {key} must be a JSON object")
            requirement_maps.append((key, requirements))
    if sum(len(requirements) for _, requirements in requirement_maps) > (
        COMPOSER_LOCK_MAX_REQUIREMENTS_PER_PACKAGE
    ):
        raise ValueError(
            "composer.lock package exceeds the combined requirement-count limit"
        )
    for key, requirements in requirement_maps:
        _validate_opaque_requirements(
            requirements, context=f"composer.lock package {key}"
        )
    distribution = _parse_distribution(value["dist"])
    source = _parse_source(value["source"]) if "source" in value else None
    if source is not None and source.reference != distribution.reference:
        raise ValueError(
            "composer.lock source and dist references must identify the same release"
        )
    return ComposerLockedPackage(
        name=name,
        version=version_value,
        lane=lane,
        package_type="library",
        source=source,
        distribution=distribution,
    )


def _validate_opaque_requirements(
    value: Mapping[str, Any], *, context: str
) -> None:
    seen: set[str] = set()
    for raw_name, raw_constraint in value.items():
        if not isinstance(raw_name, str) or not isinstance(raw_constraint, str):
            raise ValueError(f"{context} contains a malformed requirement")
        if "/" in raw_name:
            identity = _canonical_package_name(raw_name, context=f"{context} package name")
        elif _PLATFORM_NAME.fullmatch(raw_name) is not None:
            identity = raw_name
        else:
            raise ValueError(f"{context} contains an unsupported requirement identity")
        if identity in seen:
            raise ValueError(f"{context} duplicates or case-collides a requirement identity")
        seen.add(identity)
        if not raw_constraint or len(raw_constraint) > 512:
            raise ValueError(f"{context} contains an unsupported requirement spelling")


def _parse_distribution(value: object) -> ComposerDistributionClaim:
    if not isinstance(value, dict):
        raise ValueError("composer.lock dist must be a JSON object")
    required = {"type", "url", "reference", "shasum"}
    if set(value) != required:
        raise ValueError(
            "composer.lock dist must contain exactly type, url, reference, and shasum"
        )
    if value["type"] != "zip":
        raise ValueError("composer.lock supports HTTPS zip distributions only")
    url = _canonical_https_url(value["url"], context="composer.lock dist URL")
    reference = value["reference"]
    if (
        not isinstance(reference, str)
        or len(reference) > COMPOSER_REFERENCE_MAX_BYTES
        or _REFERENCE.fullmatch(reference) is None
    ):
        raise ValueError("composer.lock dist reference must be bounded lowercase hex")
    shasum = value["shasum"]
    if not isinstance(shasum, str) or _SHASUM.fullmatch(shasum) is None:
        raise ValueError("composer.lock dist shasum claim is malformed")
    return ComposerDistributionClaim(
        kind="zip",
        url=url,
        reference=reference,
        shasum=shasum,
    )


def _parse_source(value: object) -> ComposerSourceClaim:
    if not isinstance(value, dict):
        raise ValueError("composer.lock source must be a JSON object")
    if set(value) != {"type", "url", "reference"}:
        raise ValueError(
            "composer.lock source must contain exactly type, url, and reference"
        )
    if value["type"] != "git":
        raise ValueError("composer.lock supports HTTPS git source claims only")
    url = _canonical_https_url(value["url"], context="composer.lock source URL")
    if not url.endswith(".git"):
        raise ValueError("composer.lock git source URL must end in .git")
    reference = value["reference"]
    if (
        not isinstance(reference, str)
        or len(reference) > COMPOSER_REFERENCE_MAX_BYTES
        or _REFERENCE.fullmatch(reference) is None
    ):
        raise ValueError("composer.lock source reference must be bounded lowercase hex")
    return ComposerSourceClaim(kind="git", url=url, reference=reference)


def _canonical_https_url(value: object, *, context: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{context} is not text")
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{context} must use canonical ASCII") from exc
    if (
        not value
        or len(encoded) > COMPOSER_DIST_URL_MAX_BYTES
        or not value.startswith("https://")
        or value != value.strip()
        or any(
            character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F
            for character in value
        )
        or "\\" in value
        or "%" in value
        or "?" in value
        or "#" in value
    ):
        raise ValueError(f"{context} is not canonical")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"{context} is malformed") from exc
    host = parsed.hostname
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
        or not parsed.path.startswith("/")
        or parsed.path in {"", "/"}
        or "//" in parsed.path
        or _RFC3986_PATH.fullmatch(parsed.path) is None
    ):
        raise ValueError(f"{context} must be one unambiguous HTTPS URL")
    canonical_netloc = host if port is None else f"{host}:{port}"
    if host != host.lower() or parsed.netloc != canonical_netloc:
        raise ValueError(f"{context} host must be canonical lowercase DNS")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError(f"{context} must not use an IP address")
    if (
        "." not in host
        or len(host.encode("ascii")) > 253
        or host == "localhost"
        or host.endswith(_RESERVED_HOST_SUFFIXES)
        or any(_DNS_LABEL.fullmatch(label) is None for label in host.split("."))
    ):
        raise ValueError(f"{context} host is not admitted public DNS syntax")
    if any(segment in {".", ".."} for segment in parsed.path.split("/")):
        raise ValueError(f"{context} path is not canonical")
    return value


__all__ = [
    "COMPOSER_GRAPH_REASON",
    "COMPOSER_GRAPH_STATUS_UNRESOLVED",
    "COMPOSER_PROFILE",
    "COMPOSER_UNRESOLVED_LANES",
    "ComposerDirectPackage",
    "ComposerDistributionClaim",
    "ComposerGraphProvenance",
    "ComposerLockedPackage",
    "ComposerRootLockProfile",
    "ComposerSourceClaim",
    "ComposerSourceFileCustody",
    "parse_composer_root_lock",
]
