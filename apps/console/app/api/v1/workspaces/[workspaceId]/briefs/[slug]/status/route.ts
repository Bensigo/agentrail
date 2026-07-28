import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  briefStatusEnum,
  getBriefBySlug,
  getWorkspaceMembership,
  setBriefStatus,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;
const STATUS_VALUES = briefStatusEnum.enumValues;

/**
 * PATCH /api/v1/workspaces/:workspaceId/briefs/:slug/status
 *
 * The ONLY write path for a brief's `status` — a HUMAN label toggled here in
 * the console (design spec, "`status` is `draft | ready` and is a HUMAN
 * label... Implementation-readiness is computed separately from the items").
 * This route calls `setBriefStatus` directly, never `patchBriefItems` or any
 * item-level write, so it is structurally impossible for this endpoint to
 * touch the computed-readiness inputs — flipping this label can never move
 * `computeBriefReadiness`'s answer, which is the whole point of keeping the
 * two separate (`to-issues` gates on the computed check, never this flag).
 *
 * Role-gated owner/admin, mirroring every other workspace-configuration
 * mutation in this codebase (`goals/route.ts`'s own `ADMIN_ROLES` — see that
 * route's doc-comment for the precedent this follows).
 *
 * `slug`, not `briefId`, is the URL identity (matches the design spec's own
 * framing of slug as the brief's stable identity) — this route resolves the
 * actual row via `getBriefBySlug(workspaceId, slug)` itself rather than
 * trusting a caller-supplied id, so a slug from a different workspace 404s
 * rather than leaking whether it exists elsewhere.
 */
export async function PATCH(
  request: NextRequest,
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

  const brief = await getBriefBySlug(workspaceId, slug);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { status?: unknown };
  if (typeof body.status !== "string" || !STATUS_VALUES.includes(body.status as (typeof STATUS_VALUES)[number])) {
    return NextResponse.json(
      { error: `status must be one of: ${STATUS_VALUES.join(", ")}` },
      { status: 400 }
    );
  }

  const updated = await setBriefStatus(brief.id, body.status as (typeof STATUS_VALUES)[number]);
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ status: updated.status });
}
