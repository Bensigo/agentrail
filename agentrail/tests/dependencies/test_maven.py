from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from agentrail.dependencies import maven
from agentrail.dependencies.maven import (
    MAVEN_CENTRAL_REPOSITORY,
    MAVEN_RESOLUTION_ARTIFACT_PATH,
    MAVEN_RESOLUTION_PROFILE,
    MAVEN_UNRESOLVED_EVIDENCE,
    parse_maven_source_profile,
)


FIXTURES = Path(__file__).parent / "fixtures" / "maven"


def _pom() -> str:
    return (FIXTURES / "pom.xml").read_text()


def _resolution_text() -> str:
    return (FIXTURES / MAVEN_RESOLUTION_ARTIFACT_PATH).read_text()


def _resolution() -> dict:
    return json.loads(_resolution_text())


def _dump(document: dict) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def test_parses_exact_pom_bound_complete_graph_without_authority() -> None:
    result = parse_maven_source_profile(_pom(), _resolution_text())

    assert result.profile == MAVEN_RESOLUTION_PROFILE
    assert result.resolution_artifact_path == MAVEN_RESOLUTION_ARTIFACT_PATH
    assert result.repository == MAVEN_CENTRAL_REPOSITORY
    assert result.pom_sha256 == "a26ab5daecd8854f4fc8967baf33a510bc72124184a486d39b18903ce657b642"
    assert result.root.coordinate.key == "com.example:demo:1.0.0"
    assert result.root.packaging == "jar"
    assert [(item.coordinate.key, item.scope) for item in result.direct_dependencies] == [
        ("com.fasterxml.jackson.core:jackson-databind:2.17.2", "compile")
    ]
    assert tuple(result.packages) == (
        "com.fasterxml.jackson.core:jackson-annotations:2.17.2",
        "com.fasterxml.jackson.core:jackson-core:2.17.2",
        "com.fasterxml.jackson.core:jackson-databind:2.17.2",
    )
    direct = result.packages["com.fasterxml.jackson.core:jackson-databind:2.17.2"]
    assert tuple(item.key for item in direct.dependencies) == (
        "com.fasterxml.jackson.core:jackson-annotations:2.17.2",
        "com.fasterxml.jackson.core:jackson-core:2.17.2",
    )
    assert direct.pom_url.endswith("/jackson-databind-2.17.2.pom")
    assert direct.artifact_url.endswith("/jackson-databind-2.17.2.jar")
    assert result.evidence_status == "syntax_and_custody_only"
    assert result.authority == "none"
    assert result.unresolved_evidence == MAVEN_UNRESOLVED_EVIDENCE
    assert result.unresolved_evidence == (
        "committed_root_source_inventory",
        "maven_central_pom_and_artifact_authenticity",
        "maven_runtime_resolution_reproduction",
        "target_update_selection_and_target_resolution",
    )
    assert not hasattr(result, "managed_command")
    with pytest.raises(TypeError):
        result.packages["unsafe:mutation:1.0.0"] = direct  # type: ignore[index]


def test_missing_profile_owned_resolution_artifact_refuses() -> None:
    with pytest.raises(ValueError, match="malformed"):
        parse_maven_source_profile(_pom(), "")


@pytest.mark.parametrize("value,label", [(None, "pom.xml"), (b"{}", "pom.xml")])
def test_non_text_pom_refuses(value: object, label: str) -> None:
    with pytest.raises(ValueError, match=label):
        parse_maven_source_profile(value, _resolution_text())


@pytest.mark.parametrize("value", [None, b"{}"])
def test_non_text_resolution_refuses(value: object) -> None:
    with pytest.raises(ValueError, match=MAVEN_RESOLUTION_ARTIFACT_PATH):
        parse_maven_source_profile(_pom(), value)


def test_pom_and_resolution_byte_limits_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(maven, "MAVEN_POM_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="pom.xml exceeds the byte limit"):
        parse_maven_source_profile(_pom(), _resolution_text())

    monkeypatch.setattr(maven, "MAVEN_POM_MAX_BYTES", 256 * 1024)
    monkeypatch.setattr(maven, "MAVEN_RESOLUTION_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="resolution-v1.json exceeds the byte limit"):
        parse_maven_source_profile(_pom(), _resolution_text())


@pytest.mark.parametrize(
    "declaration",
    [
        '<!DOCTYPE project [<!ENTITY x "boom">]>',
        '<!ENTITY x "boom">',
        "<![CDATA[hidden]]>",
    ],
)
def test_pom_rejects_dtd_entities_and_cdata(declaration: str) -> None:
    pom = _pom().replace("<project ", f"{declaration}\n<project ", 1)
    with pytest.raises(ValueError, match="DTD, entity, or CDATA"):
        parse_maven_source_profile(pom, _resolution_text())


@pytest.mark.parametrize(
    "declaration",
    [
        '<?xml version="9.9" encoding="UTF-8"?>',
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<?xml version="1.0"?>',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    ],
)
def test_pom_rejects_unsupported_or_non_utf8_xml_declarations(declaration: str) -> None:
    pom = _pom().replace('<?xml version="1.0" encoding="UTF-8"?>', declaration, 1)
    with pytest.raises(ValueError, match="version 1.0 with explicit UTF-8"):
        parse_maven_source_profile(pom, _resolution_text())


def test_pom_rejects_excessive_depth_and_element_count(monkeypatch: pytest.MonkeyPatch) -> None:
    namespace = 'xmlns="http://maven.apache.org/POM/4.0.0"'
    nested = f"<project {namespace}>" + ("<x>" * 8) + ("</x>" * 8) + "</project>"
    with pytest.raises(ValueError, match="depth limit"):
        parse_maven_source_profile(nested, _resolution_text())

    monkeypatch.setattr(maven, "MAVEN_XML_MAX_ELEMENTS", 4)
    elements = f"<project {namespace}><x/><x/><x/><x/></project>"
    with pytest.raises(ValueError, match="element limit"):
        parse_maven_source_profile(elements, _resolution_text())


def test_pom_rejects_foreign_namespace_and_noncanonical_schema_location() -> None:
    foreign = _pom().replace("<modelVersion>", '<modelVersion xmlns="urn:foreign">', 1)
    with pytest.raises(ValueError, match="foreign or unnamespaced"):
        parse_maven_source_profile(foreign, _resolution_text())

    schema = _pom().replace("https://maven.apache.org/xsd/maven-4.0.0.xsd", "https://example.com/pom.xsd")
    with pytest.raises(ValueError, match="non-canonical schema"):
        parse_maven_source_profile(schema, _resolution_text())


@pytest.mark.parametrize(
    "unsupported",
    [
        "<parent/>",
        "<modules><module>child</module></modules>",
        "<profiles><profile/></profiles>",
        "<properties><revision>1.0.0</revision></properties>",
        "<dependencyManagement><dependencies/></dependencyManagement>",
        "<repositories><repository><url>https://example.com</url></repository></repositories>",
        "<pluginRepositories><pluginRepository/></pluginRepositories>",
        "<build><plugins><plugin/></plugins></build>",
        "<build><extensions><extension/></extensions></build>",
        "<activation><jdk>21</jdk></activation>",
    ],
)
def test_pom_rejects_model_features_requiring_maven_evaluation(unsupported: str) -> None:
    pom = _pom().replace("  <dependencies>", f"  {unsupported}\n  <dependencies>", 1)
    with pytest.raises(ValueError, match="rejects parent, modules, profiles"):
        parse_maven_source_profile(pom, _resolution_text())


@pytest.mark.parametrize(
    "version",
    [
        "2.17.2-SNAPSHOT",
        "2.17.2.Final",
        "[2.0.0,3.0.0)",
        "LATEST",
        "RELEASE",
        "2.17.+",
        "${jackson.version}",
        "02.17.2",
        "1234567890.1.1",
        "2.١٧.2",
    ],
)
def test_pom_rejects_qualifiers_ranges_dynamic_and_unbounded_versions(version: str) -> None:
    pom = _pom().replace("<version>2.17.2</version>", f"<version>{version}</version>", 1)
    with pytest.raises(ValueError, match="exact bounded stable"):
        parse_maven_source_profile(pom, _resolution_text())


@pytest.mark.parametrize(
    "old,new,match",
    [
        ("com.fasterxml.jackson.core", "Com.Fasterxml.Jackson.Core", "lowercase ASCII"),
        ("jackson-databind", "Jackson-Databind", "lowercase ASCII"),
        ("<scope>compile</scope>", "<scope>runtime</scope>", "direct compile"),
        ("<scope>compile</scope>", "<scope>test</scope>", "direct compile"),
    ],
)
def test_pom_rejects_case_ambiguity_and_noncompile_direct_scope(old: str, new: str, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        parse_maven_source_profile(_pom().replace(old, new, 1), _resolution_text())


def test_pom_rejects_bom_type_classifier_optional_and_duplicate_coordinates() -> None:
    additions = (
        "<type>pom</type>",
        "<classifier>tests</classifier>",
        "<optional>true</optional>",
        "<exclusions/>",
    )
    for addition in additions:
        pom = _pom().replace("      <scope>compile</scope>", f"      <scope>compile</scope>\n      {addition}")
        with pytest.raises(ValueError, match="require only groupId"):
            parse_maven_source_profile(pom, _resolution_text())

    duplicate = _pom().replace(
        "  <artifactId>demo</artifactId>",
        "  <artifactId>demo</artifactId>\n  <artifactId>other</artifactId>",
    )
    with pytest.raises(ValueError, match="coordinates must be explicit"):
        parse_maven_source_profile(duplicate, _resolution_text())


def test_pom_rejects_self_dependency_and_mixed_or_attributed_text() -> None:
    self_dependency = _pom().replace(
        "com.fasterxml.jackson.core",
        "com.example",
    ).replace("jackson-databind", "demo").replace("2.17.2", "1.0.0")
    with pytest.raises(ValueError, match="own dependency"):
        parse_maven_source_profile(self_dependency, _resolution_text())

    attributed = _pom().replace("<groupId>com.example</groupId>", '<groupId source="x">com.example</groupId>')
    with pytest.raises(ValueError, match="plain text"):
        parse_maven_source_profile(attributed, _resolution_text())

    mixed = _pom().replace("  <dependencies>", "  hidden\n  <dependencies>")
    with pytest.raises(ValueError, match="mixed (?:element|trailing) text"):
        parse_maven_source_profile(mixed, _resolution_text())


def test_resolution_rejects_duplicate_keys_and_excessive_nesting() -> None:
    duplicate = _resolution_text().replace(
        '"schemaVersion": 1,',
        '"schemaVersion": 1,\n  "schemaVersion": 1,',
        1,
    )
    with pytest.raises(ValueError, match="duplicate JSON key"):
        parse_maven_source_profile(_pom(), duplicate)

    nested = "[" * 2_000 + "]" * 2_000
    with pytest.raises(ValueError, match="nesting limit"):
        parse_maven_source_profile(_pom(), nested)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda value: value.update(profile="other"), "profile is unsupported"),
        (lambda value: value.update(repository="https://repo1.maven.org/maven2"), "canonical Maven Central"),
        (lambda value: value.update(complete=False), "complete reachable graph"),
        (lambda value: value.update(schemaVersion=True), "integer 1"),
        (lambda value: value.update(extra="unsafe"), "must contain exactly"),
    ],
)
def test_resolution_rejects_wrong_profile_custom_repository_incomplete_or_unknown_shape(mutation, match: str) -> None:
    document = _resolution()
    mutation(document)
    with pytest.raises(ValueError, match=match):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_is_bound_to_exact_pom_bytes_and_root_coordinates() -> None:
    with pytest.raises(ValueError, match="exact pom.xml bytes"):
        parse_maven_source_profile(_pom() + "\n", _resolution_text())

    document = _resolution()
    document["root"]["artifactId"] = "other"
    with pytest.raises(ValueError, match="root does not match"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_direct_declaration_must_match_pom_and_current_package() -> None:
    document = _resolution()
    document["directDependencies"][0]["version"] = "2.17.1"
    with pytest.raises(ValueError, match="direct declaration does not match"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    document["packages"] = document["packages"][:-1]
    with pytest.raises(ValueError, match="does not bind the direct dependency"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_rejects_duplicate_and_multiple_package_resolutions() -> None:
    document = _resolution()
    document["packages"].append(copy.deepcopy(document["packages"][-1]))
    with pytest.raises(ValueError, match="duplicate package"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    extra = copy.deepcopy(document["packages"][0])
    extra["version"] = "2.17.1"
    extra["pom"]["url"] = extra["pom"]["url"].replace("2.17.2", "2.17.1")
    extra["artifact"]["url"] = extra["artifact"]["url"].replace("2.17.2", "2.17.1")
    document["packages"].insert(0, extra)
    with pytest.raises(ValueError, match="multiple versions"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_rejects_unsorted_packages_and_edges() -> None:
    document = _resolution()
    document["packages"][0], document["packages"][1] = document["packages"][1], document["packages"][0]
    with pytest.raises(ValueError, match="packages must be sorted"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    document["packages"][-1]["dependencies"].reverse()
    with pytest.raises(ValueError, match="not canonical and unique"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_rejects_missing_edges_orphans_duplicates_and_cycles() -> None:
    document = _resolution()
    document["packages"][-1]["dependencies"][0] = "com.example:missing:1.0.0"
    with pytest.raises(ValueError, match="missing package"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    document["packages"][-1]["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-core:2.17.2"
    ]
    with pytest.raises(ValueError, match="unreachable package"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    edge = document["packages"][-1]["dependencies"][0]
    document["packages"][-1]["dependencies"] = [edge, edge]
    with pytest.raises(ValueError, match="not canonical and unique"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    document["packages"][0]["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-databind:2.17.2"
    ]
    with pytest.raises(ValueError, match="dependency cycle"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_rejects_transitive_edge_to_source_project_root() -> None:
    document = _resolution()
    root_package = copy.deepcopy(document["packages"][0])
    root_package.update(
        groupId="com.example",
        artifactId="demo",
        version="1.0.0",
        scope="compile",
        dependencies=[],
    )
    root_package["pom"]["url"] = (
        "https://repo.maven.apache.org/maven2/com/example/demo/1.0.0/demo-1.0.0.pom"
    )
    root_package["artifact"]["url"] = (
        "https://repo.maven.apache.org/maven2/com/example/demo/1.0.0/demo-1.0.0.jar"
    )
    document["packages"].insert(0, root_package)
    document["packages"][-1]["dependencies"].insert(0, "com.example:demo:1.0.0")

    with pytest.raises(ValueError, match="source project root coordinate"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_rejects_runtime_to_compile_effective_scope_widening() -> None:
    document = _resolution()
    runtime_package = document["packages"][0]
    runtime_package["scope"] = "runtime"
    runtime_package["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-core:2.17.2"
    ]
    document["packages"][-1]["dependencies"] = [
        "com.fasterxml.jackson.core:jackson-annotations:2.17.2"
    ]

    with pytest.raises(ValueError, match="effective scope widens from runtime to compile"):
        parse_maven_source_profile(_pom(), _dump(document))


@pytest.mark.parametrize(
    "field,value,match",
    [
        ("scope", "test", "unsupported effective scope"),
        ("version", "2.17.2-SNAPSHOT", "exact bounded stable"),
        ("groupId", "Com.fasterxml.jackson.core", "lowercase ASCII"),
    ],
)
def test_resolution_rejects_unsupported_scope_qualifier_and_case_ambiguity(field: str, value: str, match: str) -> None:
    document = _resolution()
    document["packages"][0][field] = value
    with pytest.raises(ValueError, match=match):
        parse_maven_source_profile(_pom(), _dump(document))


@pytest.mark.parametrize(
    "claim,field,value,match",
    [
        ("pom", "url", "https://example.com/package.pom", "canonical Maven Central URL"),
        ("artifact", "url", "https://repo.maven.apache.org/maven2/wrong.jar", "canonical Maven Central URL"),
        ("pom", "sha512", "A" * 128, "lowercase SHA-512"),
        ("artifact", "sha512", "f" * 127, "lowercase SHA-512"),
    ],
)
def test_resolution_rejects_noncanonical_urls_and_checksum_claims(
    claim: str, field: str, value: str, match: str
) -> None:
    document = _resolution()
    document["packages"][0][claim][field] = value
    with pytest.raises(ValueError, match=match):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_rejects_arabic_digit_version_and_url() -> None:
    document = _resolution()
    document["packages"][0]["version"] = "2.١٧.2"
    with pytest.raises(ValueError, match="exact bounded stable"):
        parse_maven_source_profile(_pom(), _dump(document))

    document = _resolution()
    document["packages"][0]["pom"]["url"] = document["packages"][0]["pom"][
        "url"
    ].replace("2.17.2", "2.١٧.2")
    with pytest.raises(ValueError, match="canonical Maven Central URL"):
        parse_maven_source_profile(_pom(), _dump(document))


def test_resolution_package_and_edge_caps_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(maven, "MAVEN_RESOLUTION_MAX_PACKAGES", 2)
    with pytest.raises(ValueError, match="package limit"):
        parse_maven_source_profile(_pom(), _resolution_text())

    monkeypatch.setattr(maven, "MAVEN_RESOLUTION_MAX_PACKAGES", 20_000)
    monkeypatch.setattr(maven, "MAVEN_RESOLUTION_MAX_EDGES", 1)
    with pytest.raises(ValueError, match="dependency-edge limit"):
        parse_maven_source_profile(_pom(), _resolution_text())
