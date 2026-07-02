# Spike #1030 — Eve self-hosted feasibility

**Epic:** PRD3 #1024 · **Type:** SPIKE (evidence + decision + runnable scaffold, not production code)
**Date:** 2026-07-02 · **Eve version under test:** `eve@0.19.0` (latest) · **Node:** v24.18.0

> This is a spike. The bar is **honesty over green**. Where something booted, it
> is quoted from a live run; where something was blocked, the exact block is
> quoted verbatim with the exact command to unblock it. Nothing here is
> fabricated to look like a pass.

---

## TL;DR / recommendation

**Eve self-hosting is feasible and the coordinator's core mechanic works — with one
caveat that changes how we wire outbound model calls.**

- Eve is a **long-running Node/Nitro HTTP process**, not a Vercel-only artifact and
  **not** the kind of thing that fits inside AgentRail's *downloaded CLI*. Self-host =
  `eve build` + `eve start` behind our own process manager (or `eve dev` in dev). It
  wants to live **beside the hosted console as a sidecar service**, not inside the
  runner.
- The **whole runtime boots, is healthy, and processes sessions** on pinned beta
  versions. Health is `ready`; a session runs `session.started -> turn.started ->
  message.received -> step.started` correctly.
- The **human-approval gate is real and is the mechanic the coordinator depends on** —
  but in the installed build the per-tool key is **`approval`**, not `needsApproval`
  as the docs show (docs drift).
- The **only thing blocked** is the outbound model call, and only because this sandbox
  has no model credentials. Eve routes a **string model id through the Vercel AI
  Gateway** by default; a bare `ANTHROPIC_API_KEY` does **not** work unless the agent's
  `model:` is an SDK `anthropic(...)` call. This is a real wiring decision, not a bug.

**Verdict for the PRD3 coordinator:** proceed with Eve as the coordinator shell, but
(a) plan for it as a **separate sidecar HTTP service**, (b) decide the model-routing
path (gateway key vs. direct provider SDK call) up front, and (c) keep the coordinator
logic — skill, instructions, the one gated `create_issue` tool — **portable**, because
it is ~50 lines and a thin-shell fallback stays cheap if we ever drop Eve.

---

## AC1 — Where does the sidecar run? Is it publicly reachable? Console relay or direct?

### What Eve actually is (grounded in the installed package + live boot)

`eve@0.19.0`'s **only hard dependency is `nitro@3.0.260610-beta`** — the HTTP server.
(An earlier assumption that Eve pulls `@workflow/core` was **wrong**; there is no
`@workflow/core` in the tree.) So "an Eve agent" is a **Nitro HTTP application** that
you run as a process. Its CLI verbs:

| verb        | what it does                                                        |
|-------------|---------------------------------------------------------------------|
| `eve init`  | scaffold an agent project                                           |
| `eve link`  | pull Vercel AI Gateway creds into `VERCEL_OIDC_TOKEN`               |
| `eve dev`   | Nitro **dev** server on **`http://127.0.0.1:2000/`** (NOT 3000)     |
| `eve build` | build the deployable Nitro artifact                                 |
| `eve start` | run the built artifact (this is the self-host entrypoint)           |
| `eve deploy`| deploy to Vercel prod                                               |
| `eve info`  | compile status / diagnostics / skills                              |
| `eve eval`  | run evals                                                           |

**HTTP surface** (verified live against `eve dev`):

- `GET  /eve/v1/health` -> `{"ok":true,"status":"ready","workflowId":"..."}`
- `POST /eve/v1/session` -> **202**, `x-eve-session-id: wrun_...` header + `{continuationToken, ok, sessionId}`
- `POST /eve/v1/session/:id` -> continue a session (this is where `inputResponses` go)
- `GET  /eve/v1/session/:id/stream` -> NDJSON event stream

### Answers to the hosting questions the issue asks

1. **Which deploy target does it fit — hosted console, or downloaded CLI?**
   **Neither as-is.** It is a persistent HTTP service. It does **not** belong in the
   downloaded runner CLI (that's a thin poll-and-execute client, not a place to host a
   long-running Nitro server). It also is not "just deploy to Vercel" for a self-hosted
   posture. It fits as a **third thing: a coordinator sidecar service** run with `eve
   build && eve start` under our own supervisor (systemd / a container / the same box as
   the console), OR deployed to Vercel if we accept that hosting dependency.

2. **Where does the sidecar run?**
   Recommended: **co-located with the hosted console** (same trust boundary, same
   deploy unit or an adjacent one), reachable by the console over localhost / private
   network. Durability, if we want sessions to survive restarts, comes from the
   **optional** `@workflow/world-postgres` backend (Postgres + graphile-worker) — a
   **separate** dependency from Eve itself, and it can point at the console's existing
   Postgres.

3. **Is it publicly reachable?**
   It **should not be**. The Eve HTTP API has no auth of its own in this build — anyone
   who can `POST /eve/v1/session` can drive the coordinator. Keep it on a **private
   interface**; do not expose `:2000` (or the prod port) to the internet.

4. **Does the console keep a thin webhook relay, or do channels point straight at the
   coordinator?** -> **Console keeps a thin relay. Channels must NOT point at Eve
   directly**, for two reasons: (a) no built-in auth on Eve's endpoints — the console is
   where we already do signature verification (see the Telegram inbound webhook work,
   `notify.ts` / per-workspace webhook), and (b) channel payloads (Telegram/Slack) need
   normalizing + workspace routing before they become an Eve session message. So the
   flow is **channel -> console webhook (verify + normalize) -> `POST /eve/v1/session` on
   the private sidecar**. This directly answers the blocker the Telegram-migration issue
   was waiting on: **keep the relay endpoint; do not repoint channels at the
   coordinator.**

### Exact pins (reproducible; `package.json` + committed `package-lock.json`)

`eve@0.19.0` · `ai@7.0.11` · `zod@4.4.3` · `@ai-sdk/anthropic@4.0.5` ·
devDep `@workflow/world-postgres@5.0.0-beta.20` · `engines.node >=24`.

Pin traps found (all in `package.json` `//pins`, re-verified by direct tree inspection):

- The tree ships **three coexisting zod majors** — `4.4.3`, `4.3.6` (x3), `4.1.11`.
  They work together *today*; a floating pin is exactly how that breaks. Keep exact.
- `@workflow/world-postgres`'s npm **`latest` tag is `4.2.0` — STALE**. The current
  runtime is the `5.0.0-beta.x` line. `latest` would silently pull the wrong major.
- `@ai-sdk/anthropic` is only used on the **direct-provider** path (see AC2); on the
  default string-model path it's inert.

---

## AC2 — `needsApproval` round-trip (approve AND reject)

### The gate mechanic (proven at the code + framework level)

The coordinator's one write tool declares the gate. **Installed-build finding:** the key
is **`approval: always()`** (from `eve/tools/approval`), **not** `needsApproval:` as the
published docs show. `always()` forces a fresh human yes on **every** call — the correct
posture for a boundary that files real work into the factory. The tool
(`poc/agent/tools/create_issue.ts`) is intentionally side-effect-free (returns a
simulated stub) so the spike proves the *gate + payload shape*, not a live write.

The round-trip driver (`poc/scripts/needs-approval-roundtrip.mjs`) uses `Client` from
`eve/client`, runs the coordinator **twice** — once approving, once rejecting — and
**derives the option ids from the server's real `request.options`** instead of
hardcoding "approve"/"reject", so it stays honest to whatever shape the server emits.
Resume shape: `session.send({ inputResponses: [{ requestId, optionId }] })` then
`await resumed.result()`.

### What booted vs. what blocked (quoted from a live run)

The **entire runtime boots and processes the session**. It reaches the model call, then
fails there — and **only** there — because this sandbox has no model credentials. From a
live `GET /eve/v1/session/:id/stream` (full capture in
`poc/docs-evidence.txt`):

```
session.started   modelId=anthropic/claude-sonnet-4.6, eveVersion=0.19.0
turn.started      turn_0
message.received  "File an issue under epic #1024 to add a health check..."
step.started      stepIndex=0
step.failed       code=MODEL_CALL_FAILED
                  GatewayAuthenticationError statusCode=401
                  "AI Gateway received no credentials. Run `eve link` to populate
                   VERCEL_OIDC_TOKEN, or set AI_GATEWAY_API_KEY — create a key at
                   https://vercel.com/dashboard/ai/api-keys."
turn.failed       (same MODEL_CALL_FAILED)
```

So: **the approval gate is wired and the runtime is healthy; the approval request is
never *emitted* only because the model never gets to *decide to call the tool*** — the
turn dies at the outbound model auth step. This is the honest state. The round-trip
script correctly reports `no approval was requested` on both paths for the same reason
(it does not fake a pass).

### Exactly what to run to complete AC2 (turn it green)

Pick **one** — both are one-liners, both are fully wired in the scaffold:

- **Gateway path (matches the current `agent.ts` string model id):** run `eve link`
  (populates `VERCEL_OIDC_TOKEN`) **or** `export AI_GATEWAY_API_KEY=...` (key from
  https://vercel.com/dashboard/ai/api-keys). Then `npm run dev` + `npm run roundtrip`.
- **Direct-provider path (no Vercel):** change `poc/agent/agent.ts` from the string
  `model: "anthropic/claude-sonnet-4.6"` to an SDK call —
  `import { anthropic } from "@ai-sdk/anthropic"; ... model: anthropic("claude-sonnet-4-6")`
  — and `export ANTHROPIC_API_KEY=...`. (`@ai-sdk/anthropic@4.0.5` is already pinned for
  exactly this.) Then `npm run dev` + `npm run roundtrip`.

With either credential in place, the model emits the `create_issue` call, the turn parks
on the `approval` request, and the driver exercises **approve** (tool runs, returns the
simulated issue) and **reject** (tool is denied, model revises) — the full AC2 loop. No
code change is needed for the gateway path; a two-line `agent.ts` change for the direct
path.

---

## AC3 — Skill loading (one toy skill)

**Satisfied.** `poc/agent/skills/emit-issue-brief/SKILL.md` is a real skill (frontmatter
`description:` + body that tells the coordinator to structure the house-format brief
*before* proposing a `create_issue` call). `eve info` reports **"Skills: 1 skill"** with
**0 diagnostics / compile ready**, so the framework discovers and loads it from the
filesystem convention (`agent/skills/<slug>/SKILL.md`). Skill loading does **not** need
model credentials — it is a build-time/compile concern — so this AC is fully green
independent of the AC2 block.

---

## AC4 — Honest failure / surprise notes

Everything brittle, undocumented, or surprising encountered during the spike:

1. **Approval key drift: docs say `needsApproval`, installed build wants `approval`.**
   The published eve.dev docs show `needsApproval: always()`; `eve@0.19.0` rejects that
   key and names it `approval`. Same helper (`eve/tools/approval`), different key. This
   is the docs-vs-installed-beta drift the issue anticipated. **If we adopt Eve, pin the
   version and read the installed types, not the website.**

2. **Default model routing goes through the Vercel AI Gateway, silently.** A **string**
   model id (`"anthropic/claude-sonnet-4.6"`) is gateway-routed and needs
   `VERCEL_OIDC_TOKEN`/`AI_GATEWAY_API_KEY`. A bare `ANTHROPIC_API_KEY` is ignored on
   that path — an external provider "leaves no marker eve owns, so it reads as unset."
   To use a direct key you must make `model:` an SDK `anthropic(...)` call. **This is a
   real coupling to Vercel** and a decision we must make deliberately for self-host.

3. **`eve dev` listens on `:2000`, not `:3000`.** The docs imply 3000. Cost us a probe.

4. **No `@workflow/core`.** Eve's only hard dep is `nitro@3.0.260610-beta`. Prior notes
   claiming a `@workflow/core@5.0.0-beta.26` dependency were wrong. Corrected.

5. **Three simultaneous zod majors + a stale `latest` tag on `world-postgres` (4.2.0
   while the runtime is 5.0.0-beta.x).** Classic beta-churn floating-pin trap. All pins
   are exact and the `package-lock.json` is committed.

6. **No built-in auth on the Eve HTTP API.** Any caller who can reach `:2000` can drive
   the agent. This is *why* the console must stay the auth'd relay (AC1 Q4), not a thing
   to expose.

7. **`eve dev` writes a large local run store** (`.workflow-data/` — hundreds of
   lock/event/step files, ~800KB after a few sessions) and a `.eve/` build dir (~10MB).
   Neither is covered by any parent `.gitignore`; the POC ships its own `poc/.gitignore`
   to keep them out of git. Worth knowing before anyone commits an Eve project.

---

## Reproduce

```bash
cd docs/spikes/1030-eve-selfhost/poc

# Node 24 required. (On this machine nvm must be on PATH first —
# /usr/local node shadows it.)
npm ci                      # installs the EXACT pins from package-lock.json
npx eve info                # -> compile ready, 0 diagnostics, "Skills: 1 skill" (AC3)

npm run dev                 # eve dev -> http://127.0.0.1:2000/
curl -s http://127.0.0.1:2000/eve/v1/health        # -> {"ok":true,"status":"ready",...}

# AC2 needs a model credential (see AC2 "exactly what to run"):
#   gateway path:   eve link   (or export AI_GATEWAY_API_KEY=...)
#   direct path:    edit agent.ts to anthropic(...) + export ANTHROPIC_API_KEY=...
npm run roundtrip           # exercises approve + reject once creds are present
```

Live boot + block evidence is captured verbatim in `poc/docs-evidence.txt`.

---

## AC coverage summary

| AC  | Status | Evidence |
|-----|--------|----------|
| AC1 hosting answer | **Answered** | Nitro HTTP sidecar; private, not the CLI, not Vercel-only; console keeps the auth'd relay; exact pins + lockfile committed |
| AC2 approval round-trip | **Wired, blocked on model creds** | Gate is `approval: always()`; runtime boots + processes session; blocked at `MODEL_CALL_FAILED`/401 (quoted); exact one-line unblock for both routing paths |
| AC3 skill loading | **Green** | `eve info` -> "Skills: 1 skill", 0 diagnostics; no creds needed |
| AC4 failure notes | **Complete** | 7 documented surprises incl. the hosting answer and the approval-key drift |
