import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRun, getRepository } from "@agentrail/db-postgres";
import { getRunEvents, getRunCosts } from "@agentrail/db-clickhouse";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const run = await getRun(workspaceId, runId);
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const duration =
    run.startedAt && run.finishedAt
      ? Math.round(
          (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000
        )
      : null;

  // Repository name for the header (falls back to the id if lookup fails).
  let repositoryName: string | null = null;
  try {
    const repo = await getRepository(workspaceId, run.repositoryId);
    repositoryName = repo?.name ?? null;
  } catch {
    // Postgres unavailable; header falls back to the id
  }

  let events: Awaited<ReturnType<typeof getRunEvents>> = [];
  try {
    events = await getRunEvents(workspaceId, runId);
  } catch {
    // ClickHouse unavailable; return empty timeline
  }

  let totalCost = 0;
  try {
    const costRows = await getRunCosts(workspaceId, runId);
    totalCost = costRows.reduce((acc, r) => acc + r.cost_usd, 0);
  } catch {
    // ClickHouse unavailable; cost renders as zero
  }

  return NextResponse.json({
    run: {
      id: run.id,
      workspaceId: run.workspaceId,
      repositoryId: run.repositoryId,
      repository_name: repositoryName,
      agent: run.agent,
      branch: run.branch,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      duration,
      total_cost: totalCost,
    },
    events: events.map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      phase: e.phase,
      severity: e.severity,
      occurred_at: e.occurred_at,
      payload: e.payload,
    })),
  });
}
