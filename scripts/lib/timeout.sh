#!/usr/bin/env bash
# Shared portable_timeout and sanitized_agent_exec functions.
# Source this file instead of duplicating these functions.

portable_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  # macOS fallback: capture stdin to a temp file so the backgrounded process
  # can still read it (backgrounded processes get /dev/null as stdin).
  local _pt_stdin_file=""
  if [[ ! -t 0 ]]; then
    _pt_stdin_file="$(mktemp)"
    cat > "$_pt_stdin_file"
  fi
  if [[ -n "$_pt_stdin_file" ]]; then
    "$@" < "$_pt_stdin_file" &
  else
    "$@" &
  fi
  local pid=$!
  ( sleep "$seconds" && kill -TERM "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local exit_code=$?
  # Capture sleep child PIDs before killing watcher (children reparent to PID 1 after kill)
  local _pt_sleep_pids
  _pt_sleep_pids="$(pgrep -P "$watcher" 2>/dev/null || true)"
  kill "$watcher" 2>/dev/null
  if [[ -n "$_pt_sleep_pids" ]]; then
    kill $_pt_sleep_pids 2>/dev/null || true
  fi
  [[ -n "$_pt_stdin_file" ]] && rm -f "$_pt_stdin_file"
  if [[ "$exit_code" -eq 143 ]]; then
    return 124
  fi
  return "$exit_code"
}

sanitized_agent_exec() {
  env \
    -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
    -u AI_AGENT \
    -u CODEX_SESSION -u CODEX_SANDBOX \
    -u CURSOR_SESSION -u CURSOR_AGENT \
    "$@"
}
