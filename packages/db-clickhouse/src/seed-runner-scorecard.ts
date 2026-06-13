/**
 * Seed script for Runner Scorecard fixtures (Milestone 017 / issue #572).
 *
 * Inserts `afk_run_events` and `cost_events` rows for 3 distinct runner names
 * using deterministic IDs so re-runs are idempotent. The `afk_run_events`
 * rows produce varied event-type distributions so the aggregator can compute
 * non-trivial review_fix_rate / human_review_rate values.
 *
 * PREREQUISITE (upstream blocker):
 *   The Postgres `runs` table must carry a `runner_name` column (migration in
 *   issue #568 / feat/issue-568-runner-scorecard-aggregator). The three
 *   Postgres run IDs below must be seeded with matching runner_name values
 *   before the `/api/v1/workspaces/.../scorecard/runners` endpoint can join
 *   and return scorecard rows.
 *
 *   Seed the Postgres side by running:
 *     pnpm --filter @agentrail/db-postgres db:seed
 *   (once the migration landing adds runner_name to the runs schema and the
 *   seed.ts inserts rows with the IDs below).
 *
 * Usage (throwaway local DB only):
 *   AGENTRAIL_ALLOW_SEED=1 pnpm --filter @agentrail/db-clickhouse exec tsx src/seed-runner-scorecard.ts
 */

import { pathToFileURL } from "url";
import { client } from "./client";
import type { AfkRunEventRecord, CostEventRecord } from "./schema";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// Deterministic run IDs — one per runner. Keep in sync with the Postgres seed
// once runner_name lands on the runs table.
const RUNNERS = [
  {
    name: "slot-0",
    runId: "00000000-0000-0000-0000-000000000572",
    // Scenario: success + no human review
    events: [
      { eventType: "run.started", slot: 0 },
      { eventType: "tool.call", slot: 0 },
      { eventType: "review_gate.passed", slot: 0 },
      { eventType: "run.completed", slot: 0 },
    ],
    costUsd: 0.0412,
  },
  {
    name: "slot-1",
    runId: "00000000-0000-0000-0000-000000000573",
    // Scenario: review-fix loop (one review_gate.failed then passed)
    events: [
      { eventType: "run.started", slot: 1 },
      { eventType: "tool.call", slot: 1 },
      { eventType: "review_gate.failed", slot: 1 },
      { eventType: "review_gate.passed", slot: 1 },
      { eventType: "run.completed", slot: 1 },
    ],
    costUsd: 0.0738,
  },
  {
    name: "slot-2",
    runId: "00000000-0000-0000-0000-000000000574",
    // Scenario: human review required
    events: [
      { eventType: "run.started", slot: 2 },
      { eventType: "tool.call", slot: 2 },
      { eventType: "review_gate.failed", slot: 2 },
      { eventType: "human_review.requested", slot: 2 },
      { eventType: "human_review.approved", slot: 2 },
      { eventType: "run.completed", slot: 2 },
    ],
    costUsd: 0.1056,
  },
] as const;

function clickhouseTs(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function main() {
  if (process.env.AGENTRAIL_ALLOW_SEED !== "1") {
    console.error(
      "Refusing to seed: set AGENTRAIL_ALLOW_SEED=1 to seed a throwaway local database. " +
        "Never seed the linked instance — the dashboard uses real run data only."
    );
    process.exit(1);
  }

  console.log("Seeding Runner Scorecard fixtures (M017 / issue #572)…");

  const baseTs = new Date("2026-06-10T10:00:00.000Z");

  const afkRows: AfkRunEventRecord[] = [];
  for (const runner of RUNNERS) {
    runner.events.forEach((evt, i) => {
      const ts = new Date(baseTs.getTime() + i * 60_000);
      afkRows.push({
        run_id: runner.runId,
        workspace_id: WORKSPACE_ID,
        slot: evt.slot,
        event_type: evt.eventType,
        ts: clickhouseTs(ts),
        payload_json: JSON.stringify({
          runner_name: runner.name,
          seq: i,
          fixture: "m017-runner-scorecard",
        }),
        digest: `m017-${runner.name}-${i}`,
      });
    });
  }

  await client.insert({
    table: "afk_run_events",
    values: afkRows,
    format: "JSONEachRow",
  });
  console.log(`Inserted ${afkRows.length} afk_run_events rows.`);

  const costRows: CostEventRecord[] = RUNNERS.map((runner, i) => ({
    workspace_id: WORKSPACE_ID,
    run_id: runner.runId,
    repository_id: "00000000-0000-0000-0000-000000000010",
    team_id: "team-eng",
    api_key_id: "key-alpha",
    cost_type: "model_call",
    phase: "execute",
    input_tokens: 8_000,
    output_tokens: 2_000,
    cache_tokens: 1_000,
    tokens: 11_000,
    cost_usd: runner.costUsd,
    model: "claude-sonnet-4-6",
    occurred_at: new Date(baseTs.getTime() + i * 300_000),
    event_id: `m017-cost-${runner.name}`,
  }));

  await client.insert({
    table: "cost_events",
    values: costRows.map((e) => ({
      ...e,
      occurred_at: clickhouseTs(e.occurred_at as Date),
    })),
    format: "JSONEachRow",
  });
  console.log(`Inserted ${costRows.length} cost_events rows.`);

  console.log("");
  console.log("Runner Scorecard fixtures seeded.");
  console.log(`workspace_id=${WORKSPACE_ID}`);
  RUNNERS.forEach((r) =>
    console.log(`runner=${r.name}  run_id=${r.runId}  cost_usd=${r.costUsd}`)
  );
  console.log("");
  console.log(
    "NEXT STEP: Postgres runs with matching runner_name must be seeded once the"
  );
  console.log(
    "  runner_name migration (issue #568) lands and the Postgres seed is updated."
  );
  console.log(
    `  Scorecard page: /dashboard/${WORKSPACE_ID}/scorecard`
  );

  await client.close();
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("Runner Scorecard seed failed:", err);
    process.exit(1);
  });
}
