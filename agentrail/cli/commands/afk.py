"""
``agentrail afk`` — Python entry point for the AFK workflow.

Replaces the legacy bash ``afk-workflow`` script. Builds the Redux-style store,
seeds the queue from GitHub, and runs the asyncio orchestrator.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

from agentrail.afk import github as gh
from agentrail.afk import hosted_repo_guard
from agentrail.afk.runner import Runner, build_store

# Mirrors the Heartbeat daemon / issue.py connector-mode convention: a single
# workspace context for this CLI process, read straight from the environment
# rather than a new flag (a self-hosted runner or a Jace deployment is already
# scoped to one workspace). Used ONLY to exempt the operator's own workspace
# from the hosted-repo quarantine guard below (#1271). Left unset, NO
# workspace is exempt, so any hosted match refuses (safe over-refusal) — set
# this to your own dogfood workspace id to exempt it.
_WORKSPACE_ID_ENV = "AGENTRAIL_WORKSPACE_ID"


def _usage() -> str:
    return """Usage:
  agentrail afk [--concurrency N] [--engine claude|codex] [--base BRANCH]
                [--afk-label LABEL] [--queue-labels a,b] [--max-retries N]
                [--max-review-rounds N] [--dry-run] [--allow-dirty]
                [--model MODEL] [--budget-per-issue FLOAT]
                [--allow-hosted-repo]

Runs the AFK workflow: pick approved GitHub issues, implement each in an
isolated worktree, open a PR, review it, and either merge, auto-fix P0/P1
findings in place, or comment P2/P3 findings for the engineer to decide.

State is a single JSON snapshot at .agentrail/afk/state.json (the single source
of truth). Slot claiming is synchronous, so two workers never take the same
issue.

Budget: when --budget-per-issue is omitted, the default per-issue cap is read
from `budgets.per_issue_usd` in .agentrail/config.json; when THAT is also
unset, the product default (see `agentrail run --help`) applies. Explicit
0 — either --budget-per-issue 0 or budgets.per_issue_usd: 0 in config —
always means deliberately uncapped, at whichever tier it is set.

Hosted-repo quarantine: AFK refuses to start against a repo connected to a
hosted customer workspace other than this operator's own (AGENTRAIL_WORKSPACE_ID)
— AFK auto-merges once its review gate passes, and must not touch a customer's
repo until grantable merge permission ships (#1278). --allow-hosted-repo
overrides this refusal (the override is logged).
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
        "allow_dirty": False,
        "model": "",
        "budget_per_issue": 0.0,
        "budget_explicit": False,
        "allow_hosted_repo": False,
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
        elif a == "--allow-dirty":
            opts["allow_dirty"] = True; i += 1
        elif a == "--model":
            opts["model"] = args[i + 1]; i += 2
        elif a == "--budget-per-issue":
            opts["budget_per_issue"] = float(args[i + 1])
            opts["budget_explicit"] = True; i += 2
        elif a == "--allow-hosted-repo":
            opts["allow_hosted_repo"] = True; i += 1
        elif a in ("-h", "--help"):
            print(_usage()); raise SystemExit(0)
        else:
            raise SystemExit(f"unknown option: {a}")
    return opts


def _origin_repo_slug(target: Path) -> Tuple[Optional[str], Optional[str]]:
    """Best-effort ``(owner/repo, raw_origin_url)`` for ``target``'s git
    ``origin`` remote.

    ``(None, None)`` when there is no ``origin`` remote, or ``target`` isn't a
    git checkout — the caller treats that as "nothing to hosted-repo-check",
    not an error. ``(None, url)`` when an origin URL exists but isn't a
    recognizable GitHub remote — this includes SSH host aliases (e.g.
    ``git@github-work:owner/repo.git``), which cannot be resolved to
    ``github.com`` without reading the user's ssh config; this module
    deliberately does not do that (no ssh-config parsing), so an aliased
    GitHub remote surfaces here the same as any other unparseable URL, and
    the caller prints a notice naming the raw URL rather than silently
    skipping the quarantine check without saying why.
    """
    result = subprocess.run(
        ["git", "-C", str(target), "remote", "get-url", "origin"],
        check=False, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None, None
    url = result.stdout.strip()
    return hosted_repo_guard.parse_repo_slug(url), url


def run_afk(args: List[str]) -> int:
    opts = _parse(args)
    target = opts["target"].resolve()

    # Guard (#1271): AFK auto-merges unconditionally once its review gate
    # passes (Runner._merge -> gh.merge_pr_squash, afk/runner.py:548-550). Fine
    # against our own dogfood repo; must never fire against a repo connected to
    # a HOSTED CUSTOMER workspace until grantable merge permission ships
    # (#1278). This is the fence until then — placed at the very first entry
    # point, before ANY queue/worktree work (including --dry-run's read-only
    # issue listing below).
    hosted_override_banner = ""
    repo_slug, origin_url = _origin_repo_slug(target)
    if repo_slug is None:
        if origin_url:
            print(
                "AFK: hosted-repo quarantine check skipped: origin remote not "
                "recognized as github.com (SSH host aliases are not "
                f"resolved) — {origin_url}",
                file=sys.stderr,
            )
        else:
            print(
                "AFK: hosted-repo quarantine check skipped: could not determine a "
                "GitHub owner/repo for this checkout's origin remote.",
                file=sys.stderr,
            )
    else:
        own_workspace_id = os.environ.get(_WORKSPACE_ID_ENV)
        foreign, db_notice = hosted_repo_guard.resolve_foreign_workspaces(
            repo_slug, own_workspace_id=own_workspace_id,
        )
        if db_notice:
            print(f"AFK: {db_notice}", file=sys.stderr)
        elif foreign:
            if not opts["allow_hosted_repo"]:
                print(
                    f"AFK refuses to start: {repo_slug} is connected to a "
                    "hosted customer workspace, not this operator's own"
                    + (f" ({own_workspace_id})" if own_workspace_id else "")
                    + ".\n"
                    "AFK auto-merges once its review gate passes and must not "
                    "touch a hosted customer's repo until grantable merge "
                    "permission ships (#1278).\n"
                    "Use --allow-hosted-repo to override (the override is "
                    "logged).",
                    file=sys.stderr,
                )
                return 1
            hosted_override_banner = (
                f" [--allow-hosted-repo OVERRIDE ACTIVE for {repo_slug}]"
            )
            print(
                f"AFK: --allow-hosted-repo override ACTIVE — {repo_slug} "
                "belongs to a hosted customer workspace "
                f"({', '.join(foreign)}); proceeding anyway. This override is "
                "logged.",
                file=sys.stderr,
            )

    # No explicit --budget-per-issue: fall back to budgets.per_issue_usd from
    # .agentrail/config.json. An explicit 0 disables the cap even when the
    # config sets a default.
    if not opts["budget_explicit"]:
        from agentrail.cli.commands.run import resolve_default_budget
        opts["budget_per_issue"] = resolve_default_budget(str(target))

    if opts["engine"] not in ("claude", "codex"):
        print(f"unsupported engine: {opts['engine']}"); return 1

    issues = gh.list_queue_issues(opts["afk_label"], opts["queue_labels"])
    if not issues:
        print(f"AFK: no queued issues matching labels; nothing to do.{hosted_override_banner}")
        return 0

    if opts["dry_run"]:
        print(f"AFK dry-run — would process {len(issues)} issue(s) "
              f"at concurrency {opts['concurrency']}:{hosted_override_banner}")
        blockers = sorted({b for it in issues for b in it.get("blocked_by") or ()})
        open_blockers = gh.open_issue_numbers(blockers) if blockers else set()
        for it in issues:
            held = sorted(set(it.get("blocked_by") or ()) & open_blockers)
            tag = f"  [blocked by {', '.join('#%d' % b for b in held)}]" if held else ""
            print(f"  #{it['number']} {it['title']}{tag}")
        return 0

    # Guard: AFK mutates the main checkout during PR review — it runs
    # `git switch --detach` and `git reset --hard origin/<base>` there
    # (see runner._prepare_for_review / _restore_main). On a dirty tree that
    # silently discards uncommitted work. Refuse unless explicitly overridden.
    if not opts["allow_dirty"]:
        dirty = subprocess.run(
            ["git", "-C", str(target), "status", "--porcelain"],
            check=False, capture_output=True, text=True,
        ).stdout.strip()
        if dirty:
            print(
                "AFK refuses to start: the main checkout has uncommitted changes.\n"
                "During PR review AFK switches and hard-resets this checkout, which "
                "would discard them. Commit or stash your changes first, or run AFK "
                "from a separate clone. Use --allow-dirty to override (work may be lost).",
                file=sys.stderr,
            )
            return 1

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
        model=opts["model"],
        budget_per_issue=opts["budget_per_issue"],
    )

    print(f"AFK: {len(issues)} issue(s), concurrency {opts['concurrency']}, "
          f"engine {opts['engine']}. State → {target}/.agentrail/afk/state.json"
          f"{hosted_override_banner}")
    final = asyncio.run(runner.run())
    print(f"AFK done. {final.completed} merged, {final.failed} need human review.")
    print("Replay this run:  agentrail timeline")
    return 0
