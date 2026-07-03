# Hosting

This is the resolved hosting decision for Jace. It is not an open question.

## Decision

Jace runs as an Eve **self-hosted sidecar**, co-located with the operator's
AgentRail install.

- Build and run with Eve's own lifecycle:

  ```bash
  npm run build   # eve build
  npm run start   # eve start
  ```

  In development, `npm run dev` (`eve dev`) serves the same surface.

- The sidecar listens on `http://127.0.0.1:2000`. Its HTTP surface is:
  - `GET  /eve/v1/health`
  - `POST /eve/v1/session`
  - `POST /eve/v1/session/:id`
  - `GET  /eve/v1/session/:id/stream` (NDJSON)

- State is backed by `@workflow/world-postgres` (pinned exactly at
  `5.0.0-beta.20`), Eve's Postgres world adapter. There is no separate
  Jace-side datastore.

## Why co-located

Jace's single write path is the local `agentrail issue create` CLI. Running the
sidecar next to the operator's AgentRail install means that CLI, its `github`
connector auth, and Jace share one host and one trust boundary. There is no
network hop between Jace and the write path it depends on.

## Authentication

- **Model.** `agent.ts` uses the string model id `anthropic/claude-sonnet-4.6`,
  which routes through the Vercel AI Gateway. The host must provide
  `VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`. A bare `ANTHROPIC_API_KEY` is
  ignored on that path.
- **GitHub.** The `agentrail issue create` CLI's `github` connector needs
  `GITHUB_OAUTH_TOKEN` or `GITHUB_TOKEN` on the host.

## Runtime and dependency policy

- Node.js `>= 24` is required.
- All dependency pins are **exact** (no `^`/`~`). Eve is pre-1.0 and churns
  quickly; a floating range would silently move the sidecar onto a breaking beta.
  This app is excluded from the root pnpm workspace and installs standalone with
  `npm ci`.
