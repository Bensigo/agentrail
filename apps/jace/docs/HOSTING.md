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

The Vercel AI Gateway string id is the production model path, but the endpoint is
configurable. Setting `JACE_MODEL_BASE_URL` points Jace at any OpenAI-compatible
server (a self-hosted Ollama, vLLM, LM Studio, or LiteLLM) via
`@ai-sdk/openai-compatible`, with `JACE_MODEL_ID` selecting the model and
`JACE_MODEL_API_KEY` an optional bearer token. This is how the app is exercised
locally — against a local Ollama — without cloud model credentials.

On this path Eve cannot resolve the model's context window from the AI Gateway
catalog (a self-hosted model has no catalog entry), and it refuses to boot without
one because it needs the window to compile its compaction trigger. Jace supplies
the window itself via Eve's public `modelContextWindowTokens` escape hatch;
`JACE_MODEL_CONTEXT_WINDOW_TOKENS` overrides it (default `8192`, set it to match
your model / Ollama `num_ctx`). The var is ignored on the AI Gateway path, where
Eve resolves the window from the catalog.

## Researcher MCP sidecars

Jace's `researcher` subagent reads from two external MCP sources to verify
external-tech facts before Jace drafts. Both are read-only and both fail soft —
Eve discovers connection tools lazily at runtime, so a source that is unreachable
just never resolves its tools and the researcher degrades rather than failing to
boot.

- **Context7** (hosted, no setup). The `context7` connection points at the hosted
  MCP endpoint `https://mcp.context7.com/mcp` for current, version-accurate
  library docs. It works keyless on the public tier. Set `CONTEXT7_API_KEY` to
  raise rate limits — Jace forwards it as the `CONTEXT7_API_KEY` request header;
  unset means the keyless tier.

- **Playwright** (headless browser sidecar, you run it). The `playwright`
  connection drives a headless-Chromium [Playwright MCP][pw] server to read live
  web pages (release notes, changelogs, GitHub issues) that Context7 may not
  index. The researcher uses only navigation/observation tools — it cannot click,
  type, or run code. Jace reaches the sidecar over Streamable HTTP; point it with
  `JACE_PLAYWRIGHT_MCP_URL` (default `http://localhost:8931/mcp`).

  - **Production (compose).** The root `docker-compose.yml` ships a `playwright`
    service on the official image `mcr.microsoft.com/playwright/mcp`, launched
    `--headless --no-sandbox` and bound `--host 0.0.0.0` so sibling containers can
    reach it. Co-located services use `JACE_PLAYWRIGHT_MCP_URL=http://playwright:8931/mcp`;
    a Jace process outside the compose network uses the published port,
    `http://localhost:8931/mcp`.

  - **Local dev (npx).** No Docker needed — run the server directly:

    ```bash
    npx @playwright/mcp@latest --headless --port 8931
    ```

    Jace then uses the default `http://localhost:8931/mcp`, so no env var is
    required locally.

- **Degraded mode.** If the Playwright sidecar is unreachable, the researcher
  continues on Context7 alone and marks the brief `degraded: true` with
  `sourcesUsed: ["context7"]`, noting the reduced web coverage and lowering its
  confidence. If Context7 is *also* unreachable it returns an honest,
  low-confidence brief that verifies nothing (`sourcesUsed: []`) rather than
  guessing. Jace then surfaces the affected claims as "unverified" instead of
  stating them as fact.

The researcher has no write capability and never needs approval. That holds from
two mechanisms: Eve's subagent boundary isolates it from Jace's single
`create_issue` write path, AND a `tools/` directory of `disableTool()` sentinels
strips Eve's default agent harness (`bash`, `write_file`, `read_file`,
`web_fetch`, …, which Eve injects into every agent regardless of the authored
tool list) down to the one read-only `connection_search`. Isolation alone would
not remove `bash`/`write_file`; the sentinels do. All web access is therefore
funnelled through the two allow-listed, read-only MCP connections. Web content it
reads is untrusted data (a prompt-injection surface): the researcher cites what a
page says, it never acts on what a page tells it to do.

[pw]: https://github.com/microsoft/playwright-mcp

## Runtime and dependency policy

- Node.js `>= 24` is required.
- All dependency pins are **exact** (no `^`/`~`). Eve is pre-1.0 and churns
  quickly; a floating range would silently move the sidecar onto a breaking beta.
  This app is excluded from the root pnpm workspace and installs standalone with
  `npm ci`.
