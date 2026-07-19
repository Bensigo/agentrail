# AgentRail console — production image.
#
# apps/console is a Next.js 15 app that is part of the ROOT pnpm workspace
# (pnpm-workspace.yaml: "apps/*" minus "apps/jace", plus "packages/*") and
# depends on several `@agentrail/*` workspace packages via `workspace:*`. That
# means this image MUST be built with the REPO ROOT as the build context, e.g.
# from the repo root:
#
#   docker build -f apps/console/Dockerfile -t agentrail/console:latest .
#
# (docker-compose.prod.yml's `console` service already sets `context: .` /
# `dockerfile: apps/console/Dockerfile` relative to deploy/docker-compose.prod.yml
# — see that file.)
#
# Build stages:
#   1. base  — pnpm via corepack, on Node 24 (apps/console/package.json has no
#      explicit engines field, but CI (.github/workflows/ci.yml) pins Node 24 +
#      pnpm 9, and pnpm-lock.yaml is lockfileVersion 9.0 — this mirrors CI
#      exactly so the resolved dependency tree matches what's tested).
#   2. deps  — installs the FULL workspace with `pnpm install --frozen-lockfile`.
#      Only manifests (package.json/pnpm-lock.yaml/pnpm-workspace.yaml) are
#      copied into this stage, so this (slow) layer is cache-hit on any change
#      that doesn't touch a dependency.
#   3. builder — copies real source, builds `@agentrail/db-postgres` (the one
#      workspace package whose package.json points at `./dist`, not raw `./src`
#      — see packages/db-postgres/package.json's "main"/"exports" — so it MUST
#      be compiled before `next build`; every other `@agentrail/*` dep resolves
#      straight to `./src/index.ts` and Next transpiles it directly via
#      `transpilePackages` in next.config.ts), regenerates the fumadocs MDX
#      source (`fumadocs-mdx`, the console's own `postinstall`/`predev` hook —
#      re-run explicitly here rather than trusting postinstall timing/order in
#      a multi-package workspace install), then runs `next build` with
#      `output: "standalone"` (see next.config.ts).
#   4. runner — copies ONLY the traced standalone bundle
#      (.next/standalone/apps/console) + static assets into a slim runtime
#      image. No pnpm, no full node_modules, no source.
#
# apps/jace is NEVER copied into this build (excluded from the workspace
# entirely — see pnpm-workspace.yaml) and its exclusion also keeps this image
# free of Jace's exact-pinned Eve betas.
#
# Runtime env: see deploy/.env.production.example for the full list
# (DATABASE_URL, AUTH_SECRET, AUTH_TRUST_HOST=true behind Caddy, GITHUB_*,
# CONNECTOR_SECRET_KEY, EVE_HOST, ...). CLICKHOUSE_URL / S3_* are OPTIONAL —
# confirmed by reading the actual ingest routes (e.g.
# apps/console/app/api/v1/runner/result/route.ts wraps its ClickHouse
# failure-event insert in try/catch and still returns 202 on failure); S3_* has
# no reader anywhere in apps/console or packages/ at all today (dead config,
# reserved for a future artifact-storage feature) — see deploy/README.md.

# ---- 1. base -----------------------------------------------------------------
FROM node:24-slim AS base
# Match CI (.github/workflows/ci.yml node job): pnpm 9, activated via corepack
# (no separate npm-global pnpm install, no version drift from the lockfile's
# lockfileVersion 9.0).
RUN corepack enable && corepack prepare pnpm@9 --activate

# ---- 2. deps — install the full workspace, cached on manifests only ----------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-postgres/package.json packages/db-postgres/package.json
COPY packages/db-clickhouse/package.json packages/db-clickhouse/package.json
COPY packages/ui/package.json packages/ui/package.json
# @agentrail/mcp is NOT a console dependency, but its manifest is copied anyway:
# pnpm-lock.yaml's `importers:` section (lockfileVersion 9.0) lists every
# packages/* workspace member pnpm-workspace.yaml's glob matches, and
# `--frozen-lockfile` cross-checks that set against what it finds on disk —
# omitting a member here risks a frozen-lockfile mismatch rather than a quiet
# partial install. packages/mcp's actual source is never copied into the
# builder stage below since nothing in the console build imports from it.
COPY packages/mcp/package.json packages/mcp/package.json
# pnpm-workspace.yaml excludes apps/jace, so pnpm never tries to resolve it —
# apps/jace is not copied into this build context at all (see .dockerignore).
# --ignore-scripts: the deps stage has ONLY manifests (no source yet), so the
# console's `postinstall` (fumadocs-mdx) has nothing to generate and crashes.
# The builder stage below re-runs fumadocs-mdx explicitly once source is present
# (and db-postgres is built there too), so no lifecycle script is needed here.
# esbuild's platform binary ships as an optionalDependency (resolved from the
# lockfile, not a postinstall), so skipping scripts does not break it.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- 3. builder — real source, build db-postgres, regen mdx, next build ------
FROM deps AS builder
WORKDIR /app
COPY apps/console apps/console
COPY packages/auth packages/auth
COPY packages/contracts packages/contracts
COPY packages/db-postgres packages/db-postgres
COPY packages/db-clickhouse packages/db-clickhouse
COPY packages/ui packages/ui

ENV NODE_ENV=production
# Compile the ONE workspace package that resolves to dist/, not raw source.
RUN pnpm --filter @agentrail/db-postgres build
# Regenerate fumadocs' generated `.source/` (gitignored, driven by
# apps/console/source.config.ts + content/docs/**/*.mdx) explicitly, matching
# the console's own "predev" belt-and-suspenders re-run rather than trusting
# postinstall's ordering during a workspace-wide `pnpm install`.
RUN pnpm --filter @agentrail/console exec fumadocs-mdx
# One NEXT_PUBLIC_* var exists in apps/console today: NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
# (the hosted setup wizard's shared-bot deep link — see
# app/(dashboard)/setup/components/channel-step.tsx). Inlining it into the
# browser bundle requires the var to be present at BUILD time, not just at
# container start. Railway sets build-time env vars automatically, so its
# build of this image picks it up with no changes here; this compose
# Dockerfile has no build-arg plumbing for it, which is fine for self-host,
# where the var is expected to stay unset (see
# deploy/telegram-shared-bot-cutover.md) and the bring-your-own-bot form
# renders instead.
RUN pnpm --filter @agentrail/console build
# Self-contained migrator (#owner rule 2026-07-19: migrations ALWAYS run on
# deploy). Hand-assembled with plain npm (NOT `pnpm deploy`, which mis-splits
# its virtual store across /app/packages and the target dir under pnpm 9 —
# observed failing on Railway's builder): copy dist + drizzle + package.json,
# then npm-install the ONLY two prod deps (pure-JS `postgres` + `drizzle-orm`)
# into a flat node_modules the runner can execute without pnpm, the workspace,
# or the Next trace. dist/migrate.js resolves its SQL as `__dirname/../drizzle/
# migrations` and package.json's `"type": "module"` makes plain `node` run it
# as ESM. The `test -f` lines fail the BUILD (not the deploy) if either half
# ever goes missing. Wired to Railway's preDeployCommand on the console
# service (`node migrator/dist/migrate.js`): a failed migration aborts the
# rollout and the old build keeps serving.
RUN mkdir -p /migrator/dist /migrator/drizzle \
  && cp -r packages/db-postgres/dist/. /migrator/dist/ \
  && cp -r packages/db-postgres/drizzle/. /migrator/drizzle/ \
  && cp packages/db-postgres/package.json /migrator/package.json \
  && cd /migrator && npm install --omit=dev --no-audit --no-fund \
  && test -f /migrator/dist/migrate.js \
  && test -f /migrator/drizzle/migrations/meta/_journal.json

# ---- 4. runner — slim runtime, standalone server only ------------------------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# node:24-slim ships a non-root `node` user (uid 1000) out of the box.
RUN mkdir -p apps/console/.next && chown node:node apps/console/.next
COPY --from=builder --chown=node:node /app/apps/console/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/console/.next/static ./apps/console/.next/static
# The self-contained migrator (see the builder stage note). Runs as Railway's
# preDeployCommand (`node migrator/dist/migrate.js`) before every rollout;
# harmless to ship for self-host too (compose users can `docker compose run
# console node migrator/dist/migrate.js`).
COPY --from=builder --chown=node:node /migrator ./migrator
# apps/console has no public/ directory today (verified: `ls apps/console` has
# no public/), so there is nothing to copy there — add a
# `COPY --from=builder --chown=node:node /app/apps/console/public ./apps/console/public`
# line if one is added later.
USER node
EXPOSE 3000
# Standalone output nests the entry at <tracingRoot>/<app-dir>/server.js
# because outputFileTracingRoot points at the repo root (see next.config.ts).
CMD ["node", "apps/console/server.js"]
