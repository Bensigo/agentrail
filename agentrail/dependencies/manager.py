"""Manager-neutral dependency manager detection.

Detection is deliberately limited to a caller-supplied file snapshot.  This
module never reads the filesystem, calls a package manager, starts a process,
or fetches metadata.  It identifies one repository ecosystem and returns a
small command plan that a later, policy-controlled adapter may execute.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Mapping, Optional, Sequence, Tuple, Union

from agentrail.dependencies.strict_json import loads_strict_json


class DetectionStatus(str, Enum):
    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"


class Ecosystem(str, Enum):
    NODE = "node"
    PYTHON = "python"
    RUST = "rust"
    GO = "go"
    RUBY = "ruby"
    PHP = "php"
    JAVA = "java"
    DOTNET = "dotnet"
    ELIXIR = "elixir"
    DART = "dart"
    SWIFT = "swift"


class ManagerId(str, Enum):
    NPM = "npm"
    PNPM = "pnpm"
    YARN = "yarn"
    BUN = "bun"
    POETRY = "poetry"
    UV = "uv"
    PIP = "pip"
    CARGO = "cargo"
    GO_MODULES = "go-modules"
    BUNDLER = "bundler"
    COMPOSER = "composer"
    MAVEN = "maven"
    GRADLE = "gradle"
    DOTNET = "dotnet"
    MIX = "mix"
    PUB = "pub"
    SPM = "spm"


Command = Tuple[str, ...]


class AdapterCapability(str, Enum):
    """The strongest R10 capability implemented for a detected manager.

    Detection is not a capability claim. ``OBSERVATION_PROPOSAL`` admits a
    bounded candidate and descriptive external-builder argv but never managed
    execution. ``MANAGED_EXECUTION`` additionally has an in-process executor.
    ``UNSUPPORTED`` remains detected-only and must not produce a candidate.
    """

    MANAGED_EXECUTION = "managed_execution"
    OBSERVATION_PROPOSAL = "observation_proposal"
    UNSUPPORTED = "unsupported"


# These IDs are the closed adapter identities already persisted by the
# Console/database proposal boundary.  They are data custody, not aliases that
# may be inferred from a lockfile name at execution time.
PNPM_ADAPTER_PROFILE = "pnpm_lockfile_only_v1"
NPM_ADAPTER_PROFILE = "npm_package_lock_only_v1"
CARGO_ADAPTER_PROFILE = "cargo_lock_registry_only_v1"
ADAPTER_PROFILE_IDS: Mapping[Tuple[str, str], str] = {
    (Ecosystem.NODE.value, ManagerId.PNPM.value): PNPM_ADAPTER_PROFILE,
    (Ecosystem.NODE.value, ManagerId.NPM.value): NPM_ADAPTER_PROFILE,
}


# This is deliberately a closed registry. A detector or command template does
# not make a manager candidate-capable or executable.
_NODE_ADAPTER_CAPABILITIES: Dict[ManagerId, AdapterCapability] = {
    ManagerId.NPM: AdapterCapability.OBSERVATION_PROPOSAL,
    ManagerId.PNPM: AdapterCapability.MANAGED_EXECUTION,
    ManagerId.YARN: AdapterCapability.UNSUPPORTED,
    ManagerId.BUN: AdapterCapability.UNSUPPORTED,
}


def node_adapter_capability(manager: ManagerId) -> AdapterCapability:
    """Return the R10 capability for a Node manager, never inferring npm."""

    return _NODE_ADAPTER_CAPABILITIES.get(manager, AdapterCapability.UNSUPPORTED)


def node_adapter_can_observe(manager: ManagerId) -> bool:
    return node_adapter_capability(manager) is not AdapterCapability.UNSUPPORTED


def node_adapter_has_managed_execution(manager: ManagerId) -> bool:
    return node_adapter_capability(manager) is AdapterCapability.MANAGED_EXECUTION


@dataclass(frozen=True)
class RepositorySnapshot:
    """Files made available to detection by the caller."""

    files: Mapping[str, str]


# Descriptive aliases make the boundary clear to callers that use a generic
# "file snapshot" name rather than the repository-specific name.
FileSnapshot = RepositorySnapshot
DependencyManagerSnapshot = RepositorySnapshot


@dataclass(frozen=True)
class CommandPlan:
    """Shell-free command templates for a manager adapter.

    Commands are argv tuples, never shell strings.  ``{dependency}``,
    ``{version}``, and the npm-only ``{save_flag}`` are placeholders for a
    later adapter; detection itself does not interpolate or execute them.
    """

    install: Command
    upgrade: Command
    verify: Command

    @property
    def install_command(self) -> Command:
        return self.install

    @property
    def upgrade_command(self) -> Command:
        return self.upgrade

    @property
    def verify_command(self) -> Command:
        return self.verify


@dataclass(frozen=True)
class SupportedDetection:
    status: DetectionStatus = field(default=DetectionStatus.SUPPORTED, init=False)
    ecosystem: Ecosystem = Ecosystem.NODE
    manager_id: ManagerId = ManagerId.NPM
    manifest_path: str = ""
    lockfile_path: Optional[str] = None
    command_plan: CommandPlan = field(default_factory=lambda: COMMAND_PLANS[ManagerId.NPM])
    reasons: Tuple[str, ...] = ()

    @property
    def supported(self) -> bool:
        return True


@dataclass(frozen=True)
class UnsupportedDetection:
    status: DetectionStatus = field(default=DetectionStatus.UNSUPPORTED, init=False)
    ecosystem: Optional[Ecosystem] = None
    manager_id: Optional[ManagerId] = None
    manifest_path: Optional[str] = None
    lockfile_path: Optional[str] = None
    command_plan: Optional[CommandPlan] = None
    reason: str = ""
    reasons: Tuple[str, ...] = ()

    @property
    def supported(self) -> bool:
        return False


DetectionResult = Union[SupportedDetection, UnsupportedDetection]


@dataclass(frozen=True)
class _Candidate:
    ecosystem: Ecosystem
    manager_id: ManagerId
    manifest_path: str
    lockfile_path: Optional[str]
    reasons: Tuple[str, ...] = ()


_NODE_LOCKFILES: Dict[ManagerId, Tuple[str, ...]] = {
    ManagerId.NPM: ("package-lock.json",),
    ManagerId.PNPM: ("pnpm-lock.yaml",),
    ManagerId.YARN: ("yarn.lock",),
    ManagerId.BUN: ("bun.lock", "bun.lockb"),
}
_NODE_MANAGER_NAMES = {manager.value: manager for manager in _NODE_LOCKFILES}
_NODE_PACKAGE_MANAGER_RE = re.compile(r"^(npm|pnpm|yarn|bun)(?:@.+)?$")


NPM_DEPENDENCY_KINDS: Tuple[str, ...] = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
_NPM_SAVE_FLAGS: Dict[str, str] = {
    "dependencies": "--save-prod",
    "devDependencies": "--save-dev",
    "optionalDependencies": "--save-optional",
    "peerDependencies": "--save-peer",
}


def npm_save_flag(dependency_kind: str) -> Optional[str]:
    """Return the exact #1688 npm save flag for an admitted dependency kind."""

    return _NPM_SAVE_FLAGS.get(dependency_kind)


COMMAND_PLANS: Dict[ManagerId, CommandPlan] = {
    ManagerId.NPM: CommandPlan(
        ("npm", "ci", "--ignore-scripts"),
        (
            "npm",
            "install",
            "{dependency}@{version}",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "{save_flag}",
        ),
        ("npm", "test"),
    ),
    ManagerId.PNPM: CommandPlan(("pnpm", "install", "--frozen-lockfile"), ("pnpm", "update", "{dependency}@{version}", "--lockfile-only"), ("pnpm", "test")),
    ManagerId.YARN: CommandPlan(("yarn", "install", "--immutable"), ("yarn", "up", "{dependency}@{version}"), ("yarn", "test")),
    ManagerId.BUN: CommandPlan(("bun", "install", "--frozen-lockfile"), ("bun", "add", "{dependency}@{version}"), ("bun", "test")),
    ManagerId.POETRY: CommandPlan(("poetry", "install"), ("poetry", "add", "{dependency}@{version}"), ("poetry", "run", "pytest")),
    ManagerId.UV: CommandPlan(
        (
            "uv",
            "lock",
            "--check",
            "--no-cache",
            "--no-config",
            "--no-python-downloads",
            "--no-sources",
            "--no-build",
        ),
        (
            "uv",
            "lock",
            "--no-cache",
            "--no-config",
            "--no-python-downloads",
            "--no-sources",
            "--no-build",
            "--upgrade-package",
            "{dependency}=={version}",
        ),
        (
            "uv",
            "lock",
            "--check",
            "--no-cache",
            "--no-config",
            "--no-python-downloads",
            "--no-sources",
            "--no-build",
        ),
    ),
    ManagerId.PIP: CommandPlan(("python", "-m", "pip", "install", "-r", "requirements.txt"), ("python", "-m", "pip", "install", "--upgrade", "{dependency}=={version}"), ("python", "-m", "pytest")),
    ManagerId.CARGO: CommandPlan(("cargo", "fetch", "--locked"), ("cargo", "update", "-p", "{dependency}", "--precise", "{version}"), ("cargo", "test")),
    ManagerId.GO_MODULES: CommandPlan(("go", "mod", "download"), ("go", "get", "{dependency}@{version}"), ("go", "test", "./...")),
    ManagerId.BUNDLER: CommandPlan(("bundle", "install", "--deployment"), ("bundle", "update", "{dependency}"), ("bundle", "exec", "rake", "test")),
    ManagerId.COMPOSER: CommandPlan(("composer", "install", "--no-interaction", "--prefer-dist"), ("composer", "update", "{dependency}", "--with-dependencies"), ("composer", "test")),
    ManagerId.MAVEN: CommandPlan(("mvn", "-B", "dependency:go-offline"), ("mvn", "-B", "versions:use-dep-version", "-Dincludes={dependency}", "-DdepVersion={version}", "-DgenerateBackupPoms=false"), ("mvn", "-B", "test")),
    ManagerId.GRADLE: CommandPlan(("./gradlew", "dependencies"), ("./gradlew", "dependencyUpdates", "-Ddependency={dependency}", "-Drevision={version}"), ("./gradlew", "test")),
    ManagerId.DOTNET: CommandPlan(("dotnet", "restore", "--locked-mode"), ("dotnet", "add", "{dependency}", "package", "--version", "{version}"), ("dotnet", "test", "--no-restore")),
    ManagerId.MIX: CommandPlan(("mix", "deps.get"), ("mix", "deps.update", "{dependency}"), ("mix", "test")),
    ManagerId.PUB: CommandPlan(("dart", "pub", "get"), ("dart", "pub", "upgrade", "{dependency}"), ("dart", "test")),
    ManagerId.SPM: CommandPlan(("swift", "package", "resolve"), ("swift", "package", "update", "{dependency}"), ("swift", "test")),
}


def detect_dependency_manager(
    snapshot: Union[RepositorySnapshot, Mapping[str, str]],
) -> DetectionResult:
    """Detect one supported manager from a supplied file snapshot.

    A repository containing multiple independent ecosystems or conflicting
    manager evidence is returned as ``UnsupportedDetection``.  That avoids
    silently selecting the wrong lockfile in a polyglot or partially migrated
    repository.
    """

    files, error = _normalise_snapshot(snapshot)
    if error is not None:
        return _unsupported(error)

    candidates, errors = _find_candidates(files)
    if errors:
        return _unsupported(errors[0])
    if not candidates:
        return _unsupported("no supported dependency manifest or lockfile was detected")
    if len(candidates) > 1:
        managers = ", ".join(sorted(candidate.manager_id.value for candidate in candidates))
        return _unsupported(f"multiple dependency managers detected: {managers}")

    candidate = candidates[0]
    if candidate.ecosystem is Ecosystem.NODE and not node_adapter_can_observe(candidate.manager_id):
        return _unsupported(
            f"{candidate.manager_id.value} was detected but its Node dependency adapter is unsupported"
        )
    return SupportedDetection(
        ecosystem=candidate.ecosystem,
        manager_id=candidate.manager_id,
        manifest_path=candidate.manifest_path,
        lockfile_path=candidate.lockfile_path,
        command_plan=COMMAND_PLANS[candidate.manager_id],
        reasons=candidate.reasons,
    )


# Short aliases are useful at call sites while keeping the descriptive API as
# the canonical name.
detect_manager = detect_dependency_manager
detect = detect_dependency_manager


def _normalise_snapshot(
    snapshot: Union[RepositorySnapshot, Mapping[str, str]],
) -> Tuple[Dict[str, str], Optional[str]]:
    raw_files = snapshot.files if isinstance(snapshot, RepositorySnapshot) else snapshot
    if not isinstance(raw_files, Mapping):
        return {}, "file snapshot must be a mapping"

    files: Dict[str, str] = {}
    for raw_path, content in raw_files.items():
        if not isinstance(raw_path, str) or not raw_path.strip():
            return {}, "file snapshot contains an invalid path"
        if not isinstance(content, str):
            return {}, f"file snapshot entry {raw_path!r} is not text"
        path = raw_path.replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        if (
            not path
            or path.startswith("/")
            or re.match(r"^[A-Za-z]:/", path)
            or ".." in path.split("/")
        ):
            return {}, f"file snapshot contains an unsafe path: {raw_path}"
        if path in files:
            return {}, f"file snapshot path collision after normalization: {path}"
        files[path] = content
    return files, None


def _unsupported(reason: str) -> UnsupportedDetection:
    return UnsupportedDetection(reason=reason, reasons=(reason,))


def _find_candidates(files: Mapping[str, str]) -> Tuple[Tuple[_Candidate, ...], Tuple[str, ...]]:
    candidates = []
    errors = []

    node = _node_candidate(files)
    if node[1] is not None:
        errors.append(node[1])
    elif node[0] is not None:
        candidates.append(node[0])

    python = _python_candidate(files)
    if python[1] is not None:
        errors.append(python[1])
    elif python[0] is not None:
        candidates.append(python[0])

    simple_detectors = (
        _rust_candidate,
        _go_candidate,
        _ruby_candidate,
        _php_candidate,
        _java_candidate,
        _dotnet_candidate,
        _elixir_candidate,
        _dart_candidate,
        _swift_candidate,
    )
    for detector in simple_detectors:
        candidate, error = detector(files)
        if error is not None:
            errors.append(error)
        elif candidate is not None:
            candidates.append(candidate)
    return tuple(candidates), tuple(errors)


def _node_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    if "package.json" not in files:
        return None, None
    if "npm-shrinkwrap.json" in files:
        return None, "npm-shrinkwrap.json was detected but the npm adapter supports package-lock.json v3 only"
    try:
        manifest = loads_strict_json(files["package.json"], document="package.json")
    except (TypeError, ValueError) as exc:
        return None, f"package.json is malformed: {exc}"
    if not isinstance(manifest, dict):
        return None, "package.json must contain an object"

    declared = manifest.get("packageManager")
    if declared is not None:
        if not isinstance(declared, str) or not _NODE_PACKAGE_MANAGER_RE.fullmatch(declared):
            return None, "package.json declares an unsupported package manager"
        manager = _NODE_MANAGER_NAMES[declared.split("@", 1)[0]]
        expected = _NODE_LOCKFILES[manager]
        present = _present_node_lockfiles(files)
        conflicting = [path for path in present if path not in expected]
        if conflicting:
            return None, f"package.json declares {manager.value} but found conflicting lockfile {conflicting[0]}"
        lockfile = next((path for path in expected if path in files), None)
        return _Candidate(Ecosystem.NODE, manager, "package.json", lockfile), None

    present = _present_node_lockfiles(files)
    if len(present) != 1:
        if len(present) > 1:
            return None, "multiple Node package-manager lockfiles detected"
        return None, "package.json does not identify npm, pnpm, yarn, or bun"
    lockfile = present[0]
    manager = next(manager for manager, paths in _NODE_LOCKFILES.items() if lockfile in paths)
    return _Candidate(Ecosystem.NODE, manager, "package.json", lockfile), None


def _present_node_lockfiles(files: Mapping[str, str]) -> Tuple[str, ...]:
    return tuple(path for paths in _NODE_LOCKFILES.values() for path in paths if path in files)


def _python_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    pyproject = files.get("pyproject.toml")
    poetry_marker = pyproject is not None and _toml_section(pyproject, "tool.poetry")
    uv_marker = pyproject is not None and _toml_section(pyproject, "tool.uv")
    has_poetry_lock = "poetry.lock" in files
    has_uv_lock = "uv.lock" in files
    requirements = _first_path(files, ("requirements.txt", "requirements/base.txt"), suffix=".txt", prefix="requirements/")

    if poetry_marker and uv_marker:
        return None, "pyproject.toml declares both Poetry and uv"
    if poetry_marker and has_uv_lock:
        return None, "pyproject.toml declares Poetry but uv.lock is present"
    if uv_marker and has_poetry_lock:
        return None, "pyproject.toml declares uv but poetry.lock is present"
    if poetry_marker or has_poetry_lock:
        if pyproject is None:
            return None, "poetry.lock is present without pyproject.toml"
        return _Candidate(Ecosystem.PYTHON, ManagerId.POETRY, "pyproject.toml", "poetry.lock" if has_poetry_lock else None), None
    if uv_marker or has_uv_lock:
        if pyproject is None:
            return None, "uv.lock is present without pyproject.toml"
        return _Candidate(Ecosystem.PYTHON, ManagerId.UV, "pyproject.toml", "uv.lock" if has_uv_lock else None), None
    if requirements is not None:
        return _Candidate(Ecosystem.PYTHON, ManagerId.PIP, requirements, None), None
    if pyproject is not None:
        return None, "pyproject.toml does not identify Poetry, uv, or pip"
    return None, None


def _first_path(
    files: Mapping[str, str],
    preferred: Sequence[str] = (),
    *,
    suffix: Optional[str] = None,
    prefix: Optional[str] = None,
) -> Optional[str]:
    for path in preferred:
        if path in files:
            return path
    matches = [
        path for path in files
        if (suffix is None or path.endswith(suffix)) and (prefix is None or path.startswith(prefix))
    ]
    return sorted(matches)[0] if matches else None


def _toml_section(text: str, section: str) -> bool:
    return re.search(rf"(?m)^\s*\[{re.escape(section)}(?:\.|\])", text) is not None


def _candidate_for(
    files: Mapping[str, str],
    *,
    ecosystem: Ecosystem,
    manager: ManagerId,
    manifest_names: Sequence[str],
    lockfile_names: Sequence[str] = (),
    manifest_suffixes: Sequence[str] = (),
    lockfile_suffixes: Sequence[str] = (),
) -> Tuple[Optional[_Candidate], Optional[str]]:
    manifests = [path for path in manifest_names if path in files]
    manifests.extend(sorted(path for path in files if any(path.endswith(suffix) for suffix in manifest_suffixes)))
    manifests = sorted(set(manifests))
    if not manifests:
        return None, None
    if len(manifests) > 1 and not manifest_suffixes:
        return None, f"multiple {manager.value} manifests detected"
    manifest = manifests[0]
    lockfile = next((path for path in lockfile_names if path in files), None)
    if lockfile is None and lockfile_suffixes:
        lockfile = _first_path(files, suffix=lockfile_suffixes[0])
    return _Candidate(ecosystem, manager, manifest, lockfile), None


def _rust_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    return _candidate_for(files, ecosystem=Ecosystem.RUST, manager=ManagerId.CARGO, manifest_names=("Cargo.toml",), lockfile_names=("Cargo.lock",))


def _go_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    return _candidate_for(files, ecosystem=Ecosystem.GO, manager=ManagerId.GO_MODULES, manifest_names=("go.mod",), lockfile_names=("go.sum",))


def _ruby_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    return _candidate_for(files, ecosystem=Ecosystem.RUBY, manager=ManagerId.BUNDLER, manifest_names=("Gemfile",), lockfile_names=("Gemfile.lock",))


def _php_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    return _candidate_for(files, ecosystem=Ecosystem.PHP, manager=ManagerId.COMPOSER, manifest_names=("composer.json",), lockfile_names=("composer.lock",))


def _java_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    if "pom.xml" in files and ("build.gradle" in files or "build.gradle.kts" in files):
        return None, "both Maven and Gradle manifests detected"
    if "pom.xml" in files:
        return _Candidate(Ecosystem.JAVA, ManagerId.MAVEN, "pom.xml", None), None
    gradle = [path for path in ("build.gradle", "build.gradle.kts") if path in files]
    if gradle:
        lockfile = "gradle.lockfile" if "gradle.lockfile" in files else None
        return _Candidate(Ecosystem.JAVA, ManagerId.GRADLE, gradle[0], lockfile), None
    return None, None


def _dotnet_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    manifests = sorted(path for path in files if path.endswith((".csproj", ".fsproj", ".vbproj")))
    if not manifests:
        return None, None
    manifest = manifests[0]
    lockfile = "packages.lock.json" if "packages.lock.json" in files else None
    return _Candidate(Ecosystem.DOTNET, ManagerId.DOTNET, manifest, lockfile), None


def _elixir_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    return _candidate_for(files, ecosystem=Ecosystem.ELIXIR, manager=ManagerId.MIX, manifest_names=("mix.exs",), lockfile_names=("mix.lock",))


def _dart_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    return _candidate_for(files, ecosystem=Ecosystem.DART, manager=ManagerId.PUB, manifest_names=("pubspec.yaml",), lockfile_names=("pubspec.lock",))


def _swift_candidate(files: Mapping[str, str]) -> Tuple[Optional[_Candidate], Optional[str]]:
    lockfile = next((path for path in ("Package.resolved", ".swiftpm/Package.resolved") if path in files), None)
    if "Package.swift" not in files:
        return None, None
    return _Candidate(Ecosystem.SWIFT, ManagerId.SPM, "Package.swift", lockfile), None


__all__ = [
    "Command",
    "CommandPlan",
    "AdapterCapability",
    "ADAPTER_PROFILE_IDS",
    "CARGO_ADAPTER_PROFILE",
    "DependencyManagerSnapshot",
    "DetectionResult",
    "DetectionStatus",
    "Ecosystem",
    "FileSnapshot",
    "ManagerId",
    "NPM_ADAPTER_PROFILE",
    "PNPM_ADAPTER_PROFILE",
    "RepositorySnapshot",
    "SupportedDetection",
    "UnsupportedDetection",
    "detect",
    "detect_dependency_manager",
    "detect_manager",
    "node_adapter_can_observe",
    "node_adapter_capability",
    "node_adapter_has_managed_execution",
]
