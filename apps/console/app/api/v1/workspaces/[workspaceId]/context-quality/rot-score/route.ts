import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRotScore } from "../../../../../../../lib/rot-scorer";

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

  const repositoryId = searchParams.get("repositoryId") ?? undefined;

  // Parse and validate `asOf` (ISO date, default now)
  const asOfParam = searchParams.get("asOf");
  let asOf: Date;
  if (asOfParam !== null) {
    asOf = new Date(asOfParam);
    if (isNaN(asOf.getTime())) {
      return NextResponse.json(
        { error: "asOf must be a valid ISO date" },
        { status: 400 }
      );
    }
  } else {
    asOf = new Date();
  }

  // Parse and validate thresholdDays (integer, default 30)
  const thresholdDaysParam = searchParams.get("thresholdDays");
  let thresholdDays: number | undefined;
  if (thresholdDaysParam !== null) {
    const parsed = Number(thresholdDaysParam);
    if (!Number.isInteger(parsed) || isNaN(parsed)) {
      return NextResponse.json(
        { error: "thresholdDays must be an integer" },
        { status: 400 }
      );
    }
    thresholdDays = parsed;
  }

  try {
    const result = await getRotScore({
      workspaceId,
      repositoryId,
      asOf,
      thresholdDays,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Failed to load rot score" },
      { status: 502 }
    );
  }
}
