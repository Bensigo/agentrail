"""Thin git wrappers for line-level blame, commit history, and working-tree diff.

These functions shell out to git and parse machine-readable output formats.
They are not subject to denied-source filtering — git metadata is not source
content from the AgentRail index.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List, Optional


def _run_git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def git_blame(path: str, line_start: int, line_end: int, target: Path) -> List[dict]:
    """Return blame info for lines A–B (1-based, inclusive) of PATH.

    Parses ``git blame --porcelain PATH`` and filters to the requested range.

    Returns a list of dicts: {line, author, sha, date, content}.
    """
    output = _run_git(["blame", "--porcelain", path], cwd=target)

    # Porcelain format: groups of lines per hunk.
    # First line of each group: <40-char sha> <orig_line> <result_line> [<num_lines>]
    # Then header lines: "author ...", "author-mail ...", "author-time ...",
    #   "author-tz ...", "committer ...", etc.
    # Final line of each group starts with a tab: "\t<content>"
    results: List[dict] = []
    # Cache commit metadata (porcelain only emits headers on first occurrence of each SHA)
    commit_cache: dict[str, dict] = {}
    lines = output.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        # Each group starts with a 40-char hex SHA followed by line numbers
        if len(line) >= 40 and all(c in "0123456789abcdefABCDEF" for c in line[:40]) and (len(line) == 40 or line[40] == " "):
            parts = line.split()
            sha = parts[0]
            result_line = int(parts[2])
            i += 1
            # Parse header fields until we hit the tab-prefixed content line
            # Headers are only emitted on the first occurrence of each SHA
            author = commit_cache.get(sha, {}).get("author", "")
            date = commit_cache.get(sha, {}).get("date", "")
            while i < len(lines) and not lines[i].startswith("\t"):
                field = lines[i]
                if field.startswith("author "):
                    author = field[len("author "):]
                elif field.startswith("author-time "):
                    date = field[len("author-time "):]
                i += 1
            # Cache for this SHA in case the same commit appears again
            if sha not in commit_cache:
                commit_cache[sha] = {"author": author, "date": date}
            else:
                # Merge any newly-parsed values (first occurrence has full headers)
                if author:
                    commit_cache[sha]["author"] = author
                if date:
                    commit_cache[sha]["date"] = date
            author = commit_cache[sha]["author"]
            date = commit_cache[sha]["date"]
            # Content line (starts with tab)
            content = lines[i][1:] if i < len(lines) else ""
            i += 1
            if line_start <= result_line <= line_end:
                results.append({
                    "line": result_line,
                    "author": author,
                    "sha": sha,
                    "date": date,
                    "content": content,
                })
        else:
            i += 1

    return results


def git_history(path: str, symbol: Optional[str] = None, target: Optional[Path] = None) -> List[dict]:
    """Return commit history for PATH, newest first.

    With ``symbol``, uses ``git log -L :<NAME>:PATH`` to filter to commits that
    touched the named function/symbol.

    Returns a list of dicts: {sha, author, date, summary}.
    """
    cwd = target or Path(".")
    if symbol:
        # -L :<funcname>:path — format is mixed with diff output; extract commits
        output = _run_git(["log", f"-L:{symbol}:{path}", "--format=%H %ae %ai %s"], cwd=cwd)
    else:
        output = _run_git(["log", "--follow", "--format=%H %ae %ai %s", "--", path], cwd=cwd)

    results: List[dict] = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        # Lines starting with diff/hunk markers come from -L output; skip them
        if line.startswith("diff ") or line.startswith("@@") or line.startswith("---") or line.startswith("+++") or line.startswith("-") or line.startswith("+"):
            # Only skip diff lines, not commit lines (which are 40-char hex)
            if not (len(line) >= 40 and all(c in "0123456789abcdefABCDEF" for c in line[:40])):
                continue
        parts = line.split(" ", 3)
        if len(parts) < 4:
            continue
        sha, author, date, summary = parts[0], parts[1], parts[2], parts[3]
        # Validate sha is a 40-char hex string
        if len(sha) != 40 or not all(c in "0123456789abcdefABCDEF" for c in sha):
            continue
        results.append({
            "sha": sha,
            "author": author,
            "date": date,
            "summary": summary,
        })

    return results


def git_changed(since: Optional[str] = None, target: Optional[Path] = None) -> List[dict]:
    """Return files changed relative to REF (default: HEAD).

    Runs ``git diff --name-status REF`` and maps status codes to
    "added", "modified", or "deleted". Rename pairs (R prefix) report the
    destination path with status "modified".

    Returns a list of dicts: {path, status}.
    """
    cwd = target or Path(".")
    ref = since if since is not None else "HEAD"
    output = _run_git(["diff", "--name-status", ref], cwd=cwd)

    status_map = {
        "A": "added",
        "M": "modified",
        "D": "deleted",
        "C": "modified",
        "T": "modified",
        "U": "modified",
    }

    results: List[dict] = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        raw_status = parts[0]
        # Rename: R100\told\tnew or R\told\tnew
        if raw_status.startswith("R"):
            dest = parts[2] if len(parts) >= 3 else parts[1]
            results.append({"path": dest, "status": "modified"})
        elif raw_status in status_map and len(parts) >= 2:
            results.append({"path": parts[1], "status": status_map[raw_status]})

    return results
