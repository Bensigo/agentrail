import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listQueueEntries } from "@agentrail/db-postgres";
import { mapQueueEntryRows } from "../../../../../../app/(dashboard)/dashboard/[workspaceId]/queue/components/queue-helpers";

/**
 * Issue Queue read model. Reads the authoritative durable `queue_entries` table
 * — the same queue the runner claims from (agentrail/afk/queue_state.py is the
 * state machine; queue_entries persists its decisions). This replaces the legacy
 * runs-history projection, which could never flush: it re-derived every past run
 * as an entry forever and showed failed-but-unretried runs as phantom "queued".
 *
 * `activeOnly` defaults to true, so the queue self-flushes — an issue drops out
 * the instant it reaches a terminal (green / escalated-to-human / blocked),
 * which by definition has *left* the queue and lives in Runs/history. Pass
 * `?all=1` to include terminals (history view).
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

  const includeAll = new URL(request.url).searchParams.get("all") === "1";

  try {
    const rows = await listQueueEntries(workspaceId, { activeOnly: !includeAll });
    return NextResponse.json({ entries: mapQueueEntryRows(rows) });
  } catch (err) {
    console.error("[queue] failed to load queue for workspace:", err);
    return NextResponse.json(
      { error: "Failed to load the Issue Queue" },
      { status: 500 }
    );
  }
}
