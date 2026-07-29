import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { confirmVerdictAsHuman, getInvestigationBySlug, getWorkspaceMembership } from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * POST /api/v1/workspaces/:workspaceId/investigations/:slug/confirm
 *
 * The human confirmation gate on the LATEST recorded verdict (Task 13 —
 * "the human sees exactly what Jace saw, confirms verdict truth" — the
 * knowledge loop and calibration read the resulting `data.humanConfirmed`).
 * Calls `confirmVerdictAsHuman` directly — see that query's own doc-comment
 * for why it is NOT routed through `updateInvestigationItemAsHuman` (it must
 * not flip `authority`: the verdict's AUTHOR stays whoever `record_verdict`
 * was called for; confirmation is an orthogonal fact, not a claim of
 * authorship over the verdict text).
 *
 * Role-gated owner/admin, mirroring every other workspace-configuration
 * mutation in this codebase (`briefs/[slug]/status/route.ts`'s own
 * `ADMIN_ROLES` — see that route's doc-comment for the precedent this
 * follows).
 *
 * `slug`, not the row's uuid, is the URL identity (matches every sibling
 * investigation/brief route) — this route resolves the actual row via
 * `getInvestigationBySlug(workspaceId, slug)` itself rather than trusting a
 * caller-supplied id, so a slug from a different workspace 404s rather than
 * leaking whether it exists elsewhere.
 *
 * 401 — unauthenticated. 403 — not a member, or a member without
 * owner/admin. 404 — no investigation at that slug in this workspace. 409 —
 * the investigation has no `kind: 'verdict'` item yet (nothing to confirm).
 * 200 — `{ item }`, the updated verdict item.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, slug } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Owner or admin role required" }, { status: 403 });
  }

  const found = await getInvestigationBySlug(workspaceId, slug);
  if (!found) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await confirmVerdictAsHuman(found.investigation.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: "No verdict has been recorded for this investigation yet" },
      { status: 409 }
    );
  }

  return NextResponse.json({ item: result.item });
}
