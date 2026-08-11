from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from agentrail.dependencies.execution import (
    ApprovedPnpmUpgrade,
    ExecutionReason,
    ExecutionStatus,
    execute_approved_dependency_upgrade,
    execute_approved_pnpm_upgrade,
)
from agentrail.dependencies.manager import CARGO_ADAPTER_PROFILE, NPM_ADAPTER_PROFILE
from agentrail.dependencies.go_modules import GO_MODULES_OBSERVATION_PROFILE
from agentrail.dependencies.pnpm import adapter_identity_fingerprint


BASELINE = "a" * 40


class NoCallRunner:
    def __init__(self, capability: str | None = None) -> None:
        # A capability-shaped attribute must not turn descriptive npm argv into
        # a managed executor.
        self.dependency_execution_capability = capability
        self.calls: list[tuple[str, ...]] = []

    def run(self, command, **kwargs):
        self.calls.append(tuple(command))
        raise AssertionError("non-operational manager reached the runner")


def _contract(*, package_manager: str = "npm") -> ApprovedPnpmUpgrade:
    fingerprint = "sha256:npm-candidate"
    return ApprovedPnpmUpgrade(
        package="left-pad",
        dependency_kind="dependencies",
        specifier="^1.3.0",
        current_version="1.3.0",
        target_version="1.3.1",
        baseline_sha=BASELINE,
        candidate_fingerprint=fingerprint,
        approval_id="approval-npm",
        approved=True,
        ecosystem="node",
        package_manager=package_manager,
        adapter_profile=NPM_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint,
            ecosystem="node",
            package_manager=package_manager,
            adapter_profile=NPM_ADAPTER_PROFILE,
        ),
        manifest_path="package.json",
        lockfile_path="package-lock.json",
        verification_commands=(("npm", "test"),),
    )


@pytest.mark.parametrize(
    "runner",
    (
        NoCallRunner(),
        NoCallRunner("agentrail_restricted_dependency_execution_v1"),
    ),
)
def test_npm_managed_execution_is_unavailable_before_clone_or_runner(
    tmp_path: Path, runner: NoCallRunner
) -> None:
    result = execute_approved_dependency_upgrade(
        "/repository-must-not-be-touched",
        _contract(),
        runner=runner,
        workspace_parent=tmp_path,
    )

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.CAPABILITY_UNAVAILABLE
    assert result.reason == "managed dependency execution adapter is unavailable: npm"
    assert result.adapter_profile == NPM_ADAPTER_PROFILE
    assert runner.calls == []
    assert list(tmp_path.iterdir()) == []


def test_npm_default_host_runner_refuses_before_workspace(tmp_path: Path) -> None:
    result = execute_approved_dependency_upgrade(
        "/repository-must-not-be-touched", _contract(), workspace_parent=tmp_path
    )

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.CAPABILITY_UNAVAILABLE
    assert list(tmp_path.iterdir()) == []


def test_cargo_profile_has_no_managed_execution_before_checkout_or_runner(tmp_path: Path) -> None:
    fingerprint = "sha256:cargo-candidate"
    contract = replace(
        _contract(), package="serde", specifier="^1.0.203", current_version="1.0.203",
        target_version="1.0.204", candidate_fingerprint=fingerprint,
        ecosystem="rust", package_manager="cargo", adapter_profile=CARGO_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint, ecosystem="rust", package_manager="cargo",
            adapter_profile=CARGO_ADAPTER_PROFILE,
        ), manifest_path="Cargo.toml", lockfile_path="Cargo.lock",
        verification_commands=(("cargo", "test"),),
    )
    runner = NoCallRunner()

    result = execute_approved_dependency_upgrade(
        "/repository-must-not-be-touched", contract, runner=runner, workspace_parent=tmp_path,
    )

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.CAPABILITY_UNAVAILABLE
    assert result.reason == "managed dependency execution adapter is unavailable: cargo"
    assert result.adapter_profile == CARGO_ADAPTER_PROFILE
    assert runner.calls == []
    assert list(tmp_path.iterdir()) == []


def test_go_observation_profile_has_no_managed_execution_before_checkout_or_runner(tmp_path: Path) -> None:
    fingerprint = "sha256:go-candidate"
    contract = replace(
        _contract(),
        package="github.com/acme/lib",
        specifier="v1.2.3",
        current_version="v1.2.3",
        target_version="v1.3.0",
        candidate_fingerprint=fingerprint,
        ecosystem="go",
        package_manager="go-modules",
        adapter_profile=GO_MODULES_OBSERVATION_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint,
            ecosystem="go",
            package_manager="go-modules",
            adapter_profile=GO_MODULES_OBSERVATION_PROFILE,
        ),
        manifest_path="go.mod",
        lockfile_path="go.sum",
        verification_commands=(("go", "test", "./..."),),
    )
    runner = NoCallRunner()

    result = execute_approved_dependency_upgrade(
        "/repository-must-not-be-touched",
        contract,
        runner=runner,
        workspace_parent=tmp_path,
    )

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.CAPABILITY_UNAVAILABLE
    assert result.reason == "managed dependency execution adapter is unavailable: go-modules"
    assert result.adapter_profile == GO_MODULES_OBSERVATION_PROFILE
    assert runner.calls == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "manager",
    (
        "pip",
        "poetry",
        "uv",
        "yarn",
        "bun",
        "maven",
        "gradle",
        "dotnet",
        "composer",
        "cargo",
        "go-modules",
    ),
)
def test_detected_command_plan_never_grants_managed_execution(
    tmp_path: Path, manager: str
) -> None:
    runner = NoCallRunner()
    result = execute_approved_dependency_upgrade(
        "/repository-must-not-be-touched",
        replace(_contract(), package_manager=manager),
        runner=runner,
        workspace_parent=tmp_path,
    )

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.CAPABILITY_UNAVAILABLE
    assert result.reason == f"managed dependency execution adapter is unavailable: {manager}"
    assert runner.calls == []
    assert list(tmp_path.iterdir()) == []


def test_direct_pnpm_entry_refuses_non_pnpm_contract_before_runner(
    tmp_path: Path,
) -> None:
    runner = NoCallRunner()
    result = execute_approved_pnpm_upgrade(
        "/repository-must-not-be-touched",
        _contract(),
        runner=runner,
        workspace_parent=tmp_path,
    )

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.INVALID_CONTRACT
    assert result.reason == "pnpm executor accepts only package_manager=pnpm"
    assert runner.calls == []
    assert list(tmp_path.iterdir()) == []
