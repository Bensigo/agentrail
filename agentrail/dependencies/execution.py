"""Fail-closed execution of one approved dependency upgrade.

This module is intentionally not part of the general issue runner.  A
dependency upgrade has a narrower, auditable contract:

* an approval stamped by the alignment/approval seam is required;
* the repository is cloned into a disposable checkout;
* the checkout's declared manager/runtime boundary is checked before the
  manager is invoked;
* manager-specific installs and verification happen only in that checkout; and
* the resulting diff must be inside the contract's allow-list.

The module returns dependency-specific evidence.  It does not publish, merge,
change the Objective Gate implementation, or grant any new permission.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Protocol, Sequence, Tuple, Union

from agentrail.dependencies.evidence import DependencyEvidence
from agentrail.dependencies.manager import (
    ADAPTER_PROFILE_IDS,
    ManagerId,
)
from agentrail.dependencies.pnpm import DependencyCandidate, adapter_identity_fingerprint
from agentrail.run.evidence import bound_evidence


class ExecutionStatus(str, Enum):
    GREEN = "green"
    RED = "red"
    REFUSED = "refused"


class ExecutionReason(str, Enum):
    APPROVAL_REQUIRED = "approval_required"
    INVALID_CONTRACT = "invalid_contract"
    CLONE_FAILED = "clone_failed"
    BASELINE_SHA_MISMATCH = "baseline_sha_mismatch"
    MANIFEST_MISMATCH = "manifest_mismatch"
    LOCKFILE_MISSING = "lockfile_missing"
    LOCKFILE_UNCOMMITTED = "lockfile_uncommitted"
    UNSUPPORTED_RUNTIME = "unsupported_runtime"
    TOOLCHAIN_MISMATCH = "toolchain_mismatch"
    BASELINE_INSTALL_FAILED = "baseline_install_failed"
    BASELINE_VERIFICATION_FAILED = "baseline_verification_failed"
    UPGRADE_FAILED = "upgrade_failed"
    TARGET_INSTALL_FAILED = "target_install_failed"
    TARGET_VERIFICATION_FAILED = "target_verification_failed"
    SCOPE_VIOLATION = "scope_violation"
    NO_DEPENDENCY_CHANGE = "no_dependency_change"
    EXECUTION_ERROR = "execution_error"
    EVIDENCE_REQUIRED = "evidence_required"
    EVIDENCE_MISMATCH = "evidence_mismatch"
    CAPABILITY_UNAVAILABLE = "capability_unavailable"


Command = Tuple[str, ...]


class CommandRunner(Protocol):
    def run(
        self,
        command: Sequence[str],
        *,
        cwd: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        timeout: Optional[int] = None,
        capture_output: bool = False,
        text: bool = False,
        check: bool = False,
    ) -> Any: ...


def _subprocess_runner(
    command: Sequence[str],
    *,
    cwd: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    timeout: Optional[int] = None,
    capture_output: bool = False,
    text: bool = False,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(command),
        cwd=cwd,
        env=dict(env) if env is not None else None,
        timeout=timeout,
        capture_output=capture_output,
        text=text,
        check=check,
    )


@dataclass(frozen=True)
class ApprovedPnpmUpgrade:
    """The minimum immutable contract accepted by the executor.

    ``approved`` and ``approval_id`` are deliberately separate from the
    candidate.  A detected candidate is not permission to execute it.
    ``from_candidate`` is an adapter for #1577's observation type; it still
    requires the caller to provide the approval record explicitly.
    """

    package: str
    dependency_kind: str
    specifier: str
    current_version: str
    target_version: str
    baseline_sha: str
    candidate_fingerprint: str
    approval_id: str
    approved: bool
    ecosystem: str = "node"
    package_manager: str = "pnpm"
    package_manager_version: str = ""
    adapter_profile: Optional[str] = None
    adapter_identity_fingerprint: Optional[str] = None
    dependency_evidence: Optional[DependencyEvidence] = None
    manifest_path: str = "package.json"
    lockfile_path: str = "pnpm-lock.yaml"
    affected_usage_paths: Tuple[str, ...] = ()
    required_test_paths: Tuple[str, ...] = ()
    verification_commands: Tuple[Command, ...] = ()

    @classmethod
    def from_candidate(
        cls,
        candidate: DependencyCandidate,
        *,
        approval_id: str,
        approved: bool,
        dependency_evidence: DependencyEvidence,
        verification_commands: Iterable[Union[str, Sequence[str]]],
        affected_usage_paths: Iterable[str] = (),
        required_test_paths: Iterable[str] = (),
    ) -> "ApprovedPnpmUpgrade":
        return cls(
            package=candidate.package,
            dependency_kind=candidate.dependency_kind,
            specifier=candidate.specifier,
            current_version=candidate.current_version,
            target_version=candidate.target_version,
            baseline_sha=candidate.baseline_sha,
            candidate_fingerprint=candidate.fingerprint,
            approval_id=approval_id,
            approved=approved,
            ecosystem=getattr(candidate, "ecosystem", "node") or "node",
            package_manager=getattr(candidate, "package_manager", "pnpm") or "pnpm",
            package_manager_version=getattr(candidate, "package_manager_version", None) or "",
            adapter_profile=getattr(candidate, "adapter_profile", None),
            adapter_identity_fingerprint=getattr(
                candidate, "adapter_identity_fingerprint", None
            ),
            dependency_evidence=dependency_evidence,
            manifest_path=candidate.manifest_path,
            lockfile_path=candidate.lockfile_path,
            affected_usage_paths=tuple(affected_usage_paths),
            required_test_paths=tuple(required_test_paths),
            verification_commands=_normalise_commands(verification_commands),
        )


@dataclass(frozen=True)
class Toolchain:
    pnpm_version: str
    runtime_version: str
    pnpm_command: Command = ("corepack", "pnpm")
    manager_id: str = "pnpm"
    manager_version: str = ""
    manager_command: Command = ()


@dataclass(frozen=True)
class CommandEvidence:
    command: Command
    returncode: Optional[int]
    stdout: str = ""
    stderr: str = ""

    @property
    def passed(self) -> bool:
        return self.returncode == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "command": list(self.command),
            "returncode": self.returncode,
            "passed": self.passed,
            "stdout": bound_evidence(self.stdout),
            "stderr": bound_evidence(self.stderr),
        }


@dataclass
class DependencyExecutionResult:
    status: ExecutionStatus
    gate_verdict: str
    reason_code: Optional[ExecutionReason] = None
    reason: str = ""
    baseline_sha: str = ""
    checkout_sha: str = ""
    toolchain: Optional[Toolchain] = None
    baseline_install: Optional[CommandEvidence] = None
    baseline_verification: Tuple[CommandEvidence, ...] = ()
    upgrade: Optional[CommandEvidence] = None
    target_install: Optional[CommandEvidence] = None
    target_verification: Tuple[CommandEvidence, ...] = ()
    changed_files: Tuple[str, ...] = ()
    allowed_files: Tuple[str, ...] = ()
    cleanup_completed: bool = False
    evidence_version: int = 1
    candidate_fingerprint: str = ""
    approval_id: str = ""
    approved: bool = False
    dependency_kind: str = ""
    ecosystem: str = ""
    package_manager: str = ""
    package_manager_version: str = ""
    adapter_profile: Optional[str] = None
    adapter_identity_fingerprint: Optional[str] = None
    package: str = ""
    current_version: str = ""
    target_version: str = ""
    manifest_path: str = "package.json"
    lockfile_path: str = "pnpm-lock.yaml"
    dependency_evidence: Optional[DependencyEvidence] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "evidenceVersion": self.evidence_version,
            "status": self.status.value,
            "gate": {"verdict": self.gate_verdict, "reason": self.reason},
            "reasonCode": self.reason_code.value if self.reason_code else None,
            "dependencyEvidence": self.dependency_evidence.to_dict() if self.dependency_evidence else None,
            "baselineSha": self.baseline_sha,
            "checkoutSha": self.checkout_sha,
            "toolchain": (
                {
                    "pnpmVersion": self.toolchain.pnpm_version,
                    "runtimeVersion": self.toolchain.runtime_version,
                    "pnpmCommand": list(self.toolchain.pnpm_command),
                    "managerId": self.toolchain.manager_id,
                    "managerVersion": self.toolchain.manager_version,
                    "managerCommand": list(self.toolchain.manager_command),
                }
                if self.toolchain
                else None
            ),
            "baselineInstall": self.baseline_install.to_dict() if self.baseline_install else None,
            "baselineVerification": [item.to_dict() for item in self.baseline_verification],
            "upgrade": self.upgrade.to_dict() if self.upgrade else None,
            "targetInstall": self.target_install.to_dict() if self.target_install else None,
            "targetVerification": [item.to_dict() for item in self.target_verification],
            "changedFiles": list(self.changed_files),
            "allowedFiles": list(self.allowed_files),
            "cleanupCompleted": self.cleanup_completed,
            "candidateFingerprint": self.candidate_fingerprint,
            "approvalId": self.approval_id,
            "approved": self.approved,
            "dependencyKind": self.dependency_kind,
            "ecosystem": self.ecosystem,
            "packageManager": self.package_manager,
            "packageManagerVersion": self.package_manager_version,
            "adapterProfile": self.adapter_profile,
            "adapterIdentityFingerprint": self.adapter_identity_fingerprint,
            "package": self.package,
            "currentVersion": self.current_version,
            "targetVersion": self.target_version,
            "manifestPath": self.manifest_path,
            "lockfilePath": self.lockfile_path,
        }

@dataclass(frozen=True)
class _CommandResult:
    evidence: CommandEvidence
    error: Optional[str] = None


_EXACT_VERSION = re.compile(r"^(?:v)?(\d+\.\d+\.\d+)$")
_EXACT_PNPM = re.compile(r"^pnpm@(\d+\.\d+\.\d+)$")
_SHELL_META = re.compile(r"[;&|<>`]|\n")

# Detection, an evidence profile and a descriptive command plan do not grant
# managed execution capability. pnpm is the only executor implemented here;
# npm candidates are handed to an external builder and refuse before clone.
_MANAGED_EXECUTION_MANAGERS = frozenset({ManagerId.PNPM.value})


def _normalise_commands(commands: Iterable[Union[str, Sequence[str]]]) -> Tuple[Command, ...]:
    normalised: List[Command] = []
    for command in commands:
        if isinstance(command, str):
            if _SHELL_META.search(command):
                raise ValueError("verification commands must not contain shell operators")
            parts = tuple(shlex.split(command))
        else:
            parts = tuple(str(part) for part in command)
        if not parts or any(not part for part in parts):
            raise ValueError("verification commands must be non-empty")
        normalised.append(parts)
    return tuple(normalised)


def _normalise_path(path: str) -> str:
    if not isinstance(path, str):
        raise ValueError(f"path is not text: {path!r}")
    value = path.replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    if (
        not value
        or value.startswith("/")
        or re.match(r"^[A-Za-z]:/", value)
        or ".." in value.split("/")
    ):
        raise ValueError(f"path is outside the repository: {path!r}")
    return value


def _validate_contract(contract: ApprovedPnpmUpgrade) -> Optional[str]:
    if not contract.approved or not contract.approval_id.strip():
        return "dependency upgrade has no explicit approval record"
    required = {
        "package": contract.package,
        "specifier": contract.specifier,
        "current_version": contract.current_version,
        "target_version": contract.target_version,
        "baseline_sha": contract.baseline_sha,
        "candidate_fingerprint": contract.candidate_fingerprint,
    }
    if any(not isinstance(value, str) or not value.strip() for value in required.values()):
        return "approved dependency contract is incomplete"
    expected_profile = ADAPTER_PROFILE_IDS.get(
        (contract.ecosystem, contract.package_manager)
    )
    if expected_profile is None:
        return "dependency execution adapter capability is unavailable"
    if contract.adapter_profile != expected_profile:
        return "approved dependency adapter profile is mismatched"
    try:
        expected_adapter_fingerprint = adapter_identity_fingerprint(
            candidate_fingerprint=contract.candidate_fingerprint,
            ecosystem=contract.ecosystem,
            package_manager=contract.package_manager,
            adapter_profile=expected_profile,
        )
    except ValueError:
        return "approved dependency adapter identity is invalid"
    if contract.adapter_identity_fingerprint != expected_adapter_fingerprint:
        return "approved dependency adapter identity fingerprint is mismatched"
    evidence = contract.dependency_evidence
    if evidence is None or not evidence.decision.proof_complete:
        return "dependency evidence is missing or not proof-complete"
    identity = evidence.candidate
    if (
        identity.fingerprint != contract.candidate_fingerprint
        or identity.package != contract.package
        or identity.current_version != contract.current_version
        or identity.target_version != contract.target_version
        or identity.baseline_sha != contract.baseline_sha
        or identity.ecosystem != contract.ecosystem
        or identity.package_manager != contract.package_manager
        or identity.adapter_profile != contract.adapter_profile
        or identity.adapter_identity_fingerprint
        != contract.adapter_identity_fingerprint
    ):
        return "dependency evidence does not match the approved candidate"
    if contract.dependency_kind not in {"dependencies", "devDependencies", "optionalDependencies", "buildDependencies"}:
        return "dependency kind is unsupported"
    if contract.current_version == contract.target_version:
        return "target version is unchanged"
    if not contract.verification_commands:
        return "approved dependency contract declares no verification commands"
    try:
        paths = (
            contract.manifest_path,
            contract.lockfile_path,
            *contract.affected_usage_paths,
            *contract.required_test_paths,
        )
        seen_paths: set[str] = set()
        for path in paths:
            normalised = _normalise_path(path)
            if normalised in seen_paths:
                return (
                    "approved dependency paths collide after normalization: "
                    f"{normalised}"
                )
            seen_paths.add(normalised)
    except ValueError as exc:
        return str(exc)
    return None


def _command(
    runner: CommandRunner,
    command: Command,
    *,
    cwd: Path,
    timeout: int,
    env: Optional[Mapping[str, str]] = None,
) -> _CommandResult:
    try:
        process = runner.run(
            command,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        evidence = CommandEvidence(command, None, str(exc), "timeout")
        return _CommandResult(evidence, "command timed out")
    except (OSError, ValueError) as exc:
        evidence = CommandEvidence(command, None, "", str(exc))
        return _CommandResult(evidence, str(exc))
    evidence = CommandEvidence(
        command,
        int(getattr(process, "returncode", 1)),
        str(getattr(process, "stdout", "") or ""),
        str(getattr(process, "stderr", "") or ""),
    )
    return _CommandResult(evidence)


def _read_exact_runtime(checkout: Path) -> Optional[str]:
    declared: List[str] = []
    for name in (".nvmrc", ".node-version"):
        path = checkout / name
        if path.exists():
            declared.append(path.read_text(encoding="utf-8").strip())
    package = checkout / "package.json"
    if not declared and package.exists():
        try:
            data = json.loads(package.read_text(encoding="utf-8"))
            engine = data.get("engines", {}).get("node") if isinstance(data, dict) else None
            if isinstance(engine, str):
                declared.append(engine.strip().lstrip("="))
        except (OSError, ValueError, AttributeError):
            return None
    if not declared or any(_EXACT_VERSION.fullmatch(value) is None for value in declared):
        return None
    normalised = _EXACT_VERSION.fullmatch(declared[0]).group(1)  # type: ignore[union-attr]
    if any((_EXACT_VERSION.fullmatch(value).group(1) != normalised) for value in declared):  # type: ignore[union-attr]
        return None
    return normalised


def _inspect_toolchain(checkout: Path) -> Tuple[Optional[Toolchain], Optional[ExecutionReason], str]:
    package_path = checkout / "package.json"
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, ExecutionReason.INVALID_CONTRACT, "package.json is missing"
    except (OSError, ValueError) as exc:
        return None, ExecutionReason.INVALID_CONTRACT, f"package.json is unreadable: {exc}"
    package_manager = package.get("packageManager") if isinstance(package, dict) else None
    match = _EXACT_PNPM.fullmatch(package_manager) if isinstance(package_manager, str) else None
    if match is None:
        return None, ExecutionReason.UNSUPPORTED_RUNTIME, "package.json must declare an exact pnpm@x.y.z"
    runtime = _read_exact_runtime(checkout)
    if runtime is None:
        return None, ExecutionReason.UNSUPPORTED_RUNTIME, "repository has no single exact Node runtime declaration"
    return Toolchain(match.group(1), runtime), None, ""


def _manifest_matches_contract(checkout: Path, contract: ApprovedPnpmUpgrade) -> Optional[str]:
    try:
        manifest = json.loads((checkout / _normalise_path(contract.manifest_path)).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return f"approved package manifest is unreadable: {exc}"
    section = manifest.get(contract.dependency_kind) if isinstance(manifest, dict) else None
    if not isinstance(section, dict) or section.get(contract.package) != contract.specifier:
        return "approved candidate does not match the package manifest at the baseline"
    return None


def _git_changed_files(runner: CommandRunner, checkout: Path, baseline_sha: str, timeout: int) -> Tuple[Tuple[str, ...], Optional[str]]:
    diff = _command(runner, ("git", "diff", "--name-only", baseline_sha), cwd=checkout, timeout=timeout)
    status = _command(runner, ("git", "status", "--porcelain=v1", "--untracked-files=all"), cwd=checkout, timeout=timeout)
    if diff.error or status.error or not diff.evidence.passed or not status.evidence.passed:
        return (), "could not inspect the dependency upgrade diff"
    paths = set(line.strip() for line in diff.evidence.stdout.splitlines() if line.strip())
    for line in status.evidence.stdout.splitlines():
        if not line.strip():
            continue
        value = line[3:] if len(line) >= 3 else ""
        if " -> " in value:
            value = value.rsplit(" -> ", 1)[-1]
        if value:
            paths.add(value.strip())
    return tuple(sorted(paths)), None


def _isolated_package_env(workspace: Path) -> Dict[str, str]:
    """Keep Corepack, pnpm, npm, and XDG caches inside the disposable run."""
    cache = workspace / "cache"
    return {
        **os.environ,
        "COREPACK_HOME": str(cache / "corepack"),
        "PNPM_HOME": str(cache / "pnpm-home"),
        "PNPM_STORE_DIR": str(cache / "pnpm-store"),
        "npm_config_cache": str(cache / "npm"),
        "npm_config_store_dir": str(cache / "pnpm-store"),
        "XDG_CACHE_HOME": str(cache / "xdg"),
    }


def _finish(
    *,
    status: ExecutionStatus,
    reason_code: Optional[ExecutionReason],
    reason: str,
    baseline_sha: str,
    checkout_sha: str = "",
    toolchain: Optional[Toolchain] = None,
    **values: Any,
) -> DependencyExecutionResult:
    return DependencyExecutionResult(
        status=status,
        gate_verdict="green" if status is ExecutionStatus.GREEN else "red",
        reason_code=reason_code,
        reason=reason,
        baseline_sha=baseline_sha,
        checkout_sha=checkout_sha,
        toolchain=toolchain,
        **values,
    )


def execute_approved_pnpm_upgrade(
    repository: Union[str, Path],
    contract: ApprovedPnpmUpgrade,
    *,
    runner: CommandRunner = _subprocess_runner,
    timeout: int = 1800,
    workspace_parent: Optional[Union[str, Path]] = None,
) -> DependencyExecutionResult:
    """Execute one approved upgrade and always remove its disposable checkout."""

    if contract.package_manager != ManagerId.PNPM.value:
        result = _finish(
            status=ExecutionStatus.REFUSED,
            reason_code=ExecutionReason.INVALID_CONTRACT,
            reason="pnpm executor accepts only package_manager=pnpm",
            baseline_sha=contract.baseline_sha,
        )
        result.dependency_evidence = contract.dependency_evidence
        result.adapter_profile = contract.adapter_profile
        result.adapter_identity_fingerprint = contract.adapter_identity_fingerprint
        return result

    invalid = _validate_contract(contract)
    if invalid:
        if "approval" in invalid:
            code = ExecutionReason.APPROVAL_REQUIRED
        elif "evidence is missing" in invalid:
            code = ExecutionReason.EVIDENCE_REQUIRED
        elif "evidence does not match" in invalid:
            code = ExecutionReason.EVIDENCE_MISMATCH
        else:
            code = ExecutionReason.INVALID_CONTRACT
        result = _finish(status=ExecutionStatus.REFUSED, reason_code=code, reason=invalid, baseline_sha=contract.baseline_sha)
        result.dependency_evidence = contract.dependency_evidence
        result.candidate_fingerprint = contract.candidate_fingerprint
        result.adapter_profile = contract.adapter_profile
        result.adapter_identity_fingerprint = contract.adapter_identity_fingerprint
        return result

    parent = Path(workspace_parent) if workspace_parent is not None else None
    workspace: Optional[Path] = None
    result: Optional[DependencyExecutionResult] = None
    try:
        workspace = Path(tempfile.mkdtemp(prefix="agentrail-dependency-", dir=str(parent) if parent else None))
        checkout = workspace / "checkout"
        package_env = _isolated_package_env(workspace)
        clone = _command(
            runner,
            ("git", "clone", "--no-local", "--no-hardlinks", "--quiet", str(repository), str(checkout)),
            cwd=workspace,
            timeout=timeout,
        )
        if not clone.evidence.passed:
            result = _finish(
                status=ExecutionStatus.REFUSED,
                reason_code=ExecutionReason.CLONE_FAILED,
                reason="disposable checkout could not be created",
                baseline_sha=contract.baseline_sha,
            )
            return result

        checkout_sha_result = _command(runner, ("git", "rev-parse", "HEAD"), cwd=checkout, timeout=timeout)
        checkout_sha = checkout_sha_result.evidence.stdout.strip()
        if not checkout_sha_result.evidence.passed or checkout_sha != contract.baseline_sha:
            checkout_sha_result = _command(
                runner,
                ("git", "checkout", "--quiet", "--detach", contract.baseline_sha),
                cwd=checkout,
                timeout=timeout,
            )
            if not checkout_sha_result.evidence.passed:
                result = _finish(
                    status=ExecutionStatus.REFUSED,
                    reason_code=ExecutionReason.BASELINE_SHA_MISMATCH,
                    reason="disposable checkout does not contain the approved baseline SHA",
                    baseline_sha=contract.baseline_sha,
                    checkout_sha=checkout_sha,
                )
                return result
            checkout_sha = _command(runner, ("git", "rev-parse", "HEAD"), cwd=checkout, timeout=timeout).evidence.stdout.strip()
        if checkout_sha != contract.baseline_sha:
            result = _finish(
                status=ExecutionStatus.REFUSED,
                reason_code=ExecutionReason.BASELINE_SHA_MISMATCH,
                reason="disposable checkout is not at the approved baseline SHA",
                baseline_sha=contract.baseline_sha,
                checkout_sha=checkout_sha,
            )
            return result

        lockfile = _normalise_path(contract.lockfile_path)
        manifest = _normalise_path(contract.manifest_path)
        tracked = _command(runner, ("git", "ls-files", "--error-unmatch", lockfile), cwd=checkout, timeout=timeout)
        if not (checkout / lockfile).is_file():
            result = _finish(status=ExecutionStatus.REFUSED, reason_code=ExecutionReason.LOCKFILE_MISSING, reason="approved pnpm lockfile is missing", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha)
            return result
        if not tracked.evidence.passed:
            result = _finish(status=ExecutionStatus.REFUSED, reason_code=ExecutionReason.LOCKFILE_UNCOMMITTED, reason="approved pnpm lockfile is not committed", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha)
            return result

        manifest_error = _manifest_matches_contract(checkout, contract)
        if manifest_error:
            result = _finish(status=ExecutionStatus.REFUSED, reason_code=ExecutionReason.MANIFEST_MISMATCH, reason=manifest_error, baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha)
            return result

        toolchain, toolchain_reason, toolchain_message = _inspect_toolchain(checkout)
        if toolchain is None:
            result = _finish(status=ExecutionStatus.REFUSED, reason_code=toolchain_reason, reason=toolchain_message, baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha)
            return result
        node = _command(runner, ("node", "--version"), cwd=checkout, timeout=timeout, env=package_env)
        pnpm = _command(runner, (*toolchain.pnpm_command, "--version"), cwd=checkout, timeout=timeout, env=package_env)
        actual_node = node.evidence.stdout.strip().lstrip("v")
        actual_pnpm = pnpm.evidence.stdout.strip().lstrip("v")
        if not node.evidence.passed or not pnpm.evidence.passed or actual_node != toolchain.runtime_version or actual_pnpm != toolchain.pnpm_version:
            result = _finish(status=ExecutionStatus.REFUSED, reason_code=ExecutionReason.TOOLCHAIN_MISMATCH, reason="runtime or pnpm does not match the repository's pinned declaration", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain)
            return result

        install_command = (*toolchain.pnpm_command, "install", "--frozen-lockfile", "--ignore-scripts")
        baseline_install = _command(runner, install_command, cwd=checkout, timeout=timeout, env=package_env)
        if not baseline_install.evidence.passed:
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.BASELINE_INSTALL_FAILED, reason="baseline frozen install failed", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence)
            return result
        baseline_verification = tuple(_command(runner, command, cwd=checkout, timeout=timeout, env=package_env).evidence for command in contract.verification_commands)
        if any(not item.passed for item in baseline_verification):
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.BASELINE_VERIFICATION_FAILED, reason="baseline verification failed; upgrade was not attempted", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification)
            return result

        upgrade = _command(runner, (*toolchain.pnpm_command, "update", "--lockfile-only", "--ignore-scripts", f"{contract.package}@{contract.target_version}"), cwd=checkout, timeout=timeout, env=package_env)
        if not upgrade.evidence.passed:
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.UPGRADE_FAILED, reason="pnpm could not apply the approved dependency update", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence)
            return result

        target_install = _command(runner, install_command, cwd=checkout, timeout=timeout, env=package_env)
        if not target_install.evidence.passed:
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.TARGET_INSTALL_FAILED, reason="target frozen install failed", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence, target_install=target_install.evidence)
            return result
        target_verification = tuple(_command(runner, command, cwd=checkout, timeout=timeout, env=package_env).evidence for command in contract.verification_commands)
        changed_files, diff_error = _git_changed_files(runner, checkout, contract.baseline_sha, timeout)
        allowed_files = tuple(sorted({_normalise_path(path) for path in (manifest, lockfile, *contract.affected_usage_paths, *contract.required_test_paths)}))
        if diff_error:
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.SCOPE_VIOLATION, reason=diff_error, baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence, target_install=target_install.evidence, target_verification=target_verification, changed_files=changed_files, allowed_files=allowed_files)
            return result
        outside = sorted(set(changed_files) - set(allowed_files))
        if outside:
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.SCOPE_VIOLATION, reason=f"upgrade changed files outside the approved scope: {', '.join(outside)}", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence, target_install=target_install.evidence, target_verification=target_verification, changed_files=changed_files, allowed_files=allowed_files)
            return result
        if lockfile not in changed_files:
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.NO_DEPENDENCY_CHANGE, reason="approved upgrade did not change the pnpm lockfile", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence, target_install=target_install.evidence, target_verification=target_verification, changed_files=changed_files, allowed_files=allowed_files)
            return result
        if any(not item.passed for item in target_verification):
            result = _finish(status=ExecutionStatus.RED, reason_code=ExecutionReason.TARGET_VERIFICATION_FAILED, reason="target verification failed", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence, target_install=target_install.evidence, target_verification=target_verification, changed_files=changed_files, allowed_files=allowed_files)
            return result
        result = _finish(status=ExecutionStatus.GREEN, reason_code=None, reason="approved pnpm upgrade passed baseline, frozen install, scope, and target verification", baseline_sha=contract.baseline_sha, checkout_sha=checkout_sha, toolchain=toolchain, baseline_install=baseline_install.evidence, baseline_verification=baseline_verification, upgrade=upgrade.evidence, target_install=target_install.evidence, target_verification=target_verification, changed_files=changed_files, allowed_files=allowed_files)
        return result
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = _finish(status=ExecutionStatus.REFUSED, reason_code=ExecutionReason.EXECUTION_ERROR, reason=str(exc), baseline_sha=contract.baseline_sha)
        return result
    finally:
        if result is not None:
            result.candidate_fingerprint = contract.candidate_fingerprint
            result.approval_id = contract.approval_id
            result.approved = contract.approved
            result.dependency_kind = contract.dependency_kind
            result.ecosystem = getattr(contract, "ecosystem", "")
            result.package_manager = getattr(contract, "package_manager", "")
            result.package_manager_version = getattr(contract, "package_manager_version", "") or ""
            result.adapter_profile = contract.adapter_profile
            result.adapter_identity_fingerprint = contract.adapter_identity_fingerprint
            result.package = contract.package
            result.current_version = contract.current_version
            result.target_version = contract.target_version
            result.manifest_path = contract.manifest_path
            result.lockfile_path = contract.lockfile_path
        cleanup_completed = True
        if workspace is not None:
            try:
                shutil.rmtree(workspace)
            except OSError:
                cleanup_completed = False
        if result is not None:
            result.dependency_evidence = contract.dependency_evidence
            result.cleanup_completed = cleanup_completed


def execute_approved_dependency_upgrade(
    repository: Union[str, Path],
    contract: ApprovedPnpmUpgrade,
    *,
    runner: CommandRunner = _subprocess_runner,
    timeout: int = 1800,
    workspace_parent: Optional[Union[str, Path]] = None,
) -> DependencyExecutionResult:
    """Execute only the managed pnpm profile.

    Detection, observation, evidence profiles and descriptive command plans do
    not grant managed execution capability. Every other manager, including
    npm, refuses before a checkout is created or a runner is called.
    """
    if contract.package_manager in _MANAGED_EXECUTION_MANAGERS:
        return execute_approved_pnpm_upgrade(
            repository,
            contract,
            runner=runner,
            timeout=timeout,
            workspace_parent=workspace_parent,
        )

    result = _finish(
        status=ExecutionStatus.REFUSED,
        reason_code=ExecutionReason.CAPABILITY_UNAVAILABLE,
        reason=(
            "managed dependency execution adapter is unavailable: "
            f"{contract.package_manager}"
        ),
        baseline_sha=contract.baseline_sha,
    )
    result.dependency_evidence = contract.dependency_evidence
    result.candidate_fingerprint = contract.candidate_fingerprint
    result.approval_id = contract.approval_id
    result.approved = contract.approved
    result.dependency_kind = contract.dependency_kind
    result.ecosystem = contract.ecosystem
    result.package_manager = contract.package_manager
    result.package_manager_version = contract.package_manager_version
    result.adapter_profile = contract.adapter_profile
    result.adapter_identity_fingerprint = contract.adapter_identity_fingerprint
    result.package = contract.package
    result.current_version = contract.current_version
    result.target_version = contract.target_version
    result.manifest_path = contract.manifest_path
    result.lockfile_path = contract.lockfile_path
    return result


def write_dependency_execution_evidence(
    path: Path,
    result: DependencyExecutionResult,
    *,
    metadata_path: Optional[Path] = None,
) -> None:
    """Persist execution proof and attach it to the run metadata surface."""
    payload = result.to_dict()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if metadata_path is None:
        return
    metadata: Dict[str, Any] = {}
    if metadata_path.exists():
        try:
            loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                metadata = loaded
        except (OSError, ValueError, TypeError):
            metadata = {}
    metadata["dependencyExecution"] = payload
    metadata["dependencyExecutionFile"] = str(path)
    if result.dependency_evidence is not None:
        evidence = result.dependency_evidence.to_dict()
        metadata["dependencyEvidence"] = evidence
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")


__all__ = [
    "ApprovedPnpmUpgrade",
    "CommandEvidence",
    "DependencyExecutionResult",
    "ExecutionReason",
    "ExecutionStatus",
    "Toolchain",
    "execute_approved_dependency_upgrade",
    "execute_approved_pnpm_upgrade",
    "write_dependency_execution_evidence",
]
