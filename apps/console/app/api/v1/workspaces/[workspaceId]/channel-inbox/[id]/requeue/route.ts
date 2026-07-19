import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, requeueDeadChannelMessage } from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Console Requeue for a dead-lettered `channel_inbox` row — issue #1276
 * PR ②. `requeueDeadChannelMessage` already exists (issue #1250) and is
 * already workspace- and state-scoped (`WHERE id = ... AND workspace_id =
 * ... AND state = 'dead'`) — no new query work, this route is just the
 * role-gated HTTP wrapper the console page's action calls.
 *
 * Role-gated server-side (owner/admin act), mirrors
 * `api-keys/[keyId]/route.ts`'s `ADMIN_ROLES` precedent exactly.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, id } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Admin or owner role required" },
      { status: 403 }
    );
  }

  const requeued = await requeueDeadChannelMessage(workspaceId, id);
  if (!requeued) {
    return NextResponse.json(
      { error: "Not found, or no longer dead-lettered" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
