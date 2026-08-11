from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, Optional, Sequence

from agentrail.dependencies.pnpm import (
    CandidatesResult,
    DependencySnapshot,
    InsufficientEvidenceResult,
    ObservationStatus,
    RegistryPackage,
    TargetVersionAdapter,
    UnchangedResult,
    UnsupportedResult,
    observe_pnpm_dependencies,
)


FIXTURES = Path(__file__).parent / "fixtures"
BASELINE = "a" * 40


class FakeRegistry:
    def __init__(self, versions: Dict[str, Sequence[str]]) -> None:
        self.versions = versions
        self.calls = []

    def package_metadata(self, package: str) -> Optional[RegistryPackage]:
        self.calls.append(package)
        versions = self.versions.get(package)
        return RegistryPackage(tuple(versions)) if versions is not None else None


class FirstNewVersion(TargetVersionAdapter):
    def choose_target_version(
        self,
        package: str,
        current_version: str,
        specifier: str,
        available_versions: Sequence[str],
    ) -> Optional[str]:
        for version in available_versions:
            if version != current_version:
                return version
        return current_version


def _snapshot(*, package_json: Optional[str] = None, lockfile: Optional[str] = None) -> DependencySnapshot:
    files = {
        "package.json": package_json if package_json is not None else (FIXTURES / "package.json").read_text(),
        "pnpm-lock.yaml": lockfile if lockfile is not None else (FIXTURES / "pnpm-lock.yaml").read_text(),
    }
    return DependencySnapshot(files=files, baseline_sha=BASELINE)


def test_direct_and_dev_dependencies_include_pinned_and_ranged_specs() -> None:
    registry = FakeRegistry(
        {
            "lodash": ("4.17.21", "4.17.22"),
            "react": ("18.2.0", "18.3.1"),
            "vitest": ("1.6.0", "1.6.1"),
        }
    )

    result = observe_pnpm_dependencies(
        _snapshot(),
        selected_dependencies=("vitest", "react", "lodash"),
        registry=registry,
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, CandidatesResult)
    assert result.status is ObservationStatus.CANDIDATES
    assert [(c.package, c.dependency_kind, c.specifier, c.current_version, c.target_version) for c in result.candidates] == [
        ("lodash", "dependencies", "4.17.21", "4.17.21", "4.17.22"),
        ("react", "dependencies", "^18.2.0", "18.2.0", "18.3.1"),
        ("vitest", "devDependencies", "~1.6.0", "1.6.0", "1.6.1"),
    ]
    candidate = result.candidates[0]
    assert candidate.manifest_path == "package.json"
    assert candidate.lockfile_path == "pnpm-lock.yaml"
    assert candidate.baseline_sha == BASELINE
    assert candidate.fingerprint.startswith("sha256:")
    assert len(candidate.fingerprint) == len("sha256:") + 64
    assert registry.calls == ["lodash", "react", "vitest"]


def test_identical_inputs_have_identical_fingerprints() -> None:
    registry = FakeRegistry({"lodash": ("4.17.21", "4.17.22")})
    first = observe_pnpm_dependencies(
        _snapshot(),
        selected_dependencies=("lodash",),
        registry=registry,
        target_versions=FirstNewVersion(),
    )
    second = observe_pnpm_dependencies(
        _snapshot(),
        selected_dependencies=("lodash",),
        registry=registry,
        target_versions=FirstNewVersion(),
    )

    assert isinstance(first, CandidatesResult)
    assert isinstance(second, CandidatesResult)
    assert first.candidates[0].fingerprint == second.candidates[0].fingerprint
    # Frozen #1687 producer vector: adapter custody must not rewrite the
    # heartbeat/draft candidate fingerprint already persisted by main.
    assert first.candidates[0].fingerprint == (
        "sha256:af59eab86acc638cb5a81368338233085e052e60b85ef57c26da3b6516fbdb39"
    )
    assert first.candidates[0].adapter_profile == "pnpm_lockfile_only_v1"
    assert first.candidates[0].adapter_identity_fingerprint == (
        "sha256:5a3690f2d1aa867bf62d3a5a98a0e555eb107e3666232a96ceba0df5126172b8"
    )


def test_direct_observer_rejects_unsafe_or_colliding_paths_before_registry() -> None:
    snapshot = _snapshot()
    manifest = snapshot.files["package.json"]
    lockfile = snapshot.files["pnpm-lock.yaml"]
    collision_entries = (
        ("package.json", manifest),
        ("./package.json", manifest),
        ("pnpm-lock.yaml", lockfile),
    )
    cases = (
        {"../package.json": manifest, "../pnpm-lock.yaml": lockfile},
        {"/package.json": manifest, "/pnpm-lock.yaml": lockfile},
        {"C:\\package.json": manifest, "C:\\pnpm-lock.yaml": lockfile},
        {"./../package.json": manifest, "./../pnpm-lock.yaml": lockfile},
        dict(collision_entries),
        dict(reversed(collision_entries)),
    )
    for files in cases:
        registry = FakeRegistry({"lodash": ("4.17.21", "4.17.22")})

        result = observe_pnpm_dependencies(
            DependencySnapshot(files=files, baseline_sha=BASELINE),
            selected_dependencies=("lodash",),
            registry=registry,
            target_versions=FirstNewVersion(),
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert registry.calls == []


def test_unchanged_dependency_produces_no_candidate() -> None:
    result = observe_pnpm_dependencies(
        _snapshot(),
        selected_dependencies=("react",),
        registry=FakeRegistry({"react": ("18.2.0",)}),
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, UnchangedResult)
    assert result.status is ObservationStatus.UNCHANGED
    assert result.candidates == ()


def test_malformed_manifest_returns_typed_insufficient_evidence() -> None:
    malformed = json.dumps({"dependencies": ["lodash"]})
    result = observe_pnpm_dependencies(
        _snapshot(package_json=malformed),
        selected_dependencies=("lodash",),
        registry=FakeRegistry({"lodash": ("4.17.21", "4.17.22")}),
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert result.status is ObservationStatus.INSUFFICIENT_EVIDENCE
    assert result.candidates == ()


def test_missing_lockfile_returns_insufficient_evidence_without_registry_call() -> None:
    snapshot = DependencySnapshot(
        files={"package.json": (FIXTURES / "package.json").read_text()},
        baseline_sha=BASELINE,
    )
    registry = FakeRegistry({"lodash": ("4.17.21", "4.17.22")})
    result = observe_pnpm_dependencies(
        snapshot,
        selected_dependencies=("lodash",),
        registry=registry,
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert registry.calls == []


def test_unavailable_registry_returns_insufficient_evidence_and_no_candidate() -> None:
    result = observe_pnpm_dependencies(
        _snapshot(),
        selected_dependencies=("lodash",),
        registry=FakeRegistry({}),
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert result.status is ObservationStatus.INSUFFICIENT_EVIDENCE
    assert result.candidates == ()


def test_unsupported_package_manager_returns_typed_unsupported_result() -> None:
    package_json = json.dumps({"name": "npm-app", "packageManager": "npm@10.0.0", "dependencies": {"lodash": "^4.17.0"}})
    result = observe_pnpm_dependencies(
        DependencySnapshot(
            files={
                "package.json": package_json,
                "package-lock.json": "{\"lockfileVersion\": 3}",
            },
            baseline_sha=BASELINE,
        ),
        selected_dependencies=("lodash",),
        registry=FakeRegistry({"lodash": ("4.17.21",)}),
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, UnsupportedResult)
    assert result.status is ObservationStatus.UNSUPPORTED
    assert result.candidates == ()


def test_malformed_lockfile_and_unparseable_versions_fail_closed() -> None:
    malformed_lock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lodash: {not yaml}\n"
    result = observe_pnpm_dependencies(
        _snapshot(lockfile=malformed_lock),
        selected_dependencies=("lodash",),
        registry=FakeRegistry({"lodash": ("4.17.22",)}),
        target_versions=FirstNewVersion(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert result.candidates == ()
