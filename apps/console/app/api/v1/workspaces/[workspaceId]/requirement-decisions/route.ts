/**
 * GET /api/v1/workspaces/[workspaceId]/requirement-decisions
 *
 * Read-only #1583 report. The response carries the actual date window and
 * explicit denominators so an empty period is distinguishable from a zero
 * rate. `time_from` is inclusive and `time_to` is exclusive; absent bounds
 * default to the previous 30 days through the current instant.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getRequirementDecisionReport,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";

function parseDate(value: string | null, name: string, fallback: Date): Date | string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `${name} must be a valid ISO date` : date;
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

  const now = new Date();
  const from = parseDate(
    request.nextUrl.searchParams.get("time_from"),
    "time_from",
    new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  );
  if (typeof from === "string") {
    return NextResponse.json({ error: from }, { status: 400 });
  }
  const to = parseDate(
    request.nextUrl.searchParams.get("time_to"),
    "time_to",
    now
  );
  if (typeof to === "string") {
    return NextResponse.json({ error: to }, { status: 400 });
  }

  try {
    const report = await getRequirementDecisionReport({
      workspaceId,
      from,
      to,
    });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof Error && error.message.includes("to must be after from")) {
      return NextResponse.json(
        { error: "time_to must be after time_from" },
        { status: 400 }
      );
    }
    console.error("[requirement-decisions] report failed:", error);
    return NextResponse.json({ error: "Unable to load requirement report" }, { status: 500 });
  }
}
