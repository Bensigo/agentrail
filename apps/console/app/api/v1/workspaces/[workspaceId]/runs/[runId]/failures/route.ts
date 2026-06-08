import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getFailureEvents } from "@agentrail/db-clickhouse";

export async function GET(
  _request: Request,
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

  let failures: Awaited<ReturnType<typeof getFailureEvents>> = [];
  try {
    failures = await getFailureEvents(workspaceId, { runId });
  } catch {
    // ClickHouse may not be available
  }

  return NextResponse.json({ failures });
}
