# Jace

Jace is the coordinator for the AgentRail factory. It owns the ideation→issues
boundary: a human converses with Jace about an idea, and when the human approves,
Jace creates exactly ONE GitHub issue in the AgentRail "house format". The
AgentRail factory then picks that issue up on its own — it polls GitHub for the
trigger label — with zero Jace-side plumbing.

Jace is built on [Eve](https://github.com/vercel/eve) and runs as a self-hosted
HTTP sidecar.

## Topology

- Jace runs as an Eve self-hosted sidecar on `http://127.0.0.1:2000`.
- HTTP surface: `GET /eve/v1/health`, `POST /eve/v1/session`,
  `POST /eve/v1/session/:id`, `GET /eve/v1/session/:id/stream` (NDJSON).
- Jace has THREE human-gated ways to act on the outside world: `create_issue`,
  `create_workspace`, and `create_repo`. Every call to any of them is approved
  or rejected by a human before it runs (`approval: always()`). Every other
  tool is ungated because it is read-only or scoped to this conversation's own
  state — never a write to GitHub, a workspace, or the factory.
- `create_issue` shells out to the existing `agentrail issue create` CLI
  (connector mode → a direct GitHub issue create). This is still the single
  write path into the factory — `create_workspace` and `create_repo` write
  elsewhere (a workspace row; a GitHub repo and its connect chain) but neither
  enqueues factory work. The `ready-for-agent` trigger label is applied
  server-side by the CLI; Jace never passes labels.

Jace never merges pull requests, runs the factory, or triggers builds.

## Channels

Jace's platform channels are native Eve channels — files under
`agent/channels/`, auto-discovered by Eve (the filename is the channel id). The
built-in adapters (`telegramChannel()`, `discordChannel()`, …) default their
webhook route to `/eve/v1/<id>`; hand-rolled `defineChannel` files must declare
the FULL path themselves — Eve mounts their routes at the literal declared path,
with no prefixing. We do NOT hand-roll platform HTTP or token handling; Eve owns
inbound + outbound + threading + credentials.

- `agent/channels/telegram.ts` — `telegramChannel({ botUsername })`. Inbound at
  `/eve/v1/telegram`; register it once with Telegram's `setWebhook`:
  ```bash
  curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://<host>/eve/v1/telegram",
         "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
         "allowed_updates":["message","callback_query"]}'
  ```
- `agent/channels/discord.ts` — `discordChannel()`. Inbound at `/eve/v1/discord`.
- `agent/channels/slack.ts` — `slackChannel()`. Inbound (Events API +
  Interactivity) at `/eve/v1/slack`; point Slack's request URLs there. Credentials
  come from env (`SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`) — the same env-based
  self-host shape as Telegram/Discord, no Vercel Connect required.
- `agent/channels/run-outcome.ts` — a custom `defineChannel` route mounted at
  `/eve/v1/run-outcome`. The AgentRail console POSTs a TERMINAL run outcome here
  (`{ channel, message, target, auth }`); Jace hands it to the addressed platform
  channel via `args.receive(...)`, so the notification lands in a repliable thread.
  The console sends only the built message and the NON-SECRET destination
  (`target`) — the bot credentials stay in Jace's env.

- `agent/channels/imessage.ts` — a hand-rolled `defineChannel` (#1100). Eve ships
  no iMessage/LoopMessage channel, so this is a first-party bridge over the
  [LoopMessage](https://docs.loopmessage.com) Send + Inbound API. Inbound at
  `/eve/v1/imessage` (register that URL as the LoopMessage webhook, and set its
  dashboard `webhook_header` value to `LOOPMESSAGE_WEBHOOK_SECRET_TOKEN` — the
  route verifies it constant-time and `401`s on mismatch, then ACKs `200` fast and
  runs the turn under `waitUntil` because LoopMessage retries any non-2xx). It
  replies by posting to the Send API, splitting long turns into bubbles with the
  shared `chat-split` core. Bidirectional and group-aware. All pure logic
  (send-body shaping, inbound parse, constant-time auth) lives in the unit-tested
  `agent/lib/loopmessage.core.mjs`; the run-outcome recipient is resolved Jace-side
  from `target.handle` else `LOOPMESSAGE_DEFAULT_RECIPIENT`.

`imessage` is now a WIRED run-outcome channel: its `target` key is `handle`
(phone/email), but unlike the other channels that key is OPTIONAL — the console
has no non-secret channel id to send for iMessage, so `notifyIMessageViaJace`
posts an empty target and the recipient is resolved Jace-side (above). With the
free LoopMessage **Sandbox** account the sender cannot initiate: a contact must
text the sandbox sender first (rolling 24h window, ≤5 contacts).

These are gated per-workspace by `jaceOwns<Channel>Notify` (default OFF); a
workspace's outbound stays on its legacy console sender until its cutover.

### Hosted vs self-host

The Telegram bullet above is the self-host path: your own BotFather bot,
webhook pointed straight at this sidecar's `/eve/v1/telegram`. The hosted
product instead runs ONE shared bot for every workspace — Telegram's
`setWebhook` points at the AgentRail console's
`/api/v1/connectors/telegram/webhook` (secret-verified with the same
`TELEGRAM_WEBHOOK_SECRET_TOKEN`), which resolves the sender's workspace and
dispatches the turn into this sidecar's `/eve/v1/hosted-inbound` door.
Self-hosters keep the flow documented above unchanged; see
[`deploy/telegram-shared-bot-cutover.md`](../../deploy/telegram-shared-bot-cutover.md)
to migrate an existing self-hosted workspace onto the shared bot.

## Requirements

- Node.js `>= 24` (the tests use Node's built-in `node --test`).
- An installed `agentrail` CLI on `PATH` (or point `JACE_AGENTRAIL_BIN` at it),
  co-located with the operator's AgentRail install.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY` | Authenticates the model. `agent.ts` uses the string model id `anthropic/claude-sonnet-4.6`, which routes through the Vercel AI Gateway. A bare `ANTHROPIC_API_KEY` is IGNORED on that path. |
| `JACE_MODEL_BASE_URL` | Optional. When set, Jace uses an OpenAI-compatible endpoint at this URL instead of the AI Gateway (e.g. a self-hosted Ollama at `http://localhost:11434/v1`). Unset = production AI Gateway path. |
| `JACE_MODEL_ID` | Model id for the OpenAI-compatible endpoint. Defaults to `gemma4:latest`. Ignored on the AI Gateway path. |
| `JACE_MODEL_API_KEY` | Optional bearer token for the OpenAI-compatible endpoint. Omitted when unset (a local Ollama needs none). |
| `JACE_MODEL_CONTEXT_WINDOW_TOKENS` | Context-window size (tokens) for the OpenAI-compatible model, forwarded to Eve as `modelContextWindowTokens`. Defaults to `8192`. Used only on this path — a custom model has no AI Gateway catalog entry, and Eve refuses to boot without a window to compile its compaction trigger. Ignored on the AI Gateway path. Set it to match your model / Ollama `num_ctx`. |
| `GITHUB_OAUTH_TOKEN` or `GITHUB_TOKEN` | Optional manual override for the CLI's `github` connector auth. Normally unset: connecting a repo on the AgentRail console is sufficient — the CLI resolves the workspace's GitHub OAuth token from Postgres (`AGENTRAIL_WORKSPACE_ID` + `DATABASE_URL`) when no env token is given. See `agentrail/cli/commands/issue.py`. |
| `JACE_TARGET_REPO` | LAST-RESORT override for the `owner/repo` the created issue lands in. Normally unset: the CLI resolves the workspace's connected GitHub repo itself when `repo` isn't supplied to the `create_issue` tool. |
| `AGENTRAIL_WORKSPACE_ID` | The workspace this Jace deployment / its `agentrail` CLI invocations act for — the key the CLI uses to look up the connected GitHub repo + token in Postgres. |
| `DATABASE_URL` | Postgres connection the CLI's workspace lookup reads (the same store the console writes "connect a repo" to). Required only for the automatic repo/token resolution above; unused when `GITHUB_OAUTH_TOKEN`/`GITHUB_TOKEN` and `JACE_TARGET_REPO` (or an explicit `repo`) are both already set. |
| `JACE_AGENTRAIL_BIN` | Optional override for the `agentrail` binary. Defaults to `agentrail`. |
| `EVE_HOST` | Base URL used by the round-trip harness. Defaults to `http://127.0.0.1:2000`. |
| `TELEGRAM_BOT_USERNAME` | The Telegram bot's @username (without `@`) for the native `telegram` channel. |
| `TELEGRAM_BOT_TOKEN` | BotFather token for proactive Telegram sends. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Secret token Telegram signs inbound updates with (set on `setWebhook`). |
| `DISCORD_PUBLIC_KEY` | Verifies inbound Discord `X-Signature-Ed25519` + timestamp. |
| `DISCORD_APPLICATION_ID` | Edits Discord deferred responses / sends followups. |
| `DISCORD_BOT_TOKEN` | Proactive Discord messages + typing indicators. |
| `SLACK_BOT_TOKEN` | Bot user OAuth token (`xoxb-…`) for the native `slack` channel — proactive posts + Web API calls. (`slackChannel()` reads it from env when no explicit credentials are passed.) |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack request signatures (Events API + Interactivity). Read from env by `slackChannel()` unless a `webhookVerifier` is supplied. |
| `LOOPMESSAGE_API_KEY` | LoopMessage Send-API key for the native `imessage` channel. Sent RAW as the `Authorization` header (no `Bearer` prefix). |
| `LOOPMESSAGE_SENDER_NAME` | The LoopMessage sender name (`…@imsg.co` / your dedicated sender) used as `sender_name` on 1:1 sends. |
| `LOOPMESSAGE_WEBHOOK_SECRET_TOKEN` | The dashboard `webhook_header` value; inbound LoopMessage webhooks must present it as `Authorization`. Verified constant-time — unset ⇒ fail-closed (every inbound `401`s). |
| `LOOPMESSAGE_DEFAULT_RECIPIENT` | Fallback iMessage recipient (phone/email) for run-outcome pushes that carry no `target.handle`. |
| `JACE_PLAYWRIGHT_MCP_URL` | Streamable-HTTP URL of the headless Playwright MCP sidecar the `researcher` subagent drives read-only. Defaults to `http://localhost:8931/mcp` (the compose service / `npx @playwright/mcp` local dev). If unreachable, the researcher degrades gracefully to Context7-only. |
| `JACE_AGENT_BROWSER_MCP_URL` | Streamable-HTTP URL of the agent-browser MCP sidecar the `qa` subagent drives as its primary UI tester. Defaults to `http://localhost:8932/mcp` (the compose `agent-browser` service). If unreachable, qa falls back to the browser-use sidecar. |
| `JACE_BROWSER_USE_MCP_URL` | Streamable-HTTP URL of the browser-use MCP sidecar — the `qa` subagent's extraction + fallback engine. Defaults to `http://localhost:8933/mcp` (the compose `browser-use` service). Its optional LLM key is `BROWSER_USE_LLM_KEY` (see below). |
| `BROWSER_USE_LLM_KEY` | Optional. LLM key powering only the browser-use sidecar's `browser_extract_content` tool; passed to that sidecar (as its `OPENAI_API_KEY`) and to no other service. Unset = qa skips content extraction and falls back to `browser_get_state`. Never a Jace model/GitHub secret. |
| `CONTEXT7_API_KEY` | Optional. Raises Context7 hosted-MCP rate limits for the `researcher`; sent as the `CONTEXT7_API_KEY` request header. Unset = the keyless public tier. |

## The researcher subagent

Jace declares one read-only subagent, [`agent/subagents/researcher`](agent/subagents/researcher/agent.ts).
Root Jace delegates to it BEFORE drafting anything that touches external tech (a
library, SDK, API, CLI, or cloud service): it verifies claims against current
docs ([Context7](https://context7.com) hosted MCP) and the live web (the headless
Playwright sidecar), then returns a structured brief — recommended approach,
alternatives, citations (claim → URL → version), open questions, confidence.

The researcher has ZERO write capability by construction, from two independent
mechanisms (either alone is insufficient):

- **Isolation.** Eve's subagent boundary means it inherits nothing from root, so
  it cannot see or call `create_issue`.
- **Harness lock-down.** Eve injects a default harness — `bash`, `write_file`,
  `read_file`, `web_fetch`, … — into *every* agent at runtime, independent of the
  authored tools list, and `bash`/`write_file` are real write capabilities. The
  researcher's [`tools/`](agent/subagents/researcher/tools/) directory holds a
  `disableTool()` sentinel per harness tool, stripping the whole harness down to
  the one dynamic `connection_search` — its only means of reaching the two
  read-only MCP connections.

The Playwright connection is further restricted to a navigate/observe allow-list,
and fetched web content is treated as untrusted data (a prompt-injection
surface), never as instructions. See
[`docs/HOSTING.md`](docs/HOSTING.md#researcher-mcp-sidecars) for the sidecar setup.

## Install

This app is DELIBERATELY excluded from the root pnpm workspace and installs
standalone. The dependency pins are exact (see the `//pins` note in
`package.json`) because Eve is pre-1.0 and churns fast.

```bash
cd apps/jace
npm ci
```

## Run

Start the sidecar in one shell:

```bash
npm run dev        # runs `eve dev` on http://127.0.0.1:2000
```

Then, in another shell, drive the human-gated approval round-trip:

```bash
npm run roundtrip  # runs the approve + reject arms against the running sidecar
```

The round-trip harness exercises both arms end to end: approving creates a real
issue and returns its URL; rejecting creates no issue and the conversation
continues.

## Testing against a local OpenAI-compatible model (Ollama)

Jace's model endpoint is configurable, so you can drive the full approval flow
against a self-hosted model with no cloud model credentials. The operator's test
target is a local [Ollama](https://ollama.com) serving `gemma4`:

```bash
# one shell — start the sidecar pointed at local Ollama
JACE_MODEL_BASE_URL=http://localhost:11434/v1 \
JACE_MODEL_ID=gemma4:latest \
npm run dev

# another shell — drive the approve + reject arms
npm run roundtrip
```

The reject arm and the human-gated approval boundary itself need only the local
model. The approve arm additionally shells out to `agentrail issue create`, so it
still needs a reachable `agentrail` CLI and a resolvable GitHub repo + token —
either a repo connected on the AgentRail console (`AGENTRAIL_WORKSPACE_ID` +
`DATABASE_URL`) or the manual `GITHUB_OAUTH_TOKEN`/`GITHUB_TOKEN` + `JACE_TARGET_REPO`
overrides — to create the real issue. With neither, `create_issue` returns a
friendly "connect a repo first" message instead of failing.

## Unit tests

The pure issue-building/parsing core is unit-tested with zero extra
dependencies:

```bash
npm test           # node --test test/
```

## Persona

Jace's persona/system prompt is a reviewable artifact at
[`agent/instructions.md`](agent/instructions.md), loaded by Eve's filesystem
convention. The issue-shaping skill lives at
[`agent/skills/emit-issue-brief/SKILL.md`](agent/skills/emit-issue-brief/SKILL.md).

## Hosting

See [`docs/HOSTING.md`](docs/HOSTING.md) for the hosting decision.
