"""
Output-token savings accounting for the AFK execute phase (issue #709).

Estimates how many output tokens the agent saved by producing unified diffs
instead of full-file rewrites, and prices those savings via M022 ``cost_for``.

Usage
-----
After an execute-phase run completes inside a worktree::

    entries = collect_worktree_diff(worktree_path, base_branch)
    savings = estimate_output_savings(entries, model_id)
    # savings["outputTokensSaved"], savings["outputDollarsSaved"], savings["estimate"]

The result is intended to be written to the AFK journal as a ``cost_optimizer``
event so ``agentrail cost`` can surface it.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List

from agentrail.context.pricing import cost_for
from agentrail.context.retrieval import estimate_tokens

# Statuses from ``git diff --name-status`` that indicate a modified existing
# file (the only case where diff vs rewrite savings apply).
_MODIFIED_STATUSES = frozenset({"M"})

# Statuses that mean a new or renamed path (no savings — agent had to write
# the full content regardless).
_NEW_OR_RENAME_STATUSES = frozenset({"A", "R", "C"})


def collect_worktree_diff(worktree: Path, base: str) -> List[dict]:
    """Classify every changed file in *worktree* vs ``origin/{base}``.

    Returns a list of per-file dicts::

        {
            "file":                   str,   # repo-relative path
            "status":                 str,   # git status letter: A/M/R/D/C
            "est_full_rewrite_tokens": int,  # 0 for non-M files
            "actual_diff_tokens":     int,   # 0 for non-M files
        }

    Non-fatal: returns [] on any subprocess error or when HEAD == origin/base
    (no commits made by the agent).
    """
    ref = f"origin/{base}"

    # --name-status gives one "STATUS\\tPATH" line per changed file.
    ns = subprocess.run(
        ["git", "-C", str(worktree), "diff", ref, "HEAD", "--name-status"],
        capture_output=True,
        text=True,
    )
    if ns.returncode != 0 or not ns.stdout.strip():
        return []

    entries: List[dict] = []
    for line in ns.stdout.strip().splitlines():
        parts = line.split("\t", 1)
        if len(parts) < 2:
            continue
        status_raw, filepath = parts[0].strip(), parts[1].strip()
        status = status_raw[0]  # first char covers M, A, D, R100, C100 …

        if status not in _MODIFIED_STATUSES:
            # New file, rename, deletion — no savings to claim.
            entries.append(
                {
                    "file": filepath,
                    "status": status,
                    "est_full_rewrite_tokens": 0,
                    "actual_diff_tokens": 0,
                }
            )
            continue

        # Modified file: compare full-file token estimate vs diff token count.
        file_path = worktree / filepath
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
            full_tokens = estimate_tokens(content)
        except OSError:
            full_tokens = 0

        diff_result = subprocess.run(
            [
                "git", "-C", str(worktree), "diff",
                ref, "HEAD", "--", filepath,
            ],
            capture_output=True,
            text=True,
        )
        diff_text = diff_result.stdout if diff_result.returncode == 0 else ""
        diff_tokens = estimate_tokens(diff_text)

        entries.append(
            {
                "file": filepath,
                "status": status,
                "est_full_rewrite_tokens": full_tokens,
                "actual_diff_tokens": diff_tokens,
            }
        )
    return entries


def estimate_output_savings(entries: List[dict], model: str) -> dict:
    """Compute aggregate output-token savings from a list of diff entries.

    For each entry:
    - ``status == "M"``:  saved = max(0, est_full_rewrite_tokens − actual_diff_tokens)
    - all other statuses: saved = 0  (new file / rename / deletion — not an error)

    Dollar savings are priced at the model's output rate via M022 ``cost_for``.
    When *model* is unknown, ``cost_for`` returns ``estimate: True`` and uses
    the sonnet-class fallback rate; that flag is propagated here.

    Returns::

        {
            "outputTokensSaved":  int,
            "outputDollarsSaved": float,
            "estimate":           bool,   # True when model is unknown
            "model":              str,
            "outputRatePerMtok":  float,  # $/Mtok output rate used
            "perFile": [
                {
                    "file":                    str,
                    "status":                  str,
                    "est_full_rewrite_tokens":  int,
                    "actual_diff_tokens":       int,
                    "outputTokensSaved":        int,
                },
                ...
            ],
        }
    """
    per_file: List[dict] = []
    total_saved = 0

    for entry in entries:
        if entry.get("status") == "M":
            saved = max(
                0,
                entry.get("est_full_rewrite_tokens", 0)
                - entry.get("actual_diff_tokens", 0),
            )
        else:
            saved = 0

        per_file.append(
            {
                "file": entry.get("file", ""),
                "status": entry.get("status", ""),
                "est_full_rewrite_tokens": entry.get("est_full_rewrite_tokens", 0),
                "actual_diff_tokens": entry.get("actual_diff_tokens", 0),
                "outputTokensSaved": saved,
            }
        )
        total_saved += saved

    cost_info = cost_for(model, output_tokens=total_saved)

    return {
        "outputTokensSaved": total_saved,
        "outputDollarsSaved": cost_info["dollars"],
        "estimate": cost_info["estimate"],
        "model": model,
        "outputRatePerMtok": cost_info["rates"]["output"],
        "perFile": per_file,
    }
