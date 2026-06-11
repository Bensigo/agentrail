"""
``agentrail internal`` — native dispatcher for internal helpers.

Replaces the legacy bash ``internal`` (review-pr + worktree mark).

``review-pr`` runs NATIVELY via ``agentrail/afk/review_engine.py`` (the legacy
bash ``templates/scripts/review-pr`` and the ``AGENTRAIL_NATIVE_REVIEW`` escape
hatch were removed after live validation — see milestone M3 / issue #430).
``worktree mark`` updates the worktree lifecycle in state.json.
"""
from __future__ import annotations
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from agentrail.run.state import update_worktree_state


def _usage() -> str:
    return ("Usage:\n"
            "  agentrail internal review-pr --pr N [--engine codex] [--output FILE] [--machine-readable]\n"
            "  agentrail internal worktree mark --path DIR --status STATUS [--target DIR] [--issue N] [--pr N] [--run-dir DIR] [--base BRANCH] [--slot N]\n")


def run_internal(args: List[str]) -> int:
    if not args:
        print(_usage(), file=sys.stderr)
        return 1
    if args[0] in ("-h", "--help"):
        print(_usage())
        return 0
    cmd, rest = args[0], args[1:]
    if cmd == "review-pr":
        return _review_pr_native(rest)
    if cmd == "worktree":
        return _worktree(rest)
    print(f"Unknown internal command: {cmd}", file=sys.stderr)
    return 2


def _die(msg: str) -> int:
    print(f"agentrail review: {msg}", file=sys.stderr)
    return 1


def _gh_view(pr: str) -> Optional[dict]:
    proc = subprocess.run(
        ["gh", "pr", "view", pr, "--json",
         "number,title,url,headRefName,baseRefName,state"],
        check=False, capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], check=False, capture_output=True, text=True)


def _review_pr_native(rest: List[str]) -> int:
    """Native PR review (formerly ``templates/scripts/review-pr``).

    Preserves the arg parse, dep checks, gh metadata fetch, and the
    exact fetch/switch/pull ordering (the AFK data-loss fix), then builds the
    prompt (with the machine-readable contract) and invokes the review agent.
    Exit-code semantics: 0 = success, nonzero = failure (AFK treats nonzero as a
    failed review).
    """
    from agentrail.afk import review_engine

    pr = ""
    base = ""
    engine = "codex"
    output = ""
    machine_readable = False

    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--pr":
            if i + 1 >= len(rest):
                return _die("--pr requires a number")
            pr = rest[i + 1]
            i += 2
        elif a == "--base":
            if i + 1 >= len(rest):
                return _die("--base requires a branch")
            base = rest[i + 1]
            i += 2
        elif a == "--engine":
            if i + 1 >= len(rest):
                return _die("--engine requires a value")
            engine = rest[i + 1]
            i += 2
        elif a == "--output":
            if i + 1 >= len(rest):
                return _die("--output requires a file path")
            output = rest[i + 1]
            i += 2
        elif a == "--machine-readable":
            machine_readable = True
            i += 1
        elif a in ("-h", "--help"):
            print(_usage())
            return 0
        else:
            return _die(f"unknown option: {a}")

    if not pr:
        print(_usage(), file=sys.stderr)
        return 1
    if engine not in ("codex", "claude"):
        return _die(f"unsupported review engine: {engine}")
    if machine_readable and not output:
        return _die(
            "--machine-readable requires --output so AgentRail can validate the "
            "review contract"
        )

    # Dependency checks (git/gh/jq + the chosen agent). jq is retained for parity
    # with the script's checks even though native validation no longer shells out
    # to it.
    for dep in ("git", "gh", "jq"):
        if shutil.which(dep) is None:
            return _die(f"missing required command: {dep}")
    if shutil.which(engine) is None:
        return _die(f"missing required command: {engine}")

    # cd to the repo toplevel (the script does this so doc/relative paths and the
    # checkout operate on the right tree).
    root_proc = _git("rev-parse", "--show-toplevel")
    if root_proc.returncode != 0 or not root_proc.stdout.strip():
        return _die("not inside a git repository")
    repo_root = Path(root_proc.stdout.strip())

    # AFK runs this inside a clean disposable worktree, so the script's
    # ensure_clean_tree lockfile auto-commit is intentionally dropped here.

    meta = _gh_view(pr)
    if meta is None:
        return _die(f"could not load PR metadata for #{pr}")
    title = meta.get("title", "")
    url = meta.get("url", "")
    head_ref = meta.get("headRefName", "")
    base_ref = meta.get("baseRefName", "")
    base = base or base_ref

    # Preserve the EXACT ordering from the script — this is the AFK data-loss
    # fix: fetch base, fetch head, switch head, ff-only pull head.
    for args in (
        ("fetch", "origin", base),
        ("fetch", "origin", head_ref),
        ("switch", head_ref),
        ("pull", "--ff-only", "origin", head_ref),
    ):
        proc = _git("-C", str(repo_root), *args)
        if proc.returncode != 0:
            return _die(
                f"git {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}"
            )

    print(f"==> Review PR #{pr}: {title}")
    print(f"    {url}")
    print(f"    base: {base}")
    print(f"    head: {head_ref}")

    try:
        prompt = review_engine.build_review_prompt(
            pr, title, url, machine_readable, repo_root,
        )
    except review_engine.ReviewError as exc:
        return _die(str(exc))

    rc = review_engine.run_review(
        engine, base, pr, prompt, output or None, cwd=repo_root,
    )
    if rc != 0:
        return rc

    if machine_readable:
        try:
            review_engine.validate_machine_readable_output(Path(output))
        except review_engine.ReviewError as exc:
            return _die(str(exc))

    return 0


def _worktree(rest: List[str]) -> int:
    if not rest:
        print("internal worktree requires an action", file=sys.stderr)
        return 2
    action, opts = rest[0], rest[1:]
    target = os.getcwd()
    path = status = run_dir = base = ""
    issue = pr = slot = ""
    i = 0

    while i < len(opts):
        a = opts[i]
        if a in ("--target", "--path", "--status", "--issue", "--pr", "--run-dir", "--base", "--slot"):
            # Check that a value follows and is not itself a flag
            if i + 1 >= len(opts) or opts[i + 1].startswith("--"):
                print(f"{a} requires a value", file=sys.stderr)
                return 2
            val = opts[i + 1]
            if a == "--target":
                target = val
            elif a == "--path":
                path = val
            elif a == "--status":
                status = val
            elif a == "--issue":
                issue = val
            elif a == "--pr":
                pr = val
            elif a == "--run-dir":
                run_dir = val
            elif a == "--base":
                base = val
            elif a == "--slot":
                slot = val
            i += 2
        else:
            print(f"Unknown internal worktree option: {a}", file=sys.stderr)
            return 2

    if action != "mark":
        print(f"unknown internal worktree action: {action}", file=sys.stderr)
        return 2
    if not path:
        print("internal worktree mark requires --path", file=sys.stderr)
        return 2
    if not status:
        print("internal worktree mark requires --status", file=sys.stderr)
        return 2

    target_abs = str(Path(target).resolve())
    wt_path = path if os.path.isabs(path) else os.path.join(target_abs, path)

    try:
        update_worktree_state(
            Path(target_abs), wt_path, status,
            issue=int(issue) if issue else None,
            pr=int(pr) if pr else None,
            run_dir=run_dir, base=base,
            slot=int(slot) if slot else None,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0
