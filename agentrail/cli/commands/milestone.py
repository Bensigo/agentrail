"""``agentrail milestone create`` — PRD → docs/milestones via the to-milestones skill.

Binds the shipped ``to-milestones`` skill to the skill-backed agent-session
primitive (``agentrail/skillcmd/session.py``). The agent is launched
interactively by default (quizzes the user on the milestone breakdown before
writing files); ``--headless``/``--yes`` writes without prompting.

Output: local ``docs/milestones/NNN-<slug>.md`` files. No tracker publish.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import List, Optional

from agentrail.cli.commands.run import (
    AGENTS,
    UsageError,
    ensure_command_available,
    resolve_agent_command,
    resolve_agent_name,
)
from agentrail.skillcmd.session import run_skill_session

SKILL_NAME = "to-milestones"
# House context the to-milestones procedure loads before drafting milestones.
EXTRA_CONTEXT = ["TASTE.md"]

_USAGE = """\
Usage:
  agentrail milestone create <prd> [--agent codex|claude|cursor|hermes|custom]
                             [--target DIR] [--headless|--yes] [--dry-run]

Commands:
  create    Convert a PRD into docs/milestones/NNN-<slug>.md files.

Options:
  --agent      Agent to use (default: from config)
  --target     Repo root (default: cwd)
  --headless / --yes  Skip interactive quiz, write files immediately.
  --dry-run    Print planned milestone file(s) without writing.
"""

_CREATE_USAGE = """\
Usage:
  agentrail milestone create <prd> [--agent codex|claude|cursor|hermes|custom]
                             [--target DIR] [--headless|--yes] [--dry-run]

Launches the configured agent seeded with the to-milestones skill + CONTEXT.md
to convert a PRD into local docs/milestones/NNN-<slug>.md files. Interactive
by default (agent quizzes you on the milestone breakdown before writing);
--headless writes without prompting. --dry-run prints the planned file(s)
without invoking the agent.
"""


def _next_milestone_number(target: Path) -> int:
    """Return the next free sequential milestone number (1-based).

    Scans ``docs/milestones/`` under *target* for files matching ``NNN-*.md``
    and returns max(NNN) + 1, or 1 if the directory is missing or empty.
    """
    milestones_dir = target / "docs" / "milestones"
    if not milestones_dir.is_dir():
        return 1
    highest = 0
    for p in milestones_dir.iterdir():
        m = re.match(r"^(\d+)-", p.name)
        if m:
            n = int(m.group(1))
            if n > highest:
                highest = n
    return highest + 1


def run_milestone(args: List[str]) -> int:
    """Entry point for ``agentrail milestone ...``."""
    if not args or args[0] in ("-h", "--help"):
        print(_USAGE, end="")
        return 0

    sub = args[0]
    if sub == "create":
        try:
            return _run_create(args[1:])
        except UsageError as exc:
            msg = str(exc)
            if msg:
                print(msg, file=sys.stderr)
            return exc.code

    print(f"Unknown milestone subcommand: {sub}", file=sys.stderr)
    print(_USAGE, end="", file=sys.stderr)
    return 2


def _need_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise UsageError(f"{flag} requires a value")
    return args[i + 1]


def _run_create(args: List[str]) -> int:
    """Dispatch ``agentrail milestone create ...``."""
    if args and args[0] in ("-h", "--help"):
        print(_CREATE_USAGE, end="")
        return 0

    agent_flag = "__config__"
    target = os.getcwd()
    headless = False
    dry_run = False
    prd: Optional[str] = None

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--agent":
            value = _need_value(args, i, "--agent")
            if value not in AGENTS:
                raise UsageError("--agent must be codex, claude, cursor, hermes, or custom")
            agent_flag = value
            i += 2
        elif a == "--target":
            target = _need_value(args, i, "--target")
            i += 2
        elif a in ("--headless", "--yes"):
            headless = True
            i += 1
        elif a == "--dry-run":
            dry_run = True
            i += 1
        elif a.startswith("--"):
            raise UsageError(f"Unknown option: {a}")
        else:
            if prd is not None:
                raise UsageError("milestone create takes exactly one <prd> argument")
            prd = a
            i += 1

    if prd is None:
        raise UsageError("milestone create requires a <prd> argument")

    target_path = Path(target).resolve()
    target = str(target_path)
    next_n = _next_milestone_number(target_path)

    if dry_run:
        # The to-milestones skill decides how many milestone files to write and
        # their slugs — unknowable without running the agent. Describe the
        # destination and starting number rather than predicting one filename.
        print(
            f"Would write one or more milestone file(s) under {target_path}/docs/milestones/, "
            f"starting at {next_n:03d}-<slug>.md (exact count and slugs are decided by the "
            "to-milestones skill at runtime)."
        )
        return 0

    agent = resolve_agent_name(target, agent_flag)
    command = resolve_agent_command(agent, "", target)
    ensure_command_available(command)

    return run_skill_session(
        SKILL_NAME,
        str(target_path),
        [prd],
        agent=agent,
        command=command,
        headless=headless,
        extra_context=EXTRA_CONTEXT,
    )
