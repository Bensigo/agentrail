import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getCostAnomalies } from "@agentrail/db-clickhouse";

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
  const timeFrom = searchParams.get("time_from");
  const timeTo = searchParams.get("time_to");

  const anomalies = await getCostAnomalies(workspaceId, {
    timeFrom: timeFrom ? new Date(timeFrom) : undefined,
    timeTo: timeTo ? new Date(timeTo) : undefined,
  });
  return NextResponse.json({ anomalies });
}
