/**
 * Seed script: Runner Scorecard Postgres fixture data (Milestone 017)
 *
 * Inserts runs for 3 distinct agent values (claude, codex, gemini) with
 * deterministic UUIDs matching packages/db-clickhouse/src/seed-runner-scorecard.ts.
 *
 * Run AFTER the main seed.ts to avoid workspace/repo FK failures:
 *   DATABASE_URL=... AGENTRAIL_ALLOW_SEED=1 pnpm --filter @agentrail/db-postgres exec tsx src/seed-runner-scorecard.ts
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

// Keep in sync with packages/db-clickhouse/src/seed-runner-scorecard.ts
const RUNNER_SCORECARD_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const RUNNER_SCORECARD_REPOSITORY_ID = "00000000-0000-0000-0000-000000000010";

const RUNNER_RUN_IDS: Record<string, string[]> = {
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

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://agentrail:agentrail@localhost:5432/agentrail";

/**
 * Deterministic metrics per runner:
 *   claude  → 2/3 success; review_fix on run-1 and run-2
 *   codex   → 3/3 success; review_fix on all 3
 *   gemini  → 1/3 success; review_fix on run-1 only
 */
const RUNNER_CONFIGS: Record<
  string,
  Array<{ status: "success" | "failed"; hasReviewGate: boolean }>
> = {
  claude: [
    { status: "success", hasReviewGate: true },
    { status: "success", hasReviewGate: true },
    { status: "failed", hasReviewGate: false },
  ],
  codex: [
    { status: "success", hasReviewGate: true },
    { status: "success", hasReviewGate: true },
    { status: "success", hasReviewGate: true },
  ],
  gemini: [
    { status: "success", hasReviewGate: true },
    { status: "failed", hasReviewGate: false },
    { status: "failed", hasReviewGate: false },
  ],
};

async function seed() {
  if (process.env["AGENTRAIL_ALLOW_SEED"] !== "1") {
    console.error(
      "Refusing to seed M017 runner scorecard fixtures: set AGENTRAIL_ALLOW_SEED=1."
    );
    process.exit(1);
  }

  const client = postgres(DATABASE_URL);
  const db = drizzle(client, { schema });

  const workspaceId =
    process.env["AGENTRAIL_FIXTURE_WORKSPACE_ID"] ?? RUNNER_SCORECARD_WORKSPACE_ID;

  const now = new Date("2026-06-12T12:00:00Z");

  for (const [runner, runIds] of Object.entries(RUNNER_RUN_IDS)) {
    const configs = RUNNER_CONFIGS[runner] ?? [];

    for (let i = 0; i < runIds.length; i++) {
      const runId = runIds[i]!;
      const config = configs[i] ?? { status: "failed", hasReviewGate: false };
      const startedAt = new Date(now.getTime() - (i + 1) * 60 * 60 * 1000);
      const finishedAt = new Date(startedAt.getTime() + 5 * 60 * 1000);

      await db
        .insert(schema.runs)
        .values({
          id: runId,
          workspaceId,
          repositoryId: RUNNER_SCORECARD_REPOSITORY_ID,
          agent: runner,
          branch: `feat/m017-${runner}-${i + 1}`,
          status: config.status,
          startedAt,
          finishedAt,
        })
        .onConflictDoNothing();

      if (config.hasReviewGate) {
        await db
          .insert(schema.reviewGates)
          .values({
            id: `00000000-0017-00${runner.charCodeAt(0)}-0000-${String(i + 1).padStart(12, "0")}`,
            workspaceId,
            runId,
            gateName: "Verification evidence",
            status: "passed",
            conditions: [{ key: "test_pass_rate", operator: "gte", value: 1.0 }],
            blockingReasons: [],
            evidenceRefs: [],
            evaluatedAt: finishedAt,
          })
          .onConflictDoNothing();
      }
    }
  }

  console.log("Runner Scorecard (M017) Postgres fixtures seeded.");
  console.log(`workspace_id=${workspaceId}`);
  console.log("Runners: claude, codex, gemini (3 runs each)");

  await client.end();
}

seed().catch((err) => {
  console.error("M017 Postgres runner scorecard seed failed:", err);
  process.exit(1);
});
