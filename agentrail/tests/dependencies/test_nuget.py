from __future__ import annotations

import copy
import json
from pathlib import Path
import random

import pytest

from agentrail.dependencies import nuget
from agentrail.dependencies.nuget import (
    NUGET_LOCKFILE_PATH,
    NUGET_PROFILE,
    NUGET_PROJECT_SDK,
    NUGET_UNRESOLVED_EVIDENCE,
    NuGetSourceProfile,
    canonical_nuget_package_id,
    parse_nuget_source_profile,
    stable_nuget_version,
)


FIXTURES = Path(__file__).parent / "fixtures" / "nuget"


def _project() -> str:
    return (FIXTURES / "app.csproj").read_text()


def _lock_text() -> str:
    return (FIXTURES / NUGET_LOCKFILE_PATH).read_text()


def _lock() -> dict:
    return json.loads(_lock_text())


def _dump(document: dict) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def _packages(document: dict) -> dict:
    return document["dependencies"]["net8.0"]


def test_parses_single_target_closed_graph_without_authority() -> None:
    result = parse_nuget_source_profile(_project(), _lock_text())

    assert result.profile == NUGET_PROFILE
    assert result.lockfile_path == NUGET_LOCKFILE_PATH
    assert result.project.sdk == NUGET_PROJECT_SDK
    assert result.project.target_framework == "net8.0"
    assert result.project_sha256 == "36c91e526564d7dfac9c966a7e43b942e360240d9f3832106a150cf90590d135"
    assert result.lock_sha256 == "3f2603f93e58e31113932d80a6d68dcb606ef69b3be6521254e94f964a5f64a2"
    assert [
        (item.package_id, item.canonical_id, item.version)
        for item in result.direct_dependencies
    ] == [
        ("Contoso.Root", "contoso.root", "2.1.0"),
        ("Newtonsoft.Json", "newtonsoft.json", "13.0.3"),
    ]
    assert tuple(result.packages) == (
        "contoso.common",
        "contoso.root",
        "newtonsoft.json",
        "system.memory",
    )
    root = result.packages["contoso.root"]
    assert root.dependency_type == "Direct"
    assert root.requested == "[2.1.0, )"
    assert root.requested_version == "2.1.0"
    assert root.resolved_version == "2.1.0"
    assert [
        (edge.canonical_id, edge.minimum_version) for edge in root.dependencies
    ] == [("contoso.common", "1.0.0")]
    assert result.packages["contoso.common"].resolved_version == "1.2.0"
    assert result.graph_status == "internally_closed"
    assert result.evidence_status == "syntax_and_custody_only"
    assert result.authority == "none"
    assert result.unresolved_evidence == NUGET_UNRESOLVED_EVIDENCE
    assert result.unresolved_evidence == (
        "nuget_org_package_authenticity",
        "package_artifact_and_signature_verification",
        "package_security_status",
        "repository_inventory_and_config_absence",
        "runtime_and_msbuild_reproduction",
        "target_update_selection_and_resolution",
    )
    assert not hasattr(result, "managed_command")
    assert not hasattr(result, "repository")
    with pytest.raises(TypeError):
        result.packages["unsafe"] = root  # type: ignore[index]


def test_exact_source_digests_change_with_supplied_utf8_bytes() -> None:
    baseline = parse_nuget_source_profile(_project(), _lock_text())
    changed_project = parse_nuget_source_profile(_project() + "\n", _lock_text())
    changed_lock = parse_nuget_source_profile(_project(), _lock_text() + "\n")

    assert changed_project.project_sha256 != baseline.project_sha256
    assert changed_project.lock_sha256 == baseline.lock_sha256
    assert changed_lock.project_sha256 == baseline.project_sha256
    assert changed_lock.lock_sha256 != baseline.lock_sha256


@pytest.mark.parametrize(
    "value,label",
    [
        (None, "SDK project"),
        (b"<Project/>", "SDK project"),
        (None, NUGET_LOCKFILE_PATH),
        (b"{}", NUGET_LOCKFILE_PATH),
    ],
)
def test_non_text_sources_refuse(value: object, label: str) -> None:
    if label == "SDK project":
        call = lambda: parse_nuget_source_profile(value, _lock_text())
    else:
        call = lambda: parse_nuget_source_profile(_project(), value)
    with pytest.raises(ValueError, match=label):
        call()


def test_invalid_unicode_and_source_byte_caps_refuse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValueError, match="valid UTF-8"):
        parse_nuget_source_profile("\ud800", _lock_text())
    with pytest.raises(ValueError, match="valid UTF-8"):
        parse_nuget_source_profile(_project(), "\ud800")

    monkeypatch.setattr(nuget, "NUGET_PROJECT_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="SDK project exceeds the byte limit"):
        parse_nuget_source_profile(_project(), _lock_text())

    monkeypatch.setattr(nuget, "NUGET_PROJECT_MAX_BYTES", 256 * 1024)
    monkeypatch.setattr(nuget, "NUGET_LOCK_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="packages.lock.json exceeds the byte limit"):
        parse_nuget_source_profile(_project(), _lock_text())


@pytest.mark.parametrize(
    "injection,match",
    [
        ("<!-- hidden -->", "comments and processing instructions"),
        ("<?unsafe value?>", "comments and processing instructions"),
        ('<?xml version="1.0" encoding="UTF-8"?>', "comments and processing instructions"),
        ('<!DOCTYPE Project [<!ENTITY x "boom">]>', "DTD, entity declaration, or CDATA"),
        ('<!ENTITY x "boom">', "DTD, entity declaration, or CDATA"),
        ("<![CDATA[hidden]]>", "DTD, entity declaration, or CDATA"),
    ],
)
def test_project_rejects_comments_processing_instructions_dtd_entities_and_cdata(
    injection: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(injection + _project(), _lock_text())


def test_project_rejects_entity_references_and_byte_order_mark() -> None:
    encoded_id = _project().replace("Contoso.Root", "Contoso&#46;Root", 1)
    with pytest.raises(ValueError, match="entity references"):
        parse_nuget_source_profile(encoded_id, _lock_text())

    with pytest.raises(ValueError, match="byte-order mark"):
        parse_nuget_source_profile("\ufeff" + _project(), _lock_text())


def test_project_rejects_non_xml_unicode_whitespace_as_mixed_text() -> None:
    before_property_group = _project().replace(
        "  <PropertyGroup>",
        "\u00a0  <PropertyGroup>",
        1,
    )
    with pytest.raises(ValueError, match="mixed element text"):
        parse_nuget_source_profile(before_property_group, _lock_text())

    for body in ["\u00a0", "\u2028"]:
        package_body = _project().replace(
            '<PackageReference Include="Contoso.Root" Version="2.1.0" />',
            '<PackageReference Include="Contoso.Root" Version="2.1.0">'
            + body
            + "</PackageReference>",
            1,
        )
        with pytest.raises(ValueError, match="child Version nodes"):
            parse_nuget_source_profile(package_body, _lock_text())


def test_project_xml_depth_and_element_caps_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(nuget, "NUGET_XML_MAX_DEPTH", 2)
    with pytest.raises(ValueError, match="XML depth limit"):
        parse_nuget_source_profile(_project(), _lock_text())

    monkeypatch.setattr(nuget, "NUGET_XML_MAX_DEPTH", 4)
    monkeypatch.setattr(nuget, "NUGET_XML_MAX_ELEMENTS", 4)
    with pytest.raises(ValueError, match="XML element limit"):
        parse_nuget_source_profile(_project(), _lock_text())


@pytest.mark.parametrize(
    "project,match",
    [
        (
            _project().replace(
                '<Project Sdk="Microsoft.NET.Sdk">',
                '<Project xmlns="urn:foreign" Sdk="Microsoft.NET.Sdk">',
            ),
            "namespace",
        ),
        (
            _project().replace("Microsoft.NET.Sdk", "Microsoft.NET.Sdk.Web", 1),
            "supports only Sdk",
        ),
        (
            _project().replace('<Project Sdk="Microsoft.NET.Sdk">', "<Project>"),
            "SDK-style Project root",
        ),
        (
            _project().replace("  <PropertyGroup>", "  hidden\n  <PropertyGroup>", 1),
            "mixed element text",
        ),
    ],
)
def test_project_rejects_namespaces_other_sdks_missing_sdk_and_mixed_text(
    project: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(project, _lock_text())


@pytest.mark.parametrize(
    "old,new,match",
    [
        (
            '<Project Sdk="Microsoft.NET.Sdk">',
            '<Project Sdk="Microsoft.NET.Sdk" Condition="true">',
            "SDK-style Project root",
        ),
        ("<PropertyGroup>", '<PropertyGroup Condition="true">', "rejects conditions"),
        ("<ItemGroup>", '<ItemGroup Condition="true">', "unconditional"),
        (
            '<PackageReference Include="Contoso.Root" Version="2.1.0" />',
            '<PackageReference Include="Contoso.Root" Version="2.1.0" Condition="true" />',
            "Condition, Update, Remove",
        ),
    ],
)
def test_project_rejects_conditions_everywhere(
    old: str,
    new: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(_project().replace(old, new, 1), _lock_text())


@pytest.mark.parametrize(
    "unsupported",
    [
        '<Import Project="Directory.Build.props" />',
        '<Target Name="Unsafe"><Exec Command="whoami" /></Target>',
        '<UsingTask TaskName="Unsafe" AssemblyFile="unsafe.dll" />',
        '<Exec Command="whoami" />',
        '<ItemGroup><ProjectReference Include="other.csproj" /></ItemGroup>',
    ],
)
def test_project_rejects_import_target_usingtask_exec_and_project_reference(
    unsupported: str,
) -> None:
    project = _project().replace("  <ItemGroup>", f"  {unsupported}\n  <ItemGroup>", 1)
    with pytest.raises(ValueError, match="rejects imports, targets|requires one leading"):
        parse_nuget_source_profile(project, _lock_text())


@pytest.mark.parametrize(
    "replacement",
    [
        "<TargetFrameworks>net8.0;net9.0</TargetFrameworks>",
        "<RuntimeIdentifier>linux-x64</RuntimeIdentifier>",
        "<RuntimeIdentifiers>linux-x64;win-x64</RuntimeIdentifiers>",
        "<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>",
        "<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>",
        "<PackageVersion>2.1.0</PackageVersion>",
        "<ContosoVersion>2.1.0</ContosoVersion>",
    ],
)
def test_project_rejects_multi_target_rid_central_management_and_properties(
    replacement: str,
) -> None:
    project = _project().replace(
        "<TargetFramework>net8.0</TargetFramework>",
        replacement,
        1,
    )
    with pytest.raises(ValueError, match="central package management, properties, and indirection"):
        parse_nuget_source_profile(project, _lock_text())


@pytest.mark.parametrize(
    "target",
    [
        "net8.0;net9.0",
        "net8.0-windows",
        "net8.0/linux-x64",
        "netstandard2.0",
        "netcoreapp3.1",
        "$(TargetFramework)",
        " net8.0",
        "net08.0",
        "net1234.0",
    ],
)
def test_project_rejects_ambiguous_or_out_of_profile_target_frameworks(
    target: str,
) -> None:
    project = _project().replace("net8.0", target, 1)
    with pytest.raises(ValueError, match="(?:one unconditional canonical|canonical non-empty text)"):
        parse_nuget_source_profile(project, _lock_text())


def test_project_rejects_duplicate_target_framework_and_multiple_property_groups() -> None:
    duplicate = _project().replace(
        "<TargetFramework>net8.0</TargetFramework>",
        "<TargetFramework>net8.0</TargetFramework><TargetFramework>net8.0</TargetFramework>",
        1,
    )
    with pytest.raises(ValueError, match="rejects conditions"):
        parse_nuget_source_profile(duplicate, _lock_text())

    multiple_groups = _project().replace(
        "  <ItemGroup>",
        "  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n  <ItemGroup>",
        1,
    )
    with pytest.raises(ValueError, match="one leading TargetFramework"):
        parse_nuget_source_profile(multiple_groups, _lock_text())


@pytest.mark.parametrize(
    "old,new,match",
    [
        ("Include=", "Update=", "Condition, Update, Remove"),
        ("Include=", "Remove=", "Condition, Update, Remove"),
        (' Version="2.1.0"', "", "literal Include and Version"),
        (
            'Version="2.1.0"',
            'Version="2.1.0" VersionOverride="2.1.0"',
            "Condition, Update, Remove",
        ),
        (
            '<PackageReference Include="Contoso.Root" Version="2.1.0" />',
            '<PackageReference Include="Contoso.Root"><Version>2.1.0</Version></PackageReference>',
            "child Version nodes",
        ),
        (
            '<PackageReference Include="Contoso.Root" Version="2.1.0" />',
            '<PackageReference Include="Contoso.Root" Version="2.1.0"><PrivateAssets>all</PrivateAssets></PackageReference>',
            "child Version nodes",
        ),
    ],
)
def test_project_rejects_update_remove_child_version_and_metadata(
    old: str,
    new: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(_project().replace(old, new, 1), _lock_text())


@pytest.mark.parametrize(
    "version",
    [
        "2.*",
        "[2.1.0]",
        "[2.0.0,3.0.0)",
        "2.1.0-alpha",
        "2.1.0+build.1",
        "2.1",
        "2.1.0.0",
        "02.1.0",
        "1234567890.1.1",
        "2.١.0",
        "$(ContosoVersion)",
    ],
)
def test_project_rejects_floating_ranges_prerelease_and_noncanonical_versions(
    version: str,
) -> None:
    project = _project().replace('Version="2.1.0"', f'Version="{version}"', 1)
    with pytest.raises(ValueError, match="exact bounded stable"):
        parse_nuget_source_profile(project, _lock_text())


@pytest.mark.parametrize(
    "package_id",
    [
        ".Contoso",
        "Contoso.",
        "Contoso..Root",
        "Contoso--Root",
        "Contoso/Root",
        "Contoso Root",
        "Cöntoso.Root",
        "A" * 101,
    ],
)
def test_project_rejects_noncanonical_package_ids(package_id: str) -> None:
    project = _project().replace("Contoso.Root", package_id, 1)
    with pytest.raises(ValueError, match="NuGet package ID"):
        parse_nuget_source_profile(project, _lock_text())


def test_package_ids_are_ascii_case_insensitive_and_collisions_refuse() -> None:
    assert canonical_nuget_package_id("Contoso_Package.Core") == "contoso_package.core"
    duplicate = _project().replace(
        '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
        '    <PackageReference Include="Contoso.Root" Version="2.1.0" />\n'
        '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
        1,
    )
    with pytest.raises(ValueError, match="duplicate or case-colliding"):
        parse_nuget_source_profile(duplicate, _lock_text())

    collision = duplicate.replace(
        'Include="Contoso.Root" Version="2.1.0" />\n'
        '    <PackageReference Include="Contoso.Root"',
        'Include="contoso.root" Version="2.1.0" />\n'
        '    <PackageReference Include="Contoso.Root"',
        1,
    )
    with pytest.raises(ValueError, match="duplicate or case-colliding"):
        parse_nuget_source_profile(collision, _lock_text())


def test_empty_item_group_and_direct_reference_cap_refuse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    empty = _project().replace(
        '    <PackageReference Include="Contoso.Root" Version="2.1.0" />\n'
        '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n',
        "",
    )
    with pytest.raises(ValueError, match="unconditional and non-empty"):
        parse_nuget_source_profile(empty, _lock_text())

    monkeypatch.setattr(nuget, "NUGET_MAX_DIRECT_REFERENCES", 1)
    with pytest.raises(ValueError, match="direct PackageReference limit"):
        parse_nuget_source_profile(_project(), _lock_text())


def test_strict_json_rejects_duplicate_keys_nonfinite_values_and_deep_nesting() -> None:
    duplicate = _lock_text().replace(
        '"version": 1,',
        '"version": 1,\n  "version": 1,',
        1,
    )
    with pytest.raises(ValueError, match="duplicate JSON key"):
        parse_nuget_source_profile(_project(), duplicate)

    nonfinite = _lock_text().replace('"version": 1', '"version": NaN', 1)
    with pytest.raises(ValueError, match="non-finite JSON constant"):
        parse_nuget_source_profile(_project(), nonfinite)

    nested = "[" * 2_000 + "]" * 2_000
    with pytest.raises(ValueError, match="nesting limit"):
        parse_nuget_source_profile(_project(), nested)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda value: value.update(version=True), "version must be integer 1"),
        (lambda value: value.update(version=2), "version must be integer 1"),
        (lambda value: value.update(extra="unsafe"), "must contain exactly"),
        (lambda value: value.update(dependencies=[]), "exactly one target framework"),
    ],
)
def test_lock_rejects_wrong_version_or_top_level_shape(mutation, match: str) -> None:
    document = _lock()
    mutation(document)
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(_project(), _dump(document))


def test_lock_requires_exactly_the_same_single_target_framework() -> None:
    document = _lock()
    document["dependencies"]["net9.0"] = copy.deepcopy(
        document["dependencies"]["net8.0"]
    )
    with pytest.raises(ValueError, match="exactly one target framework"):
        parse_nuget_source_profile(_project(), _dump(document))

    for target in ["net9.0", "net8.0/win-x64", ".NETCoreApp,Version=v8.0"]:
        document = _lock()
        graph = document["dependencies"].pop("net8.0")
        document["dependencies"][target] = graph
        with pytest.raises(ValueError, match="exactly match"):
            parse_nuget_source_profile(_project(), _dump(document))


def test_lock_direct_nodes_map_exactly_to_project_references() -> None:
    document = _lock()
    del _packages(document)["Contoso.Root"]
    with pytest.raises(ValueError, match="missing a direct project PackageReference"):
        parse_nuget_source_profile(_project(), _dump(document))

    document = _lock()
    package = _packages(document)["System.Memory"]
    package.update(type="Direct", requested="[4.5.5, )")
    with pytest.raises(ValueError, match="extra direct package"):
        parse_nuget_source_profile(_project(), _dump(document))

    for field, value in [
        ("requested", "[2.1.1, )"),
        ("resolved", "2.1.1"),
    ]:
        document = _lock()
        _packages(document)["Contoso.Root"][field] = value
        with pytest.raises(ValueError, match="does not exactly bind"):
            parse_nuget_source_profile(_project(), _dump(document))


def test_lock_matches_package_ids_case_insensitively_without_losing_source_spelling() -> None:
    document = _lock()
    packages = _packages(document)
    packages["CONTOSO.ROOT"] = packages.pop("Contoso.Root")

    result = parse_nuget_source_profile(_project(), _dump(document))

    assert result.packages["contoso.root"].package_id == "CONTOSO.ROOT"
    assert result.direct_dependencies[0].package_id == "Contoso.Root"


@pytest.mark.parametrize(
    "requested",
    [
        "2.1.0",
        "[2.1.0]",
        "[2.1.0,3.0.0)",
        "[2.1.0-alpha, )",
        "[2.*, )",
        "[02.1.0, )",
    ],
)
def test_lock_rejects_noncanonical_direct_request_serializations(requested: str) -> None:
    document = _lock()
    _packages(document)["Contoso.Root"]["requested"] = requested
    with pytest.raises(ValueError, match="canonical lock serialization"):
        parse_nuget_source_profile(_project(), _dump(document))


@pytest.mark.parametrize(
    "field,value,match",
    [
        ("resolved", "2.*", "exact bounded stable"),
        ("resolved", "[2.1.0]", "exact bounded stable"),
        ("resolved", "2.1.0-alpha", "exact bounded stable"),
        ("resolved", "2.1", "exact bounded stable"),
        ("resolved", "2.1.0.0", "exact bounded stable"),
        ("resolved", "02.1.0", "exact bounded stable"),
        ("resolved", "2.١.0", "exact bounded stable"),
        ("type", "Project", "Direct or Transitive"),
    ],
)
def test_lock_rejects_unstable_noncanonical_versions_and_package_types(
    field: str,
    value: str,
    match: str,
) -> None:
    document = _lock()
    _packages(document)["Contoso.Root"][field] = value
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(_project(), _dump(document))


@pytest.mark.parametrize(
    "version",
    ["1.*", "[1.0.0]", "1.0.0-alpha", "1.0", "1.0.0.0", "01.0.0"],
)
def test_lock_rejects_nonstable_dependency_edge_versions(version: str) -> None:
    document = _lock()
    _packages(document)["Contoso.Root"]["dependencies"]["Contoso.Common"] = version
    with pytest.raises(ValueError, match="bounded stable minimum version"):
        parse_nuget_source_profile(_project(), _dump(document))


@pytest.mark.parametrize(
    "content_hash",
    [
        None,
        "sha512-" + "A" * 88,
        "A" * 88,
        "A" * 86 + "=A",
        "A" * 85 + "===",
        "!" * 86 + "==",
    ],
)
def test_lock_rejects_noncanonical_sha512_content_hash_syntax(
    content_hash: object,
) -> None:
    document = _lock()
    _packages(document)["Contoso.Root"]["contentHash"] = content_hash
    with pytest.raises(ValueError, match="canonical base64 SHA-512 syntax"):
        parse_nuget_source_profile(_project(), _dump(document))


def test_lock_rejects_case_collisions_in_packages_and_dependency_edges() -> None:
    document = _lock()
    packages = _packages(document)
    packages["contoso.root"] = copy.deepcopy(packages["Contoso.Root"])
    with pytest.raises(ValueError, match="case-colliding package"):
        parse_nuget_source_profile(_project(), _dump(document))

    document = _lock()
    edges = _packages(document)["Contoso.Root"]["dependencies"]
    edges["contoso.common"] = "1.0.0"
    with pytest.raises(ValueError, match="case-colliding dependency edges"):
        parse_nuget_source_profile(_project(), _dump(document))


def test_lock_rejects_missing_packages_orphans_cycles_and_below_minimum_resolution() -> None:
    document = _lock()
    del _packages(document)["System.Memory"]
    with pytest.raises(ValueError, match="references a missing package"):
        parse_nuget_source_profile(_project(), _dump(document))

    document = _lock()
    _packages(document)["Contoso.Common"].pop("dependencies")
    with pytest.raises(ValueError, match="unreachable package"):
        parse_nuget_source_profile(_project(), _dump(document))

    document = _lock()
    _packages(document)["System.Memory"]["dependencies"] = {
        "Contoso.Root": "2.1.0"
    }
    with pytest.raises(ValueError, match="dependency cycle"):
        parse_nuget_source_profile(_project(), _dump(document))

    document = _lock()
    _packages(document)["Contoso.Root"]["dependencies"]["Contoso.Common"] = "2.0.0"
    with pytest.raises(ValueError, match="below the dependency edge minimum"):
        parse_nuget_source_profile(_project(), _dump(document))


@pytest.mark.parametrize(
    "mutation,match",
    [
        (
            lambda package: package.update(extra="unsafe"),
            "unknown or missing fields",
        ),
        (
            lambda package: package.pop("requested"),
            "unknown or missing fields",
        ),
        (
            lambda package: package.update(dependencies=[]),
            "dependencies must be an object",
        ),
    ],
)
def test_lock_rejects_unknown_missing_and_malformed_package_fields(
    mutation,
    match: str,
) -> None:
    document = _lock()
    mutation(_packages(document)["Contoso.Root"])
    with pytest.raises(ValueError, match=match):
        parse_nuget_source_profile(_project(), _dump(document))


def test_lock_rejects_nonobject_or_empty_package_graph() -> None:
    document = _lock()
    _packages(document)["Contoso.Root"] = []
    with pytest.raises(ValueError, match="must be an object"):
        parse_nuget_source_profile(_project(), _dump(document))

    document = _lock()
    document["dependencies"]["net8.0"] = {}
    with pytest.raises(ValueError, match="has no package graph"):
        parse_nuget_source_profile(_project(), _dump(document))


def test_lock_package_and_edge_caps_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(nuget, "NUGET_MAX_PACKAGES", 3)
    with pytest.raises(ValueError, match="package limit"):
        parse_nuget_source_profile(_project(), _lock_text())

    monkeypatch.setattr(nuget, "NUGET_MAX_PACKAGES", 20_000)
    monkeypatch.setattr(nuget, "NUGET_MAX_EDGES", 1)
    with pytest.raises(ValueError, match="dependency-edge limit"):
        parse_nuget_source_profile(_project(), _lock_text())


def _mutate(text: str, randomizer: random.Random) -> str:
    start = randomizer.randrange(len(text) + 1)
    width = randomizer.randrange(0, min(12, len(text) - start) + 1)
    insertion = "".join(
        randomizer.choice('<>{}[],:"&!?/\\\x00ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
        for _ in range(randomizer.randrange(0, 16))
    )
    return text[:start] + insertion + text[start + width :]


def test_seeded_malformed_xml_and_json_fuzz_has_no_unexpected_crashes() -> None:
    randomizer = random.Random(0xC0FFEE)
    for _ in range(256):
        mutated_project = _mutate(_project(), randomizer)
        try:
            result = parse_nuget_source_profile(mutated_project, _lock_text())
        except ValueError:
            pass
        else:
            assert isinstance(result, NuGetSourceProfile)

        mutated_lock = _mutate(_lock_text(), randomizer)
        try:
            result = parse_nuget_source_profile(_project(), mutated_lock)
        except ValueError:
            pass
        else:
            assert isinstance(result, NuGetSourceProfile)


def test_stable_version_helper_is_ascii_bounded_and_exact() -> None:
    assert stable_nuget_version("13.0.3") == (13, 0, 3)
    for value in [None, "13.0", "13.0.3.0", "13.0.3-alpha", "013.0.3", "13.٠.3"]:
        assert stable_nuget_version(value) is None
