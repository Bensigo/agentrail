"""``agentrail prompt`` — generate copy-paste agent prompts.

Composes existing run/ modules to produce grill / issue / review prompts.

Legacy reference: scripts/agentrail-legacy run_prompt ~5080, parse_prompt_options ~4079.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List, Optional

from agentrail.run.context import (
    build_issue_context_pack,
    build_pack,
    context_pack_summary,
    context_selected_snippets,
    issue_resolution_text,
)
from agentrail.run.prompts import (
    common_header,
    format_skill_resolution,
    grill_prompt,
    issue_base_prompt,
    review_prompt,
)
from agentrail.run.skills import SkillResolutionError, resolve_skills
from agentrail.run.state import render_state_summary

PROMPT_AGENTS = {"codex", "claude"}

_USAGE = """\
Usage:
  agentrail prompt grill <idea> [--agent codex|claude] [--target DIR]
  agentrail prompt issue <N>   [--agent codex|claude] [--target DIR] [--skill NAME]... [--no-auto-skills]
  agentrail prompt review <N>  [--agent codex|claude] [--target DIR]
"""


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def _print_usage(file=None) -> None:
    print(_USAGE, file=file or sys.stdout, end="")


def run_prompt(args: List[str]) -> int:
    """Entry point for `agentrail prompt ...`."""
    if not args:
        _print_usage(file=sys.stderr)
        return 1

    if args[0] in ("-h", "--help"):
        _print_usage()
        return 0

    kind = args[0]
    if kind not in ("grill", "issue", "review"):
        print(f"Unknown prompt type: {kind}", file=sys.stderr)
        return 2

    rest = args[1:]

    # Validate subject
    if not rest or rest[0].startswith("--"):
        print(f"prompt {kind} requires an argument", file=sys.stderr)
        return 2

    subject = rest[0]
    option_args = rest[1:]

    # Numeric validation for issue / review
    if kind in ("issue", "review"):
        if not subject.isdigit():
            print(f"prompt {kind} argument must be numeric", file=sys.stderr)
            return 2

    # Parse options
    agent = "codex"
    target = os.getcwd()
    explicit_skills: List[str] = []
    auto_skills = True

    i = 0
    while i < len(option_args):
        opt = option_args[i]
        if opt == "--agent":
            if i + 1 >= len(option_args) or option_args[i + 1].startswith("--"):
                print("--agent requires a value", file=sys.stderr)
                return 2
            value = option_args[i + 1]
            if value not in PROMPT_AGENTS:
                print("--agent must be codex or claude", file=sys.stderr)
                return 2
            agent = value
            i += 2
        elif opt == "--target":
            if i + 1 >= len(option_args) or option_args[i + 1].startswith("--"):
                print("--target requires a value", file=sys.stderr)
                return 2
            target = option_args[i + 1]
            i += 2
        elif opt == "--skill":
            if i + 1 >= len(option_args) or option_args[i + 1].startswith("--"):
                print("--skill requires a value", file=sys.stderr)
                return 2
            explicit_skills.append(option_args[i + 1])
            i += 2
        elif opt == "--no-auto-skills":
            auto_skills = False
            i += 1
        else:
            print(f"Unknown option: {opt}", file=sys.stderr)
            return 2

    # Build common header once
    target_path = Path(target).resolve()
    state_summary = render_state_summary(target_path)
    header = common_header(agent, state_summary)

    if kind == "grill":
        print(grill_prompt(agent, subject, header=header))
        return 0

    if kind == "issue":
        issue = int(subject)
        resolution_text = issue_resolution_text(target_path, issue)
        try:
            resolution = resolve_skills(
                target_path, _repo_dir(), resolution_text,
                auto_skills=auto_skills, explicit_skills=explicit_skills,
            )
        except SkillResolutionError as e:
            print(str(e), file=sys.stderr)
            return 1
        except Exception:
            resolution = {"resolved": [], "autoSkills": auto_skills}
        pack = build_issue_context_pack(target_path, issue, "plan")
        summary = context_pack_summary(target_path, pack)
        snippets = context_selected_snippets(target_path, resolution_text)
        skill_block = format_skill_resolution(resolution, mode="prompt", engine=agent)
        print(issue_base_prompt(
            agent, issue,
            header=header,
            skill_block=skill_block,
            context_summary=summary,
            context_snippets=snippets,
        ))
        return 0

    # kind == "review"
    pr = int(subject)
    pack = build_pack(target_path, "pr", pr, "review")
    summary = context_pack_summary(target_path, pack)
    snippets = context_selected_snippets(target_path, f"review pr {pr}")
    print(review_prompt(
        agent, pr,
        header=header,
        context_summary=summary,
        context_snippets=snippets,
    ))
    return 0
