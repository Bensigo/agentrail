"""``agentrail langfuse`` — operator commands for the Langfuse integration.

Mirrors the subcommand-dispatch shape of ``agentrail/cli/commands/evals.py``
(a ``kind = args[0]`` dispatch inside ``run_langfuse``).

Three subcommands:

  * ``sync-models`` pushes ``agentrail.context.pricing.PRICE_TABLE`` into
    Langfuse's Models API via ``agentrail.observability.price_sync.sync_models``
    (see that module's docstring for the pinned API contract and
    unit-conversion rules).
  * ``push-scores`` pushes truth/judge scores (``solved``, ``false_green``,
    ``verify_verdict``, ``judge_verdict``) onto Langfuse traces via
    ``agentrail.observability.score_push.push_scores`` (see that module's
    docstring for the pinned scores-API contract and the fail-closed
    per-record contract).
  * ``calibration-report`` reads those same scores back and reports how often
    the optional shadow judge (``judge_verdict``) agrees with the ground
    truth (``solved`` / ``verify_verdict``) via
    ``agentrail.observability.calibration.calibration`` (see that module's
    docstring for the pinned read-side API contract and the no-vanity-metrics
    sample-size gate); writes a dated markdown report under
    ``agentrail/evals/reports/``.

All three are explicit operator actions — none is ever run implicitly by a
flag, so there is no feature-flag gate here.
"""
from __future__ import annotations

import sys
from datetime import date as _date
from pathlib import Path
from typing import List

from agentrail.observability.calibration import calibration, write_markdown_report
from agentrail.observability.langfuse_client import LangfuseHTTP
from agentrail.observability.price_sync import sync_models
from agentrail.observability.score_push import push_scores


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail langfuse sync-models [--dry-run]\n"
        "  agentrail langfuse push-scores --records <dir> [--judge <ledger.json>] [--dry-run]\n"
        "  agentrail langfuse calibration-report [--reports-dir <dir>] [--date YYYY-MM-DD]\n"
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
        "  calibration-report\n"
        "               Read judge_verdict/solved/verify_verdict scores back from\n"
        "               Langfuse and report how often the shadow judge agrees with\n"
        "               the ground truth. Writes a dated markdown report; an\n"
        "               agreement rate below n=10 renders as insufficient data,\n"
        "               never a bare percentage.\n"
        "\n"
        "Options:\n"
        "  --dry-run       Report what would be created/pushed without issuing any\n"
        "                  POST requests.\n"
        "  --records <dir> (push-scores) Directory of run-record JSON files.\n"
        "  --judge <file>  (push-scores) Optional JSON ledger of shadow-judge\n"
        "                  verdicts keyed by record identity.\n"
        "  --reports-dir <dir>\n"
        "                  (calibration-report) Directory to write the dated\n"
        "                  report into. Defaults to agentrail/evals/reports/.\n"
        "  --date YYYY-MM-DD\n"
        "                  (calibration-report) Date to stamp the report file\n"
        "                  and its 'Generated:' line with. Defaults to today.\n"
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


def _run_calibration_report(args: List[str]) -> int:
    reports_dir: str = ""
    date: str = ""
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            return 0
        elif a == "--reports-dir":
            if i + 1 >= len(args):
                print("error: --reports-dir requires a value", file=sys.stderr)
                return 2
            reports_dir = args[i + 1]
            i += 2
        elif a == "--date":
            if i + 1 >= len(args):
                print("error: --date requires a value", file=sys.stderr)
                return 2
            date = args[i + 1]
            i += 2
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

    result = calibration(client)
    date_str = date or _date.today().isoformat()
    path = write_markdown_report(
        result,
        reports_dir=Path(reports_dir) if reports_dir else None,
        date=date_str,
    )

    print(f"Wrote {path}")
    print(f"n={result['n']} (insufficient: {result['insufficient']})")
    for key, rate in result["agreement"].items():
        print(f"  {key}: {rate if rate is not None else 'n/a'}")
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

    if kind == "calibration-report":
        return _run_calibration_report(args[1:])

    print(f"Unknown langfuse command: {kind}", file=sys.stderr)
    return 2
