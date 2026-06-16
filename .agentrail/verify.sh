#!/usr/bin/env bash
# Objective-gate verify for AgentRail's own repo.
#
# Runs ONLY the test files this change touches — not the whole suite. The
# red-green proof needs the authored acceptance test to fail (baseline) then
# pass (after implementation); running the full suite drags in unrelated
# environment-dependent tests (daemon lifecycle, MCP structural, …) that fail in
# a fresh clone and would falsely make the gate red even when the work is correct.
#
# Also unsets the runner's ingestion env so the `*_push` "not linked" tests don't
# false-fail under it.
set -uo pipefail

unset AGENTRAIL_SERVER_BASE_URL AGENTRAIL_SERVER_API_KEY AGENTRAIL_SERVER_REPOSITORY_ID

# Changed/added/untracked test files in the worktree (porcelain → last field is
# the path; covers ??, M, A, and rename targets).
files=$(git status --porcelain | awk '{print $NF}' | grep -E '(^|/)(test_.*|.*_test)\.py$' | sort -u || true)

if [ -z "$files" ]; then
  echo "verify: no changed test files — nothing to prove (red)" >&2
  exit 1
fi

echo "verify: running changed tests:" >&2
echo "$files" | sed 's/^/  /' >&2
exec python3 -m pytest -q -p no:cacheprovider $files
