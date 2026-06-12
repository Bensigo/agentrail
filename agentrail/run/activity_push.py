"""Agent activity log — per-turn transcript summaries pushed as run events.

After each pipeline phase the agent's local transcript (Claude projects dir
or Codex rollout sessions) is summarised into one entry per assistant turn:
the first ~200 chars of thinking/text plus the names of the tools used that
turn.  Entries are POSTed to POST /api/v1/ingest/run-events with
``event_type: "agent_activity"`` so the run-detail timeline can render the
agent's thought process.  Every failure is non-fatal: the local run always
stands on its own.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from agentrail.context.snapshot_push import load_link
from agentrail.run.usage_capture import _claude_projects_dir, _codex_session_records

# One entry per assistant turn, capped so a long phase cannot flood the rail.
MAX_ENTRIES_PER_PHASE = 50
SUMMARY_MAX_CHARS = 200


@dataclass
class ActivityEntry:
    """One assistant turn: a short summary plus the tools used that turn."""
    summary: str
    tools: List[str] = field(default_factory=list)
    ts: str = ""  # transcript timestamp (ISO) when available, else ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) <= SUMMARY_MAX_CHARS:
        return text
    return text[:SUMMARY_MAX_CHARS].rstrip() + "…"


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def extract_activity(agent: str, target: Path, since_ts: float) -> List[ActivityEntry]:
    """Return per-turn activity entries for *agent* since *since_ts*.

    Unknown agents return an empty list (non-fatal, mirrors capture_usage).
    """
    if agent == "claude":
        return _extract_claude_activity(target, since_ts)
    if agent == "codex":
        return _extract_codex_activity(target, since_ts)
    return []


def _extract_claude_activity(target: Path, since_ts: float) -> List[ActivityEntry]:
    projects_dir = _claude_projects_dir(target)
    if not projects_dir.exists():
        return []

    entries: List[ActivityEntry] = []

    for jsonl_file in sorted(projects_dir.glob("*.jsonl")):
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
            if not isinstance(record, dict) or record.get("type") != "assistant":
                continue

            message = record.get("message") or {}
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, list):
                continue

            thinking = ""
            plain_text = ""
            tools: List[str] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "thinking" and not thinking:
                    thinking = str(block.get("thinking") or "")
                elif btype == "text" and not plain_text:
                    plain_text = str(block.get("text") or "")
                elif btype == "tool_use":
                    name = block.get("name")
                    if name:
                        tools.append(str(name))

            summary = _truncate(thinking or plain_text)
            if not summary and not tools:
                continue

            ts = record.get("timestamp")
            entries.append(ActivityEntry(
                summary=summary,
                tools=tools,
                ts=ts if isinstance(ts, str) else "",
            ))
            if len(entries) >= MAX_ENTRIES_PER_PHASE:
                return entries

    return entries


def _extract_codex_activity(target: Path, since_ts: float) -> List[ActivityEntry]:
    """Best-effort per-turn extraction from codex rollout records.

    Reasoning/assistant-message response items start a new entry; tool calls
    (function_call & friends) attach their name to the current entry.
    """
    entries: List[ActivityEntry] = []

    for records in _codex_session_records(target, since_ts):
        for record in records:
            if record.get("type") != "response_item":
                continue
            payload = record.get("payload")
            if not isinstance(payload, dict):
                continue

            ptype = payload.get("type")
            ts = record.get("timestamp")
            ts = ts if isinstance(ts, str) else ""

            if ptype == "reasoning":
                text = _first_text(payload.get("summary"), key="text")
                if text:
                    entries.append(ActivityEntry(summary=_truncate(text), ts=ts))

            elif ptype == "message" and payload.get("role") == "assistant":
                text = _first_text(payload.get("content"), key="text")
                if text:
                    entries.append(ActivityEntry(summary=_truncate(text), ts=ts))

            elif ptype in ("function_call", "local_shell_call", "custom_tool_call"):
                name = str(payload.get("name") or ptype)
                if entries:
                    entries[-1].tools.append(name)
                else:
                    entries.append(ActivityEntry(summary="", tools=[name], ts=ts))

            if len(entries) >= MAX_ENTRIES_PER_PHASE:
                return entries

    return entries


def _first_text(blocks: Any, key: str) -> str:
    """Return the first non-empty *key* string from a list of block dicts."""
    if not isinstance(blocks, list):
        return ""
    for block in blocks:
        if isinstance(block, dict):
            text = block.get(key)
            if isinstance(text, str) and text.strip():
                return text
    return ""


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

# Per-run seq state. The ingest endpoint dedupes on (workspace, session, seq),
# so seqs must never collide with the AFK telemetry counter (1..N) for the
# same session — seed from epoch-ms instead, which also keeps seq
# monotonically increasing across phases within the process.
_seq_state: Dict[str, int] = {}


def _next_seq(run_id: str) -> int:
    nxt = max(_seq_state.get(run_id, 0) + 1, int(time.time() * 1000))
    _seq_state[run_id] = nxt
    return nxt


def push_agent_activity(
    target: Path,
    run_id: str,
    phase: str,
    agent: str,
    since_ts: float,
) -> bool:
    """Extract per-turn activity for the finished phase and POST it as
    ``agent_activity`` run events. Returns True only on HTTP 202.

    Non-fatal: any exception → False, never raises.
    Not linked or no entries → False (no network call).
    """
    link = load_link(target)
    if link is None:
        return False

    try:
        entries = extract_activity(agent, target, since_ts)
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False
    if not entries:
        return False

    fallback_ts = _now_iso()
    events: List[Dict[str, Any]] = []
    for turn, entry in enumerate(entries, start=1):
        events.append({
            "session_id": run_id,
            "seq": _next_seq(run_id),
            "ts": entry.ts or fallback_ts,
            "kind": phase,
            "action": {
                "type": "agent_activity",
                "phase": phase,
                "turn": turn,
                "summary": entry.summary,
                "tools": entry.tools,
            },
            "digest": entry.summary[:64],
        })

    body = json.dumps(events).encode("utf-8")
    req = urllib.request.Request(
        f"{link['base_url']}/api/v1/ingest/run-events",
        data=body,
        headers={
            "Authorization": f"Bearer {link['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False
