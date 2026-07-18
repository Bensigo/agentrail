# AgentRail self-hosted runner — production image.
#
# This is the long-running `agentrail runner` daemon: claim → execute → report,
# forever (agentrail/runner/worker.py + agentrail/cli/commands/runner.py). It is
# NOT the same thing as agentrail/docker/runner/Dockerfile, which builds the
# DISPOSABLE per-issue sandbox image (agentrail/runner:latest) that the Docker
# execution backend spawns as a sibling container. This image never builds or
# runs that other image — see the execution-mode decision below.
#
# Build context is the REPO ROOT (needs pyproject.toml + agentrail/):
#
#   docker build -f deploy/runner/Dockerfile -t agentrail/deploy-runner:latest .
#
# ---------------------------------------------------------------------------
# EXECUTION MODE: host-native, not Docker-sandboxed. No /var/run/docker.sock.
# ---------------------------------------------------------------------------
# agentrail/sandbox/native_runner.py:select_sandbox_runner() picks the
# execution backend from ONE signal: whether ANTHROPIC_API_KEY is set in the
# runner's own environment.
#   - ANTHROPIC_API_KEY set   -> Docker sandbox mode (spawns disposable
#     `agentrail/runner:latest` sibling containers via the `docker` CLI; needs
#     the Docker socket mounted + that image pre-built on the host).
#   - ANTHROPIC_API_KEY unset -> host-native mode (run_issue_on_host): clones
#     into a fresh temp dir INSIDE THIS CONTAINER and runs `agentrail run issue
#     N` directly as a subprocess, no nested container, no Docker socket.
#
# This deployment routes the coding agent through OpenRouter (the secret lives
# in ANTHROPIC_AUTH_TOKEN at runtime, mapped from OPENROUTER_API_KEY — see
# below and entrypoint.sh), so ANTHROPIC_API_KEY is left UNSET (explicitly
# empty — see the baked ENV below) on purpose -> host-native mode is selected
# automatically. This is the simpler and safer choice for a single dogfood VM:
# no privileged socket mount, no need to `docker build` and tag the separate
# sandbox image on the server, one fewer thing to keep in sync. The tradeoff
# (per agentrail/sandbox/native_runner.py's own module docstring) is weaker
# isolation between this container and the cloned-repo agent execution — both
# share this container's filesystem/process namespace, mitigated by the coding
# agent's own sandboxing and the always-deleted-afterward temp working dir. If
# you outgrow this, switch to Docker-sandbox mode instead: set
# ANTHROPIC_API_KEY, mount /var/run/docker.sock into this container, and
# `docker build -f agentrail/docker/runner/Dockerfile -t agentrail/runner:latest .`
# on the host so the sibling image exists to spawn.
#
# ---------------------------------------------------------------------------
# CODING AGENT: Claude Code (headless), routed through OpenRouter (#1266).
# ---------------------------------------------------------------------------
# Supersedes the prior `aider`-via-`--agent custom` choice (see
# deploy/runner/README.md's "Supersedes aider" section for the full history of
# why aider was picked first). That choice is no longer needed: OpenRouter now
# documents a NATIVE Anthropic-Messages-compatible endpoint — Claude Code's own
# wire format, no shim/LiteLLM/custom-agent wrapper required (verified
# 2026-07-18: openrouter.ai/docs/cookbook/coding-agents/claude-code-integration):
#
#   ANTHROPIC_BASE_URL="https://openrouter.ai/api"
#   ANTHROPIC_AUTH_TOKEN="<your OpenRouter key>"   (RUNTIME secret, see entrypoint.sh)
#   ANTHROPIC_API_KEY=""                           (must be explicitly empty)
#
# Headless invocation is `claude --bare -p`: `--bare` skips local-machine
# discovery — hooks, skills, plugin sync, MCP servers, CLAUDE.md
# auto-discovery, keychain/OAuth reads (code.claude.com/docs/en/headless.md,
# "Start faster with bare mode"). That is exactly the posture a hosted runner
# needs: it clones ARBITRARY target repos and must never execute whatever
# hooks or CLAUDE.md THAT repo happens to carry. `--dangerously-skip-permissions`
# is required alongside it — same as this very repo's own pre-#1266 `claude`
# runner command (.agentrail/config.json) — because a headless run with no
# human watching would otherwise hang forever on the first permission prompt.
#
# UNVERIFIED INTERACTION — read before trusting a live run; this is exactly
# what PR② (the real end-to-end run) exists to settle:
#   code.claude.com/docs/en/headless.md states, verbatim: "Bare mode skips
#   OAuth and keychain reads. Anthropic authentication must come from
#   ANTHROPIC_API_KEY or an apiKeyHelper in the JSON passed to --settings" —
#   ANTHROPIC_AUTH_TOKEN is not named as a bare-mode-compatible credential
#   there. The installed CLI's own `--bare` --help text says close to the same
#   thing ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
#   --settings (OAuth and keychain are never read)"). Meanwhile OpenRouter's
#   OWN Claude Code integration guide (cited above) is written around the
#   ANTHROPIC_AUTH_TOKEN + empty-ANTHROPIC_API_KEY shape and never mentions
#   `--bare` at all. Neither source explicitly contradicts the other, but
#   together they leave it genuinely unverified whether `--bare` reads
#   ANTHROPIC_AUTH_TOKEN at all when talking to a non-Anthropic base URL. This
#   could not be tested in the build environment that produced this image (no
#   OpenRouter key here, and none should ever be written into this repo — see
#   deploy/runner/README.md). The default below is the OpenRouter-documented
#   shape; if PR②'s first real run 401s (or otherwise fails to authenticate)
#   instead of reaching the model, the one-line fallback is: in
#   entrypoint.sh, set `ANTHROPIC_API_KEY="$OPENROUTER_API_KEY"` instead of
#   `ANTHROPIC_AUTH_TOKEN`, and drop the empty-string override — not a
#   re-architecture.
#
# Model routing is per-target-repo: `.agentrail/config.json`'s
# `runners.claude.models.{execute,verify,critic}` (see
# deploy/runner/agentrail-config.hosted.json, the shipped template — and
# deploy/runner/README.md for the full contract). A repo that commits its own
# config keeps it untouched (BYO always wins); a freshly claimed repo with
# none is seeded from this template, baked into the image below and pointed
# to by AGENTRAIL_HOSTED_CONFIG — see
# agentrail/sandbox/native_runner.py:_inject_hosted_config (#1267 PR②). Before
# that seam existed this template was reference-only and nothing copied it
# into a clone; that gap is now closed. `--model` is appended per-phase,
# already shell-quoted, by agentrail/cli/commands/run.py's
# `append_model_to_command`.
#
# `--bare` is wired via the AGENTRAIL_CLAUDE_COMMAND env override baked below
# — NOT by changing DEFAULT_COMMANDS["claude"] in
# agentrail/cli/commands/run.py. That constant is also what every LOCAL
# developer's `agentrail run` falls back to; hardcoding `--bare` there would
# silently take away their own hooks/CLAUDE.md/MCP servers. The env override
# (agentrail/cli/commands/run.py: ENV_NAMES = {"claude": "AGENTRAIL_CLAUDE_COMMAND", ...},
# read by resolve_agent_command) only affects processes that inherit THIS
# image's environment, i.e. only hosted/containerized runs.
#
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# git + gh: agentrail/sandbox/native_runner.py shells out to both directly
# (git clone/checkout/add/commit/push; gh pr create / gh pr view) — confirmed
# by reading native_runner.py. `agentrail run`'s bare-issue-selection path also
# calls `gh issue list` (agentrail/cli/commands/run.py) and `gh issue view`
# (agentrail/run/context.py). curl: installs gh's apt repo. ca-certificates:
# outbound HTTPS to the console, OpenRouter, GitHub. python3/python3-pip: the
# agentrail CLI is pure Python (see below) — this base image is Node-first
# (Claude Code needs Node >=22; see the pin note below), so Python is the one
# added via apt here, mirroring apps/jace/Dockerfile's identical vendoring
# recipe on the same node:*-slim base. --break-system-packages is required on
# Debian 12+'s PEP 668 "externally managed environment" python (same flag
# apps/jace/Dockerfile already uses).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        gnupg \
        python3 \
        python3-pip \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ---- agentrail CLI (Python) ---------------------------------------------------
# Same vendoring recipe as apps/jace/Dockerfile and agentrail/docker/runner/Dockerfile:
# vendor the package source, pip install it (registers `agentrail` + resolves
# its tree-sitter deps from pyproject.toml), put the bash launcher on PATH.
WORKDIR /opt/agentrail
COPY pyproject.toml ./pyproject.toml
COPY agentrail ./agentrail
RUN rm -rf ./agentrail/tests ./agentrail/docker \
    && python3 -m pip install --no-cache-dir --break-system-packages . \
    && chmod +x agentrail/scripts/agentrail \
    && ln -sf /opt/agentrail/agentrail/scripts/agentrail /usr/local/bin/agentrail

# ---- Claude Code CLI (the coding agent; #1266) -------------------------------
# Exact pin, not a floating `npm i -g @anthropic-ai/claude-code` — house pin
# discipline: an unpinned install would silently change agent behavior on
# every image rebuild. 2.1.214 was the current published `latest` as of
# 2026-07-18 (`npm view @anthropic-ai/claude-code version`). Bump deliberately.
#
# Node >=22 is a hard requirement of this package (`npm view
# @anthropic-ai/claude-code engines` -> {"node": ">=22.0.0"}) — this is why
# this image's base is node:22-slim rather than python:3.11-slim (the prior
# base): Debian bookworm's own apt `nodejs` package is v18, too old to run a
# current claude-code build at all.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.214 \
    && npm cache clean --force

COPY deploy/runner/entrypoint.sh /usr/local/bin/runner-entrypoint
RUN chmod +x /usr/local/bin/runner-entrypoint

# ---- Hosted default config template (#1267 PR②) ------------------------------
# Baked at a FIXED path so agentrail/sandbox/native_runner.py's
# _inject_hosted_config can seed it into a freshly claimed repo that has no
# .agentrail/config.json of its own — without this, every such repo is
# permanently refused by #1270's independent-review assert (no distinct
# verify-phase model to resolve). AGENTRAIL_HOSTED_CONFIG (below) points at
# this exact path; the two must move together. Previously this template
# existed only as a reference file nothing copied into an image — see
# agentrail-config.hosted.json's own header and deploy/runner/README.md's
# now-superseded "not auto-injected" section.
COPY deploy/runner/agentrail-config.hosted.json /opt/agentrail/agentrail-config.hosted.json

# ---- Env baked into the image (all non-secret) -------------------------------
# ANTHROPIC_AUTH_TOKEN — the actual OpenRouter credential — is deliberately
# NOT here. runner-entrypoint maps it in at container start from
# OPENROUTER_API_KEY (docker-compose.prod.yml's env_file), so the secret is
# never an image layer and never logged. See entrypoint.sh + README.md.
#
# `docker build` prints a linter warning on the ANTHROPIC_API_KEY line below
# ("SecretsUsedInArgOrEnv") — it is pattern-matching the variable NAME, not
# its value. The value here is the empty string, on purpose (required by
# OpenRouter's own Claude Code integration guide, so it never shadows
# ANTHROPIC_AUTH_TOKEN); there is no secret in this ENV instruction to leak.
ENV ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
    ANTHROPIC_API_KEY="" \
    CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1 \
    AGENTRAIL_HOSTED=1 \
    AGENTRAIL_HOSTED_CONFIG=/opt/agentrail/agentrail-config.hosted.json \
    AGENTRAIL_AGENT=claude \
    AGENTRAIL_CLAUDE_COMMAND="claude --bare -p --dangerously-skip-permissions"

# Runs as root (no USER directive) — simplest for a single-tenant VM writing
# into a named volume, and matches Python's home-dir resolution below. `HOME`
# is NOT overridden: root's home is /root by convention (Path.home() in
# agentrail/runner/credentials.py resolves via $HOME), so `agentrail login`
# writes credentials to /root/.agentrail/credentials.json — that is the exact
# path docker-compose.prod.yml mounts a named volume onto. Harden with a
# dedicated non-root user + matching volume ownership if you outgrow
# single-tenant.
WORKDIR /root

ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
# Default CMD: the long-running daemon (`docker compose up -d runner`). Overridden
# entirely by `docker compose run --rm runner <anything>` (e.g. `agentrail login
# --url ...`, `agentrail runner --once`) — see runner-entrypoint's own header
# comment for why the entrypoint script stays generic instead of hardcoding this.
CMD ["agentrail", "runner"]
