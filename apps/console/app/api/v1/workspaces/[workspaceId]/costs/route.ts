import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { aggregateWorkspaceCosts } from "@agentrail/db-clickhouse";
import type { CostGroupBy } from "@agentrail/db-clickhouse";

const VALID_GROUP_BY = new Set<CostGroupBy>(["team", "repo", "api_key", "run"]);

function isValidGroupBy(v: string | null): v is CostGroupBy {
  return v !== null && VALID_GROUP_BY.has(v as CostGroupBy);
}

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
  const groupByParam = searchParams.get("group_by");
  const groupBy: CostGroupBy = isValidGroupBy(groupByParam) ? groupByParam : "repo";
  const timeFrom = searchParams.get("time_from");
  const timeTo = searchParams.get("time_to");

  try {
    const rows = await aggregateWorkspaceCosts(workspaceId, {
      groupBy,
      timeFrom: timeFrom ? new Date(timeFrom) : undefined,
      timeTo: timeTo ? new Date(timeTo) : undefined,
    });
    return NextResponse.json({ costs: rows, groupBy });
  } catch {
    return NextResponse.json({ costs: [], groupBy });
  }
}
