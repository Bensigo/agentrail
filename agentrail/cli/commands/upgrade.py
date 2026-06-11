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
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.run.state import write_state

# Shared template-sync engine (also used by install.py).
from agentrail.cli.commands._template_sync import (  # noqa: F401  (re-exported for patching/tests)
    DEFAULT_CONFIG,
    DEFAULT_WORKFLOW,
    _build_inventory,
    _categorize_item,
    _copy_file,
    _materialize_source,
    _process_item,
    _sha256_file,
    _should_skip,
    _walk_files_sorted,
)

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

    write_state(state_path, next_state)
    print("updated: .agentrail/state.json")

    # Write config.json if missing or forced
    config_path = target_dir / ".agentrail" / "config.json"
    if not config_path.exists() or force:
        config_path.write_text(json.dumps(DEFAULT_CONFIG, indent=2) + "\n")
        print("updated: .agentrail/config.json")

    # Materialize .agentrail/source
    _materialize_source(repo_dir, target_dir)

    return 0
