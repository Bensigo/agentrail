"""``agentrail prd create`` — idea → PRD via the to-prd skill.

Binds the shipped ``to-prd`` skill to the skill-backed agent-session
primitive (``agentrail/skillcmd/session.py``). The agent is launched
interactively by default (quizzes the user to refine the PRD before
publishing); ``--headless``/``--yes`` runs one-shot.

Output: published to the issue tracker with the ``ready-for-agent`` label
(the skill handles publication). No local docs/prd/ file is written — the
tracker issue IS the canonical PRD artifact; a local copy would diverge and
add no value. Use ``--dry-run`` to preview the seed prompt without invoking
the agent or publishing.
"""
from __future__ import annotations

import os
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

SKILL_NAME = "to-prd"
# House context the to-prd procedure uses when drafting the PRD.
EXTRA_CONTEXT = ["TASTE.md"]

_USAGE = """\
Usage:
  agentrail prd create <brief> [--agent codex|claude|cursor|hermes|custom]
                       [--target DIR] [--headless|--yes] [--dry-run]

Commands:
  create    Convert an idea/brief into a PRD published to the issue tracker.

Options:
  --agent      Agent to use (default: from config)
  --target     Repo root (default: cwd)
  --headless / --yes  Skip interactive quiz, run one-shot.
  --dry-run    Print seed prompt info without invoking the agent or publishing.

Local copy: none. The tracker issue is the canonical PRD artifact.
"""

_CREATE_USAGE = """\
Usage:
  agentrail prd create <brief> [--agent codex|claude|cursor|hermes|custom]
                       [--target DIR] [--headless|--yes] [--dry-run]

Launches the configured agent seeded with the to-prd skill + CONTEXT.md +
TASTE.md to convert an idea or brief into a template-conformant PRD published
to the issue tracker with the ready-for-agent label. Interactive by default
(agent quizzes you to refine the PRD before publishing); --headless runs
one-shot without prompting. --dry-run prints the seed prompt info without
invoking the agent or publishing.

Local copy: no local docs/prd/ file is written. The tracker issue is the
canonical PRD artifact; a local copy would diverge and add no value.
"""


def run_prd(args: List[str]) -> int:
    """Entry point for ``agentrail prd ...``."""
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

    print(f"Unknown prd subcommand: {sub}", file=sys.stderr)
    print(_USAGE, end="", file=sys.stderr)
    return 2


def _need_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise UsageError(f"{flag} requires a value")
    return args[i + 1]


def _run_create(args: List[str]) -> int:
    """Dispatch ``agentrail prd create ...``."""
    if args and args[0] in ("-h", "--help"):
        print(_CREATE_USAGE, end="")
        return 0

    agent_flag = "__config__"
    target = os.getcwd()
    headless = False
    dry_run = False
    brief: Optional[str] = None

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
            if brief is not None:
                raise UsageError("prd create takes exactly one <brief> argument")
            brief = a
            i += 1

    if brief is None:
        raise UsageError("prd create requires a <brief> argument")

    target_path = Path(target).resolve()

    if dry_run:
        print("Would publish PRD with ready-for-agent label.")
        print("Seed prompt will include:")
        print("  - apps/jace/agent/skills/to-prd/SKILL.md")
        print("  - CONTEXT.md")
        print("  - TASTE.md")
        print(f"  - Brief: {brief}")
        print()
        print("No local docs/prd/ file will be written. Use without --dry-run to publish.")
        return 0

    agent = resolve_agent_name(target, agent_flag)
    command = resolve_agent_command(agent, "", target)
    ensure_command_available(command)

    return run_skill_session(
        SKILL_NAME,
        str(target_path),
        [brief],
        agent=agent,
        command=command,
        headless=headless,
        extra_context=EXTRA_CONTEXT,
    )
