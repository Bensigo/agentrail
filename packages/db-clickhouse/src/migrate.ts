import { client } from "./client";
import { CREATE_RUN_EVENTS_TABLE, CREATE_FAILURE_EVENTS_TABLE } from "./schema";

async function main() {
  console.log("Running ClickHouse migrations...");
  await client.command({ query: CREATE_RUN_EVENTS_TABLE });
  console.log("Created run_events table.");
  await client.command({ query: CREATE_FAILURE_EVENTS_TABLE });
  console.log("Created failure_events table.");
  await client.close();
  console.log("ClickHouse migration complete.");
}

main().catch((err) => {
  console.error("ClickHouse migration failed:", err);
  process.exit(1);
});
