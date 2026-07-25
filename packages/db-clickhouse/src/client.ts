import { createClient } from "@clickhouse/client";

const url = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const username = process.env.CLICKHOUSE_USER ?? "agentrail";
const password = process.env.CLICKHOUSE_PASSWORD ?? "agentrail";
const database = process.env.CLICKHOUSE_DB ?? "agentrail";

// Make the localhost fallback loud in anything production-like. Prod ran with
// CLICKHOUSE_URL unset for a long stretch and nobody noticed: every write
// silently connection-refused against localhost:8123 and was swallowed by the
// call sites' own try/catch (the entire evidence layer — run_events,
// cost_events, failure_events, context_packs, context_events,
// afk_run_events, index_snapshots, wiki_compile_events — went dark with zero
// signal). This does not change call-site behavior (still try/caught same as
// before); it just makes the misconfiguration visible in the deploy logs
// instead of discoverable only by noticing an empty dashboard weeks later.
if (!process.env.CLICKHOUSE_URL && process.env.NODE_ENV === "production") {
  console.warn(
    "[db-clickhouse] CLICKHOUSE_URL is not set — falling back to " +
      "http://localhost:8123, which will not resolve in production. Every " +
      "ClickHouse-backed telemetry write (run_events, cost_events, " +
      "failure_events, context_packs, context_events, afk_run_events, " +
      "index_snapshots, wiki_compile_events) will silently fail wherever the " +
      "caller wraps it in try/catch. Set CLICKHOUSE_URL (and " +
      "CLICKHOUSE_USER/CLICKHOUSE_PASSWORD/CLICKHOUSE_DB) to enable it."
  );
}

export const client = createClient({
  url,
  username,
  password,
  database,
});
