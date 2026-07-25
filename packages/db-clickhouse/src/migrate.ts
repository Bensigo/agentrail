import { pathToFileURL } from "url";
import { client as defaultClient } from "./client.js";
import {
  CREATE_RUN_EVENTS_TABLE,
  CREATE_FAILURE_EVENTS_TABLE,
  CREATE_CONTEXT_PACKS_TABLE,
  CREATE_CONTEXT_EVENTS_TABLE,
  CREATE_INDEX_SNAPSHOTS_TABLE,
  CREATE_COST_EVENTS_TABLE,
  ALTER_RUN_EVENTS_ADD_SESSION_ID,
  ALTER_RUN_EVENTS_ADD_SEQ,
  ALTER_RUN_EVENTS_ADD_FILES_READ_COUNT,
  ALTER_RUN_EVENTS_ADD_FULL_FILE_READ,
  ALTER_RUN_EVENTS_ADD_TOOL_LOOP_COUNT,
  ALTER_RUN_EVENTS_ADD_EDIT_WITHOUT_CONTEXT,
  ALTER_RUN_EVENTS_ADD_VERIFICATION_SKIP,
  ALTER_CONTEXT_PACKS_ADD_TOKENS_SAVED,
  ALTER_CONTEXT_PACKS_ADD_PRECISION_AT_BUDGET,
  ALTER_CONTEXT_PACKS_ADD_CITATION_COVERAGE,
  ALTER_CONTEXT_PACKS_ADD_STALE_COUNT,
  ALTER_CONTEXT_PACKS_ADD_DENIED_COUNT,
  ALTER_CONTEXT_PACKS_ADD_SOURCE_HASH_LIST,
  ALTER_CONTEXT_PACKS_ADD_REPOSITORY_ID,
  ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR,
  ALTER_FAILURE_EVENTS_ADD_FINGERPRINT,
  ALTER_COST_EVENTS_ADD_PHASE,
  ALTER_COST_EVENTS_ADD_INPUT_TOKENS,
  ALTER_COST_EVENTS_ADD_OUTPUT_TOKENS,
  ALTER_COST_EVENTS_ADD_CACHE_TOKENS,
  ALTER_COST_EVENTS_ADD_CACHE_CREATION_TOKENS,
  ALTER_COST_EVENTS_ADD_PRICE_SOURCE,
  CREATE_AFK_RUN_EVENTS_TABLE,
  CREATE_WIKI_COMPILE_EVENTS_TABLE,
} from "./schema.js";

// Minimal structural seam migrations actually need (command + close) —
// deliberately narrower than the full @clickhouse/client `ClickHouseClient`
// type so tests can pass a plain fake without implementing query/insert/ping/
// etc. `defaultClient` (the real client) satisfies this structurally, same
// DI pattern as seed-milestone-016.ts's `Milestone016SeedClient`.
export interface ClickHouseMigrationClient {
  command(args: { query: string }): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Applies every ClickHouse migration statement, in order. Every CREATE TABLE
 * uses IF NOT EXISTS and every ALTER TABLE uses ADD COLUMN IF NOT EXISTS (see
 * schema.ts), so this is idempotent — re-running it against an
 * already-migrated database is a safe no-op. That idempotency is what makes
 * "run this on every deploy" (rather than tracking which migrations already
 * ran) safe here, unlike the drizzle-tracked Postgres migrator.
 */
export async function runClickHouseMigrations(
  ch: ClickHouseMigrationClient = defaultClient
): Promise<void> {
  console.log("Running ClickHouse migrations...");
  await ch.command({ query: CREATE_RUN_EVENTS_TABLE });
  console.log("Created run_events table.");
  // Additive columns for AFK telemetry (safe on existing tables).
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_SESSION_ID });
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_SEQ });
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_FILES_READ_COUNT });
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_FULL_FILE_READ });
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_TOOL_LOOP_COUNT });
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_EDIT_WITHOUT_CONTEXT });
  await ch.command({ query: ALTER_RUN_EVENTS_ADD_VERIFICATION_SKIP });
  console.log("Applied run_events ALTER TABLE migrations.");
  await ch.command({ query: CREATE_FAILURE_EVENTS_TABLE });
  console.log("Created failure_events table.");
  await ch.command({ query: ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR });
  await ch.command({ query: ALTER_FAILURE_EVENTS_ADD_FINGERPRINT });
  console.log("Applied failure_events ALTER TABLE migrations.");
  await ch.command({ query: CREATE_CONTEXT_PACKS_TABLE });
  console.log("Created context_packs table.");
  // Additive columns for tokens-saved and context-quality telemetry (safe on existing tables).
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_TOKENS_SAVED });
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_PRECISION_AT_BUDGET });
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_CITATION_COVERAGE });
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_STALE_COUNT });
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_DENIED_COUNT });
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_SOURCE_HASH_LIST });
  await ch.command({ query: ALTER_CONTEXT_PACKS_ADD_REPOSITORY_ID });
  console.log("Applied context_packs ALTER TABLE migrations.");
  await ch.command({ query: CREATE_CONTEXT_EVENTS_TABLE });
  console.log("Created context_events table.");
  await ch.command({ query: CREATE_INDEX_SNAPSHOTS_TABLE });
  console.log("Created index_snapshots table.");
  await ch.command({ query: CREATE_COST_EVENTS_TABLE });
  console.log("Created cost_events table.");
  // Additive columns for per-phase cost tracking (safe on existing tables).
  await ch.command({ query: ALTER_COST_EVENTS_ADD_PHASE });
  await ch.command({ query: ALTER_COST_EVENTS_ADD_INPUT_TOKENS });
  await ch.command({ query: ALTER_COST_EVENTS_ADD_OUTPUT_TOKENS });
  await ch.command({ query: ALTER_COST_EVENTS_ADD_CACHE_TOKENS });
  await ch.command({ query: ALTER_COST_EVENTS_ADD_CACHE_CREATION_TOKENS });
  await ch.command({ query: ALTER_COST_EVENTS_ADD_PRICE_SOURCE });
  console.log("Applied cost_events ALTER TABLE migrations.");
  await ch.command({ query: CREATE_AFK_RUN_EVENTS_TABLE });
  console.log("Created afk_run_events table.");
  await ch.command({ query: CREATE_WIKI_COMPILE_EVENTS_TABLE });
  console.log("Created wiki_compile_events table.");
  await ch.close();
  console.log("ClickHouse migration complete.");
}

/**
 * Deploy-time entrypoint. Returns the process exit code rather than calling
 * `process.exit` itself, so it stays plain-async-testable (see
 * migrate.test.ts) — the invocation guard below is the only place that
 * actually exits the process.
 *
 * Fail-soft on absence, fail-hard on breakage (owner rule: migrations always
 * run on deploy, but ClickHouse itself stays an OPTIONAL dependency — most
 * self-hosters don't run it): if CLICKHOUSE_URL is unset, skip with a clear
 * log line and report success (0) rather than blocking a rollout on a
 * service that was never configured. If CLICKHOUSE_URL IS set, a genuine
 * migration failure propagates (rejects) so the caller can exit non-zero and
 * abort the rollout — same posture as the Postgres migrator.
 */
export async function main(): Promise<number> {
  if (!process.env.CLICKHOUSE_URL) {
    console.log(
      "CLICKHOUSE_URL is not set — skipping ClickHouse migrations " +
        "(optional dependency). Set CLICKHOUSE_URL to enable ClickHouse-backed " +
        "telemetry."
    );
    return 0;
  }
  await runClickHouseMigrations(defaultClient);
  return 0;
}

// Only auto-run when this file is the process entrypoint (`node
// dist/migrate.js`), not when imported by a test — same guard as
// seed-milestone-016.ts.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("ClickHouse migration failed:", err);
      process.exit(1);
    });
}
