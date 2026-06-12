"""
``agentrail init`` / ``agentrail install`` — native Python port of the legacy
``scripts/install-workflow`` bash helper.

Drives the shared template-sync engine (``_template_sync``) with ``previous=None``
for every inventory item (a fresh install), then writes ``state.json`` +
``config.json``, materializes the trimmed ``.agentrail/source`` vendor dir (#404
Option B), optionally creates GitHub labels, and prints the "Next steps" footer.

Unlike ``upgrade`` (which requires an existing ``state.json``), install creates
state fresh.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.run.state import write_state
from agentrail.cli.commands._template_sync import (
    DEFAULT_CONFIG,
    DEFAULT_WORKFLOW,
    _build_inventory,
    _materialize_source,
    _process_item,
    _sha256_file,
)


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def _now_iso(injected: Optional[str] = None) -> str:
    """UTC ISO timestamp with millis + Z, matching JS new Date().toISOString()."""
    if injected is not None:
        return injected
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

class UsageError(Exception):
    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


_USAGE = """Usage: agentrail install [--target DIR] [--force] [--github-labels]

Installs the AgentRail workflow templates into a project.

Options:
  --target DIR      Project directory to install into. Defaults to current directory.
  --force           Overwrite existing files.
  --github-labels   Create/update GitHub labels with gh CLI.
  -h, --help        Show this help."""


def parse_install_args(args: List[str]):
    import os
    target = os.getcwd()
    force = False
    github_labels = False
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
        elif a == "--github-labels":
            github_labels = True
            i += 1
        elif a in ("-h", "--help"):
            print(_USAGE)
            raise UsageError("", code=0)
        else:
            raise UsageError(f"Unknown option: {a}")
    return target, force, github_labels


# ---------------------------------------------------------------------------
# GitHub labels (mirror of scripts/install-workflow)
# ---------------------------------------------------------------------------

# name -> (color, description). Names stay in sync with doctor.REQUIRED_LABELS.
_LABEL_SPECS: Dict[str, tuple] = {
    "ready-for-agent": ("0E8A16", "Fully specified, ready for an agent to implement."),
    "afk": ("5319E7", "Approved for unattended AFK agent execution."),
    "afk-in-progress": ("BFDADC", "Currently claimed by AFK workflow."),
    "review-fix": ("D93F0B", "Follow-up issue created from PR review."),
    "memory-suggestion": ("FBCA04", "Suggested project memory update for human review."),
    "pr-reviewed": ("1D76DB", "Implementation PR has been reviewed."),
}


def _install_claude_skills(repo_dir: Path, target_dir: Path) -> None:
    """Copy repo skills into target's .claude/skills/ for native Claude Code lazy-loading.

    Idempotent: overwrites on reinstall. Each skill lands at:
      <target_dir>/.claude/skills/<skill_name>/SKILL.md
    """
    skills_src = repo_dir / "skills"
    if not skills_src.is_dir():
        return
    for skill_md in sorted(skills_src.glob("*/SKILL.md")):
        skill_name = skill_md.parent.name
        dest = target_dir / ".claude" / "skills" / skill_name / "SKILL.md"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(skill_md), str(dest))
        print(f"installed skill: .claude/skills/{skill_name}/SKILL.md")


def _install_claude_hooks(repo_dir: Path, target_dir: Path) -> None:
    """Install the context-first PreToolUse hook (claude-only enforcement, #519).

    Copies ``templates/scripts/context-first.sh`` to
    ``<target>/.agentrail/hooks/context-first.sh`` (chmod +x) and merges a
    ``hooks.PreToolUse`` entry into ``<target>/.claude/settings.json`` without
    clobbering existing user settings. Idempotent: re-running refreshes the
    script and skips re-adding an already-wired hook entry.
    """
    hook_src = repo_dir / "templates" / "scripts" / "context-first.sh"
    if not hook_src.is_file():
        return

    hook_dest = target_dir / ".agentrail" / "hooks" / "context-first.sh"
    hook_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(hook_src), str(hook_dest))
    hook_dest.chmod(0o755)
    print("installed hook: .agentrail/hooks/context-first.sh")

    settings_path = target_dir / ".claude" / "settings.json"
    settings: Dict[str, Any] = {}
    if settings_path.exists():
        try:
            loaded = json.loads(settings_path.read_text())
            if isinstance(loaded, dict):
                settings = loaded
        except (OSError, ValueError):
            settings = {}

    command = ".agentrail/hooks/context-first.sh"
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks
    pre_tool_use = hooks.setdefault("PreToolUse", [])
    if not isinstance(pre_tool_use, list):
        pre_tool_use = []
        hooks["PreToolUse"] = pre_tool_use

    already_wired = any(
        isinstance(entry, dict)
        and any(
            isinstance(h, dict) and h.get("command") == command
            for h in (entry.get("hooks") or [])
            if isinstance(entry.get("hooks"), list)
        )
        for entry in pre_tool_use
    )
    if not already_wired:
        pre_tool_use.append({
            "matcher": "Grep|Glob|Bash",
            "hooks": [{"type": "command", "command": command}],
        })
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n")
        print("updated: .claude/settings.json")


def _create_github_labels(target_dir: Path) -> None:
    from agentrail.cli.commands.doctor import REQUIRED_LABELS

    if shutil.which("gh") is None:
        print("gh CLI is not installed; skipping labels", file=sys.stderr)
        return

    for name in REQUIRED_LABELS:
        color, description = _LABEL_SPECS.get(name, ("EDEDED", ""))
        subprocess.run(
            [
                "gh", "label", "create", name,
                "--color", color,
                "--description", description,
                "--force",
            ],
            cwd=str(target_dir),
            check=False,
        )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_install(args: List[str], *, _now: Optional[str] = None) -> int:
    """Native fresh install. Returns exit code (0 ok, 1 error, 2 usage)."""
    try:
        target_str, force, github_labels = parse_install_args(args)
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

    target_dir.mkdir(parents=True, exist_ok=True)

    state_path = target_dir / ".agentrail" / "state.json"
    previous_state: Optional[Dict[str, Any]] = None
    if state_path.exists():
        try:
            previous_state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            previous_state = None

    # Build inventory
    try:
        inventory = _build_inventory(repo_dir)
    except OSError as exc:
        print(f"failed to build inventory: {exc}", file=sys.stderr)
        return 1

    now = _now_iso(_now)

    # Record which managed files pre-existed (before any copy) — drives legacyAdopted.
    existing_before = 0
    for item in inventory:
        if (target_dir / item["path"]).exists():
            existing_before += 1

    legacy_adopted = bool(
        (previous_state and previous_state.get("legacyAdopted"))
        or (not previous_state and existing_before > 0)
    )

    print(f"AgentRail install: {target_dir}")

    # When there is NO prior state this is a true fresh install: every item is
    # driven with previous=None (install_mode records freshly written files as
    # "installed", matching the legacy bash installer). When a prior state
    # exists (re-running install), categorize per-item against it for
    # idempotency — exactly like upgrade — so unchanged files become
    # "preserved" rather than being re-stamped. This mirrors the legacy bash
    # installer, which read the prior state.json when present.
    previous_by_path: Dict[str, Dict[str, Any]] = {}
    if previous_state and isinstance(previous_state.get("managedFiles"), list):
        previous_by_path = {
            f["path"]: f
            for f in previous_state["managedFiles"]
            if isinstance(f, dict) and "path" in f
        }
    legacy_adopted_state = bool(previous_state and previous_state.get("legacyAdopted"))

    next_managed_files: List[Dict[str, Any]] = []
    for item in inventory:
        record = _process_item(
            item,
            previous=previous_by_path.get(item["path"]),
            legacy_adopted_state=legacy_adopted_state,
            force=force,
            target_dir=target_dir,
            install_mode=True,
        )
        next_managed_files.append(record)

    # Build state
    existing_workflow = (previous_state or {}).get("workflow") or {}
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
        "installedAt": (previous_state or {}).get("installedAt") or now,
        "updatedAt": now,
        "legacyAdopted": legacy_adopted,
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

    # Materialize trimmed .agentrail/source (#404 Option B)
    _materialize_source(repo_dir, target_dir)

    # Install repo skills into .claude/skills/ for native Claude Code lazy-loading
    _install_claude_skills(repo_dir, target_dir)

    # Install the context-first PreToolUse hook (claude-only enforcement, #519)
    _install_claude_hooks(repo_dir, target_dir)

    # GitHub labels
    if github_labels:
        _create_github_labels(target_dir)

    # Next steps footer (mirrors scripts/install-workflow)
    print()
    print(f"AgentRail installed in: {target_dir}")
    print()
    print("Next steps:")
    print("  1. Start with a grilling session to define your project context:")
    print(f"     cd {target_dir} && agentrail grill")
    print("     (or use /grill inside Claude Code or Codex)")
    print("  2. The grill will create CONTEXT.md and sharpen your domain language.")
    print("  3. Then create issues and run: agentrail run issue NUMBER --agent claude")

    return 0
