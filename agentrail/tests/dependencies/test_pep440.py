from __future__ import annotations

import pytest

from agentrail.dependencies.pep440 import (
    compare_stable_versions,
    parse_poetry_constraint,
    poetry_constraint_is_subset,
    poetry_constraint_matches,
    select_highest_compatible_version,
)


@pytest.mark.parametrize(
    ("constraint", "matching", "outside"),
    [
        ("~=2.2", "2.9.9", "3.0"),
        ("~=1.4.5", "1.4.99", "1.5"),
        ("^1.2.3", "1.99", "2.0"),
        ("^0.2.3", "0.2.99", "0.3"),
        ("^0.0.3", "0.0.3", "0.0.4"),
        ("~1.2.3", "1.2.99", "1.3"),
        ("~1", "1.99", "2"),
        (">=1.2,<2.0,!=1.5.*", "1.4.9", "1.5.1"),
        ("1.4.*", "1.4.7", "1.5"),
        ("==1.2.0", "1.2", "1.2.1"),
    ],
)
def test_poetry_constraints_match_only_the_admitted_stable_range(
    constraint: str, matching: str, outside: str
) -> None:
    assert poetry_constraint_matches(constraint, matching) == (True, None)
    assert poetry_constraint_matches(constraint, outside) == (False, None)


def test_stable_version_ordering_uses_numeric_pep_440_release_segments() -> None:
    assert compare_stable_versions("1.10", "1.9.99") == 1
    assert compare_stable_versions("1.0", "1.0.0") == 0
    assert compare_stable_versions("2026.4", "2025.12.99") == 1


def test_target_selection_returns_the_highest_compatible_stable_release() -> None:
    assert select_highest_compatible_version(
        "^0.2.3", ("0.2.3", "0.2.10", "0.3.0")
    ) == ("0.2.10", None)


@pytest.mark.parametrize(
    "version",
    (
        "1.2.0rc1",
        "1.2.0a1",
        "1.2.0b1",
        "1.2.0.dev1",
        "1.2.0.post1",
        "1.2.0+local",
        "1!1.2.0",
        "1.2.0-1",
        " 1.2.0",
    ),
)
def test_prerelease_post_dev_local_epoch_and_implicit_post_versions_fail_closed(
    version: str,
) -> None:
    matched, error = poetry_constraint_matches(">=1.0", version)
    assert matched is None
    assert error is not None and "stable PEP 440 subset" in error


@pytest.mark.parametrize(
    "constraint",
    (
        "latest",
        ">=1 || <2",
        ">=1; python_version >= '3.11'",
        "package @ https://example.invalid/package.whl",
        "===1.2.3",
        "1.2 - 2.0",
        "~=1",
        ">=1.*",
        "^1.2.3.4",
        "~1.2.3.4",
        ">=1,,<2",
    ),
)
def test_unknown_constraint_forms_fail_closed(constraint: str) -> None:
    matched, error = poetry_constraint_matches(constraint, "1.2.3")
    assert matched is None
    assert error


def test_exclusions_and_zero_major_edges_are_intersections() -> None:
    assert poetry_constraint_matches("^0.0", "0.0.99") == (True, None)
    assert poetry_constraint_matches("^0.0", "0.1") == (False, None)
    assert poetry_constraint_matches("^0", "0.99") == (True, None)
    assert poetry_constraint_matches("^0", "1.0") == (False, None)
    assert poetry_constraint_matches(">=1,<3,!=2.0,!=2.1.*", "2.2") == (
        True,
        None,
    )
    assert poetry_constraint_matches(">=1,<3,!=2.0,!=2.1.*", "2.1.9") == (
        False,
        None,
    )


def test_target_selection_rejects_any_unsafe_or_equivalent_candidate() -> None:
    selected, error = select_highest_compatible_version(
        ">=1", ("1.0", "1.1rc1", "2.0")
    )
    assert selected is None
    assert error is not None and "stable PEP 440 subset" in error

    selected, error = select_highest_compatible_version(">=1", ("1.0", "1.0.0"))
    assert selected is None
    assert error is not None and "ambiguous equivalent" in error


def test_constraint_and_target_bounds_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    import agentrail.dependencies.pep440 as pep440_module

    monkeypatch.setattr(pep440_module, "PEP440_CONSTRAINT_MAX_BYTES", 4)
    with pytest.raises(ValueError, match="byte limit"):
        parse_poetry_constraint(">=1.0")

    monkeypatch.setattr(pep440_module, "PEP440_MAX_TARGET_VERSIONS", 1)
    assert select_highest_compatible_version(">=1", ("1", "2")) == (
        None,
        "candidate versions exceed the entry limit",
    )


def test_release_component_resource_limits_fail_closed() -> None:
    huge = "9" * 19
    with pytest.raises(ValueError, match="stable PEP 440 subset"):
        compare_stable_versions(huge, "1")
    with pytest.raises(ValueError, match="stable PEP 440 subset"):
        compare_stable_versions("1.2.3.4.5.6.7.8.9", "1")


@pytest.mark.parametrize(
    ("subset", "superset", "expected"),
    [
        (">=3.11,<4.0", ">=3.9", True),
        (">=3.11,<4.0", "<3.0", False),
        (">=3.11,<4.0", ">=3.11,<3.12", False),
        ("==3.11.*", ">=3.11,<3.12", True),
        (">=3.11,<4.0,!=3.12.*", ">=3.11,<4.0", True),
        (">=3.11,<4.0", ">=3.11,<4.0,!=3.12.*", False),
        (">=3.12,<4.0", "!=3.11.*", True),
        (">=3.11,<3.12", "!=3.11.*", False),
        (">3.11,<3.12", "!=3.11", True),
        (">=3.11,<3.12", "!=3.11", False),
        ("^0.2.3", ">=0.2,<0.3", True),
        ("~=3.11.2", "==3.11.*", True),
        (">=3.11,<4.0", "*", True),
    ],
)
def test_constraint_containment_proves_the_entire_subset_or_refuses(
    subset: str, superset: str, expected: bool
) -> None:
    assert poetry_constraint_is_subset(subset, superset) == (expected, None)


def test_constraint_containment_refuses_an_empty_or_invalid_root_domain() -> None:
    contained, error = poetry_constraint_is_subset(">=4,<3", ">=3")
    assert contained is None
    assert error is not None and "no stable release" in error

    contained, error = poetry_constraint_is_subset(
        ">3.11.0.0.0.0.0.0,<3.11.0.0.0.0.0.1",
        ">=3",
    )
    assert contained is None
    assert error is not None and "no stable release" in error
