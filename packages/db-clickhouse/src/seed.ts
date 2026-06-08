import { client } from "./client";
import type { TelemetryEventRecord, FailureEventRecord } from "./schema";

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
  await client.close();
  console.log("ClickHouse seed complete.");
}

main().catch((err) => {
  console.error("ClickHouse seed failed:", err);
  process.exit(1);
});
