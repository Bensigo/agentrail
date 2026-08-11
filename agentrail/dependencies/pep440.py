"""Conservative PEP 440 and Poetry constraint evaluation.

This module admits only final release identifiers without an explicit epoch.
Pre-releases, post-releases, development releases, local versions, arbitrary
equality, OR branches, markers, direct references, and every unknown form fail
closed.
Poetry's caret and tilde forms are implemented explicitly rather than being
coerced through a Node semver library.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Optional, Sequence, Tuple


PEP440_CONSTRAINT_MAX_BYTES = 512
PEP440_MAX_CLAUSES = 32
PEP440_MAX_RELEASE_COMPONENTS = 8
PEP440_MAX_COMPONENT_DIGITS = 18
PEP440_MAX_TARGET_VERSIONS = 10_000

_RELEASE_LATTICE_BASE = 10**PEP440_MAX_COMPONENT_DIGITS
_RELEASE_LATTICE_MAX = _RELEASE_LATTICE_BASE**PEP440_MAX_RELEASE_COMPONENTS - 1

_RELEASE = re.compile(r"^(?:v)?([0-9]+(?:\.[0-9]+)*)$")
_WILDCARD = re.compile(r"^(==|!=)?\s*([0-9]+(?:\.[0-9]+)*)\.\*$")
_CLAUSE = re.compile(r"^(~=|==|!=|<=|>=|<|>|\^|~)?\s*(\S+)$")


@dataclass(frozen=True)
class StablePep440Version:
    """One admitted final PEP 440 release, preserving its supplied spelling."""

    raw: str
    release: Tuple[int, ...]


@dataclass(frozen=True)
class _ConstraintClause:
    kind: str
    expected: Optional[StablePep440Version] = None
    lower: Optional[StablePep440Version] = None
    upper: Optional[StablePep440Version] = None
    prefix: Tuple[int, ...] = ()


@dataclass(frozen=True)
class PoetryConstraint:
    raw: str
    clauses: Tuple[_ConstraintClause, ...]

    def matches(self, version: object) -> bool:
        actual = _require_stable_version(version)
        return all(_clause_matches(clause, actual) for clause in self.clauses)


@dataclass(frozen=True)
class _Interval:
    lower: Optional[Tuple[int, ...]]
    lower_inclusive: bool
    upper: Optional[Tuple[int, ...]]
    upper_inclusive: bool


def parse_stable_version(value: object) -> Optional[StablePep440Version]:
    """Return the admitted stable release subset, or ``None`` for unsafe input."""

    if not isinstance(value, str) or not value or value != value.strip():
        return None
    matched = _RELEASE.fullmatch(value)
    if matched is None:
        return None
    raw_components = matched.group(1).split(".")
    if not 1 <= len(raw_components) <= PEP440_MAX_RELEASE_COMPONENTS:
        return None
    if any(len(component) > PEP440_MAX_COMPONENT_DIGITS for component in raw_components):
        return None
    return StablePep440Version(value, tuple(int(component) for component in raw_components))


def compare_stable_versions(left: object, right: object) -> int:
    """Compare two admitted stable versions using PEP 440 zero padding."""

    left_version = _require_stable_version(left)
    right_version = _require_stable_version(right)
    return _compare_release(left_version.release, right_version.release)


def parse_poetry_constraint(value: object) -> PoetryConstraint:
    """Parse the closed Poetry/PEP 440 constraint subset used by the profile."""

    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("Poetry constraint must be non-empty text without outer whitespace")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError("Poetry constraint is not valid UTF-8 text") from exc
    if size > PEP440_CONSTRAINT_MAX_BYTES:
        raise ValueError("Poetry constraint exceeds the byte limit")
    if any(token in value for token in ("||", ";", "@", "===", "\\")):
        raise ValueError("Poetry constraint uses an unsupported selector or source form")

    raw_clauses = value.split(",")
    if not 1 <= len(raw_clauses) <= PEP440_MAX_CLAUSES or any(
        not clause.strip() for clause in raw_clauses
    ):
        raise ValueError("Poetry constraint has an invalid clause list")

    clauses = tuple(_parse_clause(clause.strip()) for clause in raw_clauses)
    return PoetryConstraint(raw=value, clauses=clauses)


def poetry_constraint_matches(
    constraint: object, version: object
) -> Tuple[Optional[bool], Optional[str]]:
    """Evaluate one constraint, returning an error instead of guessing."""

    try:
        parsed = parse_poetry_constraint(constraint)
        actual = _require_stable_version(version)
    except ValueError as exc:
        return None, str(exc)
    return all(_clause_matches(clause, actual) for clause in parsed.clauses), None


def poetry_constraint_is_subset(
    subset: object, superset: object
) -> Tuple[Optional[bool], Optional[str]]:
    """Prove that every admitted release in ``subset`` is in ``superset``.

    The admitted constraint grammar is an intersection of numeric intervals,
    prefixes, and exclusions. Converting each side to a finite interval set
    gives a conservative proof: any uncovered interval refuses containment.
    """

    try:
        subset_intervals = _constraint_intervals(parse_poetry_constraint(subset))
        superset_intervals = _constraint_intervals(parse_poetry_constraint(superset))
    except ValueError as exc:
        return None, str(exc)
    if not subset_intervals:
        return None, "subset constraint admits no stable release"

    uncovered = list(subset_intervals)
    for cover in superset_intervals:
        remaining: list[_Interval] = []
        for source in uncovered:
            remaining.extend(_subtract_interval(source, cover))
        uncovered = remaining
        if not uncovered:
            return True, None
    return False, None


def select_highest_compatible_version(
    constraint: object, versions: Sequence[object]
) -> Tuple[Optional[str], Optional[str]]:
    """Select a unique highest stable match from a bounded supplied snapshot."""

    if isinstance(versions, (str, bytes)) or not isinstance(versions, Sequence):
        return None, "candidate versions must be a sequence"
    if not versions:
        return None, "candidate versions are empty"
    if len(versions) > PEP440_MAX_TARGET_VERSIONS:
        return None, "candidate versions exceed the entry limit"
    try:
        parsed_constraint = parse_poetry_constraint(constraint)
        parsed_versions = [_require_stable_version(value) for value in versions]
    except ValueError as exc:
        return None, str(exc)

    seen: set[Tuple[int, ...]] = set()
    best: Optional[StablePep440Version] = None
    for candidate in parsed_versions:
        identity = _semantic_release(candidate.release)
        if identity in seen:
            return None, "candidate versions contain an ambiguous equivalent release"
        seen.add(identity)
        if not all(
            _clause_matches(clause, candidate)
            for clause in parsed_constraint.clauses
        ):
            continue
        if best is None or _compare_release(candidate.release, best.release) > 0:
            best = candidate
    if best is None:
        return None, "no compatible stable release is available"
    return best.raw, None


def _parse_clause(text: str) -> _ConstraintClause:
    if text == "*":
        return _ConstraintClause("any")

    wildcard = _WILDCARD.fullmatch(text)
    if wildcard is not None:
        prefix = _parse_release_components(wildcard.group(2), maximum=None)
        return _ConstraintClause(
            "exclude-prefix" if wildcard.group(1) == "!=" else "prefix",
            prefix=prefix,
        )

    matched = _CLAUSE.fullmatch(text)
    if matched is None:
        raise ValueError(f"unsupported Poetry/PEP 440 constraint syntax: {text}")
    operator = matched.group(1) or "=="
    expected = _require_stable_version(matched.group(2))

    if operator == "^":
        if len(expected.release) > 3:
            raise ValueError("Poetry caret constraints support at most three release components")
        return _range_clause(expected, _caret_upper(expected.release))
    if operator == "~":
        if len(expected.release) > 3:
            raise ValueError("Poetry tilde constraints support at most three release components")
        return _range_clause(expected, _tilde_upper(expected.release))
    if operator == "~=":
        if len(expected.release) < 2:
            raise ValueError("PEP 440 compatible release requires at least two components")
        return _range_clause(expected, _compatible_upper(expected.release))
    if operator == "==":
        return _ConstraintClause("equal", expected=expected)
    if operator == "!=":
        return _ConstraintClause("not-equal", expected=expected)
    return _ConstraintClause(operator, expected=expected)


def _range_clause(
    lower: StablePep440Version, upper_release: Tuple[int, ...]
) -> _ConstraintClause:
    upper = StablePep440Version(".".join(str(part) for part in upper_release), upper_release)
    return _ConstraintClause("range", lower=lower, upper=upper)


def _parse_release_components(
    value: str, *, maximum: Optional[int]
) -> Tuple[int, ...]:
    components = value.split(".")
    limit = PEP440_MAX_RELEASE_COMPONENTS if maximum is None else maximum
    if not 1 <= len(components) <= limit:
        raise ValueError("Poetry constraint has too many release components")
    if any(
        not component.isascii()
        or not component.isdigit()
        or len(component) > PEP440_MAX_COMPONENT_DIGITS
        for component in components
    ):
        raise ValueError("Poetry constraint has an invalid release component")
    return tuple(int(component) for component in components)


def _caret_upper(release: Tuple[int, ...]) -> Tuple[int, ...]:
    upper = list(release)
    index = next((position for position, part in enumerate(upper) if part), len(upper) - 1)
    upper[index] += 1
    for position in range(index + 1, len(upper)):
        upper[position] = 0
    return tuple(upper)


def _tilde_upper(release: Tuple[int, ...]) -> Tuple[int, ...]:
    upper = list(release)
    index = 0 if len(upper) == 1 else 1
    upper[index] += 1
    for position in range(index + 1, len(upper)):
        upper[position] = 0
    return tuple(upper)


def _compatible_upper(release: Tuple[int, ...]) -> Tuple[int, ...]:
    upper = list(release)
    index = len(upper) - 2
    upper[index] += 1
    for position in range(index + 1, len(upper)):
        upper[position] = 0
    return tuple(upper)


def _clause_matches(clause: _ConstraintClause, actual: StablePep440Version) -> bool:
    if clause.kind == "any":
        return True
    if clause.kind in {"prefix", "exclude-prefix"}:
        padded = actual.release + (0,) * max(0, len(clause.prefix) - len(actual.release))
        matched = padded[: len(clause.prefix)] == clause.prefix
        return not matched if clause.kind == "exclude-prefix" else matched
    if clause.kind == "range":
        assert clause.lower is not None and clause.upper is not None
        return (
            _compare_release(actual.release, clause.lower.release) >= 0
            and _compare_release(actual.release, clause.upper.release) < 0
        )
    assert clause.expected is not None
    comparison = _compare_release(actual.release, clause.expected.release)
    return {
        "equal": comparison == 0,
        "not-equal": comparison != 0,
        "<": comparison < 0,
        "<=": comparison <= 0,
        ">": comparison > 0,
        ">=": comparison >= 0,
    }[clause.kind]


def _constraint_intervals(constraint: PoetryConstraint) -> Tuple[_Interval, ...]:
    intervals = (_Interval((0,), True, None, False),)
    for clause in constraint.clauses:
        intersections: list[_Interval] = []
        for current in intervals:
            for admitted in _clause_intervals(clause):
                intersection = _intersect_interval(current, admitted)
                if intersection is not None:
                    intersections.append(intersection)
        intervals = tuple(intersections)
        if not intervals:
            break
    return intervals


def _clause_intervals(clause: _ConstraintClause) -> Tuple[_Interval, ...]:
    universe_lower = (0,)
    if clause.kind == "any":
        return (_Interval(universe_lower, True, None, False),)
    if clause.kind in {"prefix", "exclude-prefix"}:
        upper = _increment_prefix(clause.prefix)
        if clause.kind == "prefix":
            return (_Interval(clause.prefix, True, upper, False),)
        return tuple(
            interval
            for interval in (
                _validated_interval(universe_lower, True, clause.prefix, False),
                _validated_interval(upper, True, None, False),
            )
            if interval is not None
        )
    if clause.kind == "range":
        assert clause.lower is not None and clause.upper is not None
        return (
            _Interval(
                clause.lower.release,
                True,
                clause.upper.release,
                False,
            ),
        )
    assert clause.expected is not None
    expected = clause.expected.release
    if clause.kind == "equal":
        return (_Interval(expected, True, expected, True),)
    if clause.kind == "not-equal":
        return tuple(
            interval
            for interval in (
                _validated_interval(universe_lower, True, expected, False),
                _validated_interval(expected, False, None, False),
            )
            if interval is not None
        )
    if clause.kind == "<":
        interval = _validated_interval(universe_lower, True, expected, False)
        return (interval,) if interval is not None else ()
    if clause.kind == "<=":
        interval = _validated_interval(universe_lower, True, expected, True)
        return (interval,) if interval is not None else ()
    if clause.kind == ">":
        return (_Interval(expected, False, None, False),)
    if clause.kind == ">=":
        return (_Interval(expected, True, None, False),)
    raise ValueError(f"unsupported constraint interval kind: {clause.kind}")


def _increment_prefix(prefix: Tuple[int, ...]) -> Tuple[int, ...]:
    upper = list(prefix)
    upper[-1] += 1
    return tuple(upper)


def _intersect_interval(left: _Interval, right: _Interval) -> Optional[_Interval]:
    lower, lower_inclusive = _later_lower(left, right)
    upper, upper_inclusive = _earlier_upper(left, right)
    return _validated_interval(lower, lower_inclusive, upper, upper_inclusive)


def _later_lower(
    left: _Interval, right: _Interval
) -> Tuple[Optional[Tuple[int, ...]], bool]:
    if left.lower is None:
        return right.lower, right.lower_inclusive
    if right.lower is None:
        return left.lower, left.lower_inclusive
    comparison = _compare_release(left.lower, right.lower)
    if comparison > 0:
        return left.lower, left.lower_inclusive
    if comparison < 0:
        return right.lower, right.lower_inclusive
    return left.lower, left.lower_inclusive and right.lower_inclusive


def _earlier_upper(
    left: _Interval, right: _Interval
) -> Tuple[Optional[Tuple[int, ...]], bool]:
    if left.upper is None:
        return right.upper, right.upper_inclusive
    if right.upper is None:
        return left.upper, left.upper_inclusive
    comparison = _compare_release(left.upper, right.upper)
    if comparison < 0:
        return left.upper, left.upper_inclusive
    if comparison > 0:
        return right.upper, right.upper_inclusive
    return left.upper, left.upper_inclusive and right.upper_inclusive


def _validated_interval(
    lower: Optional[Tuple[int, ...]],
    lower_inclusive: bool,
    upper: Optional[Tuple[int, ...]],
    upper_inclusive: bool,
) -> Optional[_Interval]:
    interval = _Interval(lower, lower_inclusive, upper, upper_inclusive)
    minimum = 0 if lower is None else _release_lattice_index(lower)
    maximum = _RELEASE_LATTICE_MAX if upper is None else _release_lattice_index(upper)
    if lower is not None and not lower_inclusive:
        minimum += 1
    if upper is not None and not upper_inclusive:
        maximum -= 1
    if 0 <= minimum <= maximum <= _RELEASE_LATTICE_MAX:
        return interval
    return None


def _release_lattice_index(release: Tuple[int, ...]) -> int:
    """Map the bounded, zero-padded release domain to its discrete order."""

    padded = release + (0,) * (PEP440_MAX_RELEASE_COMPONENTS - len(release))
    index = 0
    for component in padded:
        index = index * _RELEASE_LATTICE_BASE + component
    return index


def _subtract_interval(source: _Interval, cover: _Interval) -> Tuple[_Interval, ...]:
    intersection = _intersect_interval(source, cover)
    if intersection is None:
        return (source,)
    remaining: list[_Interval] = []
    if intersection.lower is not None:
        left = _validated_interval(
            source.lower,
            source.lower_inclusive,
            intersection.lower,
            not intersection.lower_inclusive,
        )
        if left is not None:
            remaining.append(left)
    if intersection.upper is not None:
        right = _validated_interval(
            intersection.upper,
            not intersection.upper_inclusive,
            source.upper,
            source.upper_inclusive,
        )
        if right is not None:
            remaining.append(right)
    return tuple(remaining)


def _require_stable_version(value: object) -> StablePep440Version:
    parsed = parse_stable_version(value)
    if parsed is None:
        raise ValueError(f"version is outside the admitted stable PEP 440 subset: {value}")
    return parsed


def _compare_release(left: Tuple[int, ...], right: Tuple[int, ...]) -> int:
    width = max(len(left), len(right))
    padded_left = left + (0,) * (width - len(left))
    padded_right = right + (0,) * (width - len(right))
    if padded_left == padded_right:
        return 0
    return -1 if padded_left < padded_right else 1


def _semantic_release(release: Tuple[int, ...]) -> Tuple[int, ...]:
    value = list(release)
    while len(value) > 1 and value[-1] == 0:
        value.pop()
    return tuple(value)


__all__ = [
    "PEP440_CONSTRAINT_MAX_BYTES",
    "PEP440_MAX_CLAUSES",
    "PEP440_MAX_RELEASE_COMPONENTS",
    "PEP440_MAX_TARGET_VERSIONS",
    "PoetryConstraint",
    "StablePep440Version",
    "compare_stable_versions",
    "parse_poetry_constraint",
    "parse_stable_version",
    "poetry_constraint_is_subset",
    "poetry_constraint_matches",
    "select_highest_compatible_version",
]
