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


__all__ = ["collect_changed_files", "collect_diff", "collect_deleted_files"]
