import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import {
  aggregateWorkspaceSavings,
  getAgentSavingsBreakdown,
} from "@agentrail/db-clickhouse";

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

  const opts = { timeFrom: timeFrom.date, timeTo: timeTo.date };

  try {
    const [savings, agentBreakdown] = await Promise.all([
      aggregateWorkspaceSavings(workspaceId, opts),
      getAgentSavingsBreakdown(workspaceId, opts),
    ]);
    return NextResponse.json({ savings, agentBreakdown });
  } catch {
    const emptySavings = {
      tokensSaved: 0,
      dollarsSaved: 0,
      model: "claude-sonnet-4-5",
      ratePerMtok: 3.0,
      estimateFlag: true as const,
    };
    const emptyBreakdown = [
      { agent: "claude" as const, totalCostUsd: 0, dollarsSaved: 0, eventCount: 0 },
      { agent: "codex" as const, totalCostUsd: 0, dollarsSaved: 0, eventCount: 0 },
      { agent: "cursor" as const, totalCostUsd: 0, dollarsSaved: 0, eventCount: 0 },
    ];
    return NextResponse.json({ savings: emptySavings, agentBreakdown: emptyBreakdown });
  }
}
