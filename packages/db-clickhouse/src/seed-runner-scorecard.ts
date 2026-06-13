/**
 * Seed script: Runner Scorecard fixture data (Milestone 017)
 *
 * Inserts cost_events and context_packs for 3 distinct runner_name values,
 * keyed to shared run_ids that must also exist in the Postgres runs table
 * (seeded via packages/db-postgres/src/seed-runner-scorecard.ts or by
 * running the main pg seed which seeds the dev workspace).
 *
 * Run:
 *   AGENTRAIL_ALLOW_SEED=1 \
 *   [AGENTRAIL_FIXTURE_WORKSPACE_ID=<id>] \
 *   pnpm --filter @agentrail/db-clickhouse exec tsx src/seed-runner-scorecard.ts
 */

import { pathToFileURL } from "url";
import { client as defaultClient } from "./client";

// ---------------------------------------------------------------------------
// Shared constants — must match packages/db-postgres/src/seed-runner-scorecard.ts
// ---------------------------------------------------------------------------

export const RUNNER_SCORECARD_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
export const RUNNER_SCORECARD_REPOSITORY_ID = "00000000-0000-0000-0000-000000000010";

/**
 * 3 runners × 3 runs each.
 * runner_name corresponds to runs.agent (lowercased) in Postgres.
 *   claude  → run IDs 17a-01..17a-03
 *   codex   → run IDs 17b-01..17b-03
 *   gemini  → run IDs 17c-01..17c-03
 */
export const RUNNER_RUN_IDS: Record<string, string[]> = {
  claude: [
    "00000000-0000-0000-0017-a00000000001",
    "00000000-0000-0000-0017-a00000000002",
    "00000000-0000-0000-0017-a00000000003",
  ],
  codex: [
    "00000000-0000-0000-0017-b00000000001",
    "00000000-0000-0000-0017-b00000000002",
    "00000000-0000-0000-0017-b00000000003",
  ],
  gemini: [
    "00000000-0000-0000-0017-c00000000001",
    "00000000-0000-0000-0017-c00000000002",
    "00000000-0000-0000-0017-c00000000003",
  ],
};

function clickHouseDate(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function eventId(runId: string, suffix: string): string {
  return `m017-${runId.slice(-8)}-${suffix}`;
}

type SeedClient = {
  query(args: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }): Promise<{ json<T>(): Promise<T[]> }>;
  insert(args: {
    table: string;
    values: Array<Record<string, unknown>>;
    format: "JSONEachRow";
  }): Promise<unknown>;
};

async function insertMissing(
  ch: SeedClient,
  table: string,
  idColumn: string,
  rows: Array<Record<string, unknown>>
): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => String(r[idColumn]));
  const paramKey = idColumn === "context_pack_id" ? "packIds" : "eventIds";
  const result = await ch.query({
    query: `
      SELECT ${table === "context_packs" ? "context_pack_id" : idColumn}
      FROM ${table}
      WHERE ${table === "context_packs" ? "context_pack_id" : idColumn} IN ({${paramKey}: Array(String)})
    `,
    query_params: { [paramKey]: ids },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await result.json<Record<string, unknown>>()).map((r) => String(r[idColumn]))
  );
  const toInsert = rows.filter((r) => !existing.has(String(r[idColumn])));
  if (toInsert.length === 0) return 0;
  await ch.insert({ table, values: toInsert, format: "JSONEachRow" });
  return toInsert.length;
}

/**
 * Build deterministic cost_events for each runner's runs.
 * Costs are chosen so scorecard metrics are predictable:
 *   claude:  $0.05 / run × 3 runs → total $0.15; 2 successes → cost/PR = $0.075
 *   codex:   $0.08 / run × 3 runs → total $0.24; 3 successes → cost/PR = $0.08
 *   gemini:  $0.12 / run × 3 runs → total $0.36; 1 success  → cost/PR = $0.36
 */
const RUNNER_COST_USD: Record<string, number> = {
  claude: 0.05,
  codex: 0.08,
  gemini: 0.12,
};

export async function seedRunnerScorecardFixtures(
  workspaceId: string,
  ch: SeedClient = defaultClient
): Promise<{ costEvents: number; contextPacks: number }> {
  const now = new Date("2026-06-12T12:00:00Z");

  const costRows: Array<Record<string, unknown>> = [];
  const packRows: Array<Record<string, unknown>> = [];

  for (const [runner, runIds] of Object.entries(RUNNER_RUN_IDS)) {
    const costUsd = RUNNER_COST_USD[runner] ?? 0.05;
    runIds.forEach((runId, idx) => {
      const occurredAt = new Date(now.getTime() - (idx + 1) * 60 * 60 * 1000);

      costRows.push({
        workspace_id: workspaceId,
        run_id: runId,
        repository_id: RUNNER_SCORECARD_REPOSITORY_ID,
        team_id: "fixture-team",
        api_key_id: "fixture-api-key",
        cost_type: "model_call",
        phase: "execute",
        input_tokens: 8_000,
        output_tokens: 3_000,
        cache_tokens: 1_000,
        tokens: 12_000,
        cost_usd: costUsd,
        model: "claude-sonnet-4-6",
        occurred_at: clickHouseDate(occurredAt),
        event_id: eventId(runId, `cost-${idx + 1}`),
      });

      packRows.push({
        workspace_id: workspaceId,
        run_id: runId,
        context_pack_id: eventId(runId, "pack"),
        token_budget: 16_000,
        tokens_used: 10_000,
        tokens_saved: 6_000,
        anchors_extracted: 5,
        sources_considered: 20,
        precision_at_budget: 1,
        citation_coverage: 1,
        stale_count: 0,
        denied_count: 0,
        source_hash_list: [`sha256:m017-${runner}-${idx + 1}`],
        occurred_at: clickHouseDate(occurredAt),
        repository_id: RUNNER_SCORECARD_REPOSITORY_ID,
      });
    });
  }

  const [costEvents, contextPacks] = await Promise.all([
    insertMissing(ch, "cost_events", "event_id", costRows),
    insertMissing(ch, "context_packs", "context_pack_id", packRows),
  ]);

  return { costEvents, contextPacks };
}

async function main() {
  if (process.env["AGENTRAIL_ALLOW_SEED"] !== "1") {
    console.error(
      "Refusing to seed M017 runner scorecard fixtures: set AGENTRAIL_ALLOW_SEED=1."
    );
    process.exit(1);
  }

  const workspaceId =
    process.env["AGENTRAIL_FIXTURE_WORKSPACE_ID"] ?? RUNNER_SCORECARD_WORKSPACE_ID;

  const result = await seedRunnerScorecardFixtures(workspaceId);

  console.log("Runner Scorecard (M017) fixtures seeded.");
  console.log(`workspace_id=${workspaceId}`);
  console.log(`cost_events inserted=${result.costEvents}`);
  console.log(`context_packs inserted=${result.contextPacks}`);
  console.log("Runners: claude, codex, gemini");
  console.log(
    `Scorecard path=/dashboard/${workspaceId}/scorecard`
  );

  await defaultClient.close();
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("M017 runner scorecard seed failed:", err);
    process.exit(1);
  });
}
