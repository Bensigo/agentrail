import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getApprovalById, getWorkspaceMembership, resolveApproval } from "@agentrail/db-postgres";
import { applyAlignmentDecision } from "../../../../../../../lib/approval-decision";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Console Approve/Deny — issue #1276 PR ②. Resolves an approval through the
 * EXACT SAME seam a Telegram button tap does: `resolveApproval`'s atomic
 * pending->resolved flip, then `applyAlignmentDecision` (shared with the
 * Telegram webhook, `lib/approval-decision.ts`) for the one tool
 * (`alignment_brief`) that carries a side effect beyond the status flip. For
 * every other tool (create_issue/create_workspace/create_repo) that function
 * is a no-op — the async poller (`console_gated_approval.core.mjs`) is what
 * actually executes the gated tool's `create_*` side effect, identical
 * regardless of which channel (Telegram or here) resolved the approval — see
 * `annex-1276-1278-recon.md` §1d.
 *
 * Role-gated server-side (owner/admin act — mirrors
 * `api-keys/[keyId]/route.ts`'s `ADMIN_ROLES` precedent exactly): a
 * member/viewer's request is rejected here even if the console UI never
 * rendered the button for them.
 *
 * Workspace-scoped: `getApprovalById` itself carries no workspace scope (by
 * design — see its own doc-comment, it's the console poller's own-uuid
 * lookup), so the approval's OWN `workspaceId` is compared against the URL's
 * `workspaceId` explicitly below. An id from another workspace never
 * resolves here, regardless of the caller's role in THIS workspace.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; approvalId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, approvalId } = await params;
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const decision = (body as Record<string, unknown> | null)?.["decision"];
  if (decision !== "approved" && decision !== "denied") {
    return NextResponse.json(
      { error: 'decision must be "approved" or "denied"' },
      { status: 400 }
    );
  }

  const approval = await getApprovalById(approvalId);
  if (!approval || approval.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const flipped = await resolveApproval(approvalId, decision);
  if (!flipped) {
    // Matches resolveApproval's own idempotency contract (see its
    // doc-comment): a second resolution attempt — a double-submitted click,
    // or this approval was already resolved via Telegram in the meantime —
    // matches zero rows. Not an error, just nothing left to do.
    return NextResponse.json({ error: "Already resolved" }, { status: 409 });
  }

  // #1274: only an "alignment_brief" approval carries queueEntryId — every
  // other tool's approval has it null and this is a no-op for them.
  // Regression-pinned by the Telegram webhook route's own suite (which
  // exercises the shared applyAlignmentDecision end-to-end, including the
  // no-queueEntryId no-op) and by this route's tests alongside this file.
  await applyAlignmentDecision(approval, decision);

  return NextResponse.json({ success: true });
}
