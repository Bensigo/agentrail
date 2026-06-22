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
  # No test files changed — check whether any Python source code changed.
  # If only docs/config/markdown changed, this is a legitimately test-free
  # change (AC3 issue #891); exit 0 (green).  If Python source files changed
  # but no test was written, Red-Green-Proof (ADR 0008) is violated; exit 1.
  #
  # Use git ls-files --others (untracked files, listed individually not as dirs)
  # plus git diff for tracked modified/staged files.
  code_files=$(
    { git ls-files --others --exclude-standard; git diff --name-only HEAD 2>/dev/null || true; } \
      | grep -E '\.py$' | sort -u || true
  )
  if [ -z "$code_files" ]; then
    echo "verify: no code changes — legitimately test-free (docs/config only), green" >&2
    exit 0
  fi
  echo "verify: no changed test files — nothing to prove (red)" >&2
  exit 1
fi

echo "verify: running changed tests:" >&2
echo "$files" | sed 's/^/  /' >&2
exec python3 -m pytest -q -p no:cacheprovider $files
