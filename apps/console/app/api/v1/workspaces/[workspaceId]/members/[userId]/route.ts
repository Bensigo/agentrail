import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  db,
  getWorkspaceMembership,
  listWorkspaceMembers,
  removeWorkspaceMembership,
  getBillingAccountIdForWorkspace,
  listAccountWorkspaceIds,
  listWorkspacesForUser,
  releaseUserSeatForAccount,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Remove a workspace member — the console members page's "Remove" action.
 *
 * This capability did not exist anywhere in the codebase before slice 4
 * Task 3 (traced: `members-client.tsx`'s only DELETE fetch was the invite-
 * revoke one; there was no members/[userId] route, no UI control, and no
 * db-postgres query to delete a `workspace_memberships` row). It's built
 * now because the seat-release rule below has nothing to hook onto without
 * it, and `queries/seats.ts`'s `releaseUserSeatForAccount` doc-comment
 * already named "the console members-page remove member action" as this
 * exact route's own future caller. Admin-gated the same flat way
 * `DELETE /invites/[inviteId]` is (`ADMIN_ROLES`) — no special-case for
 * `session.user.id === userId`; the client only chooses not to render the
 * control on the caller's own row, which is cosmetic, not a security
 * boundary. The real boundary is the last-owner check below, which also
 * catches self-removal for a sole owner as one case of the general rule.
 *
 * Last-owner protection (review fix-round, folded into Task 3): removing
 * the workspace's LAST remaining owner — by an admin, or by that owner
 * removing themselves — is rejected with 409 rather than silently leaving
 * the workspace ownerless. Removing an owner while ANOTHER owner still
 * exists stays allowed (an admin CAN remove any non-last owner — that part
 * of the original flat `ADMIN_ROLES` precedent is unchanged). Checked via
 * the same `getWorkspaceMembership` this route already uses for the caller
 * (reused here for the TARGET's role) plus `listWorkspaceMembers` (already
 * exists for the members-list read) to count the workspace's current
 * owners — no new query needed for either.
 *
 * After a successful removal, releases the user's seat on the workspace's
 * billing account — but ONLY when they hold no remaining membership in ANY
 * of that account's workspaces (spec §5.5 reconciled with §5.2, plan's own
 * Global Constraints: removal from one workspace of a multi-workspace
 * account keeps the seat; only the LAST removal releases it). Computed by
 * intersecting `listAccountWorkspaceIds` (every workspace on this account)
 * against `listWorkspacesForUser` (every workspace this user still belongs
 * to, post-removal) — an empty intersection is "zero remaining in this
 * account", regardless of memberships the user holds elsewhere.
 *
 * The release step is awaited but NON-FATAL: the member is already gone by
 * the time it runs, so a release failure must never surface as a failed
 * removal to the caller — every DB call in that step is try/caught as a
 * whole and logged loudly, matching the invite-accept claim hook's own
 * discipline (`app/(auth)/invite/[token]/page.tsx`). A `null` billing
 * account id (a transitional workspace not yet bound to one) skips the
 * whole release step silently — same contract
 * `getBillingAccountIdForWorkspace`'s own doc-comment describes.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; userId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, userId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const targetMembership = await getWorkspaceMembership(userId, workspaceId);
  if (!targetMembership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (targetMembership.role === "owner") {
    const members = await listWorkspaceMembers(workspaceId);
    const ownerCount = members.filter((m) => m.role === "owner").length;
    if (ownerCount <= 1) {
      return NextResponse.json(
        { error: "Transfer ownership before removing the last owner." },
        { status: 409 }
      );
    }
  }

  const removed = await removeWorkspaceMembership(workspaceId, userId);
  if (!removed) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  try {
    const billingAccountId = await getBillingAccountIdForWorkspace(db, workspaceId);
    if (billingAccountId) {
      const accountWorkspaceIds = new Set(
        await listAccountWorkspaceIds(db, billingAccountId)
      );
      const remainingMemberships = await listWorkspacesForUser(userId);
      const stillHasSeatInAccount = remainingMemberships.some((ws) =>
        accountWorkspaceIds.has(ws.id)
      );
      if (!stillHasSeatInAccount) {
        await releaseUserSeatForAccount(db, { billingAccountId, userId });
      }
    }
  } catch (err) {
    console.error(
      `[members] seat release failed (workspace=${workspaceId}, user=${userId}):`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return NextResponse.json({ removed: { user_id: userId } });
}
