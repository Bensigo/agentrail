import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, requeueParkedQueueEntry } from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Console Requeue for a parked queue entry — issue #1276 PR ②.
 * `requeueParkedQueueEntry` itself decides alignment-held server-side by the
 * SAME predicate `unparkDependents` releases on (kind / confirmed
 * estimatedBudgetUsd / the workspace's require_alignment flag, denial
 * unconditional — NOT a parkReason string match; #1276 fix round, review
 * C1), enforced by its own transaction + guarded `WHERE`, not by this
 * route. An alignment-held row resolves EXCLUSIVELY through the posted
 * brief's own Approve/Deny (`/approvals/[approvalId]`), never a raw
 * requeue; bypassing that would reintroduce the exact bug #1274 closed. The
 * console UI renders those rows' Requeue disabled (server-computed flag),
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
            "This entry is held by the alignment gate — resolve it via Approve/Deny on its brief, not Requeue",
        },
        { status: 409 }
      );
  }
}
