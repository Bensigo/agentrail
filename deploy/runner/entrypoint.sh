#!/usr/bin/env bash
# Runner container ENTRYPOINT: wire up `gh`/`git` GitHub auth from
# GITHUB_TOKEN and the coding agent's OpenRouter auth from OPENROUTER_API_KEY,
# then exec whatever CMD was given.
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

# --- OpenRouter auth for Claude Code (#1266) ---------------------------------
# ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY="" are baked into the image
# (Dockerfile ENV, non-secret). Only the credential itself is supplied at
# runtime — mapped here from OPENROUTER_API_KEY (already the one env name
# deploy/.env.production.example documents for this service) into the
# variable Claude Code actually reads for a Bearer-style credential,
# ANTHROPIC_AUTH_TOKEN. Doing the mapping here (not in docker-compose.prod.yml)
# keeps ONE secret name across the whole deploy folder and keeps the secret
# out of both the image and any compose file — it exists only in this
# process's environment. Never echoed/logged. See deploy/runner/Dockerfile's
# header comment and deploy/runner/README.md for the UNVERIFIED note on
# whether Claude Code's `--bare` mode actually honors this env var — if it
# turns out not to, the fix is a one-line swap right here (set
# ANTHROPIC_API_KEY instead and drop this export), not a re-architecture.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
else
  echo "runner-entrypoint: WARNING — OPENROUTER_API_KEY not set." >&2
  echo "  claude (the coding agent) will fail to authenticate against OpenRouter once a job is claimed." >&2
fi

exec "$@"
