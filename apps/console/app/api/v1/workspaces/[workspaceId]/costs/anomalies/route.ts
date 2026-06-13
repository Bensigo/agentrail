import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { listCostAnomalies } from "@agentrail/db-clickhouse";

function dateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
  try {
    const anomalies = await listCostAnomalies(workspaceId, {
      timeFrom: dateParam(searchParams.get("time_from")),
      timeTo: dateParam(searchParams.get("time_to")),
    });
    return NextResponse.json({ anomalies });
  } catch {
    return NextResponse.json({ anomalies: [] });
  }
}
