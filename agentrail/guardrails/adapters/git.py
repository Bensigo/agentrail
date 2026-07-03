"""Git adapter — produces ``changed_files`` / ``diff`` / ``deleted_files`` slices
of :class:`~agentrail.guardrails.signals.Signals` (issue #919).

This is where the git I/O that used to live in
``agentrail/run/verify_gate.collect_changed_files`` now lives.  The classification
that USED it moved into a pure policy
(:mod:`agentrail.guardrails.policies.proof_required`); this adapter is the only
place ``git``/``subprocess`` is touched (AC4).

The change set is the UNION of:
  * committed-on-branch changes — ``git diff merge-base(HEAD, base)..HEAD`` (AFK
    flow, where the agent's work is committed to a feature branch), and
  * uncommitted working-tree changes — tracked diffs + individually-listed
    untracked files (runner flow, where the agent leaves changes uncommitted).

Looking at only one of those is the false-green hole #899 hit (verbatim semantics
preserved from #907 so the Python gate is byte-for-byte unchanged — AC5).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import List, Optional, Sequence

DEFAULT_BASE_REF = "origin/main"


def _git(args: Sequence[str], cwd: Path) -> str:
    """Run a git command best-effort; return stdout or "" on any failure."""
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=30
        )
    except Exception:
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout or ""


def _resolve_base(base_ref: Optional[str]) -> str:
    return base_ref or os.environ.get("AGENTRAIL_BASE_REF") or DEFAULT_BASE_REF


def collect_changed_files(
    repo_dir: Path | str = ".", *, base_ref: Optional[str] = None
) -> List[str]:
    """Return the full set of files this change touches, against the base branch.

    Union of committed-on-branch changes (merge-base..HEAD) and uncommitted
    working-tree changes (tracked diffs + individually-listed untracked files).
    Best-effort: any git failure degrades to whatever could be collected (an
    empty list at worst), never raises.
    """
    cwd = Path(repo_dir)
    base = _resolve_base(base_ref)

    files: set[str] = set()

    # Committed-on-branch changes relative to the merge-base with the base branch.
    merge_base = _git(["merge-base", "HEAD", base], cwd).strip()
    if merge_base:
        committed = _git(["diff", "--name-only", merge_base, "HEAD"], cwd)
        files.update(p for p in committed.splitlines() if p.strip())

    # Tracked working-tree changes (staged + unstaged) vs HEAD.
    tracked = _git(["diff", "--name-only", "HEAD"], cwd)
    files.update(p for p in tracked.splitlines() if p.strip())

    # Untracked files, enumerated one-per-file (git status --porcelain collapses a
    # wholly-new directory to "?? dir/", which would hide the source files inside).
    untracked = _git(["ls-files", "--others", "--exclude-standard"], cwd)
    files.update(p for p in untracked.splitlines() if p.strip())

    return sorted(files)


def collect_diff(
    repo_dir: Path | str = ".", *, base_ref: Optional[str] = None
) -> str:
    """Return the unified diff text for the change (committed + working tree).

    Best-effort; "" on any git failure.
    """
    cwd = Path(repo_dir)
    base = _resolve_base(base_ref)
    parts: List[str] = []
    merge_base = _git(["merge-base", "HEAD", base], cwd).strip()
    if merge_base:
        committed = _git(["diff", merge_base, "HEAD"], cwd)
        if committed.strip():
            parts.append(committed)
    working = _git(["diff", "HEAD"], cwd)
    if working.strip():
        parts.append(working)
    return "\n".join(parts)


def collect_deleted_files(
    repo_dir: Path | str = ".", *, base_ref: Optional[str] = None
) -> List[str]:
    """Return files this change DELETES (committed + working tree).

    Best-effort; empty list on any git failure.
    """
    cwd = Path(repo_dir)
    base = _resolve_base(base_ref)
    deleted: set[str] = set()
    merge_base = _git(["merge-base", "HEAD", base], cwd).strip()
    if merge_base:
        out = _git(
            ["diff", "--name-only", "--diff-filter=D", merge_base, "HEAD"], cwd
        )
        deleted.update(p for p in out.splitlines() if p.strip())
    out = _git(["diff", "--name-only", "--diff-filter=D", "HEAD"], cwd)
    deleted.update(p for p in out.splitlines() if p.strip())
    return sorted(deleted)


def collect_classified_changes(
    repo_dir: Path | str = ".", *, base_ref: Optional[str] = None
) -> tuple[List[str], List[str]]:
    """Split the change into (modified_preexisting, created) file lists.

    Live recall (#1037) uses the pre-existing-modified list as its denominator
    and excludes created files entirely — a file the agent invented was never
    something the pack could have retrieved. This is the diff-filter-classified
    sibling of :func:`collect_changed_files`, kept here so ALL git I/O lives in
    the one adapter (AC4 contract).

    * ``modified_preexisting`` — files that existed at the base and were changed:
      ``git diff --diff-filter=M`` over both the committed-on-branch range and
      the working tree.
    * ``created`` — files the change ADDED: ``--diff-filter=A`` plus untracked
      files in the working tree (which git does not classify at all).

    A path that shows up as both (e.g. deleted-then-recreated, or added on the
    branch but shown modified in the working tree) is treated as created and
    removed from the modified set, matching the "created files are excluded"
    rule verbatim. Best-effort: any git failure degrades to what could be
    collected, never raises.
    """
    cwd = Path(repo_dir)
    base = _resolve_base(base_ref)

    modified: set[str] = set()
    created: set[str] = set()

    merge_base = _git(["merge-base", "HEAD", base], cwd).strip()
    if merge_base:
        m = _git(["diff", "--name-only", "--diff-filter=M", merge_base, "HEAD"], cwd)
        modified.update(p for p in m.splitlines() if p.strip())
        a = _git(["diff", "--name-only", "--diff-filter=A", merge_base, "HEAD"], cwd)
        created.update(p for p in a.splitlines() if p.strip())

    m = _git(["diff", "--name-only", "--diff-filter=M", "HEAD"], cwd)
    modified.update(p for p in m.splitlines() if p.strip())
    a = _git(["diff", "--name-only", "--diff-filter=A", "HEAD"], cwd)
    created.update(p for p in a.splitlines() if p.strip())

    # Untracked working-tree files git does not classify — they are created.
    untracked = _git(["ls-files", "--others", "--exclude-standard"], cwd)
    created.update(p for p in untracked.splitlines() if p.strip())

    # Created wins: never let an invented file inflate the recall denominator.
    modified -= created
    return sorted(modified), sorted(created)


__all__ = [
    "collect_changed_files",
    "collect_diff",
    "collect_deleted_files",
    "collect_classified_changes",
]
