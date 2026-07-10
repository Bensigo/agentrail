# AgentRail disposable-run sandbox image.
#
# One container per dispatched issue: clone the repo, run `agentrail run issue N`
# inside, emit a sentinel-fenced result JSON, exit. The container is thrown away
# after each run (see agentrail/sandbox/docker_runner.py).
#
# Build (from repo root, so the build context includes the agentrail source):
#   docker build -f agentrail/docker/runner/Dockerfile -t agentrail/runner:latest .
#
# Required RUNTIME env (passed by the dispatcher via `docker run -e KEY`):
#   ANTHROPIC_API_KEY   agent API key for the Claude CLI (or the key your
#                       configured agent CLI needs, e.g. OPENAI_API_KEY for codex)
#   GIT_TOKEN           token used to clone private repos over HTTPS (optional
#                       for public repos)
#
# The entrypoint takes 3 positional args: <repo_url> <ref> <issue_ref>.
#
# Kept lean: a single slim Python base, Node added for the agent CLIs, git for
# cloning, and the agentrail CLI installed from the build context. No build
# toolchains or caches left in the final image.

FROM python:3.11-slim

# ---- base OS deps: git (clone) + node/npm (agent CLIs) + ca-certificates -----
# nodejs/npm from Debian is sufficient to run `npm i -g` agent CLIs. We clean the
# apt cache in the same layer to keep the image small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

# ---- agent CLIs --------------------------------------------------------------
# The project shells out to an agent CLI (claude / codex — see
# agentrail/cli/commands/run.py DEFAULT_COMMANDS). Install the ones we support.
# Pinned-floating to the latest; tighten to exact versions for reproducibility.
RUN npm install -g --no-audit --no-fund \
        @anthropic-ai/claude-code \
        @openai/codex \
    && npm cache clean --force

# ---- agentrail CLI -----------------------------------------------------------
# Install the agentrail package source from the build context. The CLI is pure
# Python driven by agentrail/scripts/agentrail (-> python -m agentrail.cli.main),
# so we vendor the package and put the launcher on PATH. tree-sitter deps come
# from pyproject so context retrieval works inside the sandbox. templates/,
# skills/, and scripts/ all live nested under agentrail/, so COPY agentrail
# ./agentrail already carries them — no separate COPY lines needed. tests/ and
# docker/ are dev-only and stripped after the copy to keep the image lean.
WORKDIR /opt/agentrail
COPY pyproject.toml ./pyproject.toml
COPY agentrail ./agentrail
RUN rm -rf ./agentrail/tests ./agentrail/docker \
    && pip install --no-cache-dir . \
    && chmod +x agentrail/scripts/agentrail \
    && ln -sf /opt/agentrail/agentrail/scripts/agentrail /usr/local/bin/agentrail

# ---- run entrypoint ----------------------------------------------------------
# clone -> agentrail run issue N -> emit result JSON. Lives in the image so the
# sandbox seam only has to pass repo/ref/issue.
COPY agentrail/docker/runner/entrypoint.sh /usr/local/bin/agentrail-sandbox-entry
RUN chmod +x /usr/local/bin/agentrail-sandbox-entry

# Disposable workspace; cloned fresh on every run.
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/agentrail-sandbox-entry"]
