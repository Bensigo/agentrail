import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getInstallationToken } from "@agentrail/db-postgres";
import { listInstallationRepos } from "../../../../../../../lib/github-repos";

// Connecting a repo is admin-gated, so listing candidates to connect must be
// too — same roles as the repos POST route's ADMIN_ROLES.
const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * GET /api/v1/workspaces/:workspaceId/github/repos?q=<search>
 *
 * Powers the connect-repo picker (#1293 AC1): the searchable list of repos
 * the WORKSPACE's GitHub App installation was granted (spec
 * docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md
 * §5/§6, Task 6 delta of the drift addendum). Auth mirrors the repos POST
 * route exactly — `auth()` (401) → `getWorkspaceMembership` (403) →
 * owner/admin (403). The token used to call GitHub is the WORKSPACE's App
 * installation token (`getInstallationToken`, minted fresh, never returned
 * to the client) — NOT the signed-in user's own OAuth token: repo access
 * comes exclusively from the installation grant, so which admin happens to
 * click "Add repository" no longer matters, and there is no per-user scope
 * to escalate.
 *
 * Failure modes are surfaced with a machine-readable `code` the UI switches on:
 *   - no installation bound / App unconfigured → 400 `github_not_connected`
 *     (`getInstallationToken` collapses "never installed", "App env
 *     unconfigured", and "installation uninstalled" into one null — see its
 *     own doc-comment; the install-link flow is the fix for all three)
 *   - installation token rejected/revoked at GitHub → 401/403
 *     `github_reconnect` — steers the picker into the install-link
 *     (re)install flow (Task 3's mint endpoint), not an OAuth re-consent
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

  const token = await getInstallationToken(workspaceId);
  if (!token) {
    return NextResponse.json(
      {
        error:
          "GitHub is not connected for this workspace — install the Jace GitHub App first.",
        code: "github_not_connected",
      },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? undefined;

  const result = await listInstallationRepos(token, { q });
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
