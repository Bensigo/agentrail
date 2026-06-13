import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getWorkspace } from "@agentrail/db-postgres";
import { getQualityMetrics } from "@agentrail/db-clickhouse";

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

  // Fetch workspace to get the baseline_window_days default.
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const workspaceDefault = workspace.baselineWindowDays;

  // Parse and validate windowDays (integer, 7–90, default from workspace)
  const windowDaysParam = searchParams.get("windowDays");
  let windowDays = workspaceDefault;
  if (windowDaysParam !== null) {
    const parsed = Number(windowDaysParam);
    if (!Number.isInteger(parsed) || isNaN(parsed)) {
      return NextResponse.json(
        { error: "windowDays must be an integer" },
        { status: 400 }
      );
    }
    if (parsed < 7 || parsed > 90) {
      return NextResponse.json(
        { error: "windowDays must be between 7 and 90" },
        { status: 400 }
      );
    }
    windowDays = parsed;
  }

  // Parse and validate `to` (ISO date, default now)
  const toParam = searchParams.get("to");
  let to: Date;
  if (toParam !== null) {
    to = new Date(toParam);
    if (isNaN(to.getTime())) {
      return NextResponse.json(
        { error: "to must be a valid ISO date" },
        { status: 400 }
      );
    }
  } else {
    to = new Date();
  }

  // Parse and validate `from` (ISO date, default to - windowDays)
  const fromParam = searchParams.get("from");
  let from: Date;
  if (fromParam !== null) {
    from = new Date(fromParam);
    if (isNaN(from.getTime())) {
      return NextResponse.json(
        { error: "from must be a valid ISO date" },
        { status: 400 }
      );
    }
  } else {
    from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  }

  try {
    const result = await getQualityMetrics({
      workspaceId,
      repositoryId,
      from,
      to,
      windowDays,
    });
    return NextResponse.json({ ...result, baseline_window_days: workspaceDefault });
  } catch {
    return NextResponse.json(
      { error: "Failed to load quality metrics" },
      { status: 502 }
    );
  }
}
