"""In-sandbox Context Compiler enforcement (issue #878).

Hard enforcement so the sandboxed agent must use the Context Compiler instead
of re-exploring the repo with raw search.  Enforcement is toggleable via
``.agentrail/config.json`` so it can be A/B'd against the Raw-Agent Baseline.

Public API
----------
evaluate_tool_use(tool_name, tool_input, *, context_queried, enforcement_enabled)
    → ("allow" | "block", message: str)

record_bypass_attempt(target_dir, run_id, tool_name, command="") → None
    Append an audit/Run event to the bypass ledger.

read_bypass_events(target_dir) → list[dict]
    Return all bypass events from the local ledger.

is_enforcement_enabled(target_dir) → bool
    Read .agentrail/config.json and return enforcement.context_first.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Blocked search prefixes for Bash commands
# ---------------------------------------------------------------------------
_BASH_BLOCKED_PREFIXES = ("grep ", "grep\t", "rg ", "rg\t", "find ")

_BLOCK_MESSAGE = (
    "Repo-wide search is disabled (AgentRail context-first enforcement). "
    "Use `agentrail context query \"<term>\" --json` for ranked retrieval, "
    "then Read the cited files. "
    "The Grep/Glob tools and bare grep/rg/find Bash commands are blocked "
    "until you have queried the context engine for the current task."
)


def evaluate_tool_use(
    tool_name: str,
    tool_input: dict[str, Any],
    *,
    context_queried: bool,
    enforcement_enabled: bool,
) -> tuple[str, str]:
    """Decide whether a tool call is allowed under context-first enforcement.

    Parameters
    ----------
    tool_name:
        The Claude Code tool name (e.g. "Grep", "Glob", "Bash").
    tool_input:
        The tool's input dict from the PreToolUse hook payload.
    context_queried:
        True once the agent has issued at least one ``agentrail context query``
        or ``agentrail context search`` call for the current task.
    enforcement_enabled:
        Whether context-first enforcement is active (from config or caller).

    Returns
    -------
    (verdict, message)
        verdict is "allow" or "block".  message is non-empty and references the
        context engine whenever the verdict is "block".
    """
    if not enforcement_enabled:
        return ("allow", "")

    if context_queried:
        return ("allow", "")

    if tool_name in ("Grep", "Glob"):
        return ("block", _BLOCK_MESSAGE)

    if tool_name == "Bash":
        command = (tool_input.get("command") or "").lstrip()
        if any(command.startswith(prefix) for prefix in _BASH_BLOCKED_PREFIXES):
            return ("block", _BLOCK_MESSAGE)

    return ("allow", "")


# ---------------------------------------------------------------------------
# Bypass ledger (AC3)
# ---------------------------------------------------------------------------

def _ledger_path(target_dir: Path) -> Path:
    return target_dir / ".agentrail" / "bypass_events.jsonl"


def record_bypass_attempt(
    target_dir: Path,
    run_id: str,
    tool_name: str,
    command: str = "",
) -> None:
    """Append a bypass audit event to the local JSONL ledger.

    Each call appends one event so the bypass count is always accurate.
    The ledger is stored at ``<target_dir>/.agentrail/bypass_events.jsonl``.
    """
    ledger = _ledger_path(Path(target_dir))
    ledger.parent.mkdir(parents=True, exist_ok=True)
    event: dict[str, str] = {
        "event_type": "bypass_attempt",
        "run_id": run_id,
        "tool_name": tool_name,
        "command": command,
    }
    with ledger.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")


def read_bypass_events(target_dir: Path) -> list[dict]:
    """Return all bypass events from the local ledger, oldest first.

    Returns an empty list if no bypass attempts have been recorded.
    """
    ledger = _ledger_path(Path(target_dir))
    if not ledger.exists():
        return []
    events: list[dict] = []
    for line in ledger.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            events.append(json.loads(line))
    return events


# ---------------------------------------------------------------------------
# Config reader (AC5)
# ---------------------------------------------------------------------------

def is_enforcement_enabled(target_dir: Path) -> bool:
    """Return True if ``enforcement.context_first`` is set in config.

    Reads ``<target_dir>/.agentrail/config.json``.  Returns False when the
    file is absent, malformed, or the key is missing — fail-open so a missing
    config never blocks agent work.
    """
    config_path = Path(target_dir) / ".agentrail" / "config.json"
    if not config_path.exists():
        return False
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        return bool(config.get("enforcement", {}).get("context_first", False))
    except (json.JSONDecodeError, OSError):
        return False
