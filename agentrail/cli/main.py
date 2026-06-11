from __future__ import annotations

import sys
from pathlib import Path
from typing import List

from agentrail.cli.commands.afk import run_afk
from agentrail.cli.commands.cleanup import run_cleanup
from agentrail.cli.commands.doctor import run_doctor
from agentrail.cli.commands.grill import run_grill
from agentrail.cli.commands.issue import run_issue
from agentrail.cli.commands.milestone import run_milestone
from agentrail.cli.commands.prd import run_prd
from agentrail.cli.commands.console import run_console
from agentrail.cli.commands.context import run_context
from agentrail.cli.commands.install import run_install
from agentrail.cli.commands.internal import run_internal
from agentrail.cli.commands.labels import run_labels
from agentrail.cli.commands.link import run_link
from agentrail.cli.commands.memory import run_memory
from agentrail.cli.commands.prompt import run_prompt
from agentrail.cli.commands.skills import run_skills
from agentrail.cli.commands.resume import run_resume
from agentrail.cli.commands.run import run_run
from agentrail.cli.commands.status import run_status
from agentrail.cli.commands.upgrade import run_upgrade
from agentrail.cli.commands.timeline import run_timeline


def _repo_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail context sources [--target DIR]\n"
        "  agentrail context index [--target DIR]\n"
        "  agentrail context query \"<task>\" [--target DIR]\n"
        "  agentrail run [--agent codex|claude] [--target DIR]\n"
        "  agentrail run issue NUMBER [--agent codex|claude] [--target DIR]\n"
        "  agentrail afk [--concurrency 2] [--max-waves 20] [--base main] [--dry-run]\n"
        "  agentrail status [--target DIR]\n"
        "  agentrail doctor [--target DIR]\n"
        "  agentrail upgrade [--target DIR] [--force]\n"
        "  agentrail init [--target DIR] [--force]\n"
        "  agentrail install [--target DIR] [--force]\n"
        "  agentrail grill-me [plan-or-path] [--agent codex|claude] [--target DIR] [--headless]\n"
        "  agentrail issue create <milestone-or-prd> [--agent codex|claude] [--target DIR] [--headless] [--dry-run]\n"
        "  agentrail milestone create <prd> [--agent codex|claude] [--target DIR] [--headless] [--dry-run]\n"
        "  agentrail prd create <brief> [--agent codex|claude] [--target DIR] [--headless] [--dry-run]\n"
        "  agentrail prompt issue NUMBER [--target DIR]\n"
        "  agentrail prompt review PR_NUMBER [--target DIR]\n"
        "  agentrail internal <subcommand>\n"
        "  agentrail memory recall QUERY [--target DIR]\n"
        "  agentrail memory capture KIND TITLE [--target DIR]\n"
        "  agentrail skills list [--target DIR]\n"
        "  agentrail skills resolve \"<task>\" [--target DIR]\n"
        "  agentrail resume [--target DIR]\n"
        "  agentrail labels sync [--target DIR]\n"
        "  agentrail cleanup [--target DIR] [--dry-run]\n"
        "  agentrail console [--target DIR]\n"
        "  agentrail link [--target DIR]\n"
        "  agentrail timeline [--target DIR]\n"
        "\n"
        "Commands:\n"
        "  context     Build/query the context index\n"
        "  run         Run a workflow\n"
        "  afk         Run the AFK queue/worktree loop\n"
        "  status      Show worktree / session status\n"
        "  doctor      Check installation health\n"
        "  upgrade     Upgrade agentrail in this project\n"
        "  init        Initialise a new project (alias: install)\n"
        "  install     Install agentrail into a project (alias: init)\n"
        "  grill-me    Stress-test a plan with the grill-with-docs skill\n"
        "  issue       Create house-template GitHub issues from a milestone or PRD\n"
        "  milestone   Convert a PRD into docs/milestones/ files\n"
        "  prd         Convert an idea into a PRD published to the issue tracker\n"
        "  prompt      Print an agent-ready prompt\n"
        "  internal    Internal plumbing commands\n"
        "  memory      Manage memory\n"
        "  skills      List / manage skills\n"
        "  resume      Resume a paused session\n"
        "  labels      Manage labels\n"
        "  cleanup     Clean up worktrees / sessions\n"
        "  console     Open the interactive console\n"
        "  link        Link a worktree to a session\n"
        "  timeline    Show session timeline\n"
    )


def main(argv: List[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    # No args or help flag → print usage
    if not args or args[0] in ("-h", "--help"):
        print(_usage(), end="")
        return 0

    if args[0] in ("init", "install"):
        return run_install(args[1:])
    if args[0] == "doctor":
        return run_doctor(args[1:])
    if args[0] == "context":
        return run_context(args[1:])
    if args[0] == "afk":
        return run_afk(args[1:])
    if args[0] == "cleanup":
        return run_cleanup(args[1:])
    if args[0] == "console":
        return run_console(args[1:])
    if args[0] == "link":
        return run_link(args[1:])
    if args[0] == "timeline":
        return run_timeline(args[1:])
    if args[0] == "resume":
        return run_resume(args[1:])
    if args[0] == "status":
        return run_status(args[1:])
    if args[0] == "grill-me":
        return run_grill(args[1:])
    if args[0] == "issue":
        return run_issue(args[1:])
    if args[0] == "milestone":
        return run_milestone(args[1:])
    if args[0] == "prd":
        return run_prd(args[1:])
    if args[0] == "prompt":
        return run_prompt(args[1:])
    if args[0] == "run":
        return run_run(args[1:])
    if args[0] == "upgrade":
        return run_upgrade(args[1:])
    if args[0] == "internal":
        return run_internal(args[1:])
    if args[0] == "labels":
        return run_labels(args[1:])
    if args[0] == "memory":
        return run_memory(args[1:])
    if args[0] == "skills":
        return run_skills(args[1:])

    # Unknown command
    print(f"Unknown command: {args[0]}", file=sys.stderr)
    print(_usage(), end="", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
