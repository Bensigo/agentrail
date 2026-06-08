import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { listWorkspaceFailures } from "@agentrail/db-clickhouse";

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
  const repositoryId = searchParams.get("repository_id") ?? undefined;
  const runId = searchParams.get("run_id") ?? undefined;
  const severity = searchParams.get("severity") ?? undefined;
  const failureType = searchParams.get("failure_type") ?? undefined;
  const timeFrom = searchParams.get("time_from");
  const timeTo = searchParams.get("time_to");
  const cursor = searchParams.get("cursor") ?? undefined;

  try {
    const { failures, nextCursor } = await listWorkspaceFailures(workspaceId, {
      repositoryId,
      runId,
      severity,
      failureType,
      timeFrom: timeFrom ? new Date(timeFrom) : undefined,
      timeTo: timeTo ? new Date(timeTo) : undefined,
      cursor,
      limit: 50,
    });

    const serialized = failures.map((f) => ({
      ...f,
      occurred_at: typeof f.occurred_at === "string" ? f.occurred_at : f.occurred_at instanceof Date ? f.occurred_at.toISOString() : String(f.occurred_at),
    }));

    return NextResponse.json({ failures: serialized, nextCursor });
  } catch {
    return NextResponse.json({ failures: [], nextCursor: null });
  }
}
