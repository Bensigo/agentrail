#!/usr/bin/env bash
# Bridges agentrail's stdin-piped prompt contract to aider's file-based
# non-interactive interface.
#
# agentrail/run/proc.py's run_with_timeout() pipes the phase prompt to the
# agent command's STDIN (`stdin_text`) — the same contract DEFAULT_COMMANDS'
# other entries rely on (codex's trailing `-`, claude/cursor/hermes's `-p`
# reading stdin). Aider has no stdin-prompt mode; its scripting interface is
# `--message`/`-m TEXT` or `--message-file`/`-f FILE` (verified via aider's own
# docs, aider/website/docs/scripting.md). This wrapper reads the piped prompt
# into a temp file and hands it to aider via `--message-file`.
#
# UNVERIFIED END TO END — this repo has no existing aider integration to copy
# (grepped; there is none) and this could not be run in this build environment
# (no Docker here). Validate a real claimed-issue run on the server before
# trusting it; see deploy/README.md.
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"

MODEL="${RUNNER_MODEL:-z-ai/glm-4.6}"

exec aider \
  --yes \
  --no-auto-commits \
  --no-check-update \
  --model "openrouter/${MODEL}" \
  --message-file "$tmp"
