from __future__ import annotations

import json
from typing import Dict, Optional, Sequence

from agentrail.dependencies.observation import (
    CandidatesResult,
    UnsupportedResult,
    observe_dependencies,
)
from agentrail.dependencies.pnpm import (
    DependencySnapshot,
    InsufficientEvidenceResult,
    RegistryPackage,
    TargetVersionAdapter,
)


BASELINE = "b" * 40


class Registry:
    def __init__(self, versions: Dict[str, Sequence[str]]) -> None:
        self.versions = versions
        self.calls = []

    def package_metadata(self, package: str) -> Optional[RegistryPackage]:
        self.calls.append(package)
        values = self.versions.get(package)
        return RegistryPackage(tuple(values)) if values is not None else None


class Newest(TargetVersionAdapter):
    def choose_target_version(self, package, current_version, specifier, available_versions):
        for version in reversed(tuple(available_versions)):
            if version.removeprefix("v") != current_version.removeprefix("v"):
                return version
        return current_version


def _snapshot(**files: str) -> DependencySnapshot:
    return DependencySnapshot(files=files, baseline_sha=BASELINE)


def test_npm_package_lock_dispatch_detects_candidate() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "package.json": json.dumps({"dependencies": {"lodash": "^4.17.21"}}),
                "package-lock.json": json.dumps(
                    {
                        "lockfileVersion": 3,
                        "packages": {
                            "": {"dependencies": {"lodash": "^4.17.21"}},
                            "node_modules/lodash": {"version": "4.17.21"},
                        },
                    }
                ),
            }
        ),
        registry=Registry({"lodash": ("4.17.21", "4.17.22")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    candidate = result.candidates[0]
    assert (candidate.package_manager, candidate.ecosystem) == ("npm", "node")
    assert candidate.manifest_path == "package.json"
    assert candidate.lockfile_path == "package-lock.json"


def test_poetry_dispatch_detects_candidate() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "pyproject.toml": '[tool.poetry.dependencies]\npython = ">=3.11"\nrequests = "^2.31"\n',
                "poetry.lock": '[[package]]\nname = "requests"\nversion = "2.31.0"\n',
            }
        ),
        registry=Registry({"requests": ("2.31.0", "2.32.0")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    assert result.candidates[0].package_manager == "poetry"
    assert result.candidates[0].ecosystem == "python"


def test_uv_dispatch_detects_candidate() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "pyproject.toml": '[project]\nname = "demo"\ndependencies = ["httpx>=0.27"]\n',
                "uv.lock": '[[package]]\nname = "httpx"\nversion = "0.27.0"\n',
            }
        ),
        registry=Registry({"httpx": ("0.27.0", "0.28.0")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    assert result.candidates[0].package_manager == "uv"


def test_cargo_dispatch_detects_candidate() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
                "Cargo.lock": 'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.203"\n',
            }
        ),
        registry=Registry({"serde": ("1.0.203", "1.0.204")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    assert result.candidates[0].package_manager == "cargo"
    assert result.candidates[0].manifest_path == "Cargo.toml"


def test_go_modules_dispatch_detects_candidate_and_checksum() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "go.mod": "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/acme/lib v1.2.3\n)\n",
                "go.sum": "github.com/acme/lib v1.2.3 h1:checksum\n",
            }
        ),
        registry=Registry({"github.com/acme/lib": ("v1.2.3", "v1.3.0")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    candidate = result.candidates[0]
    assert (candidate.package_manager, candidate.ecosystem) == ("go-modules", "go")
    assert candidate.current_version == "v1.2.3"


def test_missing_lockfile_is_typed_insufficient_evidence() -> None:
    result = observe_dependencies(
        _snapshot(**{"package.json": '{"dependencies":{"lodash":"^4.17.21"}}'}),
        registry=Registry({}),
        target_versions=Newest(),
    )
    assert isinstance(result, InsufficientEvidenceResult)
    assert "package-lock.json" in result.reasons[0]


def test_unsupported_declared_manager_is_typed_unsupported() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "package.json": json.dumps({"packageManager": "yarn@4.0.0", "dependencies": {"x": "1.0.0"}}),
                "yarn.lock": "",
            }
        ),
        registry=Registry({}),
        target_versions=Newest(),
    )
    assert isinstance(result, UnsupportedResult)
    assert "unsupported" not in result.reasons[0].lower() or result.reasons


def test_malformed_lockfile_fails_closed_without_registry_access() -> None:
    registry = Registry({"serde": ("1.0.0", "1.1.0")})
    result = observe_dependencies(
        _snapshot(**{"Cargo.toml": '[dependencies]\nserde = "1"\n', "Cargo.lock": "not = [valid"}),
        registry=registry,
        target_versions=Newest(),
    )
    assert isinstance(result, InsufficientEvidenceResult)
    assert registry.calls == []


def test_pnpm_is_dispatched_to_existing_detector() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "package.json": json.dumps({"dependencies": {"lodash": "^4.17.21"}}),
                "pnpm-lock.yaml": """lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.21\n        version: 4.17.21\n""",
            }
        ),
        registry=Registry({"lodash": ("4.17.21", "4.17.22")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    assert result.candidates[0].package_manager == "pnpm"
