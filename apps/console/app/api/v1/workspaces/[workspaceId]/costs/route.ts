import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getCostAggregation } from "@agentrail/db-clickhouse";

export async function GET(
  request: Request,
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

  const url = new URL(request.url);
  const groupBy = url.searchParams.get("group_by") ?? "run";
  const timeFrom = url.searchParams.get("time_from") ?? undefined;
  const timeTo = url.searchParams.get("time_to") ?? undefined;

  let rows: Awaited<ReturnType<typeof getCostAggregation>> = [];
  try {
    rows = await getCostAggregation(workspaceId, { groupBy, timeFrom, timeTo });
  } catch {
    // ClickHouse may not be available
  }

  return NextResponse.json({ rows });
}
