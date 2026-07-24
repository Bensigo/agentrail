import { client } from "./client";
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
} from "./schema";

async function main() {
  console.log("Running ClickHouse migrations...");
  await client.command({ query: CREATE_RUN_EVENTS_TABLE });
  console.log("Created run_events table.");
  // Additive columns for AFK telemetry (safe on existing tables).
  await client.command({ query: ALTER_RUN_EVENTS_ADD_SESSION_ID });
  await client.command({ query: ALTER_RUN_EVENTS_ADD_SEQ });
  await client.command({ query: ALTER_RUN_EVENTS_ADD_FILES_READ_COUNT });
  await client.command({ query: ALTER_RUN_EVENTS_ADD_FULL_FILE_READ });
  await client.command({ query: ALTER_RUN_EVENTS_ADD_TOOL_LOOP_COUNT });
  await client.command({ query: ALTER_RUN_EVENTS_ADD_EDIT_WITHOUT_CONTEXT });
  await client.command({ query: ALTER_RUN_EVENTS_ADD_VERIFICATION_SKIP });
  console.log("Applied run_events ALTER TABLE migrations.");
  await client.command({ query: CREATE_FAILURE_EVENTS_TABLE });
  console.log("Created failure_events table.");
  await client.command({ query: ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR });
  await client.command({ query: ALTER_FAILURE_EVENTS_ADD_FINGERPRINT });
  console.log("Applied failure_events ALTER TABLE migrations.");
  await client.command({ query: CREATE_CONTEXT_PACKS_TABLE });
  console.log("Created context_packs table.");
  // Additive columns for tokens-saved and context-quality telemetry (safe on existing tables).
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_TOKENS_SAVED });
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_PRECISION_AT_BUDGET });
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_CITATION_COVERAGE });
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_STALE_COUNT });
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_DENIED_COUNT });
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_SOURCE_HASH_LIST });
  await client.command({ query: ALTER_CONTEXT_PACKS_ADD_REPOSITORY_ID });
  console.log("Applied context_packs ALTER TABLE migrations.");
  await client.command({ query: CREATE_CONTEXT_EVENTS_TABLE });
  console.log("Created context_events table.");
  await client.command({ query: CREATE_INDEX_SNAPSHOTS_TABLE });
  console.log("Created index_snapshots table.");
  await client.command({ query: CREATE_COST_EVENTS_TABLE });
  console.log("Created cost_events table.");
  // Additive columns for per-phase cost tracking (safe on existing tables).
  await client.command({ query: ALTER_COST_EVENTS_ADD_PHASE });
  await client.command({ query: ALTER_COST_EVENTS_ADD_INPUT_TOKENS });
  await client.command({ query: ALTER_COST_EVENTS_ADD_OUTPUT_TOKENS });
  await client.command({ query: ALTER_COST_EVENTS_ADD_CACHE_TOKENS });
  await client.command({ query: ALTER_COST_EVENTS_ADD_CACHE_CREATION_TOKENS });
  await client.command({ query: ALTER_COST_EVENTS_ADD_PRICE_SOURCE });
  console.log("Applied cost_events ALTER TABLE migrations.");
  await client.command({ query: CREATE_AFK_RUN_EVENTS_TABLE });
  console.log("Created afk_run_events table.");
  await client.command({ query: CREATE_WIKI_COMPILE_EVENTS_TABLE });
  console.log("Created wiki_compile_events table.");
  await client.close();
  console.log("ClickHouse migration complete.");
}

main().catch((err) => {
  console.error("ClickHouse migration failed:", err);
  process.exit(1);
});
