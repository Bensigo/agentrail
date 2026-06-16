import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";
import {
  projectQueueEntries,
  type QueueRunInput,
} from "../../../../../../app/(dashboard)/dashboard/[workspaceId]/queue/components/queue-helpers";

/**
 * Issue Queue read model (M035, AC3). Projects the per-issue tier / remaining
 * budget / state from the runs read model — runs grouped by branch are one
 * issue, the same convention the Cost-per-Issue-to-Green meter uses. The
 * execution state machine (agentrail/afk/queue_state.py) is the source of truth;
 * this surface only projects it for the console.
 */
export async function GET(
  _request: NextRequest,
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

  try {
    const runs = (await listRuns(workspaceId)) as {
      id: string;
      branch: string;
      title: string | null;
      agent: string;
      status: string;
      createdAt: Date | string;
    }[];
    const inputs: QueueRunInput[] = runs.map((r) => ({
      id: r.id,
      branch: r.branch,
      title: r.title,
      agent: r.agent,
      status: r.status,
      createdAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : String(r.createdAt),
    }));
    return NextResponse.json({ entries: projectQueueEntries(inputs) });
  } catch (err) {
    console.error("[queue] failed to project queue for workspace:", err);
    return NextResponse.json(
      { error: "Failed to load the Issue Queue" },
      { status: 500 }
    );
  }
}
