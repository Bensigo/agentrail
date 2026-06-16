import { NextRequest, NextResponse } from "next/server";
import {
  recordRunnerResult,
  touchApiKeyLastUsed,
  type RunnerStatus,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const RUNNER_STATUSES: readonly RunnerStatus[] = [
  "green",
  "red",
  "error",
  "running",
];

function isRunnerStatus(value: unknown): value is RunnerStatus {
  return (
    typeof value === "string" &&
    (RUNNER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Runner result report. Bearer-authenticated with the runner token. Maps the
 * runner status onto the queue state-machine (green→green terminal, red→queued
 * for retry, error→blocked, running→running) and updates the queue entry.
 *
 * NOTE: this updates `queue_entries` only — it does NOT write a `runs` row.
 * The `runs` table requires a `repository_id` (text, not nullable) plus agent /
 * branch fields that aren't part of this result payload, and run-registration is
 * already owned by the dedicated ingest endpoints (`/api/v1/ingest/run-events`,
 * `/api/v1/ingest/runs`). Cost/visibility flows through those; folding a partial
 * run write in here would create under-specified `runs` rows. See report.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    workspace_id?: string;
    status?: string;
    cost_usd?: number;
    branch?: string;
    gate_reason?: string;
    logs_tail?: string;
  };

  const { id, workspace_id, status } = body;
  if (!id || !workspace_id || !status) {
    return NextResponse.json(
      { error: "id, workspace_id and status are required" },
      { status: 400 }
    );
  }

  if (auth.workspaceId !== workspace_id) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  if (!isRunnerStatus(status)) {
    return NextResponse.json(
      { error: "status must be one of green, red, error, running" },
      { status: 400 }
    );
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  const updated = await recordRunnerResult({
    id,
    workspaceId: workspace_id,
    status,
  });
  if (!updated) {
    return NextResponse.json(
      { error: "Queue entry not found in this workspace" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
