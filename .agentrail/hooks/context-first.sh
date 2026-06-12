#!/usr/bin/env bash
# AgentRail context-first enforcement hook (Claude Code PreToolUse) — HARD MODE.
#
# Denies repo-wide search outright: the Grep and Glob tools, and Bash commands
# that start with `grep `/`rg `/`find `, are blocked. Agents must rely on the
# AgentRail context pack and `agentrail context query`/`search` for retrieval,
# then Read the cited files. Unlike the earlier soft-nudge mode there is no
# marker escape — a prior `context query` does NOT re-enable grep. Retrieval is
# the only sanctioned way to locate code.
#
# Reads Claude Code's PreToolUse hook JSON from stdin. Exit 2 + feedback on
# stderr blocks the call (Claude Code convention); exit 0 allows it.
#
# Enforcement is claude-only: Codex has no hook mechanism and relies on prompt
# steering (see AGENTS.md "Context Retrieval").
set -euo pipefail

payload="$(cat)"

# Decide whether this call is a broad search that must be denied. python3 parses
# the hook JSON (no jq dependency). Prints "block" for a broad search, else
# "allow". Malformed input fails open ("allow") so the hook never wedges a
# session on a parsing edge case.
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
    print("block")
    sys.exit(0)

if tool == "Bash":
    command = (tool_input.get("command") or "").lstrip()
    for prefix in ("grep ", "rg ", "find "):
        if command.startswith(prefix):
            print("block")
            sys.exit(0)

print("allow")
')"

if [ "$decision" != "block" ]; then
  exit 0
fi

echo 'Repo-wide search is disabled (AgentRail hard mode). Use `agentrail context query "<your term>" --json` for ranked retrieval, then Read the cited files. The Grep/Glob tools and bare grep/rg/find are blocked.' >&2
exit 2
