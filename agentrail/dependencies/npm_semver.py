"""Conservative npm semver evaluation for observation and peer evidence.

This module deliberately supports only the range forms proven by the npm v1
adapter: exact versions, full-version comparators, comparator intersections,
OR branches, full-version caret/tilde ranges, wildcards/partials, and hyphen
ranges. Dist-tags, aliases, and every unrecognised form fail closed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple, Union


PrereleasePart = Union[int, str]

_PRERELEASE_IDENTIFIER = (
    r"(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
)
_PRERELEASE = rf"{_PRERELEASE_IDENTIFIER}(?:\.{_PRERELEASE_IDENTIFIER})*"
_BUILD = r"[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*"
_VERSION_TEXT = (
    rf"v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    rf"(?:-{_PRERELEASE})?(?:\+{_BUILD})?"
)
_VERSION_RE = re.compile(
    rf"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    rf"(?:-({_PRERELEASE}))?(?:\+{_BUILD})?$"
)
_COMPARATOR_RE = re.compile(rf"^(<=|>=|<|>|=)?({_VERSION_TEXT})$")
_HYPHEN_RE = re.compile(rf"^({_VERSION_TEXT})\s+-\s+({_VERSION_TEXT})$")


@dataclass(frozen=True)
class _Version:
    major: int
    minor: int
    patch: int
    prerelease: Tuple[PrereleasePart, ...] = ()

    @property
    def core(self) -> Tuple[int, int, int]:
        return self.major, self.minor, self.patch


def _parse_version(value: object) -> Optional[_Version]:
    if not isinstance(value, str):
        return None
    match = _VERSION_RE.fullmatch(value.strip())
    if match is None:
        return None
    prerelease: Tuple[PrereleasePart, ...] = tuple(
        int(part) if part.isdigit() else part
        for part in (match.group(4).split(".") if match.group(4) else ())
    )
    return _Version(
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
        prerelease,
    )


def _compare(left: _Version, right: _Version) -> int:
    if left.core != right.core:
        return -1 if left.core < right.core else 1
    if not left.prerelease and not right.prerelease:
        return 0
    if not left.prerelease:
        return 1
    if not right.prerelease:
        return -1
    for left_part, right_part in zip(left.prerelease, right.prerelease):
        if left_part == right_part:
            continue
        if isinstance(left_part, int) and isinstance(right_part, str):
            return -1
        if isinstance(left_part, str) and isinstance(right_part, int):
            return 1
        return -1 if left_part < right_part else 1
    if len(left.prerelease) == len(right.prerelease):
        return 0
    return -1 if len(left.prerelease) < len(right.prerelease) else 1


def _prerelease_is_admitted(
    version: _Version, prerelease_cores: Tuple[Tuple[int, int, int], ...]
) -> bool:
    # node-semver excludes prereleases from a comparator set unless that set
    # names a prerelease comparator with the same major/minor/patch identity.
    return not version.prerelease or version.core in prerelease_cores


def _wildcard_bounds(text: str) -> Optional[Tuple[Optional[_Version], Optional[_Version]]]:
    if text in {"*", "x", "X"}:
        return None, None
    parts = text.split(".")
    if not 1 <= len(parts) <= 3:
        return None
    if any(
        part not in {"x", "X", "*"} and re.fullmatch(r"0|[1-9]\d*", part) is None
        for part in parts
    ):
        return None
    if parts[0] in {"x", "X", "*"}:
        return None, None
    major = int(parts[0])
    if len(parts) == 1 or parts[1] in {"x", "X", "*"}:
        return _Version(major, 0, 0), _Version(major + 1, 0, 0)
    minor = int(parts[1])
    if len(parts) == 2 or parts[2] in {"x", "X", "*"}:
        return _Version(major, minor, 0), _Version(major, minor + 1, 0)
    return None


def _comparator_matches(operator: str, actual: _Version, expected: _Version) -> bool:
    comparison = _compare(actual, expected)
    return {
        "=": comparison == 0,
        ">": comparison > 0,
        ">=": comparison >= 0,
        "<": comparison < 0,
        "<=": comparison <= 0,
    }[operator]


def _branch_matches(branch: str, actual: _Version) -> Tuple[Optional[bool], Optional[str]]:
    hyphen = _HYPHEN_RE.fullmatch(branch)
    if hyphen is not None:
        lower = _parse_version(hyphen.group(1))
        upper = _parse_version(hyphen.group(2))
        assert lower is not None and upper is not None
        prerelease_cores = tuple(
            version.core for version in (lower, upper) if version.prerelease
        )
        matches = _compare(actual, lower) >= 0 and _compare(actual, upper) <= 0
        return matches and _prerelease_is_admitted(actual, prerelease_cores), None

    if branch.startswith(("^", "~")):
        if " " in branch:
            return None, f"unsupported range syntax: {branch}"
        lower = _parse_version(branch[1:])
        if lower is None:
            return None, f"unsupported range syntax: {branch}"
        if branch[0] == "~":
            upper = _Version(lower.major, lower.minor + 1, 0)
        elif lower.major > 0:
            upper = _Version(lower.major + 1, 0, 0)
        elif lower.minor > 0:
            upper = _Version(0, lower.minor + 1, 0)
        else:
            upper = _Version(0, 0, lower.patch + 1)
        prerelease_cores = (lower.core,) if lower.prerelease else ()
        matches = _compare(actual, lower) >= 0 and _compare(actual, upper) < 0
        return matches and _prerelease_is_admitted(actual, prerelease_cores), None

    wildcard = _wildcard_bounds(branch)
    if wildcard is not None:
        lower, upper = wildcard
        matches = lower is None or (
            _compare(actual, lower) >= 0
            and upper is not None
            and _compare(actual, upper) < 0
        )
        return matches and _prerelease_is_admitted(actual, ()), None

    tokens = branch.split()
    if not tokens:
        return None, "constraint is empty"
    parsed = []
    for token in tokens:
        match = _COMPARATOR_RE.fullmatch(token)
        if match is None:
            label = "comparator range" if len(tokens) > 1 else "range"
            return None, f"unsupported {label} syntax: {branch}"
        operator = match.group(1) or "="
        if len(tokens) > 1 and match.group(1) is None:
            return None, f"unsupported comparator range syntax: {branch}"
        expected = _parse_version(match.group(2))
        assert expected is not None
        parsed.append((operator, expected))
    prerelease_cores = tuple(
        expected.core for _, expected in parsed if expected.prerelease
    )
    matches = all(
        _comparator_matches(operator, actual, expected)
        for operator, expected in parsed
    )
    return matches and _prerelease_is_admitted(actual, prerelease_cores), None


def npm_constraint_matches(
    specifier: object, version: object
) -> Tuple[Optional[bool], Optional[str]]:
    """Evaluate the npm v1 semver subset, returning an error for drift.

    The optional boolean is ``None`` only when either the version or the
    constraint uses syntax outside the admitted profile. Callers must treat an
    error as insufficient evidence or a peer conflict, never as a match.
    """

    actual = _parse_version(version)
    if actual is None:
        return None, f"version is not valid npm semver: {version}"
    if not isinstance(specifier, str) or not specifier.strip():
        return None, "constraint is empty"
    branches = [branch.strip() for branch in specifier.strip().split("||")]
    if any(not branch for branch in branches):
        return None, "OR range contains an empty branch"
    any_match = False
    for branch in branches:
        matches, error = _branch_matches(branch, actual)
        if error is not None:
            return None, error
        any_match = any_match or bool(matches)
    return any_match, None


__all__ = ["npm_constraint_matches"]
