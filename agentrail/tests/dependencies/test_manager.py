from __future__ import annotations

import json

import pytest

from agentrail.dependencies.manager import (
    CommandPlan,
    DetectionStatus,
    Ecosystem,
    ManagerId,
    RepositorySnapshot,
    SupportedDetection,
    UnsupportedDetection,
    detect_dependency_manager,
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
        ({"package.json", "yarn.lock"}, Ecosystem.NODE, ManagerId.YARN, "package.json", "yarn.lock"),
        ({"package.json", "bun.lock"}, Ecosystem.NODE, ManagerId.BUN, "package.json", "bun.lock"),
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


def test_node_package_manager_field_selects_manager_without_lockfile() -> None:
    package_json = json.dumps({"name": "app", "packageManager": "yarn@4.2.0"})
    result = detect_dependency_manager({"package.json": package_json})

    assert isinstance(result, SupportedDetection)
    assert result.manager_id is ManagerId.YARN
    assert result.lockfile_path is None


def test_node_package_manager_conflict_is_unsupported() -> None:
    package_json = json.dumps({"packageManager": "npm@10.0.0"})
    result = detect_dependency_manager({"package.json": package_json, "pnpm-lock.yaml": ""})

    assert isinstance(result, UnsupportedDetection)
    assert result.status is DetectionStatus.UNSUPPORTED
    assert "conflicting lockfile" in result.reason
    assert result.command_plan is None


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


def test_invalid_snapshot_entry_is_typed_unsupported() -> None:
    result = detect_dependency_manager({"package.json": b"not text"})

    assert isinstance(result, UnsupportedDetection)
    assert result.status is DetectionStatus.UNSUPPORTED
    assert "not text" in result.reason


def test_pnpm_plan_preserves_existing_frozen_lockfile_concept() -> None:
    result = _detect("package.json", "pnpm-lock.yaml")

    assert isinstance(result, SupportedDetection)
    assert result.manager_id is ManagerId.PNPM
    assert result.command_plan.install == ("pnpm", "install", "--frozen-lockfile")
    assert "{dependency}@{version}" in result.command_plan.upgrade


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
