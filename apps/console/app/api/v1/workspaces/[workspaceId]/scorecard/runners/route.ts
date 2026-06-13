import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRunnerRunStats } from "@agentrail/db-postgres";
import { getRunnerCostStats, getRunnerContextEfficiency } from "@agentrail/db-clickhouse";
import { buildRunnerScorecard } from "../../../../../../../lib/runner-scorecard";

function parseDateParam(
  param: string | null,
  name: string
): { date: Date; error?: never } | { date?: never; error: NextResponse } {
  if (param === null) return { date: new Date(0) }; // unused sentinel; caller handles null
  const d = new Date(param);
  if (isNaN(d.getTime())) {
    return {
      error: NextResponse.json(
        { error: `${name} must be a valid ISO date` },
        { status: 400 }
      ),
    };
  }
  return { date: d };
}

const VALID_RANGES = ["7d", "30d", "90d", "all"] as const;
type RangeOption = (typeof VALID_RANGES)[number];

function rangeToWindow(range: RangeOption, now: Date): { from: Date; to: Date } {
  const to = now;
  if (range === "all") {
    return { from: new Date(0), to };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
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
  const repositoryId = searchParams.get("repositoryId") ?? undefined;
  const taskType = searchParams.get("taskType") ?? undefined;

  // Parse time range: prefer `range` quick-select, fall back to explicit from/to.
  const rangeParam = searchParams.get("range");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  let from: Date | undefined;
  let to: Date | undefined;

  if (rangeParam !== null) {
    if (!VALID_RANGES.includes(rangeParam as RangeOption)) {
      return NextResponse.json(
        { error: `range must be one of: ${VALID_RANGES.join(", ")}` },
        { status: 400 }
      );
    }
    const window = rangeToWindow(rangeParam as RangeOption, new Date());
    from = window.from;
    to = window.to;
  } else {
    if (fromParam !== null) {
      const result = parseDateParam(fromParam, "from");
      if (result.error) return result.error;
      from = result.date;
    }
    if (toParam !== null) {
      const result = parseDateParam(toParam, "to");
      if (result.error) return result.error;
      to = result.date;
    }
  }

  try {
    const pgRows = await getRunnerRunStats(workspaceId, {
      repositoryId,
      from,
      to,
      taskType,
    });

    const allRunIds = pgRows.flatMap((r) => r.run_ids);

    const [costRows, effRows] = await Promise.all([
      getRunnerCostStats(workspaceId, allRunIds),
      getRunnerContextEfficiency(workspaceId, allRunIds),
    ]);

    const runners = buildRunnerScorecard(pgRows, costRows, effRows);

    return NextResponse.json({ runners });
  } catch {
    return NextResponse.json(
      { error: "Failed to load runner scorecard" },
      { status: 502 }
    );
  }
}
