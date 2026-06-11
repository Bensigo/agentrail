"""
``agentrail status`` — native Python port of the legacy bash ``run_status``.

Prints install status and current workflow state, then appends a telemetry
summary line when ``.agentrail/afk/outbox.jsonl`` exists.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import List, Optional


# ---------------------------------------------------------------------------
# Argument parsing (mirrors legacy parse_target for the status sub-command)
# ---------------------------------------------------------------------------

def _parse_target(args: List[str]) -> str:
    """Parse ``--target DIR`` / ``-h`` / ``--help``; return target directory.

    Unknown options → print "Unknown option: <x>" to stderr, exit 2.
    -h / --help → print nothing meaningful, exit 0.
    """
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
            raise SystemExit(0)
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            raise SystemExit(2)
    return target


# ---------------------------------------------------------------------------
# render_status — native Python port of the legacy JS block in run_status
# ---------------------------------------------------------------------------

def render_status(target_dir: Path) -> int:
    """Print the status output for *target_dir* to stdout.

    Returns 0 on success, 1 on corrupt-state.
    Does NOT print the dashboard line (caller does that).
    """
    from agentrail.run.state import (  # noqa: PLC0415
        _run_label,
        _attempt_summary,
        _stale_summary,
        _goal_label,
        _null_coalesce,
        state_recommendation,
    )

    print(f"AgentRail status: {target_dir}")

    state_file = target_dir / ".agentrail" / "state.json"

    if not state_file.exists():
        print("install status: missing-state")
        print()
        print(state_recommendation(target_dir))
        return 0

    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError) as exc:
        print("install status: corrupt-state")
        print(f"state error: {exc}")
        return 1

    workflow = state.get("workflow") or {}
    active_run = workflow.get("activeRun")
    completed_runs: list = workflow.get("completedRuns") if isinstance(workflow.get("completedRuns"), list) else []
    worktrees: list = workflow.get("worktrees") if isinstance(workflow.get("worktrees"), list) else []
    goals: list = workflow.get("goals") if isinstance(workflow.get("goals"), list) else []

    # Legacy uses Boolean() which prints lowercase true/false in JS
    legacy_adopted = str(bool(state.get("legacyAdopted"))).lower()

    print("install status: state-present")
    print(f"agentrail version: {state.get('agentrailVersion') or 'unknown'}")
    print(f"installed at: {state.get('installedAt') or 'unknown'}")
    print(f"updated at: {state.get('updatedAt') or 'unknown'}")
    print(f"legacy adopted: {legacy_adopted}")
    print("workflow:")
    print(f"  phase: {workflow.get('phase') or 'unknown'}")
    print(f"  active phase: {_null_coalesce(workflow.get('activePhase'), 'none')}")
    print(f"  active issue: {_null_coalesce(workflow.get('activeIssue'), 'none')}")
    print(f"  active pull request: {_null_coalesce(workflow.get('activePullRequest'), 'none')}")
    print(f"  active PRD: {_null_coalesce(workflow.get('activePrd'), 'none')}")
    print(f"  active milestone: {_null_coalesce(workflow.get('activeMilestone'), 'none')}")
    print(f"  active run: {_run_label(active_run) if isinstance(active_run, dict) else 'none'}")

    active_goals = [g for g in goals if isinstance(g, dict) and g.get("status") == "active"]
    if active_goals:
        print("  active goals:")
        for goal in active_goals[:5]:
            print(f"    {_goal_label(goal)}")

    active_attempts = _attempt_summary(active_run)
    if active_attempts:
        print(f"  active run {active_attempts}")

    active_stale = _stale_summary(target_dir, active_run)
    if active_stale:
        print(f"  active run stale: {active_stale}")

    if completed_runs:
        for run in completed_runs[-5:]:
            print(f"  completed run: {_run_label(run)}")
            attempts = _attempt_summary(run)
            if attempts:
                print(f"  completed run {attempts}")
            if isinstance(run, dict) and run.get("blockedReason"):
                print(f"  completed run blocked reason: {run['blockedReason']}")

    if worktrees:
        print("  worktrees:")
        for worktree in worktrees[-5:]:
            if not isinstance(worktree, dict):
                continue
            target_label = f"issue #{worktree['issue']}" if worktree.get("issue") else "issue"
            pr_part = f" PR #{worktree['pr']}" if worktree.get("pr") else ""
            removed_part = f" removed {worktree['removedAt']}" if worktree.get("removedAt") else ""
            wt_path = worktree.get("path") or worktree.get("absolutePath") or "unknown"
            print(f"    {target_label}{pr_part}: {worktree.get('status') or 'unknown'} {wt_path}{removed_part}")

    print(f"  last completed step: {_null_coalesce(workflow.get('lastCompletedStep'), 'none')}")
    print(f"  next action: {workflow.get('nextSuggestedAction') or 'none'}")

    return 0


# ---------------------------------------------------------------------------
# run_status — main entry point called by main.py
# ---------------------------------------------------------------------------

def run_status(args: List[str], target: Optional[Path] = None) -> int:
    """Parse args, render native status output, then append telemetry line."""

    # Honour an explicit target kwarg (used by tests); otherwise parse from args.
    if target is not None:
        target_dir = target
    else:
        try:
            target_str = _parse_target(args)
        except SystemExit as exc:
            return int(exc.code)
        target_dir = Path(target_str)

    rc = render_status(target_dir)

    # Dashboard line (after the main block, regardless of rc).
    # We always print it even on corrupt-state to mirror legacy behaviour where
    # the dashboard echo happens outside the node block.
    from agentrail.cli.commands.doctor import resolve_api_key  # noqa: PLC0415
    print("dashboard:")
    if resolve_api_key(str(target_dir)):
        print("  connected (AGENTRAIL_API_KEY)")
    else:
        print("  not configured (local-only mode)")

    # Append telemetry summary line.
    try:
        from agentrail.afk.telemetry import count_outbox, load_last_flush  # noqa: PLC0415

        queued = count_outbox(target_dir)
        last_flush = load_last_flush(target_dir) or "never"
        print(f"telemetry: {queued} events queued, last flush {last_flush}")
    except Exception:  # noqa: BLE001
        pass

    return rc
