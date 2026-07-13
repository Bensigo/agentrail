"""``agentrail langfuse`` — operator commands for the Langfuse integration.

Mirrors the subcommand-dispatch shape of ``agentrail/cli/commands/evals.py``
(a ``kind = args[0]`` dispatch inside ``run_langfuse``).

Two subcommands:

  * ``sync-models`` pushes ``agentrail.context.pricing.PRICE_TABLE`` into
    Langfuse's Models API via ``agentrail.observability.price_sync.sync_models``
    (see that module's docstring for the pinned API contract and
    unit-conversion rules).
  * ``push-scores`` pushes truth/judge scores (``solved``, ``false_green``,
    ``verify_verdict``, ``judge_verdict``) onto Langfuse traces via
    ``agentrail.observability.score_push.push_scores`` (see that module's
    docstring for the pinned scores-API contract and the fail-closed
    per-record contract).

Both are explicit operator actions — neither is ever run implicitly by a
flag, so there is no feature-flag gate here.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List

from agentrail.observability.langfuse_client import LangfuseHTTP
from agentrail.observability.price_sync import sync_models
from agentrail.observability.score_push import push_scores


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail langfuse sync-models [--dry-run]\n"
        "  agentrail langfuse push-scores --records <dir> [--judge <ledger.json>] [--dry-run]\n"
        "\n"
        "Subcommands:\n"
        "  sync-models  Push agentrail.context.pricing.PRICE_TABLE into Langfuse's\n"
        "               Models API (client-side idempotent: GET-compare-create;\n"
        "               Langfuse has no upsert/delete model endpoint).\n"
        "  push-scores  Push solved/false_green/verify_verdict/judge_verdict scores\n"
        "               onto Langfuse traces from a directory of run-record JSON\n"
        "               files (production run-records or eval per-rep records).\n"
        "               Fail-closed per record: a malformed record is skipped with\n"
        "               a reason, never blocks the rest of the batch.\n"
        "\n"
        "Options:\n"
        "  --dry-run       Report what would be created/pushed without issuing any\n"
        "                  POST requests.\n"
        "  --records <dir> (push-scores) Directory of run-record JSON files.\n"
        "  --judge <file>  (push-scores) Optional JSON ledger of shadow-judge\n"
        "                  verdicts keyed by record identity.\n"
        "  -h, --help      Show this help\n"
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


def _run_push_scores(args: List[str]) -> int:
    dry_run = False
    records_dir: str = ""
    judge_file: str = ""
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            return 0
        elif a == "--dry-run":
            dry_run = True
            i += 1
        elif a == "--records":
            if i + 1 >= len(args):
                print("error: --records requires a value", file=sys.stderr)
                return 2
            records_dir = args[i + 1]
            i += 2
        elif a == "--judge":
            if i + 1 >= len(args):
                print("error: --judge requires a value", file=sys.stderr)
                return 2
            judge_file = args[i + 1]
            i += 2
        else:
            print(f"error: unknown option: {a}", file=sys.stderr)
            return 2

    if not records_dir:
        print("error: --records <dir> is required", file=sys.stderr)
        return 2

    client = LangfuseHTTP.from_env()
    if client is None:
        print(
            "error: Langfuse is not configured "
            "(set LANGFUSE_HOST or LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY)",
            file=sys.stderr,
        )
        return 1

    result = push_scores(
        client,
        Path(records_dir),
        Path(judge_file) if judge_file else None,
        dry_run=dry_run,
    )

    verb = "Would push" if dry_run else "Pushed"
    print(f"{verb}: {result['pushed']} score(s)")
    print(f"Skipped: {len(result['skipped'])}")
    for item in result["skipped"]:
        print(f"  {item['record']}: {item['reason']}")
    return 0


def run_langfuse(args: List[str]) -> int:
    """Dispatch ``agentrail langfuse <subcommand>``."""
    kind = args[0] if args else ""

    if kind in ("", "-h", "--help"):
        print(_usage())
        return 0

    if kind == "sync-models":
        return _run_sync_models(args[1:])

    if kind == "push-scores":
        return _run_push_scores(args[1:])

    print(f"Unknown langfuse command: {kind}", file=sys.stderr)
    return 2
