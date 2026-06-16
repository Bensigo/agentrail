import { pathToFileURL } from "url";
import { client as defaultClient } from "./client";
import type {
  ContextEventRecord,
  ContextPackRecord,
  CostEventRecord,
  FailureEventRecord,
  IndexSnapshotRecord,
  TelemetryEventRecord,
} from "./schema";

export const MILESTONE_016_WORKSPACE_ID =
  "00000000-0000-0000-0000-000000000001";
export const MILESTONE_016_MISSING_COST_RUN_ID =
  "00000000-0000-0000-0000-000000000563";
export const MILESTONE_016_COST_ANOMALY_RUN_ID =
  "00000000-0000-0000-0000-000000001563";

const REPOSITORY_ID = "fixture-repo";
const MODEL = "claude-sonnet-4-6";
const PHASE = "execute";
const TEAM_ID = "fixture-team";
const API_KEY_ID = "fixture-api-key";

export type Milestone016SeedTable =
  | "run_events"
  | "cost_events"
  | "failure_events"
  | "context_packs"
  | "context_events"
  | "index_snapshots";

type QueryJsonResult = {
  json<T>(): Promise<T[]>;
};

export type Milestone016SeedClient = {
  query(args: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }): Promise<QueryJsonResult>;
  insert(args: {
    table: Milestone016SeedTable;
    values: Array<Record<string, unknown>>;
    format: "JSONEachRow";
  }): Promise<unknown>;
};

export interface BuildMilestone016FixturesOptions {
  workspaceId?: string;
  now?: Date;
}

export interface Milestone016Fixtures {
  workspaceId: string;
  missingTelemetryRunId: string;
  costAnomalyRunId: string;
  runEvents: TelemetryEventRecord[];
  costEvents: CostEventRecord[];
  failureEvents: FailureEventRecord[];
  contextPacks: ContextPackRecord[];
  contextEvents: ContextEventRecord[];
  indexSnapshots: IndexSnapshotRecord[];
}

export interface Milestone016SeedResult extends Milestone016Fixtures {
  inserted: Record<Milestone016SeedTable, number>;
}

const TABLE_ID_COLUMNS: Record<Milestone016SeedTable, string> = {
  run_events: "event_id",
  cost_events: "event_id",
  failure_events: "event_id",
  context_packs: "context_pack_id",
  context_events: "context_pack_id",
  index_snapshots: "event_id",
};

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function clickHouseDate(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function toClickHouseRows(rows: object[]): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [
        key,
        value instanceof Date ? clickHouseDate(value) : value,
      ])
    )
  );
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStddev(values: number[], avg: number): number {
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function eventId(...parts: string[]): string {
  return `m016-${parts.join("-")}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function runEvent({
  workspaceId,
  runId,
  eventType,
  seq,
  occurredAt,
  submissionKind = "run",
  phase = PHASE,
  severity = "info",
  payload = {},
}: {
  workspaceId: string;
  runId: string;
  eventType: string;
  seq: number;
  occurredAt: Date;
  submissionKind?: string;
  phase?: string;
  severity?: string;
  payload?: Record<string, unknown>;
}): TelemetryEventRecord {
  return {
    workspace_id: workspaceId,
    repository_id: REPOSITORY_ID,
    run_id: runId,
    agent: "codex",
    phase,
    event_type: eventType,
    severity,
    occurred_at: occurredAt,
    event_id: eventId(runId, String(seq), eventType),
    submission_kind: submissionKind,
    payload: JSON.stringify(payload),
    session_id: runId,
    seq,
  };
}

function costEvent({
  workspaceId,
  runId,
  eventId,
  costUsd,
  occurredAt,
}: {
  workspaceId: string;
  runId: string;
  eventId: string;
  costUsd: number;
  occurredAt: Date;
}): CostEventRecord {
  return {
    workspace_id: workspaceId,
    run_id: runId,
    repository_id: REPOSITORY_ID,
    team_id: TEAM_ID,
    api_key_id: API_KEY_ID,
    cost_type: "model_call",
    phase: PHASE,
    input_tokens: 2_000,
    output_tokens: 1_000,
    cache_tokens: 250,
    cache_creation_tokens: 0,
    tokens: 3_250,
    cost_usd: costUsd,
    model: MODEL,
    occurred_at: occurredAt,
    event_id: eventId,
  };
}

function buildMissingTelemetryScenario(
  workspaceId: string,
  now: Date
): Pick<
  Milestone016Fixtures,
  "runEvents" | "failureEvents" | "contextPacks" | "contextEvents" | "indexSnapshots"
> {
  const runId = MILESTONE_016_MISSING_COST_RUN_ID;
  const startedAt = addMs(now, -30 * 60 * 1000);
  const contextPackId = eventId(runId, "context-pack");

  const runEvents = [
    runEvent({
      workspaceId,
      runId,
      eventType: "run_start",
      seq: 0,
      occurredAt: startedAt,
      payload: { issue: 563, fixture: "missing-cost" },
    }),
    runEvent({
      workspaceId,
      runId,
      eventType: "context_pack",
      seq: 1,
      occurredAt: addMs(startedAt, 1_000),
      submissionKind: "context_pack",
      payload: { context_pack_id: contextPackId },
    }),
    runEvent({
      workspaceId,
      runId,
      eventType: "review_gate.passed",
      seq: 2,
      occurredAt: addMs(startedAt, 2_000),
      submissionKind: "review_gate",
      payload: { gate_type: "verification", status: "passed" },
    }),
    runEvent({
      workspaceId,
      runId,
      eventType: "failure_event",
      seq: 3,
      occurredAt: addMs(startedAt, 3_000),
      submissionKind: "failure_event",
      severity: "warning",
      payload: { failure_type: "fixture_warning" },
    }),
    runEvent({
      workspaceId,
      runId,
      eventType: "memory_items.pushed",
      seq: 4,
      occurredAt: addMs(startedAt, 4_000),
      submissionKind: "memory",
      payload: { count: 1 },
    }),
    runEvent({
      workspaceId,
      runId,
      eventType: "index_snapshot",
      seq: 5,
      occurredAt: addMs(startedAt, 5_000),
      submissionKind: "index_snapshot",
      payload: { repository_id: REPOSITORY_ID },
    }),
    runEvent({
      workspaceId,
      runId,
      eventType: "outbox_flushed",
      seq: 6,
      occurredAt: addMs(startedAt, 6_000),
      submissionKind: "outbox",
      payload: { pending_before: 7, pending_after: 0 },
    }),
  ];

  const contextPacks: ContextPackRecord[] = [
    {
      workspace_id: workspaceId,
      run_id: runId,
      context_pack_id: contextPackId,
      token_budget: 16_000,
      tokens_used: 8_200,
      tokens_saved: 41_000,
      anchors_extracted: 6,
      sources_considered: 23,
      precision_at_budget: 1,
      citation_coverage: 1,
      stale_count: 0,
      denied_count: 0,
      source_hash_list: ["sha256:m016-context-pack"],
      occurred_at: addMs(startedAt, 1_000),
    },
  ];

  const contextEvents: ContextEventRecord[] = [
    {
      workspace_id: workspaceId,
      run_id: runId,
      context_pack_id: contextPackId,
      item_path: "packages/db-clickhouse/src/seed-milestone-016.ts",
      item_hash: "sha256:m016-seed",
      included: 1,
      citation: "issue #563 fixture context",
      reason: "M016 fixture seed script verification target.",
      score: 1,
      occurred_at: addMs(startedAt, 1_100),
    },
  ];

  const failureEvents: FailureEventRecord[] = [
    {
      workspace_id: workspaceId,
      run_id: runId,
      repository_id: REPOSITORY_ID,
      failure_type: "fixture_warning",
      message: "Synthetic warning keeps failure_event health signal green.",
      normalized_error: "synthetic warning keeps failure_event health signal green.",
      fingerprint: "sha256:m016-fixture-warning",
      evidence: JSON.stringify({ fixture: "m016-missing-cost" }),
      phase: PHASE,
      severity: "low",
      occurred_at: addMs(startedAt, 3_000),
      event_id: eventId(runId, "failure-event"),
    },
  ];

  const indexSnapshots: IndexSnapshotRecord[] = [
    {
      workspace_id: workspaceId,
      repository_id: REPOSITORY_ID,
      commit_sha: "0160160160160160160160160160160160160160",
      indexed_at: addMs(startedAt, -5 * 60 * 1000),
      source_count: 128,
      graph_edge_count: 512,
      event_id: eventId(runId, "index-snapshot"),
    },
  ];

  return { runEvents, failureEvents, contextPacks, contextEvents, indexSnapshots };
}

function buildCostAnomalyScenario(workspaceId: string, now: Date) {
  const anomalyRunId = MILESTONE_016_COST_ANOMALY_RUN_ID;
  const baselineCosts = Array.from({ length: 30 }, (_, index) =>
    index % 2 === 0 ? 0.049 : 0.051
  );
  const baselineMean = mean(baselineCosts);
  const baselineStddev = populationStddev(baselineCosts, baselineMean);
  const observedCost = 0.5;
  const deviationSigmas = (observedCost - baselineMean) / baselineStddev;
  const startedAt = addMs(now, -10 * 60 * 1000);

  const costEvents = baselineCosts.map((costUsd, index) =>
    costEvent({
      workspaceId,
      runId: `fixture-016-cost-baseline-${String(index + 1).padStart(2, "0")}`,
      eventId: eventId("cost-baseline", String(index + 1).padStart(2, "0")),
      costUsd,
      occurredAt: addMs(startedAt, index * 1_000),
    })
  );
  costEvents.push(
    costEvent({
      workspaceId,
      runId: anomalyRunId,
      eventId: eventId(anomalyRunId, "cost-observed"),
      costUsd: observedCost,
      occurredAt: addMs(startedAt, 31_000),
    })
  );

  const runEvents = [
    runEvent({
      workspaceId,
      runId: anomalyRunId,
      eventType: "run_start",
      seq: 0,
      occurredAt: startedAt,
      payload: { issue: 563, fixture: "cost-anomaly" },
    }),
    runEvent({
      workspaceId,
      runId: anomalyRunId,
      eventType: "cost_anomaly",
      seq: 1,
      occurredAt: addMs(startedAt, 31_000),
      submissionKind: "cost",
      payload: {
        model: MODEL,
        phase: PHASE,
        repository_id: REPOSITORY_ID,
        cost_usd: observedCost,
        mean: baselineMean,
        stddev: baselineStddev,
        deviation_sigmas: deviationSigmas,
        baseline_window_days: 30,
      },
    }),
  ];

  return { runEvents, costEvents };
}

export function buildMilestone016Fixtures(
  options: BuildMilestone016FixturesOptions = {}
): Milestone016Fixtures {
  const workspaceId = options.workspaceId ?? MILESTONE_016_WORKSPACE_ID;
  const now = options.now ?? new Date();
  const missingTelemetry = buildMissingTelemetryScenario(workspaceId, now);
  const costAnomaly = buildCostAnomalyScenario(workspaceId, now);

  return {
    workspaceId,
    missingTelemetryRunId: MILESTONE_016_MISSING_COST_RUN_ID,
    costAnomalyRunId: MILESTONE_016_COST_ANOMALY_RUN_ID,
    runEvents: [...missingTelemetry.runEvents, ...costAnomaly.runEvents],
    costEvents: costAnomaly.costEvents,
    failureEvents: missingTelemetry.failureEvents,
    contextPacks: missingTelemetry.contextPacks,
    contextEvents: missingTelemetry.contextEvents,
    indexSnapshots: missingTelemetry.indexSnapshots,
  };
}

async function insertMissingRows(
  ch: Milestone016SeedClient,
  table: Milestone016SeedTable,
  rows: Array<Record<string, unknown>>
): Promise<number> {
  if (rows.length === 0) return 0;

  const idColumn = TABLE_ID_COLUMNS[table];
  const paramName = idColumn === "context_pack_id" ? "packIds" : "eventIds";
  const requestedIds = [
    ...new Set(rows.map((row) => String(row[idColumn])).filter(Boolean)),
  ];
  const result = await ch.query({
    query: `
      SELECT ${table === "context_events" ? "DISTINCT " : ""}${idColumn}
      FROM ${table}
      WHERE ${idColumn} IN ({${paramName}: Array(String)})
    `,
    query_params: { [paramName]: requestedIds },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await result.json<Record<string, unknown>>()).map((row) =>
      String(row[idColumn])
    )
  );
  const toInsert = rows.filter((row) => !existing.has(String(row[idColumn])));
  if (toInsert.length === 0) return 0;

  await ch.insert({
    table,
    values: toInsert,
    format: "JSONEachRow",
  });
  return toInsert.length;
}

export async function seedMilestone016Fixtures(
  ch: Milestone016SeedClient = defaultClient,
  options: BuildMilestone016FixturesOptions = {}
): Promise<Milestone016SeedResult> {
  const fixtures = buildMilestone016Fixtures(options);
  const inserted: Record<Milestone016SeedTable, number> = {
    run_events: await insertMissingRows(
      ch,
      "run_events",
      toClickHouseRows(fixtures.runEvents)
    ),
    context_packs: await insertMissingRows(
      ch,
      "context_packs",
      toClickHouseRows(fixtures.contextPacks)
    ),
    context_events: await insertMissingRows(
      ch,
      "context_events",
      toClickHouseRows(fixtures.contextEvents)
    ),
    failure_events: await insertMissingRows(
      ch,
      "failure_events",
      toClickHouseRows(fixtures.failureEvents)
    ),
    index_snapshots: await insertMissingRows(
      ch,
      "index_snapshots",
      toClickHouseRows(fixtures.indexSnapshots)
    ),
    cost_events: await insertMissingRows(
      ch,
      "cost_events",
      toClickHouseRows(fixtures.costEvents)
    ),
  };

  return { ...fixtures, inserted };
}

async function main() {
  if (process.env.AGENTRAIL_ALLOW_SEED !== "1") {
    console.error(
      "Refusing to seed M016 fixtures: set AGENTRAIL_ALLOW_SEED=1 for a throwaway local database."
    );
    process.exit(1);
  }

  const result = await seedMilestone016Fixtures(defaultClient, {
    workspaceId:
      process.env.AGENTRAIL_FIXTURE_WORKSPACE_ID ??
      MILESTONE_016_WORKSPACE_ID,
  });

  console.log("Milestone 016 fixtures seeded.");
  console.log(`workspace_id=${result.workspaceId}`);
  console.log(`missing_telemetry_run_id=${result.missingTelemetryRunId}`);
  console.log(`cost_anomaly_run_id=${result.costAnomalyRunId}`);
  console.log(
    `run_detail_path=/dashboard/${result.workspaceId}/runs/${result.missingTelemetryRunId}`
  );
  console.log(`costs_path=/dashboard/${result.workspaceId}/costs`);
  console.log(`inserted=${JSON.stringify(result.inserted)}`);

  await defaultClient.close();
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("M016 fixture seed failed:", err);
    process.exit(1);
  });
}
