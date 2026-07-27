from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Iterable, Optional, Set


def git_ignored_set(root: Path, paths: Iterable[str], respect_git_ignore: bool) -> Set[str]:
    path_list = list(paths)
    if not respect_git_ignore or not path_list:
        return set()
    try:
        subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return set()
    result = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--stdin"],
        input="\n".join(path_list),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return {line for line in result.stdout.splitlines() if line}


def current_commit_sha(root: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except subprocess.CalledProcessError:
        return None
    value = result.stdout.strip()
    return value or None


# Moved here from agentrail.cli.commands.context (Repo Wiki task-time-context
# spec, section A "Shared repo-full-name helper" —
# docs/superpowers/specs/2026-07-27-repo-wiki-task-time-context-design.md):
# the run path (agentrail.run.context.build_pack) needs the EXACT SAME
# owner/repo resolution the CLI's `context index` push path already had, so
# a second copy of git-remote parsing would just be drift waiting to happen.
# `agentrail.shared` is the right common home for both callers — neither the
# run path nor the CLI should depend on the other, and this stays out of
# agentrail.context on purpose (wiki_push.py's own docstring explicitly
# flags "CLI-only git-remote parsing living inside agentrail.context" as a
# boundary to avoid; the run path's need for it doesn't change that — it's
# still git-porcelain plumbing, not a context-engine concern).
#
# Mirrors agentrail.afk.hosted_repo_guard.parse_repo_slug /
# agentrail.cli.commands.afk._origin_repo_slug's exact regex and resolution
# strategy — duplicated locally rather than cross-imported, both for the
# self-containment convention hosted_repo_guard.py's own docstring documents
# ("import-free of its sibling seam modules") and because that module lives
# under agentrail.afk, a layer neither agentrail.context nor agentrail.run
# should reach into for a two-line regex.
_GITHUB_REMOTE_RE = re.compile(r"github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?$")


def origin_repo_full_name(target: Path) -> Optional[str]:
    """Best-effort lowercase ``owner/repo`` for ``target``'s git ``origin``
    remote. ``None`` when there is no origin remote, ``target`` isn't a git
    checkout, or the URL isn't a recognizable GitHub remote (including SSH
    host aliases — this deliberately does no ssh-config parsing) — every
    caller treats that as "nothing to push/hydrate wiki pages under", never
    an error.
    """
    result = subprocess.run(
        ["git", "-C", str(target), "remote", "get-url", "origin"],
        check=False, capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    match = _GITHUB_REMOTE_RE.search(result.stdout.strip())
    if not match:
        return None
    owner, repo = match.group(1), match.group(2)
    if not owner or not repo:
        return None
    return f"{owner}/{repo}".lower()
