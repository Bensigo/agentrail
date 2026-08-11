"""Acceptance fixtures for the dependency-specific pnpm executor (#1581)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import List

import pytest

from agentrail.dependencies.execution import (
    ApprovedPnpmUpgrade,
    ExecutionReason,
    ExecutionStatus,
    execute_approved_pnpm_upgrade,
    write_dependency_execution_evidence,
)
from agentrail.dependencies.evidence import (
    CandidateIdentity,
    DependencyEvidence,
    DependencyEvidenceDecision,
    DependencyDecisionStatus,
    EvidenceResolution,
    EvidenceSource,
    EvidenceState,
    LockResolution,
    ReleaseEvidence,
    SecurityEvidence,
    UsageEvidence,
    UsageFinding,
)
from agentrail.dependencies.pnpm import DependencyCandidate
from agentrail.dependencies.manager import NPM_ADAPTER_PROFILE, PNPM_ADAPTER_PROFILE
from agentrail.dependencies.pnpm import adapter_identity_fingerprint


FIXTURES = Path(__file__).parent / "fixtures" / "dependency"
BASELINE_SHA = "a" * 40


class Completed:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FixtureRunner:
    """Fake Git/toolchain runner that leaves pnpm behavior fully observable."""

    def __init__(self, fixture_name: str, *, target_install_fails: bool = False, target_test_fails: bool = False, unrelated_file: bool = False) -> None:
        self.fixture_name = fixture_name
        self.target_install_fails = target_install_fails
        self.target_test_fails = target_test_fails
        self.unrelated_file = unrelated_file
        self.calls: List[dict] = []
        self.upgraded = False
        self.verification_count = 0

    def run(self, command, *, cwd=None, env=None, timeout=None, capture_output=False, text=False, check=False):
        command = tuple(command)
        self.calls.append({"command": command, "cwd": cwd, "timeout": timeout, "env": dict(env or {})})
        if command[:2] == ("git", "clone"):
            checkout = Path(command[-1])
            checkout.mkdir(parents=True)
            fixture = FIXTURES / self.fixture_name
            for source in fixture.iterdir():
                target = checkout / source.name
                target.write_bytes(source.read_bytes())
            return Completed(stdout="cloned")
        if command == ("git", "rev-parse", "HEAD"):
            return Completed(stdout=f"{BASELINE_SHA}\n")
        if command[:3] == ("git", "checkout", "--quiet"):
            return Completed()
        if command[:3] == ("git", "ls-files", "--error-unmatch"):
            return Completed(stdout="pnpm-lock.yaml\n")
        if command == ("node", "--version"):
            return Completed(stdout="v20.11.1\n")
        if command == ("corepack", "pnpm", "--version"):
            return Completed(stdout="9.15.0\n")
        if command[:3] == ("corepack", "pnpm", "install"):
            if self.target_install_fails and self.upgraded:
                return Completed(1, stderr="ERR_PNPM_OUTDATED_LOCKFILE")
            return Completed(stdout="frozen install")
        if command[:3] == ("corepack", "pnpm", "update"):
            self.upgraded = True
            return Completed(stdout="updated")
        if command[:2] == ("git", "diff"):
            paths = ["pnpm-lock.yaml"]
            if self.unrelated_file:
                paths.append("README.md")
            return Completed(stdout="\n".join(paths) + "\n")
        if command[:2] == ("git", "status"):
            return Completed()
        if command and command[0] == "pnpm-test":
            self.verification_count += 1
            if self.target_test_fails and self.verification_count == 2:
                return Completed(1, stderr="target test failed")
            return Completed(stdout="tests passed")
        raise AssertionError(f"unexpected command: {command}")


def _contract(*, approved: bool = True, verification_commands=("pnpm-test",), **changes: object) -> ApprovedPnpmUpgrade:
    fingerprint = "sha256:candidate"
    candidate = DependencyCandidate(
        package="left-pad",
        dependency_kind="dependencies",
        specifier="^1.3.0",
        current_version="1.3.0",
        target_version="1.3.1",
        manifest_path="package.json",
        lockfile_path="pnpm-lock.yaml",
        baseline_sha=BASELINE_SHA,
        fingerprint=fingerprint,
        adapter_profile=PNPM_ADAPTER_PROFILE,
        adapter_identity_fingerprint=adapter_identity_fingerprint(
            candidate_fingerprint=fingerprint,
            ecosystem="node",
            package_manager="pnpm",
            adapter_profile=PNPM_ADAPTER_PROFILE,
        ),
    )
    source = EvidenceSource("fixture", "https://example.test/evidence", "2026-08-03T00:00:00Z", "fixture")
    identity = CandidateIdentity.from_candidate(candidate)
    finding = UsageFinding(EvidenceState.NOT_FOUND, detail="fixture inventory is complete")
    evidence = DependencyEvidence(
        candidate=identity,
        collected_at="2026-08-03T00:00:00Z",
        release=ReleaseEvidence(EvidenceResolution.RESOLVED, candidate.target_version, (source,), "2026-08-03T00:00:00Z", True),
        usage=UsageEvidence(finding, finding, finding, finding, "2026-08-03T00:00:00Z"),
        lock=LockResolution(EvidenceResolution.RESOLVED, observed_at="2026-08-03T00:00:00Z"),
        security=SecurityEvidence(EvidenceResolution.RESOLVED, sources=(source,), observed_at="2026-08-03T00:00:00Z"),
        decision=DependencyEvidenceDecision(DependencyDecisionStatus.READY),
    )
    return ApprovedPnpmUpgrade.from_candidate(
        candidate,
        approval_id="approval-1581",
        approved=approved,
        dependency_evidence=evidence,
        verification_commands=verification_commands,
        **changes,
    )


def _run(tmp_path: Path, runner: FixtureRunner, contract: ApprovedPnpmUpgrade | None = None):
    parent = tmp_path / "executor-parent"
    parent.mkdir()
    result = execute_approved_pnpm_upgrade(
        "/fixture/repository",
        contract or _contract(),
        runner=runner,
        workspace_parent=parent,
    )
    return result, parent


def test_clean_upgrade_uses_pinned_toolchain_frozen_installs_and_cleans_checkout(tmp_path: Path) -> None:
    runner = FixtureRunner("clean")
    result, parent = _run(tmp_path, runner)

    assert result.status is ExecutionStatus.GREEN
    assert result.gate_verdict == "green"
    assert result.reason_code is None
    assert result.toolchain is not None
    assert result.toolchain.pnpm_version == "9.15.0"
    assert result.toolchain.runtime_version == "20.11.1"
    assert result.cleanup_completed is True
    assert list(parent.iterdir()) == []
    assert result.changed_files == ("pnpm-lock.yaml",)

    pnpm_calls = [call for call in runner.calls if call["command"][:2] == ("corepack", "pnpm")]
    assert pnpm_calls
    assert all(call["cwd"] and Path(call["cwd"]).name == "checkout" for call in pnpm_calls)
    install_calls = [call["command"] for call in pnpm_calls if call["command"][:3] == ("corepack", "pnpm", "install")]
    assert len(install_calls) == 2
    assert all("--frozen-lockfile" in command for command in install_calls)
    package_env = next(call["env"] for call in pnpm_calls if call["command"][-1] == "--version")
    assert package_env["COREPACK_HOME"].startswith(str(parent))
    assert package_env["PNPM_STORE_DIR"].startswith(str(parent))
    assert runner.calls.index(next(call for call in runner.calls if call["command"][:3] == ("corepack", "pnpm", "update"))) > runner.calls.index(next(call for call in runner.calls if call["command"][0] == "pnpm-test"))


def test_pnpm_preserves_repository_private_registry_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("npm_config_save_prefix", raising=False)
    monkeypatch.delenv("NPM_CONFIG_SAVE_PREFIX", raising=False)
    monkeypatch.setenv("npm_config_registry", "https://registry.private.example/")
    monkeypatch.setenv("npm_config_userconfig", "/workspace/private-pnpmrc")
    runner = FixtureRunner("clean")

    result, _ = _run(tmp_path, runner)

    assert result.status is ExecutionStatus.GREEN
    pnpm_envs = [
        call["env"] for call in runner.calls
        if call["command"][:2] == ("corepack", "pnpm")
    ]
    assert pnpm_envs
    assert all(env["npm_config_registry"] == "https://registry.private.example/" for env in pnpm_envs)
    assert all(env["npm_config_userconfig"] == "/workspace/private-pnpmrc" for env in pnpm_envs)
    assert all("npm_config_save_prefix" not in env for env in pnpm_envs)


def test_approval_is_required_and_no_checkout_is_created(tmp_path: Path) -> None:
    runner = FixtureRunner("clean")
    result, parent = _run(tmp_path, runner, _contract(approved=False))

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.APPROVAL_REQUIRED
    assert runner.calls == []
    assert result.cleanup_completed is False
    assert list(parent.iterdir()) == []


def test_pnpm_execution_refuses_missing_or_cross_manager_profile_before_clone(tmp_path: Path) -> None:
    for index, contract in enumerate((
        replace(_contract(), adapter_profile=None),
        replace(
            _contract(),
            adapter_profile=NPM_ADAPTER_PROFILE,
            adapter_identity_fingerprint=adapter_identity_fingerprint(
                candidate_fingerprint="sha256:candidate",
                ecosystem="node",
                package_manager="pnpm",
                adapter_profile=NPM_ADAPTER_PROFILE,
            ),
        ),
    )):
        runner = FixtureRunner("clean")
        case_dir = tmp_path / f"profile-{index}"
        case_dir.mkdir()
        result, parent = _run(case_dir, runner, contract)

        assert result.status is ExecutionStatus.REFUSED
        assert result.reason_code is ExecutionReason.INVALID_CONTRACT
        assert "adapter" in result.reason
        assert runner.calls == []
        assert list(parent.iterdir()) == []


def test_pnpm_execution_refuses_unsafe_or_colliding_contract_paths_before_clone(
    tmp_path: Path,
) -> None:
    contracts = (
        replace(_contract(), manifest_path="../package.json"),
        replace(_contract(), lockfile_path="/pnpm-lock.yaml"),
        replace(_contract(), lockfile_path="C:\\pnpm-lock.yaml"),
        replace(_contract(), affected_usage_paths=("../README.md",)),
        replace(_contract(), required_test_paths=("./../test.js",)),
        replace(
            _contract(),
            affected_usage_paths=("test.js",),
            required_test_paths=("./test.js",),
        ),
    )
    for index, contract in enumerate(contracts):
        runner = FixtureRunner("clean")
        case_dir = tmp_path / f"unsafe-path-{index}"
        case_dir.mkdir()

        result, parent = _run(case_dir, runner, contract)

        assert result.status is ExecutionStatus.REFUSED
        assert result.reason_code is ExecutionReason.INVALID_CONTRACT
        assert runner.calls == []
        assert list(parent.iterdir()) == []


def test_candidate_and_approval_without_proof_evidence_cannot_execute(tmp_path: Path) -> None:
    runner = FixtureRunner("clean")
    result, parent = _run(tmp_path, runner, replace(_contract(), dependency_evidence=None))

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.EVIDENCE_REQUIRED
    assert runner.calls == []
    assert list(parent.iterdir()) == []


def test_baseline_failure_is_red_and_upgrade_is_not_attempted(tmp_path: Path) -> None:
    runner = FixtureRunner("baseline-failure")
    original = runner.run

    def fail_baseline(command, **kwargs):
        if tuple(command)[:3] == ("corepack", "pnpm", "install"):
            return Completed(1, stderr="baseline test fixture failure")
        return original(command, **kwargs)

    runner.run = fail_baseline  # type: ignore[method-assign]
    result, _ = _run(tmp_path, runner)

    assert result.status is ExecutionStatus.RED
    assert result.gate_verdict == "red"
    assert result.reason_code is ExecutionReason.BASELINE_INSTALL_FAILED
    assert not any(call["command"][:3] == ("corepack", "pnpm", "update") for call in runner.calls)


def test_target_frozen_lockfile_failure_is_red(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, FixtureRunner("frozen-lockfile-failure", target_install_fails=True))

    assert result.status is ExecutionStatus.RED
    assert result.reason_code is ExecutionReason.TARGET_INSTALL_FAILED
    assert result.target_install is not None
    assert "--frozen-lockfile" in result.target_install.command


def test_unsupported_runtime_refuses_before_install(tmp_path: Path) -> None:
    runner = FixtureRunner("unsupported-runtime")
    result, _ = _run(tmp_path, runner)

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.UNSUPPORTED_RUNTIME
    assert not any(call["command"][:2] == ("corepack", "pnpm") for call in runner.calls)


def test_unrelated_file_modification_trips_scope_gate(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, FixtureRunner("unrelated-file", unrelated_file=True))

    assert result.status is ExecutionStatus.RED
    assert result.reason_code is ExecutionReason.SCOPE_VIOLATION
    assert "README.md" in result.reason
    assert result.changed_files == ("README.md", "pnpm-lock.yaml")


def test_target_test_failure_is_red_after_upgrade(tmp_path: Path) -> None:
    runner = FixtureRunner("target-test-failure", target_test_fails=True)
    result, _ = _run(tmp_path, runner)

    assert result.status is ExecutionStatus.RED
    assert result.reason_code is ExecutionReason.TARGET_VERIFICATION_FAILED
    assert result.target_verification[0].passed is False
    assert runner.upgraded is True


def test_missing_lockfile_refuses_without_install(tmp_path: Path) -> None:
    runner = FixtureRunner("missing-lockfile")
    result, _ = _run(tmp_path, runner)

    assert result.status is ExecutionStatus.REFUSED
    assert result.reason_code is ExecutionReason.LOCKFILE_MISSING
    assert not any(call["command"][:2] == ("corepack", "pnpm") for call in runner.calls)


def test_result_evidence_is_json_serialisable(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, FixtureRunner("clean"))
    payload = result.to_dict()
    assert json.dumps(payload)
    assert payload["cleanupCompleted"] is True
    assert payload["candidateFingerprint"] == "sha256:candidate"


def test_execution_evidence_persists_to_run_metadata(tmp_path: Path) -> None:
    result, _ = _run(tmp_path, FixtureRunner("clean"))
    artifact = tmp_path / "dependency-execution.json"
    metadata = tmp_path / "run.json"
    metadata.write_text("{}\n")
    write_dependency_execution_evidence(artifact, result, metadata_path=metadata)

    stored = json.loads(artifact.read_text())
    run = json.loads(metadata.read_text())
    assert stored["candidateFingerprint"] == "sha256:candidate"
    assert run["dependencyExecution"]["status"] == "green"
    assert run["dependencyExecutionFile"] == str(artifact)
