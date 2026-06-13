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
# Fuller text kept alongside the summary so the dashboard can expand an entry
# for investigation; bounded so one verbose turn cannot bloat the payload.
FULL_TEXT_MAX_CHARS = 4000


@dataclass
class ActivityEntry:
    """One assistant turn: a short summary plus the tools used that turn."""
    summary: str
    tools: List[str] = field(default_factory=list)
    ts: str = ""  # transcript timestamp (ISO) when available, else ""
    full_text: str = ""  # set only when the turn text extends past the summary
    files_read_count: int = 0
    full_file_read: int = 0
    tool_loop_count: int = 0
    edit_without_context: int = 0
    verification_skip: int = 0
    _tool_calls: List[Dict[str, Any]] = field(default_factory=list, repr=False, compare=False)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) <= SUMMARY_MAX_CHARS:
        return text
    return text[:SUMMARY_MAX_CHARS].rstrip() + "…"


def _entry_texts(text: str) -> tuple[str, str]:
    """Return (summary, full_text) for a turn's text.

    full_text is empty when the summary already carries everything, so short
    turns add no payload weight.
    """
    text = text.strip()
    summary = _truncate(text)
    if len(text) <= SUMMARY_MAX_CHARS:
        return summary, ""
    full = text[:FULL_TEXT_MAX_CHARS]
    if len(text) > FULL_TEXT_MAX_CHARS:
        full = full.rstrip() + "…"
    return summary, full


def _tool_input(block: Dict[str, Any]) -> Dict[str, Any]:
    raw = block.get("input")
    if raw is None:
        raw = block.get("arguments")
    if raw is None:
        raw = block.get("params")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {"command": raw}
    return {}


def _codex_tool_input(payload: Dict[str, Any]) -> Dict[str, Any]:
    for key in ("arguments", "input", "params", "action"):
        raw = payload.get(key)
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                return {"command": raw}
    return {}


def _command_text(args: Dict[str, Any]) -> str:
    for key in ("command", "cmd", "script"):
        value = args.get(key)
        if isinstance(value, str):
            return value
    return ""


def _normalise_tool_name(name: str) -> str:
    return name.strip().lower().replace("-", "_")


def _is_read_tool(name: str, args: Dict[str, Any]) -> bool:
    lname = _normalise_tool_name(name)
    if lname in {"read", "read_file"} or lname.endswith("__read_file"):
        return True
    command = _command_text(args).strip()
    return bool(command) and (
        command.startswith("cat ")
        or command.startswith("nl ")
        or command.startswith("sed ")
    )


def _read_identifier(name: str, args: Dict[str, Any]) -> str:
    for key in ("file_path", "path", "absolute_path", "uri", "url"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    command = _command_text(args).strip()
    if command:
        return command
    return _tool_signature(name, args)


def _is_limited_read(args: Dict[str, Any]) -> bool:
    return any(
        key in args and args.get(key) not in (None, "")
        for key in ("offset", "limit", "start", "start_line", "end", "end_line")
    )


def _is_full_file_read(name: str, args: Dict[str, Any]) -> bool:
    if not _is_read_tool(name, args):
        return False
    command = _command_text(args).strip()
    if command:
        return command.startswith("cat ") or command.startswith("nl ")
    return not _is_limited_read(args)


def _is_edit_tool(name: str, args: Dict[str, Any]) -> bool:
    lname = _normalise_tool_name(name)
    if lname in {"edit", "multiedit", "multi_edit", "write", "apply_patch"}:
        return True
    if lname.endswith("apply_patch"):
        return True
    command = _command_text(args)
    return "apply_patch" in command


def _is_context_tool(name: str, args: Dict[str, Any]) -> bool:
    lname = _normalise_tool_name(name)
    if (
        _is_read_tool(name, args)
        or lname in {"grep", "glob", "ls", "find"}
        or "search" in lname
        or "context" in lname
    ):
        return True
    command = _command_text(args).strip()
    if not command:
        return False
    return command.startswith((
        "rg ",
        "grep ",
        "sed ",
        "ls ",
        "find ",
        "git show ",
        "git diff ",
        "agentrail context ",
    ))


def _is_verification_tool(name: str, args: Dict[str, Any]) -> bool:
    lname = _normalise_tool_name(name)
    if any(term in lname for term in ("test", "pytest", "vitest", "typecheck", "lint")):
        return True
    command = _command_text(args).lower()
    return any(
        term in command
        for term in (
            "npm test",
            "pnpm test",
            "yarn test",
            "pytest",
            "vitest",
            "tsc",
            "typecheck",
            "lint",
            "go test",
            "cargo test",
            "ruff",
            "mypy",
            "playwright",
        )
    )


def _tool_signature(name: str, args: Dict[str, Any]) -> str:
    try:
        encoded = json.dumps(args, sort_keys=True, separators=(",", ":"))
    except TypeError:
        encoded = str(args)
    return f"{name}:{encoded}"


def _behavior_metrics(tool_calls: List[Dict[str, Any]]) -> Dict[str, int]:
    read_targets: set[str] = set()
    signatures: Dict[str, int] = {}
    has_full_read = False
    has_edit = False
    has_context = False
    has_verification = False

    for call in tool_calls:
        name = str(call.get("name") or "")
        args = call.get("input") if isinstance(call.get("input"), dict) else {}
        signature = _tool_signature(name, args)
        signatures[signature] = signatures.get(signature, 0) + 1

        if _is_read_tool(name, args):
            read_targets.add(_read_identifier(name, args))
        if _is_full_file_read(name, args):
            has_full_read = True
        if _is_edit_tool(name, args):
            has_edit = True
        if _is_context_tool(name, args):
            has_context = True
        if _is_verification_tool(name, args):
            has_verification = True

    duplicate_count = sum(max(0, count - 1) for count in signatures.values())
    return {
        "files_read_count": len(read_targets),
        "full_file_read": 1 if has_full_read else 0,
        "tool_loop_count": duplicate_count,
        "edit_without_context": 1 if has_edit and not has_context else 0,
        "verification_skip": 1 if has_edit and not has_verification else 0,
    }


def _apply_behavior_metrics(entry: ActivityEntry) -> ActivityEntry:
    metrics = _behavior_metrics(entry._tool_calls)
    entry.files_read_count = metrics["files_read_count"]
    entry.full_file_read = metrics["full_file_read"]
    entry.tool_loop_count = metrics["tool_loop_count"]
    entry.edit_without_context = metrics["edit_without_context"]
    entry.verification_skip = metrics["verification_skip"]
    return entry


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
            tool_calls: List[Dict[str, Any]] = []
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
                        tool_name = str(name)
                        tools.append(tool_name)
                        tool_calls.append({"name": tool_name, "input": _tool_input(block)})

            summary, full_text = _entry_texts(thinking or plain_text)
            if not summary and not tools:
                continue

            ts = record.get("timestamp")
            entry = ActivityEntry(
                summary=summary,
                tools=tools,
                ts=ts if isinstance(ts, str) else "",
                full_text=full_text,
                _tool_calls=tool_calls,
            )
            entries.append(_apply_behavior_metrics(entry))
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
                    summary, full_text = _entry_texts(text)
                    entries.append(ActivityEntry(summary=summary, ts=ts, full_text=full_text))

            elif ptype == "message" and payload.get("role") == "assistant":
                text = _first_text(payload.get("content"), key="text")
                if text:
                    summary, full_text = _entry_texts(text)
                    entries.append(ActivityEntry(summary=summary, ts=ts, full_text=full_text))

            elif ptype in ("function_call", "local_shell_call", "custom_tool_call"):
                name = str(payload.get("name") or ptype)
                tool_call = {"name": name, "input": _codex_tool_input(payload)}
                if entries:
                    entries[-1].tools.append(name)
                    entries[-1]._tool_calls.append(tool_call)
                    _apply_behavior_metrics(entries[-1])
                else:
                    entry = ActivityEntry(
                        summary="",
                        tools=[name],
                        ts=ts,
                        _tool_calls=[tool_call],
                    )
                    entries.append(_apply_behavior_metrics(entry))

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
                "files_read_count": entry.files_read_count,
                "full_file_read": entry.full_file_read,
                "tool_loop_count": entry.tool_loop_count,
                "edit_without_context": entry.edit_without_context,
                "verification_skip": entry.verification_skip,
                **({"full_text": entry.full_text} if entry.full_text else {}),
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
