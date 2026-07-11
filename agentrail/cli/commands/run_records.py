"""``agentrail run-records`` — assemble per-run production run records.

Wraps agentrail.run.run_record.assemble_all: read-only over run artifacts
under ``<target>/.agentrail/runs/``, no network. See agentrail/run/run_record.py
for the record schema. Part of issue #1178 (AC1 local slice).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import List

from agentrail.run.run_record import assemble_all, list_candidate_run_ids


def _parse_args(args: List[str]) -> dict:
    """Parse --target/--since/--force/--json. Unknown option or bad value ->
    print to stderr, exit 2. -h/--help -> exit 0 (mirrors status.py's
    _parse_target: prints nothing meaningful for help)."""
    opts = {
        "target": os.getcwd(),
        "since": None,
        "force": False,
        "json": False,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            value = args[i + 1] if (i + 1 < len(args) and not args[i + 1].startswith("--")) else ""
            if not value:
                print("--target requires a directory", file=sys.stderr)
                raise SystemExit(2)
            opts["target"] = value
            i += 2
        elif a == "--since":
            value = args[i + 1] if (i + 1 < len(args) and not args[i + 1].startswith("--")) else ""
            if not value:
                print("--since requires a YYYY-MM-DD date", file=sys.stderr)
                raise SystemExit(2)
            try:
                datetime.strptime(value, "%Y-%m-%d")
            except ValueError:
                print(f"--since must be YYYY-MM-DD, got: {value}", file=sys.stderr)
                raise SystemExit(2)
            opts["since"] = value
            i += 2
        elif a == "--force":
            opts["force"] = True
            i += 1
        elif a == "--json":
            opts["json"] = True
            i += 1
        elif a in ("-h", "--help"):
            raise SystemExit(0)
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            raise SystemExit(2)
    return opts


def run_run_records(args: List[str]) -> int:
    """Assemble per-run records for all runs under --target's .agentrail/runs/.

    Default output: one line per candidate run (assembled or skipped), then a
    summary line. --json: {"assembled": [paths], "skipped": [run_ids]}.
    Returns 0 on success, 2 on bad args.
    """
    try:
        opts = _parse_args(args)
    except SystemExit as exc:
        return int(exc.code)

    target = Path(opts["target"])
    candidates = list_candidate_run_ids(target, opts["since"])
    written = assemble_all(target, since=opts["since"], force=opts["force"])
    written_by_id = {p.stem: p for p in written}

    if opts["json"]:
        out = {
            "assembled": [str(p) for p in written],
            "skipped": [rid for rid in candidates if rid not in written_by_id],
        }
        print(json.dumps(out, indent=2))
        return 0

    skipped_count = 0
    for run_id in candidates:
        if run_id in written_by_id:
            print(f"assembled {run_id} -> {written_by_id[run_id]}")
        else:
            print(f"skipped {run_id} (record exists)")
            skipped_count += 1
    print(f"{len(written)} assembled, {skipped_count} skipped")
    return 0
