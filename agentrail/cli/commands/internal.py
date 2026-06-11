"""
``agentrail internal`` — native dispatcher for internal helpers.

Replaces the legacy bash ``internal`` (review-pr + worktree mark). ``review-pr``
execs the ``templates/scripts/review-pr`` helper (kept as a template script, like
ralph-loop); ``worktree mark`` updates the worktree lifecycle in state.json.
"""
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path
from typing import List

from agentrail.run.state import update_worktree_state


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def _usage() -> str:
    return ("Usage:\n"
            "  agentrail internal review-pr --pr N [--engine codex] [--output FILE] [--machine-readable]\n"
            "  agentrail internal worktree mark --path DIR --status STATUS [--target DIR] [--issue N] [--pr N] [--run-dir DIR] [--base BRANCH] [--slot N]\n")


def run_internal(args: List[str]) -> int:
    if not args:
        print(_usage(), file=sys.stderr)
        return 1
    if args[0] in ("-h", "--help"):
        print(_usage())
        return 0
    cmd, rest = args[0], args[1:]
    if cmd == "review-pr":
        return _review_pr(rest)
    if cmd == "worktree":
        return _worktree(rest)
    print(f"Unknown internal command: {cmd}", file=sys.stderr)
    return 2


def _review_pr(rest: List[str]) -> int:
    review_script = _repo_dir() / "templates" / "scripts" / "review-pr"
    if not (review_script.exists() and os.access(review_script, os.X_OK)):
        print(f"missing internal review helper: {review_script}", file=sys.stderr)
        return 2
    proc = subprocess.run([str(review_script), *rest], check=False)
    return int(proc.returncode)


def _worktree(rest: List[str]) -> int:
    if not rest:
        print("internal worktree requires an action", file=sys.stderr)
        return 2
    action, opts = rest[0], rest[1:]
    target = os.getcwd()
    path = status = run_dir = base = ""
    issue = pr = slot = ""
    i = 0

    while i < len(opts):
        a = opts[i]
        if a in ("--target", "--path", "--status", "--issue", "--pr", "--run-dir", "--base", "--slot"):
            # Check that a value follows and is not itself a flag
            if i + 1 >= len(opts) or opts[i + 1].startswith("--"):
                print(f"{a} requires a value", file=sys.stderr)
                return 2
            val = opts[i + 1]
            if a == "--target":
                target = val
            elif a == "--path":
                path = val
            elif a == "--status":
                status = val
            elif a == "--issue":
                issue = val
            elif a == "--pr":
                pr = val
            elif a == "--run-dir":
                run_dir = val
            elif a == "--base":
                base = val
            elif a == "--slot":
                slot = val
            i += 2
        else:
            print(f"Unknown internal worktree option: {a}", file=sys.stderr)
            return 2

    if action != "mark":
        print(f"unknown internal worktree action: {action}", file=sys.stderr)
        return 2
    if not path:
        print("internal worktree mark requires --path", file=sys.stderr)
        return 2
    if not status:
        print("internal worktree mark requires --status", file=sys.stderr)
        return 2

    target_abs = str(Path(target).resolve())
    wt_path = path if os.path.isabs(path) else os.path.join(target_abs, path)

    try:
        update_worktree_state(
            Path(target_abs), wt_path, status,
            issue=int(issue) if issue else None,
            pr=int(pr) if pr else None,
            run_dir=run_dir, base=base,
            slot=int(slot) if slot else None,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0
