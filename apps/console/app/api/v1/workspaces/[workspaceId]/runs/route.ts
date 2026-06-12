import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listRunsWithCursor,
} from "@agentrail/db-postgres";
import type { RunStatus } from "@agentrail/db-postgres";
import {
  getRunEventSummaries,
  aggregateWorkspaceCosts,
} from "@agentrail/db-clickhouse";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const statusParam = searchParams.get("status");
  const status =
    statusParam &&
    ["queued", "running", "success", "failed"].includes(statusParam)
      ? (statusParam as RunStatus)
      : undefined;
  const repositoryId = searchParams.get("repository_id") ?? undefined;
  const timeFrom = searchParams.get("time_from");
  const timeTo = searchParams.get("time_to");
  const cursor = searchParams.get("cursor") ?? undefined;
  const limitParam = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 100)
      : 25;

  const { runs, nextCursor } = await listRunsWithCursor(workspaceId, {
    status,
    repositoryId,
    timeFrom: timeFrom ? new Date(timeFrom) : undefined,
    timeTo: timeTo ? new Date(timeTo) : undefined,
    cursor,
    limit,
  });

  // Enrich with ClickHouse event counts (graceful fallback if unavailable)
  const runIds = runs.map((r) => r.id);
  const summaryMap = new Map<
    string,
    { failure_count: number; event_count: number }
  >();
  try {
    const summaries = await getRunEventSummaries(workspaceId, runIds);
    for (const s of summaries) {
      summaryMap.set(s.run_id, {
        failure_count: s.failure_count,
        event_count: s.event_count,
      });
    }
  } catch {
    // ClickHouse unavailable; return zeros
  }

  const costByRun = new Map<string, number>();
  try {
    const costRows = await aggregateWorkspaceCosts(workspaceId, {
      groupBy: "run",
    });
    for (const row of costRows) {
      costByRun.set(row.entity_id, row.total_cost_usd);
    }
  } catch {
    // ClickHouse unavailable; costs render as zero
  }

  const enriched = runs.map((run) => {
    const summary = summaryMap.get(run.id) ?? {
      failure_count: 0,
      event_count: 0,
    };
    const duration =
      run.startedAt && run.finishedAt
        ? Math.round(
            (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000
          )
        : null;
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      repositoryId: run.repositoryId,
      agent: run.agent,
      branch: run.branch,
      title: run.title ?? null,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      duration,
      failure_count: summary.failure_count,
      total_cost: costByRun.get(run.id) ?? 0,
    };
  });

  return NextResponse.json({ runs: enriched, nextCursor });
}
