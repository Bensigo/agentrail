# Hosted fleet — Railway service (issue #1267 PR②)

Day-2 operations (kill switches, scaling, restart, log triage, incident playbooks) live in [RUNBOOK.md](./RUNBOOK.md) — this file is setup only.

`agentrail fleet` (`agentrail/cli/commands/fleet.py`) is one long-running
process that serves **every** hosted-eligible workspace at once: it syncs its
own set of per-workspace tokens from the console (no human ever clicks
through `/activate` for a fleet-served workspace — see #1267 PR①'s
`POST /api/v1/fleet/workspace-tokens/sync`), then round-robins claims across
all of them. This directory is that service's Railway definition.

Builds from the SAME image as the single-tenant self-hosted runner
(`deploy/runner/Dockerfile` — see that directory's own README for the full
env contract baked into the image: Claude Code via OpenRouter, `AGENTRAIL_HOSTED=1`,
the hosted default-config template). The only difference is the **command**
that image runs: `agentrail runner` (one workspace, from `agentrail login`)
vs. `agentrail fleet` (every hosted-eligible workspace, from
`FLEET_CONSOLE_TOKEN`) — same container, different daemon.

## What's in `railway.json` (config-as-code) vs. what's dashboard-only

[`railway.json`](./railway.json) covers everything Railway's schema
(`https://railway.com/railway.schema.json`, verified against the schema
itself and `railwayapp/docs` before writing this — field names below are not
guesses) can express for this service:

```json
{
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "deploy/runner/Dockerfile" },
  "deploy": { "startCommand": "agentrail fleet", "restartPolicyType": "ALWAYS" }
}
```

- `build.dockerfilePath` is relative to the service's **Root Directory**
  (a dashboard/service-setting field, not part of this schema at all —
  Railway's own monorepo docs are explicit that "the Railway Config File
  does not follow the root directory path automatically"). Leave Root
  Directory unset (defaults to the repo root) so the Dockerfile's build
  context matches every other Dockerfile in this repo
  (`docker build -f deploy/runner/Dockerfile -t ... .`, run from repo root) —
  changing Root Directory here would silently break that context.
- `deploy.restartPolicyType: "ALWAYS"` — a claim/execute crash restarts the
  daemon rather than leaving the fleet dark. (The schema's enum is
  `ON_FAILURE` / `ALWAYS` / `NEVER`, confirmed against both the JSON Schema
  file itself and Railway's GraphQL API docs — some prose examples in
  Railway's docs show a lowercase `"never"`; the schema's own declared enum
  is uppercase, so that's what's used here.)
- **Run this service at exactly 1 replica.** The schema HAS a
  `deploy.numReplicas` field (Railway allows up to 200) and nothing
  platform-side will warn you — but the per-workspace token store
  (`fleet-credentials.json` on the volume) is last-writer-wins with no
  cross-replica coordination: two replicas syncing the same console race
  each other's mints, and whichever wrote the file last wins while the
  other's freshly minted (hash-only, unrecoverable) tokens are silently
  lost. `numReplicas` is deliberately omitted from `railway.json` so it
  stays at Railway's default of 1; do not raise it in the dashboard either.
  Scale a busy fleet UP via `FLEET_CONCURRENCY` (more concurrent claims in
  the one process), not OUT via replicas.
- **Not expressible in this schema, confirmed absent from
  `railway.schema.json`'s properties list**: volumes, and any environment
  variable. Both are dashboard-only (or `railway variables set` via the
  CLI) — see the manual steps below. Guessing field names for either would
  have been silently ignored at best; this file only contains fields the
  schema actually declares.

## Dashboard steps (cannot be config-as-code)

1. **Create the service** from this GitHub repo (same repo the console/jace
   services already deploy from).
2. **Point the service at this config file** — Service Settings → the
   custom Config File Path field → `/deploy/fleet/railway.json` (Railway
   resolves this as an absolute path *within the repo*, independent of Root
   Directory — leave Root Directory itself unset, per above).
3. **Attach a Volume**, mount path `/root/.agentrail`. This is where
   `fleet-credentials.json` (the per-workspace token store,
   `AGENTRAIL_FLEET_HOME`'s default) lives — the image runs as root with no
   `HOME` override, so `Path.home()` resolves to `/root` (same convention
   `deploy/docker-compose.prod.yml`'s single-tenant `runner` service already
   uses for its own `credentials.json` at the same path). Without this
   volume, every restart forgets every workspace's token and re-syncs from
   scratch — not fatal (the next boot sync re-mints/re-fetches everything
   whether hosted_execution says it should have one), but needlessly slow
   and noisy.
4. **Set environment variables**:

   | Var | Required | Notes |
   |---|---|---|
   | `FLEET_CONSOLE_TOKEN` | **Yes** | The shared secret the sync route checks (`FLEET_TOKEN_ENV` in `apps/console/app/api/v1/fleet/workspace-tokens/sync/route.ts`) — set the SAME value in the console service's own env. Never logged by either side. |
   | `AGENTRAIL_SERVER_BASE_URL` | **Yes** | The console's public base URL. |
   | `OPENROUTER_API_KEY` | **Yes** | The coding agent's OpenRouter credential — same var `deploy/runner/README.md` documents for the single-tenant runner; `entrypoint.sh` maps it to `ANTHROPIC_AUTH_TOKEN` at container start, never baked, never logged. |
   | `GITHUB_TOKEN` (or `GITHUB_OAUTH_TOKEN`) | No | Optional shared fallback identity for `gh`/`git`. Each REAL claimed run already carries its own per-workspace GitHub OAuth token from the claim payload (`item.github_token`), embedded straight into the authenticated clone/push URL and `GH_TOKEN` — this shared var is only ever used for a workspace that hasn't connected GitHub on the console. If every hosted-eligible workspace has GitHub connected, it's fine to leave this unset (the entrypoint's boot-time warning about it is then harmless noise, not a real gap). If you DO set it, remember its blast radius: one shared PAT usable as a fallback across every workspace lacking its own connection. |
   | `AGENTRAIL_FLEET_HOME` | No | Default `~/.agentrail` (= `/root/.agentrail`, see step 3). Only set this if you're mounting the volume somewhere else. |
   | `FLEET_CONCURRENCY` | No | Default `2` — claims executing at once across the WHOLE fleet, not per workspace. This is the knob for scaling a busy fleet (never replicas — see the 1-replica constraint above). |
   | `FLEET_SYNC_INTERVAL_SECONDS` | No | Default `300`, floor `30` — how often the fleet re-syncs its token set after the initial boot sync. Values below 30 are clamped (with a warning): a tiny interval would busy-loop the console's sync endpoint. |
   | `AGENTRAIL_SANDBOX` | No | `host` (default, via the legacy trigger — see the Isolation section below) or `docker`. This daemon's `ANTHROPIC_API_KEY` is always empty (OpenRouter auth rides `ANTHROPIC_AUTH_TOKEN` instead), so the legacy ANTHROPIC_API_KEY-presence trigger can never select Docker mode here on its own — `AGENTRAIL_SANDBOX=docker` is the ONLY way to turn on per-task container isolation for this service. Requires the Docker socket + the separate sandbox image; see the Isolation section. |

   **Do NOT set `AGENTRAIL_WORKSPACE_ID`** here under any circumstances — see
   `agentrail/cli/commands/fleet.py`'s module docstring for exactly why (it
   would leak an operator-only quarantine exemption into every fleet-served
   customer workspace's run).

## Kill switches

Two independent levers, at different scopes and different speeds — know
which one you need before an incident, not during one:

- **Freeze provisioning (all workspaces, not immediate for already-running
  claims):** unset `FLEET_CONSOLE_TOKEN` in the **console's** own env. The
  sync route's `verifyFleetBearer` then rejects every request with the same
  404 it uses for a wrong secret (anti-enumeration — "unset" and "wrong" are
  indistinguishable on purpose). The fleet's *next* sync (boot or periodic)
  fails: on boot this is fatal (the process exits rather than start
  ignorant of who to serve); a *periodic* re-sync failure is only a logged
  warning — **the fleet keeps claiming with whatever per-workspace tokens
  it already holds** until each is separately revoked or the process
  restarts. This lever stops future re-provisioning; it does not
  instantly stop an already-running fleet.
- **Revoke one workspace immediately:** revoke that workspace's `kind:
  'fleet'` `api_keys` row directly (independent of the sync route — e.g.
  flip `hosted_execution` off for that workspace and let a sync process the
  revoke, or revoke the row directly for an instant cut). Its very next
  `claim_next()` gets a 401 → `RunnerAuthError` → that ONE workspace drops
  out of rotation immediately (loud warning) while every other workspace
  keeps being served without interruption. This is the fast, targeted
  kill switch; a sync-cycle-mediated revoke is only as fast as
  `FLEET_SYNC_INTERVAL_SECONDS`, a direct row revoke is as fast as that
  workspace's next claim attempt.
- **Stop everything right now, regardless of the above:** scale the Railway
  service to 0 / stop the deployment. Neither lever above is instant at the
  whole-fleet level — this is the one that is.

## Isolation

Two deploy shapes exist for this fleet today, with genuinely different
isolation properties. Pick knowing which one you're actually running — no
softening either way.

### The Railway shape (this directory's own `railway.json`) — one container, no per-task isolation

This is what `railway.json` deploys by default (`AGENTRAIL_SANDBOX` unset).
Each claimed run clones into its own disposable temp directory
(`agentrail/sandbox/native_runner.py:run_issue_on_host` — `tempfile.mkdtemp`,
always `shutil.rmtree`'d afterward, even on error/timeout) inside **this one
container**. That's filesystem-collision safety between concurrent runs
across different workspaces (`FLEET_CONCURRENCY` > 1), not isolation:
every concurrent run shares this container's CPU, memory, process
namespace, and kernel. There is no per-task container, VM, network
namespace, or resource cap — a runaway or malicious task in one workspace's
clone can affect every other concurrently-running task in the same
container, and nothing at this layer stops one concurrently-running task
from reading another's clone on the same filesystem. Say this plainly to
anyone evaluating the fleet for multi-tenant use: on the bare Railway shape,
"isolation" between workspaces is disposable-directory hygiene, not a
security boundary.

### The VM/socket shape (`AGENTRAIL_SANDBOX=docker`) — genuine per-task containers

`agentrail/sandbox/native_runner.py:select_sandbox_runner` picks a different
execution backend entirely when `AGENTRAIL_SANDBOX=docker` is set on this
service (an explicit override — the legacy ANTHROPIC_API_KEY-presence
trigger can never fire here on its own, since this daemon's
`ANTHROPIC_API_KEY` is always empty). Each claim then spawns a fresh,
disposable **sibling** container per task — its own filesystem, process
namespace, and (subject to `docker_runner.build_run_command`'s `--cpus`/
`--memory`/`--pids-limit` flags) resource limits, unconditionally removed
after the run. That sibling container is built from a genuinely DIFFERENT
image — `agentrail/docker/runner/Dockerfile` (tag `agentrail/runner:latest`)
— not this service's own `deploy/runner/Dockerfile`; the two "runner"
Dockerfiles in this repo are not interchangeable, and the sandbox image must
be built and available on the host before flipping this on. Env forwarded
into that sibling container is an explicit, commented allowlist, not a
blanket dump of this process's own environment — see
`agentrail/sandbox/native_runner.py`'s `_DOCKER_SANDBOX_ENV_ALLOWLIST`.
One residual the allowlist deliberately does not remove: the coding agent's
OpenRouter credential is inside every per-task container by design — its
value rides in as `ANTHROPIC_AUTH_TOKEN`, which the agent cannot
authenticate without — so a malicious task can read the operator's real
OpenRouter key even in this shape. That residual is one of the concrete
reasons the #1295 hardening below is a precondition for calling this shape
fully multi-tenant-safe, not an optional extra.

This mode needs the Docker socket mounted into the fleet container — see the
commented `- /var/run/docker.sock:/var/run/docker.sock` line under the
`runner:` service in `deploy/docker-compose.prod.yml` for the exact mechanic
(that file is the single-tenant compose deploy, not this Railway service, but
the socket-mount requirement is identical here). This repo has not verified
whether Railway's own managed container platform exposes a host Docker
socket to a service at all — do not assume it does. Treat "VM/socket shape"
literally: a VM or self-hosted Docker host you control, not a claim about
what `railway.json` alone can express on Railway's managed containers.

**Recommended over the bare Railway shape for multi-tenant production**,
until the #1295 hardening work (network policy, rootless containers, tighter
resource caps) lands on top of it. Per-task containers close the
shared-filesystem/process/kernel gap described above; #1295's items address
what's still open even with per-task containers (a container boundary is
not, by itself, a hardened one).
