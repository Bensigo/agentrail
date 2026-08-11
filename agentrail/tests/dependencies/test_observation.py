from __future__ import annotations

import json
from typing import Dict, Optional, Sequence

import pytest

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
    UnchangedResult,
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


def _uv_files(
    *,
    requirement: str = "httpx>=0.27.0",
    package_source: str = 'source = { registry = "https://pypi.org/simple" }',
    package_version: str = "0.27.0",
    package_hash: str = "a" * 64,
    manifest_extra: str = "",
    lock_extra: str = "",
) -> Dict[str, str]:
    return {
        "pyproject.toml": (
            '[project]\nname = "demo"\nversion = "1.0.0"\n'
            'requires-python = ">=3.12.0,<3.13.0"\n'
            f'dependencies = ["{requirement}"]\n'
            f"{manifest_extra}"
        ),
        "uv.lock": (
            'version = 1\nrevision = 3\nrequires-python = ">=3.12.0,<3.13.0"\n\n'
            '[[package]]\nname = "demo"\nversion = "1.0.0"\n'
            'source = { virtual = "." }\ndependencies = [{ name = "httpx" }]\n\n'
            f'[[package]]\nname = "httpx"\nversion = "{package_version}"\n'
            f"{package_source}\n"
            'wheels = [{ url = "https://files.pythonhosted.org/packages/httpx.whl", '
            f'hash = "sha256:{package_hash}", size = 123 }}]\n'
            f"{lock_extra}"
        ),
    }


def test_npm_package_lock_dispatch_detects_candidate() -> None:
    result = observe_dependencies(
        _snapshot(
            **{
                "package.json": json.dumps(
                    {
                        "packageManager": "npm@10.8.2",
                        "scripts": {"test": "node --test"},
                        "dependencies": {"lodash": "^4.17.21"},
                    }
                ),
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
    assert candidate.manager_commands["install"] == "npm ci --ignore-scripts"
    assert candidate.manager_commands["update"] == (
        "npm install lodash@4.17.22 --package-lock-only --ignore-scripts "
        "--no-audit --save-prod"
    )
    assert candidate.verification_commands == ("npm test",)


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
        _snapshot(**_uv_files()),
        registry=Registry({"httpx": ("0.27.0", "0.28.0rc1", "0.28.0")}),
        target_versions=Newest(),
    )
    assert isinstance(result, CandidatesResult)
    candidate = result.candidates[0]
    assert candidate.package_manager == "uv"
    assert candidate.ecosystem == "python"
    assert candidate.dependency_kind == "dependencies"
    assert candidate.specifier == ">=0.27.0"
    assert candidate.target_version == "0.28.0"
    assert candidate.manager_commands["update"] == (
        "uv lock --no-cache --no-config --no-python-downloads --no-sources "
        "--no-build --upgrade-package httpx==0.28.0"
    )


@pytest.mark.parametrize(
    ("files", "reason"),
    [
        (_uv_files(requirement="HTTP_X>=0.27.0"), "canonical name"),
        (_uv_files(requirement="httpx[http2]>=0.27.0"), "canonical name"),
        (_uv_files(requirement="httpx>=0.27.0; python_version >= '3.12'"), "canonical name"),
        (_uv_files(requirement="httpx @ https://example.com/httpx.whl"), "canonical name"),
        (_uv_files(requirement="httpx>=0.27"), "canonical name"),
        (
            _uv_files(package_source='source = { registry = "https://packages.example/simple" }'),
            "non-PyPI source",
        ),
        (_uv_files(package_hash="b" * 63), "distribution hashes"),
        (_uv_files(manifest_extra='[project.optional-dependencies]\nextra = ["rich>=1.0.0"]\n'), "optional"),
        (_uv_files(manifest_extra='[tool.uv]\nindex-url = "https://example.com/simple"\n'), "configuration"),
        (_uv_files(lock_extra='\n[[package]]\nname = "httpx"\nversion = "0.26.0"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{ url = "https://files.pythonhosted.org/packages/httpx-old.whl", hash = "sha256:' + "c" * 64 + '", size = 123 }]\n'), "exactly one"),
    ],
)
def test_uv_v1_rejects_ambiguous_or_non_registry_custody(files, reason) -> None:
    registry = Registry({"httpx": ("0.27.0", "0.28.0")})

    result = observe_dependencies(
        _snapshot(**files),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert reason in result.reasons[0]
    assert registry.calls == []


def test_uv_v1_rejects_lock_and_manifest_python_range_drift() -> None:
    files = _uv_files()
    files["uv.lock"] = files["uv.lock"].replace(
        'requires-python = ">=3.12.0,<3.13.0"',
        'requires-python = ">=3.11.0,<3.12.0"',
    )
    registry = Registry({"httpx": ("0.27.0", "0.28.0")})

    result = observe_dependencies(
        _snapshot(**files),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "requires-python disagree" in result.reasons[0]
    assert registry.calls == []


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


def _npm_snapshot(
    specifier: str = "^4.17.21",
    *,
    lockfile_version: int = 3,
    dependency_kind: str = "dependencies",
    package: str = "lodash",
    current_version: str = "4.17.21",
) -> DependencySnapshot:
    return _snapshot(
        **{
            "package.json": json.dumps(
                {
                    "packageManager": "npm@10.8.2",
                    "scripts": {"test": "node --test"},
                    dependency_kind: {package: specifier},
                }
            ),
            "package-lock.json": json.dumps(
                {
                    "lockfileVersion": lockfile_version,
                    "packages": {
                        "": {dependency_kind: {package: specifier}},
                        f"node_modules/{package}": {"version": current_version},
                    },
                }
            ),
        }
    )


def test_npm_observation_preserves_each_admitted_manifest_kind_and_save_flag() -> None:
    cases = (
        ("dependencies", "--save-prod"),
        ("devDependencies", "--save-dev"),
        ("optionalDependencies", "--save-optional"),
        ("peerDependencies", "--save-peer"),
    )
    for dependency_kind, save_flag in cases:
        result = observe_dependencies(
            _npm_snapshot(dependency_kind=dependency_kind),
            registry=Registry({"lodash": ("4.17.21", "4.17.22")}),
            target_versions=Newest(),
        )

        assert isinstance(result, CandidatesResult)
        candidate = result.candidates[0]
        assert candidate.dependency_kind == dependency_kind
        assert candidate.manager_commands["update"] == (
            "npm install lodash@4.17.22 --package-lock-only --ignore-scripts "
            f"--no-audit {save_flag}"
        )


def test_npm_observation_does_not_admit_build_dependencies() -> None:
    result = observe_dependencies(
        _npm_snapshot(dependency_kind="buildDependencies"),
        selected_dependencies=("lodash",),
        registry=Registry({"lodash": ("4.17.21", "4.17.22")}),
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "not declared" in result.reasons[0]


def test_npm_observation_refuses_unsafe_package_names_before_registry_access() -> None:
    for package in ("Lodash", "--force", "@Acme/widget", "@acme", "@/widget", "@acme/Widget"):
        registry = Registry({package: ("4.17.21", "4.17.22")})
        result = observe_dependencies(
            _npm_snapshot(package=package),
            registry=registry,
            target_versions=Newest(),
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "npm package name" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_rejects_duplicate_json_keys_at_every_depth() -> None:
    valid_manifest = (
        '{"packageManager":"npm@10.8.2","scripts":{"test":"node --test"},'
        '"dependencies":{"lodash":"^4.17.21"}}'
    )
    valid_lock = (
        '{"lockfileVersion":3,"packages":{"":{"dependencies":'
        '{"lodash":"^4.17.21"}},"node_modules/lodash":{"version":"4.17.21"}}}'
    )
    cases = (
        (
            '{"packageManager":"npm@10.8.2","packageManager":"npm@10.8.2",'
            '"scripts":{"test":"node --test"},"dependencies":'
            '{"lodash":"^4.17.21"}}',
            valid_lock,
        ),
        (
            '{"packageManager":"npm@10.8.2","scripts":{"test":"node --test"},'
            '"dependencies":{"lodash":"^4.17.21","lodash":"^4.17.20"}}',
            valid_lock,
        ),
        (
            valid_manifest,
            '{"lockfileVersion":3,"lockfileVersion":3,"packages":{"":'
            '{"dependencies":{"lodash":"^4.17.21"}},"node_modules/lodash":'
            '{"version":"4.17.21"}}}',
        ),
        (
            valid_manifest,
            '{"lockfileVersion":3,"packages":{"":{"dependencies":'
            '{"lodash":"^4.17.21"}},"node_modules/lodash":'
            '{"version":"4.17.21"},"node_modules/lodash":'
            '{"version":"4.17.20"}}}',
        ),
    )
    for manifest, lockfile in cases:
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})
        result = observe_dependencies(
            _snapshot(**{"package.json": manifest, "package-lock.json": lockfile}),
            registry=registry,
            target_versions=Newest(),
        )

        assert isinstance(result, (InsufficientEvidenceResult, UnsupportedResult))
        assert "duplicate JSON key" in result.reasons[0]
        assert registry.calls == []


def test_explicit_npm_observation_rejects_unsafe_or_colliding_snapshot_paths() -> None:
    snapshot = _npm_snapshot()
    manifest = snapshot.files["package.json"]
    lockfile = snapshot.files["package-lock.json"]
    cases = (
        {"../package.json": manifest, "package-lock.json": lockfile},
        {"/package.json": manifest, "package-lock.json": lockfile},
        {"C:\\package.json": manifest, "package-lock.json": lockfile},
        {
            "package.json": manifest,
            "./package.json": manifest,
            "package-lock.json": lockfile,
        },
    )
    for files in cases:
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})

        result = observe_dependencies(
            DependencySnapshot(files=files, baseline_sha=BASELINE),
            registry=registry,
            target_versions=Newest(),
            manager="npm",
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "snapshot paths are invalid" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_rejects_non_finite_manifest_and_lock_json() -> None:
    valid_manifest = (
        '{"packageManager":"npm@10.8.2","scripts":{"test":"node --test"},'
        '"dependencies":{"lodash":"^4.17.21"}}'
    )
    valid_lock = (
        '{"lockfileVersion":3,"packages":{"":{"dependencies":'
        '{"lodash":"^4.17.21"}},"node_modules/lodash":{"version":"4.17.21"}}}'
    )
    cases = (
        (
            valid_manifest.replace('"^4.17.21"', "NaN"),
            valid_lock,
        ),
        (
            valid_manifest,
            valid_lock.replace('"lockfileVersion":3', '"lockfileVersion":Infinity'),
        ),
    )
    for manifest, lockfile in cases:
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})

        result = observe_dependencies(
            _snapshot(**{"package.json": manifest, "package-lock.json": lockfile}),
            registry=registry,
            target_versions=Newest(),
            manager="npm",
        )

        assert isinstance(result, (InsufficientEvidenceResult, UnsupportedResult))
        assert "non-finite JSON constant" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_requires_complete_manifest_lock_root_identity() -> None:
    manifest = {
        "packageManager": "npm@10.8.2",
        "scripts": {"test": "node --test"},
        "dependencies": {"lodash": "^4.17.21", "helper": "^1.0.0"},
    }
    lockfile = {
        "lockfileVersion": 3,
        "packages": {
            "": {
                "dependencies": {"lodash": "^4.17.21", "helper": "^1.0.0"},
            },
            "node_modules/lodash": {"version": "4.17.21"},
            "node_modules/helper": {"version": "1.0.0"},
        },
    }
    cases = []

    missing = (json.loads(json.dumps(manifest)), json.loads(json.dumps(lockfile)))
    del missing[1]["packages"][""]["dependencies"]["helper"]
    cases.append(missing)

    extra = (json.loads(json.dumps(manifest)), json.loads(json.dumps(lockfile)))
    del extra[0]["dependencies"]["helper"]
    cases.append(extra)

    moved = (json.loads(json.dumps(manifest)), json.loads(json.dumps(lockfile)))
    del moved[0]["dependencies"]["helper"]
    moved[0]["devDependencies"] = {"helper": "^1.0.0"}
    cases.append(moved)

    for manifest_data, lock_data in cases:
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})

        result = observe_dependencies(
            _snapshot(
                **{
                    "package.json": json.dumps(manifest_data),
                    "package-lock.json": json.dumps(lock_data),
                }
            ),
            selected_dependencies=("lodash",),
            registry=registry,
            target_versions=Newest(),
            manager="npm",
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "direct dependency maps do not exactly match" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_refuses_case_insensitive_unsafe_and_alias_specifiers() -> None:
    for specifier in ("NPM:other@1.0.0", "FILE:../local", "HTTPS://mirror.invalid/pkg.tgz"):
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})
        result = observe_dependencies(
            _npm_snapshot(specifier), registry=registry, target_versions=Newest()
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "unsupported local or alias specifier" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_requires_exact_semver_and_accepts_canonical_scoped_name() -> None:
    invalid_current_registry = Registry({"lodash": ("v4.17.21", "4.17.22")})
    invalid_current = observe_dependencies(
        _npm_snapshot(current_version="v4.17.21"),
        registry=invalid_current_registry,
        target_versions=Newest(),
    )
    assert isinstance(invalid_current, InsufficientEvidenceResult)
    assert "exact semver" in invalid_current.reasons[0]
    assert invalid_current_registry.calls == []

    scoped = observe_dependencies(
        _npm_snapshot(package="@acme/widget"),
        registry=Registry({"@acme/widget": ("4.17.21", "4.17.22")}),
        target_versions=Newest(),
    )
    assert isinstance(scoped, CandidatesResult)
    assert scoped.candidates[0].package == "@acme/widget"
    assert scoped.candidates[0].adapter_profile == "npm_package_lock_only_v1"


def test_npm_comparator_range_filters_out_an_incompatible_latest_version() -> None:
    result = observe_dependencies(
        _npm_snapshot(">=4.17.21 <5.0.0"),
        registry=Registry({"lodash": ("4.17.21", "4.17.22", "5.0.0")}),
        target_versions=Newest(),
    )

    assert isinstance(result, CandidatesResult)
    assert result.candidates[0].target_version == "4.17.22"


def test_npm_supported_ranges_constrain_target_selection() -> None:
    cases = (
        ("~4.17.21", ("4.17.21", "4.17.22", "4.18.0"), "4.17.22"),
        ("4.17.x", ("4.17.21", "4.17.22", "4.18.0"), "4.17.22"),
        ("4.17.21 - 4.17.30", ("4.17.21", "4.17.30", "4.17.31"), "4.17.30"),
        ("^3.0.0 || ^4.17.21", ("4.17.21", "4.17.22", "5.0.0"), "4.17.22"),
    )
    for specifier, available, expected in cases:
        result = observe_dependencies(
            _npm_snapshot(specifier),
            registry=Registry({"lodash": available}),
            target_versions=Newest(),
        )

        assert isinstance(result, CandidatesResult)
        assert result.candidates[0].target_version == expected


def test_npm_exact_constraint_is_unchanged_instead_of_widened() -> None:
    result = observe_dependencies(
        _npm_snapshot("4.17.21"),
        registry=Registry({"lodash": ("4.17.21", "4.17.22")}),
        target_versions=Newest(),
    )

    assert isinstance(result, UnchangedResult)


def test_unsupported_npm_range_refuses_before_registry_access() -> None:
    for specifier in ("latest", "^4.17.21 || latest"):
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})
        result = observe_dependencies(
            _npm_snapshot(specifier), registry=registry, target_versions=Newest()
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "unsupported npm semver constraint" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_requires_a_repository_declared_test_command() -> None:
    snapshot = _npm_snapshot()
    files = dict(snapshot.files)
    package = json.loads(files["package.json"])
    package["scripts"] = {}
    files["package.json"] = json.dumps(package)
    registry = Registry({"lodash": ("4.17.21", "4.17.22")})

    result = observe_dependencies(
        DependencySnapshot(files=files, baseline_sha=BASELINE),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "non-empty test script" in result.reasons[0]
    assert registry.calls == []


def test_npm_observation_requires_an_exact_repository_manager_pin() -> None:
    snapshot = _npm_snapshot()
    files = dict(snapshot.files)
    package = json.loads(files["package.json"])
    package["packageManager"] = "npm"
    files["package.json"] = json.dumps(package)
    registry = Registry({"lodash": ("4.17.21", "4.17.22")})

    result = observe_dependencies(
        DependencySnapshot(files=files, baseline_sha=BASELINE),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "exact npm@x.y.z" in result.reasons[0]
    assert registry.calls == []


def test_explicit_npm_selection_rejects_yarn_and_bun_declarations_without_fallback() -> None:
    registry = Registry({"lodash": ("4.17.21", "4.17.22")})
    for declaration in ("yarn@4.5.0", "bun@1.1.0"):
        snapshot = _npm_snapshot()
        files = dict(snapshot.files)
        files["package.json"] = json.dumps(
            {
                "packageManager": declaration,
                "scripts": {"test": "node --test"},
                "dependencies": {"lodash": "^4.17.21"},
            }
        )
        result = observe_dependencies(
            DependencySnapshot(files=files, baseline_sha=BASELINE),
            manager="npm",
            registry=registry,
            target_versions=Newest(),
        )

        assert isinstance(result, UnsupportedResult)
        assert "explicit npm selection conflicts" in result.reasons[0]
    assert registry.calls == []


def test_explicit_npm_selection_rejects_alternate_node_lockfiles() -> None:
    for lockfile in ("yarn.lock", "bun.lock"):
        snapshot = _npm_snapshot()
        result = observe_dependencies(
            DependencySnapshot(
                files={**snapshot.files, lockfile: ""}, baseline_sha=BASELINE
            ),
            manager="npm",
            registry=Registry({}),
            target_versions=Newest(),
        )

        assert isinstance(result, UnsupportedResult)
        assert lockfile in result.reasons[0]


def test_npm_package_lock_v1_and_v2_are_narrowly_refused() -> None:
    for version in (1, 2):
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})
        result = observe_dependencies(
            _npm_snapshot(lockfile_version=version),
            registry=registry,
            target_versions=Newest(),
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "lockfileVersion 3 only" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_refuses_workspace_and_nonflat_lock_graphs_before_registry() -> None:
    cases = (
        "manifest-workspaces",
        "lock-root-workspaces",
        "workspace-location",
        "nested-location",
        "non-package-subpath",
    )
    for case in cases:
        snapshot = _npm_snapshot()
        files = dict(snapshot.files)
        manifest = json.loads(files["package.json"])
        lock = json.loads(files["package-lock.json"])
        if case == "manifest-workspaces":
            manifest["workspaces"] = ["packages/*"]
        elif case == "lock-root-workspaces":
            lock["packages"][""]["workspaces"] = ["packages/*"]
        elif case == "workspace-location":
            lock["packages"]["packages/helper"] = {"version": "1.0.0"}
        elif case == "nested-location":
            lock["packages"]["node_modules/react/node_modules/helper"] = {
                "version": "1.0.0"
            }
        else:
            lock["packages"]["node_modules/react/vendor"] = {"version": "1.0.0"}
        files["package.json"] = json.dumps(manifest)
        files["package-lock.json"] = json.dumps(lock)
        registry = Registry({"lodash": ("4.17.21", "4.17.22")})

        result = observe_dependencies(
            DependencySnapshot(files=files, baseline_sha=BASELINE),
            registry=registry,
            target_versions=Newest(),
        )

        assert isinstance(result, InsufficientEvidenceResult)
        assert "workspace" in result.reasons[0] or "flat root" in result.reasons[0] or "nested" in result.reasons[0]
        assert registry.calls == []


def test_npm_observation_refuses_duplicate_root_dependency_kind_before_registry() -> None:
    snapshot = _npm_snapshot()
    files = dict(snapshot.files)
    lock = json.loads(files["package-lock.json"])
    lock["packages"][""]["devDependencies"] = {"lodash": "^4.17.21"}
    files["package-lock.json"] = json.dumps(lock)
    registry = Registry({"lodash": ("4.17.21", "4.17.22")})

    result = observe_dependencies(
        DependencySnapshot(files=files, baseline_sha=BASELINE),
        registry=registry,
        target_versions=Newest(),
    )

    assert isinstance(result, InsufficientEvidenceResult)
    assert "multiple sections" in result.reasons[0]
    assert registry.calls == []


def test_npm_shrinkwrap_is_refused_even_when_package_lock_is_present() -> None:
    snapshot = _npm_snapshot()
    result = observe_dependencies(
        DependencySnapshot(
            files={**snapshot.files, "npm-shrinkwrap.json": "{}"}, baseline_sha=BASELINE
        ),
        manager="npm",
        registry=Registry({}),
        target_versions=Newest(),
    )

    assert isinstance(result, UnsupportedResult)
    assert "npm-shrinkwrap.json" in result.reasons[0]
