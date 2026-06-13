import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { listFailureClusters } from "@agentrail/db-clickhouse";

export async function GET(
  _request: NextRequest,
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

  try {
    const clusters = await listFailureClusters(workspaceId);
    return NextResponse.json(clusters);
  } catch (err) {
    console.error("[failures/clusters] ClickHouse query failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
