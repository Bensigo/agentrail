from __future__ import annotations

import base64

import pytest

import agentrail.dependencies.go_modules as go_modules
from agentrail.dependencies.go_modules import (
    GO_MODULES_OBSERVATION_PROFILE,
    compare_go_versions,
    go_proxy_list_url,
    go_snapshot_path_refusal,
    parse_go_mod,
    parse_go_module_files,
    parse_go_proxy_list,
    parse_go_sum,
    same_go_major_versions,
    validate_go_module_version,
    validate_go_proxy_versions,
)
from agentrail.dependencies.manager import ADAPTER_PROFILE_IDS
from agentrail.dependencies.observation import observe_dependencies
from agentrail.dependencies.pnpm import (
    CandidatesResult,
    DependencySnapshot,
    InsufficientEvidenceResult,
    RegistryPackage,
    UnchangedResult,
)


BASELINE = "a" * 40
H1 = "h1:" + base64.b64encode(b"baseline syntax only".ljust(32, b".")).decode()


def _go_mod(requirement: str, *, extra: str = "") -> str:
    return (
        "module example.com/root\n\n"
        "go 1.26\n\n"
        f"require {requirement}\n"
        f"{extra}"
    )


def _go_sum(module: str, version: str, *, module_row: bool = True, mod_row: bool = True) -> str:
    rows = []
    if module_row:
        rows.append(f"{module} {version} {H1}")
    if mod_row:
        rows.append(f"{module} {version}/go.mod {H1}")
    return "\n".join(rows) + "\n"


class Registry:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def package_metadata(self, package):
        self.calls.append(package)
        value = self.rows.get(package)
        return RegistryPackage(tuple(value)) if value is not None else None

    def package_metadata_source_url(self, package):
        return go_proxy_list_url(package)


class Newest:
    def choose_target_version(self, package, current, specifier, available):
        newer = [value for value in available if compare_go_versions(value, current) > 0]
        return max(newer, key=lambda value: tuple(map(int, value[1:].split(".")))) if newer else None


class FixedTarget:
    def __init__(self, value):
        self.value = value

    def choose_target_version(self, package, current, specifier, available):
        return self.value


def _snapshot(module: str, current: str, *, extra_files=None) -> DependencySnapshot:
    files = {
        "go.mod": _go_mod(f"{module} {current}"),
        "go.sum": _go_sum(module, current),
    }
    files.update(extra_files or {})
    return DependencySnapshot(files=files, baseline_sha=BASELINE)


def test_root_module_parser_requires_exact_direct_current_sum_rows() -> None:
    parsed = parse_go_module_files(
        _go_mod("github.com/acme/lib v1.2.3"),
        _go_sum("github.com/acme/lib", "v1.2.3"),
    )

    assert parsed.module_path == "example.com/root"
    assert parsed.go_version == "1.26"
    assert parsed.requirements["github.com/acme/lib"].version == "v1.2.3"
    assert len(parsed.sums) == 2


@pytest.mark.parametrize(
    "directive",
    (
        "replace github.com/acme/lib => ../lib",
        "exclude github.com/acme/lib v1.2.2",
        "retract v1.2.0",
        "toolchain go1.26.1",
        "tool github.com/acme/tool",
        "godebug default=go1.25",
        "unknown value",
    ),
)
def test_go_mod_refuses_unmodelled_directives(directive: str) -> None:
    with pytest.raises(ValueError, match="rejects|does not model"):
        parse_go_mod(_go_mod("github.com/acme/lib v1.2.3", extra=f"{directive}\n"))


def test_go_mod_refuses_a_direct_requirement_on_its_root_module() -> None:
    with pytest.raises(ValueError, match="own root module"):
        parse_go_mod(_go_mod("example.com/root v1.2.3"))


@pytest.mark.parametrize(
    "go_version",
    (
        f"1.{'9' * 100}",
        f"1.26.{'9' * 5_000}",
    ),
)
def test_go_language_version_components_are_bounded(go_version: str) -> None:
    text = _go_mod("github.com/acme/lib v1.2.3").replace(
        "go 1.26", f"go {go_version}"
    )
    with pytest.raises(ValueError, match="canonical Go language version"):
        parse_go_mod(text)


@pytest.mark.parametrize(
    ("requirement", "reason"),
    (
        ("github.com/acme/lib v1.2.3 // indirect", "indirect or commented"),
        ("github.com/acme/lib v1.2.3-rc.1", "stable"),
        ("github.com/acme/lib v0.0.0-20260101000000-abcdefabcdef", "stable"),
        ("github.com/acme/lib v1.2.x", "stable"),
        ("github.com/acme/lib ^v1.2.3", "stable"),
        ("github.com/Acme/lib v1.2.3", "lowercase"),
        ("github.com/acme/lib v2.0.0", "missing its semantic /vN"),
        ("github.com/acme/lib/v2 v1.2.3", "does not match"),
        ("github.com/acme/lib/v1 v1.2.3", "below the supported major"),
        ("github.com/acme/lib/v2.0 v1.2.3", "numeric-looking"),
        ("github.com/acme/lib/v01 v1.2.3", "numeric-looking"),
    ),
)
def test_go_mod_refuses_unsupported_requirement_shapes(requirement: str, reason: str) -> None:
    with pytest.raises(ValueError, match=reason):
        parse_go_mod(_go_mod(requirement))


def test_semantic_import_version_accepts_standard_and_gopkg_major_forms() -> None:
    assert validate_go_module_version("github.com/acme/lib/v2", "v2.4.1") is None
    assert validate_go_module_version("gopkg.in/yaml.v3", "v3.0.1") is None
    assert "does not match" in (
        validate_go_module_version("gopkg.in/yaml.v3", "v2.4.1") or ""
    )
    assert "must end" in (
        validate_go_module_version("gopkg.in/yaml", "v1.0.0") or ""
    )


@pytest.mark.parametrize(
    "module",
    (
        "localhost/acme/lib",
        "internal.local/acme/lib",
        "127.0.0.1/acme/lib",
        "github.com/acme/../lib",
        "github.com/acme/lib.git",
        "github.com/acme/con",
        "con.example.com/acme/lib",
        "github.com/acme/foo~1",
        f"{'a' * 64}.example.com/acme/lib",
    ),
)
def test_module_paths_refuse_local_private_or_ambiguous_identities(module: str) -> None:
    with pytest.raises(ValueError):
        parse_go_mod(_go_mod(f"{module} v1.2.3"))


@pytest.mark.parametrize("digits", (100, 5_000))
def test_go_version_components_are_bounded_before_integer_conversion(digits: int) -> None:
    version = f"v{'9' * digits}.0.0"

    with pytest.raises(ValueError, match="stable"):
        parse_go_mod(_go_mod(f"github.com/acme/lib {version}"))
    with pytest.raises(ValueError, match="unsupported release"):
        parse_go_proxy_list("github.com/acme/lib", f"{version}\n")


@pytest.mark.parametrize(
    "checksum",
    (
        "h1:not-base64",
        "h1:" + base64.b64encode(b"x" * 31).decode(),
        "h1:" + base64.b64encode(b"x" * 33).decode(),
        "sha256:" + "a" * 64,
    ),
)
def test_go_sum_refuses_noncanonical_h1_syntax_or_length(checksum: str) -> None:
    with pytest.raises(ValueError, match="h1 checksum syntax"):
        parse_go_sum(f"github.com/acme/lib v1.2.3 {checksum}\n")


@pytest.mark.parametrize(("module_row", "mod_row", "missing"), ((False, True, "module"), (True, False, "go.mod")))
def test_go_sum_requires_both_current_syntax_rows(module_row: bool, mod_row: bool, missing: str) -> None:
    with pytest.raises(ValueError, match=f"missing {missing}"):
        parse_go_module_files(
            _go_mod("github.com/acme/lib v1.2.3"),
            _go_sum(
                "github.com/acme/lib",
                "v1.2.3",
                module_row=module_row,
                mod_row=mod_row,
            ),
        )


def test_go_sum_refuses_duplicate_rows() -> None:
    row = f"github.com/acme/lib v1.2.3 {H1}\n"
    with pytest.raises(ValueError, match="duplicate checksum rows"):
        parse_go_sum(row + row)


@pytest.mark.parametrize(
    ("path", "reason"),
    (
        ("go.work", "go.work"),
        ("GO.WORK", "go.work"),
        ("tools/go.work.sum", "go.work"),
        ("nested/go.mod", "nested"),
        ("nested/GO.MOD", "nested"),
        ("nested/go.sum", "nested"),
        ("vendor/modules.txt", "vendored"),
        ("Vendor/modules.txt", "vendored"),
        (".netrc", "configuration"),
        (".NETRC", "configuration"),
        (".gitconfig", "configuration"),
        (".config/go/env", "configuration"),
        (".Config/Go/Env", "configuration"),
        ("go.env", "configuration"),
    ),
)
def test_supplied_workspace_module_and_config_paths_fail_closed(path: str, reason: str) -> None:
    assert reason in (go_snapshot_path_refusal(("go.mod", "go.sum", path)) or "")


def test_supplied_case_colliding_paths_fail_closed() -> None:
    refusal = go_snapshot_path_refusal(("go.mod", "go.sum", "Nested/go.mod", "nested/GO.MOD"))
    assert refusal is not None
    assert "case-ambiguous" in refusal or "nested" in refusal


def test_manifest_dependency_and_sum_row_caps(monkeypatch) -> None:
    monkeypatch.setattr(go_modules, "GO_MOD_MAX_BYTES", 16)
    with pytest.raises(ValueError, match="go.mod exceeds the byte limit"):
        parse_go_mod(_go_mod("github.com/acme/lib v1.2.3"))

    monkeypatch.setattr(go_modules, "GO_MOD_MAX_BYTES", 256 * 1024)
    monkeypatch.setattr(go_modules, "GO_MAX_DIRECT_REQUIREMENTS", 1)
    with pytest.raises(ValueError, match="direct-requirement limit"):
        parse_go_mod(
            _go_mod(
                "github.com/acme/one v1.0.0",
                extra="require github.com/acme/two v1.0.0\n",
            )
        )

    monkeypatch.setattr(go_modules, "GO_SUM_MAX_ROWS", 1)
    with pytest.raises(ValueError, match="row limit"):
        parse_go_sum(_go_sum("github.com/acme/lib", "v1.2.3"))


def test_sum_file_byte_cap(monkeypatch) -> None:
    monkeypatch.setattr(go_modules, "GO_SUM_MAX_BYTES", 8)
    with pytest.raises(ValueError, match="go.sum exceeds the byte limit"):
        parse_go_sum(_go_sum("github.com/acme/lib", "v1.2.3"))


def test_proxy_url_and_rows_are_exact_bounded_and_duplicate_free(monkeypatch) -> None:
    assert (
        go_proxy_list_url("github.com/acme/lib/v2")
        == "https://proxy.golang.org/github.com/acme/lib/v2/@v/list"
    )
    assert parse_go_proxy_list("github.com/acme/lib", "v1.2.3\nv1.3.0\n") == (
        "v1.2.3",
        "v1.3.0",
    )
    with pytest.raises(ValueError, match="duplicate release"):
        parse_go_proxy_list("github.com/acme/lib", "v1.2.3\nv1.2.3\n")
    with pytest.raises(ValueError, match="malformed row"):
        parse_go_proxy_list("github.com/acme/lib", "v1.2.3\n\nv1.3.0\n")
    with pytest.raises(ValueError, match="unsupported release"):
        parse_go_proxy_list("github.com/acme/lib", "v1.3.0-rc.1\n")

    monkeypatch.setattr(go_modules, "GO_PROXY_LIST_MAX_VERSIONS", 1)
    with pytest.raises(ValueError, match="release-row limit"):
        validate_go_proxy_versions("github.com/acme/lib", ("v1.2.3", "v1.3.0"))


def test_proxy_response_byte_cap(monkeypatch) -> None:
    monkeypatch.setattr(go_modules, "GO_PROXY_LIST_MAX_BYTES", 4)
    with pytest.raises(ValueError, match="byte limit"):
        parse_go_proxy_list("github.com/acme/lib", "v1.2.3\n")


def test_observer_requires_exact_current_proxy_membership_before_candidate() -> None:
    registry = Registry({"github.com/acme/lib": ("v1.2.2", "v1.3.0")})
    result = observe_dependencies(
        _snapshot("github.com/acme/lib", "v1.2.3"),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "exact locked current version" in result.reasons[0]


def test_observer_refuses_unbound_or_noncanonical_go_registry_source_before_metadata() -> None:
    class UnboundRegistry:
        def __init__(self, source=None):
            self.source = source
            self.calls = []

        def package_metadata_source_url(self, package):
            if self.source is None:
                raise ValueError("source receipt missing")
            return self.source

        def package_metadata(self, package):
            self.calls.append(package)
            return RegistryPackage(("v1.2.3", "v1.3.0"))

    for registry in (
        UnboundRegistry(),
        UnboundRegistry("https://private.example.invalid/github.com/acme/lib/@v/list"),
    ):
        result = observe_dependencies(
            _snapshot("github.com/acme/lib", "v1.2.3"),
            registry=registry,
            target_versions=Newest(),
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "Go registry source identity" in result.reasons[0]
        assert registry.calls == []


def test_observer_refuses_registry_without_a_go_source_identity_method() -> None:
    class MissingSourceRegistry:
        def __init__(self):
            self.calls = []

        def package_metadata(self, package):
            self.calls.append(package)
            return RegistryPackage(("v1.2.3", "v1.3.0"))

    registry = MissingSourceRegistry()
    result = observe_dependencies(
        _snapshot("github.com/acme/lib", "v1.2.3"),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "source identity" in result.reasons[0]
    assert registry.calls == []


@pytest.mark.parametrize(
    "rows",
    (
        ("v1.2.3", "v1.2.3"),
        ("v1.2.3", "v1.3.0-rc.1"),
        ("v1.2.3", "v0.0.0-20260101000000-abcdefabcdef"),
    ),
)
def test_observer_refuses_duplicate_or_unsupported_proxy_rows(rows) -> None:
    result = observe_dependencies(
        _snapshot("github.com/acme/lib", "v1.2.3"),
        registry=Registry({"github.com/acme/lib": rows}),
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "Go proxy data" in result.reasons[0]


def test_observer_selects_only_stable_same_major_go_candidate() -> None:
    result = observe_dependencies(
        _snapshot("github.com/acme/lib", "v1.2.3"),
        registry=Registry(
            {"github.com/acme/lib": ("v0.9.0", "v1.2.3", "v1.4.0")}
        ),
        target_versions=Newest(),
    )

    assert isinstance(result, CandidatesResult)
    assert result.candidates[0].target_version == "v1.4.0"
    assert result.candidates[0].adapter_profile is None


def test_observer_does_not_cross_major_for_unsuffixed_module() -> None:
    result = observe_dependencies(
        _snapshot("github.com/acme/lib", "v0.2.0"),
        registry=Registry({"github.com/acme/lib": ("v0.2.0", "v1.0.0")}),
        target_versions=Newest(),
    )

    assert isinstance(result, UnchangedResult)


def test_observer_refuses_target_selector_output_outside_same_major_rows() -> None:
    result = observe_dependencies(
        _snapshot("github.com/acme/lib", "v0.2.0"),
        registry=Registry(
            {"github.com/acme/lib": ("v0.2.0", "v0.3.0", "v1.0.0")}
        ),
        target_versions=FixedTarget("v1.0.0"),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "target version" in result.reasons[0]


def test_go_observation_profile_is_not_an_accepted_python_adapter() -> None:
    assert GO_MODULES_OBSERVATION_PROFILE not in ADAPTER_PROFILE_IDS.values()


def test_same_major_helper_preserves_proxy_row_identity() -> None:
    assert same_go_major_versions(
        "v1.2.3", ("v0.9.0", "v1.2.3", "v1.4.0")
    ) == ("v1.2.3", "v1.4.0")
