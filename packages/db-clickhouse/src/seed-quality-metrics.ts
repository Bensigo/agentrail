import { client } from "./client";
import type { ContextPackRecord, TelemetryEventRecord, IndexSnapshotRecord } from "./schema";

// ---------------------------------------------------------------------------
// Guard: only run against throwaway local databases.
// ---------------------------------------------------------------------------
if (process.env.AGENTRAIL_ALLOW_SEED !== "1") {
  console.error(
    "Refusing to seed: set AGENTRAIL_ALLOW_SEED=1 to seed a throwaway local database. " +
      "Never seed the linked instance — the dashboard uses real run data only."
  );
  process.exit(1);
}

const workspaceId = process.env.SEED_WORKSPACE_ID;
const repositoryId = process.env.SEED_REPOSITORY_ID;

if (!workspaceId || !repositoryId) {
  console.error(
    "Missing required env vars. Set SEED_WORKSPACE_ID and SEED_REPOSITORY_ID before running."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const now = new Date();

/** Return a Date that is `n` days before now, at midnight UTC + given hours. */
function daysAgo(n: number, hourUtc = 8): Date {
  const d = new Date(now.getTime() - n * MS_PER_DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** Format a Date as the ClickHouse DateTime64 string expected by seed.ts. */
function fmtDate(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** Generate a deterministic fake SHA list for a run (all lists are distinct). */
function hashList(prefix: string, i: number): string[] {
  return [
    `${prefix}-${i}-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`,
    `${prefix}-${i}-b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3`,
    `${prefix}-${i}-c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`,
  ];
}

// ---------------------------------------------------------------------------
// Scenario A — "Stable"
// 10 runs spread evenly over days -30..-3.
// precision_at_budget ≈ 0.85 ± 0.02, citation_coverage ≈ 0.90 ± 0.02.
// stale_count = 1–2, denied_count = 0.
// ---------------------------------------------------------------------------

const STABLE_DAYS_AGO = [30, 27, 24, 21, 18, 15, 12, 9, 6, 3];
const STABLE_PRECISION = [0.85, 0.84, 0.86, 0.83, 0.87, 0.85, 0.84, 0.86, 0.85, 0.87];
const STABLE_COVERAGE = [0.90, 0.89, 0.91, 0.88, 0.92, 0.90, 0.89, 0.91, 0.90, 0.92];
const STABLE_STALE = [1, 2, 1, 1, 2, 1, 2, 1, 1, 2];

// ---------------------------------------------------------------------------
// Scenario B — "Regressing"
// 10 runs over 30 days.
//   - First 7 runs: precision_at_budget ≈ 0.85, spread over days -28..-10.
//   - Last 3 runs: precision_at_budget ≈ 0.60 (> 5 pp drop), all on day -1.
//     (No Scenario A run on day -1, so day -1 is the sole "latest day".)
// ---------------------------------------------------------------------------

const REGRESS_EARLY_DAYS_AGO = [28, 25, 22, 19, 16, 13, 10];
const REGRESS_EARLY_PRECISION = [0.85, 0.84, 0.86, 0.85, 0.85, 0.84, 0.86];
const REGRESS_EARLY_COVERAGE = [0.90, 0.89, 0.91, 0.90, 0.90, 0.89, 0.91];

const REGRESS_LATE_DAYS_AGO = [1, 1, 1]; // all on the most recent day
const REGRESS_LATE_PRECISION = [0.61, 0.60, 0.59];
const REGRESS_LATE_COVERAGE = [0.90, 0.89, 0.91];

// ---------------------------------------------------------------------------
// Build context_packs rows
// ---------------------------------------------------------------------------

const contextPacks: ContextPackRecord[] = [];

// Scenario A
for (let i = 0; i < STABLE_DAYS_AGO.length; i++) {
  const runId = `qmfix-stable-${String(i).padStart(2, "0")}`;
  contextPacks.push({
    workspace_id: workspaceId,
    run_id: runId,
    context_pack_id: `pack-${runId}`,
    token_budget: 16000,
    tokens_used: 12000 + i * 100,
    tokens_saved: 2000 + i * 50,
    anchors_extracted: 5 + (i % 3),
    sources_considered: 20 + i,
    precision_at_budget: STABLE_PRECISION[i]!,
    citation_coverage: STABLE_COVERAGE[i]!,
    stale_count: STABLE_STALE[i]!,
    denied_count: 0,
    source_hash_list: hashList("stable", i),
    occurred_at: daysAgo(STABLE_DAYS_AGO[i]!),
  });
}

// Scenario B — early runs (precision ≈ 0.85)
for (let i = 0; i < REGRESS_EARLY_DAYS_AGO.length; i++) {
  const runId = `qmfix-regress-early-${String(i).padStart(2, "0")}`;
  contextPacks.push({
    workspace_id: workspaceId,
    run_id: runId,
    context_pack_id: `pack-${runId}`,
    token_budget: 16000,
    tokens_used: 11500 + i * 120,
    tokens_saved: 1800 + i * 60,
    anchors_extracted: 4 + (i % 3),
    sources_considered: 18 + i,
    precision_at_budget: REGRESS_EARLY_PRECISION[i]!,
    citation_coverage: REGRESS_EARLY_COVERAGE[i]!,
    stale_count: 1 + (i % 2),
    denied_count: 0,
    source_hash_list: hashList("regress-early", i),
    occurred_at: daysAgo(REGRESS_EARLY_DAYS_AGO[i]!),
  });
}

// Scenario B — late runs (precision ≈ 0.60, day -1, trigger regression)
for (let i = 0; i < REGRESS_LATE_DAYS_AGO.length; i++) {
  const runId = `qmfix-regress-late-${String(i).padStart(2, "0")}`;
  // Stagger hours within the same day so rows have distinct timestamps.
  const hour = 8 + i * 2;
  contextPacks.push({
    workspace_id: workspaceId,
    run_id: runId,
    context_pack_id: `pack-${runId}`,
    token_budget: 16000,
    tokens_used: 9000 + i * 200,
    tokens_saved: 1200 + i * 40,
    anchors_extracted: 3 + (i % 2),
    sources_considered: 15 + i,
    precision_at_budget: REGRESS_LATE_PRECISION[i]!,
    citation_coverage: REGRESS_LATE_COVERAGE[i]!,
    stale_count: 2,
    denied_count: 0,
    source_hash_list: hashList("regress-late", i),
    occurred_at: daysAgo(REGRESS_LATE_DAYS_AGO[i]!, hour),
  });
}

// ---------------------------------------------------------------------------
// Build run_events rows (one per context_pack run, needed for repo filter)
// ---------------------------------------------------------------------------

const runEvents: TelemetryEventRecord[] = contextPacks.map((pack) => ({
  workspace_id: workspaceId,
  repository_id: repositoryId,
  run_id: pack.run_id,
  agent: "claude",
  phase: "execute",
  event_type: "run.started",
  severity: "info",
  occurred_at: pack.occurred_at,
  event_id: `evt-${pack.run_id}`,
  submission_kind: "issue",
  payload: JSON.stringify({ seed: "quality-metrics-fixture" }),
  session_id: "",
  seq: 0,
}));

// ---------------------------------------------------------------------------
// Build index_snapshots row (7 days old, drives deterministic snapshot component)
// ---------------------------------------------------------------------------

const indexSnapshot: IndexSnapshotRecord = {
  workspace_id: workspaceId,
  repository_id: repositoryId,
  commit_sha: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
  indexed_at: daysAgo(7),
  source_count: 180,
  graph_edge_count: 820,
  event_id: `snap-qmfix-${workspaceId}`,
};

// ---------------------------------------------------------------------------
// Rot score range computation (printed to stdout, not measured)
//
// rot_score = round((0.4 * memory + 0.4 * snapshot + 0.2 * churn) * 100)
//
// Churn component (20% weight):
//   All 20 runs have distinct source_hash_lists.
//   churnDecay = min((20 - 1) / (20 - 1), 1.0) = 1.0
//   churnPts = 1.0 * 20 = 20 pts (deterministic)
//
// Snapshot component (40% weight):
//   indexedAt = 7 days ago, thresholdDays = 30
//   snapshotDecay = min(7 / 30, 1.0) ≈ 0.233
//   snapshotPts = 0.233 * 40 ≈ 9 pts (deterministic at seed time; drifts ~1.3 pts/day)
//
// Memory component (40% weight):
//   Reads live Postgres memory_items — environment-dependent.
//   Range: 0 pts (no memory items) to 40 pts (all items fully stale).
//
// Total range:
//   Low  (no memory):   round((0 + 0.4 * 7/30 + 0.2 * 1.0) * 100) = 29
//   High (full memory): round((0.4 + 0.4 * 7/30 + 0.2 * 1.0) * 100) = 69
// ---------------------------------------------------------------------------

const CHURN_DECAY = (20 - 1) / Math.max(20 - 1, 1); // = 1.0
const SNAPSHOT_DECAY = Math.min(7 / 30, 1.0); // ≈ 0.2333
const ROT_LOW = Math.round((0.4 * 0 + 0.4 * SNAPSHOT_DECAY + 0.2 * CHURN_DECAY) * 100);
const ROT_HIGH = Math.round((0.4 * 1.0 + 0.4 * SNAPSHOT_DECAY + 0.2 * CHURN_DECAY) * 100);

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Seeding quality metrics fixture data...`);
  console.log(`  workspace_id:  ${workspaceId}`);
  console.log(`  repository_id: ${repositoryId}`);
  console.log(`  now:           ${now.toISOString()}`);
  console.log("");

  // Insert context_packs
  await client.insert({
    table: "context_packs",
    values: contextPacks.map((p) => ({
      ...p,
      repository_id: repositoryId,
      occurred_at: fmtDate(p.occurred_at instanceof Date ? p.occurred_at : new Date(p.occurred_at)),
    })),
    format: "JSONEachRow",
  });
  console.log(`Inserted ${contextPacks.length} context_packs rows (10 Stable + 10 Regressing).`);

  // Insert run_events (needed for repository_id filter in getQualityMetrics)
  await client.insert({
    table: "run_events",
    values: runEvents.map((e) => ({
      ...e,
      occurred_at: fmtDate(e.occurred_at instanceof Date ? e.occurred_at : new Date(e.occurred_at)),
    })),
    format: "JSONEachRow",
  });
  console.log(`Inserted ${runEvents.length} run_events rows.`);

  // Insert index_snapshots
  await client.insert({
    table: "index_snapshots",
    values: [
      {
        ...indexSnapshot,
        indexed_at: fmtDate(
          indexSnapshot.indexed_at instanceof Date
            ? indexSnapshot.indexed_at
            : new Date(indexSnapshot.indexed_at)
        ),
      },
    ],
    format: "JSONEachRow",
  });
  console.log(`Inserted 1 index_snapshots row (indexed 7 days ago).`);

  await client.close();

  console.log("");
  console.log("--- Expected regression flags ---");
  console.log("  precision_at_budget : REGRESSION expected (Scenario B, latest day avg ≈ 0.60 vs baseline median ≈ 0.85)");
  console.log("  citation_coverage   : stable (no regression expected)");
  console.log("  stale_count         : stable (no regression expected)");
  console.log("  denied_count        : stable — all zeros (no regression expected)");
  console.log("");
  console.log("--- Rot score range ---");
  console.log(
    `  churn component  : 20 pts (20 distinct source_hash_lists → decay = 1.0, deterministic)`
  );
  console.log(
    `  snapshot component: ~9 pts (index snapshot 7 days old / 30-day threshold, drifts ~1.3 pts/day)`
  );
  console.log(
    `  memory component : 0–40 pts (live Postgres memory_items, environment-dependent)`
  );
  console.log(`  Rot score range  : ${ROT_LOW}–${ROT_HIGH} pts`);
  console.log("");
  console.log(
    `Seeded 20 context_packs rows. Expected: regression on precision_at_budget (Scenario B). Rot score range: ${ROT_LOW}–${ROT_HIGH}.`
  );
  console.log("");
  console.log(
    "NOTE: Re-running this script inserts duplicate rows (MergeTree, no automatic dedupe).\n" +
      "      Run IDs use the prefix 'qmfix-' so duplicate rows are identifiable.\n" +
      "      This is a throwaway-DB tool — acceptable limitation."
  );
}

main().catch((err) => {
  console.error("seed-quality-metrics failed:", err);
  process.exit(1);
});
