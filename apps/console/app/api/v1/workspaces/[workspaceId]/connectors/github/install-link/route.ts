import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  mintGithubInstallState,
} from "@agentrail/db-postgres";
import { resolveGithubAppConfig } from "@agentrail/github-app";

const ADMIN_ROLES = ["owner", "admin"];

/**
 * POST /api/v1/workspaces/[workspaceId]/connectors/github/install-link
 *
 * Mints the single-use install URL for GitHub's App-installation flow (spec
 * §5). Session-authed + admin-gated like the sibling webhook route — an
 * explicit button click only. The returned URL carries a 30-minute,
 * single-use `state` token bound server-side to THIS workspace; the global
 * install-callback consumes it atomically, so a tampered or replayed state
 * can never bind an installation to a workspace the clicker isn't an
 * admin of.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId } = await ctx.params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = resolveGithubAppConfig(process.env);
  if (!cfg.ok) {
    return NextResponse.json(
      { error: "GitHub App is not configured on this deployment" },
      { status: 503 }
    );
  }
  const state = await mintGithubInstallState(workspaceId);
  return NextResponse.json({
    url: `https://github.com/apps/${cfg.slug}/installations/new?state=${state}`,
  });
}
