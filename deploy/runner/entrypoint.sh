#!/usr/bin/env bash
# Runner container ENTRYPOINT: wire up `gh`/`git` GitHub auth from
# GITHUB_TOKEN, then exec whatever CMD was given.
#
# This does NOT hardcode `agentrail runner` — it execs "$@" generically so the
# SAME image serves both:
#   docker compose ... up -d runner                    # default CMD (Dockerfile:
#                                                        # `CMD ["agentrail","runner"]`)
#                                                        # -> long-running daemon
#   docker compose ... run --rm runner agentrail login --url ...   # one-off,
#                                                        # overrides CMD entirely
# If this hardcoded `exec agentrail runner "$@"` instead, the second form would
# actually run `agentrail runner agentrail login --url ...` (nonsense) — Docker
# CMD-override only replaces CMD, never ENTRYPOINT, so ENTRYPOINT must stay
# generic for `docker compose run <service> <anything-else>` to work at all.
#
# `agentrail runner` itself needs ZERO connection config (no DB URL, no API
# key as a flag): it reads ~/.agentrail/credentials.json, written once by an
# interactive `agentrail login` (see deploy/README.md's runbook — this is a
# human-in-the-loop OAuth device-flow step, it cannot be scripted headlessly
# here). That file must be on a volume that survives container restarts —
# docker-compose.prod.yml mounts one at /root/.agentrail.
set -euo pipefail

# --- GitHub auth for git/gh (native_runner.py shells out to both directly) ---
# Prefer GITHUB_TOKEN; fall back to GITHUB_OAUTH_TOKEN so the same PAT used for
# Jace's connector can be reused here without duplicating it under two names.
GH_AUTH_TOKEN="${GITHUB_TOKEN:-${GITHUB_OAUTH_TOKEN:-}}"
if [ -n "$GH_AUTH_TOKEN" ]; then
  # `gh auth login --with-token` authenticates the gh CLI itself (used for
  # `gh pr create` / `gh pr view` / `gh issue list` / `gh issue view`).
  echo "$GH_AUTH_TOKEN" | gh auth login --hostname github.com --with-token
  # `gh auth setup-git` configures a git credential helper so plain `git
  # clone`/`git push` over HTTPS (native_runner.py's _clone_command /
  # _push_command — no token is spliced into the URL there, unlike the
  # disposable sandbox's entrypoint.sh) pick up the same credential.
  gh auth setup-git
else
  echo "runner-entrypoint: WARNING — GITHUB_TOKEN/GITHUB_OAUTH_TOKEN not set." >&2
  echo "  git clone/push and gh pr create/issue view will fail once a job is claimed." >&2
fi

exec "$@"
