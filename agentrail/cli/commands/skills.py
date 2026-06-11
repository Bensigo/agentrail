"""
``agentrail skills`` — native Python port of the legacy bash ``run_skills``.

Subcommands: list / resolve / validate
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List, Optional

from agentrail.run.skills import (
    SkillResolutionError,
    bundled_skills,
    load_registry,
    resolve_skills,
)
from agentrail.cli.commands.doctor import validate_skill_registry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _repo_dir() -> Path:
    """Return the agentrail source repository root (lazy, no caching needed)."""
    return Path(__file__).resolve().parents[3]


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail skills list [--target DIR]\n"
        "  agentrail skills resolve TASK [--target DIR] [--no-auto-skills] [--skill NAME ...]\n"
        "  agentrail skills validate [--target DIR]\n"
        "\n"
        "Options:\n"
        "  --target DIR   Project directory (default: cwd)\n"
        "  -h, --help     Show this help\n"
    )


def _parse_target(args: List[str]) -> str:
    """Parse ``--target DIR`` / ``-h`` / ``--help`` from *args*; return target directory.

    Raises SystemExit(2) on bad input, SystemExit(0) on -h/--help.
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
            print(_usage())
            raise SystemExit(0)
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            raise SystemExit(2)
    return target


# ---------------------------------------------------------------------------
# Subcommand: list
# ---------------------------------------------------------------------------

def _run_list(args: List[str]) -> int:
    try:
        target = _parse_target(args)
    except SystemExit as exc:
        return int(exc.code)

    try:
        _, registry = load_registry(Path(target), _repo_dir())
    except (FileNotFoundError, Exception) as exc:
        print(f"skills list: {exc}", file=sys.stderr)
        return 1

    print(f"AgentRail skills list: {target}")
    for skill in bundled_skills(registry):
        print(f"- {skill['name']}")
        print(f"  path: {skill['localPath']}")
        print(f"  description: {skill['description']}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: resolve
# ---------------------------------------------------------------------------

def _parse_resolve_options(args: List[str]) -> tuple[str, bool, List[str]]:
    """Parse --target, --no-auto-skills, --skill from *args*.

    Returns (target, auto_skills, explicit_skills).
    Raises SystemExit(2) on bad input.
    """
    target = os.getcwd()
    auto_skills = True
    explicit_skills: List[str] = []

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
        elif a == "--no-auto-skills":
            auto_skills = False
            i += 1
        elif a == "--skill":
            value = args[i + 1] if (i + 1 < len(args) and not args[i + 1].startswith("--")) else ""
            if not value:
                print("--skill requires a skill name", file=sys.stderr)
                raise SystemExit(2)
            explicit_skills.append(value)
            i += 2
        elif a in ("-h", "--help"):
            print(_usage())
            raise SystemExit(0)
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            raise SystemExit(2)

    return target, auto_skills, explicit_skills


def _run_resolve(args: List[str]) -> int:
    # Task text is required as the first positional argument
    task_text = args[0] if args else ""
    if not task_text or task_text.startswith("--"):
        print("skills resolve requires task text", file=sys.stderr)
        return 2

    try:
        target, auto_skills, explicit_skills = _parse_resolve_options(args[1:])
    except SystemExit as exc:
        return int(exc.code)

    try:
        resolution = resolve_skills(
            Path(target),
            _repo_dir(),
            task_text,
            auto_skills=auto_skills,
            explicit_skills=explicit_skills or None,
        )
    except SkillResolutionError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    # Print CLI-mode output (mirrors legacy print_skill_resolution mode=cli)
    print(f"AgentRail skills resolve: {resolution['targetDir']}")
    print(f"task: {task_text}")
    if not resolution["autoSkills"]:
        print("Automatic skill resolution disabled.")
    if not resolution["resolved"]:
        print("No skills resolved.")
    else:
        for skill in resolution["resolved"]:
            print(f"- {skill['name']}")
            print(f"  path: {skill['localPath']}")
            for reason in skill["reasons"]:
                print(f"  reason: {reason}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: validate
# ---------------------------------------------------------------------------

def _run_validate(args: List[str]) -> int:
    try:
        target = _parse_target(args)
    except SystemExit as exc:
        return int(exc.code)

    result = validate_skill_registry(target, _repo_dir())

    print(f"AgentRail skills validate: {target}")
    if result.ok:
        print("  ok skill registry")
        print(f"  path {result.registry_path}")
        return 0
    else:
        for err in result.errors:
            print(f"  error {err}")
        return 1


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def run_skills(args: List[str]) -> int:
    """Dispatch ``agentrail skills <subcommand>``."""
    kind = args[0] if args else ""

    if kind in ("", "-h", "--help"):
        print(_usage())
        return 0

    if kind == "list":
        return _run_list(args[1:])

    if kind == "resolve":
        return _run_resolve(args[1:])

    if kind == "validate":
        return _run_validate(args[1:])

    print(f"Unknown skills command: {kind}", file=sys.stderr)
    return 2
