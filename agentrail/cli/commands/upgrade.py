"""
``agentrail upgrade`` — native Python port of the legacy bash ``run_upgrade``
+ Node template-sync logic.

Faithfully ports:
- Inventory build (templates/ + skills/ roots, hiddenTemplatePrefix, skipPatterns,
  extraFiles).
- state.json read + per-item categorize/installStatus/finalHash logic (exact match
  of legacy JS lines ~302-368).
- state.json write with defaultWorkflow merge.
- config.json write when missing or --force.
- .agentrail/source materialization (bash section ~470-485).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def _now_iso(injected: Optional[str] = None) -> str:
    """Return UTC ISO timestamp with milliseconds and Z suffix, matching JS new Date().toISOString()."""
    if injected is not None:
        return injected
    dt = datetime.now(timezone.utc)
    millis = dt.microsecond // 1000
    return dt.strftime(f"%Y-%m-%dT%H:%M:%S.{millis:03d}Z")


def _sha256_file(path: Path) -> str:
    import hashlib
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _walk_files_sorted(root: Path) -> List[Path]:
    """Recursively walk directory, returning sorted list of files (not dirs)."""
    results: List[Path] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.is_dir():
            results.extend(_walk_files_sorted(entry))
        elif entry.is_file():
            results.append(entry)
    return results


def _copy_file(source: Path, dest: Path) -> None:
    """Copy source to dest, preserving mode bits (executables stay executable)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    mode = source.stat().st_mode & 0o777
    os.chmod(dest, mode)


# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

class UsageError(Exception):
    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


def parse_upgrade_args(args: List[str]):
    target = os.getcwd()
    force = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            if i + 1 >= len(args) or not args[i + 1] or args[i + 1].startswith("--"):
                raise UsageError("--target requires a directory")
            target = args[i + 1]
            i += 2
        elif a == "--force":
            force = True
            i += 1
        elif a in ("-h", "--help"):
            _print_usage()
            raise UsageError("", code=0)
        else:
            raise UsageError(f"Unknown option: {a}")
    return target, force


def _print_usage() -> None:
    print("Usage: agentrail upgrade [--target DIR] [--force]")


# ---------------------------------------------------------------------------
# Skip patterns (exact from legacy)
# ---------------------------------------------------------------------------

_SKIP_PATTERNS = [
    re.compile(r"^TASTE\.md$"),
    re.compile(r"^docs[/\\]memory[/\\]"),
    re.compile(r"^docs[/\\]prd[/\\]context-engine\.md$"),
    re.compile(r"^\.claude[/\\]agents[/\\]"),
    re.compile(r"^\.codex[/\\]agents[/\\]"),
]

_HIDDEN_TEMPLATE_PREFIX = "scripts" + os.sep  # "scripts/" on unix


def _should_skip(relative_to_root: str) -> bool:
    return any(pat.search(relative_to_root) for pat in _SKIP_PATTERNS)


# ---------------------------------------------------------------------------
# Default config / workflow literals (VERBATIM from legacy lines ~370-464)
# ---------------------------------------------------------------------------

DEFAULT_WORKFLOW: Dict[str, Any] = {
    "phase": "idle",
    "activePhase": None,
    "activeIssue": None,
    "activePullRequest": None,
    "activePrd": None,
    "activeMilestone": None,
    "activeRun": None,
    "completedRuns": [],
    "goals": [],
    "worktrees": [],
    "lastCompletedStep": None,
    "nextSuggestedAction": "Pick a ready-for-agent issue or create a PRD/milestone before starting implementation.",
}

DEFAULT_CONFIG: Dict[str, Any] = {
    "schemaVersion": 1,
    "runner": {
        "name": "codex",
        "command": "codex exec --sandbox danger-full-access -",
    },
    "context": {
        "includeGlobs": ["**/*"],
        "excludeGlobs": [
            ".git/**",
            "node_modules/**",
            "dist/**",
            "build/**",
            ".next/**",
            "target/**",
            "coverage/**",
            ".cache/**",
            ".turbo/**",
            ".agentrail/context/**",
            ".agentrail/source/**",
            ".env",
            ".env.*",
            "**/.env",
            "**/.env.*",
            "**/*.pem",
            "**/*.key",
            "**/*credentials*",
            "**/*secret*",
        ],
        "maxFileSizeBytes": 262144,
        "skipBinary": True,
        "respectGitIgnore": True,
        "secretRedaction": {
            "enabled": True,
            "action": "exclude",
            "denyGlobs": [
                ".env",
                ".env.*",
                "**/.env",
                "**/.env.*",
                "**/*.pem",
                "**/*.key",
                "**/*credentials*",
                "**/*secret*",
            ],
        },
        "embedding": {
            "mode": "disabled",
            "provider": None,
            "model": None,
        },
        "summary": {
            "mode": "disabled",
            "provider": None,
            "model": None,
        },
        "externalSources": [],
    },
}


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def _build_inventory(repo_dir: Path) -> List[Dict[str, Any]]:
    """Build the managed file inventory (templates + skills roots + extraFiles)."""
    roots = [
        (repo_dir / "templates", ""),
        (repo_dir / "skills", "skills"),
    ]
    inventory: List[Dict[str, Any]] = []

    for root, prefix in roots:
        if not root.is_dir():
            continue
        for source_path in _walk_files_sorted(root):
            relative_to_root = source_path.relative_to(root)
            relative_to_root_str = str(relative_to_root)  # os-native separators

            if not prefix:
                # hidden: anything under scripts/
                if relative_to_root_str.startswith(_HIDDEN_TEMPLATE_PREFIX):
                    continue
                # skip patterns use the os-native string (legacy uses relativeToRoot directly)
                if _should_skip(relative_to_root_str):
                    continue

            # managedPath: prefix joined with relativeToRoot, converted to posix
            if prefix:
                managed_path = (Path(prefix) / relative_to_root).as_posix()
            else:
                managed_path = relative_to_root.as_posix()

            source_posix = source_path.relative_to(repo_dir).as_posix()

            inventory.append({
                "path": managed_path,
                "source": source_posix,
                "sourcePath": source_path,
                "sourceHash": _sha256_file(source_path),
            })

    # extraFiles
    extra_source = repo_dir / "scripts" / "agentrail"
    inventory.append({
        "path": "scripts/agentrail",
        "source": extra_source.relative_to(repo_dir).as_posix(),
        "sourcePath": extra_source,
        "sourceHash": _sha256_file(extra_source),
    })

    return inventory


def _categorize_item(
    item: Dict[str, Any],
    previous: Optional[Dict[str, Any]],
    legacy_adopted_state: bool,
    force: bool,
    target_dir: Path,
) -> tuple:
    """
    Reproduce legacy lines ~302-368 exactly.
    Returns (category, install_status, should_copy).
    """
    target_path = target_dir / item["path"]
    target_exists = target_path.exists()
    current_hash = _sha256_file(target_path) if target_exists else None
    source_hash = item["sourceHash"]

    user_owned = bool(
        previous and (
            previous.get("installStatus") == "legacy-adopted"
            or (previous.get("installStatus") == "preserved" and legacy_adopted_state)
        )
    )

    category = "unchanged"
    install_status = (previous.get("installStatus") if previous else None) or "preserved"
    should_copy = False

    if not previous:
        category = "added"
        if target_exists and current_hash != source_hash and not force:
            install_status = "legacy-adopted"
        else:
            install_status = "added"
        should_copy = (not target_exists) or force or (current_hash == source_hash)
    elif not target_exists:
        category = "missing"
        install_status = "restored"
        should_copy = True
    elif user_owned and source_hash != previous.get("contentHash"):
        category = "locally modified"
        install_status = "forced" if force else "preserved"
        should_copy = force
    elif current_hash != previous.get("contentHash") and current_hash != source_hash:
        category = "locally modified"
        install_status = "forced" if force else "preserved"
        should_copy = force
    elif source_hash != previous.get("contentHash"):
        category = "changed"
        install_status = "updated"
        should_copy = True
    # else: unchanged — keep defaults

    return category, install_status, should_copy


def _process_item(
    item: Dict[str, Any],
    previous: Optional[Dict[str, Any]],
    legacy_adopted_state: bool,
    force: bool,
    target_dir: Path,
) -> Dict[str, Any]:
    """Process a single inventory item: print, copy if needed, build next managed record."""
    target_path = target_dir / item["path"]
    source_path: Path = item["sourcePath"]

    category, install_status, should_copy = _categorize_item(
        item, previous, legacy_adopted_state, force, target_dir
    )

    # Print category line (when not unchanged)
    if category != "unchanged":
        print(f"{category}: {item['path']}")

    if should_copy:
        _copy_file(source_path, target_path)
        if install_status == "forced":
            print(f"forced: {item['path']}")
        elif install_status == "restored":
            print(f"restored: {item['path']}")
        elif install_status == "updated":
            print(f"updated: {item['path']}")
        else:
            print(f"installed: {item['path']}")
    elif category == "locally modified":
        print(f"preserved local: {item['path']}")
    elif category == "added":
        print(f"preserved existing untracked: {item['path']}")

    # Compute finalHash
    if category == "locally modified" and not force and previous:
        final_hash = previous.get("contentHash")
    else:
        final_hash = _sha256_file(target_path) if target_path.exists() else item["sourceHash"]

    return {
        "path": item["path"],
        "source": item["source"],
        "contentHash": final_hash,
        "installStatus": install_status,
    }


def _materialize_source(repo_dir: Path, target_dir: Path) -> None:
    """
    Bash section ~470-485: copy repo contents into .agentrail/source unless
    target/.agentrail/source IS the repo_dir (dogfooding guard).
    """
    source_support_dir = target_dir / ".agentrail" / "source"
    source_support_dir.mkdir(parents=True, exist_ok=True)

    try:
        repo_real = repo_dir.resolve()
        source_real = source_support_dir.resolve()
    except OSError:
        repo_real = repo_dir
        source_real = source_support_dir

    if repo_real == source_real:
        return

    scripts_dir = source_support_dir / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)

    # Copy package.json + 3 scripts; chmod +x the scripts
    shutil.copy2(repo_dir / "package.json", source_support_dir / "package.json")
    for script_name in ("agentrail", "install-workflow"):
        src = repo_dir / "scripts" / script_name
        dst = scripts_dir / script_name
        if src.exists():
            shutil.copy2(src, dst)
            dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # rm -rf then cp -R for templates, skills, agentrail
    for dir_name in ("templates", "skills", "agentrail"):
        dst = source_support_dir / dir_name
        if dst.exists():
            shutil.rmtree(dst)
        src = repo_dir / dir_name
        if src.exists():
            shutil.copytree(src, dst)

    print("updated: .agentrail/source")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_upgrade(args: List[str], *, _now: Optional[str] = None) -> int:
    """
    Native Python port of ``run_upgrade`` from scripts/agentrail-legacy.
    Returns exit code (0 = success, 1 = error, 2 = usage).
    """
    try:
        target_str, force = parse_upgrade_args(args)
    except UsageError as exc:
        if str(exc):
            print(str(exc), file=sys.stderr)
        return exc.code

    target_dir = Path(target_str).resolve()
    repo_dir = _repo_dir()

    # Read package.json version
    pkg_path = repo_dir / "package.json"
    try:
        pkg_version = json.loads(pkg_path.read_text())["version"]
    except (OSError, KeyError, ValueError):
        pkg_version = "0.0.0"

    # Read state.json
    state_path = target_dir / ".agentrail" / "state.json"
    if not state_path.exists():
        print(
            "missing .agentrail/state.json; run agentrail init first",
            file=sys.stderr,
        )
        return 1

    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError) as exc:
        print(f"failed to read state.json: {exc}", file=sys.stderr)
        return 1

    if not isinstance(state.get("managedFiles"), list):
        print(
            "invalid .agentrail/state.json: managedFiles must be an array",
            file=sys.stderr,
        )
        return 1

    previous_by_path: Dict[str, Dict[str, Any]] = {
        f["path"]: f for f in state["managedFiles"] if isinstance(f, dict) and "path" in f
    }
    legacy_adopted_state = bool(state.get("legacyAdopted"))

    # Build inventory
    try:
        inventory = _build_inventory(repo_dir)
    except OSError as exc:
        print(f"failed to build inventory: {exc}", file=sys.stderr)
        return 1

    now = _now_iso(_now)

    print(f"AgentRail upgrade: {target_dir}")

    next_managed_files: List[Dict[str, Any]] = []
    for item in inventory:
        previous = previous_by_path.get(item["path"])
        record = _process_item(item, previous, legacy_adopted_state, force, target_dir)
        next_managed_files.append(record)

    # Build nextState
    existing_workflow = state.get("workflow") or {}
    next_workflow = {
        **DEFAULT_WORKFLOW,
        **existing_workflow,
        "completedRuns": (
            existing_workflow.get("completedRuns")
            if isinstance(existing_workflow.get("completedRuns"), list)
            else []
        ),
        "goals": (
            existing_workflow.get("goals")
            if isinstance(existing_workflow.get("goals"), list)
            else []
        ),
        "worktrees": (
            existing_workflow.get("worktrees")
            if isinstance(existing_workflow.get("worktrees"), list)
            else []
        ),
    }

    next_state: Dict[str, Any] = {
        "schemaVersion": 1,
        "agentrailVersion": pkg_version,
        "installedAt": state.get("installedAt") or now,
        "updatedAt": now,
        "legacyAdopted": bool(state.get("legacyAdopted")),
        "managedFiles": next_managed_files,
        "workflow": next_workflow,
    }

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(next_state, indent=2) + "\n")
    print("updated: .agentrail/state.json")

    # Write config.json if missing or forced
    config_path = target_dir / ".agentrail" / "config.json"
    if not config_path.exists() or force:
        config_path.write_text(json.dumps(DEFAULT_CONFIG, indent=2) + "\n")
        print("updated: .agentrail/config.json")

    # Materialize .agentrail/source
    _materialize_source(repo_dir, target_dir)

    return 0
