import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getUserGithubAccessToken,
} from "@agentrail/db-postgres";
import { listUserRepos } from "../../../../../../../lib/github-repos";

// Connecting a repo is admin-gated, so listing candidates to connect must be
// too — same roles as the repos POST route's ADMIN_ROLES.
const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * GET /api/v1/workspaces/:workspaceId/github/repos?q=<search>&page=<n>
 *
 * Powers the connect-repo picker (#1293 AC1): the searchable list of the
 * SIGNED-IN user's real GitHub repositories, so a repo is chosen from what
 * actually exists rather than typed free-hand. Auth mirrors the repos POST
 * route exactly — `auth()` (401) → `getWorkspaceMembership` (403) → owner/admin
 * (403). The user's stored GitHub OAuth token is read server-side and used to
 * call the GitHub REST API; it is NEVER returned to the client.
 *
 * Failure modes are surfaced with a machine-readable `code` the UI switches on:
 *   - no linked GitHub account/token → 400 `github_not_connected`
 *   - stored token expired/revoked/under-scoped → 401/403 `github_reconnect`
 *   - GitHub rate limit → 429 `github_rate_limited`
 *   - anything else / unreachable → 502 `github_error`
 * All of these steer the UI toward "Reconnect GitHub" or the manual-entry
 * fallback rather than a dead end.
 */
export async function GET(
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

  const token = await getUserGithubAccessToken(session.user.id);
  if (!token) {
    return NextResponse.json(
      {
        error:
          "No GitHub account is connected for your user. Reconnect GitHub, or enter the repository manually.",
        code: "github_not_connected",
      },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? undefined;
  const pageParam = url.searchParams.get("page");
  const page = pageParam ? Number(pageParam) : undefined;

  const result = await listUserRepos(token, { q, page });
  if (!result.ok) {
    const code =
      result.kind === "reconnect"
        ? "github_reconnect"
        : result.kind === "rate_limited"
          ? "github_rate_limited"
          : "github_error";
    return NextResponse.json(
      { error: result.message, code },
      { status: result.status }
    );
  }

  return NextResponse.json({ repos: result.repos });
}
