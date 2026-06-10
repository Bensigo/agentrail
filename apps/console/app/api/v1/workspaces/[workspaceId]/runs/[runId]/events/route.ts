/**
 * GET /api/v1/workspaces/:workspaceId/runs/:runId/events
 *
 * Returns run events for polling by the run-detail timeline.
 * ``runId`` may be a Postgres UUID (regular run) or an AFK session_id.
 *
 * Optional query param: ``after_seq`` (Int) — return only events with
 * seq > after_seq, enabling incremental polling.
 *
 * Returns: 200 { events: TimelineEvent[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRunEventsByRunId } from "@agentrail/db-clickhouse";

function prettifyKind(s: string): string {
  // "EnqueueIssue" -> "Enqueue Issue"
  return s.replace(/([A-Z])/g, " $1").trim();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const afterSeqParam = request.nextUrl.searchParams.get("after_seq");
  const afterSeq =
    afterSeqParam !== null && afterSeqParam !== "" ? parseInt(afterSeqParam, 10) : undefined;

  let events: Awaited<ReturnType<typeof getRunEventsByRunId>> = [];
  try {
    events = await getRunEventsByRunId(workspaceId, runId, afterSeq);
  } catch {
    // ClickHouse unavailable; return empty list (polling will retry)
  }

  const mapped = events.map((e) => ({
    event_id: e.event_id,
    kind: e.event_type,
    label: prettifyKind(e.event_type),
    digest: e.event_id.slice(0, 8),
    occurred_at: e.occurred_at instanceof Date
      ? e.occurred_at.toISOString()
      : String(e.occurred_at),
    event_type: e.event_type,
    phase: e.phase,
    severity: e.severity,
    payload: e.payload,
    seq: e.seq,
  }));

  return NextResponse.json({ events: mapped });
}
