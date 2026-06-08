import { client } from "./client";
import type { TelemetryEventRecord } from "./schema";

async function main() {
  console.log("Seeding ClickHouse run_events...");

  const events: TelemetryEventRecord[] = [
    {
      workspace_id: "dev-workspace",
      repository_id: "bensigo/agentrail",
      run_id: "run-001",
      agent: "claude",
      phase: "execute",
      event_type: "run.started",
      severity: "info",
      occurred_at: new Date("2026-06-08T08:00:00.000Z"),
      event_id: "evt-001",
      submission_kind: "issue",
      payload: JSON.stringify({ issue: 212 }),
    },
    {
      workspace_id: "dev-workspace",
      repository_id: "bensigo/agentrail",
      run_id: "run-001",
      agent: "claude",
      phase: "execute",
      event_type: "run.completed",
      severity: "info",
      occurred_at: new Date("2026-06-08T08:05:00.000Z"),
      event_id: "evt-002",
      submission_kind: "issue",
      payload: JSON.stringify({ issue: 212, status: "success" }),
    },
    {
      workspace_id: "dev-workspace",
      repository_id: "bensigo/agentrail",
      run_id: "run-002",
      agent: "claude",
      phase: "plan",
      event_type: "run.started",
      severity: "info",
      occurred_at: new Date("2026-06-08T09:00:00.000Z"),
      event_id: "evt-003",
      submission_kind: "issue",
      payload: JSON.stringify({ issue: 213 }),
    },
  ];

  await client.insert({
    table: "run_events",
    values: events.map((e) => ({
      ...e,
      occurred_at: e.occurred_at.toISOString().replace("T", " ").replace("Z", ""),
    })),
    format: "JSONEachRow",
  });

  console.log(`Inserted ${events.length} sample run_events.`);
  await client.close();
  console.log("ClickHouse seed complete.");
}

main().catch((err) => {
  console.error("ClickHouse seed failed:", err);
  process.exit(1);
});
