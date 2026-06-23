"""Sandbox-enforcement adapter — the filesystem I/O (issue #921).

The sandbox-enforcement policy
(:mod:`agentrail.guardrails.policies.sandbox_enforcement`) is pure: it holds the
signed token-delta metric and the bypass-count decision.  Something has to read
the enforcement toggle, append/count bypass JSONL events, and write the sandbox
hook script — that is this adapter's job, and the only job done here.  This is
where the filesystem I/O lives (AC2); the policy never imports it.

Public API (consumed by the acceptance test and the run pipeline, via the shim):
  is_enforcement_enabled(target_dir)            — AC5 toggle
  install_sandbox_hooks(repo_dir, ...)          — AC1 system-level context + AC2 hook
  record_bypass_event(target_dir, run_id, ...)  — AC3 audit event write
  count_bypass_events(target_dir, run_id)       — AC3 audit event read
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Union

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_BYPASSES_SUFFIX = "-bypasses.jsonl"
_CONTEXT_QUERIED_SUFFIX = "-context-queried"


def _bypass_file(target_dir: Path, run_id: str) -> Path:
    return target_dir / ".agentrail" / "run" / f"{run_id}{_BYPASSES_SUFFIX}"


# ---------------------------------------------------------------------------
# AC5 — toggle
# ---------------------------------------------------------------------------

def is_enforcement_enabled(target_dir: Union[str, Path]) -> bool:
    """Return True iff enforcement.enabled is True in .agentrail/config.json.

    Defaults to False so enforcement can be A/B'd against the Raw-Agent Baseline
    without touching agent code.
    """
    target_dir = Path(target_dir)
    config_path = target_dir / ".agentrail" / "config.json"
    if not config_path.exists():
        return False
    try:
        config = json.loads(config_path.read_text())
        return bool((config.get("enforcement") or {}).get("enabled", False))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# AC3 — bypass audit events
# ---------------------------------------------------------------------------

def record_bypass_event(
    target_dir: Union[str, Path],
    run_id: str,
    *,
    tool_name: str = "",
    command: str = "",
) -> None:
    """Append one bypass audit/Run event for *run_id* into the target workspace.

    The event is appended to a JSONL file so it survives concurrent writers and
    is readable by count_bypass_events without holding a lock.
    """
    target_dir = Path(target_dir)
    bf = _bypass_file(target_dir, run_id)
    bf.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "type": "bypass_attempt",
        "run_id": run_id,
        "tool_name": tool_name,
        "command": command,
        "ts": time.time(),
    }
    with bf.open("a") as fh:
        fh.write(json.dumps(event) + "\n")


def count_bypass_events(target_dir: Union[str, Path], run_id: str) -> int:
    """Return the number of recorded bypass events for *run_id*.

    Returns 0 (not an error) when no events have been written yet, so the
    metric is always readable and can be reported as 0 — making it falsifiable.
    """
    target_dir = Path(target_dir)
    bf = _bypass_file(target_dir, run_id)
    if not bf.exists():
        return 0
    return sum(1 for line in bf.read_text().splitlines() if line.strip())


# ---------------------------------------------------------------------------
# Hook script template (written by install_sandbox_hooks)
# ---------------------------------------------------------------------------

# NOTE: this is a plain string, not an f-string.  All ${...} constructs are
# literal bash variable expansions; the Python dict literals ({}) inside the
# single-quoted python3 -c '...' block are also literal.
_HOOK_SCRIPT = """\
#!/usr/bin/env bash
# AgentRail in-sandbox context-enforcement hook (Claude Code PreToolUse).
#
# Blocks raw repo-wide search (Grep / Glob / bash grep|rg|find) until the
# sandboxed agent has queried the Context Compiler for the current task.
# After a context query the block lifts automatically.
#
# Required environment variables (set by agentrail run / install_sandbox_hooks):
#   AGENTRAIL_RUN_ID      — current run identifier
#   AGENTRAIL_TARGET_DIR  — path to the .agentrail workspace directory
#
# Claude Code PreToolUse convention:
#   exit 2 + message on stderr  →  call blocked
#   exit 0                      →  call allowed
set -euo pipefail

RUN_ID="${AGENTRAIL_RUN_ID:-}"
TARGET_DIR="${AGENTRAIL_TARGET_DIR:-}"

payload="$(cat)"

# Fail open when env vars are absent — never wedge the session.
if [ -z "$RUN_ID" ] || [ -z "$TARGET_DIR" ]; then
  exit 0
fi

# After the agent has queried the context engine, lift the block.
MARKER="$TARGET_DIR/.agentrail/run/$RUN_ID-context-queried"
if [ -f "$MARKER" ]; then
  exit 0
fi

# Determine whether this tool call is a raw repo-wide search.
# python3 reads the hook JSON and prints "block:<tool>" or "allow".
# Malformed input → "allow" (fail open; never wedge the session).
decision="$(printf '%s' "$payload" | python3 -c '
import json, sys

try:
    data = json.load(sys.stdin)
except Exception:
    print("allow")
    sys.exit(0)

tool = data.get("tool_name", "")
tool_input = data.get("tool_input") or {}

if tool in ("Grep", "Glob"):
    print("block:" + tool)
    sys.exit(0)

if tool == "Bash":
    command = (tool_input.get("command") or "").lstrip()
    for prefix in ("grep ", "rg ", "find "):
        if command.startswith(prefix):
            print("block:Bash")
            sys.exit(0)

print("allow")
')"

if [[ "$decision" != block* ]]; then
  exit 0
fi

# Record the bypass audit event (JSONL append, one event per line).
BYPASS_FILE="$TARGET_DIR/.agentrail/run/$RUN_ID-bypasses.jsonl"
mkdir -p "$(dirname "$BYPASS_FILE")"
TOOL_NAME="${decision#block:}"
printf '{"type":"bypass_attempt","run_id":"%s","tool_name":"%s","ts":%s}\\n' \
  "$RUN_ID" "$TOOL_NAME" "$(date +%s)" >> "$BYPASS_FILE"

echo 'Repo-wide search is blocked (AgentRail context enforcement). Query the context engine first: `agentrail context query "<term>" --json`. The block lifts automatically after a context query.' >&2
exit 2
"""


# ---------------------------------------------------------------------------
# AC1 + AC2 — install hooks
# ---------------------------------------------------------------------------

def install_sandbox_hooks(
    repo_dir: Union[str, Path],
    *,
    context_pack_text: str,
    run_id: str,
    target_dir: Union[str, Path],
) -> None:
    """Install context-enforcement artifacts into a sandbox repository clone.

    Creates two files:

    * ``<repo_dir>/.claude/settings.json``
      Injects *context_pack_text* as the agent's ``systemPrompt`` so the
      Context Pack is primary (system-level) context, not advisory text
      appended to the issue prompt.  (AC1)

    * ``<repo_dir>/.claude/hooks/context-enforcement.sh``
      Claude Code ``PreToolUse`` hook that blocks Grep / Glob / bash
      grep|rg|find before the agent has queried the Context Compiler, then
      records bypass audit events and exits 2 with a denial message.  (AC2)

    Args:
        repo_dir: Root of the sandbox repository clone.
        context_pack_text: Rendered Context Pack text to inject as system context.
        run_id: Unique identifier for the current run.
        target_dir: Path to the .agentrail workspace (used by the hook for
            marker and bypass-event file paths).
    """
    repo_dir = Path(repo_dir)
    target_dir = Path(target_dir)

    claude_dir = repo_dir / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)

    # AC1 — system-level context injection.
    settings_path = claude_dir / "settings.json"
    settings: dict = {}
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text())
        except Exception:
            settings = {}
    settings["systemPrompt"] = context_pack_text
    settings_path.write_text(json.dumps(settings, indent=2))

    # AC2 — enforcement hook script.
    hooks_dir = claude_dir / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    hook_path = hooks_dir / "context-enforcement.sh"
    hook_path.write_text(_HOOK_SCRIPT)
    hook_path.chmod(0o755)


__all__ = [
    "is_enforcement_enabled",
    "record_bypass_event",
    "count_bypass_events",
    "install_sandbox_hooks",
]
