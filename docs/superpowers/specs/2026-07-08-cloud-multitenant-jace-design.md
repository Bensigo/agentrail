# Cloud deployment & multi-tenant Jace — design

**Date:** 2026-07-08
**Status:** Draft for review
**Owner:** bensigo

## 1. Problem

AgentRail's console, queue, and runner protocol are built, and Jace (the Eve-based
coordinator, `apps/jace/`) is built — but the system cannot serve multiple users or
multiple companies today:

1. **Jace is single-operator by design.** `apps/jace/docs/HOSTING.md` places the Eve
   sidecar on `127.0.0.1:2000`, co-located with one operator's install.
2. **One message blocks everything.** The inbound route
   (`apps/console/app/api/v1/connectors/jace/inbound/[workspaceId]/route.ts`) does a
   synchronous `fetch()` to the sidecar and holds the webhook request for the whole
   agent turn. Channel providers time out webhooks in seconds; concurrent users queue
   behind one another.
3. **No job layer.** Telegram, GitHub, and Jace inbound paths all run inline in HTTP
   handlers. Nothing absorbs bursts or parallelizes conversations.
4. **Security gaps block multi-company hosting.** The Jace inbound route has no
   authentication; the GitHub webhook uses one global secret and skips verification
   when unset; GitHub OAuth tokens (broad `repo` scope) sit plaintext in `accounts`;
   live secrets sit in a local plaintext `.env.local`.
5. **No deployment story.** The repo has zero hosting config (no Dockerfile for the
   console, no compose for prod, no CI deploy job).

**Goal:** a secure, multi-tenant cloud deployment where ~10 companies onboard,
teammates message Jace concurrently from Slack, Telegram, Discord, and iMessage, and
assign work that flows to each company's own self-hosted runner.

## 2. Decisions locked (brainstorm 2026-07-08)

| Decision | Choice |
|---|---|
| Tenancy | Multi-tenant day one: any company signs up, gets a workspace, invites teammates |
| Channels at launch | All four: Telegram, Slack, Discord, iMessage |
| Hosting | One VPS, Docker Compose (Hetzner-class, 8 vCPU / 16 GB) |
| Concurrency architecture | Async ingest + one shared multi-workspace Jace service (Approach A) |
| Code execution | Stays on each company's self-hosted runner (existing device-flow + Bearer model). The VPS never runs customer code |
| Scale-out posture | Single box + fast rebuildability (offsite backups, restore runbook). All state in Postgres so worker/jace can move to a second box later by pointing `DATABASE_URL` across a private network |

Why one VPS for 10 companies: the box only orchestrates — Jace turns are LLM API
calls and code execution is off-box. Anthropic rate limits bind before the hardware
does. HA (LB + Postgres failover) is not warranted at this stage; rebuildability is.

## 3. Topology

```
                        internet
                           │
                     ┌─────▼─────┐  only published ports (80/443)
                     │   caddy    │  auto-TLS
                     └─────┬─────┘
              edge network │
                     ┌─────▼─────┐
                     │  console   │  Next.js standalone
                     │            │  - dashboard (Auth.js GitHub OAuth)
                     │            │  - channel webhooks (per-workspace auth)
                     │            │  - GitHub webhook (per-workspace HMAC)
                     │            │  - runner claim/result API (Bearer)
                     │            │  - device-flow activation
                     └─────┬─────┘
          internal network │ (no published ports)
      ┌──────────┬─────────┼──────────┬──────────┐
 ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼───┐
 │ worker │ │  jace  │ │postgres│ │clickhse│ │ minio │
 │dispatch│ │  (Eve) │ │        │ │        │ │       │
 └────────┘ └────────┘ └────────┘ └────────┘ └───────┘

 outside the VPS:
 - self-hosted runners (per company) → HTTPS inbound to console (Bearer)
 - BlueBubbles Mac bridge(s) ←→ VPS via Tailscale (iMessage)
 - GitHub, Slack, Telegram, Discord → webhooks to console
```

**Containers**

- `caddy` — reverse proxy, TLS, the only public listener. Routes `console.<domain>`
  → console. Jace, Postgres, ClickHouse, MinIO are never routed.
- `console` — existing Next.js app, standalone output, new Dockerfile.
- `worker` — **new** app (`apps/worker`, Node, in the pnpm workspace): claims inbox
  rows, drives Eve sessions, posts channel replies, handles approval callbacks.
- `jace` — **new** Dockerfile around `apps/jace` (Node 24, exact pins, standalone
  `npm ci` per its workspace-excluded design). Listens only on the internal network;
  requires an `X-Internal-Auth` shared-secret header (defense in depth).
- `postgres` — two databases: `agentrail` (drizzle) and `eve_world`
  (`@workflow/world-postgres`). Separate DB keeps Eve's beta schema churn away from
  drizzle migrations.
- `clickhouse`, `minio` — as in dev compose, internal only.

## 4. Message flow & session model

### Ingest — `channel_inbox` (new table)

Webhook handlers become thin: **verify → insert → 200** (milliseconds).

```
channel_inbox(
  id, workspace_id, channel,            -- telegram|slack|discord|imessage
  conversation_key,                     -- thread identity (see below)
  kind,                                 -- message | approval_response
  sender_id, sender_display,            -- verified platform identity
  provider_message_id, payload jsonb,
  state,                                -- queued|processing|done|failed|dead
  attempts, next_attempt_at,
  created_at, updated_at
)
UNIQUE (channel, provider_message_id)   -- provider redeliveries are idempotent
```

If Postgres is down, webhooks return 5xx so providers redeliver (at-least-once);
the unique index absorbs the retries.

### Dispatch — the worker

A pool of N loops claims rows with `FOR UPDATE SKIP LOCKED` (same pattern as
`claimQueueEntry` in `packages/db-postgres/src/queries/runner.ts`), with two
fairness rules:

1. **Per-conversation serialization** — a conversation with an in-flight row is not
   claimable; messages within a thread stay ordered.
2. **Per-workspace in-flight cap** (default 3) — one company cannot starve others.

Claim/transition logic is a pure function (like `nextQueueTransition`) with unit
tests; the SQL mirrors it.

### Sessions — `jace_sessions` (new table)

```
jace_sessions(
  workspace_id, channel, conversation_key,  -- unique together
  eve_session_id, status,                   -- active|waiting|closed
  last_activity_at
)
```

Conversation key by channel: Slack `thread_ts` (or channel for top-level), Telegram
chat id (+ topic id), Discord channel/thread id, iMessage chat GUID. DMs key per
user. **Same thread = same Eve session** (shared context; every message carries
verified sender attribution). Different threads run fully parallel.

> Blocking scope shrinks from "all of Jace" to "one conversation thread" — this is
> the direct fix for "one user's message blocks everyone".

### Approvals (HITL) — parked, never blocking

1. Jace calls `create_issue` → Eve parks the session `waiting` with `inputRequests`
   (approve/deny option ids) — state lives in `eve_world` Postgres.
2. Worker posts approve/deny controls to the channel (Slack buttons, Telegram inline
   keyboard, Discord components, iMessage "reply approve/deny") and **releases its
   slot**.
3. The callback arrives as a new `channel_inbox` row (`kind=approval_response`); any
   worker resumes the session via `send({inputResponses})`.

A pending approval costs nothing and can wait hours. Approval controls carry the
Eve `requestId`; the resume path verifies the responder is a member of the
workspace bound to the session.

### Turn budget & failure

- Hard per-turn timeout (default 120 s): timeout → apologetic reply in-thread,
  session stays usable.
- Row retry with backoff (`attempts`, `next_attempt_at`); after 3 attempts →
  `dead`, surfaced in the console (dead-letter view).
- Worker crash mid-turn → stale-`processing` reclaim on a timer (same idea as
  `reconcileStaleRuns`).
- Eve container restart is safe: sessions persist in `eve_world`.

## 5. Security model

### Authentication per public surface

| Surface | Mechanism |
|---|---|
| Console web/API | Auth.js GitHub OAuth, DB sessions, `getWorkspaceMembership` per route (existing) |
| Telegram webhook | Per-workspace `X-Telegram-Bot-Api-Secret-Token`, `timingSafeEqual` (existing, #1031) |
| Slack events/interactivity | Signing-secret HMAC + timestamp window (new) |
| Discord interactions | Ed25519 signature verification (new) |
| iMessage bridge | Per-workspace shared secret over Tailscale (new) |
| GitHub webhook | **Fix:** per-workspace HMAC secret, mandatory (today: one optional global secret, verification skipped when unset) |
| Runner API | Bearer keys, sha256 at rest, device-flow issuance (existing) |
| Jace sidecar | Internal network only + `X-Internal-Auth` shared secret. **The public unauthenticated `connectors/jace/inbound` route is removed**, replaced by the inbox flow |

### Secrets

- **Pre-deploy rotation (required):** `AUTH_SECRET`, `CONNECTOR_SECRET_KEY`, GitHub
  OAuth client secret — all have lived in a local plaintext `.env.local`; treat as
  exposed. Prod values live in a root-only env file on the VPS (chmod 600) injected
  by compose; sops/age documented as the upgrade path.
- **Encrypt GitHub OAuth tokens at rest** (`accounts.access_token`/`refresh_token`):
  AES-256-GCM envelope via the existing `crypto.ts` (`enc:v1:`), plus a backfill
  migration. This is the most damaging plaintext in a DB leak (broad `repo` scope).
- Channel bot tokens/secrets continue into `connectors.secret` (encrypted,
  `hasSecret`-only reads — existing pattern). Telegram's inbound `webhookSecret`
  moves from plaintext `config` jsonb into the encrypted secret payload.
- Follow-up (separate arc): GitHub App migration for short-lived, narrow
  installation tokens.

### Tenant isolation

- `workspace_id` is **never read from model output or message text**. The webhook
  route binds it from the verified secret; the worker binds it to the Eve session;
  every Jace tool receives it server-side from that binding.
- Tool-level tenancy tests: workspace A can never read B (standup, memory,
  create_issue targets).
- Memory stays workspace-scoped with writer attribution (#1032/#1039, shipped).
- Per-workspace ingest rate limit (msgs/min) at the webhook layer, on top of
  per-writer limits at the queue entrances (below).

### Untrusted input & the write path

Channel text and memory are prompt-injection surfaces. Layered defenses:

1. Source-framing at prompt assembly (PRD1 read-side, `pipeline.py`).
2. `create_issue` keeps `approval: always()` — a UX gate, not the boundary.
3. **The real boundary is the two queue entrances** (`enqueueGithubIssue`,
   `admit_to_queue`): injection screening, content-hash dedup, per-writer rate
   limits — **PRD1 / #1022 becomes mandatory in this arc** (multi-company means
   untrusted writers are real, not hypothetical).

### VPS hardening

UFW (443/80 + key-only SSH), fail2ban, unattended-upgrades, non-root containers, no
`docker.sock` mounts, per-container memory limits, nightly `pg_dump` (+ MinIO sync)
shipped offsite (S3/B2), and a **tested** restore runbook (target: rebuilt on a
fresh VPS in under an hour).

## 6. Channels

All four land in the same inbox; each connector is a **verifier + a sender**.

- **Telegram** — extend the existing per-workspace webhook
  (`connectors/telegram/webhook/[workspaceId]`) to enqueue instead of returning
  canned `/status` replies. Bidirectional Jace per #1047; legacy
  `notify.ts`/`decideReply`/`GATEWAY_SENDERS` retire per-channel as each migrates.
- **Slack** (greenfield, #1050) — per-workspace Slack app install (OAuth v2); bot
  token encrypted in `connectors.secret`; Events API + interactivity endpoints;
  signing-secret verification; `thread_ts` conversation keying.
- **Discord** — constraint: free-form message receipt requires a persistent Gateway
  websocket (privileged message-content intent). **v1 = slash commands + button
  interactions** (pure HTTP, Ed25519-verified): `/jace ask …`, `/jace status`,
  approvals as buttons. Fast-follow: small gateway client in the worker for
  free-form chat.
- **iMessage** (new, no PRD yet) — per-workspace bridge config on the connector:
  - **Self-hosted Mac:** BlueBubbles server on the company's Mac, joined to the
    VPS tailnet; inbound webhooks → console with per-workspace secret; replies via
    BlueBubbles REST over the tailnet. Bensigo's own Mac serves our workspace day
    one.
  - **No Mac:** Sendblue (paid relay) — same connector shape, hosted endpoint.
  - Sender allowlist (phone numbers / handles → workspace) is part of connector
    config; unknown senders are dropped at the webhook.

**Outbound notifications** (run outcomes) migrate from legacy `notify.ts` to
Jace-authored channel sends as each channel migrates (#1047/#1050): terminal-only,
exactly-once per outcome, announced in the originating thread where known.

## 7. Task assignment path (end to end)

1. Teammate in any channel: "Jace, build X" → thread session; ideation skills
   (grill-me / to-prd / to-issues) draft freely.
2. `create_issue` → approval buttons in-thread → a workspace member approves.
3. Jace publishes the **house-format** GitHub issue + trigger label via a **new
   authenticated console endpoint** (internal service token + session-bound
   workspace), using the workspace's stored GitHub credentials.
   - This **replaces** the current `execFile("agentrail issue create")` shell-out
     in `apps/jace/agent/tools/create_issue.ts`, which assumes a single operator
     laptop with a configured CLI.
4. GitHub webhook (per-workspace HMAC) → `enqueueGithubIssue` (PRD1 screens) →
   `queue_entries`.
5. **That company's self-hosted runner** claims it (existing Bearer +
   `SKIP LOCKED` claim), executes in its sandbox, ships the PR through the verify
   gate.
6. Terminal outcome → Jace announces in the originating thread.

The single-write-path invariant holds: issues still enter the queue only through
the GitHub-webhook entrance; Jace gets no direct queue write
(`no-second-write-path` test extends to the new endpoint).

## 8. Known limitation — `codebase_query` in the cloud

Jace's `codebase_query` tool reads the **local** context index — which, in the
cloud, doesn't exist: each company's code and index live with *their runner*.
**v1:** the tool detects no index for the workspace and answers gracefully that
codebase Q&A isn't available in cloud yet (standup, ideation, and issue creation
are unaffected). **Follow-up (own issue):** route codebase queries to the
workspace's runner as a new pull-work kind, reusing the existing claim protocol.

## 9. Deployment & ops

- `deploy/compose.prod.yml` + `deploy/Caddyfile` in-repo; three new Dockerfiles
  (console standalone, worker, jace).
- CI/CD: GitHub Actions on `main` → build images → GHCR → SSH deploy step
  (`docker compose pull && up -d`). Post-deploy smoke: health endpoints + one
  canary message through the full Telegram loop on a staging workspace.
- Healthchecks per container; log rotation via Docker logging opts; external
  uptime ping (e.g. healthchecks.io).
- ClickHouse + MinIO stay for evals/analytics as today.
- Feature flags default-OFF for rollout safety only (per house rule — no gated
  build phases; all workstreams are built unconditionally).

## 10. Testing

- **Unit:** per-channel signature verifiers (valid/invalid/expired fixtures);
  dispatcher claim + serialization as pure transition functions; session keying;
  approval-responder membership check.
- **Integration:** webhook → inbox → worker → stubbed Eve → reply capture;
  approval round-trip against **real Eve + Postgres** in CI (extends
  `apps/jace/scripts/needs-approval-roundtrip.mjs`); notify exactly-once on
  terminal transitions.
- **Tenancy:** tool-level tests that workspace A cannot read/write B.
- **Security:** unsigned/missing-secret webhooks → 401; Jace sidecar refuses
  missing `X-Internal-Auth`; rate limits trip; `no-second-write-path` extended.
- **Console UI:** browser-verified per house rule (CI skips console tests).

## 11. Workstreams

Independent where not noted; flags default-OFF for rollout only.

| # | Workstream | Depends on |
|---|---|---|
| W1 | Security fixes: rotate secrets; encrypt OAuth tokens; per-workspace mandatory GitHub webhook HMAC; remove unauthenticated Jace inbound route | — |
| W2 | `channel_inbox` + `jace_sessions` schema + worker app (claim, serialize, dispatch, retry/dead-letter) | — |
| W3 | Jace containerization + internal auth + `eve_world` DB + console→worker→jace wiring | W2 |
| W4 | `create_issue` → console endpoint (replace CLI shell-out); single-write-path test extension | W3 |
| W5 | Telegram migration to inbox + bidirectional Jace + legacy retirement (#1047) | W2, W3 |
| W6 | Slack connector (install flow, events, interactivity) (#1050) | W2, W3 |
| W7 | Discord slash-commands connector (#1050) | W2, W3 |
| W8 | iMessage connector (BlueBubbles + Tailscale + allowlist; Sendblue variant) | W2, W3 |
| W9 | PRD1 queue-entrance guardrails (#1022): screening, dedup, per-writer rate limits | — |
| W10 | Deploy: Dockerfiles, compose.prod, Caddy, CI→GHCR→SSH, backups + restore runbook, hardening | — |
| W11 | Approval controls per channel + responder membership verification | W5–W8 (per channel) |

Testing phase (Section 10) runs after build work per house rule; W1 and W10's
rotation/hardening land **before** any public traffic.

## 12. Out of scope / follow-ups

- GitHub App migration (short-lived installation tokens).
- Per-workspace Jace sidecars (Approach B) as a later paid-tier hardening step —
  the dispatcher already routes by workspace, so sharding is config, not redesign.
- Discord free-form chat via gateway client.
- `codebase_query` via runner round-trip (Section 8).
- HA / second VPS (triggers: contractual HA, sustained CPU >70%, ClickHouse growth).
- Billing/plans for the 10 onboarded companies.
