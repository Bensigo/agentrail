"""Strict, non-admitted Go Modules observation primitives.

This module recognizes one deliberately small Go shape: a single root
``go.mod`` plus a committed ``go.sum``, exact direct stable requirements, and
release rows fetched from the public ``proxy.golang.org`` list endpoint.  It
does not invoke ``go``, inspect ambient Go configuration, authenticate sums
against ``sum.golang.org``, or grant an evidence-gate, Pack, or managed-
execution capability.  ``go.sum`` values are syntax-checked caller-provided
baseline material only.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import ipaddress
import re
from typing import Dict, Iterable, Mapping, Optional, Sequence, Tuple


GO_MODULES_OBSERVATION_PROFILE = "go_root_public_proxy_lock_v1"
GO_PROXY_ORIGIN = "https://proxy.golang.org"
GO_MOD_MAX_BYTES = 256 * 1024
GO_SUM_MAX_BYTES = 8 * 1024 * 1024
GO_MAX_DIRECT_REQUIREMENTS = 2_000
GO_SUM_MAX_ROWS = 100_000
GO_PROXY_LIST_MAX_BYTES = 1024 * 1024
GO_PROXY_LIST_MAX_VERSIONS = 20_000
GO_MODULE_PATH_MAX_BYTES = 500
GO_GITHUB_TREE_MAX_ENTRIES = 20_000
GO_VERSION_COMPONENT_MAX_DIGITS = 16

_GO_STABLE_VERSION = re.compile(
    r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"
)
_GO_DIRECT_REQUIREMENT = re.compile(r"^(\S+) (\S+)$")
_GO_DIRECTIVE = re.compile(r"^([a-z][a-z0-9]*)\b(?:\s+(.*))?$")
_GO_LANGUAGE_VERSION = re.compile(
    r"^1\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$"
)
_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_PATH_ELEMENT = re.compile(r"^[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$")
_PATH_MAJOR = re.compile(r"^v(0|[1-9]\d*)$")
_NUMERIC_LOOKING_PATH_MAJOR = re.compile(r"^v[0-9.]+$")
_GOPKG_MAJOR = re.compile(r"\.v(0|[1-9]\d*)$")
_WINDOWS_RESERVED = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.I
)
_WINDOWS_SHORT_NAME = re.compile(r"~[0-9]+$")
_RESERVED_PUBLIC_SUFFIXES = (
    ".example",
    ".internal",
    ".invalid",
    ".local",
    ".localhost",
    ".test",
)
_UNMODELLED_DIRECTIVES = frozenset(
    {
        "exclude",
        "godebug",
        "replace",
        "retract",
        "tool",
        "toolchain",
    }
)
_FORBIDDEN_CONFIG_BASENAMES = frozenset(
    {".gitconfig", ".goenv", ".netrc", "go.env"}
)


@dataclass(frozen=True)
class GoDirectRequirement:
    module_path: str
    version: str


@dataclass(frozen=True)
class GoModuleFiles:
    module_path: str
    go_version: str
    requirements: Mapping[str, GoDirectRequirement]
    sums: Mapping[Tuple[str, str, str], str]


def stable_go_version(value: object) -> Optional[Tuple[int, int, int]]:
    """Return the numeric tuple for one canonical stable ``vX.Y.Z``."""

    if not isinstance(value, str):
        return None
    matched = _GO_STABLE_VERSION.fullmatch(value)
    if matched is None:
        return None
    parts = matched.groups()
    if any(len(part) > GO_VERSION_COMPONENT_MAX_DIGITS for part in parts):
        return None
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


def compare_go_versions(left: str, right: str) -> int:
    left_version = stable_go_version(left)
    right_version = stable_go_version(right)
    if left_version is None or right_version is None:
        raise ValueError("Go versions must be canonical stable vX.Y.Z releases")
    return (left_version > right_version) - (left_version < right_version)


def validate_go_module_path(module_path: object) -> Optional[str]:
    """Validate the conservative lowercase public-module path subset."""

    if not isinstance(module_path, str) or not module_path:
        return "Go module path is missing"
    try:
        encoded = module_path.encode("ascii")
    except UnicodeEncodeError:
        return "Go module path must use the canonical ASCII subset"
    if len(encoded) > GO_MODULE_PATH_MAX_BYTES:
        return "Go module path exceeds the byte limit"
    if module_path != module_path.lower():
        return "Go v1 supports only canonical lowercase public module paths"
    if (
        module_path != module_path.strip()
        or "//" in module_path
        or "\\" in module_path
    ):
        return "Go module path is not canonical"

    elements = module_path.split("/")
    host = elements[0]
    if len(elements) < 2 or "." not in host:
        return "Go module path must name a public dotted host and repository path"
    if host.endswith(_RESERVED_PUBLIC_SUFFIXES):
        return "Go module path host is not a public registry identity"
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return "Go module path host must not be an IP address"
    host_labels = host.split(".")
    if any(
        len(label.encode("ascii")) > 63
        or _DNS_LABEL.fullmatch(label) is None
        or not _portable_go_path_element(label)
        for label in host_labels
    ):
        return "Go module path host is not canonical lowercase DNS"
    for element in elements[1:]:
        if (
            len(element.encode("ascii")) > 128
            or _PATH_ELEMENT.fullmatch(element) is None
            or not _portable_go_path_element(element)
            or ".." in element
            or element.endswith((".git", ".hg", ".bzr", ".svn"))
        ):
            return "Go module path contains an unsupported or ambiguous path element"
    return None


def _portable_go_path_element(element: str) -> bool:
    prefix = element.split(".", 1)[0]
    return (
        _WINDOWS_RESERVED.fullmatch(prefix) is None
        and _WINDOWS_SHORT_NAME.search(prefix) is None
    )


def _declared_path_major(module_path: str) -> Optional[int]:
    last = module_path.rsplit("/", 1)[-1]
    standard = _PATH_MAJOR.fullmatch(last)
    if standard is not None:
        raw_major = standard.group(1)
        if len(raw_major) > GO_VERSION_COMPONENT_MAX_DIGITS:
            return -2
        return int(raw_major)
    if _NUMERIC_LOOKING_PATH_MAJOR.fullmatch(last) is not None:
        return -3
    if module_path.startswith("gopkg.in/"):
        gopkg = _GOPKG_MAJOR.search(last)
        if gopkg is None:
            return -1
        raw_major = gopkg.group(1)
        if len(raw_major) > GO_VERSION_COMPONENT_MAX_DIGITS:
            return -2
        return int(raw_major)
    return None


def validate_go_module_version(module_path: object, version: object) -> Optional[str]:
    """Bind a stable version to Go's semantic import-version path rule."""

    path_error = validate_go_module_path(module_path)
    if path_error is not None:
        return path_error
    parsed = stable_go_version(version)
    if parsed is None:
        return "Go v1 supports only canonical stable vMAJOR.MINOR.PATCH releases"
    assert isinstance(module_path, str)
    declared_major = _declared_path_major(module_path)
    version_major = parsed[0]
    if declared_major == -1:
        return "gopkg.in module paths must end in a canonical .vN major suffix"
    if declared_major == -2:
        return "Go semantic import-version suffix exceeds the numeric bound"
    if declared_major == -3:
        return "Go module path has an ambiguous numeric-looking major suffix"
    if declared_major is not None:
        minimum = 1 if module_path.startswith("gopkg.in/") else 2
        if declared_major < minimum:
            return "Go semantic import-version suffix is below the supported major"
        if declared_major != version_major:
            return "Go module path major suffix does not match its release major"
    elif version_major >= 2:
        return "Go v2+ module path is missing its semantic /vN suffix"
    return None


def go_proxy_escape_path(module_path: object) -> str:
    """Return the exact Go proxy path for the supported lowercase subset."""

    error = validate_go_module_path(module_path)
    if error is not None:
        raise ValueError(error)
    assert isinstance(module_path, str)
    # Go's module.EscapePath only adds ! escapes for uppercase letters.  This
    # profile rejects uppercase identities, so the canonical proxy path is the
    # validated module path byte-for-byte.
    return module_path


def go_proxy_list_url(module_path: object) -> str:
    return f"{GO_PROXY_ORIGIN}/{go_proxy_escape_path(module_path)}/@v/list"


def _text_size(value: object, label: str, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return f"{label} is not text"
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return f"{label} is not valid UTF-8 text"
    if size > limit:
        return f"{label} exceeds the byte limit"
    if "\x00" in value or "\r" in value:
        return f"{label} contains unsupported control or line-ending bytes"
    return None


def _parse_requirement(value: str, *, line_number: int) -> GoDirectRequirement:
    if "//" in value:
        raise ValueError(
            "go.mod direct requirements cannot be indirect or commented "
            f"at line {line_number}"
        )
    matched = _GO_DIRECT_REQUIREMENT.fullmatch(value)
    if matched is None:
        raise ValueError(f"go.mod has an unsupported require entry at line {line_number}")
    module_path, version = matched.groups()
    error = validate_go_module_version(module_path, version)
    if error is not None:
        raise ValueError(f"{error}: {module_path}@{version}")
    return GoDirectRequirement(module_path, version)


def parse_go_mod(text: object) -> Tuple[str, str, Mapping[str, GoDirectRequirement]]:
    """Parse the exact root, direct-require-only ``go.mod`` v1 subset."""

    size_error = _text_size(text, "go.mod", GO_MOD_MAX_BYTES)
    if size_error is not None:
        raise ValueError(size_error)
    assert isinstance(text, str)
    module_path: Optional[str] = None
    go_version: Optional[str] = None
    requirements: Dict[str, GoDirectRequirement] = {}
    folded_requirements: Dict[str, str] = {}
    in_require = False

    for line_number, raw_line in enumerate(text.split("\n"), start=1):
        line = raw_line.strip()
        if not line or line.startswith("//"):
            continue
        if in_require:
            if line == ")":
                in_require = False
                continue
            requirement = _parse_requirement(line, line_number=line_number)
            _add_requirement(requirements, folded_requirements, requirement)
            if len(requirements) > GO_MAX_DIRECT_REQUIREMENTS:
                raise ValueError("go.mod exceeds the direct-requirement limit")
            continue
        if line == ")":
            raise ValueError(
                f"go.mod has an unmatched require block terminator at line {line_number}"
            )
        if line == "require (":
            in_require = True
            continue
        matched = _GO_DIRECTIVE.fullmatch(line)
        if matched is None:
            raise ValueError(f"go.mod contains unsupported syntax at line {line_number}")
        directive, value = matched.groups()
        value = value or ""
        if directive in _UNMODELLED_DIRECTIVES:
            raise ValueError(f"Go v1 rejects the {directive} directive")
        if directive == "module":
            if module_path is not None or " " in value or "//" in value:
                raise ValueError("go.mod must contain exactly one canonical module directive")
            error = validate_go_module_path(value)
            if error is not None:
                raise ValueError(error)
            module_path = value
        elif directive == "go":
            language_match = _GO_LANGUAGE_VERSION.fullmatch(value)
            if (
                go_version is not None
                or language_match is None
                or any(
                    len(part) > GO_VERSION_COMPONENT_MAX_DIGITS
                    for part in language_match.groups()
                    if part is not None
                )
            ):
                raise ValueError("go.mod must contain one canonical Go language version")
            go_version = value
        elif directive == "require":
            requirement = _parse_requirement(value, line_number=line_number)
            _add_requirement(requirements, folded_requirements, requirement)
            if len(requirements) > GO_MAX_DIRECT_REQUIREMENTS:
                raise ValueError("go.mod exceeds the direct-requirement limit")
        else:
            raise ValueError(f"Go v1 does not model the {directive} directive")

    if in_require:
        raise ValueError("go.mod has an unterminated require block")
    if module_path is None:
        raise ValueError("go.mod has no root module directive")
    if go_version is None:
        raise ValueError("go.mod has no canonical Go language version")
    if not requirements:
        raise ValueError("go.mod has no supported direct require entries")
    if module_path in requirements:
        raise ValueError("go.mod cannot require its own root module path")
    return module_path, go_version, requirements


def _add_requirement(
    requirements: Dict[str, GoDirectRequirement],
    folded_requirements: Dict[str, str],
    requirement: GoDirectRequirement,
) -> None:
    folded = requirement.module_path.casefold()
    previous = folded_requirements.get(folded)
    if previous is not None:
        if previous == requirement.module_path:
            raise ValueError(f"go.mod declares {requirement.module_path} more than once")
        raise ValueError(
            "go.mod contains case-ambiguous module paths: "
            f"{previous} and {requirement.module_path}"
        )
    folded_requirements[folded] = requirement.module_path
    requirements[requirement.module_path] = requirement


def _canonical_h1(value: str) -> bool:
    if not value.startswith("h1:"):
        return False
    encoded = value[3:]
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(decoded) == 32 and base64.b64encode(decoded).decode("ascii") == encoded


def parse_go_sum(text: object) -> Mapping[Tuple[str, str, str], str]:
    """Parse checksum syntax; returned fields are not authenticated proof."""

    size_error = _text_size(text, "go.sum", GO_SUM_MAX_BYTES)
    if size_error is not None:
        raise ValueError(size_error)
    assert isinstance(text, str)
    sums: Dict[Tuple[str, str, str], str] = {}
    folded_paths: Dict[str, str] = {}
    row_count = 0
    for line_number, raw_line in enumerate(text.split("\n"), start=1):
        if not raw_line:
            continue
        if raw_line != raw_line.strip() or "\t" in raw_line:
            raise ValueError(f"go.sum has a malformed row at line {line_number}")
        row_count += 1
        if row_count > GO_SUM_MAX_ROWS:
            raise ValueError("go.sum exceeds the row limit")
        fields = raw_line.split(" ")
        if len(fields) != 3 or any(not field for field in fields):
            raise ValueError(f"go.sum has a malformed row at line {line_number}")
        module_path, raw_version, checksum = fields
        kind = "go.mod" if raw_version.endswith("/go.mod") else "module"
        version = raw_version[:-7] if kind == "go.mod" else raw_version
        error = validate_go_module_version(module_path, version)
        if error is not None:
            raise ValueError(f"{error} in go.sum at line {line_number}")
        if not _canonical_h1(checksum):
            raise ValueError(f"go.sum h1 checksum syntax is malformed at line {line_number}")
        folded = module_path.casefold()
        previous = folded_paths.get(folded)
        if previous is not None and previous != module_path:
            raise ValueError(
                "go.sum contains case-ambiguous module paths: "
                f"{previous} and {module_path}"
            )
        folded_paths[folded] = module_path
        key = (module_path, version, kind)
        if key in sums:
            raise ValueError(
                "go.sum contains duplicate checksum rows for "
                f"{module_path}@{raw_version}"
            )
        sums[key] = checksum
    if not sums:
        raise ValueError("go.sum has no checksum rows")
    return sums


def go_snapshot_path_refusal(paths: Iterable[object]) -> Optional[str]:
    """Return why supplied repository paths cannot support the root profile.

    The check is deliberately limited to paths the caller supplied.  Absence
    from an arbitrary mapping is not proof of repository or ambient absence.
    """

    folded_paths: Dict[str, str] = {}
    for raw_path in paths:
        if not isinstance(raw_path, str) or not raw_path:
            return "Go snapshot paths must be non-empty text"
        path = raw_path.replace("\\", "/")
        folded = path.casefold()
        previous = folded_paths.get(folded)
        if previous is not None and previous != path:
            return f"Go snapshot contains case-ambiguous paths: {previous} and {path}"
        folded_paths[folded] = path
        parts = path.split("/")
        folded_parts = [part.casefold() for part in parts]
        folded_basename = folded_parts[-1]
        folded_path = "/".join(folded_parts)
        if folded_basename in ("go.work", "go.work.sum"):
            return "Go v1 rejects go.work workspace state"
        if folded_basename in ("go.mod", "go.sum") and path not in ("go.mod", "go.sum"):
            return "Go v1 rejects nested or multiple module roots"
        if "vendor" in folded_parts:
            return "Go v1 rejects vendored module state"
        if (
            folded_basename in _FORBIDDEN_CONFIG_BASENAMES
            or folded_path == ".config/go/env"
            or folded_path.endswith("/.config/go/env")
        ):
            return "Go v1 rejects supplied repository or credential configuration"
    return None


def parse_go_module_files(
    go_mod: object,
    go_sum: object,
    *,
    supplied_paths: Iterable[object] = ("go.mod", "go.sum"),
) -> GoModuleFiles:
    refusal = go_snapshot_path_refusal(supplied_paths)
    if refusal is not None:
        raise ValueError(refusal)
    module_path, go_version, requirements = parse_go_mod(go_mod)
    sums = parse_go_sum(go_sum)
    for requirement in requirements.values():
        missing = [
            kind
            for kind in ("module", "go.mod")
            if (requirement.module_path, requirement.version, kind) not in sums
        ]
        if missing:
            raise ValueError(
                "go.sum has no complete current syntax baseline for "
                f"{requirement.module_path}@{requirement.version}: "
                f"missing {', '.join(missing)}"
            )
    return GoModuleFiles(module_path, go_version, requirements, sums)


def validate_go_proxy_versions(
    module_path: object, versions: Sequence[object]
) -> Tuple[str, ...]:
    error = validate_go_module_path(module_path)
    if error is not None:
        raise ValueError(error)
    if isinstance(versions, (str, bytes)) or not isinstance(versions, (tuple, list)):
        raise ValueError("Go proxy list rows must be a bounded sequence")
    if not versions:
        raise ValueError("Go proxy list has no release rows")
    if len(versions) > GO_PROXY_LIST_MAX_VERSIONS:
        raise ValueError("Go proxy list exceeds the release-row limit")
    parsed = []
    seen = set()
    for version in versions:
        error = validate_go_module_version(module_path, version)
        if error is not None:
            raise ValueError(f"Go proxy list contains an unsupported release: {error}")
        assert isinstance(version, str)
        if version in seen:
            raise ValueError(f"Go proxy list contains duplicate release row {version}")
        seen.add(version)
        parsed.append(version)
    return tuple(parsed)


def parse_go_proxy_list(module_path: object, text: object) -> Tuple[str, ...]:
    size_error = _text_size(text, "Go proxy list", GO_PROXY_LIST_MAX_BYTES)
    if size_error is not None:
        raise ValueError(size_error)
    assert isinstance(text, str)
    body = text[:-1] if text.endswith("\n") else text
    if not body:
        raise ValueError("Go proxy list has no release rows")
    rows = body.split("\n")
    for line_number, raw_line in enumerate(rows, start=1):
        if (
            not raw_line
            or raw_line != raw_line.strip()
            or any(character.isspace() for character in raw_line)
        ):
            raise ValueError(f"Go proxy list has a malformed row at line {line_number}")
    return validate_go_proxy_versions(module_path, rows)


def same_go_major_versions(current: str, versions: Sequence[str]) -> Tuple[str, ...]:
    current_release = stable_go_version(current)
    if current_release is None:
        raise ValueError("locked Go version must be a canonical stable release")
    compatible = []
    for version in versions:
        release = stable_go_version(version)
        if release is not None and release[0] == current_release[0]:
            compatible.append(version)
    return tuple(compatible)


__all__ = [
    "GO_GITHUB_TREE_MAX_ENTRIES",
    "GO_MAX_DIRECT_REQUIREMENTS",
    "GO_MOD_MAX_BYTES",
    "GO_MODULES_OBSERVATION_PROFILE",
    "GO_MODULE_PATH_MAX_BYTES",
    "GO_PROXY_LIST_MAX_BYTES",
    "GO_PROXY_LIST_MAX_VERSIONS",
    "GO_PROXY_ORIGIN",
    "GO_SUM_MAX_BYTES",
    "GO_SUM_MAX_ROWS",
    "GO_VERSION_COMPONENT_MAX_DIGITS",
    "GoDirectRequirement",
    "GoModuleFiles",
    "compare_go_versions",
    "go_proxy_escape_path",
    "go_proxy_list_url",
    "go_snapshot_path_refusal",
    "parse_go_mod",
    "parse_go_module_files",
    "parse_go_proxy_list",
    "parse_go_sum",
    "same_go_major_versions",
    "stable_go_version",
    "validate_go_module_path",
    "validate_go_module_version",
    "validate_go_proxy_versions",
]
