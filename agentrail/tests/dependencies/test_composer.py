from __future__ import annotations

import copy
from dataclasses import FrozenInstanceError
import hashlib
import json
from pathlib import Path
import random

import pytest

import agentrail.dependencies.composer as composer
from agentrail.dependencies.composer import (
    COMPOSER_GRAPH_REASON,
    COMPOSER_GRAPH_STATUS_UNRESOLVED,
    COMPOSER_PROFILE,
    COMPOSER_UNRESOLVED_LANES,
    parse_composer_root_lock,
)


FIXTURES = Path(__file__).parent / "fixtures" / "composer"
PUBLIC_PACKAGIST_FIXTURES = (
    Path(__file__).parent / "fixtures" / "composer_public_packagist"
)


def _manifest_text() -> str:
    return (FIXTURES / "composer.json").read_text(encoding="utf-8")


def _lock_text() -> str:
    return (FIXTURES / "composer.lock").read_text(encoding="utf-8")


def _manifest() -> dict:
    return json.loads(_manifest_text())


def _lock() -> dict:
    return json.loads(_lock_text())


def _dump(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _parse_documents(manifest: dict, lock: dict):
    return parse_composer_root_lock(_dump(manifest), _dump(lock))


def _selected(lock: dict) -> dict:
    return next(
        package
        for package in lock["packages"] + lock["packages-dev"]
        if package["name"] == "acme/root-package"
    )


def test_parses_bounded_v2_syntax_and_exact_file_custody_without_authority() -> None:
    manifest_text = _manifest_text()
    lock_text = _lock_text()

    result = parse_composer_root_lock(manifest_text, lock_text)

    assert result.profile == COMPOSER_PROFILE
    assert COMPOSER_PROFILE == "php:composer:root_lock_v2_syntax_v1"
    assert result.lock_format == 2
    assert result.root_name == "acme/demo-app"
    assert result.root_type == "project"
    assert (
        result.direct_package.name,
        result.direct_package.lane,
        result.direct_package.constraint,
        result.direct_package.locked_version,
    ) == ("acme/root-package", "require", "^2.0.0", "2.4.1")
    assert [(item.name, item.version, item.lane) for item in result.locked_packages] == [
        ("acme/leaf-package", "1.3.0", "require"),
        ("acme/root-package", "2.4.1", "require"),
    ]
    assert result.locked_packages[1].distribution.url.startswith(
        "https://api.github.com/"
    )
    assert result.content_hash_claim == "f" * 32
    assert result.plugin_api_version == "2.9.0"
    assert [(item.path, item.sha256, item.byte_count) for item in result.file_custody] == [
        (
            "composer.json",
            hashlib.sha256(manifest_text.encode("utf-8")).hexdigest(),
            len(manifest_text.encode("utf-8")),
        ),
        (
            "composer.lock",
            hashlib.sha256(lock_text.encode("utf-8")).hexdigest(),
            len(lock_text.encode("utf-8")),
        ),
    ]
    assert result.graph_provenance.status == COMPOSER_GRAPH_STATUS_UNRESOLVED
    assert result.graph_provenance.reason == COMPOSER_GRAPH_REASON
    assert "bounded opaque text" in result.graph_provenance.reason
    assert "semantically unparsed" in result.graph_provenance.reason
    assert "not traversed" in result.graph_provenance.reason
    assert result.evidence_status == "syntax_and_custody_only"
    assert result.authority == "none"
    assert result.unresolved_lanes == COMPOSER_UNRESOLVED_LANES
    assert result.unresolved_lanes == (
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
    assert not hasattr(result, "managed_command")
    assert not hasattr(result, "content_hash_verified")
    with pytest.raises(FrozenInstanceError):
        result.authority = "evidence"  # type: ignore[misc]
    with pytest.raises(TypeError):
        result.locked_packages[0] = result.locked_packages[1]  # type: ignore[index]


def test_parses_composer_generated_public_packagist_source_and_dist_without_authority() -> None:
    manifest_text = (PUBLIC_PACKAGIST_FIXTURES / "composer.json").read_text(
        encoding="utf-8"
    )
    lock_text = (PUBLIC_PACKAGIST_FIXTURES / "composer.lock").read_text(
        encoding="utf-8"
    )

    result = parse_composer_root_lock(manifest_text, lock_text)

    assert result.direct_package.name == "ralouphie/getallheaders"
    assert result.direct_package.locked_version == "3.0.3"
    assert len(result.locked_packages) == 1
    locked = result.locked_packages[0]
    assert locked.source is not None
    assert locked.source.url == "https://github.com/ralouphie/getallheaders.git"
    assert locked.source.reference == locked.distribution.reference
    assert result.evidence_status == "syntax_and_custody_only"
    assert result.authority == "none"


def test_require_dev_lane_is_explicit_and_opposite_lock_lane_is_empty() -> None:
    manifest = _manifest()
    lock = _lock()
    manifest["require-dev"] = manifest.pop("require")
    lock["packages-dev"] = lock.pop("packages")
    lock["packages"] = []

    result = _parse_documents(manifest, lock)

    assert result.direct_package.lane == "require-dev"
    assert {package.lane for package in result.locked_packages} == {"require-dev"}


def test_additional_lock_rows_remain_opaque_and_do_not_become_graph_proof() -> None:
    lock = _lock()
    orphan = copy.deepcopy(lock["packages"][0])
    orphan["name"] = "acme/orphan-package"
    orphan["dist"]["url"] = (
        "https://api.github.com/repos/acme/orphan-package/zipball/"
        + "c" * 40
    )
    orphan["dist"]["reference"] = "c" * 40
    orphan.pop("require")
    lock["packages"].insert(1, orphan)

    result = _parse_documents(_manifest(), lock)

    assert [package.name for package in result.locked_packages] == [
        "acme/leaf-package",
        "acme/orphan-package",
        "acme/root-package",
    ]
    assert result.graph_provenance.status == "unresolved"
    assert "orphan status" in result.graph_provenance.reason


@pytest.mark.parametrize("value", [None, b"{}", 1, [], True])
def test_non_text_inputs_refuse(value: object) -> None:
    with pytest.raises(ValueError, match="composer.json is not text"):
        parse_composer_root_lock(value, _lock_text())
    with pytest.raises(ValueError, match="composer.lock is not text"):
        parse_composer_root_lock(_manifest_text(), value)


def test_utf8_and_byte_limits_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError, match="not valid UTF-8"):
        parse_composer_root_lock('{"name":"\ud800"}', _lock_text())
    with pytest.raises(ValueError, match="not valid UTF-8"):
        parse_composer_root_lock(_manifest_text(), '{"value":"\ud800"}')

    monkeypatch.setattr(composer, "COMPOSER_MANIFEST_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="composer.json exceeds the byte limit"):
        parse_composer_root_lock(_manifest_text(), _lock_text())
    monkeypatch.setattr(composer, "COMPOSER_MANIFEST_MAX_BYTES", 256 * 1024)
    monkeypatch.setattr(composer, "COMPOSER_LOCK_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="composer.lock exceeds the byte limit"):
        parse_composer_root_lock(_manifest_text(), _lock_text())


def test_duplicate_keys_are_rejected_at_every_json_level() -> None:
    manifest = _manifest_text().replace(
        '"name": "acme/demo-app",',
        '"name": "acme/demo-app",\n  "name": "acme/other-app",',
        1,
    )
    with pytest.raises(ValueError, match="duplicate JSON key: name"):
        parse_composer_root_lock(manifest, _lock_text())

    lock = _lock_text().replace(
        '"type": "zip",',
        '"type": "zip",\n        "type": "tar",',
        1,
    )
    with pytest.raises(ValueError, match="duplicate JSON key: type"):
        parse_composer_root_lock(_manifest_text(), lock)

    edge = _lock_text().replace(
        '"acme/leaf-package": "^1.0",',
        '"acme/leaf-package": "^1.0",\n        "acme/leaf-package": "*",',
        1,
    )
    with pytest.raises(ValueError, match="duplicate JSON key: acme/leaf-package"):
        parse_composer_root_lock(_manifest_text(), edge)


def test_depth_and_json_value_caps_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(composer, "COMPOSER_JSON_MAX_DEPTH", 2)
    with pytest.raises(ValueError, match="nesting limit"):
        parse_composer_root_lock(_manifest_text(), _lock_text())

    monkeypatch.setattr(composer, "COMPOSER_JSON_MAX_DEPTH", 32)
    monkeypatch.setattr(composer, "COMPOSER_MANIFEST_MAX_JSON_VALUES", 2)
    with pytest.raises(ValueError, match="composer.json exceeds the JSON value limit"):
        parse_composer_root_lock(_manifest_text(), _lock_text())

    monkeypatch.setattr(composer, "COMPOSER_MANIFEST_MAX_JSON_VALUES", 10_000)
    monkeypatch.setattr(composer, "COMPOSER_LOCK_MAX_JSON_VALUES", 2)
    with pytest.raises(ValueError, match="composer.lock exceeds the JSON value limit"):
        parse_composer_root_lock(_manifest_text(), _lock_text())


def test_pathologically_deep_and_nonfinite_json_refuse_as_value_errors() -> None:
    deep = "[" * 2_000 + "0" + "]" * 2_000
    with pytest.raises(ValueError, match="(?:nesting|malformed)"):
        parse_composer_root_lock(deep, _lock_text())
    with pytest.raises(ValueError, match="non-finite"):
        parse_composer_root_lock('{"value":NaN}', _lock_text())


@pytest.mark.parametrize("number", ["1e400", "-1e400"])
def test_exponent_overflow_nonfinite_numbers_refuse_recursively(number: str) -> None:
    manifest = _manifest_text().replace('"type": "project"', f'"type": {number}')
    with pytest.raises(ValueError, match="composer.json contains a non-finite JSON number"):
        parse_composer_root_lock(manifest, _lock_text())

    lock = _lock_text().replace(
        '"prefer-lowest": false', f'"prefer-lowest": {number}'
    )
    with pytest.raises(ValueError, match="composer.lock contains a non-finite JSON number"):
        parse_composer_root_lock(_manifest_text(), lock)


@pytest.mark.parametrize(
    "sections",
    [
        {},
        {"require": {}},
        {"require-dev": {}},
        {
            "require": {
                "acme/root-package": "^2.0.0",
                "acme/second-package": "1.0.0",
            }
        },
        {
            "require": {"acme/root-package": "^2.0.0"},
            "require-dev": {"acme/dev-package": "1.0.0"},
        },
    ],
)
def test_manifest_requires_exactly_one_direct_package_across_both_lanes(
    sections: dict,
) -> None:
    manifest = {"name": "acme/demo-app", "type": "project", **sections}
    with pytest.raises(ValueError, match="exactly one direct package"):
        _parse_documents(manifest, _lock())


@pytest.mark.parametrize(
    "name",
    [
        "Acme/root-package",
        "acme/Root-Package",
        "acme//root-package",
        "acme/root--package",
        "acme/root_package-",
        "acme/root package",
        "acme/root/package",
        "php",
        "ext-json",
        "../acme/root-package",
        "acmé/root-package",
    ],
)
def test_manifest_rejects_noncanonical_case_colliding_or_platform_names(name: str) -> None:
    manifest = _manifest()
    manifest["require"] = {name: "^2.0.0"}
    with pytest.raises(ValueError, match="canonical lowercase vendor/name"):
        _parse_documents(manifest, _lock())


def test_root_name_is_optional_but_canonical_and_cannot_self_require() -> None:
    manifest = _manifest()
    manifest.pop("name")
    assert _parse_documents(manifest, _lock()).root_name is None

    manifest = _manifest()
    manifest["name"] = "Acme/Demo-App"
    with pytest.raises(ValueError, match="canonical lowercase vendor/name"):
        _parse_documents(manifest, _lock())

    manifest = _manifest()
    manifest["name"] = "acme/root-package"
    with pytest.raises(ValueError, match="own root package"):
        _parse_documents(manifest, _lock())


@pytest.mark.parametrize(
    "constraint",
    [
        "",
        "*",
        "2.0",
        ">=2.0.0",
        "2.*",
        "2.0.x",
        "^2.0",
        "^2.0.0 || ^3.0.0",
        "dev-main",
        "1.0.x-dev",
        "2.0.0-alpha1",
        "2.0.0@dev",
        "dev-main as 2.0.0",
        "2.0.0#abcdef",
        " 2.0.0",
        {"version": "2.0.0"},
    ],
)
def test_manifest_rejects_unsupported_alias_dev_prerelease_and_constraint_forms(
    constraint: object,
) -> None:
    manifest = _manifest()
    manifest["require"]["acme/root-package"] = constraint
    with pytest.raises(ValueError, match="constraint"):
        _parse_documents(manifest, _lock())


@pytest.mark.parametrize(
    ("constraint", "locked_version"),
    [
        ("2.4.1", "v2.4.1"),
        ("~2.4.0", "2.4.9"),
        ("^2.0.0", "2.99.0"),
        ("^0.2.3", "0.2.9"),
        ("^0.0.3", "0.0.3"),
    ],
)
def test_exact_tilde_and_caret_stable_constraint_subset_matches(
    constraint: str, locked_version: str
) -> None:
    manifest = _manifest()
    lock = _lock()
    manifest["require"]["acme/root-package"] = constraint
    _selected(lock)["version"] = locked_version
    result = _parse_documents(manifest, lock)
    assert result.direct_package.locked_version == locked_version


@pytest.mark.parametrize(
    ("constraint", "locked_version"),
    [
        ("2.4.1", "2.4.2"),
        ("~2.4.0", "2.5.0"),
        ("^2.0.0", "3.0.0"),
        ("^0.2.3", "0.3.0"),
        ("^0.0.3", "0.0.4"),
    ],
)
def test_lock_version_must_satisfy_the_direct_constraint(
    constraint: str, locked_version: str
) -> None:
    manifest = _manifest()
    lock = _lock()
    manifest["require"]["acme/root-package"] = constraint
    _selected(lock)["version"] = locked_version
    with pytest.raises(ValueError, match="does not satisfy"):
        _parse_documents(manifest, lock)


@pytest.mark.parametrize(
    "version",
    [
        "2",
        "2.4",
        "02.4.1",
        "2.04.1",
        "2.4.1.0",
        "2.4.1-alpha1",
        "2.4.1-beta",
        "2.4.1-RC1",
        "2.4.1-dev",
        "dev-main",
        "2.4.x-dev",
        "2.4.1+metadata",
        "9999999999.1.1",
        "2.٤.1",
    ],
)
def test_lock_rejects_noncanonical_dev_prerelease_and_unbounded_versions(
    version: str,
) -> None:
    lock = _lock()
    _selected(lock)["version"] = version
    with pytest.raises(ValueError, match="stable"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("scripts", {}),
        ("repositories", []),
        ("repositories", [{"type": "path", "url": "../package"}]),
        ("repositories", [{"type": "vcs", "url": "https://github.com/acme/x"}]),
        ("repositories", [{"type": "artifact", "url": "artifacts"}]),
        ("repositories", [{"type": "package", "package": {}}]),
        ("replace", {}),
        ("provide", {}),
        ("conflict", {}),
        ("extra", {"installer-paths": {}}),
        ("version", "dev-main"),
        ("autoload", {"files": ["bootstrap.php"]}),
    ],
)
def test_root_rejects_scripts_repositories_alias_and_resolution_ambiguity(
    field: str, value: object
) -> None:
    manifest = _manifest()
    manifest[field] = value
    with pytest.raises(ValueError, match="unsupported root field"):
        _parse_documents(manifest, _lock())


@pytest.mark.parametrize(
    "value",
    [True, {"acme/plugin": True}, {"acme/plugin": False}, [], "false", None],
)
def test_truthy_or_nonempty_allow_plugins_refuses(value: object) -> None:
    manifest = _manifest()
    manifest["config"]["allow-plugins"] = value
    with pytest.raises(ValueError, match="allow-plugins must be false or empty"):
        _parse_documents(manifest, _lock())


def test_false_or_empty_allow_plugins_is_inert_but_other_config_refuses() -> None:
    for value in (False, {}):
        manifest = _manifest()
        manifest["config"]["allow-plugins"] = value
        assert _parse_documents(manifest, _lock()).authority == "none"

    manifest = _manifest()
    manifest["config"]["platform"] = {"php": "8.3.0"}
    with pytest.raises(ValueError, match="platform overrides"):
        _parse_documents(manifest, _lock())

    manifest = _manifest()
    manifest["config"]["vendor-dir"] = "other"
    with pytest.raises(ValueError, match="unsupported Composer config"):
        _parse_documents(manifest, _lock())


@pytest.mark.parametrize("root_type", ["composer-plugin", "composer-installer", "custom", {}, True])
def test_root_plugin_and_custom_installer_types_refuse(root_type: object) -> None:
    manifest = _manifest()
    manifest["type"] = root_type
    with pytest.raises(ValueError, match="plugins and custom installers"):
        _parse_documents(manifest, _lock())


def test_nondefault_root_stability_refuses() -> None:
    for field, value in (
        ("minimum-stability", "dev"),
        ("minimum-stability", "beta"),
        ("prefer-stable", True),
        ("prefer-stable", 0),
    ):
        manifest = _manifest()
        manifest[field] = value
        with pytest.raises(ValueError, match="(?:minimum-stability|prefer-stable)"):
            _parse_documents(manifest, _lock())


@pytest.mark.parametrize(
    "content_hash",
    ["f" * 31, "f" * 33, "F" * 32, "g" * 32, "sha256:" + "f" * 64, "", None],
)
def test_lock_rejects_malformed_content_hash_claim(content_hash: object) -> None:
    lock = _lock()
    lock["content-hash"] = content_hash
    with pytest.raises(ValueError, match="content-hash"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    "plugin_api_version",
    ["1.10.0", "3.0.0", "2.9", "v2.9.0", "2.9.0-RC1", "dev-main", True],
)
def test_only_canonical_stable_composer_2_plugin_api_shape_is_admitted(
    plugin_api_version: object,
) -> None:
    lock = _lock()
    lock["plugin-api-version"] = plugin_api_version
    with pytest.raises(ValueError, match="(?:plugin-api-version|Composer v2)"):
        _parse_documents(_manifest(), lock)


def test_lock_requires_exact_v2_top_level_shape() -> None:
    lock = _lock()
    lock.pop("packages-dev")
    with pytest.raises(ValueError, match="missing required v2 field: packages-dev"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    lock["hash"] = "f" * 32
    with pytest.raises(ValueError, match="unsupported top-level field: hash"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    lock["_readme"] = []
    with pytest.raises(ValueError, match="_readme is malformed"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("aliases", [{"package": "acme/root-package"}], "aliases"),
        ("minimum-stability", "dev", "minimum-stability"),
        ("stability-flags", {"acme/root-package": 20}, "stability-flags"),
        ("prefer-stable", True, "prefer-stable"),
        ("prefer-lowest", True, "prefer-lowest"),
        ("platform", {"php": ">=8.1"}, "platform requirements"),
        ("platform-dev", {"ext-json": "*"}, "platform requirements"),
    ],
)
def test_lock_rejects_aliases_platform_and_nondefault_stability(
    field: str, value: object, message: str
) -> None:
    lock = _lock()
    lock[field] = value
    with pytest.raises(ValueError, match=message):
        _parse_documents(_manifest(), lock)


def test_lock_rejects_platform_overrides_even_when_empty() -> None:
    lock = _lock()
    lock["platform-overrides"] = {}
    with pytest.raises(ValueError, match="platform-overrides"):
        _parse_documents(_manifest(), lock)


def test_selected_package_must_exist_once_in_the_matching_lane() -> None:
    lock = _lock()
    _selected(lock)["name"] = "acme/unrelated-package"
    with pytest.raises(ValueError, match="exactly one matching"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    lock["packages-dev"] = lock.pop("packages")
    lock["packages"] = []
    with pytest.raises(ValueError, match="undeclared root lane"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    lock["packages"].append(copy.deepcopy(_selected(lock)))
    with pytest.raises(ValueError, match="duplicates"):
        _parse_documents(_manifest(), lock)


def test_lock_rejects_unsorted_case_colliding_and_duplicate_package_rows() -> None:
    lock = _lock()
    lock["packages"].reverse()
    with pytest.raises(ValueError, match="must be sorted"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    lock["packages"][0]["name"] = "Acme/Leaf-Package"
    with pytest.raises(ValueError, match="canonical lowercase vendor/name"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    lock["packages"][0]["name"] = "acme/root-package"
    with pytest.raises(ValueError, match="duplicates"):
        _parse_documents(_manifest(), lock)


def test_lock_package_identity_cannot_collide_with_the_named_root_package() -> None:
    lock = _lock()
    lock["packages"][0]["name"] = "acme/demo-app"
    with pytest.raises(ValueError, match="collides with the root package"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    "package_type",
    ["composer-plugin", "composer-installer", "metapackage", "project", "custom"],
)
def test_lock_rejects_plugins_custom_installers_and_nonlibrary_types(
    package_type: str,
) -> None:
    lock = _lock()
    _selected(lock)["type"] = package_type
    with pytest.raises(ValueError, match="plugins and custom installers"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("replace", {"acme/old": "*"}),
        ("provide", {"psr/log-implementation": "3.0.0"}),
        ("conflict", {"acme/other": "<1.0"}),
        ("extra", {"branch-alias": {"dev-main": "2.x-dev"}}),
        ("scripts", {"post-install-cmd": "echo unsafe"}),
        ("target-dir", "src"),
        ("include-path", ["src"]),
    ],
)
def test_lock_package_rejects_replace_provide_conflict_alias_and_command_ambiguity(
    field: str, value: object
) -> None:
    lock = _lock()
    _selected(lock)[field] = value
    with pytest.raises(ValueError, match="resolution ambiguity"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("suggest", {}),
        ("autoload", {"psr-4": {"Acme\\Root\\": "src/"}}),
        ("autoload-dev", {"psr-4": {"Acme\\Tests\\": "tests/"}}),
        ("notification-url", "https://packagist.org/downloads/"),
        ("license", ["MIT"]),
        ("authors", [{"name": "Example"}]),
        ("description", "ignored metadata"),
        ("homepage", "https://github.com/acme/root-package"),
        ("keywords", ["example"]),
        ("support", {"source": "https://github.com/acme/root-package"}),
        ("funding", [{"type": "github", "url": "https://github.com/sponsors/acme"}]),
        ("time", "2026-01-01T00:00:00+00:00"),
        ("abandoned", False),
        ("bin", ["bin/tool"]),
    ],
)
def test_lock_package_keeps_standard_optional_metadata_non_authoritative(
    field: str, value: object
) -> None:
    lock = _lock()
    _selected(lock)[field] = value
    result = _parse_documents(_manifest(), lock)
    assert result.graph_provenance.status == "unresolved"
    assert not hasattr(result.locked_packages[-1], field.replace("-", "_"))


def test_lock_admits_coherent_source_and_dist_but_keeps_dist_required() -> None:
    lock = _lock()
    _selected(lock)["source"] = {
        "type": "git",
        "url": "https://github.com/acme/root-package.git",
        "reference": "b" * 40,
    }
    result = _parse_documents(_manifest(), lock)
    assert result.locked_packages[-1].source is not None
    assert (
        result.locked_packages[-1].source.reference
        == result.locked_packages[-1].distribution.reference
    )

    lock = _lock()
    assert _parse_documents(_manifest(), lock).locked_packages[-1].source is None

    lock = _lock()
    _selected(lock).pop("dist")
    with pytest.raises(ValueError, match="missing required field: dist"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("type", "hg", "HTTPS git"),
        ("url", "git@github.com:acme/root-package.git", "source URL"),
        ("url", "https://github.com/acme/root-package", "end in .git"),
        ("reference", "B" * 40, "source reference"),
    ],
)
def test_lock_rejects_malformed_source_fields(
    field: str, value: object, message: str
) -> None:
    lock = _lock()
    selected = _selected(lock)
    selected["source"] = {
        "type": "git",
        "url": "https://github.com/acme/root-package.git",
        "reference": "b" * 40,
    }
    selected["source"][field] = value
    with pytest.raises(ValueError, match=message):
        _parse_documents(_manifest(), lock)


def test_source_shape_and_dist_reference_coherence_are_required() -> None:
    lock = _lock()
    selected = _selected(lock)
    selected["source"] = {
        "type": "git",
        "url": "https://github.com/acme/root-package.git",
        "reference": "b" * 40,
        "branch": "main",
    }
    with pytest.raises(ValueError, match="exactly type, url, and reference"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    selected = _selected(lock)
    selected["source"] = {
        "type": "git",
        "url": "https://github.com/acme/root-package.git",
        "reference": "c" * 40,
    }
    with pytest.raises(ValueError, match="identify the same release"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    "url",
    [
        "HTTPS://api.github.com/repos/acme/root/zipball/ref",
        "http://api.github.com/repos/acme/root/zipball/ref",
        "git+https://github.com/acme/root.git",
        "file:///tmp/package.zip",
        "https://user@api.github.com/repos/acme/root/zipball/ref",
        "https://api.github.com:444/repos/acme/root/zipball/ref",
        "https://api.github.com:0443/repos/acme/root/zipball/ref",
        "https://API.github.com/repos/acme/root/zipball/ref",
        "https://localhost/package.zip",
        "https://127.0.0.1/package.zip",
        "https://[::1]/package.zip",
        "https://cdn.example/package.zip",
        "https://packages.internal/package.zip",
        "https://api.github.com/package.zip?token=secret",
        "https://api.github.com/package.zip?",
        "https://api.github.com/package.zip#fragment",
        "https://api.github.com/package.zip#",
        "https://api.github.com/a/../package.zip",
        "https://api.github.com/a%2fpackage.zip",
        "https://api.github.com\\package.zip",
        "https://api.github.com/",
        "https://münich.example.org/package.zip",
        " https://api.github.com/package.zip",
        "https://api.github.com:bad/package.zip",
        "https://api.github.com/package.zip\x7f",
    ],
)
def test_lock_rejects_unsafe_or_ambiguous_dist_urls(url: str) -> None:
    lock = _lock()
    _selected(lock)["dist"]["url"] = url
    with pytest.raises(ValueError, match="dist URL"):
        _parse_documents(_manifest(), lock)


@pytest.mark.parametrize(
    "character",
    ["|", "{", "}", "[", "]", "^", "`", "<", ">", '"', "\x00", "\x1f", "\x7f"],
)
def test_dist_url_path_rejects_characters_outside_unescaped_rfc3986_pchar(
    character: str,
) -> None:
    lock = _lock()
    _selected(lock)["dist"]["url"] = (
        "https://api.github.com/repos/acme/bad" + character + "path/package.zip"
    )
    with pytest.raises(ValueError, match="dist URL"):
        _parse_documents(_manifest(), lock)


def test_dist_url_hostname_enforces_the_253_character_textual_limit() -> None:
    admitted_host = ".".join(("a" * 63, "b" * 63, "c" * 63, "d" * 61))
    assert len(admitted_host) == 253
    lock = _lock()
    _selected(lock)["dist"]["url"] = f"https://{admitted_host}/package.zip"
    assert _parse_documents(_manifest(), lock).authority == "none"

    refused_host = ".".join(("a" * 63, "b" * 63, "c" * 63, "d" * 62))
    assert len(refused_host) == 254
    lock = _lock()
    _selected(lock)["dist"]["url"] = f"https://{refused_host}/package.zip"
    with pytest.raises(ValueError, match="host is not admitted public DNS syntax"):
        _parse_documents(_manifest(), lock)


def test_exact_explicit_https_default_port_remains_canonical() -> None:
    lock = _lock()
    _selected(lock)["dist"]["url"] = (
        "https://api.github.com:443/repos/acme/root-package/zipball/" + "b" * 40
    )
    result = _parse_documents(_manifest(), lock)
    assert result.direct_package.name == "acme/root-package"


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("type", "tar", "HTTPS zip"),
        ("reference", "a" * 39, "reference"),
        ("reference", "A" * 40, "reference"),
        ("reference", "dev-main", "reference"),
        ("shasum", "a" * 64, "shasum"),
        ("shasum", "A" * 40, "shasum"),
    ],
)
def test_lock_rejects_malformed_distribution_fields(
    field: str, value: object, message: str
) -> None:
    lock = _lock()
    _selected(lock)["dist"][field] = value
    with pytest.raises(ValueError, match=message):
        _parse_documents(_manifest(), lock)


def test_dist_shape_rejects_missing_and_unknown_fields() -> None:
    lock = _lock()
    _selected(lock)["dist"].pop("shasum")
    with pytest.raises(ValueError, match="must contain exactly"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    _selected(lock)["dist"]["checksum"] = "a" * 64
    with pytest.raises(ValueError, match="must contain exactly"):
        _parse_documents(_manifest(), lock)


def test_opaque_requirement_metadata_still_has_bounded_canonical_syntax(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    _selected(lock)["require"]["Acme/Leaf-Package"] = "^1.0"
    with pytest.raises(ValueError, match="canonical lowercase vendor/name"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    _selected(lock)["require"]["unsafe-platform"] = "*"
    with pytest.raises(ValueError, match="unsupported requirement identity"):
        _parse_documents(_manifest(), lock)

    lock = _lock()
    _selected(lock)["require"]["acme/leaf-package"] = {"version": "^1.0"}
    with pytest.raises(ValueError, match="malformed requirement"):
        _parse_documents(_manifest(), lock)

    monkeypatch.setattr(composer, "COMPOSER_LOCK_MAX_REQUIREMENTS_PER_PACKAGE", 1)
    with pytest.raises(ValueError, match="requirement-count limit"):
        _parse_documents(_manifest(), _lock())


def test_requirement_cap_applies_across_combined_require_and_require_dev(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    selected = _selected(lock)
    selected["require"] = {"acme/leaf-package": "^1.0"}
    selected["require-dev"] = {"acme/dev-package": "^1.0"}
    monkeypatch.setattr(composer, "COMPOSER_LOCK_MAX_REQUIREMENTS_PER_PACKAGE", 1)

    with pytest.raises(ValueError, match="combined requirement-count limit"):
        _parse_documents(_manifest(), lock)


def test_both_requirement_map_types_are_checked_before_the_combined_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _lock()
    _selected(lock)["require-dev"] = []
    monkeypatch.setattr(composer, "COMPOSER_LOCK_MAX_REQUIREMENTS_PER_PACKAGE", 1)

    with pytest.raises(ValueError, match="require-dev must be a JSON object"):
        _parse_documents(_manifest(), lock)


def test_transitive_constraint_text_is_explicitly_not_semantically_parsed() -> None:
    lock = _lock()
    _selected(lock)["require"]["acme/leaf-package"] = "not-composer-constraint-syntax"

    result = _parse_documents(_manifest(), lock)

    assert result.graph_provenance.status == "unresolved"
    assert "semantically unparsed" in result.graph_provenance.reason


def test_package_count_cap_is_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(composer, "COMPOSER_LOCK_MAX_PACKAGES", 1)
    with pytest.raises(ValueError, match="package-count limit"):
        parse_composer_root_lock(_manifest_text(), _lock_text())


@pytest.mark.parametrize(
    "manifest_value",
    [None, True, False, 0, 1.5, [], "text", {"type": {}}, {"require": []}],
)
def test_arbitrary_json_manifest_shapes_fail_as_value_errors(manifest_value: object) -> None:
    with pytest.raises(ValueError):
        parse_composer_root_lock(_dump(manifest_value), _lock_text())


@pytest.mark.parametrize(
    "lock_value",
    [None, True, False, 0, 1.5, [], "text", {"packages": {}}, {"_readme": {}}],
)
def test_arbitrary_json_lock_shapes_fail_as_value_errors(lock_value: object) -> None:
    with pytest.raises(ValueError):
        parse_composer_root_lock(_manifest_text(), _dump(lock_value))


def test_seeded_malformed_json_fuzz_never_escapes_the_value_error_boundary() -> None:
    randomizer = random.Random(0xC0DEC0DE)
    alphabet = '{}[],:"\\/abcdefghijklmnopqrstuvwxyz0123456789\n\t\ud800'
    refused = 0
    for _ in range(500):
        length = randomizer.randint(0, 512)
        fragment = "".join(randomizer.choice(alphabet) for _ in range(length))
        for manifest_text, lock_text in (
            (fragment, _lock_text()),
            (_manifest_text(), fragment),
        ):
            try:
                parse_composer_root_lock(manifest_text, lock_text)
            except ValueError:
                refused += 1
    assert refused == 1_000


def test_seeded_recursive_json_fuzz_never_crashes_on_valid_json_types() -> None:
    randomizer = random.Random(1714)

    def random_value(depth: int = 0) -> object:
        scalars: list[object] = [None, True, False, 0, 1.5, "", "text"]
        if depth >= 4:
            return randomizer.choice(scalars)
        choice = randomizer.randrange(4)
        if choice == 0:
            return randomizer.choice(scalars)
        if choice == 1:
            return [random_value(depth + 1) for _ in range(randomizer.randrange(4))]
        return {
            f"key-{index}": random_value(depth + 1)
            for index in range(randomizer.randrange(4))
        }

    for _ in range(500):
        value = _dump(random_value())
        for manifest_text, lock_text in (
            (value, _lock_text()),
            (_manifest_text(), value),
        ):
            with pytest.raises(ValueError):
                parse_composer_root_lock(manifest_text, lock_text)
