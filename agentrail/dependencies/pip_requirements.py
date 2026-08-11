"""Strict paired-file syntax and custody primitives for pip requirements.

This module deliberately parses only a small, canonical subset of two supplied
root files: ``requirements.in`` for exact direct intent and
``requirements.txt`` for exact pins with caller-supplied sha256 fields.  The
standard files do not encode dependency edges, so a successfully parsed pair
still reports graph provenance as unresolved.  This module does not invoke
pip, authenticate PyPI or hashes, attest pip-tools, regenerate a target file,
grant evidence/Pack authority, or execute an upgrade.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Mapping, Tuple


PIP_REQUIREMENTS_IN_MAX_BYTES = 64 * 1024
PIP_REQUIREMENTS_TXT_MAX_BYTES = 4 * 1024 * 1024
PIP_REQUIREMENTS_IN_MAX_LINES = 1_024
PIP_REQUIREMENTS_TXT_MAX_LINES = 10_000
PIP_REQUIREMENT_LINE_MAX_BYTES = 16 * 1024
PIP_MAX_DIRECT_REQUIREMENTS = 512
PIP_MAX_COMPILED_REQUIREMENTS = 5_000
PIP_MAX_HASHES_PER_REQUIREMENT = 32
PIP_MAX_TOTAL_HASHES = 100_000

PIP_GRAPH_PROVENANCE_UNRESOLVED = "unresolved"
PIP_GRAPH_PROVENANCE_REASON = (
    "requirements.in and requirements.txt do not encode the dependency edges "
    "needed to prove a complete reachable graph"
)

_REQUIRED_ROOT_FILES = frozenset(("requirements.in", "requirements.txt"))
_RAW_DISTRIBUTION_NAME = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$"
)
_CANONICAL_DISTRIBUTION_NAME = re.compile(
    r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
)
_STABLE_RELEASE = re.compile(
    r"^(?:0|[1-9][0-9]{0,15})(?:\.(?:0|[1-9][0-9]{0,15})){0,3}$"
)
_SHA256_TOKEN = re.compile(r"^--hash=sha256:([0-9a-f]{64})$")


@dataclass(frozen=True)
class PipDirectRequirement:
    """One exact, canonical direct requirement from ``requirements.in``."""

    name: str
    version: str


@dataclass(frozen=True)
class PipCompiledRequirement:
    """One exact compiled pin with syntactically valid supplied hashes."""

    name: str
    version: str
    sha256_hashes: Tuple[str, ...]


@dataclass(frozen=True)
class PipGraphProvenance:
    """Whether the supplied files prove their complete dependency graph."""

    status: str
    reason: str


@dataclass(frozen=True)
class PipSourceFileCustody:
    """Content identity for one exact root file supplied to the parser."""

    path: str
    sha256: str
    byte_count: int


@dataclass(frozen=True)
class PipPairedRequirements:
    """The admitted syntax plus an explicit graph-provenance boundary."""

    direct: Tuple[PipDirectRequirement, ...]
    compiled: Tuple[PipCompiledRequirement, ...]
    file_custody: Tuple[PipSourceFileCustody, ...]
    graph_provenance: PipGraphProvenance


def _bounded_lines(
    value: object,
    *,
    document: str,
    max_bytes: int,
    max_lines: int,
) -> Tuple[Tuple[str, ...], bytes]:
    if not isinstance(value, str):
        raise ValueError(f"{document} is not text")
    # UTF-8 uses at least one byte per code point.  This avoids encoding a
    # caller-supplied string that is already known to exceed the byte budget.
    if len(value) > max_bytes:
        raise ValueError(f"{document} exceeds the byte limit")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{document} is not valid UTF-8 text") from exc
    if len(encoded) > max_bytes:
        raise ValueError(f"{document} exceeds the byte limit")
    if "\r" in value:
        raise ValueError(f"{document} must use LF line endings")
    if value.startswith("\ufeff"):
        raise ValueError(f"{document} must not contain a byte-order mark")
    if value.count("\n") + 1 > max_lines:
        raise ValueError(f"{document} exceeds the line limit")

    lines = tuple(value.split("\n"))
    for number, line in enumerate(lines, start=1):
        if len(line) > PIP_REQUIREMENT_LINE_MAX_BYTES:
            raise ValueError(f"{document} line {number} exceeds the byte limit")
        if len(line.encode("utf-8")) > PIP_REQUIREMENT_LINE_MAX_BYTES:
            raise ValueError(f"{document} line {number} exceeds the byte limit")
    return lines, encoded


def _canonical_distribution_name(value: str, *, document: str, line: int) -> str:
    if _RAW_DISTRIBUTION_NAME.fullmatch(value) is None:
        raise ValueError(f"{document} line {line} has an unsupported distribution name")
    canonical = re.sub(r"[-_.]+", "-", value).lower()
    if canonical != value or _CANONICAL_DISTRIBUTION_NAME.fullmatch(value) is None:
        raise ValueError(
            f"{document} line {line} must use the canonical PyPI distribution name"
        )
    return canonical


def _stable_release(value: str, *, document: str, line: int) -> str:
    if _STABLE_RELEASE.fullmatch(value) is None:
        raise ValueError(
            f"{document} line {line} must use an exact canonical stable release"
        )
    return value


def _exact_requirement(
    token: str, *, document: str, line: int
) -> Tuple[str, str]:
    pieces = token.split("==")
    if len(pieces) != 2 or not pieces[0] or not pieces[1]:
        raise ValueError(
            f"{document} line {line} must be one canonical name==stable-release pin"
        )
    name = _canonical_distribution_name(pieces[0], document=document, line=line)
    version = _stable_release(pieces[1], document=document, line=line)
    return name, version


def _parse_direct(lines: Tuple[str, ...]) -> Tuple[PipDirectRequirement, ...]:
    parsed = []
    seen = set()
    for number, line in enumerate(lines, start=1):
        if line == "":
            continue
        name, version = _exact_requirement(
            line, document="requirements.in", line=number
        )
        if name in seen:
            raise ValueError(
                f"requirements.in line {number} duplicates distribution {name}"
            )
        seen.add(name)
        parsed.append(PipDirectRequirement(name=name, version=version))
        if len(parsed) > PIP_MAX_DIRECT_REQUIREMENTS:
            raise ValueError("requirements.in exceeds the direct-requirement limit")
    if not parsed:
        raise ValueError("requirements.in has no direct requirements")
    return tuple(parsed)


def _parse_compiled(lines: Tuple[str, ...]) -> Tuple[PipCompiledRequirement, ...]:
    parsed = []
    seen = set()
    total_hashes = 0
    for number, line in enumerate(lines, start=1):
        if line == "":
            continue
        tokens = line.split(" ")
        if "" in tokens or len(tokens) < 2:
            raise ValueError(
                f"requirements.txt line {number} must contain one pin and sha256 hash fields"
            )
        name, version = _exact_requirement(
            tokens[0], document="requirements.txt", line=number
        )
        if name in seen:
            raise ValueError(
                f"requirements.txt line {number} duplicates distribution {name}"
            )
        if len(tokens) - 1 > PIP_MAX_HASHES_PER_REQUIREMENT:
            raise ValueError(
                f"requirements.txt line {number} exceeds the per-requirement hash limit"
            )
        hashes = []
        for token in tokens[1:]:
            matched = _SHA256_TOKEN.fullmatch(token)
            if matched is None:
                raise ValueError(
                    f"requirements.txt line {number} has an unsupported hash field"
                )
            digest = matched.group(1)
            if digest in hashes:
                raise ValueError(
                    f"requirements.txt line {number} duplicates a sha256 hash"
                )
            hashes.append(digest)
        total_hashes += len(hashes)
        if total_hashes > PIP_MAX_TOTAL_HASHES:
            raise ValueError("requirements.txt exceeds the total hash limit")
        seen.add(name)
        parsed.append(
            PipCompiledRequirement(
                name=name,
                version=version,
                sha256_hashes=tuple(hashes),
            )
        )
        if len(parsed) > PIP_MAX_COMPILED_REQUIREMENTS:
            raise ValueError("requirements.txt exceeds the compiled-requirement limit")
    if not parsed:
        raise ValueError("requirements.txt has no compiled requirements")
    return tuple(parsed)


def parse_pip_requirements_snapshot(files: object) -> PipPairedRequirements:
    """Parse one exact root pair while keeping graph provenance unresolved.

    Only the two literal root filenames are accepted.  Every direct entry must
    occur in the compiled file at the same canonical version spelling.  Extra
    compiled entries may be transitive, but these files cannot prove that fact
    or prove whether any entry is missing or unreachable.
    """

    if not isinstance(files, Mapping):
        raise ValueError("pip requirements snapshot is not a file mapping")
    if len(files) != 2 or any(not isinstance(path, str) for path in files):
        raise ValueError(
            "pip paired profile requires exactly root requirements.in and requirements.txt"
        )
    if frozenset(files) != _REQUIRED_ROOT_FILES:
        raise ValueError(
            "pip paired profile requires exactly root requirements.in and requirements.txt"
        )

    direct_lines, requirements_in_bytes = _bounded_lines(
        files["requirements.in"],
        document="requirements.in",
        max_bytes=PIP_REQUIREMENTS_IN_MAX_BYTES,
        max_lines=PIP_REQUIREMENTS_IN_MAX_LINES,
    )
    compiled_lines, requirements_txt_bytes = _bounded_lines(
        files["requirements.txt"],
        document="requirements.txt",
        max_bytes=PIP_REQUIREMENTS_TXT_MAX_BYTES,
        max_lines=PIP_REQUIREMENTS_TXT_MAX_LINES,
    )
    direct = _parse_direct(direct_lines)
    compiled = _parse_compiled(compiled_lines)
    compiled_by_name = {requirement.name: requirement for requirement in compiled}
    for requirement in direct:
        locked = compiled_by_name.get(requirement.name)
        if locked is None:
            raise ValueError(
                f"requirements.txt is missing direct distribution {requirement.name}"
            )
        if locked.version != requirement.version:
            raise ValueError(
                "requirements.txt does not preserve the exact direct version for "
                + requirement.name
            )

    return PipPairedRequirements(
        direct=direct,
        compiled=compiled,
        file_custody=(
            PipSourceFileCustody(
                path="requirements.in",
                sha256=hashlib.sha256(requirements_in_bytes).hexdigest(),
                byte_count=len(requirements_in_bytes),
            ),
            PipSourceFileCustody(
                path="requirements.txt",
                sha256=hashlib.sha256(requirements_txt_bytes).hexdigest(),
                byte_count=len(requirements_txt_bytes),
            ),
        ),
        graph_provenance=PipGraphProvenance(
            status=PIP_GRAPH_PROVENANCE_UNRESOLVED,
            reason=PIP_GRAPH_PROVENANCE_REASON,
        ),
    )


__all__ = [
    "PIP_GRAPH_PROVENANCE_REASON",
    "PIP_GRAPH_PROVENANCE_UNRESOLVED",
    "PipCompiledRequirement",
    "PipDirectRequirement",
    "PipGraphProvenance",
    "PipPairedRequirements",
    "PipSourceFileCustody",
    "parse_pip_requirements_snapshot",
]
