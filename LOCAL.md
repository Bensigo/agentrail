# Run AgentRail locally

This is an Apache-2.0 open-source project. No hosted AgentRail or Jace account is required. Node 24, pnpm 9, Python 3.11+ and Docker Compose are the local prerequisites.

```sh
pnpm install --frozen-lockfile
pnpm local:up
```

The first start installs the Python CLI in `.venv`, builds shared packages, starts private data containers, applies migrations and opens a local operator session. The Console and workers run on your host for faster startup and source changes; PostgreSQL, ClickHouse and artifact storage run in Docker. Data survives `pnpm local:down`. To sign in again, run `pnpm local:open`. Its single-use code expires after two minutes; it is issued through your local database and cannot be used on Vercel. `LOCAL_OPERATOR_LOGIN` is enabled only by the local launcher. Its services bind to loopback; keep this development setup private.

Configuration and generated passwords are stored in the ignored, permission-restricted `.local/env`. To change ports or add optional GitHub credentials, edit that file and rerun `pnpm local:up`. No shared database or runtime connection to the other product is configured.

| Service | Local port |
| --- | --- |
| Console | 3000 |
| PostgreSQL | 15432 |
| ClickHouse HTTP | 18123 |
| Artifact store | 19000 |
| Artifact store administration | 19001 |

## Connect any coding agent

In Console → Agents, create a workflow key and copy the command/arguments/environment into your MCP-compatible coding agent. Build the host-side MCP server first with `pnpm --filter @agentrail/mcp build`. The launcher installs the Python CLI into `.venv`; use that absolute CLI path in your agent configuration.

The Console and MCP read/write the same durable task history. Context retrieval runs next to your source checkout. Configured checks execute on your machine, in the source checkout. Work reports remain labelled as reported, and human closure remains separate.

## Troubleshooting

Use `pnpm local:status`. Application logs are in `.local/*.log`; data-service logs are available with `docker compose --env-file .local/env -f compose.local-data.yml logs <service>`. If a port is occupied, change its value in `.local/env`; do not stop another project. A failed migration prevents the Console from starting. Do not delete volumes to hide the failure.

Vercel is the intended later hosting target. Railway files are inherited historical deployment material; they are not used by this local profile.

The launcher uses `compose.local-data.yml` for data services and host processes for applications.

ClickHouse has a 1536M local memory limit by default. Its earlier 768M limit could reject migrations after the server cache grew. Override `CLICKHOUSE_MEMORY_LIMIT` in `.local/env` if your workload needs more headroom; rerunning `pnpm local:up` preserves the data volume.
