import { clickhouse } from "./client";
import { CREATE_RUN_EVENTS } from "./schema";

async function main() {
  console.log("Running ClickHouse migrations...");
  await clickhouse.command({ query: CREATE_RUN_EVENTS });
  console.log("Created run_events table.");
  await clickhouse.close();
  console.log("ClickHouse migrations complete.");
}

main().catch((err) => {
  console.error("ClickHouse migration failed:", err);
  process.exit(1);
});
