"""Thin git time-travel wrappers for ``agentrail context``.

These commands read git metadata only — blame, history, and changed files.
They do not read the AgentRail index and are not subject to denied-source
filtering, because git metadata is not source content. Each function runs
``git`` from the resolved target directory and returns plain Python
dicts/lists so callers can print JSON or a human-readable view.
"""

from __future__ import annotations

import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

_SHA_HEADER = re.compile(r"^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$")
_STATUS_MAP = {"A": "added", "M": "modified", "D": "deleted"}


def _git(target: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(target), *args],
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _format_date(epoch: Optional[str], tz: Optional[str]) -> str:
    if not epoch:
        return ""
    try:
        seconds = int(epoch)
    except ValueError:
        return epoch
    offset = timedelta()
    if tz and len(tz) == 5 and tz[0] in "+-":
        try:
            sign = 1 if tz[0] == "+" else -1
            offset = sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5]))
        except ValueError:
            offset = timedelta()
    return datetime.fromtimestamp(seconds, tz=timezone(offset)).isoformat()


def git_blame(target: Path, path: str, line_start: int, line_end: int) -> List[dict]:
    """Return per-line blame for lines A–B (inclusive, 1-based).

    Parses ``git blame --porcelain``; never the human-readable form. The
    porcelain format emits the author block only on the first line of each
    SHA group, so per-SHA author/date are cached as we iterate.
    """
    result = _git(target, "blame", "--porcelain", "-L", f"{line_start},{line_end}", "--", path)
    meta: dict[str, dict] = {}
    entries: List[dict] = []
    current_sha: Optional[str] = None
    pending: dict = {}
    for raw in result.stdout.splitlines():
        header = _SHA_HEADER.match(raw)
        if header:
            current_sha = header.group(1)
            pending = {"line": int(header.group(2))}
            continue
        if raw.startswith("author "):
            pending["author"] = raw[len("author "):]
        elif raw.startswith("author-time "):
            pending["time"] = raw[len("author-time "):]
        elif raw.startswith("author-tz "):
            pending["tz"] = raw[len("author-tz "):]
        elif raw.startswith("\t") and current_sha is not None:
            if current_sha not in meta and "author" in pending:
                meta[current_sha] = {
                    "author": pending.get("author", ""),
                    "date": _format_date(pending.get("time"), pending.get("tz")),
                }
            info = meta.get(current_sha, {"author": "", "date": ""})
            entries.append(
                {
                    "line": pending.get("line", line_start),
                    "author": info["author"],
                    "sha": current_sha,
                    "date": info["date"],
                    "content": raw[1:],
                }
            )
    return entries


def git_history(target: Path, path: str, symbol: Optional[str] = None) -> List[dict]:
    """Return commit history for a file, newest first.

    With ``symbol``, follows a single function via ``git log -L :NAME:PATH``.
    """
    if symbol:
        return _history_symbol(target, path, symbol)
    result = _git(target, "log", "--follow", "--format=%H %ae %ai %s", "--", path)
    entries: List[dict] = []
    for raw in result.stdout.splitlines():
        if not raw.strip():
            continue
        parts = raw.split(" ")
        if len(parts) < 5:
            continue
        entries.append(
            {
                "sha": parts[0],
                "author": parts[1],
                "date": " ".join(parts[2:5]),
                "summary": " ".join(parts[5:]),
            }
        )
    return entries


def _history_symbol(target: Path, path: str, symbol: str) -> List[dict]:
    result = _git(target, "log", "-L", f":{symbol}:{path}", check=False)
    if result.returncode != 0:
        return []
    entries: List[dict] = []
    current: Optional[dict] = None
    for raw in result.stdout.splitlines():
        if raw.startswith("commit "):
            if current is not None:
                entries.append(current)
            sha = raw[len("commit "):].strip().split(" ")[0]
            current = {"sha": sha, "author": "", "date": "", "summary": ""}
        elif current is None:
            continue
        elif raw.startswith("Author:"):
            current["author"] = raw[len("Author:"):].strip()
        elif raw.startswith("Date:"):
            current["date"] = raw[len("Date:"):].strip()
        elif not current["summary"] and raw.startswith("    "):
            current["summary"] = raw.strip()
    if current is not None:
        entries.append(current)
    return entries


def git_changed(target: Path, since: str = "HEAD") -> List[dict]:
    """Return changed paths between ``since`` and the working tree.

    Status is mapped to ``added`` / ``modified`` / ``deleted``. Rename pairs
    (``R`` prefix) report the destination path with status ``modified``.
    """
    result = _git(target, "diff", "--name-status", since)
    entries: List[dict] = []
    for raw in result.stdout.splitlines():
        if not raw.strip():
            continue
        parts = raw.split("\t")
        code = parts[0]
        if code.startswith("R") and len(parts) >= 3:
            entries.append({"path": parts[2], "status": "modified"})
        elif code.startswith("C") and len(parts) >= 3:
            entries.append({"path": parts[2], "status": "added"})
        elif len(parts) >= 2:
            entries.append({"path": parts[1], "status": _STATUS_MAP.get(code[0], "modified")})
    return entries
