import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, requeueParkedQueueEntry } from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Console Requeue for a parked queue entry — issue #1276 PR ②, guardrail
 * (duplicate content / rate limit / injection screen) and dependency
 * ("Waiting on #N") parks ONLY. `requeueParkedQueueEntry` itself refuses an
 * alignment-locked row server-side (its own `WHERE` clause is the real gate,
 * not this route) — an alignment hold resolves EXCLUSIVELY through the
 * posted brief's own Approve/Deny (`/approvals/[approvalId]`), never a raw
 * requeue; bypassing that would reintroduce the exact bug #1274 closed. The
 * console UI never renders this button for an alignment-locked row either,
 * but that's belt-and-suspenders — this endpoint enforces it independently.
 *
 * Role-gated server-side (owner/admin act), mirrors
 * `api-keys/[keyId]/route.ts`'s `ADMIN_ROLES` precedent exactly.
 */
export async function POST(
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
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Admin or owner role required" },
      { status: 403 }
    );
  }

  const result = await requeueParkedQueueEntry(workspaceId, queueEntryId);
  switch (result) {
    case "requeued":
      return NextResponse.json({ success: true });
    case "not_found":
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    case "not_parked":
      return NextResponse.json(
        { error: "This entry is no longer parked" },
        { status: 409 }
      );
    case "alignment_locked":
      return NextResponse.json(
        {
          error:
            "This entry is held by an alignment brief — resolve it via Approve/Deny, not Requeue",
        },
        { status: 409 }
      );
  }
}
