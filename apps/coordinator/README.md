# Coordinator (Eve sidecar)

The **coordinator** turns a channel message ("file an issue to add a health
check…") into a **house-format issue** in the factory, gated behind a human
approval. It is built on **[Eve](https://eve.dev)** — the chosen framework for
PRD3 [#1024](https://github.com/bensigo/ai-workflow/issues/1024); this app is
where that lives in the monorepo.

This directory is the **scaffold**: the agent, its one write tool
(`create_issue`, human-approved), one skill, and a driver that exercises the
approval round-trip. Everything boots and processes a session today; the only
thing that needs a credential you must supply is the outbound model call (see
[Running it locally](#running-it-locally)).

Eve is a **long-running Node/Nitro HTTP process**, so the coordinator is a
**sidecar service** (`eve build` + `eve start`), deployed *beside* the hosted
console — not inside the downloaded runner CLI, and not a Vercel-only artifact.
It is **excluded from the pnpm/npm workspace** on purpose: it carries beta Eve
pins (three coexisting zod majors, `node>=24`) that must not mix into the
monorepo's dependency resolution, so it installs in isolation with its own
`package-lock.json` via `npm ci`.

> Evidence quoted below is from a live run captured verbatim in
> [`EVIDENCE.txt`](./EVIDENCE.txt) against `eve@0.19.0` / Node v24.18.0. Where a
> step was blocked, the exact block and the exact command to clear it are quoted
> — nothing is dressed up as a pass.

## What's here

| Path | What it is |
|------|------------|
| `agent/agent.ts` | The coordinator agent — model + tools + instructions wiring |
| `agent/instructions.md` | System instructions (house-format issue behaviour) |
| `agent/tools/create_issue.ts` | The one **write** tool, gated by `approval: always()` (side-effect-free stub for now — proves the gate + payload shape) |
| `agent/skills/emit-issue-brief/SKILL.md` | A skill that structures the brief before proposing a `create_issue` call |
| `scripts/needs-approval-roundtrip.mjs` | Driver that runs the agent twice — approve and reject — deriving option ids from the server's real `request.options` |
| `EVIDENCE.txt` | Verbatim live-boot + session-stream capture |
| `package.json` / `package-lock.json` | Exact pins (see [Pinned versions](#pinned-versions--why)) |

## How it's hosted (topology)

`eve@0.19.0`'s **only hard dependency is `nitro@3.0.260610-beta`** — the HTTP
server. So "an Eve agent" is a **Nitro HTTP application** you run as a process.
Relevant CLI verbs:

| verb | what it does |
|------|--------------|
| `eve dev` | Nitro **dev** server on **`http://127.0.0.1:2000/`** (not 3000) |
| `eve build` | build the deployable Nitro artifact |
| `eve start` | run the built artifact — the **self-host entrypoint** |
| `eve link` | pull Vercel AI Gateway creds into `VERCEL_OIDC_TOKEN` |
| `eve info` | compile status / diagnostics / skills |

**HTTP surface** (verified live against `eve dev`):

- `GET  /eve/v1/health` → `{"ok":true,"status":"ready","workflowId":"..."}`
- `POST /eve/v1/session` → **202**, `x-eve-session-id: wrun_...` + `{continuationToken, ok, sessionId}`
- `POST /eve/v1/session/:id` → continue a session (`inputResponses` go here)
- `GET  /eve/v1/session/:id/stream` → NDJSON event stream

**Where it runs, and how channels reach it:**

- **Co-located with the hosted console** (same trust boundary, adjacent deploy
  unit), reachable over localhost / private network. Optional session durability
  comes from the **separate** `@workflow/world-postgres` backend (Postgres +
  graphile-worker), which can point at the console's existing Postgres.
- **Not publicly reachable.** The Eve HTTP API has **no auth of its own** — any
  caller who can `POST /eve/v1/session` can drive the coordinator. Keep `:2000`
  (and the prod port) on a private interface.
- **The console keeps a thin relay; channels must NOT point at Eve directly.**
  Reasons: (a) no built-in auth on Eve's endpoints — the console is where
  signature verification already lives (Telegram inbound webhook / `notify.ts`),
  and (b) channel payloads (Telegram/Slack) need normalizing + workspace routing
  before they become an Eve session message. So the flow is:
  **channel → console webhook (verify + normalize) → `POST /eve/v1/session` on
  the private sidecar.** (This is the answer the Telegram-migration work was
  waiting on: keep the relay endpoint; don't repoint channels at the coordinator.)

## The approval gate

The coordinator's one write tool declares the gate. In the installed build the
per-tool key is **`approval: always()`** (from `eve/tools/approval`) — **not**
`needsApproval:` as the published docs show (docs drift; see
[Integration notes](#integration-notes)). `always()` forces a fresh human yes on
**every** call — the right posture for a boundary that files real work into the
factory. `agent/tools/create_issue.ts` is intentionally side-effect-free (returns
a simulated stub) so the scaffold proves the *gate + payload shape*, not a live
write.

The driver (`scripts/needs-approval-roundtrip.mjs`) uses `Client` from
`eve/client`, runs the coordinator **twice** — approving once, rejecting once —
and **derives the option ids from the server's real `request.options`** instead
of hardcoding "approve"/"reject". Resume shape:
`session.send({ inputResponses: [{ requestId, optionId }] })` then
`await resumed.result()`.

**Current state (honest):** the whole runtime boots and processes the session; it
reaches the model call and fails **only there**, because the environment that
generated this scaffold had no model credentials. From a live stream (full
capture in [`EVIDENCE.txt`](./EVIDENCE.txt)):

```
session.started   modelId=anthropic/claude-sonnet-4.6, eveVersion=0.19.0
turn.started      turn_0
message.received  "File an issue under epic #1024 to add a health check..."
step.started      stepIndex=0
step.failed       code=MODEL_CALL_FAILED
                  GatewayAuthenticationError statusCode=401
                  "AI Gateway received no credentials. Run `eve link` to populate
                   VERCEL_OIDC_TOKEN, or set AI_GATEWAY_API_KEY."
turn.failed       (same MODEL_CALL_FAILED)
```

The approval request is never *emitted* only because the model never gets to
*decide to call the tool* — the turn dies at the outbound model-auth step, not in
the gate. Supply a model credential (below) and the model emits the
`create_issue` call, the turn parks on the `approval` request, and the driver
exercises **approve** (tool runs) and **reject** (tool denied, model revises).

## Skills

`agent/skills/emit-issue-brief/SKILL.md` is a real skill (frontmatter
`description:` + a body that tells the coordinator to structure the house-format
brief *before* proposing a `create_issue` call). `eve info` reports
**"Skills: 1 skill"** with **0 diagnostics / compile ready** — the framework
discovers and loads it from the filesystem convention
(`agent/skills/<slug>/SKILL.md`). Skill loading is a build-time concern and needs
no model credentials.

## Integration notes

Everything brittle, undocumented, or surprising found while wiring this up —
worth knowing before extending it:

1. **Approval key drift: docs say `needsApproval`, installed build wants
   `approval`.** Published eve.dev docs show `needsApproval: always()`;
   `eve@0.19.0` rejects that key and names it `approval` (same helper,
   `eve/tools/approval`). **Pin the version and read the installed types, not the
   website.**
2. **Default model routing goes through the Vercel AI Gateway, silently.** A
   **string** model id (`"anthropic/claude-sonnet-4.6"`) is gateway-routed and
   needs `VERCEL_OIDC_TOKEN`/`AI_GATEWAY_API_KEY`; a bare `ANTHROPIC_API_KEY` is
   ignored on that path. To use a direct key, make `model:` an SDK
   `anthropic(...)` call. This is a real coupling to Vercel — decide the routing
   path deliberately for self-host.
3. **`eve dev` listens on `:2000`, not `:3000`.** The docs imply 3000.
4. **No `@workflow/core`.** Eve's only hard dep is `nitro@3.0.260610-beta`.
5. **Three simultaneous zod majors** (`4.4.3`, `4.3.6` ×3, `4.1.11`) **+ a stale
   `latest` tag on `world-postgres`** (`4.2.0` while the runtime is
   `5.0.0-beta.x`). Classic beta-churn floating-pin trap — all pins are exact and
   `package-lock.json` is committed.
6. **No built-in auth on the Eve HTTP API.** Any caller who can reach `:2000` can
   drive the agent — this is *why* the console stays the auth'd relay.
7. **`eve dev` writes a large local run store** (`.workflow-data/` — hundreds of
   lock/event/step files) and a `.eve/` build dir (~10MB). Neither is covered by
   a parent `.gitignore`; this app ships its own `.gitignore` to keep them out of
   git.

## Running it locally

```bash
cd apps/coordinator

# Node 24 required. (If nvm is shadowed by a /usr/local node, put nvm on PATH first.)
npm ci                      # installs the EXACT pins from package-lock.json
npx eve info                # -> compile ready, 0 diagnostics, "Skills: 1 skill"

npm run dev                 # eve dev -> http://127.0.0.1:2000/
curl -s http://127.0.0.1:2000/eve/v1/health        # -> {"ok":true,"status":"ready",...}

# The outbound model call needs one credential — pick either path:
#   gateway path (matches agent.ts's string model id):
#     eve link            # or: export AI_GATEWAY_API_KEY=...
#   direct-provider path (no Vercel):
#     edit agent/agent.ts  model: anthropic("claude-sonnet-4-6")  (import from @ai-sdk/anthropic)
#     export ANTHROPIC_API_KEY=...
npm run roundtrip           # exercises approve + reject once a credential is present
```

## Pinned versions & why

`eve@0.19.0` · `ai@7.0.11` · `zod@4.4.3` · `@ai-sdk/anthropic@4.0.5` · devDep
`@workflow/world-postgres@5.0.0-beta.20` · `engines.node >=24`. Eve is beta
(~41 releases in two weeks) — everything is pinned **exactly** and the
`package-lock.json` is committed. See the `//pins` block in
[`package.json`](./package.json) for the per-dependency rationale.
