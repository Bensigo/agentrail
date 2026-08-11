from __future__ import annotations

from pathlib import Path

import pytest

from agentrail.dependencies.poetry import (
    POETRY_ADAPTER_PROFILE,
    normalize_pep503_name,
    parse_poetry_root_lock,
)


FIXTURES = Path(__file__).parent / "fixtures" / "poetry"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _texts() -> tuple[str, str]:
    return _fixture("pyproject.toml"), _fixture("poetry.lock")


def test_root_manifest_and_lock_v2_preserve_direct_and_distribution_custody() -> None:
    profile = parse_poetry_root_lock(
        _fixture("pyproject.toml"), _fixture("poetry.lock")
    )

    assert profile.adapter_profile == POETRY_ADAPTER_PROFILE
    assert POETRY_ADAPTER_PROFILE == "python:poetry:poetry_root_lock_v2_v1"
    assert (profile.root_name, profile.root_version) == ("fixture-app", "0.1.0")
    assert profile.python_constraint == ">=3.11,<4.0"
    assert profile.lock_version == "2.1"
    assert profile.content_hash == "f" * 64
    assert [
        (item.name, item.declared_name, item.kind, item.constraint, item.locked_version)
        for item in profile.direct_dependencies
    ] == [
        ("requests", "Requests", "main", "^2.31.0", "2.31.0"),
        ("pytest", "pytest", "dev", "~=8.2.0", "8.2.2"),
    ]
    assert [package.name for package in profile.locked_packages] == [
        "certifi",
        "pytest",
        "requests",
    ]
    requests = next(
        package for package in profile.locked_packages if package.name == "requests"
    )
    assert [(item.filename, item.sha256) for item in requests.files] == [
        (
            "requests-2.31.0-py3-none-any.whl",
            "d" * 64,
        ),
        ("requests-2.31.0.tar.gz", "e" * 64),
    ]
    assert [
        (item.kind, item.distribution, item.version) for item in requests.files
    ] == [
        ("wheel", "requests", "2.31.0"),
        ("sdist", "requests", "2.31.0"),
    ]
    assert requests.dependencies == ("certifi",)


def test_pep_503_names_are_normalized_before_identity_checks() -> None:
    assert normalize_pep503_name("My_Package.Name") == "my-package-name"
    with pytest.raises(ValueError, match="distribution name"):
        normalize_pep503_name("requests[security]")


def test_legacy_lock_2_0_category_shape_is_explicitly_supported() -> None:
    manifest, lock = _texts()
    lock = lock.replace('lock-version = "2.1"', 'lock-version = "2.0"')
    lock = lock.replace('groups = ["main"]', 'category = "main"')
    lock = lock.replace('groups = ["dev"]', 'category = "dev"')

    profile = parse_poetry_root_lock(manifest, lock)

    assert profile.lock_version == "2.0"
    assert next(
        package.groups for package in profile.locked_packages if package.name == "pytest"
    ) == ("dev",)


@pytest.mark.parametrize(
    ("package_constraint", "accepted"),
    [
        (">=3.9", True),
        ("<3.0", False),
        (">=3.11,<3.12", False),
        (">=3.9,!=3.12.*", False),
        ("!=3.10.*", True),
    ],
)
def test_root_python_range_must_be_contained_by_every_locked_package(
    package_constraint: str, accepted: bool
) -> None:
    manifest, lock = _texts()
    lock = lock.replace(
        'python-versions = ">=3.9"',
        f'python-versions = "{package_constraint}"',
        1,
    )
    if accepted:
        assert parse_poetry_root_lock(manifest, lock).root_name == "fixture-app"
    else:
        with pytest.raises(ValueError, match="does not contain the root Python range"):
            parse_poetry_root_lock(manifest, lock)


def test_root_python_wildcard_series_can_be_proven_inside_package_bounds() -> None:
    manifest, lock = _texts()
    manifest = manifest.replace('python = ">=3.11,<4.0"', 'python = "==3.11.*"')
    lock = lock.replace(
        'python-versions = ">=3.11,<4.0"',
        'python-versions = "==3.11.*"',
    ).replace(
        'python-versions = ">=3.9"',
        'python-versions = ">=3.11,<3.12"',
        1,
    )

    assert parse_poetry_root_lock(manifest, lock).python_constraint == "==3.11.*"


def test_root_python_constraint_must_admit_a_bounded_release() -> None:
    manifest, lock = _texts()
    manifest = manifest.replace(
        'python = ">=3.11,<4.0"',
        'python = ">3.11.0.0.0.0.0.0,<3.11.0.0.0.0.0.1"',
    )
    lock = lock.replace(
        'python-versions = ">=3.11,<4.0"',
        'python-versions = ">3.11.0.0.0.0.0.0,<3.11.0.0.0.0.0.1"',
    )

    with pytest.raises(ValueError, match="admits no stable release"):
        parse_poetry_root_lock(manifest, lock)


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (
            lambda text: text.replace(
                '[tool.poetry.dev-dependencies]\npytest = "~=8.2.0"',
                '[tool.poetry.dev-dependencies]\npytest = "~=8.2.0"\nrequests = "^2.31.0"',
            ),
            "both main and dev",
        ),
        (
            lambda text: text.replace(
                'Requests = "^2.31.0"', 'Requests = { path = "../requests" }'
            ),
            "plain registry version string",
        ),
        (
            lambda text: text.replace(
                'Requests = "^2.31.0"',
                'Requests = { git = "https://example.invalid/requests.git" }',
            ),
            "plain registry version string",
        ),
        (
            lambda text: text.replace(
                'Requests = "^2.31.0"',
                'Requests = { url = "https://example.invalid/requests.whl" }',
            ),
            "plain registry version string",
        ),
        (
            lambda text: text.replace(
                'Requests = "^2.31.0"',
                'Requests = { version = "^2.31.0", source = "private" }',
            ),
            "plain registry version string",
        ),
        (
            lambda text: text.replace(
                'Requests = "^2.31.0"',
                'Requests = { version = "^2.31.0", extras = ["security"] }',
            ),
            "plain registry version string",
        ),
        (
            lambda text: text.replace(
                'Requests = "^2.31.0"',
                'Requests = { version = "^2.31.0", markers = "python_version >= \'3.11\'" }',
            ),
            "plain registry version string",
        ),
        (
            lambda text: text
            + '\n[[tool.poetry.source]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
            "source",
        ),
        (
            lambda text: text
            + '\n[tool.poetry.group.docs.dependencies]\nsphinx = "^8.0"\n',
            "group",
        ),
        (
            lambda text: text.replace(
                'name = "fixture-app"', 'name = "fixture-app"\npackage-mode = false'
            ),
            "package-mode",
        ),
        (
            lambda text: text.replace(
                'name = "fixture-app"', 'name = "fixture-app"\nbuild = "build.py"'
            ),
            "build",
        ),
        (
            lambda text: '[project]\ndynamic = ["dependencies"]\n\n' + text,
            "project",
        ),
        (
            lambda text: text
            + '\n[build-system]\nrequires = ["poetry-core>=2"]\nbuild-backend = "poetry.core.masonry.api"\n',
            "build",
        ),
    ],
)
def test_manifest_rejects_unmodelled_identity_source_group_and_build_forms(
    mutate, reason: str
) -> None:
    manifest, lock = _texts()
    with pytest.raises(ValueError, match=reason):
        parse_poetry_root_lock(mutate(manifest), lock)


@pytest.mark.parametrize(
    ("old", "new", "reason"),
    [
        ('version = "0.1.0"', 'version = "0.1.0rc1"', "stable PEP 440"),
        ('python = ">=3.11,<4.0"\n', "", "Python compatibility"),
        ('Requests = "^2.31.0"', 'Requests = "latest"', "stable PEP 440"),
        (
            'Requests = "^2.31.0"',
            'Requests = [\n  {version = "<2", python = "<3.11"},\n  {version = ">=2", python = ">=3.11"},\n]',
            "plain registry version string",
        ),
    ],
)
def test_manifest_rejects_dynamic_or_unsupported_version_custody(
    old: str, new: str, reason: str
) -> None:
    manifest, lock = _texts()
    with pytest.raises(ValueError, match=reason):
        parse_poetry_root_lock(manifest.replace(old, new, 1), lock)


def test_malformed_and_duplicate_toml_fail_before_any_profile_is_returned() -> None:
    manifest, lock = _texts()
    duplicate = manifest.replace(
        'version = "0.1.0"', 'version = "0.1.0"\nversion = "0.2.0"'
    )
    with pytest.raises(ValueError, match="duplicate TOML"):
        parse_poetry_root_lock(duplicate, lock)
    with pytest.raises(ValueError, match="malformed"):
        parse_poetry_root_lock(manifest, lock + "\n[metadata\n")


@pytest.mark.parametrize(
    ("old", "new", "reason"),
    [
        ('lock-version = "2.1"', 'lock-version = "3.0"', "2.0 or 2.1"),
        (
            'python-versions = ">=3.11,<4.0"',
            'python-versions = ">=3.12,<4.0"',
            "does not match",
        ),
        ('content-hash = "' + "f" * 64 + '"', 'content-hash = "abc"', "content hash"),
        ('optional = false', 'optional = true', "optional packages"),
        ('groups = ["main"]', 'groups = ["docs"]', "groups are unsupported"),
        ('version = "2.31.0"', 'version = "2.31.0rc1"', "stable PEP 440"),
        ('version = "2.31.0"', 'version = "2.31.0.post1"', "stable PEP 440"),
        ('version = "2.31.0"', 'version = "2.31.0.dev1"', "stable PEP 440"),
        ('version = "2.31.0"', 'version = "2.31.0+local"', "stable PEP 440"),
        (
            "sha256:" + "d" * 64,
            "sha512:" + "d" * 64,
            "SHA-256 hash",
        ),
        (
            "requests-2.31.0-py3-none-any.whl",
            "../requests-2.31.0-py3-none-any.whl",
            "filename is unsafe",
        ),
        (
            'groups = ["main"]\nfiles = [',
            'groups = ["main"]\nsource = {type = "legacy", url = "https://example.invalid/simple"}\nfiles = [',
            "source",
        ),
        (
            'groups = ["main"]\nfiles = [',
            'groups = ["main"]\nmarkers = "python_version >= \'3.11\'"\nfiles = [',
            "marker",
        ),
    ],
)
def test_lock_rejects_unsafe_format_source_release_and_file_custody(
    old: str, new: str, reason: str
) -> None:
    manifest, lock = _texts()
    with pytest.raises(ValueError, match=reason):
        parse_poetry_root_lock(manifest, lock.replace(old, new, 1))


def test_lock_rejects_missing_hashes_and_duplicate_distribution_files() -> None:
    manifest, lock = _texts()
    missing_hash = lock.replace(
        '{file = "certifi-2025.1.31-py3-none-any.whl", hash = "sha256:'
        + "a" * 64
        + '"}',
        '{file = "certifi-2025.1.31-py3-none-any.whl"}',
    )
    with pytest.raises(ValueError, match="file entry is malformed"):
        parse_poetry_root_lock(manifest, missing_hash)

    first_file = (
        '{file = "certifi-2025.1.31-py3-none-any.whl", hash = "sha256:'
        + "a" * 64
        + '"},'
    )
    duplicate = lock.replace(first_file, first_file + "\n    " + first_file, 1)
    with pytest.raises(ValueError, match="filename is unsafe or duplicated"):
        parse_poetry_root_lock(manifest, duplicate)


@pytest.mark.parametrize(
    ("old", "new", "reason"),
    [
        (
            "certifi-2025.1.31-py3-none-any.whl",
            "other-2025.1.31-py3-none-any.whl",
            "distribution does not match",
        ),
        (
            "certifi-2025.1.31.tar.gz",
            "certifi-2024.12.1.tar.gz",
            "version does not match",
        ),
        (
            "certifi-2025.1.31-py3-none-any.whl",
            "certifi-2025.1.31-1-py3-none-any.whl",
            "unsupported wheel or sdist",
        ),
        (
            "certifi-2025.1.31.tar.gz",
            "certifi-2025.1.31.zip",
            "unsupported wheel or sdist",
        ),
    ],
)
def test_lock_file_names_bind_distribution_and_version_to_the_package(
    old: str, new: str, reason: str
) -> None:
    manifest, lock = _texts()
    with pytest.raises(ValueError, match=reason):
        parse_poetry_root_lock(manifest, lock.replace(old, new, 1))


def test_lock_filename_version_may_use_a_pep_440_equivalent_release_spelling() -> None:
    manifest, lock = _texts()
    lock = lock.replace('version = "8.2.2"', 'version = "8.2.2.0"', 1)

    profile = parse_poetry_root_lock(manifest, lock)

    pytest_package = next(
        package for package in profile.locked_packages if package.name == "pytest"
    )
    assert pytest_package.version == "8.2.2.0"
    assert pytest_package.files[0].version == "8.2.2"


def test_wheel_and_sdist_names_share_the_normalized_package_identity() -> None:
    manifest, lock = _texts()
    manifest = manifest.replace("Requests =", "My-Package =")
    lock = lock.replace('name = "requests"', 'name = "my_package"').replace(
        "requests-2.31.0-py3-none-any.whl",
        "my_package-2.31.0-py3-none-any.whl",
    ).replace("requests-2.31.0.tar.gz", "my-package-2.31.0.tar.gz")

    profile = parse_poetry_root_lock(manifest, lock)

    package = next(
        package for package in profile.locked_packages if package.name == "my-package"
    )
    assert {item.distribution for item in package.files} == {"my-package"}


def test_lock_rejects_multiple_normalized_resolutions() -> None:
    manifest, lock = _texts()
    duplicate = """
[[package]]
name = "Requests"
version = "2.30.0"
description = "duplicate"
optional = false
python-versions = ">=3.7"
groups = ["main"]
files = [
    {file = "requests-2.30.0.whl", hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111"},
]
"""
    with pytest.raises(ValueError, match="multiple resolutions for requests"):
        parse_poetry_root_lock(
            manifest, lock.replace("\n[metadata]", duplicate + "\n[metadata]")
        )


def test_lock_rejects_extras_markers_and_multiple_constraint_tables() -> None:
    manifest, lock = _texts()
    extra_table = lock.replace(
        "\n[metadata]", '\n[package.extras]\nsecurity = ["certifi"]\n\n[metadata]'
    )
    with pytest.raises(ValueError, match="extra"):
        parse_poetry_root_lock(manifest, extra_table)

    marked_edge = lock.replace(
        'certifi = ">=2023.7.22,<2026"',
        'certifi = {version = ">=2023.7.22,<2026", markers = "python_version >= \'3.11\'"}',
    )
    with pytest.raises(ValueError, match="markers, extras, and multiple constraints"):
        parse_poetry_root_lock(manifest, marked_edge)


def test_lock_graph_must_be_single_resolved_reachable_and_constraint_consistent() -> None:
    manifest, lock = _texts()
    unresolved = lock.replace(
        'certifi = ">=2023.7.22,<2026"', 'missing = ">=1"'
    )
    with pytest.raises(ValueError, match="unresolved package: missing"):
        parse_poetry_root_lock(manifest, unresolved)

    inconsistent = lock.replace(
        'certifi = ">=2023.7.22,<2026"', 'certifi = "<2020"'
    )
    with pytest.raises(ValueError, match="constraint is not satisfied"):
        parse_poetry_root_lock(manifest, inconsistent)

    orphan = """
[[package]]
name = "orphan"
version = "1.0"
description = "not reachable"
optional = false
python-versions = "*"
groups = ["main"]
files = [
    {file = "orphan-1.0-py3-none-any.whl", hash = "sha256:2222222222222222222222222222222222222222222222222222222222222222"},
]
"""
    with pytest.raises(ValueError, match="unreachable package entry: orphan"):
        parse_poetry_root_lock(
            manifest, lock.replace("\n[metadata]", orphan + "\n[metadata]")
        )


def test_lock_graph_group_membership_must_be_proven_from_a_direct_root() -> None:
    manifest, lock = _texts()
    lost_group = lock.replace(
        'name = "certifi"\nversion = "2025.1.31"',
        'name = "certifi"\nversion = "2025.1.31"',
    ).replace('groups = ["main"]', 'groups = ["dev"]', 1)
    with pytest.raises(ValueError, match="loses group custody"):
        parse_poetry_root_lock(manifest, lost_group)

    unproven_group = lock.replace(
        'groups = ["main"]', 'groups = ["main", "dev"]', 1
    )
    with pytest.raises(ValueError, match="group membership not proven"):
        parse_poetry_root_lock(manifest, unproven_group)


def test_direct_lock_resolution_must_match_constraint_and_group() -> None:
    manifest, lock = _texts()
    mismatched_version = lock.replace(
        'version = "2.31.0"', 'version = "3.0.0"'
    ).replace("requests-2.31.0", "requests-3.0.0")
    with pytest.raises(ValueError, match="direct constraint: requests"):
        parse_poetry_root_lock(manifest, mismatched_version)

    wrong_group = lock.replace(
        'groups = ["dev"]\nfiles = [\n    {file = "pytest',
        'groups = ["main"]\nfiles = [\n    {file = "pytest',
    )
    with pytest.raises(ValueError, match="direct dependency kind: pytest"):
        parse_poetry_root_lock(manifest, wrong_group)


def test_manifest_lock_and_entry_resource_bounds_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import agentrail.dependencies.poetry as poetry_module

    manifest, lock = _texts()
    monkeypatch.setattr(poetry_module, "POETRY_MANIFEST_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="pyproject.toml exceeds the byte limit"):
        parse_poetry_root_lock(manifest, lock)

    monkeypatch.setattr(poetry_module, "POETRY_MANIFEST_MAX_BYTES", 1_000_000)
    monkeypatch.setattr(poetry_module, "POETRY_MAX_DIRECT_DEPENDENCIES", 1)
    with pytest.raises(ValueError, match="direct dependency limit"):
        parse_poetry_root_lock(manifest, lock)

    monkeypatch.setattr(poetry_module, "POETRY_MAX_DIRECT_DEPENDENCIES", 2_000)
    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="poetry.lock exceeds the byte limit"):
        parse_poetry_root_lock(manifest, lock)

    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_BYTES", 10_000_000)
    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_PACKAGES", 2)
    with pytest.raises(ValueError, match="package limit"):
        parse_poetry_root_lock(manifest, lock)

    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_PACKAGES", 20_000)
    monkeypatch.setattr(poetry_module, "POETRY_MAX_FILES_PER_PACKAGE", 1)
    with pytest.raises(ValueError, match="files are missing or exceed"):
        parse_poetry_root_lock(manifest, lock)

    monkeypatch.setattr(poetry_module, "POETRY_MAX_FILES_PER_PACKAGE", 256)
    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_FILES", 1)
    with pytest.raises(ValueError, match="distribution-file limit"):
        parse_poetry_root_lock(manifest, lock)

    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_FILES", 100_000)
    monkeypatch.setattr(poetry_module, "POETRY_LOCK_MAX_DEPENDENCY_EDGES", 0)
    with pytest.raises(ValueError, match="dependency-edge limit"):
        parse_poetry_root_lock(manifest, lock)


def test_invalid_utf8_text_and_non_text_inputs_fail_closed() -> None:
    manifest, lock = _texts()
    with pytest.raises(ValueError, match="not text"):
        parse_poetry_root_lock(b"not text", lock)
    with pytest.raises(ValueError, match="valid UTF-8"):
        parse_poetry_root_lock(manifest, lock + "\ud800")


def test_parser_fails_closed_when_the_runtime_has_no_toml_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import agentrail.dependencies.poetry as poetry_module

    manifest, lock = _texts()
    monkeypatch.setattr(poetry_module, "tomllib", None)
    with pytest.raises(ValueError, match="cannot be parsed on this Python runtime"):
        parse_poetry_root_lock(manifest, lock)


def test_excessively_nested_toml_is_reported_as_evidence_failure() -> None:
    _, lock = _texts()
    deeply_nested = "value = " + "[" * 5_000 + "0" + "]" * 5_000

    with pytest.raises(ValueError, match="TOML nesting limit"):
        parse_poetry_root_lock(deeply_nested, lock)
