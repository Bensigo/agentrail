"""``agentrail grill-me`` — interactive plan grilling backed by a skill.

Binds the shipped ``grill-me`` skill to the skill-backed agent-session
primitive (``agentrail/skillcmd/session.py``). The agent is launched
interactively by default (it owns the TTY and quizzes the user one question at
a time per the skill); ``--headless``/``--yes`` runs it unattended.

No publish side effects — the grilling edits ``CONTEXT.md``/ADRs inline only.
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

SKILL_NAME = "grill-me"
# House context the grilling procedure applies its questions against.
EXTRA_CONTEXT = ["TASTE.md"]

_USAGE = """\
Usage:
  agentrail grill-me [plan-or-path] [--agent codex|claude|cursor|hermes|custom]
                     [--target DIR] [--headless|--yes]

Launches the configured agent seeded with the grill-me skill + CONTEXT.md
to stress-test a plan. Interactive by default (you own the TTY); --headless runs
it unattended. Edits CONTEXT.md/ADRs inline only — no publish.
"""


def run_grill(args: List[str]) -> int:
    """Entry point for ``agentrail grill-me ...``."""
    if args and args[0] in ("-h", "--help"):
        print(_USAGE, end="")
        return 0
    try:
        return _dispatch(args)
    except UsageError as exc:
        msg = str(exc)
        if msg:
            print(msg, file=sys.stderr)
        return exc.code


def _need_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise UsageError(f"{flag} requires a value")
    return args[i + 1]


def _dispatch(args: List[str]) -> int:
    agent_flag = "__config__"
    target = os.getcwd()
    headless = False
    plan: Optional[str] = None

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
        elif a.startswith("--"):
            raise UsageError(f"Unknown option: {a}")
        else:
            if plan is not None:
                raise UsageError("grill-me takes at most one plan-or-path argument")
            plan = a
            i += 1

    target = str(Path(target).resolve())
    agent = resolve_agent_name(target, agent_flag)
    command = resolve_agent_command(agent, "", target)
    ensure_command_available(command)

    input_refs: List[str] = [plan] if plan else []
    return run_skill_session(
        SKILL_NAME,
        target,
        input_refs,
        agent=agent,
        command=command,
        headless=headless,
        extra_context=EXTRA_CONTEXT,
    )
