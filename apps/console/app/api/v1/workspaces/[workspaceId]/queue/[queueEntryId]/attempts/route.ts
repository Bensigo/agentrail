import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listQueueAttempts } from "@agentrail/db-postgres";

/**
 * #1389 (AC3) — a queue entry's full attempt history: timestamp, tier,
 * outcome, error summary. Engine-room evidence (`queue_entries.id ==
 * runs.id`, see `claimQueueEntry`'s own doc-comment) — this is what lets an
 * `escalated-to-human` run explain itself instead of just showing a red
 * terminal state with no record of what happened per attempt.
 *
 * Session-authenticated + workspace-membership-scoped, matching every other
 * per-run/per-entry read route in this tree (e.g.
 * `runs/[runId]/route.ts`, `queue/[queueEntryId]/requeue/route.ts`).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; queueEntryId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, queueEntryId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const attempts = await listQueueAttempts(workspaceId, queueEntryId);
    return NextResponse.json({ attempts });
  } catch (err) {
    console.error("[queue attempts] failed to load attempt history:", err);
    return NextResponse.json(
      { error: "Failed to load attempt history" },
      { status: 500 }
    );
  }
}
