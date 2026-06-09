import { client } from "./client";
import type {
  TelemetryEventRecord,
  FailureEventRecord,
  ContextPackRecord,
  ContextEventRecord,
  IndexSnapshotRecord,
} from "./schema";

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

  const failures: FailureEventRecord[] = [
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      repository_id: "bensigo/agentrail",
      failure_type: "tool_error",
      message: "Bash command timed out after 120s",
      evidence: JSON.stringify({
        command: "pnpm tsc --noEmit",
        exit_code: null,
        stderr: "Command timed out",
        stdout: "",
      }),
      phase: "execute",
      severity: "high",
      occurred_at: new Date("2026-06-08T08:04:00.000Z"),
      event_id: "fail-001",
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-002",
      repository_id: "bensigo/agentrail",
      failure_type: "context_error",
      message: "Required source file not found in context pack",
      evidence: JSON.stringify({
        missing_file: "apps/console/app/api/v1/workspaces/route.ts",
        pack_id: "pack-abc123",
        phase: "plan",
      }),
      phase: "plan",
      severity: "medium",
      occurred_at: new Date("2026-06-08T09:02:00.000Z"),
      event_id: "fail-002",
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-002",
      repository_id: "bensigo/agentrail",
      failure_type: "auth_error",
      message: "GitHub token expired during PR creation",
      evidence: JSON.stringify({
        step: "create_pr",
        http_status: 401,
        error: "Bad credentials",
      }),
      phase: "verify",
      severity: "critical",
      occurred_at: new Date("2026-06-08T09:10:00.000Z"),
      event_id: "fail-003",
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      repository_id: "bensigo/agentrail",
      failure_type: "lint_error",
      message: "ESLint: 3 errors found in modified files",
      evidence: JSON.stringify({
        errors: [
          { file: "apps/console/app/page.tsx", line: 12, rule: "no-unused-vars" },
          { file: "apps/console/app/layout.tsx", line: 4, rule: "@typescript-eslint/no-explicit-any" },
        ],
      }),
      phase: "execute",
      severity: "low",
      occurred_at: new Date("2026-06-08T08:01:30.000Z"),
      event_id: "fail-004",
    },
  ];

  await client.insert({
    table: "failure_events",
    values: failures.map((f) => ({
      ...f,
      occurred_at: f.occurred_at.toISOString().replace("T", " ").replace("Z", ""),
    })),
    format: "JSONEachRow",
  });

  console.log(`Inserted ${failures.length} sample failure_events.`);

  // Seed context_packs
  const contextPacks: ContextPackRecord[] = [
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      context_pack_id: "pack-001",
      token_budget: 16000,
      tokens_used: 11432,
      anchors_extracted: 5,
      sources_considered: 23,
      occurred_at: new Date("2026-06-08T08:01:00.000Z"),
    },
  ];

  await client.insert({
    table: "context_packs",
    values: contextPacks.map((p) => ({
      ...p,
      occurred_at: p.occurred_at.toISOString().replace("T", " ").replace("Z", ""),
    })),
    format: "JSONEachRow",
  });
  console.log(`Inserted ${contextPacks.length} sample context_packs.`);

  // Seed context_events
  const contextEvents: ContextEventRecord[] = [
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      context_pack_id: "pack-001",
      item_path: "packages/db-clickhouse/src/schema.ts",
      item_hash: "abc123",
      included: 1,
      citation: "issue #215 references ClickHouse schema",
      reason: "Directly referenced by task; high code-graph authority.",
      score: 0.97,
      occurred_at: new Date("2026-06-08T08:01:00.100Z"),
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      context_pack_id: "pack-001",
      item_path: "packages/db-clickhouse/src/queries.ts",
      item_hash: "def456",
      included: 1,
      citation: "code graph: imported by schema.ts consumers",
      reason: "Direct import dependency of schema.ts in execution path.",
      score: 0.91,
      occurred_at: new Date("2026-06-08T08:01:00.200Z"),
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      context_pack_id: "pack-001",
      item_path: "apps/console/app/api/v1/workspaces/[workspaceId]/runs/route.ts",
      item_hash: "ghi789",
      included: 1,
      citation: "issue #215 requires API route for context-packs",
      reason: "Existing sibling route; pattern reference for auth guard.",
      score: 0.88,
      occurred_at: new Date("2026-06-08T08:01:00.300Z"),
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      context_pack_id: "pack-001",
      item_path: "agentrail/context/packs.py",
      item_hash: "jkl012",
      included: 0,
      citation: "",
      reason: "Python server-side context compiler; out of scope for this task (JS console only).",
      score: 0.0,
      occurred_at: new Date("2026-06-08T08:01:00.400Z"),
    },
    {
      workspace_id: "dev-workspace",
      run_id: "run-001",
      context_pack_id: "pack-001",
      item_path: "docs/adr/0005-postgres-clickhouse-ingestion-storage.md",
      item_hash: "mno345",
      included: 0,
      citation: "",
      reason: "ADR already read in plan phase; excluded to stay within token budget.",
      score: 0.0,
      occurred_at: new Date("2026-06-08T08:01:00.500Z"),
    },
  ];

  await client.insert({
    table: "context_events",
    values: contextEvents.map((e) => ({
      ...e,
      occurred_at: e.occurred_at.toISOString().replace("T", " ").replace("Z", ""),
    })),
    format: "JSONEachRow",
  });
  console.log(`Inserted ${contextEvents.length} sample context_events.`);

  // Seed index_snapshots with varied ages: green (<1h), stale (12h), critical (>24h)
  const DEV_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
  const now = new Date("2026-06-09T08:00:00.000Z");
  const indexSnapshots: IndexSnapshotRecord[] = [
    {
      workspace_id: DEV_WORKSPACE_ID,
      repository_id: "00000000-0000-0000-0000-000000000010",
      commit_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      indexed_at: new Date(now.getTime() - 30 * 60 * 1000), // 30 min ago — healthy
      source_count: 284,
      graph_edge_count: 1423,
      event_id: "snap-001",
    },
    {
      workspace_id: DEV_WORKSPACE_ID,
      repository_id: "00000000-0000-0000-0000-000000000011",
      commit_sha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      indexed_at: new Date(now.getTime() - 12 * 60 * 60 * 1000), // 12h ago — stale
      source_count: 91,
      graph_edge_count: 342,
      event_id: "snap-002",
    },
    {
      workspace_id: DEV_WORKSPACE_ID,
      repository_id: "00000000-0000-0000-0000-000000000012",
      commit_sha: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      indexed_at: new Date(now.getTime() - 48 * 60 * 60 * 1000), // 48h ago — critical
      source_count: 17,
      graph_edge_count: 58,
      event_id: "snap-003",
    },
  ];

  await client.insert({
    table: "index_snapshots",
    values: indexSnapshots.map((s) => ({
      ...s,
      indexed_at:
        s.indexed_at instanceof Date
          ? s.indexed_at.toISOString().replace("T", " ").replace("Z", "")
          : String(s.indexed_at),
    })),
    format: "JSONEachRow",
  });
  console.log(`Inserted ${indexSnapshots.length} sample index_snapshots.`);

  await client.close();
  console.log("ClickHouse seed complete.");
}

main().catch((err) => {
  console.error("ClickHouse seed failed:", err);
  process.exit(1);
});
