import { clickhouse } from "./client";
import { CREATE_RUN_EVENTS, CREATE_CONTEXT_EVENTS, CREATE_FAILURE_EVENTS } from "./schema";

async function main() {
  console.log("Running ClickHouse migrations...");
  await clickhouse.command({ query: CREATE_RUN_EVENTS });
  console.log("Created run_events table.");
  await clickhouse.command({ query: CREATE_CONTEXT_EVENTS });
  console.log("Created context_events table.");
  await clickhouse.command({ query: CREATE_FAILURE_EVENTS });
  console.log("Created failure_events table.");
  await clickhouse.close();
  console.log("ClickHouse migrations complete.");
}

main().catch((err) => {
  console.error("ClickHouse migration failed:", err);
  process.exit(1);
});
