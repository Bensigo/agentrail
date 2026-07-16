import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listQueueEntries,
  listRunsWithCursor,
} from "@agentrail/db-postgres";
import { aggregateWorkspaceCosts } from "@agentrail/db-clickhouse";
import {
  buildDigest,
  getPreviousWeekRange,
  getWeekRange,
  type DigestCostRow,
} from "./digest-helpers";

// Generous upper bound on runs shipped in one week — a week of green runs
// for a single workspace will not realistically exceed this.
const SHIPPED_LIMIT = 200;

/**
 * Home "This week from Jace" digest (#1230). Replaces the workspace overview
 * count-card grid with four aggregate blocks: shipped, in progress, needs
 * you, and cost-this-week-with-trend. `buildDigest` (digest-helpers.ts) does
 * the actual shaping and is unit-tested in isolation; this route is only
 * responsible for auth, membership, fetching rows, and degrading gracefully
 * when ClickHouse (cost) is unavailable.
 */
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

  const weekParam = request.nextUrl.searchParams.get("week");
  let anchor = new Date();
  if (weekParam) {
    const parsed = new Date(weekParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "week must be a valid ISO date" },
        { status: 400 }
      );
    }
    anchor = parsed;
  }

  const week = getWeekRange(anchor);
  const previousWeek = getPreviousWeekRange(anchor);
  // Both ranges are Monday 00:00:00 (inclusive) .. next Monday 00:00:00
  // (exclusive); listRunsWithCursor/aggregateWorkspaceCosts take an inclusive
  // timeTo, so back off 1ms from the exclusive end.
  const weekTimeTo = new Date(week.end.getTime() - 1);
  const previousWeekTimeTo = new Date(previousWeek.end.getTime() - 1);

  const [shippedResult, inProgressEntries, needsYouEntries, thisWeekCostRows, previousWeekCostRows] =
    await Promise.all([
      listRunsWithCursor(workspaceId, {
        status: "success",
        timeFrom: week.start,
        timeTo: weekTimeTo,
        limit: SHIPPED_LIMIT,
      }),
      listQueueEntries(workspaceId, { states: ["queued", "running"] }),
      listQueueEntries(workspaceId, { states: ["escalated-to-human", "parked"] }),
      // ClickHouse may be down in some environments — degrade to cost:null
      // rather than 500ing the whole digest over a telemetry sidecar outage.
      aggregateWorkspaceCosts(workspaceId, {
        groupBy: "run",
        timeFrom: week.start,
        timeTo: weekTimeTo,
      })
        .then((rows): DigestCostRow[] => rows)
        .catch(() => null),
      aggregateWorkspaceCosts(workspaceId, {
        groupBy: "run",
        timeFrom: previousWeek.start,
        timeTo: previousWeekTimeTo,
      })
        .then((rows): DigestCostRow[] => rows)
        .catch(() => null),
    ]);

  const digest = buildDigest({
    week,
    shippedRuns: shippedResult.runs,
    inProgressEntries,
    needsYouEntries,
    thisWeekCostRows,
    previousWeekCostRows,
  });

  return NextResponse.json(digest);
}
