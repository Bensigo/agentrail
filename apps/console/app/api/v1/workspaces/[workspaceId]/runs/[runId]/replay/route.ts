import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getAfkRunEvents } from "@agentrail/db-clickhouse";
import { buildReplayTimeline } from "../../../../../../../../lib/replay";

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

  try {
    const rows = await getAfkRunEvents(workspaceId, runId);
    return NextResponse.json(buildReplayTimeline(rows));
  } catch {
    return NextResponse.json(
      { error: "Failed to load replay timeline" },
      { status: 500 }
    );
  }
}
