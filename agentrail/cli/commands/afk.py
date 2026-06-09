"""
``agentrail afk`` — Python entry point for the AFK workflow.

Replaces the legacy bash ``afk-workflow`` script. Builds the Redux-style store,
seeds the queue from GitHub, and runs the asyncio orchestrator.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
from pathlib import Path
from typing import List

from agentrail.afk import github as gh
from agentrail.afk.runner import Runner, build_store


def _usage() -> str:
    return """Usage:
  agentrail afk [--concurrency N] [--engine claude|codex] [--base BRANCH]
                [--afk-label LABEL] [--queue-labels a,b] [--max-retries N]
                [--max-review-rounds N] [--dry-run]

Runs the AFK workflow: pick approved GitHub issues, implement each in an
isolated worktree, open a PR, review it, and either merge, auto-fix P0/P1
findings in place, or comment P2/P3 findings for the engineer to decide.

State is a single JSON snapshot at .agentrail/afk/state.json (the single source
of truth). Slot claiming is synchronous, so two workers never take the same
issue.
"""


def _parse(args: List[str]) -> dict:
    opts = {
        "target": Path("."),
        "concurrency": 2,
        "engine": "claude",
        "base": "main",
        "afk_label": "afk",
        "queue_labels": ["review-fix", "ready-for-agent"],
        "max_retries": 2,
        "max_review_rounds": 3,
        "dry_run": False,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            opts["target"] = Path(args[i + 1]); i += 2
        elif a == "--concurrency":
            opts["concurrency"] = int(args[i + 1]); i += 2
        elif a == "--engine":
            opts["engine"] = args[i + 1]; i += 2
        elif a == "--base":
            opts["base"] = args[i + 1]; i += 2
        elif a == "--afk-label":
            opts["afk_label"] = args[i + 1]; i += 2
        elif a == "--queue-labels":
            opts["queue_labels"] = [x for x in args[i + 1].split(",") if x]; i += 2
        elif a == "--max-retries":
            opts["max_retries"] = int(args[i + 1]); i += 2
        elif a == "--max-review-rounds":
            opts["max_review_rounds"] = int(args[i + 1]); i += 2
        elif a == "--dry-run":
            opts["dry_run"] = True; i += 1
        elif a in ("-h", "--help"):
            print(_usage()); raise SystemExit(0)
        else:
            raise SystemExit(f"unknown option: {a}")
    return opts


def run_afk(args: List[str]) -> int:
    opts = _parse(args)
    target = opts["target"].resolve()

    if opts["engine"] not in ("claude", "codex"):
        print(f"unsupported engine: {opts['engine']}"); return 1

    issues = gh.list_queue_issues(opts["afk_label"], opts["queue_labels"])
    if not issues:
        print("AFK: no queued issues matching labels; nothing to do.")
        return 0

    if opts["dry_run"]:
        print(f"AFK dry-run — would process {len(issues)} issue(s) "
              f"at concurrency {opts['concurrency']}:")
        for it in issues:
            print(f"  #{it['number']} {it['title']}")
        return 0

    # ensure the labels the workflow projects onto GitHub exist
    gh.ensure_label("afk-in-progress", "BFDADC", "Claimed by the AFK workflow.")
    gh.ensure_label("pr-reviewed", "C5DEF5", "PR completed automated review.")
    gh.ensure_label("human-review-needed", "D4C5F9",
                    "PR needs human review — automated review failed repeatedly.")

    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = target / ".afk-workflow" / stamp

    store = build_store(
        target,
        concurrency=opts["concurrency"],
        max_retries=opts["max_retries"],
        max_review_rounds=opts["max_review_rounds"],
        issues=issues,
    )
    runner = Runner(
        target,
        engine=opts["engine"],
        base=opts["base"],
        concurrency=opts["concurrency"],
        afk_label=opts["afk_label"],
        queue_labels=opts["queue_labels"],
        run_dir=run_dir,
        store=store,
    )

    print(f"AFK: {len(issues)} issue(s), concurrency {opts['concurrency']}, "
          f"engine {opts['engine']}. State → {target}/.agentrail/afk/state.json")
    final = asyncio.run(runner.run())
    print(f"AFK done. {final.completed} merged, {final.failed} need human review.")
    return 0
