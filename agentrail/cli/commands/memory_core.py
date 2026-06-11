"""Native memory recall/capture — port of ``templates/scripts/memory``.

Pure Python: no rg/grep subprocess. ``memory_recall`` searches
``<git-root>/docs/memory/*.md`` in two passes (exact-phrase short-circuit,
then per-term OR) and emits raw ``grep -C 3``-style output. ``memory_capture``
prints a markdown template to stdout and writes nothing.
"""
from __future__ import annotations

import datetime
import subprocess
from pathlib import Path
from typing import List, Optional, Tuple


def _git_root(cwd: str) -> Path:
    """Resolve the git toplevel for ``cwd``; fall back to ``cwd`` itself."""
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        top = result.stdout.strip()
        if top:
            return Path(top)
    except (subprocess.CalledProcessError, OSError):
        pass
    return Path(cwd)


def _memory_files(memory_dir: Path) -> List[Path]:
    """Markdown files under ``memory_dir``, sorted for stable output."""
    return sorted(p for p in memory_dir.rglob("*.md") if p.is_file())


def _format_block(
    relpath: str,
    lines: List[str],
    match_indices: List[int],
) -> List[str]:
    """Render ``grep -C 3`` style output for one file's matches.

    Match lines use ``relpath:lineno:line``; context lines use
    ``relpath-lineno-line``; non-contiguous match groups are separated by
    ``--`` (the grep group separator).
    """
    if not match_indices:
        return []

    n = len(lines)
    matched = set(match_indices)

    # Determine which line indices to emit (match +/- 3 context).
    emit: set = set()
    for idx in match_indices:
        for j in range(max(0, idx - 3), min(n, idx + 4)):
            emit.add(j)

    ordered = sorted(emit)
    out: List[str] = []
    prev: Optional[int] = None
    for idx in ordered:
        if prev is not None and idx != prev + 1:
            out.append("--")
        lineno = idx + 1
        text = lines[idx]
        sep = ":" if idx in matched else "-"
        out.append(f"{relpath}{sep}{lineno}{sep}{text}")
        prev = idx
    return out


def _search(
    files: List[Path],
    root: Path,
    terms: List[str],
) -> List[str]:
    """Per-file: collect lines matching any term (case-insensitive, literal)."""
    lowered = [t.lower() for t in terms]
    blocks: List[str] = []
    for path in files:
        try:
            content = path.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        lines = content.split("\n")
        # A trailing newline yields a final empty element; drop it to mirror
        # line-oriented tools.
        if lines and lines[-1] == "":
            lines = lines[:-1]
        match_indices = [
            i
            for i, line in enumerate(lines)
            if any(t in line.lower() for t in lowered)
        ]
        if not match_indices:
            continue
        try:
            relpath = str(path.relative_to(root))
        except ValueError:
            relpath = str(path)
        blocks.extend(_format_block(relpath, lines, match_indices))
    return blocks


def memory_recall(query: str, cwd: str) -> Tuple[str, int]:
    """Search ``<git-root>/docs/memory`` for ``query``.

    Pass 1: exact phrase (case-insensitive, literal). If any match, emit and
    short-circuit. Pass 2 (only if pass 1 empty): per-term OR over terms with
    ``len >= 3``. Returns ``(text, rc)``.
    """
    root = _git_root(cwd)
    memory_dir = root / "docs" / "memory"
    if not memory_dir.is_dir():
        return ("No docs/memory directory found.", 0)

    files = _memory_files(memory_dir)

    # Pass 1 — exact phrase, short-circuit.
    exact = _search(files, root, [query])
    if exact:
        return ("\n".join(exact), 0)

    # Pass 2 — per-term OR (terms with len >= 3).
    terms = [t for t in query.split() if len(t) >= 3]
    if terms:
        per_term = _search(files, root, terms)
        if per_term:
            return ("\n".join(per_term), 0)

    return ("", 0)


def memory_capture(kind: str, title: str) -> str:
    """Return a markdown memory-entry template. Writes nothing."""
    today = datetime.date.today().isoformat()
    return (
        f"## {title}\n"
        f"\n"
        f"- kind: {kind}\n"
        f"- source: <issue, PR, ADR, file path, or doc link>\n"
        f"- confidence: verified\n"
        f"- created_at: {today}\n"
        f"- expires_at:\n"
        f"\n"
        f"<What future agents need to know, when it applies, and what to verify before using it.>"
    )
