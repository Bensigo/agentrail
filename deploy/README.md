# AgentRail — single-VM production deploy

Walking-skeleton deploy for **one Docker host**: a Vultr Ubuntu 26.04 x86 VM
running Docker 29.6 + Compose v5.3, single-tenant / dogfood. Five services in
one compose file: `postgres`, `console`, `jace`, `caddy`, `runner`.

**Intentionally omitted:** ClickHouse and MinIO. The app tolerates their
absence — see `deploy/.env.production.example`'s comments for exactly which
code paths are try/caught around ClickHouse and why S3/MinIO is genuinely dead
config today (grepped: zero readers anywhere in `apps/console` or
`packages/*`). Also omitted: Jace's Playwright/agent-browser/browser-use MCP
sidecars (the `researcher`/`qa` subagents' tool sources) — both subagents
degrade gracefully when their sidecar is unreachable rather than failing to
boot; add the sidecar services back later (copy them from the root
`docker-compose.yml`, which already has working recipes for all three) if you
want those subagents at full strength.

**Public hostname:** `65.20.91.127.sslip.io` — [sslip.io](https://sslip.io)
resolves that hostname to `65.20.91.127` (a wildcard DNS trick), so Caddy can
get a real Let's Encrypt cert automatically with zero DNS setup. If the box's
IP changes, change the hostname to match (`<new-ip>.sslip.io`) everywhere it
appears below and in `deploy/Caddyfile`.

---

## 0. Before you start: what you need to have ready

- The Jace GitHub App — created in step 3 below, needs the server's public URL
  first, so it comes after DNS/Caddy is live. Every hosted GitHub call
  (console, Jace, the runner's git/gh auth) rides this App's installation
  tokens; no separate PAT is required.
- An [OpenRouter](https://openrouter.ai/keys) API key.
- Optionally: a Telegram bot token (via [@BotFather](https://t.me/BotFather))
  and/or a [Langfuse Cloud](https://cloud.langfuse.com) project.

---

## 1. Clone the repo on the server

```bash
git clone <your-fork-or-origin-url> agentrail
cd agentrail
git checkout feat/deploy-artifacts   # or main, once this branch is merged
```

## 2. Fill in the environment

```bash
cp deploy/.env.production.example deploy/.env
$EDITOR deploy/.env
```

Fill in every `REQUIRED` value (see the comments in that file — each one says
exactly where it's consumed and, for anything you need to go create yourself,
how). At minimum before first boot: `POSTGRES_PASSWORD`, `DATABASE_URL`,
`AUTH_SECRET`, `CONNECTOR_SECRET_KEY`, `JACE_MODEL_API_KEY`,
`JACE_TARGET_REPO`, `OPENROUTER_API_KEY`. The `GITHUB_APP_*` sextet needs the
App from step 3, so those can wait.

## 3. GitHub App + webhook

1. **GitHub App** (identity for login + repo access): [github.com/settings/apps](https://github.com/settings/apps)
   → New GitHub App:
   - Homepage URL: `https://65.20.91.127.sslip.io`
   - Callback URL: `https://65.20.91.127.sslip.io/api/auth/callback/github`
   - Setup URL: `https://65.20.91.127.sslip.io/api/v1/connectors/github/install-callback`
     ("Redirect on update" checked; Webhook → Active UNCHECKED)
   - Repository permissions: Contents RW, Pull requests RW, Issues RW,
     Webhooks RW, Administration RW, Checks RO (Metadata RO is automatic)
   - Account permissions: Email addresses RO
   - Where can it be installed: Any account

   After creating: copy the App ID + slug from the App page, generate a
   client secret and a private key (`.pem`) there too, and fetch the bot
   user id (`curl -s https://api.github.com/users/<slug>%5Bbot%5D | jq .id`).
   Fill all six into `deploy/.env`'s `GITHUB_APP_ID` / `GITHUB_APP_SLUG` /
   `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` /
   `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_BOT_USER_ID`. Then install the App
   on the account(s) you want to connect and click "Connect GitHub" in the
   console's Connectors page per workspace.

2. **Issues webhook** (fills the queue): on the target repo → Settings →
   Webhooks → Add webhook:
   - Payload URL: `https://65.20.91.127.sslip.io/api/v1/connectors/github/webhook`
   - Content type: `application/json`
   - Secret: same value as `deploy/.env`'s `GITHUB_WEBHOOK_SECRET` (set one —
     the route works without it, but skips signature verification if unset)
   - Events: **Issues** only

## 4. Build and start everything (migrations run automatically)

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Migrations are applied **automatically on every `up`** — no separate manual
step. The `migrate` service is a one-shot (`restart: "no"`) that reuses the
console image's `builder` stage, runs `pnpm --filter @agentrail/db-postgres
migrate` (see `packages/db-postgres/src/migrate.ts`), then exits 0. `console`
and `jace` both declare
`depends_on: { migrate: { condition: service_completed_successfully } }`, so
Compose brings up Postgres → runs `migrate` to completion → *then* starts the
app services. The schema is therefore always current before anything reads it.
It's idempotent (drizzle tracks what's already applied), so re-running `up`
after pulling new migrations just applies the new ones.

> This is what fixes the console **home** and **work** pages 500ing on a fresh
> or newly-pulled deploy: previously `migrate` was profile-gated out of `up`
> and had to be run by hand, so a deploy that skipped it left the queries
> reading not-yet-created columns (e.g. `queueEntries.parkReason` from
> migration 0027) and crashing.

First build will take a while (console: full pnpm workspace install +
`next build`; jace: `npm ci` + `eve build`; runner: apt + pip + pipx installs).
Watch it come up:

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f
```

Caddy should obtain a certificate for `65.20.91.127.sslip.io` automatically on
its first request — watch its logs specifically if HTTPS doesn't come up:

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f caddy
```

Verify: `https://65.20.91.127.sslip.io` should load the console's login page,
and `https://65.20.91.127.sslip.io/eve/v1/health` should return Jace's health
response.

## 5. Log in, create a workspace

Sign in with GitHub at `https://65.20.91.127.sslip.io`. The first login flow
creates a workspace (or routes you to `/setup` — see the root page's
workspace-aware routing). Once a workspace exists:

- Create a console API key for Jace's read-back tools and set
  `deploy/.env`'s `JACE_CONSOLE_TOKEN`, then
  `docker compose -f deploy/docker-compose.prod.yml up -d jace` to pick it up
  (optional — `fetch_workspace_memory`/`fetch_run_evidence` just report "not
  configured" without it, nothing else breaks).

## 6. Attach a runner

`agentrail runner` authenticates via an OAuth **device flow**
(`agentrail login`) — this is an interactive, human-approved step and cannot
be scripted headlessly. Run it once; the resulting token persists in the
`runner_agentrail_home` volume across restarts:

```bash
docker compose -f deploy/docker-compose.prod.yml run --rm runner \
  agentrail login --url http://console:3000
```

(`--url http://console:3000` uses the internal compose network — the runner
container can reach `console` directly without going through Caddy/DNS/TLS.
You could also use the public `https://65.20.91.127.sslip.io` URL; the
internal one is simpler and one fewer hop.)

This prints a short code + a verification URL. Open that URL in **your own
browser** (already signed into the console from step 5), approve, and the
command exits once approved. Then start the long-running daemon:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d runner
```

Check it's claiming/idling correctly:

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f runner
```

You should see `Runner active — workspace <id> @ http://console:3000. ...`.

**Runner execution mode, and what's unverified about it** — read
`deploy/runner/Dockerfile`'s header comment and `deploy/runner/README.md` in
full before relying on this in anger. Short version: this runner deliberately
runs in *host-native* mode (no `/var/run/docker.sock`, no nested sandbox
container — see the `ANTHROPIC_API_KEY` note there) and drives the coding
agent through **Claude Code**, headless (`claude --bare -p`), routed to
OpenRouter via its native Anthropic-Messages-compatible endpoint (#1266 —
supersedes an earlier `aider`-based choice; `deploy/runner/README.md` has the
full history of why aider was picked first and why it's no longer needed).
The image build + `claude --version`/`agentrail --help` were smoke-tested;
whether Claude Code's `--bare` mode actually authenticates via
`ANTHROPIC_AUTH_TOKEN` against a non-Anthropic base URL was **not** — no
OpenRouter key exists in the environment that built this image, and none
should ever be committed to this repo. `deploy/runner/README.md`'s
"UNVERIFIED" section has the exact fallback if the first real run's auth
fails. Before trusting a real run:

```bash
# Drain exactly one claim and watch it closely:
docker compose -f deploy/docker-compose.prod.yml run --rm runner \
  agentrail runner --once
```

## 7. Wire up optional channels

**Telegram** (only if you set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME`/
`TELEGRAM_WEBHOOK_SECRET_TOKEN` in step 2):

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://65.20.91.127.sslip.io/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

Discord/Slack/iMessage follow the same pattern — point each platform's
inbound webhook URL at `https://65.20.91.127.sslip.io/eve/v1/<discord|slack|imessage>`
(see `apps/jace/README.md`'s "Channels" section for exact per-platform setup).

---

## Everyday operations

```bash
# Tail all logs
docker compose -f deploy/docker-compose.prod.yml logs -f

# Restart one service after an env change
docker compose -f deploy/docker-compose.prod.yml up -d --no-deps console

# Pull + rebuild after a code change
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build

# Re-apply migrations by hand (normally automatic on `up` — this is just an
# escape hatch, e.g. after pulling new migrations without cycling the stack)
docker compose -f deploy/docker-compose.prod.yml run --rm migrate

# Stop everything (data volumes persist)
docker compose -f deploy/docker-compose.prod.yml down
```

**Runner graceful shutdown caveat:** `agentrail runner`'s loop
(`agentrail/runner/worker.py`) has no `SIGTERM` handler — only `KeyboardInterrupt`
(`SIGINT`) is caught. `docker stop`/`docker compose down` send `SIGTERM`
first, so a runner mid-execution on an issue will be killed rather than
finishing gracefully. Prefer stopping the runner between claims (watch the
logs for an idle tick) if you can, or accept that an in-flight run may be
lost — it isn't durable/resumable state on the runner side either way (the
backend's atomic claim means a lost run just needs to be re-dispatched).

---

## Known risks / things this deploy could not verify without a real build

This was authored by reading source, not by running `docker build` (no Docker
in this environment) — validate these on the actual server:

1. **Console standalone build in this monorepo layout.** `output: "standalone"`
   + `outputFileTracingRoot` pointed at the repo root (see
   `apps/console/next.config.ts`) is the documented Next.js pattern for a pnpm
   monorepo, and the dependency-resolution facts behind it were verified
   (`@agentrail/db-postgres` resolves to `./dist`, needs a build step first;
   every other `@agentrail/*` package resolves to raw `./src` and is covered
   by `transpilePackages`). Never actually run — watch the `console` build
   step closely on first `up -d --build`.
2. **Jace binding/port.** Verified by reading the installed `eve@0.19.0`
   package's compiled CLI: `eve start` binds `0.0.0.0` by default (no
   `HOST`/`NITRO_HOST` fix needed), but its *port* default is 3000, not the
   documented 2000 — `PORT=2000` is set explicitly in both
   `apps/jace/Dockerfile` and `docker-compose.prod.yml` to match. Confirm the
   healthcheck (`GET /eve/v1/health` via the internal Node TCP probe) goes
   green.
3. **`agentrail` CLI install inside the Jace/runner images.** Same vendoring
   recipe as the existing, presumably-working `agentrail/docker/runner/Dockerfile`
   (copy `pyproject.toml` + `agentrail/`, `pip install .`, symlink the launcher
   script onto `PATH`) — but never actually built here. Watch for the
   `agentrail` package's two declared deps (`tree-sitter`,
   `tree-sitter-language-pack`) resolving cleanly on whatever Python/Debian
   base ends up in use.
4. **Runner agent/OpenRouter wiring (Claude Code) — the biggest unknown.**
   As of #1266, this runner drives `claude --bare -p` against OpenRouter's
   native Anthropic-Messages-compatible endpoint (superseding the earlier
   `aider` choice — see `deploy/runner/README.md`'s "Supersedes" section).
   The image builds and `claude --version`/`agentrail --help` run inside it,
   but whether `--bare` mode's auth resolution actually honors
   `ANTHROPIC_AUTH_TOKEN` against a non-Anthropic base URL is unverified — see
   `deploy/runner/README.md`'s "UNVERIFIED" section for the exact conflict
   found in Claude Code's own docs/help text, and the one-line fallback if
   the first real run's auth fails. Run `agentrail runner --once` (step 6)
   and read the logs before trusting an unattended loop.
5. **Runner execution-mode choice (host-native, no Docker socket).** This is
   the correct reading of `agentrail/sandbox/native_runner.py:select_sandbox_runner()`
   (Docker-sandbox mode triggers ONLY on `ANTHROPIC_API_KEY` being set), but
   the host-native path's isolation is genuinely weaker (the cloned repo and
   the agent CLI run directly inside the runner container, not in a disposable
   sibling container) — acceptable for a single-tenant dogfood box, revisit if
   this ever serves untrusted issues.
6. ~~`pipx` apt package name.~~ Resolved by #1266: the image no longer
   installs aider/pipx at all (superseded by Claude Code + OpenRouter, see
   `deploy/runner/README.md`). The image now builds on `node:22-slim` (Claude
   Code requires Node >=22) with `python3`/`python3-pip` added via apt for the
   `agentrail` CLI — both confirmed by an actual `docker build` in the
   environment that produced #1266's PR, not just by reading source.
