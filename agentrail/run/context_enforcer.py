"""In-sandbox Context Compiler enforcement for AgentRail (issue #878).

Public API
----------
is_enforcement_enabled(target_dir)  -- AC5: read config to decide ON/OFF
decide(payload, *, run_dir, target_dir)  -- AC2: block/allow a tool call
record_context_queried(run_dir)  -- AC2: unlock search after a context query
get_bypass_count(run_dir)  -- AC3: observable bypass counter
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Tuple

_STATE_FILE = ".context_enforcer.json"

_BLOCK_MESSAGE = (
    "Blocked: raw repo-wide search is not allowed until you query the "
    "Context Compiler for this task. Run `agentrail context query \"<term>\"` "
    "(or use the MCP context tool) first, then retry."
)

# Bash command prefixes that constitute a raw repo-wide search.
_BASH_SEARCH_PREFIXES = ("grep ", "grep\t", "rg ", "rg\t", "find ", "find\t")


# ---------------------------------------------------------------------------
# AC5 — configurable enforcement
# ---------------------------------------------------------------------------

def is_enforcement_enabled(target_dir: Path) -> bool:
    """Return True iff contextFirst enforcement is ON for *target_dir*.

    Reads ``.agentrail/config.json``.  Missing file or missing key → False
    (fail open so enforcement never silently breaks a session).
    """
    config_path = Path(target_dir) / ".agentrail" / "config.json"
    try:
        data = json.loads(config_path.read_text())
        return bool(data.get("enforcement", {}).get("contextFirst", False))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Run-scoped state helpers (bypass counter + queried marker)
# ---------------------------------------------------------------------------

def _read_state(run_dir: Path) -> dict:
    state_path = Path(run_dir) / _STATE_FILE
    try:
        return json.loads(state_path.read_text())
    except Exception:
        return {"bypass_count": 0, "context_queried": False}


def _write_state(run_dir: Path, state: dict) -> None:
    state_path = Path(run_dir) / _STATE_FILE
    state_path.write_text(json.dumps(state))


def get_bypass_count(run_dir: Path) -> int:
    """AC3: return the number of raw-search attempts blocked in this run."""
    return int(_read_state(run_dir).get("bypass_count", 0))


def record_context_queried(run_dir: Path) -> None:
    """AC2: mark that the agent has queried the Context Compiler.

    Subsequent calls to :func:`decide` will allow raw search tools.
    """
    state = _read_state(run_dir)
    state["context_queried"] = True
    _write_state(run_dir, state)


# ---------------------------------------------------------------------------
# AC2 — enforcement decision
# ---------------------------------------------------------------------------

def _is_raw_search(payload: dict) -> bool:
    """Return True if *payload* represents a blocked raw repo-wide search."""
    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}

    if tool in ("Grep", "Glob"):
        return True

    if tool == "Bash":
        cmd = (tool_input.get("command") or "").lstrip()
        return any(cmd.startswith(prefix) for prefix in _BASH_SEARCH_PREFIXES)

    return False


def decide(
    payload: dict,
    *,
    run_dir: Path,
    target_dir: Path,
) -> Tuple[str, str]:
    """Decide whether to block or allow a tool call.

    Returns ``("block", message)`` when a raw search is attempted before a
    context-engine query; ``("allow", "")`` otherwise.

    Side-effects
    ------------
    - When blocking: increments the run-scoped bypass counter (AC3).
    - Enforcement ON/OFF is read from config (AC5).
    - Allowed after ``record_context_queried`` has been called (AC2).
    """
    if not is_enforcement_enabled(target_dir):
        return ("allow", "")

    if not _is_raw_search(payload):
        return ("allow", "")

    state = _read_state(run_dir)

    if state.get("context_queried"):
        return ("allow", "")

    # Block and record.
    state["bypass_count"] = int(state.get("bypass_count", 0)) + 1
    _write_state(run_dir, state)

    return ("block", _BLOCK_MESSAGE)
