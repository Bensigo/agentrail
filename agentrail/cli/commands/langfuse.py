"""``agentrail langfuse`` — operator commands for the Langfuse integration.

Mirrors the subcommand-dispatch shape of ``agentrail/cli/commands/evals.py``
(a ``kind = args[0]`` dispatch inside ``run_langfuse``).

Currently one subcommand: ``sync-models``, which pushes
``agentrail.context.pricing.PRICE_TABLE`` into Langfuse's Models API via
``agentrail.observability.price_sync.sync_models`` (see that module's
docstring for the pinned API contract and unit-conversion rules). This is an
explicit operator action — it is never run implicitly by a flag, so there is
no feature-flag gate here.
"""
from __future__ import annotations

import sys
from typing import List

from agentrail.observability.langfuse_client import LangfuseHTTP
from agentrail.observability.price_sync import sync_models


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail langfuse sync-models [--dry-run]\n"
        "\n"
        "Subcommands:\n"
        "  sync-models  Push agentrail.context.pricing.PRICE_TABLE into Langfuse's\n"
        "               Models API (client-side idempotent: GET-compare-create;\n"
        "               Langfuse has no upsert/delete model endpoint).\n"
        "\n"
        "Options:\n"
        "  --dry-run    Report what would be created/left unchanged without\n"
        "               issuing any POST requests.\n"
        "  -h, --help   Show this help\n"
    )


def _run_sync_models(args: List[str]) -> int:
    dry_run = False
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            return 0
        elif a == "--dry-run":
            dry_run = True
            i += 1
        else:
            print(f"error: unknown option: {a}", file=sys.stderr)
            return 2

    client = LangfuseHTTP.from_env()
    if client is None:
        print(
            "error: Langfuse is not configured "
            "(set LANGFUSE_HOST or LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY)",
            file=sys.stderr,
        )
        return 1

    result = sync_models(client, dry_run=dry_run)

    verb = "Would create" if dry_run else "Created"
    print(f"{verb}: {len(result['created'])} ({', '.join(result['created']) or '(none)'})")
    print(f"Unchanged: {len(result['unchanged'])} ({', '.join(result['unchanged']) or '(none)'})")
    if result["stale"]:
        print(f"Stale (superseded by a corrected definition): {', '.join(result['stale'])}")
    return 0


def run_langfuse(args: List[str]) -> int:
    """Dispatch ``agentrail langfuse <subcommand>``."""
    kind = args[0] if args else ""

    if kind in ("", "-h", "--help"):
        print(_usage())
        return 0

    if kind == "sync-models":
        return _run_sync_models(args[1:])

    print(f"Unknown langfuse command: {kind}", file=sys.stderr)
    return 2
