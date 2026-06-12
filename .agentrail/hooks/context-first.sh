#!/usr/bin/env bash
# AgentRail context-first enforcement hook (Claude Code PreToolUse).
#
# Blocks the FIRST broad repo search (Grep/Glob tools, or Bash commands that
# start with `grep `/`rg `/`find `) until `agentrail context query`/`search` has
# been run in this session. The context CLI touches a marker file at
# .agentrail/tmp/context-queried on every query/search; once the marker exists,
# this hook is permissive — retrieval can genuinely miss, so grep is never a
# hard lock.
#
# Reads Claude Code's PreToolUse hook JSON from stdin. Exit 2 + feedback on
# stderr blocks the call (Claude Code convention); exit 0 allows it.
#
# Enforcement is claude-only: Codex has no hook mechanism and relies on prompt
# steering (see AGENTS.md "Context Retrieval").
set -euo pipefail

project_dir="${CLAUDE_PROJECT_DIR:-.}"
marker="${project_dir}/.agentrail/tmp/context-queried"

payload="$(cat)"

# Decide whether this call is a broad search that should be gated. python3
# parses the hook JSON (no jq dependency). Prints "block" when the tool is a
# broad search, otherwise "allow".
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

if [ -f "$marker" ]; then
  exit 0
fi

echo 'Use `agentrail context query "<your term>" --json` first — ranked retrieval is cheaper than repo-wide grep. Grep is allowed after retrieval has been tried.' >&2
exit 2
