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
# This deployment routes the coding agent through OpenRouter (OPENROUTER_API_KEY
# in .env.production, not ANTHROPIC_API_KEY), so ANTHROPIC_API_KEY is left
# UNSET here on purpose -> host-native mode is selected automatically. This is
# the simpler and safer choice for a single dogfood VM: no privileged socket
# mount, no need to `docker build` and tag the separate sandbox image on the
# server, one fewer thing to keep in sync. The tradeoff (per
# agentrail/sandbox/native_runner.py's own module docstring) is weaker
# isolation between this container and the cloned-repo agent execution — both
# share this container's filesystem/process namespace, mitigated by the coding
# agent's own sandboxing and the always-deleted-afterward temp working dir. If
# you outgrow this, switch to Docker-sandbox mode instead: set
# ANTHROPIC_API_KEY, mount /var/run/docker.sock into this container, and
# `docker build -f agentrail/docker/runner/Dockerfile -t agentrail/runner:latest .`
# on the host so the sibling image exists to spawn.
#
# ---------------------------------------------------------------------------
# CODING AGENT: aider, routed through OpenRouter. UNVERIFIED — see README.
# ---------------------------------------------------------------------------
# agentrail/cli/commands/run.py's DEFAULT_COMMANDS only ships four concrete
# agent CLIs: codex, claude, cursor, hermes (plus the "custom" escape hatch,
# --agent custom --command <...> / AGENTRAIL_CUSTOM_COMMAND). None of those four
# is a good OpenRouter fit today:
#   - codex: the currently-published `@openai/codex` CLI's `model_providers.*`
#     config REMOVED `wire_api = "chat"` support (Responses-API endpoints only —
#     verified against the codex-rs source: WireApi::deserialize rejects "chat"
#     with an explicit removal error). OpenRouter speaks the OpenAI
#     Chat-Completions wire format, not the Responses API, so pointing codex at
#     OpenRouter via a custom model_provider is NOT expected to work as of this
#     writing (unverified whether OpenRouter has since added Responses-API
#     compatibility — check before relying on this path).
#   - claude (Claude Code CLI): reads Anthropic's own Messages API shape;
#     OpenRouter does not expose an Anthropic-Messages-compatible endpoint.
#   - cursor-agent / hermes: no documented custom-provider/base-URL override
#     was found or verified for either.
#
# So this image installs `aider-chat` (pip, isolated via pipx) instead, wired
# through the `--agent custom` escape hatch. Aider has FIRST-CLASS, documented
# OpenRouter support: set OPENROUTER_API_KEY and pass `--model
# openrouter/<vendor>/<model>` (verified via aider's own docs,
# aider/website/docs/llms/openrouter.md). agentrail's run pipeline PIPES THE
# PROMPT OVER STDIN to the agent command (agentrail/run/proc.py:
# run_with_timeout's `stdin_text`), matching codex's trailing `-` / claude's
# `-p` / cursor's `-p` — but aider's non-interactive interface is `--message`/
# `--message-file`, NOT stdin. /usr/local/bin/aider-stdin-wrapper below bridges
# that gap: it reads stdin into a temp file and calls aider with
# `--message-file`. This wrapper is WRITTEN BUT NOT RUN END-TO-END here (no
# Docker available in this build environment) — validate it for real on the
# server (see deploy/README.md's runner verification steps) before trusting a
# live run.
#
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# git + gh: agentrail/sandbox/native_runner.py shells out to both directly
# (git clone/checkout/add/commit/push; gh pr create / gh pr view) — confirmed
# by reading native_runner.py. `agentrail run`'s bare-issue-selection path also
# calls `gh issue list` (agentrail/cli/commands/run.py) and `gh issue view`
# (agentrail/run/context.py). curl: installs gh's apt repo + pipx.
# ca-certificates: outbound HTTPS to the console, OpenRouter, GitHub.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        gnupg \
        pipx \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ---- agentrail CLI (Python) ---------------------------------------------------
# Same vendoring recipe as agentrail/docker/runner/Dockerfile and
# apps/jace/Dockerfile: vendor the package source, pip install it (registers
# `agentrail` + resolves its tree-sitter deps from pyproject.toml), put the
# bash launcher on PATH.
WORKDIR /opt/agentrail
COPY pyproject.toml ./pyproject.toml
COPY agentrail ./agentrail
RUN rm -rf ./agentrail/tests ./agentrail/docker \
    && pip install --no-cache-dir . \
    && chmod +x agentrail/scripts/agentrail \
    && ln -sf /opt/agentrail/agentrail/scripts/agentrail /usr/local/bin/agentrail

# ---- aider (isolated via pipx, keeps its dep tree off agentrail's) -----------
# PIPX_BIN_DIR=/usr/local/bin puts the `aider` shim straight on the default
# PATH, so no `pipx ensurepath` (which edits shell profile files — meaningless
# in a non-interactive container, skipped on purpose) is needed.
ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin
RUN pipx install aider-chat

# stdin -> --message-file bridge (see the wire-format note above).
COPY deploy/runner/aider-stdin-wrapper.sh /usr/local/bin/aider-stdin-wrapper
COPY deploy/runner/entrypoint.sh /usr/local/bin/runner-entrypoint
RUN chmod +x /usr/local/bin/aider-stdin-wrapper /usr/local/bin/runner-entrypoint

# `agentrail run`'s custom-agent resolution reads AGENTRAIL_CUSTOM_COMMAND (see
# agentrail/cli/commands/run.py's ENV_NAMES) when --agent custom / AGENTRAIL_AGENT=custom
# is selected; the actual `--agent custom` selection happens via AGENTRAIL_AGENT
# (read by run_issue_on_host, agentrail/sandbox/native_runner.py) at runtime,
# set in docker-compose.prod.yml rather than baked here so it stays overridable.
ENV AGENTRAIL_CUSTOM_COMMAND="/usr/local/bin/aider-stdin-wrapper"

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
