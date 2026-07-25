# Self-hosted ClickHouse — Railway service

The evidence layer's telemetry store (`run_events`, `cost_events`,
`failure_events`, `context_packs`, `context_events`, `afk_run_events`,
`index_snapshots`, `wiki_compile_events` — see `packages/db-clickhouse/src/
schema.ts`). This is **not** the single-VM `deploy/docker-compose.prod.yml`
skeleton, which intentionally omits ClickHouse (see `deploy/README.md`) — this
document covers the hosted Railway deployment's own, separate ClickHouse
service, deployed straight from the stock `clickhouse/clickhouse-server:24`
image (no Dockerfile, no build, nothing in this repo builds it).

ClickHouse stays an **optional** dependency even on the hosted deploy: every
write path that touches it is try/caught at the call site, and the console's
own migrator skips cleanly (exits 0, logs a notice) when it isn't configured
— see `apps/console/Dockerfile`'s `/ch-migrator` stage and
`packages/db-clickhouse/src/migrate.ts`. Provisioning it upgrades a workspace
from "evidence silently missing" to "evidence recorded"; it does not gate
anything on the runner's claim/execute/report loop.

## Dashboard steps

1. **Create the service** — "Deploy from Docker Image" (not "Deploy from
   GitHub repo": this service has no source in this repo to build) —
   `clickhouse/clickhouse-server:24`.
2. **Attach a Volume**, mount path `/var/lib/clickhouse/` — that's
   ClickHouse's own data directory (confirmed against the image's own
   `docker/server` docs). Without a persistent volume every redeploy/restart
   starts from an empty database and every table gets recreated empty (the
   migrator's `CREATE TABLE IF NOT EXISTS` would silently no-op against
   nothing, and every historical row is gone).
3. **Set environment variables on the ClickHouse service itself** — these
   bootstrap the database and user the FIRST time the container starts (the
   official image's own `CLICKHOUSE_DB` / `CLICKHOUSE_USER` /
   `CLICKHOUSE_PASSWORD` support):

   | Var | Required | Notes |
   |---|---|---|
   | `CLICKHOUSE_DB` | Recommended | Creates this database at first boot. Pick a name and reuse it below (`agentrail` matches `packages/db-clickhouse/src/client.ts`'s own fallback default, but any name works as long as both services agree). |
   | `CLICKHOUSE_USER` | Recommended | Creates this user at first boot. Defaults to `default` if unset — confirmed against the image's own docs. |
   | `CLICKHOUSE_PASSWORD` | **Yes** | Not just an app credential: the image's own docs are explicit that the predefined `default` user (and any `CLICKHOUSE_USER` you set) **has no network access at all until a password is set** — only localhost connections work otherwise. Skipping this makes the console's connection fail closed, not open. |

   No inbound port mapping to the public internet — reachability over
   Railway's **private network** (below) is the point; do not expose 8123 or
   9000 publicly.
4. **Set the matching environment variables on the CONSOLE service** — the
   console is the only thing that talks to this service, via
   `packages/db-clickhouse/src/client.ts`:

   | Var | Required | Notes |
   |---|---|---|
   | `CLICKHOUSE_URL` | **Yes** (to enable ClickHouse at all) | Railway private networking: `http://<clickhouse-service-name>.railway.internal:8123` — `8123` is the image's HTTP interface port (what `@clickhouse/client` speaks; the 9000 native-protocol port is unused here). Substitute whatever you actually named the service in step 1. Leaving this unset is a supported, intentional "no ClickHouse" configuration — see the fail-soft note above — not a thing to work around. |
   | `CLICKHOUSE_USER` | Recommended | Must match step 3's `CLICKHOUSE_USER` (or `default` if you left that unset there). Falls back to `agentrail` if unset here — matches step 3's suggested default, but only if you actually used it. |
   | `CLICKHOUSE_PASSWORD` | **Yes** (if `CLICKHOUSE_URL` is set) | Must match step 3's `CLICKHOUSE_PASSWORD` exactly. |
   | `CLICKHOUSE_DB` | Recommended | Must match step 3's `CLICKHOUSE_DB` (or `default` if you left that unset there). Falls back to `agentrail` if unset here. |

   Setting `CLICKHOUSE_URL` alone with everything else left at fallback
   defaults only works if step 3 also used the matching `agentrail` /
   `agentrail` defaults — mismatched credentials fail closed (connection
   refused / auth error), not silently.

## Migrations

Applied automatically by the console's own deploy — see
`apps/console/Dockerfile`'s `/ch-migrator` stage and the console service's
`preDeployCommand` (documented where the Postgres migrator's is: the
Dockerfile's builder-stage and runner-stage comments). Nothing to run by hand
here; a fresh ClickHouse service gets its full schema on the very first
console rollout after `CLICKHOUSE_URL` is set, and every later rollout
re-applies the same idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ...
ADD COLUMN IF NOT EXISTS` statements (see `packages/db-clickhouse/src/
schema.ts`) — safe to re-run, nothing to track.

## Verifying it's actually wired up

`packages/db-clickhouse/src/client.ts` logs a warning at console boot if
`NODE_ENV=production` and `CLICKHOUSE_URL` is unset — absence of that warning
in the console's boot logs is the quickest signal this is configured. Beyond
that, the console's `preDeployCommand` output on the next rollout will show
either `ClickHouse migration complete.` (working) or `CLICKHOUSE_URL is not
set — skipping ClickHouse migrations` (not configured, or the var didn't
reach the console service) — never a silent gap either way.
