from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import random
from typing import Optional

import pytest

from agentrail.dependencies import gradle
from agentrail.dependencies.gradle import (
    GRADLE_BUILD_PATH,
    GRADLE_CENTRAL_REPOSITORY,
    GRADLE_LOCK_PATH,
    GRADLE_REQUIRED_SOURCE_PATHS,
    GRADLE_RESOLUTION_ARTIFACT_PATH,
    GRADLE_RESOLUTION_PROFILE,
    GRADLE_UNRESOLVED_EVIDENCE,
    GRADLE_WRAPPER_PROPERTIES_PATH,
    GradleSourceProfile,
    gradle_inventory_refusal,
    parse_gradle_source_profile,
)


FIXTURES = Path(__file__).parent / "fixtures" / "gradle"


def _build() -> str:
    return (FIXTURES / GRADLE_BUILD_PATH).read_text()


def _lock() -> str:
    return (FIXTURES / GRADLE_LOCK_PATH).read_text()


def _wrapper() -> str:
    return (FIXTURES / GRADLE_WRAPPER_PROPERTIES_PATH).read_text()


def _resolution_text() -> str:
    return (FIXTURES / GRADLE_RESOLUTION_ARTIFACT_PATH).read_text()


def _resolution() -> dict:
    return json.loads(_resolution_text())


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _dump(document: dict) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def _parse(
    *,
    build: Optional[str] = None,
    lock: Optional[str] = None,
    wrapper: Optional[str] = None,
    document: Optional[dict] = None,
    bind_sources: bool = True,
) -> GradleSourceProfile:
    build = _build() if build is None else build
    lock = _lock() if lock is None else lock
    wrapper = _wrapper() if wrapper is None else wrapper
    document = _resolution() if document is None else document
    if bind_sources:
        document["sourceSha256"] = {
            GRADLE_BUILD_PATH: _sha256(build),
            GRADLE_LOCK_PATH: _sha256(lock),
            GRADLE_WRAPPER_PROPERTIES_PATH: _sha256(wrapper),
        }
    return parse_gradle_source_profile(build, lock, wrapper, _dump(document))


def _lock_with(
    coordinate: str,
    configurations: str,
    *,
    text: Optional[str] = None,
) -> str:
    text = _lock() if text is None else text
    rows = text.splitlines()
    for index, row in enumerate(rows):
        if row.startswith(coordinate + "="):
            rows[index] = f"{coordinate}={configurations}"
            return "\n".join(rows) + "\n"
    raise AssertionError(f"fixture lock row not found: {coordinate}")


def test_parses_exact_bound_gradle_profile_without_authority() -> None:
    result = parse_gradle_source_profile(
        _build(),
        _lock(),
        _wrapper(),
        _resolution_text(),
    )

    assert result.profile == GRADLE_RESOLUTION_PROFILE
    assert result.resolution_artifact_path == GRADLE_RESOLUTION_ARTIFACT_PATH
    assert result.repository == GRADLE_CENTRAL_REPOSITORY
    assert result.root.directory == "."
    assert result.root.project_path == ":"
    assert [
        (item.coordinate.key, item.configuration)
        for item in result.direct_dependencies
    ] == [("com.fasterxml.jackson.core:jackson-databind:2.17.2", "implementation")]
    assert tuple(result.packages) == (
        "com.fasterxml.jackson.core:jackson-annotations:2.17.2",
        "com.fasterxml.jackson.core:jackson-core:2.17.2",
        "com.fasterxml.jackson.core:jackson-databind:2.17.2",
    )
    assert tuple(result.lock_entries) == tuple(result.packages)
    assert result.wrapper.version == "8.10.2"
    assert result.wrapper.distribution_url == (
        "https://services.gradle.org/distributions/gradle-8.10.2-bin.zip"
    )
    assert result.wrapper.distribution_sha256 == "a" * 64
    assert result.wrapper_jar_sha256 is None
    assert result.source_sha256 == {
        GRADLE_BUILD_PATH: "b1146fe81e45930fcff96b2915b45c98ae6f697b1a4cce7b60990b0a381ac37a",
        GRADLE_LOCK_PATH: "0927e0a51ea3fcfc3388f8b4a357f02cd19cef6af1466658db98ca50a421ea10",
        GRADLE_WRAPPER_PROPERTIES_PATH: "e279a9cc1222dd2d2e51ed8e5f423d35aeafeac3219cd13cdd9444d4dd2d5984",
        GRADLE_RESOLUTION_ARTIFACT_PATH: _sha256(_resolution_text()),
    }
    assert result.evidence_status == "syntax_and_custody_only"
    assert result.authority == "none"
    assert result.unresolved_evidence == GRADLE_UNRESOLVED_EVIDENCE
    assert result.unresolved_evidence == (
        "full_repository_inventory_and_configuration_absence",
        "gradle_wrapper_jar_and_distribution_authenticity",
        "maven_central_pom_and_artifact_authenticity",
        "gradle_runtime_and_configuration_resolution_reproduction",
        "target_update_selection_and_target_resolution",
        "security_evaluation",
    )
    assert not hasattr(result, "managed_command")

    package = result.packages["com.fasterxml.jackson.core:jackson-databind:2.17.2"]
    assert tuple(item.key for item in package.dependencies) == (
        "com.fasterxml.jackson.core:jackson-annotations:2.17.2",
        "com.fasterxml.jackson.core:jackson-core:2.17.2",
    )
    with pytest.raises(TypeError):
        result.packages["unsafe:mutation:1.0.0"] = package  # type: ignore[index]
    with pytest.raises(TypeError):
        result.source_sha256[GRADLE_BUILD_PATH] = "0" * 64  # type: ignore[index]


def test_wrapper_jar_digest_is_only_a_syntax_bound_claim() -> None:
    document = _resolution()
    document["wrapperJarSha256"] = "b" * 64

    result = _parse(document=document)

    assert result.wrapper_jar_sha256 == "b" * 64
    assert result.authority == "none"
    assert "gradle_wrapper_jar_and_distribution_authenticity" in result.unresolved_evidence


@pytest.mark.parametrize(
    ("position", "value", "label"),
    [
        (0, None, GRADLE_BUILD_PATH),
        (0, b"", GRADLE_BUILD_PATH),
        (1, None, GRADLE_LOCK_PATH),
        (1, b"", GRADLE_LOCK_PATH),
        (2, None, "gradle-wrapper.properties"),
        (2, b"", "gradle-wrapper.properties"),
        (3, None, GRADLE_RESOLUTION_ARTIFACT_PATH),
        (3, b"", GRADLE_RESOLUTION_ARTIFACT_PATH),
    ],
)
def test_non_text_sources_refuse(position: int, value: object, label: str) -> None:
    values: list[object] = [_build(), _lock(), _wrapper(), _resolution_text()]
    values[position] = value
    with pytest.raises(ValueError, match=label):
        parse_gradle_source_profile(*values)


def test_source_byte_limits_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gradle, "GRADLE_BUILD_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="build.gradle exceeds the byte limit"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), _resolution_text())

    monkeypatch.setattr(gradle, "GRADLE_BUILD_MAX_BYTES", 256 * 1024)
    monkeypatch.setattr(gradle, "GRADLE_LOCK_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="gradle.lockfile exceeds the byte limit"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), _resolution_text())

    monkeypatch.setattr(gradle, "GRADLE_LOCK_MAX_BYTES", 8 * 1024 * 1024)
    monkeypatch.setattr(gradle, "GRADLE_WRAPPER_PROPERTIES_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="gradle-wrapper.properties exceeds the byte limit"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), _resolution_text())

    monkeypatch.setattr(gradle, "GRADLE_WRAPPER_PROPERTIES_MAX_BYTES", 16 * 1024)
    monkeypatch.setattr(gradle, "GRADLE_RESOLUTION_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="resolution-v1.json exceeds the byte limit"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), _resolution_text())


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.replace("id 'java'", 'id("java")'),
        lambda value: value.replace("id 'java'", "id 'application'"),
        lambda value: value.replace("id 'java'", "id 'java' version '1.0.0'"),
        lambda value: value.replace("mavenCentral()", "google()"),
        lambda value: value.replace("mavenCentral()", "maven { url 'https://example.com' }"),
        lambda value: value.replace("dependencies {", "def version = '2.17.2'\ndependencies {"),
        lambda value: value + "println 'code'\n",
        lambda value: value.replace("plugins {", "// comment\nplugins {"),
        lambda value: value.replace("\n\nrepositories", "\nrepositories"),
    ],
)
def test_build_rejects_kotlin_plugins_custom_repositories_code_and_noncanonical_layout(mutation) -> None:
    with pytest.raises(ValueError, match="canonical java plugin|single-quoted literal"):
        _parse(build=mutation(_build()))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("dependencyLocking {\n    lockMode = LockMode.STRICT\n}\n\n", ""),
        ("LockMode.STRICT", "LockMode.DEFAULT"),
        ("    lockMode = LockMode.STRICT\n", ""),
        (
            "resolutionStrategy.activateDependencyLocking()",
            "resolutionStrategy.deactivateDependencyLocking()",
        ),
        (
            "    compileClasspath {\n        resolutionStrategy.activateDependencyLocking()\n    }\n",
            "",
        ),
        ("compileClasspath", "testCompileClasspath"),
        ("runtimeClasspath", "testRuntimeClasspath"),
        (
            "    runtimeClasspath {",
            "    apiElements {\n        resolutionStrategy.activateDependencyLocking()\n    }\n"
            "    runtimeClasspath {",
        ),
        (
            "    lockMode = LockMode.STRICT",
            "    lockMode = LockMode.STRICT\n    lockAllConfigurations()",
        ),
    ],
)
def test_build_requires_exact_strict_lock_activation_for_only_supported_configurations(
    old: str,
    new: str,
) -> None:
    with pytest.raises(ValueError, match="strict locking for only"):
        _parse(build=_build().replace(old, new, 1))


@pytest.mark.parametrize(
    "declaration",
    [
        "implementation platform('com.example:bom:1.2.3')",
        "implementation enforcedPlatform('com.example:bom:1.2.3')",
        "implementation files('libs/local.jar')",
        "implementation project(':child')",
        "api 'com.example:lib:1.2.3'",
        "runtimeOnly 'com.example:lib:1.2.3'",
        "implementation \"com.example:lib:${version}\"",
        "implementation libs.example",
    ],
)
def test_build_rejects_bom_files_projects_other_configurations_and_interpolation(
    declaration: str,
) -> None:
    build = _build().replace(
        "implementation 'com.fasterxml.jackson.core:jackson-databind:2.17.2'",
        declaration,
    )
    with pytest.raises(ValueError, match="single-quoted literal"):
        _parse(build=build)


@pytest.mark.parametrize(
    "version",
    [
        "2.17",
        "2.17.+",
        "[2.0.0,3.0.0)",
        "2.17.2-SNAPSHOT",
        "2.17.2-rc.1",
        "latest.release",
        "02.17.2",
        "1234567890.1.1",
        "2.١٧.2",
    ],
)
def test_build_rejects_dynamic_rich_snapshot_prerelease_and_unbounded_versions(
    version: str,
) -> None:
    build = _build().replace("2.17.2'", f"{version}'", 1)
    with pytest.raises(ValueError, match="exact bounded stable"):
        _parse(build=build)


@pytest.mark.parametrize(
    ("coordinate", "match"),
    [
        ("Com.example:lib:1.2.3", "lowercase ASCII"),
        ("com.example:Lib:1.2.3", "lowercase ASCII"),
        ("com.example:lib:1.2.3:tests", "canonical group:artifact:version"),
        ("com.example:lib:1.2.3@zip", "exact bounded stable"),
    ],
)
def test_build_rejects_case_classifier_and_extension_coordinates(
    coordinate: str,
    match: str,
) -> None:
    build = _build().replace(
        "com.fasterxml.jackson.core:jackson-databind:2.17.2",
        coordinate,
        1,
    )
    with pytest.raises(ValueError, match=match):
        _parse(build=build)


def test_build_rejects_multiple_dependencies_and_noncanonical_text() -> None:
    second = "    implementation 'com.example:other:1.0.0'\n"
    build = _build().replace("}\n", second + "}\n", 1)
    with pytest.raises(ValueError, match="canonical java plugin"):
        _parse(build=build)

    for mutation in (
        lambda value: value.rstrip("\n"),
        lambda value: value.replace("\n", "\r\n"),
        lambda value: "\ufeff" + value,
        lambda value: value.replace("plugins {", "plugins { "),
        lambda value: value.replace("    id", "\tid"),
    ):
        with pytest.raises(ValueError, match="LF|UTF-8|trailing whitespace"):
            _parse(build=mutation(_build()))


def test_inventory_receipt_helper_is_bounded_and_does_not_claim_completeness() -> None:
    assert gradle_inventory_refusal(list(GRADLE_REQUIRED_SOURCE_PATHS)) is None
    assert "bounded list" in (gradle_inventory_refusal(set(GRADLE_REQUIRED_SOURCE_PATHS)) or "")
    assert "missing required" in (gradle_inventory_refusal([]) or "")
    assert "non-canonical" in (
        gradle_inventory_refusal(sorted((*GRADLE_REQUIRED_SOURCE_PATHS, "../build.gradle")))
        or ""
    )


@pytest.mark.parametrize(
    ("path", "reason"),
    [
        ("build.gradle.kts", "Kotlin"),
        ("settings.gradle", "settings"),
        ("settings.gradle.kts", "settings"),
        ("buildSrc/src/main/groovy/Plugin.groovy", "buildSrc"),
        ("gradle/libs.versions.toml", "version catalogs"),
        ("gradle.properties", "gradle.properties"),
        ("child/gradle.properties", "gradle.properties"),
        ("gradle/verification-metadata.xml", "verification metadata"),
        ("child/gradle/verification-metadata.xml", "verification metadata"),
        ("child/build.gradle", "subprojects"),
        ("child/gradle.lockfile", "subprojects"),
    ],
)
def test_inventory_receipt_refuses_unmodelled_gradle_surfaces(path: str, reason: str) -> None:
    refusal = gradle_inventory_refusal(sorted((*GRADLE_REQUIRED_SOURCE_PATHS, path)))
    assert refusal is not None
    assert reason in refusal


def test_inventory_receipt_refuses_duplicate_case_ambiguous_and_excessive_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = sorted((*GRADLE_REQUIRED_SOURCE_PATHS, "BUILD.GRADLE"))
    assert "case-ambiguous" in (gradle_inventory_refusal(paths) or "")

    monkeypatch.setattr(gradle, "GRADLE_INVENTORY_MAX_PATHS", 1)
    assert "path limit" in (gradle_inventory_refusal(list(GRADLE_REQUIRED_SOURCE_PATHS)) or "")

    monkeypatch.setattr(gradle, "GRADLE_INVENTORY_MAX_PATHS", 100_000)
    monkeypatch.setattr(gradle, "GRADLE_INVENTORY_MAX_BYTES", 4)
    assert "byte limit" in (gradle_inventory_refusal(list(GRADLE_REQUIRED_SOURCE_PATHS)) or "")


@pytest.mark.parametrize(
    "url",
    [
        "http\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip",
        "https\\://example.com/distributions/gradle-8.10.2-bin.zip",
        "https\\://user:pass@services.gradle.org/distributions/gradle-8.10.2-bin.zip",
        "https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip?x=1",
        "https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip#fragment",
        "https\\://services.gradle.org/distributions/gradle-8.10.2-all.zip",
        "https\\://services.gradle.org/distributions/gradle-8.10.2-rc-1-bin.zip",
        "https\\://services.gradle.org/distributions/gradle-9.0.0-bin.zip",
        "https\\://services.gradle.org/distributions/gradle-8.01.0-bin.zip",
        "https://services.gradle.org/distributions/gradle-8.10.2-bin.zip",
    ],
)
def test_wrapper_rejects_nonofficial_credentials_query_fragment_redirect_like_or_unstable_urls(
    url: str,
) -> None:
    wrapper = _wrapper().replace(
        "https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip",
        url,
    )
    with pytest.raises(ValueError, match="credential-free canonical HTTPS"):
        _parse(wrapper=wrapper)


@pytest.mark.parametrize("checksum", ["A" * 64, "a" * 63, "g" * 64, "sha256:" + "a" * 64])
def test_wrapper_requires_lowercase_64_hex_distribution_checksum(checksum: str) -> None:
    wrapper = _wrapper().replace("a" * 64, checksum)
    with pytest.raises(ValueError, match="lowercase 64-hex"):
        _parse(wrapper=wrapper)


def test_wrapper_rejects_duplicate_missing_unknown_and_unsafe_properties() -> None:
    duplicate = _wrapper() + "distributionBase=GRADLE_USER_HOME\n"
    with pytest.raises(ValueError, match="duplicate key"):
        _parse(wrapper=duplicate)

    missing = _wrapper().replace("networkTimeout=10000\n", "")
    with pytest.raises(ValueError, match="contain exactly"):
        _parse(wrapper=missing)

    unknown = _wrapper() + "systemProp.http.proxyHost=example.com\n"
    with pytest.raises(ValueError, match="contain exactly"):
        _parse(wrapper=unknown)

    unsafe = _wrapper().replace("validateDistributionUrl=true", "validateDistributionUrl=false")
    with pytest.raises(ValueError, match="must be true"):
        _parse(wrapper=unsafe)


def test_wrapper_accepts_exact_stable_two_component_gradle_8_version() -> None:
    wrapper = _wrapper().replace("gradle-8.10.2-bin.zip", "gradle-8.10-bin.zip")
    result = _parse(wrapper=wrapper)
    assert result.wrapper.version == "8.10"


def test_lock_requires_header_terminal_empty_row_and_sorted_unique_packages() -> None:
    with pytest.raises(ValueError, match="canonical Gradle lock header"):
        _parse(lock=_lock().replace(_LOCK_HEADER_FIRST, "# hand written", 1))

    with pytest.raises(ValueError, match="canonical empty="):
        _parse(lock=_lock().replace("empty=\n", ""))

    rows = _lock().splitlines()
    rows[3], rows[4] = rows[4], rows[3]
    with pytest.raises(ValueError, match="must be sorted"):
        _parse(lock="\n".join(rows) + "\n")

    duplicate = _lock().replace("empty=\n", rows[3] + "\nempty=\n")
    with pytest.raises(ValueError, match="duplicate package|must be sorted"):
        _parse(lock=duplicate)


_LOCK_HEADER_FIRST = "# This is a Gradle generated file for dependency locking."


@pytest.mark.parametrize(
    "configurations",
    [
        "testCompileClasspath",
        "runtimeClasspath,compileClasspath",
        "compileClasspath,compileClasspath",
        "compileClasspath,runtimeClasspath,testRuntimeClasspath",
        "",
    ],
)
def test_lock_rejects_unsupported_duplicate_or_noncanonical_configurations(
    configurations: str,
) -> None:
    lock = _lock_with(
        "com.fasterxml.jackson.core:jackson-core:2.17.2",
        configurations,
    )
    with pytest.raises(ValueError, match="unsupported or non-canonical configurations"):
        _parse(lock=lock)


def test_lock_rejects_multiple_versions_dynamic_classifier_and_malformed_rows() -> None:
    multiple = _lock().replace(
        "empty=\n",
        "com.fasterxml.jackson.core:jackson-core:2.17.1=compileClasspath,runtimeClasspath\nempty=\n",
    )
    with pytest.raises(ValueError, match="multiple versions"):
        _parse(lock=multiple)

    for old, new, match in (
        ("jackson-core:2.17.2=", "jackson-core:2.+=", "exact bounded stable"),
        ("jackson-core:2.17.2=", "jackson-core:2.17.2:tests=", "canonical group:artifact:version"),
        ("jackson-core:2.17.2=", "jackson-core:2.17.2==", "malformed lock row"),
    ):
        with pytest.raises(ValueError, match=match):
            _parse(lock=_lock().replace(old, new, 1))


def test_lock_and_wrapper_require_canonical_lf_text() -> None:
    for source_name, value in (("lock", _lock()), ("wrapper", _wrapper())):
        for mutation in (
            lambda text: text.rstrip("\n"),
            lambda text: text.replace("\n", "\r\n"),
            lambda text: "\ufeff" + text,
            lambda text: text.replace("=", "= ", 1),
        ):
            with pytest.raises(
                ValueError,
                match="LF|UTF-8|trailing whitespace|must be|non-canonical configurations",
            ):
                _parse(**{source_name: mutation(value)})


def test_lock_package_limit_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gradle, "GRADLE_LOCK_MAX_PACKAGES", 2)
    with pytest.raises(ValueError, match="package limit|line limit"):
        _parse()


def test_resolution_rejects_duplicate_keys_nonfinite_and_excessive_nesting() -> None:
    duplicate = _resolution_text().replace(
        '"schemaVersion": 1,',
        '"schemaVersion": 1,\n  "schemaVersion": 1,',
        1,
    )
    with pytest.raises(ValueError, match="duplicate JSON key"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), duplicate)

    with pytest.raises(ValueError, match="non-finite"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), '{"x": NaN}')

    nested = "[" * 2_000 + "]" * 2_000
    with pytest.raises(ValueError, match="nesting limit"):
        parse_gradle_source_profile(_build(), _lock(), _wrapper(), nested)


@pytest.mark.parametrize(
    ("mutation", "match"),
    [
        (lambda value: value.update(profile="other"), "profile is unsupported"),
        (lambda value: value.update(repository="https://repo1.maven.org/maven2"), "canonical Maven Central"),
        (lambda value: value.update(complete=False), "complete reachable graph"),
        (lambda value: value.update(schemaVersion=True), "integer 1"),
        (lambda value: value.update(extra="unsafe"), "must contain exactly"),
    ],
)
def test_resolution_rejects_wrong_profile_repository_incomplete_or_unknown_shape(
    mutation,
    match: str,
) -> None:
    document = _resolution()
    mutation(document)
    with pytest.raises(ValueError, match=match):
        _parse(document=document)


@pytest.mark.parametrize(
    "source_path",
    [GRADLE_BUILD_PATH, GRADLE_LOCK_PATH, GRADLE_WRAPPER_PROPERTIES_PATH],
)
def test_resolution_binds_exact_source_bytes_and_digest_syntax(source_path: str) -> None:
    document = _resolution()
    document["sourceSha256"][source_path] = "0" * 64
    with pytest.raises(ValueError, match=f"exact {re_escape(source_path)} bytes"):
        _parse(document=document, bind_sources=False)

    document = _resolution()
    document["sourceSha256"][source_path] = "A" * 64
    with pytest.raises(ValueError, match="lowercase SHA-256"):
        _parse(document=document, bind_sources=False)


def re_escape(value: str) -> str:
    return value.replace(".", r"\.")


def test_resolution_source_digest_map_rejects_missing_and_extra_paths() -> None:
    document = _resolution()
    del document["sourceSha256"][GRADLE_LOCK_PATH]
    with pytest.raises(ValueError, match="must contain exactly"):
        _parse(document=document, bind_sources=False)

    document = _resolution()
    document["sourceSha256"]["settings.gradle"] = "a" * 64
    with pytest.raises(ValueError, match="must contain exactly"):
        _parse(document=document, bind_sources=False)


@pytest.mark.parametrize(
    ("value", "match"),
    [
        ("A" * 64, "null or lowercase"),
        ("a" * 63, "null or lowercase"),
        (True, "null or lowercase"),
        ({"sha256": "a" * 64}, "null or lowercase"),
    ],
)
def test_resolution_rejects_invalid_wrapper_jar_digest_claim(value: object, match: str) -> None:
    document = _resolution()
    document["wrapperJarSha256"] = value
    with pytest.raises(ValueError, match=match):
        _parse(document=document)


def test_resolution_requires_exact_one_local_root_and_direct_declaration() -> None:
    document = _resolution()
    document["root"]["directory"] = "subproject"
    with pytest.raises(ValueError, match="exactly one local root"):
        _parse(document=document)

    document = _resolution()
    document["directDependencies"][0]["configuration"] = "api"
    with pytest.raises(ValueError, match="direct implementation"):
        _parse(document=document)

    document = _resolution()
    document["directDependencies"][0]["version"] = "2.17.1"
    with pytest.raises(ValueError, match="does not match build.gradle"):
        _parse(document=document)

    document = _resolution()
    document["directDependencies"].append(copy.deepcopy(document["directDependencies"][0]))
    with pytest.raises(ValueError, match="one direct"):
        _parse(document=document)


def test_resolution_rejects_duplicate_multiple_version_and_unsorted_packages() -> None:
    document = _resolution()
    document["packages"].append(copy.deepcopy(document["packages"][-1]))
    with pytest.raises(ValueError, match="duplicate package"):
        _parse(document=document)

    document = _resolution()
    extra = copy.deepcopy(document["packages"][0])
    extra["version"] = "2.17.1"
    extra["pom"]["url"] = extra["pom"]["url"].replace("2.17.2", "2.17.1")
    extra["artifactFile"]["url"] = extra["artifactFile"]["url"].replace("2.17.2", "2.17.1")
    document["packages"].insert(0, extra)
    with pytest.raises(ValueError, match="multiple versions"):
        _parse(document=document)

    document = _resolution()
    document["packages"][0], document["packages"][1] = (
        document["packages"][1],
        document["packages"][0],
    )
    with pytest.raises(ValueError, match="packages must be sorted"):
        _parse(document=document)


def test_resolution_package_set_and_lock_configuration_must_match_exactly() -> None:
    document = _resolution()
    document["packages"] = document["packages"][:-1]
    with pytest.raises(ValueError, match="does not bind the implementation"):
        _parse(document=document)

    lock = _lock_with(
        "com.fasterxml.jackson.core:jackson-core:2.17.2",
        "runtimeClasspath",
    )
    with pytest.raises(ValueError, match="configurations do not match"):
        _parse(lock=lock)


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("scope", "test", "unsupported scope"),
        ("version", "2.17.2-SNAPSHOT", "exact bounded stable"),
        ("group", "Com.fasterxml.jackson.core", "lowercase ASCII"),
        ("artifact", "Jackson-Core", "lowercase ASCII"),
    ],
)
def test_resolution_rejects_scope_qualifier_and_case_ambiguity(
    field: str,
    value: str,
    match: str,
) -> None:
    document = _resolution()
    document["packages"][0][field] = value
    with pytest.raises(ValueError, match=match):
        _parse(document=document)


def test_resolution_rejects_scope_configuration_mismatch() -> None:
    document = _resolution()
    document["packages"][0]["scope"] = "runtime"
    with pytest.raises(ValueError, match="scope/configuration mismatch"):
        _parse(document=document)


def test_resolution_rejects_missing_duplicate_unsorted_edges_orphans_and_cycles() -> None:
    document = _resolution()
    document["packages"][-1]["dependencies"][0] = "com.example:missing:1.0.0"
    with pytest.raises(ValueError, match="missing external package"):
        _parse(document=document)

    document = _resolution()
    edge = document["packages"][-1]["dependencies"][0]
    document["packages"][-1]["dependencies"] = [edge, edge]
    with pytest.raises(ValueError, match="not canonical and unique"):
        _parse(document=document)

    document = _resolution()
    document["packages"][-1]["dependencies"].reverse()
    with pytest.raises(ValueError, match="not canonical and unique"):
        _parse(document=document)

    document = _resolution()
    document["packages"][-1]["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-core:2.17.2"
    ]
    with pytest.raises(ValueError, match="unreachable package"):
        _parse(document=document)

    document = _resolution()
    document["packages"][1]["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-databind:2.17.2"
    ]
    with pytest.raises(ValueError, match="dependency cycle"):
        _parse(document=document)


def test_resolution_rejects_runtime_to_compile_scope_configuration_widening() -> None:
    document = _resolution()
    runtime_package = document["packages"][0]
    runtime_package["scope"] = "runtime"
    runtime_package["configurations"] = ["runtimeClasspath"]
    runtime_package["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-core:2.17.2"
    ]
    lock = _lock_with(
        "com.fasterxml.jackson.core:jackson-annotations:2.17.2",
        "runtimeClasspath",
    )
    with pytest.raises(ValueError, match="widens from runtime to compile"):
        _parse(document=document, lock=lock)


@pytest.mark.parametrize(
    ("claim", "field", "value", "match"),
    [
        ("pom", "url", "https://example.com/package.pom", "canonical Maven Central URL"),
        ("artifactFile", "url", "https://repo.maven.apache.org/maven2/wrong.jar", "canonical Maven Central URL"),
        ("pom", "sha512", "A" * 128, "lowercase SHA-512"),
        ("artifactFile", "sha512", "f" * 127, "lowercase SHA-512"),
    ],
)
def test_resolution_rejects_noncanonical_urls_and_sha512_syntax_claims(
    claim: str,
    field: str,
    value: str,
    match: str,
) -> None:
    document = _resolution()
    document["packages"][0][claim][field] = value
    with pytest.raises(ValueError, match=match):
        _parse(document=document)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("classifier", "tests"),
        ("extension", "zip"),
        ("project", ":child"),
        ("file", "libs/local.jar"),
        ("platform", True),
        ("substitution", "com.example:other:1.0.0"),
    ],
)
def test_resolution_rejects_classifier_extension_project_file_platform_and_substitution_claims(
    field: str,
    value: object,
) -> None:
    document = _resolution()
    document["packages"][0][field] = value
    with pytest.raises(ValueError, match="must contain exactly"):
        _parse(document=document)


def test_resolution_package_and_edge_caps_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gradle, "GRADLE_RESOLUTION_MAX_PACKAGES", 2)
    with pytest.raises(ValueError, match="package limit"):
        _parse()

    monkeypatch.setattr(gradle, "GRADLE_RESOLUTION_MAX_PACKAGES", 20_000)
    monkeypatch.setattr(gradle, "GRADLE_RESOLUTION_MAX_EDGES", 1)
    with pytest.raises(ValueError, match="dependency-edge limit"):
        _parse()


def test_malformed_input_fuzz_never_escapes_as_a_parser_crash() -> None:
    randomizer = random.Random(10_817)
    baseline = [_build(), _lock(), _wrapper(), _resolution_text()]
    alphabet = "{}[]()'\"$=:,./\\\n\r\t\x00 abcXYZ019-+@#\u2603"

    for _ in range(500):
        values = list(baseline)
        target = randomizer.randrange(len(values))
        value = values[target]
        operation = randomizer.randrange(3)
        position = randomizer.randrange(len(value) + 1)
        if operation == 0:
            value = value[:position] + randomizer.choice(alphabet) + value[position:]
        elif operation == 1 and value:
            value = value[: max(0, position - 1)] + value[position:]
        else:
            value = value[:position]
        values[target] = value

        try:
            result = parse_gradle_source_profile(*values)
        except ValueError:
            continue
        except Exception as exc:  # pragma: no cover - assertion reports the unexpected crash
            pytest.fail(f"unexpected parser exception: {type(exc).__name__}: {exc}")
        else:
            assert isinstance(result, GradleSourceProfile)
