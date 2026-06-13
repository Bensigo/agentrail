/**
 * GET /api/v1/workspaces/[workspaceId]/runs/[runId]/replay
 *
 * Returns a typed ReplayTimelineResponse: all afk_run_events for the run,
 * annotated with per-slot stall durations, retry flags, and digest-mismatch
 * flags, plus aggregated highlights.
 *
 * Auth: Bearer API key via requireBearer.
 * workspace_id and run_id come exclusively from the URL path — never from
 * query params or the request body.
 *
 * AC1: 200 + ReplayTimelineResponse when afk_run_events rows exist.
 * AC2: 200 + empty shape when no rows exist.
 * AC3: longest_stall_ms / longest_stall_slot match the actual max gap.
 * AC4: is_retry events have the same event_type earlier in the same slot.
 * AC5: Missing or invalid bearer key → 401.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAfkRunEvents } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../../../../lib/bearer-auth";
import { buildReplayTimeline } from "../../../../../../../../lib/replay";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  // AC5: bearer authentication.
  const bearerAuth = await requireBearer(req);
  if (bearerAuth instanceof NextResponse) return bearerAuth;

  const { workspaceId, runId } = await params;

  // Enforce workspace scope: the API key must belong to the requested workspace.
  if (bearerAuth.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rows: Awaited<ReturnType<typeof getAfkRunEvents>> = [];
  try {
    rows = await getAfkRunEvents(workspaceId, runId);
  } catch {
    // ClickHouse unavailable — return empty timeline (AC2 shape).
    return NextResponse.json(
      buildReplayTimeline([]),
      { status: 200 }
    );
  }

  const timeline = buildReplayTimeline(rows);
  return NextResponse.json(timeline, { status: 200 });
}
