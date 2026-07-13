# Local Langfuse Setup

This guide walks you through running Langfuse locally for development and testing. Langfuse provides tracing and evaluation infrastructure for agent runs.

## Prerequisites

- Docker and Docker Compose installed
- The docker-compose file at `agentrail/observability/docker-compose.langfuse.yml`

## Starting Langfuse

Run the following command to start all Langfuse services (PostgreSQL, Redis, ClickHouse, MinIO, worker, and web UI):

```bash
docker compose -f agentrail/observability/docker-compose.langfuse.yml up -d
```

The web UI will be available at `http://localhost:3000`. Wait a few seconds for all services to become healthy (check with `docker compose -f agentrail/observability/docker-compose.langfuse.yml ps`).

## Initial Login and API Key Creation

1. Open `http://localhost:3000` in your browser
2. On first login, create a default user account (any email/password combination works for local dev)
3. Once logged in, navigate to **Settings → API Keys**
4. Create a new API key — this will provide a **public key** and **secret key**
5. Copy both keys; you will need them for configuration below

## Configuration for agentrail

Add the following environment variables to your `.agentrail/config.json` or export them in your shell:

```json
{
  "env": {
    "AGENTRAIL_LANGFUSE_ENABLED": "1",
    "LANGFUSE_HOST": "http://localhost:3000",
    "LANGFUSE_PUBLIC_KEY": "your-public-key-from-step-above",
    "LANGFUSE_SECRET_KEY": "your-secret-key-from-step-above"
  }
}
```

Alternatively, export as environment variables:

```bash
export AGENTRAIL_LANGFUSE_ENABLED=1
export LANGFUSE_HOST=http://localhost:3000
export LANGFUSE_PUBLIC_KEY=your-public-key-from-step-above
export LANGFUSE_SECRET_KEY=your-secret-key-from-step-above
```

## Configuration for Jace

If using Jace (the Eve-based coordinator), add the following environment variables:

```json
{
  "env": {
    "LANGFUSE_BASE_URL": "http://localhost:3000",
    "LANGFUSE_PUBLIC_KEY": "your-public-key-from-step-above",
    "LANGFUSE_SECRET_KEY": "your-secret-key-from-step-above"
  }
}
```

Or as environment variables:

```bash
export LANGFUSE_BASE_URL=http://localhost:3000
export LANGFUSE_PUBLIC_KEY=your-public-key-from-step-above
export LANGFUSE_SECRET_KEY=your-secret-key-from-step-above
```

## Syncing LLM Model Pricing

To sync LLM model pricing information into Langfuse (required for cost tracking), run:

```bash
agentrail langfuse sync-models
```

This populates Langfuse's model pricing database, allowing it to calculate costs for traced LLM calls automatically.

## Data Persistence

Langfuse uses named Docker volumes to persist data:

- `langfuse_postgres_data` — application database
- `langfuse_clickhouse_data` — event analytics database
- `langfuse_redis_data` — session/cache data
- `langfuse_minio_data` — file storage
- `langfuse_clickhouse_logs` — ClickHouse logs

These volumes survive container restarts. If you need to reset Langfuse completely (e.g., to clear all traces and start fresh for calibration/dataset testing), run:

```bash
docker compose -f agentrail/observability/docker-compose.langfuse.yml down -v
```

**Warning:** The `-v` flag removes all named volumes and their data. This is only necessary for a clean slate; do not use casually.

## Stopping Langfuse

To stop Langfuse without removing data:

```bash
docker compose -f agentrail/observability/docker-compose.langfuse.yml down
```

To stop and remove all data:

```bash
docker compose -f agentrail/observability/docker-compose.langfuse.yml down -v
```

## Verifying Local Traces

Once configured and running, traces from agentrail runs will appear in the Langfuse UI at `http://localhost:3000` under your project. Each trace includes:

- Generations (LLM calls) with prompts and completions
- Tokens and costs calculated from the pricing synced above
- Trace timings and metadata
- Child spans showing agent call hierarchy

Check the **Traces** tab in the Langfuse UI to verify traces are flowing in during `agentrail run` executions.
