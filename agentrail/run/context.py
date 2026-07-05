"""Issue-text and context-pack helpers for the native run pipeline.

Ports the legacy bash context_pack_summary / context_selected_snippets / gh
issue helpers to pure Python, reusing the existing native context APIs directly
rather than shelling out to `python3 -m agentrail.cli.main context ...`.

Legacy reference: scripts/agentrail-legacy lines 4837-4916.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.packs import build_context_pack
from agentrail.context.retrieval import search_context


def issue_resolution_text(target_dir: Path, issue: int) -> str:
    """Return issue title + '\\n' + body via gh; fallback 'GitHub issue #N'."""
    proc = subprocess.run(
        [
            "gh", "issue", "view", str(issue),
            "--json", "title,body",
            "--jq", '.title + "\\n" + (.body // "")',
        ],
        cwd=str(target_dir),
        check=False,
        capture_output=True,
        text=True,
    )
    text = proc.stdout.strip() if proc.returncode == 0 else ""
    return text or f"GitHub issue #{issue}"


def build_pack(target_dir: Path, kind: str, number: int, phase: str, *, run_id: Optional[str] = None) -> Optional[str]:
    """Build a context pack for any target kind ('issue'|'pr'); return relative jsonPath
    or None on failure. Mirrors legacy build_context_pack_file.

    Does not pass ``memory_items`` — no producer writes the local memory
    snapshot on a live run yet, so the pack's memory lane is empty here today
    (see the scope-boundary note in ``agentrail/context/memory_lane.py`` and
    follow-up issue #1071, which wires a real Postgres -> snapshot producer).
    """
    try:
        pack = build_context_pack(target_dir, kind, number, phase, run_id=run_id)
    except Exception:
        return None
    return pack.get("jsonPath")


def build_issue_context_pack(target_dir: Path, issue: int, phase: str, *, run_id: Optional[str] = None) -> Optional[str]:
    """Build a context pack; return relative jsonPath or None on failure."""
    return build_pack(target_dir, "issue", issue, phase, run_id=run_id)


def context_retrieval_metadata(target_dir: Path, query: str) -> Dict[str, Any]:
    """Return search_context runMetadata dict; {} on any failure."""
    try:
        return search_context(target_dir, query, limit=10).get("runMetadata", {}) or {}
    except Exception:
        return {}


def context_pack_summary(target_dir: Path, pack_file: Optional[str]) -> str:
    """Human-readable summary block read from the pack JSON file at
    <target_dir>/<pack_file>.

    Reproduces the exact output of the legacy bash block at
    scripts/agentrail-legacy lines 4841-4878.

    Returns a banner "Context pack:\\n- Pack file: none\\n- Summary unavailable."
    if pack_file is falsy, the file does not exist, or the file is unreadable.
    """
    no_pack_banner = "Context pack:\n- Pack file: none\n- Summary unavailable."

    if not pack_file:
        return no_pack_banner

    pack_path = Path(target_dir) / pack_file
    try:
        pack: Dict[str, Any] = json.loads(pack_path.read_text(encoding="utf-8"))
    except Exception:
        return no_pack_banner

    def count(key: str) -> int:
        val = pack.get(key)
        return len(val) if isinstance(val, list) else 0

    def first_paths(key: str, limit: int = 2) -> str:
        values = pack.get(key)
        if not isinstance(values, list):
            return ""
        paths: List[str] = []
        for item in values:
            p = item.get("path") or item.get("citation")
            if p:
                paths.append(p)
            if len(paths) >= limit:
                break
        return f" ({', '.join(paths)})" if paths else ""

    target = pack.get("target") or {}
    kind = target.get("kind") or "target"
    number = target.get("number")
    number_str = str(number) if number is not None else "unknown"
    phase = target.get("phase") or ""
    target_line = f"- Target: {kind} #{number_str} {phase}".rstrip()

    goal_obj = pack.get("goal")
    if isinstance(goal_obj, dict):
        goal_summary = goal_obj.get("summary") or "No goal recorded."
    else:
        goal_summary = "No goal recorded."

    lines = [
        "Context pack:",
        f"- Pack file: {pack_file}",
        target_line,
        f"- Goal: {goal_summary}",
        f"- Required context: {count('requiredContext')}{first_paths('requiredContext')}",
        f"- Likely files: {count('likelyFiles')}{first_paths('likelyFiles')}",
        f"- Likely docs: {count('likelyDocs')}{first_paths('likelyDocs')}",
        f"- Relevant memory: {count('relevantMemory')}{first_paths('relevantMemory')}",
        f"- Prior mistakes: {count('priorMistakes')}{first_paths('priorMistakes')}",
        f"- Active state: {count('activeState')}{first_paths('activeState')}",
        f"- Goals: {count('goals')}{first_paths('goals')}",
        f"- Open questions: {count('openQuestions')}{first_paths('openQuestions')}",
        "- Use the selected context above before broad repo discovery; keep memory recall as an advisory check.",
    ]
    return "\n".join(lines)


_MAX_CONTENT_SNIPPETS = 3
_MAX_SNIPPET_LINES = 40
_MAX_TOTAL_CHARS = 8000  # ≈ 2 000 tokens at 4 chars/token


def _indent_snippet(snippet: Any) -> List[str]:
    """Indent a windowed snippet for the prompt block, preserving its full span.

    The snippet from ``search_context`` is already bounded (line/char caps) and,
    after issue #903, anchored on the matched span + enclosing signature.  We
    keep every non-blank line — never truncating to the first few — so a deep
    matched span survives into the loop prompt.
    """
    snippet_raw = str(snippet or "")
    return [f"    {l}" for l in snippet_raw.split("\n") if l.strip()]


def context_selected_snippets(target_dir: Path, query: str) -> str:
    """Context pointers with fenced content for top results.

    Top _MAX_CONTENT_SNIPPETS results include the actual file content as a
    fenced code block (≤_MAX_SNIPPET_LINES lines each, ≤_MAX_TOTAL_CHARS chars
    total).  Remaining results and any result whose file is unreadable or
    whose content would exceed the char cap fall back to the compact
    'path:lineStart-lineEnd' pointer format with the first 4 snippet lines
    indented.

    Returns empty string on exception; returns a 'none' fallback line when
    results are empty.
    """
    try:
        out = search_context(target_dir, query, limit=6)
    except Exception:
        return ""

    results = out.get("results") if isinstance(out, dict) else None
    if not isinstance(results, list):
        results = []

    if not results:
        return "Selected context (compact): none — fall back to scoped repo inspection."

    lines = [
        "Selected context (compact — read these line ranges before broad discovery):",
    ]
    total_chars = 0

    for i, r in enumerate(results):
        sym = f" {r['symbol']}" if r.get("symbol") else ""
        tok = r.get("tokenEstimate", 0)
        reason = r.get("reason") or ""
        path = r.get("path") or ""
        line_start = r.get("lineStart", 1)
        line_end = r.get("lineEnd", line_start)
        lines.append(
            f"- {path}:{line_start}-{line_end}{sym} (~{tok} tok) — {reason}"
        )

        if i < _MAX_CONTENT_SNIPPETS:
            # Attempt to inject fenced file content from the windowed line range.
            # After issue #903, (line_start, line_end) is the *relevance window*
            # (signature .. matched span), not the whole chunk — so re-reading
            # that range gives the matched span, not the file head.  But when the
            # window straddles a wider span than the line cap, a contiguous
            # head-of-range slice would truncate the deep match back off; in that
            # case fall back to the gap-compressed windowed snippet, which is
            # guaranteed to contain both the signature and the matched span.
            injected = False
            window_span = max(0, line_end - line_start + 1)
            if window_span <= _MAX_SNIPPET_LINES:
                try:
                    file_path = Path(target_dir) / path
                    raw_lines = file_path.read_text(encoding="utf-8").splitlines()
                    start_idx = max(0, line_start - 1)
                    end_idx = line_end  # 1-based inclusive → slice end exclusive
                    content_lines = raw_lines[start_idx:end_idx][:_MAX_SNIPPET_LINES]
                    content = "\n".join(content_lines)
                    fence = f"```{path}:{line_start}-{line_end}\n{content}\n```"
                    if total_chars + len(fence) <= _MAX_TOTAL_CHARS:
                        lines.append(fence)
                        total_chars += len(fence)
                        injected = True
                except OSError:
                    pass

            if not injected:
                # Fall back to the windowed snippet from the search result.  It is
                # already bounded (≤ snippet line/char caps) AND carries the
                # matched span, so do NOT truncate it to the first few lines —
                # that would discard a deep match (the windowing payoff).
                snippet_lines = _indent_snippet(r.get("snippet"))
                if snippet_lines:
                    rendered = "\n".join(snippet_lines)
                    if total_chars + len(rendered) <= _MAX_TOTAL_CHARS:
                        lines.append(rendered)
                        total_chars += len(rendered)
        else:
            # Results beyond the content limit: pointer + the full windowed
            # snippet (bounded, contains the matched span — not truncated to the
            # first 4 lines, which used to cut off deep matches).
            snippet_lines = _indent_snippet(r.get("snippet"))
            if snippet_lines:
                lines.append("\n".join(snippet_lines))

    lines.append(
        "Use `agentrail context get <path> --lines A-B` to expand any of these."
        " Do not read full files until these are insufficient."
    )
    return "\n".join(lines)
