import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  upsertConnector,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * "Skip for now" on the onboarding wizard's Connect-GitHub step (three-step
 * rebuild — owner ruling: every step is individually skippable, skip
 * remembered per workspace). Persists the choice on the github connector
 * row's jsonb config (`githubSkippedAt`) — no new table, mirroring
 * `skip-channel/route.ts`'s precedent on the telegram row. Owner/admin only,
 * matching the connector-management gate (`connectors/route.ts` PUT /
 * `connectors/secret/route.ts` PUT).
 *
 * Body: `{ skip?: boolean }` — defaults to `true`; pass `false` to undo a
 * skip (e.g. the wizard offers "actually, let me connect it" after all).
 */
export async function POST(
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
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { skip?: unknown };
  const skip = body.skip !== false;

  try {
    await upsertConnector(workspaceId, "github", {
      config: { githubSkippedAt: skip ? new Date().toISOString() : undefined },
    });
    return NextResponse.json({ skipped: skip });
  } catch (err) {
    console.error("[onboarding/skip-github] failed to persist skip:", err);
    return NextResponse.json(
      { error: "Failed to save your choice" },
      { status: 500 }
    );
  }
}
