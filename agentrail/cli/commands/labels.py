"""
``agentrail labels`` — native labels sync command.

Replaces the legacy bash ``sync_github_labels`` function.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import List

LABELS = [
    ("ready-for-agent", "0E8A16", "Fully specified, ready for an agent to implement."),
    ("afk", "5319E7", "Approved for unattended AFK agent execution."),
    ("afk-in-progress", "BFDADC", "Currently claimed by AFK workflow."),
    ("review-fix", "D93F0B", "Follow-up issue created from PR review."),
    ("memory-suggestion", "FBCA04", "Suggested project memory update for human review."),
    ("pr-reviewed", "1D76DB", "Implementation PR has been reviewed."),
]


def _usage() -> str:
    return "Usage:\n  agentrail labels sync [--target DIR]\n"


def _parse_target(args: List[str]):
    """Parse ``--target DIR`` from args; return (target, rc).

    rc is None on success, 2 on unknown option.
    """
    target = str(Path.cwd())
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            if i + 1 >= len(args) or args[i + 1].startswith("--"):
                print("--target requires a directory", file=sys.stderr)
                return None, 2
            target = args[i + 1]
            i += 2
        elif a in ("-h", "--help"):
            # help inside sync args — treat as unknown/ignore; legacy parse_target exits 0
            # but the spec says unknown opt → rc 2 (anything not --target/-h)
            # -h/--help here would be after "sync", pass through; legacy does usage exit 0
            print(_usage())
            return None, 0
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            print(_usage(), file=sys.stderr)
            return None, 2
    return target, None


def _sync(target: str) -> int:
    if shutil.which("gh") is None:
        print("labels sync: gh CLI is required", file=sys.stderr)
        return 1

    auth_result = subprocess.run(
        ["gh", "auth", "status"],
        cwd=target,
        capture_output=True,
    )
    if auth_result.returncode != 0:
        print(
            "labels sync: gh CLI is not authenticated or cannot access GitHub",
            file=sys.stderr,
        )
        return 1

    remote_result = subprocess.run(
        ["git", "-C", target, "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
    )
    if remote_result.returncode != 0 or "github.com" not in remote_result.stdout:
        print(
            f"labels sync: {target} does not have a GitHub origin remote",
            file=sys.stderr,
        )
        return 1

    for name, color, desc in LABELS:
        subprocess.run(
            [
                "gh", "label", "create", name,
                "--color", color,
                "--description", desc,
                "--force",
            ],
            cwd=target,
            check=False,
        )

    print("labels sync: ok")
    return 0


def run_labels(args: List[str]) -> int:
    if not args or args[0] in ("-h", "--help"):
        print(_usage())
        return 0

    subcmd = args[0]
    if subcmd != "sync":
        print(f"Unknown labels command: {subcmd}", file=sys.stderr)
        return 2

    target, rc = _parse_target(args[1:])
    if rc is not None:
        return rc

    return _sync(target)
