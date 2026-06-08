import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRun } from "@agentrail/db-postgres";
import { getRunEvents } from "@agentrail/db-clickhouse";

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

  const run = await getRun(workspaceId, runId);
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let events: Awaited<ReturnType<typeof getRunEvents>> = [];
  try {
    events = await getRunEvents(workspaceId, runId);
  } catch {
    // ClickHouse may not be available in dev
  }

  return NextResponse.json({ run, events });
}
