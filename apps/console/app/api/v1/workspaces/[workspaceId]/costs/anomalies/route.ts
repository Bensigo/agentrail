import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { listCostAnomalies } from "@agentrail/db-clickhouse";

function parseIsoDateParam(value: string | null, name: string) {
  if (value === null || value === "") return { date: undefined };

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { error: `${name} must be a valid ISO date` };
  }

  return { date };
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
  const timeFrom = parseIsoDateParam(searchParams.get("time_from"), "time_from");
  if (timeFrom.error) {
    return NextResponse.json({ error: timeFrom.error }, { status: 400 });
  }

  const timeTo = parseIsoDateParam(searchParams.get("time_to"), "time_to");
  if (timeTo.error) {
    return NextResponse.json({ error: timeTo.error }, { status: 400 });
  }

  try {
    const anomalies = await listCostAnomalies(workspaceId, {
      timeFrom: timeFrom.date,
      timeTo: timeTo.date,
    });
    return NextResponse.json({ anomalies });
  } catch {
    return NextResponse.json({ anomalies: [] });
  }
}
