import { clickhouse } from "./client";
import type { RunEvent } from "./schema";

async function main() {
  console.log("Seeding ClickHouse run_events...");

  const events: RunEvent[] = [
    {
      workspace_id: "00000000-0000-0000-0000-000000000001",
      repository_id: "repo-001",
      run_id: "run-001",
      agent: "codex",
      phase: "execute",
      event_type: "run_start",
      severity: "info",
      occurred_at: new Date().toISOString(),
      event_id: "evt-001",
      submission_kind: "run",
      payload: JSON.stringify({ issue: 42 }),
    },
    {
      workspace_id: "00000000-0000-0000-0000-000000000001",
      repository_id: "repo-001",
      run_id: "run-001",
      agent: "codex",
      phase: "verify",
      event_type: "run_complete",
      severity: "info",
      occurred_at: new Date().toISOString(),
      event_id: "evt-002",
      submission_kind: "run",
      payload: JSON.stringify({ exitCode: 0 }),
    },
  ];

  await clickhouse.insert({
    table: "run_events",
    values: events,
    format: "JSONEachRow",
  });

  console.log(`Inserted ${events.length} run events.`);
  await clickhouse.close();
  console.log("ClickHouse seed complete.");
}

main().catch((err) => {
  console.error("ClickHouse seed failed:", err);
  process.exit(1);
});
