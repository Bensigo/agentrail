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
import shutil
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

# Reused from install.py: the skills copy into .claude/skills/ is always-safe
# to refresh (shipped/packaged content, D2 harness exception), and the hook
# script writer / settings merge are split so upgrade can write the hook
# script only when missing (never clobbering a customized
# .agentrail/hooks/context-first.sh) while still merging the settings.json
# wiring unconditionally (that merge is already idempotent-safe).
from agentrail.cli.commands.install import (  # noqa: F401  (re-exported for patching/tests)
    _install_claude_skills,
    _merge_claude_hook_settings,
    _write_claude_hook_script,
)

# ---------------------------------------------------------------------------
# Legacy-layout migration (repo-structure-v2, PR-6 / #1137)
#
# ``agentrail upgrade`` physically moves legacy-layout files into
# ``.agentrail/`` (D4). This is intentionally conservative: a destination that
# already exists is left alone and the legacy source is left in place too, so
# ``doctor`` keeps flagging it for manual reconciliation rather than silently
# losing either copy. Hash-tracked content (docs/agents/*, CONTEXT.md) has its
# matching ``state["managedFiles"]`` path entry remapped in place *before* the
# existing template-sync loop runs, so the loop's hash-diff categorization
# naturally treats a moved-but-unmodified file as "unchanged" at its new
# location, and a moved-but-locally-modified file as "locally modified"
# (preserved), rather than as brand-new "added" content. Skip-patterned
# content (TASTE.md, docs/memory/*) was never tracked in state.json, so those
# moves are plain filesystem moves with no state remap.
# ---------------------------------------------------------------------------

# (legacy_root_rel, house2_root_rel) pairs for directory subtrees that move
# under House 2. Order matters only for readability; each is independent.
_LEGACY_DIR_MIGRATIONS = (
    ("docs/agents", ".agentrail/agents"),
    ("docs/memory", ".agentrail/memory"),
)

# (legacy_rel, house2_rel) pairs for single files that move under House 2.
_LEGACY_FILE_MIGRATIONS = (
    ("CONTEXT.md", ".agentrail/context.md"),
    ("TASTE.md", ".agentrail/taste.md"),
)

# Legacy top-level path prefix that House 2 dedupes away entirely once the
# canonical .agentrail/skills/ copy exists (design doc §5: "single skills
# copy (was top-level skills/ + .claude/skills dupe)"). Dropping this from
# the *inventory build* for fresh installs is PR-8's job; here we only stop
# `upgrade` from re-creating/tracking it and physically fold any content
# into .agentrail/skills/ so nothing is silently lost. Note this prefix does
# NOT match ".agentrail/skills/" (different leading path segment), so a plain
# ``str.startswith`` check safely distinguishes the two without extra logic.
_LEGACY_SKILLS_PREFIX = "skills/"


def _move_file_if_absent(legacy_path: Path, house2_path: Path) -> bool:
    """Move *legacy_path* to *house2_path* iff house2_path does not exist yet.

    Never overwrites an existing House-2 destination — that is left for a
    human/doctor to reconcile. Returns True iff a move happened.
    """
    if not legacy_path.exists() or house2_path.exists():
        return False
    house2_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(legacy_path), str(house2_path))
    return True


def _remap_managed_path(managed_files: List[Dict[str, Any]], old_path: str, new_path: str) -> None:
    """Rewrite a managedFiles entry's ``path`` key in place, old -> new.

    This lets the existing hash-diff categorization logic in
    ``_categorize_item`` re-derive unchanged/changed/locally-modified status
    for the file at its new location, instead of treating a moved file as
    brand-new content.
    """
    for entry in managed_files:
        if isinstance(entry, dict) and entry.get("path") == old_path:
            entry["path"] = new_path


def _migrate_legacy_layout(target_dir: Path, state: Dict[str, Any]) -> None:
    """Physically migrate legacy-layout files into ``.agentrail/`` (D4).

    Mutates ``state["managedFiles"]`` in place to remap path keys for moved
    hash-tracked content. Must run BEFORE ``previous_by_path`` is built from
    ``state`` and BEFORE the inventory sync loop, so both see the
    post-migration paths.
    """
    managed_files = state.get("managedFiles")
    if not isinstance(managed_files, list):
        managed_files = []

    # --- CONTEXT.md / TASTE.md (single files) ---
    for legacy_rel, house2_rel in _LEGACY_FILE_MIGRATIONS:
        legacy_path = target_dir / legacy_rel
        house2_path = target_dir / house2_rel
        if _move_file_if_absent(legacy_path, house2_path):
            print(f"migrated: {legacy_rel} -> {house2_rel}")
            _remap_managed_path(managed_files, legacy_rel, house2_rel)

    # --- docs/agents/* -> .agentrail/agents/*, docs/memory/* -> .agentrail/memory/* ---
    for legacy_root_rel, house2_root_rel in _LEGACY_DIR_MIGRATIONS:
        legacy_root = target_dir / legacy_root_rel
        if not legacy_root.is_dir():
            continue
        house2_root = target_dir / house2_root_rel
        for source_path in _walk_files_sorted(legacy_root):
            rel = source_path.relative_to(legacy_root).as_posix()
            legacy_file_rel = f"{legacy_root_rel}/{rel}"
            house2_file_rel = f"{house2_root_rel}/{rel}"
            dest_path = house2_root / rel
            if _move_file_if_absent(source_path, dest_path):
                print(f"migrated: {legacy_file_rel} -> {house2_file_rel}")
                _remap_managed_path(managed_files, legacy_file_rel, house2_file_rel)

        # Clean up now-empty legacy directory trees (leave non-empty ones —
        # a conflicting file was left behind for manual reconciliation).
        _prune_empty_dirs(legacy_root)

    # --- skills/ dedupe: fold any content not already at .agentrail/skills/
    #     into the House-2 location, then drop the legacy top-level copy. ---
    legacy_skills_root = target_dir / "skills"
    if legacy_skills_root.is_dir():
        house2_skills_root = target_dir / ".agentrail" / "skills"
        for source_path in _walk_files_sorted(legacy_skills_root):
            rel = source_path.relative_to(legacy_skills_root).as_posix()
            dest_path = house2_skills_root / rel
            if not dest_path.exists():
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source_path), str(dest_path))
                print(f"migrated: skills/{rel} -> .agentrail/skills/{rel}")
        # Whatever remains is an exact duplicate of shipped content that the
        # inventory loop is about to (re)write to .agentrail/skills/ anyway —
        # skills are packaged/shipped content (D2), safe to drop the legacy
        # top-level copy entirely now that everything unique has been folded in.
        shutil.rmtree(legacy_skills_root)
        print("removed legacy skills/ directory (deduped into .agentrail/skills/)")

    state["managedFiles"] = [
        entry for entry in managed_files
        if not (
            isinstance(entry, dict)
            and isinstance(entry.get("path"), str)
            and entry["path"].startswith(_LEGACY_SKILLS_PREFIX)
        )
    ]


def _prune_empty_dirs(root: Path) -> None:
    """Remove *root* and any now-empty subdirectories, bottom-up.

    Leaves *root* in place if any file remains anywhere under it (a
    conflicting destination was left behind during migration).
    """
    if not root.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(str(root), topdown=False):
        if filenames:
            continue
        p = Path(dirpath)
        try:
            p.rmdir()
        except OSError:
            pass

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

    # Physically migrate legacy-layout files into .agentrail/ (D4). Must run
    # before previous_by_path is built so the hash-diff loop below sees
    # managedFiles path keys already remapped to their House-2 locations.
    _migrate_legacy_layout(target_dir, state)

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

    # House-2 dedupe (D5/D2): `upgrade` never (re)creates the legacy top-level
    # skills/ copy — only .agentrail/skills/ is the canonical location going
    # forward. Dropping this from the shared inventory builder itself for
    # fresh installs is PR-8's job; here we just filter upgrade's own view of
    # the inventory so re-running upgrade can't resurrect what
    # _migrate_legacy_layout just deduped away.
    inventory = [
        item for item in inventory
        if not (isinstance(item.get("path"), str) and item["path"].startswith(_LEGACY_SKILLS_PREFIX))
    ]

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

    # .claude/ harness wiring (D2's two exceptions): write the hook script
    # only if missing (force=False — never clobber a customized
    # .agentrail/hooks/context-first.sh), always merge the settings.json
    # wiring (idempotent-safe), and always refresh the .claude/skills/ copy
    # (shipped/packaged content, safe to overwrite per install.py's own
    # behavior).
    _write_claude_hook_script(repo_dir, target_dir, force=False)
    _merge_claude_hook_settings(target_dir)
    _install_claude_skills(repo_dir, target_dir)

    return 0
