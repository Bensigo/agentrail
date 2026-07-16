# Jace (apps/jace) — production image.
#
# Jace is an Eve/Nitro sidecar. Unlike the console it is DELIBERATELY excluded
# from the root pnpm workspace (pnpm-workspace.yaml: "!apps/jace") and pins
# EXACT dependency versions (see the "//pins" note in apps/jace/package.json —
# Eve is pre-1.0 and churns fast), installing standalone via `npm ci`. Build
# context for this image is `apps/jace` itself, NOT the repo root — except for
# one thing: it also vendors the `agentrail` PYTHON package (from the repo
# root) because agent/tools/create_issue.ts shells out to the `agentrail`
# binary (agent/lib/create_issue.core.mjs: `bin = env.JACE_AGENTRAIL_BIN ||
# "agentrail"`, then `execFile(bin, ["issue","create","--connector","github",...])`).
# So THIS Dockerfile's context must be the REPO ROOT too:
#
#   docker build -f apps/jace/Dockerfile -t agentrail/jace:latest .
#
# (docker-compose.prod.yml's `jace` service sets `context: .` /
# `dockerfile: apps/jace/Dockerfile` accordingly.)
#
# Verified from source (not assumed) — the `agentrail issue create --connector
# github` path Jace's ONLY write action uses needs NEITHER git NOR the `gh`
# CLI NEITHER a database: it's a pure Python stdlib urllib REST call against
# GitHub's API using a bearer token from GITHUB_OAUTH_TOKEN/GITHUB_TOKEN (see
# agentrail/cli/commands/issue.py: "the connector never shells out to the `gh`
# CLI" + agentrail/connectors/github.py's OAuth REST client, "no PAT, no `gh`
# CLI"). So this image only needs Python + the two pure-Python deps the
# `agentrail` package declares in pyproject.toml (tree-sitter,
# tree-sitter-language-pack) — no git, no gh, no Docker socket.
#
# eve start binds 0.0.0.0 BY DEFAULT (verified in the installed eve@0.19.0
# package: dist/src/internal/nitro/host/start-production-server.js resolves
# `host = options.host ?? "0.0.0.0"` when no `--host` flag is passed, and
# forwards that as HOST/NITRO_HOST to the spawned Nitro server process) — no
# extra HOST env is needed for container reachability. The PORT is a different
# story: `eve start`'s default port is 3000 ($PORT env, else 3000) — the
# documented "port 2000" convention (apps/jace/README.md, apps/jace/docs/HOSTING.md,
# and EVE_HOST's default in apps/console/app/api/v1/connectors/jace/inbound/
# .../route.ts + .../runner/result/notify.ts) is `eve dev`'s own default, NOT
# `eve start`'s — so PORT=2000 is set explicitly below to keep production
# consistent with those documented/hard-coded defaults.
#
# node_modules is intentionally copied WHOLE (not pruned to --omit=dev) into
# the runtime stage: `@workflow/world-postgres` (Eve's Postgres state adapter —
# see docs/HOSTING.md: "State is backed by @workflow/world-postgres... There is
# no separate Jace-side datastore") is listed under package.json
# devDependencies, and it was not verified whether Eve's build step fully
# inlines it into `.output/` or still resolves it from node_modules at
# `eve start` time. Shipping the full node_modules is the safe choice; trimming
# it is a good follow-up once verified on the server (see deploy/README.md).

# ---- 1. deps — npm ci (standalone install, apps/jace is its own root) --------
FROM node:24-slim AS deps
WORKDIR /app
COPY apps/jace/package.json apps/jace/package-lock.json ./
# eve@0.19.0's default "just-bash" sandbox backend is NOT bundled with eve and is
# missing from apps/jace/package.json — `eve start` ENOENT/crash-loops without it.
# Install it here (--no-save: don't touch the pinned lockfile) so the sandbox can
# initialize. (Proper follow-up: add `just-bash` to apps/jace/package.json.)
RUN npm ci \
    && npm install --no-save just-bash

# ---- 2. builder — eve build -> .output/ ---------------------------------------
FROM deps AS builder
WORKDIR /app
COPY apps/jace/ ./
# Jace resolves its model AT `eve build` TIME: agent.ts runs
# `chooseModel(process.env)` during the build and the choice is BAKED into the
# compiled agent manifest (.eve/compile/compiled-agent-manifest.json). With no
# JACE_MODEL_BASE_URL present, chooseModel takes the Vercel AI Gateway branch and
# emits a PLAIN STRING model id, which Eve bakes as a STATIC gateway reference —
# runtime env can no longer change it, so Jace keeps calling the (uncredentialed)
# Vercel gateway even after you set JACE_MODEL_* at runtime and redeploy. When
# JACE_MODEL_BASE_URL IS set, agent.ts takes the openai-compatible branch and the
# model compiles to a SOURCE-BACKED reference (routing.kind:"external",
# source.sourceKind:"module") that Eve RE-IMPORTS and re-resolves against the
# RUNTIME env (incl. JACE_MODEL_API_KEY) on every boot. So these must be present
# at BUILD time — declaring them as ARG lets Railway inject the matching service
# variables into the build (Railway only injects vars that are declared as ARG).
# The API key is deliberately NOT an ARG: it is read at runtime, never baked into
# an image layer.
ARG JACE_MODEL_BASE_URL
ARG JACE_MODEL_ID
ARG JACE_MODEL_CONTEXT_WINDOW_TOKENS
ENV JACE_MODEL_BASE_URL=${JACE_MODEL_BASE_URL} \
    JACE_MODEL_ID=${JACE_MODEL_ID} \
    JACE_MODEL_CONTEXT_WINDOW_TOKENS=${JACE_MODEL_CONTEXT_WINDOW_TOKENS}
RUN npm run build

# ---- 3. runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime

# ca-certificates: outbound HTTPS to OpenRouter/Vercel AI Gateway, GitHub API,
# Telegram/Discord/Slack/LoopMessage APIs, Langfuse, Context7, the Playwright/
# agent-browser/browser-use MCP sidecars. python3/pip: the vendored `agentrail`
# CLI (see below) — Jace's ONLY outside-world write path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ---- agentrail CLI (Python) ----------------------------------------------------
# Same vendoring recipe as agentrail/docker/runner/Dockerfile: the CLI is pure
# Python driven by agentrail/scripts/agentrail (-> `python3 -m
# agentrail.cli.main`), so vendor the package source and put the launcher on
# PATH. tree-sitter deps come from pyproject.toml. tests/ and docker/ are
# dev-only and stripped after the copy. --break-system-packages is required on
# Debian 12+'s PEP 668 "externally managed environment" python — the same flag
# the root docker-compose.yml's `browser-use` sidecar already uses.
WORKDIR /opt/agentrail
COPY pyproject.toml ./pyproject.toml
COPY agentrail ./agentrail
RUN rm -rf ./agentrail/tests ./agentrail/docker \
    && python3 -m pip install --no-cache-dir --break-system-packages . \
    && chmod +x agentrail/scripts/agentrail \
    && ln -sf /opt/agentrail/agentrail/scripts/agentrail /usr/local/bin/agentrail

WORKDIR /app
ENV NODE_ENV=production PORT=2000
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.output ./.output
# eve start reads compiled agent metadata from .eve/compile/
# (compile-metadata.json, compiled-agent-manifest.json), produced by `eve build`
# in the builder stage — carry it into runtime or `eve start` ENOENT-crashes.
COPY --from=builder /app/.eve ./.eve
COPY --from=builder /app/package.json ./package.json
# agent/instructions.md (persona) and agent/skills/**/SKILL.md are loaded by
# Eve's filesystem convention at runtime, not fully inlined at build time in
# every case — ship the source tree alongside .output rather than assume.
COPY --from=builder /app/agent ./agent

EXPOSE 2000
# `npm run start` -> `eve start`: prewarm-checks .output/, binds 0.0.0.0:2000
# (PORT above), and waits on GET /eve/v1/health before eve considers itself up
# — see docker-compose.prod.yml's healthcheck for the same probe.
CMD ["npm", "run", "start"]
