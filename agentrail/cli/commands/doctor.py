"""
``agentrail doctor`` — native Python port of the legacy bash ``run_doctor``.

Performs read-only diagnostics and produces output that matches the legacy
``agentrail-legacy doctor`` section headers and wording.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _repo_dir() -> Path:
    """Lazy wrapper: return the agentrail source repository root."""
    return Path(__file__).resolve().parents[3]


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail doctor [--target DIR]\n"
        "\n"
        "Options:\n"
        "  --target DIR   Project directory to inspect (default: cwd)\n"
        "  -h, --help     Show this help\n"
    )


def _sha256(path: Path) -> str:
    """Return ``sha256:<hexdigest>`` for *path*."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{digest}"


# ---------------------------------------------------------------------------
# parse_target
# ---------------------------------------------------------------------------

def _parse_target(args: List[str]) -> str:
    """Parse ``--target DIR`` / ``-h`` / ``--help``; return target directory."""
    target = os.getcwd()
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            value = args[i + 1] if (i + 1 < len(args) and not args[i + 1].startswith("--")) else ""
            if not value:
                print("--target requires a directory", file=sys.stderr)
                raise SystemExit(2)
            target = value
            i += 2
        elif a in ("-h", "--help"):
            print(_usage())
            raise SystemExit(0)
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            print(_usage(), file=sys.stderr)
            raise SystemExit(2)
    return target


# ---------------------------------------------------------------------------
# resolve_api_key / has_api_key
# ---------------------------------------------------------------------------

def resolve_api_key(target_dir: str) -> Optional[str]:
    """Return the API key string or None.

    Checks env AGENTRAIL_API_KEY first, then
    ``<target_dir>/.agentrail/config.json`` ``apiKey`` field.
    """
    key = os.environ.get("AGENTRAIL_API_KEY", "").strip()
    if key:
        return key
    config_file = Path(target_dir) / ".agentrail" / "config.json"
    if config_file.is_file():
        try:
            data = json.loads(config_file.read_text())
            api_key = data.get("apiKey", "")
            if api_key and isinstance(api_key, str):
                return api_key
        except (json.JSONDecodeError, OSError):
            pass
    return None


def has_api_key(target_dir: str) -> bool:
    return resolve_api_key(target_dir) is not None


# ---------------------------------------------------------------------------
# inspect_state — pure-Python port of the Node.js logic
# ---------------------------------------------------------------------------

OPTIONAL_MANAGED_PATHS: frozenset = frozenset(["TASTE.md"])


@dataclass
class StateResult:
    state_status: str = "missing"          # "missing" | "ok" | "invalid"
    state_error: str = ""                  # error message when invalid
    version_status: str = ""               # "" | "ok" | "outdated"
    state_version: str = ""               # agentrailVersion from state
    state_shape_errors: List[str] = field(default_factory=list)
    hash_mismatches: List[str] = field(default_factory=list)
    source_mismatches: List[str] = field(default_factory=list)
    missing_managed: List[str] = field(default_factory=list)
    optional_missing: List[str] = field(default_factory=list)
    optional_modified: List[str] = field(default_factory=list)
    hashes_ok: bool = False
    source_hashes_ok: bool = False
    source_pkg_missing: Optional[str] = None  # path when package.json not found


def inspect_state(target_dir: str, repo_dir: Path) -> StateResult:
    result = StateResult()

    # Read currentVersion from repo package.json
    pkg_path = repo_dir / "package.json"
    current_version = ""
    if pkg_path.is_file():
        try:
            current_version = json.loads(pkg_path.read_text()).get("version", "")
        except (json.JSONDecodeError, OSError):
            pass
    else:
        result.source_pkg_missing = str(pkg_path)

    # Read state.json
    state_path = Path(target_dir) / ".agentrail" / "state.json"
    if not state_path.exists():
        result.state_status = "missing"
        return result

    try:
        state = json.loads(state_path.read_text())
    except (json.JSONDecodeError, ValueError) as exc:
        result.state_status = "invalid"
        result.state_error = str(exc)
        return result

    result.state_status = "ok"

    if not isinstance(state.get("managedFiles"), list):
        result.state_shape_errors.append("managedFiles must be an array")
        return result

    # Version check
    if current_version:
        if state.get("agentrailVersion") == current_version:
            result.version_status = "ok"
        else:
            result.version_status = "outdated"
            result.state_version = state.get("agentrailVersion") or ""

    hash_mismatch = False
    source_mismatch = False
    missing_managed = False

    for file_entry in state["managedFiles"]:
        if not file_entry or not isinstance(file_entry.get("path"), str) or not isinstance(file_entry.get("contentHash"), str):
            result.state_shape_errors.append("managedFiles entries require path and contentHash")
            continue

        file_path = file_entry["path"]
        content_hash = file_entry["contentHash"]
        target_path = Path(target_dir) / file_path

        if not target_path.exists():
            if file_path in OPTIONAL_MANAGED_PATHS:
                result.optional_missing.append(file_path)
                continue
            missing_managed = True
            result.missing_managed.append(file_path)
            continue

        current_hash = _sha256(target_path)
        if current_hash != content_hash:
            if file_path in OPTIONAL_MANAGED_PATHS:
                result.optional_modified.append(file_path)
                continue
            hash_mismatch = True
            result.hash_mismatches.append(file_path)

        # Source mismatch check: only if not user-owned
        user_owned = file_entry.get("installStatus") in ("legacy-adopted", "preserved")
        source = file_entry.get("source")
        if not user_owned and isinstance(source, str):
            source_path = repo_dir / source
            if source_path.exists() and _sha256(source_path) != content_hash:
                source_mismatch = True
                result.source_mismatches.append(file_path)

    result.hashes_ok = not hash_mismatch and not missing_managed
    result.source_hashes_ok = not source_mismatch

    return result


# ---------------------------------------------------------------------------
# print_path_status
# ---------------------------------------------------------------------------

def _print_path_status(target_dir: str, label: str, path: str, kind: str) -> bool:
    """Print "  ok <label>" or "  missing <label>". Returns True if present."""
    full_path = Path(target_dir) / path
    if kind == "file":
        present = full_path.is_file()
    elif kind == "dir":
        present = full_path.is_dir()
    elif kind == "executable":
        present = full_path.exists() and os.access(str(full_path), os.X_OK)
    else:
        present = full_path.exists()

    if present:
        print(f"  ok {label}")
    else:
        print(f"  missing {label}")
    return present


# ---------------------------------------------------------------------------
# validate_skill_registry — pure-Python port
# ---------------------------------------------------------------------------

REQUIRED_SKILL_SECTIONS = [
    "## Activation Guidance",
    "## Context To Inspect",
    "## Constraints",
    "## Verification Requirements",
    "## Expected PR Evidence",
    "## Provenance / Audit",
]


def _is_non_empty_string(value) -> bool:
    return isinstance(value, str) and len(value.strip()) > 0


def _is_string_array(value) -> bool:
    return isinstance(value, list) and all(_is_non_empty_string(v) for v in value)


def _is_safe_relative_path(value) -> bool:
    if not _is_non_empty_string(value):
        return False
    if os.path.isabs(value):
        return False
    parts = value.replace("\\", "/").split("/")
    if ".." in parts:
        return False
    return value.endswith("/SKILL.md")


@dataclass
class SkillRegistryResult:
    ok: bool = False
    errors: List[str] = field(default_factory=list)
    registry_path: str = ""


def validate_skill_registry(target_dir: str, repo_dir: Path) -> SkillRegistryResult:
    result = SkillRegistryResult()
    errors = result.errors

    installed_registry = Path(target_dir) / "docs" / "agents" / "skill-registry.json"
    source_registry = repo_dir / "templates" / "docs" / "agents" / "skill-registry.json"

    # Mirror legacy logic: if installed doesn't exist AND target==repo → use source
    validate_source = (
        not installed_registry.exists()
        and Path(target_dir).resolve() == repo_dir.resolve()
    )
    registry_path = source_registry if validate_source else installed_registry
    skill_root = repo_dir if validate_source else Path(target_dir)

    try:
        registry = json.loads(registry_path.read_text())
    except FileNotFoundError as exc:
        errors.append(f"cannot read registry: {exc}")
        result.ok = False
        return result
    except (json.JSONDecodeError, OSError) as exc:
        errors.append(f"cannot read registry: {exc}")
        result.ok = False
        return result

    result.registry_path = str(registry_path)

    if registry is None or not isinstance(registry, dict):
        errors.append("registry root must be an object")
        result.ok = len(errors) == 0
        return result

    if registry.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")

    skills = registry.get("skills")
    if not isinstance(skills, list):
        errors.append("skills must be an array")
    else:
        names: set = set()
        for index, skill in enumerate(skills):
            label = skill.get("name") if (skill and _is_non_empty_string(skill.get("name"))) else f"entry {index}"

            if not skill or not isinstance(skill, dict):
                errors.append(f"{label}: skill entry must be an object")
                continue

            for field_name in ["name", "localPath", "description", "licenseStatus", "auditStatus"]:
                if not _is_non_empty_string(skill.get(field_name)):
                    errors.append(f"{label}: missing required field {field_name}")

            if _is_non_empty_string(skill.get("name")):
                if skill["name"] in names:
                    errors.append(f"{skill['name']}: duplicate skill name")
                names.add(skill["name"])

            if not isinstance(skill.get("bundledByDefault"), bool):
                errors.append(f"{label}: bundledByDefault must be boolean")

            local_path = skill.get("localPath", "")
            if not _is_safe_relative_path(local_path):
                errors.append(f"{label}: invalid localPath")
            else:
                full_skill_path = skill_root / local_path
                if not full_skill_path.exists():
                    errors.append(f"{label}: localPath does not exist: {local_path}")
                else:
                    skill_body = full_skill_path.read_text()
                    for section in REQUIRED_SKILL_SECTIONS:
                        if section not in skill_body:
                            errors.append(f"{label}: missing SKILL.md section {section}")

            triggers = skill.get("triggers")
            if not triggers or not isinstance(triggers, dict):
                errors.append(f"{label}: triggers must be an object")
            else:
                trigger_count = 0
                for key in ["keywords", "fileGlobs", "projectSignals"]:
                    if key not in triggers:
                        errors.append(f"{label}: triggers.{key} is required")
                    elif not _is_string_array(triggers[key]):
                        errors.append(f"{label}: triggers.{key} must be an array of non-empty strings")
                    else:
                        trigger_count += len(triggers[key])
                if trigger_count == 0:
                    errors.append(f"{label}: triggers must include at least one trigger")

            provenance = skill.get("provenance")
            if not provenance or not isinstance(provenance, dict):
                errors.append(f"{label}: provenance must be an object")
            else:
                candidates = provenance.get("candidates")
                if not isinstance(candidates, list) or len(candidates) == 0:
                    errors.append(f"{label}: provenance.candidates must be a non-empty array")
                else:
                    for ci, candidate in enumerate(candidates):
                        clabel = f"{label}: provenance.candidates[{ci}]"
                        for field_name in ["sourceName", "url", "relationship", "verifiedStatus", "auditNotes"]:
                            if not _is_non_empty_string(candidate.get(field_name) if candidate else None):
                                errors.append(f"{clabel} missing {field_name}")
                        if candidate and candidate.get("autoInstall") is True:
                            errors.append(f"{clabel} must not be marked autoInstall")

    result.ok = len(errors) == 0
    return result


# ---------------------------------------------------------------------------
# check_github_labels
# ---------------------------------------------------------------------------

REQUIRED_LABELS = [
    "ready-for-agent",
    "afk",
    "afk-in-progress",
    "review-fix",
    "memory-suggestion",
    "pr-reviewed",
]


def _remote_is_github(target_dir: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", target_dir, "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=False,
        )
        return "github.com" in result.stdout
    except OSError:
        return False


def check_github_labels(target_dir: str) -> None:
    print("github:")
    gh_available = bool(subprocess.run(
        ["which", "gh"], capture_output=True, check=False
    ).returncode == 0)

    if not gh_available or not _remote_is_github(target_dir):
        print("  skipped no connected GitHub repo")
        return

    try:
        result = subprocess.run(
            ["gh", "label", "list", "--limit", "200", "--json", "name"],
            capture_output=True,
            text=True,
            check=False,
            cwd=target_dir,
        )
        if result.returncode != 0:
            print("  warn could not read GitHub labels")
            return
        labels_data = json.loads(result.stdout)
        labels = {entry["name"] for entry in labels_data}
    except (OSError, json.JSONDecodeError):
        print("  warn could not read GitHub labels")
        return

    missing = [lbl for lbl in REQUIRED_LABELS if lbl not in labels]
    if not missing:
        print("  ok GitHub labels")
    else:
        print(f"  warn missing GitHub labels: {', '.join(missing)}")


# ---------------------------------------------------------------------------
# run_doctor
# ---------------------------------------------------------------------------

# Required paths: (label, path, kind)
REQUIRED_PATHS = [
    ("AGENTS.md", "AGENTS.md", "file"),
    ("CONTEXT.md", "CONTEXT.md", "file"),
    ("docs/agents/", "docs/agents", "dir"),
    ("docs/prd/", "docs/prd", "dir"),
    ("docs/milestones/", "docs/milestones", "dir"),
    ("skills/", "skills", "dir"),
    (".agentrail/config.json", ".agentrail/config.json", "file"),
    # #404 Option B: the vendor dir carries only the native package + package.json
    # (the launcher's redirect target). No editable flow scripts are vendored.
    (".agentrail/source/package.json", ".agentrail/source/package.json", "file"),
    (".agentrail/source/agentrail/__init__.py", ".agentrail/source/agentrail/__init__.py", "file"),
    ("docs/agents/skill-registry.json", "docs/agents/skill-registry.json", "file"),
]

LEGACY_SCRIPT_PATHS = [
    "scripts/memory",
    "scripts/afk-workflow",
    "scripts/pr",
    "scripts/ralph-loop",
    "scripts/review-pr",
]


def run_doctor(args: List[str]) -> int:
    try:
        target_dir = _parse_target(args)
    except SystemExit as exc:
        return int(exc.code)

    repo_dir = _repo_dir()

    # --- inspect_state ---
    state = inspect_state(target_dir, repo_dir)

    # Determine if hidden_source_missing (legacy: state not missing but no source package.json)
    hidden_source_missing = False
    if state.source_pkg_missing:
        hidden_source_missing = True
    elif state.state_status != "missing":
        source_pkg = Path(target_dir) / ".agentrail" / "source" / "package.json"
        if not source_pkg.is_file():
            hidden_source_missing = True

    # --- validate_skill_registry (only if state present) ---
    registry_invalid = False
    registry_result: Optional[SkillRegistryResult] = None
    if state.state_status != "missing":
        registry_result = validate_skill_registry(target_dir, repo_dir)
        if not registry_result.ok:
            registry_invalid = True

    # --- Compute overall status ---
    invalid_state = (state.state_status == "invalid") or bool(state.state_shape_errors)
    hash_mismatch = bool(state.hash_mismatches)
    missing_managed = bool(state.missing_managed)
    source_mismatch = bool(state.source_mismatches)

    if invalid_state:
        status = "corrupt"
    elif state.state_status == "missing":
        status = "missing"
    elif registry_invalid:
        status = "corrupt"
    elif hash_mismatch or missing_managed or hidden_source_missing:
        status = "modified"
    elif state.version_status == "outdated" or source_mismatch:
        status = "outdated"
    else:
        status = "installed"

    # --- Output ---
    print(f"AgentRail doctor: {target_dir}")
    print(f"status: {status}")

    # core: section
    print("core:")
    required_missing = False
    for label, path, kind in REQUIRED_PATHS:
        if not _print_path_status(target_dir, label, path, kind):
            required_missing = True

    # TASTE.md — optional
    taste_path = Path(target_dir) / "TASTE.md"
    if taste_path.is_file():
        print("  ok TASTE.md")
    else:
        print("  optional-missing TASTE.md")

    # state: section
    print("state:")
    if state.state_status == "ok":
        print("  ok .agentrail/state.json")
    elif state.state_status == "invalid":
        print("  error invalid .agentrail/state.json")
    else:
        print("  missing .agentrail/state.json")

    if state.version_status == "outdated":
        print("  warn AgentRail version differs from current package")
    elif state.version_status == "ok":
        print("  ok AgentRail version")

    # Hash/source detail lines
    if state.hashes_ok:
        print("  ok managed hashes match")
    if state.source_hashes_ok and state.state_status == "ok":
        print("  ok current package hashes match")

    for path in state.hash_mismatches:
        print(f"  warn hash mismatch: {path}")
    for path in state.source_mismatches:
        print(f"  warn current package mismatch: {path}")
    if state.source_pkg_missing:
        print(f"  warn missing AgentRail source package: {state.source_pkg_missing}")
    for path in state.missing_managed:
        print(f"  warn missing managed file: {path}")
    if state.state_status == "invalid" and state.state_error:
        print(f"  error {state.state_error}")
    for err in state.state_shape_errors:
        print(f"  error {err}")

    # legacy scripts: section
    print("legacy scripts:")
    found_scripts = [
        s for s in LEGACY_SCRIPT_PATHS
        if (Path(target_dir) / s).exists()
    ]
    if found_scripts:
        legacy_scripts = True
        print(f"  warn legacy raw workflow scripts present: {' '.join(found_scripts)}")
    else:
        legacy_scripts = False
        print("  ok no raw workflow scripts in normal project surface")

    # skills: section
    print("skills:")
    if state.state_status == "missing":
        print("  skipped no AgentRail install")
    elif registry_invalid and registry_result is not None:
        for err in registry_result.errors:
            print(f"  error {err}")
    else:
        print("  ok skill registry")

    # dashboard: section
    print("dashboard:")
    if has_api_key(target_dir):
        print("  ok AGENTRAIL_API_KEY configured")
    else:
        print("  info AGENTRAIL_API_KEY not configured (local-only mode — dashboard features disabled)")

    # github: section
    check_github_labels(target_dir)

    # recommendations: section
    print("recommendations:")
    if invalid_state:
        print("  - repair or remove .agentrail/state.json, then rerun install")
    elif registry_invalid:
        print(f"  - repair docs/agents/skill-registry.json or rerun agentrail upgrade --target {target_dir}")
    elif legacy_scripts:
        print("  - remove legacy raw workflow scripts after confirming local edits; use agentrail commands or .agentrail/source for compatibility")
    elif state.state_status == "missing" or required_missing or hidden_source_missing:
        print(f"  - run agentrail install --target {target_dir}")
    elif hash_mismatch or source_mismatch or missing_managed or state.version_status == "outdated":
        print(f"  - run agentrail install --target {target_dir} --force after reviewing local edits")
    else:
        print("  - no blocking action")

    return 0
