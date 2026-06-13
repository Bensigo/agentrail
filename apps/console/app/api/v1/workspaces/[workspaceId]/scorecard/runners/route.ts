import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRunnerRunStats } from "@agentrail/db-postgres";
import { getRunnerCostStats, getRunnerContextEfficiency } from "@agentrail/db-clickhouse";
import { buildRunnerScorecard } from "../../../../../../../lib/runner-scorecard";

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
  const taskType = searchParams.get("taskType") ?? undefined;

  // Parse and validate `from` (ISO date, optional)
  const fromParam = searchParams.get("from");
  let from: Date | undefined;
  if (fromParam !== null) {
    from = new Date(fromParam);
    if (isNaN(from.getTime())) {
      return NextResponse.json(
        { error: "from must be a valid ISO date" },
        { status: 400 }
      );
    }
  }

  // Parse and validate `to` (ISO date, optional)
  const toParam = searchParams.get("to");
  let to: Date | undefined;
  if (toParam !== null) {
    to = new Date(toParam);
    if (isNaN(to.getTime())) {
      return NextResponse.json(
        { error: "to must be a valid ISO date" },
        { status: 400 }
      );
    }
  }

  try {
    // Step 1: get per-runner run stats (includes run_ids per runner).
    const runStats = await getRunnerRunStats(workspaceId, {
      repositoryId,
      from,
      to,
      taskType,
    });

    // Step 2: collect all run IDs across all runners for the secondary lookups.
    const allRunIds = runStats.flatMap((r) => r.run_ids);

    // Step 3: fetch cost and context efficiency keyed by run_id.
    const [costStats, efficiencyStats] = await Promise.all([
      getRunnerCostStats(workspaceId, allRunIds),
      getRunnerContextEfficiency(workspaceId, allRunIds),
    ]);

    const runners = buildRunnerScorecard(runStats, costStats, efficiencyStats);
    return NextResponse.json({ runners });
  } catch {
    return NextResponse.json(
      { error: "Failed to load runner scorecard" },
      { status: 502 }
    );
  }
}
