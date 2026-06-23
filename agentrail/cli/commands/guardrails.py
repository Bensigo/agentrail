"""``agentrail guardrails`` — discover the active guardrail inventory.

Subcommands:

* ``list``  — print every registered guardrail (name, description,
  blocking-vs-advisory, framework-neutral indicator).  Exit 0 (#922 AC1).
* ``docs``  — render ``docs/agents/guardrails.md`` from the same registry;
  ``--write`` commits it to disk, otherwise it prints to stdout (#922 AC2).

Both subcommands read :func:`agentrail.guardrails.list_guardrails`, the single
registry, so a newly-registered guardrail appears in both with no other change
(#922 AC3/AC4).  Nothing here is hand-maintained.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List

from agentrail.guardrails import list_guardrails
from agentrail.guardrails.docs import doc_path, render_doc, write_doc


def _repo_dir() -> Path:
    """Return the agentrail source repository root."""
    return Path(__file__).resolve().parents[3]


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail guardrails list\n"
        "  agentrail guardrails docs [--write]\n"
        "\n"
        "Subcommands:\n"
        "  list   List every registered guardrail\n"
        "  docs   Render docs/agents/guardrails.md from the registry\n"
        "\n"
        "Options:\n"
        "  --write     (docs) write the file instead of printing it\n"
        "  -h, --help  Show this help\n"
    )


# ---------------------------------------------------------------------------
# Subcommand: list
# ---------------------------------------------------------------------------

def _run_list(args: List[str]) -> int:
    if args and args[0] in ("-h", "--help"):
        print(_usage())
        return 0
    if args:
        print(f"Unknown option: {args[0]}", file=sys.stderr)
        return 2

    guardrails = list_guardrails()
    print(f"AgentRail guardrails ({len(guardrails)}):")
    for g in guardrails:
        posture = "blocking" if g.blocking else "advisory"
        neutral = "yes" if getattr(g, "framework_neutral", False) else "no"
        print(f"- {g.name}")
        print(f"  description: {g.description}")
        print(f"  posture: {posture}")
        print(f"  framework-neutral: {neutral}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: docs
# ---------------------------------------------------------------------------

def _run_docs(args: List[str]) -> int:
    write = False
    for a in args:
        if a == "--write":
            write = True
        elif a in ("-h", "--help"):
            print(_usage())
            return 0
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            return 2

    if write:
        path = write_doc(_repo_dir())
        print(f"Wrote {path}")
        return 0

    print(render_doc(), end="")
    return 0


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def run_guardrails(args: List[str]) -> int:
    """Dispatch ``agentrail guardrails <subcommand>``."""
    kind = args[0] if args else ""

    if kind in ("", "-h", "--help"):
        print(_usage())
        return 0

    if kind == "list":
        return _run_list(args[1:])

    if kind == "docs":
        return _run_docs(args[1:])

    print(f"Unknown guardrails command: {kind}", file=sys.stderr)
    return 2
