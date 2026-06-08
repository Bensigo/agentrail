import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRunById } from "@agentrail/db-postgres";

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

  const run = await getRunById(workspaceId, runId);
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const duration =
    run.startedAt && run.finishedAt
      ? Math.round(
          (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000
        )
      : null;

  return NextResponse.json({
    run: {
      id: run.id,
      workspaceId: run.workspaceId,
      repositoryId: run.repositoryId,
      agent: run.agent,
      branch: run.branch,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      duration,
      total_cost: 0, // placeholder; no cost_events table yet
    },
  });
}
