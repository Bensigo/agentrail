from __future__ import annotations

import json

import pytest

from agentrail.dependencies.manager import (
    ADAPTER_PROFILE_IDS,
    AdapterCapability,
    CommandPlan,
    DetectionStatus,
    Ecosystem,
    GO_MODULES_ADAPTER_PROFILE,
    ManagerId,
    RepositorySnapshot,
    SupportedDetection,
    UnsupportedDetection,
    detect_dependency_manager,
    node_adapter_can_observe,
    node_adapter_capability,
    node_adapter_has_managed_execution,
)


def _detect(*paths: str) -> SupportedDetection | UnsupportedDetection:
    files = {}
    for path in paths:
        if path == "package.json":
            files[path] = json.dumps({})
        elif path == "pyproject.toml":
            if "poetry.lock" in paths:
                files[path] = "[tool.poetry]\n"
            elif "uv.lock" in paths:
                files[path] = "[tool.uv]\n"
            else:
                files[path] = ""
        else:
            files[path] = ""
    return detect_dependency_manager(RepositorySnapshot(files=files))


@pytest.mark.parametrize(
    ("files", "ecosystem", "manager", "manifest", "lockfile"),
    [
        ({"package.json", "package-lock.json"}, Ecosystem.NODE, ManagerId.NPM, "package.json", "package-lock.json"),
        ({"package.json", "pnpm-lock.yaml"}, Ecosystem.NODE, ManagerId.PNPM, "package.json", "pnpm-lock.yaml"),
        ({"pyproject.toml", "poetry.lock"}, Ecosystem.PYTHON, ManagerId.POETRY, "pyproject.toml", "poetry.lock"),
        ({"pyproject.toml", "uv.lock"}, Ecosystem.PYTHON, ManagerId.UV, "pyproject.toml", "uv.lock"),
        ({"requirements.txt"}, Ecosystem.PYTHON, ManagerId.PIP, "requirements.txt", None),
        ({"Cargo.toml", "Cargo.lock"}, Ecosystem.RUST, ManagerId.CARGO, "Cargo.toml", "Cargo.lock"),
        ({"go.mod", "go.sum"}, Ecosystem.GO, ManagerId.GO_MODULES, "go.mod", "go.sum"),
        ({"Gemfile", "Gemfile.lock"}, Ecosystem.RUBY, ManagerId.BUNDLER, "Gemfile", "Gemfile.lock"),
        ({"composer.json", "composer.lock"}, Ecosystem.PHP, ManagerId.COMPOSER, "composer.json", "composer.lock"),
        ({"pom.xml"}, Ecosystem.JAVA, ManagerId.MAVEN, "pom.xml", None),
        ({"build.gradle.kts", "gradle.lockfile"}, Ecosystem.JAVA, ManagerId.GRADLE, "build.gradle.kts", "gradle.lockfile"),
        ({"app.csproj", "packages.lock.json"}, Ecosystem.DOTNET, ManagerId.DOTNET, "app.csproj", "packages.lock.json"),
        ({"mix.exs", "mix.lock"}, Ecosystem.ELIXIR, ManagerId.MIX, "mix.exs", "mix.lock"),
        ({"pubspec.yaml", "pubspec.lock"}, Ecosystem.DART, ManagerId.PUB, "pubspec.yaml", "pubspec.lock"),
        ({"Package.swift", ".swiftpm/Package.resolved"}, Ecosystem.SWIFT, ManagerId.SPM, "Package.swift", ".swiftpm/Package.resolved"),
    ],
)
def test_detects_supported_ecosystems(files, ecosystem, manager, manifest, lockfile) -> None:
    result = _detect(*files)

    assert isinstance(result, SupportedDetection)
    assert result.status is DetectionStatus.SUPPORTED
    assert result.ecosystem is ecosystem
    assert result.manager_id is manager
    assert result.manifest_path == manifest
    assert result.lockfile_path == lockfile
    assert isinstance(result.command_plan, CommandPlan)
    assert result.command_plan.install
    assert result.command_plan.upgrade
    assert result.command_plan.verify


def test_detected_node_extension_without_lockfile_is_not_reported_as_supported() -> None:
    package_json = json.dumps({"name": "app", "packageManager": "yarn@4.2.0"})
    result = detect_dependency_manager({"package.json": package_json})

    assert isinstance(result, UnsupportedDetection)
    assert "detected" in result.reason


def test_node_package_manager_conflict_is_unsupported() -> None:
    package_json = json.dumps({"packageManager": "npm@10.0.0"})
    result = detect_dependency_manager({"package.json": package_json, "pnpm-lock.yaml": ""})

    assert isinstance(result, UnsupportedDetection)
    assert result.status is DetectionStatus.UNSUPPORTED
    assert "conflicting lockfile" in result.reason
    assert result.command_plan is None


@pytest.mark.parametrize(
    ("package_manager", "lockfile"),
    [("yarn@4.2.0", "yarn.lock"), ("bun@1.1.0", "bun.lock")],
)
def test_detected_node_extension_is_not_reported_as_supported(package_manager: str, lockfile: str) -> None:
    result = detect_dependency_manager(
        {"package.json": json.dumps({"packageManager": package_manager}), lockfile: ""}
    )

    assert isinstance(result, UnsupportedDetection)
    assert result.status is DetectionStatus.UNSUPPORTED
    assert "detected" in result.reason
    assert "unsupported" in result.reason


def test_ambiguous_or_unknown_snapshot_is_unsupported() -> None:
    ambiguous = _detect("package.json", "package-lock.json", "yarn.lock")
    unknown = _detect("README.md")

    assert isinstance(ambiguous, UnsupportedDetection)
    assert "multiple Node" in ambiguous.reason
    assert isinstance(unknown, UnsupportedDetection)
    assert unknown.ecosystem is None
    assert unknown.manager_id is None


def test_polyglot_snapshot_fails_closed() -> None:
    result = _detect("package.json", "pnpm-lock.yaml", "go.mod", "go.sum")

    assert isinstance(result, UnsupportedDetection)
    assert "multiple dependency managers" in result.reason


def test_snapshot_is_normalized_without_filesystem_access() -> None:
    result = detect_dependency_manager({"./package.json": json.dumps({"packageManager": "npm"}), "./package-lock.json": ""})

    assert isinstance(result, SupportedDetection)
    assert result.manifest_path == "package.json"
    assert result.lockfile_path == "package-lock.json"


def test_detector_rejects_normalized_alias_collision_in_both_input_orders() -> None:
    yarn = json.dumps({"packageManager": "yarn@4.2.0"})
    npm = json.dumps({"packageManager": "npm@10.8.2"})
    entries = (
        ("package.json", yarn),
        ("./package.json", npm),
        ("package-lock.json", "{}"),
    )

    for ordered in (entries, tuple(reversed(entries))):
        result = detect_dependency_manager(dict(ordered))

        assert isinstance(result, UnsupportedDetection)
        assert "path collision after normalization" in result.reason


def test_detector_rejects_absolute_and_traversal_paths() -> None:
    manifest = json.dumps({"packageManager": "npm@10.8.2"})
    for path in ("../package.json", "/package.json", "C:\\package.json"):
        result = detect_dependency_manager(
            {path: manifest, "package-lock.json": "{}"}
        )

        assert isinstance(result, UnsupportedDetection)
        assert "unsafe path" in result.reason


def test_invalid_snapshot_entry_is_typed_unsupported() -> None:
    result = detect_dependency_manager({"package.json": b"not text"})

    assert isinstance(result, UnsupportedDetection)
    assert result.status is DetectionStatus.UNSUPPORTED
    assert "not text" in result.reason


@pytest.mark.parametrize(
    "manifest",
    (
        '{"packageManager":"yarn@4.2.0","packageManager":"npm@10.8.2"}',
        '{"packageManager":"npm@10.8.2","scripts":{"test":"a","test":"b"}}',
    ),
)
def test_node_detection_rejects_duplicate_json_keys_at_any_depth(
    manifest: str,
) -> None:
    result = detect_dependency_manager(
        {"package.json": manifest, "package-lock.json": "{}"}
    )

    assert isinstance(result, UnsupportedDetection)
    assert "duplicate JSON key" in result.reason


def test_pnpm_plan_preserves_existing_frozen_lockfile_concept() -> None:
    result = _detect("package.json", "pnpm-lock.yaml")

    assert isinstance(result, SupportedDetection)
    assert result.manager_id is ManagerId.PNPM
    assert result.command_plan.install == ("pnpm", "install", "--frozen-lockfile")
    assert "{dependency}@{version}" in result.command_plan.upgrade
def test_npm_plan_disables_lifecycle_scripts_for_every_install_path() -> None:
    result = _detect("package.json", "package-lock.json")

    assert isinstance(result, SupportedDetection)
    assert result.manager_id is ManagerId.NPM
    assert result.command_plan.install == ("npm", "ci", "--ignore-scripts")
    assert result.command_plan.upgrade == (
        "npm",
        "install",
        "{dependency}@{version}",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "{save_flag}",
    )


def test_node_capability_taxonomy_separates_observation_from_execution() -> None:
    assert node_adapter_capability(ManagerId.PNPM) is AdapterCapability.MANAGED_EXECUTION
    assert node_adapter_can_observe(ManagerId.PNPM) is True
    assert node_adapter_has_managed_execution(ManagerId.PNPM) is True

    assert node_adapter_capability(ManagerId.NPM) is AdapterCapability.OBSERVATION_PROPOSAL
    assert node_adapter_can_observe(ManagerId.NPM) is True
    assert node_adapter_has_managed_execution(ManagerId.NPM) is False

    assert node_adapter_capability(ManagerId.YARN) is AdapterCapability.UNSUPPORTED
    assert node_adapter_can_observe(ManagerId.YARN) is False
    assert node_adapter_has_managed_execution(ManagerId.YARN) is False


def test_npm_shrinkwrap_is_detected_but_explicitly_unsupported() -> None:
    result = detect_dependency_manager(
        {
            "package.json": json.dumps({"packageManager": "npm@10.8.2"}),
            "npm-shrinkwrap.json": json.dumps({"lockfileVersion": 3}),
        }
    )

    assert isinstance(result, UnsupportedDetection)
    assert "npm-shrinkwrap.json" in result.reason
    assert "package-lock.json v3 only" in result.reason


def test_uv_plan_is_lock_only_and_suppresses_ambient_execution_inputs() -> None:
    result = _detect("pyproject.toml", "uv.lock")

    assert isinstance(result, SupportedDetection)
    assert result.manager_id is ManagerId.UV
    assert result.command_plan.upgrade == (
        "uv",
        "lock",
        "--no-cache",
        "--no-config",
        "--no-python-downloads",
        "--no-sources",
        "--no-build",
        "--upgrade-package",
        "{dependency}=={version}",
    )
    assert "add" not in result.command_plan.upgrade
    assert "sync" not in result.command_plan.install
    assert "run" not in result.command_plan.verify


def test_go_modules_profile_has_one_exact_lock_update_instruction_without_execution_capability() -> None:
    result = _detect("go.mod", "go.sum")

    assert GO_MODULES_ADAPTER_PROFILE == "go_1_26_root_mod_sum_public_proxy_v1"
    assert isinstance(result, SupportedDetection)
    assert result.manager_id is ManagerId.GO_MODULES
    assert result.command_plan.upgrade == (
        "go", "get", "-mod=mod", "{dependency}@{version}",
    )
    assert ("go", "go-modules") not in ADAPTER_PROFILE_IDS
    assert node_adapter_capability(ManagerId.GO_MODULES) is AdapterCapability.UNSUPPORTED
