"""Token-usage extraction from Claude and Codex transcript files.

Reads local transcript directories written by the agent during a run phase and
returns a summed Usage record.  Only agents whose transcript format is known
are handled; unknown agents return None (non-fatal).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List, Optional


@dataclass
class Usage:
    model: str
    input_tokens: int
    output_tokens: int
    cache_tokens: int


def capture_usage(agent: str, target: Path, since_ts: float) -> Optional[Usage]:
    """Return summed token Usage for *agent* since *since_ts* (epoch seconds).

    *target* is the repository root used to locate the matching transcript.
    Returns None for unknown agents or when no matching transcript is found.
    """
    if agent == "claude":
        return _extract_claude(target, since_ts)
    if agent == "codex":
        return _extract_codex(target, since_ts)
    # hermes / cursor / custom — future agents; non-fatal
    return None


# ---------------------------------------------------------------------------
# Claude extractor
# ---------------------------------------------------------------------------

def _claude_projects_dir(target: Path) -> Path:
    """Resolve ~/.claude/projects/<encoded-cwd> for *target*.

    Claude encodes the cwd by replacing every non-alphanumeric character with
    '-' (not just '/'): '/repo/.afk/wt' becomes '-repo--afk-wt'. Dots matter —
    afk worktrees live under '.afk/', so a '/'-only encoding never matches.
    """
    encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(target.resolve()))
    return Path.home() / ".claude" / "projects" / encoded


def _extract_claude(target: Path, since_ts: float) -> Optional[Usage]:
    projects_dir = _claude_projects_dir(target)
    if not projects_dir.exists():
        return None

    input_tokens = 0
    output_tokens = 0
    cache_tokens = 0
    model: Optional[str] = None

    found_any = False

    for jsonl_file in sorted(projects_dir.glob("*.jsonl")):
        # Files not modified since since_ts are skipped.
        # Use >= so a file written exactly at since_ts is included.
        if os.path.getmtime(jsonl_file) < since_ts:
            continue

        try:
            text = jsonl_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            try:
                message = record.get("message") or {}
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    continue

                input_tokens += int(usage.get("input_tokens", 0))
                output_tokens += int(usage.get("output_tokens", 0))
                cache_tokens += int(usage.get("cache_read_input_tokens", 0))

                msg_model = message.get("model")
                if msg_model:
                    model = msg_model  # keep the last seen model

                found_any = True
            except (TypeError, ValueError):
                continue

    if not found_any:
        return None

    return Usage(
        model=model or "",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_tokens=cache_tokens,
    )


# ---------------------------------------------------------------------------
# Codex extractor
# ---------------------------------------------------------------------------

def _codex_session_records(target: Path, since_ts: float) -> Iterator[List[dict]]:
    """Yield parsed record lists for codex rollout files matching *target*.

    Scans ~/.codex/sessions/**/rollout-*.jsonl, skips files modified before
    *since_ts*, and yields the parsed JSON records of each file whose
    session_meta.cwd equals the resolved target path. Shared by the usage
    extractor below and the agent-activity extractor (activity_push.py).
    """
    sessions_dir = Path.home() / ".codex" / "sessions"
    if not sessions_dir.exists():
        return

    target_str = str(target.resolve())

    # Process each candidate file that was modified >= since_ts and whose
    # session_meta.cwd matches the target repo.
    for jsonl_file in sorted(sessions_dir.glob("**/rollout-*.jsonl")):
        if os.path.getmtime(jsonl_file) < since_ts:
            continue

        try:
            text = jsonl_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        session_cwd: Optional[str] = None
        records: List[dict] = []

        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            records.append(record)
            if record.get("type") == "session_meta":
                session_cwd = record.get("cwd")

        if session_cwd == target_str:
            yield records


def _extract_codex(target: Path, since_ts: float) -> Optional[Usage]:
    for records in _codex_session_records(target, since_ts):
        session_model: Optional[str] = None
        last_token_usage: Optional[dict] = None

        for record in records:
            try:
                record_type = record.get("type")

                if record_type == "turn_context":
                    m = record.get("model")
                    if m:
                        session_model = m

                elif record_type == "token_count":
                    info = record.get("info") or {}
                    total = info.get("total_token_usage")
                    if isinstance(total, dict):
                        last_token_usage = total
            except (TypeError, AttributeError):
                continue

        if last_token_usage is None:
            continue

        try:
            input_tokens = int(last_token_usage.get("input_tokens", 0))
            output_tokens = int(last_token_usage.get("output_tokens", 0))
            cache_tokens = int(last_token_usage.get("cached_input_tokens", 0))
        except (TypeError, ValueError):
            continue

        return Usage(
            model=session_model or "",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_tokens=cache_tokens,
        )

    return None
