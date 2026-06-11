"""
``agentrail cleanup`` — native Python port of the legacy bash run_cleanup.

Reads ``.agentrail/state.json`` ``workflow.worktrees[]``, removes merged
worktrees via git, and marks them removed in state.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from agentrail.run.state import state_recommendation, write_state


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _utc_now_iso() -> str:
    """Return current UTC time as ISO-8601 with millisecond precision and Z suffix."""
    dt = datetime.now(tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _usage() -> str:
    return (
        "Usage: agentrail cleanup [--target DIR] [--dry-run] [--merged] [--force]\n"
        "\n"
        "  --target DIR   Project root (default: cwd).\n"
        "  --dry-run      Show what would be removed without removing anything.\n"
        "  --merged       Remove worktrees whose status is 'merged'.\n"
        "  --force        Remove even if the worktree has uncommitted changes.\n"
    )


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def _parse_args(args: List[str]):
    """Parse cleanup args. Returns (target_str, dry_run, merged, force) or
    raises SystemExit-like by returning a (None, rc) sentinel."""
    import os

    target: str = os.getcwd()
    dry_run: bool = False
    merged: bool = False
    force: bool = False

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            return (None, 0)
        elif a == "--target":
            if i + 1 >= len(args) or args[i + 1].startswith("--"):
                print("--target requires a directory", file=sys.stderr)
                return (None, 2)
            target = args[i + 1]
            i += 2
        elif a == "--dry-run":
            dry_run = True
            i += 1
        elif a == "--merged":
            merged = True
            i += 1
        elif a == "--force":
            force = True
            i += 1
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            print(_usage(), file=sys.stderr)
            return (None, 2)

    return (target, dry_run, merged, force)


# ---------------------------------------------------------------------------
# Candidate selection from state
# ---------------------------------------------------------------------------

def _build_candidates(state: Dict[str, Any], target: Path, merged_only: bool) -> List[Dict[str, Any]]:
    """Build the list of candidate worktrees from state.json workflow.worktrees."""
    workflow: Dict[str, Any] = state.get("workflow") or {}
    if not isinstance(workflow, dict):
        workflow = {}
    worktrees = workflow.get("worktrees") or []
    if not isinstance(worktrees, list):
        worktrees = []

    candidates: List[Dict[str, Any]] = []
    for wt in worktrees:
        if not isinstance(wt, dict):
            continue
        if wt.get("removedAt"):
            continue
        if merged_only and wt.get("status") != "merged":
            continue
        stored_path = wt.get("path") or wt.get("worktreePath")
        if not stored_path:
            continue
        p = Path(stored_path)
        if p.is_absolute():
            absolute_path = p
        else:
            absolute_path = target / stored_path

        # issue: prefer wt.issue, then wt.targetIssue
        issue = wt.get("issue")
        if issue is None:
            issue = wt.get("targetIssue")

        # pr: prefer wt.pr, then wt.pullRequest
        pr = wt.get("pr")
        if pr is None:
            pr = wt.get("pullRequest")

        candidates.append({
            "id": wt.get("id") or "",
            "issue": issue if issue is not None else "",
            "pr": pr if pr is not None else "",
            "status": wt.get("status") or "unknown",
            "path": absolute_path,
        })
    return candidates


# ---------------------------------------------------------------------------
# State update
# ---------------------------------------------------------------------------

def _update_state(state_path: Path, state: Dict[str, Any], removed_paths: Set[Path],
                  now: str) -> None:
    """Mark each worktree whose resolved absolute path is in removed_paths
    with removedAt=now and cleanupStatus='removed'. Set state.updatedAt=now.
    Write atomically via write_state."""
    workflow: Dict[str, Any] = state.get("workflow") or {}
    if not isinstance(workflow, dict):
        workflow = {}
    worktrees = workflow.get("worktrees") or []
    if not isinstance(worktrees, list):
        worktrees = []

    target = state_path.parent.parent  # <target>/.agentrail/state.json

    updated_worktrees = []
    for wt in worktrees:
        if not isinstance(wt, dict):
            updated_worktrees.append(wt)
            continue
        stored_path = wt.get("path") or wt.get("worktreePath")
        if not stored_path:
            updated_worktrees.append(wt)
            continue
        p = Path(stored_path)
        if p.is_absolute():
            absolute_path = p.resolve()
        else:
            absolute_path = (target / stored_path).resolve()

        if absolute_path in removed_paths:
            wt = dict(wt)
            wt["removedAt"] = now
            wt["cleanupStatus"] = "removed"
        updated_worktrees.append(wt)

    workflow["worktrees"] = updated_worktrees
    state["workflow"] = workflow
    state["updatedAt"] = now
    write_state(state_path, state)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_cleanup(args: List[str], now: Optional[str] = None) -> int:
    """Parse args, prune git worktrees, remove merged ones, update state.

    Args:
        args: CLI arguments after ``cleanup``.
        now:  Optional injected UTC ISO timestamp for tests.

    Returns:
        Exit code (0 success, 1 setup error, 2 usage error).
    """
    parsed = _parse_args(args)

    # Sentinel: (None, rc) means early exit
    if parsed[0] is None:
        return parsed[1]

    target_str, dry_run, merged, force = parsed

    # Resolve target to absolute path
    target = Path(target_str).resolve()

    # Check state.json exists
    state_path = target / ".agentrail" / "state.json"
    if not state_path.exists():
        print(state_recommendation(target), file=sys.stderr)
        return 1

    # Check git is on PATH
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=False)
    except FileNotFoundError:
        print("git is required for worktree cleanup", file=sys.stderr)
        return 1

    # Require --merged or --dry-run
    if not merged and not dry_run:
        print("cleanup requires --dry-run or --merged", file=sys.stderr)
        return 2

    # git worktree prune
    subprocess.run(["git", "-C", str(target), "worktree", "prune"],
                   capture_output=True, check=False)

    # Load state
    state: Dict[str, Any] = json.loads(state_path.read_text(encoding="utf-8"))

    # Build candidates
    candidates = _build_candidates(state, target, merged)

    print(f"AgentRail cleanup: {target}")
    if not candidates:
        print("No matching AgentRail-owned worktrees found.")
        return 0

    removed_paths: Set[Path] = set()

    for cand in candidates:
        path: Path = cand["path"]
        status: str = cand["status"]
        issue = cand["issue"]
        pr = cand["pr"]

        # Build label
        label = "worktree"
        if issue != "" and issue is not None:
            label += f" issue #{issue}"
        if pr != "" and pr is not None:
            label += f" PR #{pr}"
        print(f"{label}: {path} ({status})")

        if dry_run:
            if path.is_dir():
                result = subprocess.run(
                    ["git", "-C", str(path), "status", "--porcelain"],
                    capture_output=True, text=True, check=False,
                )
                dirty = result.stdout.strip()
                if dirty:
                    print("  dirty: would skip without --force")
            else:
                print("  missing: stale state entry")
            continue

        # Actual removal (requires status == "merged")
        if status != "merged":
            print("  skip: not merged")
            continue

        if path.is_dir():
            result = subprocess.run(
                ["git", "-C", str(path), "status", "--porcelain"],
                capture_output=True, text=True, check=False,
            )
            dirty = result.stdout.strip()
            if dirty and not force:
                print("  skip: uncommitted changes; rerun with --force to remove")
                continue

            # Remove worktree
            remove_cmd = ["git", "-C", str(target), "worktree", "remove"]
            if force:
                remove_cmd.append("--force")
            remove_cmd.append(str(path))
            subprocess.run(remove_cmd, capture_output=True, check=False)
            print("  removed")
        else:
            print("  already missing")

        removed_paths.add(path.resolve())

    # Update state if any worktrees were removed
    if removed_paths:
        effective_now = now if now is not None else _utc_now_iso()
        _update_state(state_path, state, removed_paths, effective_now)

    return 0
