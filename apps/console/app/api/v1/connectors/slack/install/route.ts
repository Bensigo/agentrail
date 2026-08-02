import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import {
  buildSlackAuthorizeUrl,
  buildSlackRedirectUri,
  signSlackOauthState,
} from "../../../../../../lib/slack-oauth";

/**
 * GET /api/v1/connectors/slack/install — task 2 of the multi-workspace
 * install (spec §2: docs/superpowers/specs/
 * 2026-07-29-slack-multi-workspace-design.md). The "Add to Slack" link's
 * target: 302s straight to Slack's own OAuth authorize screen with the
 * bot scopes (`slack-oauth.ts`'s `SLACK_BOT_SCOPES`, pinned to the app
 * manifest), the registered redirect_uri, and a signed, expiring `state`
 * for CSRF (verified by the callback before it ever exchanges a code).
 *
 * Fails closed with a 500 JSON error (never a redirect built from a
 * half-configured env) when `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
 * (doubles as the state-signing key — see slack-oauth.ts's module
 * comment), or `CONSOLE_PUBLIC_URL` is unset.
 *
 * WORKSPACE ATTRIBUTION (`?workspaceId=`) — the bugfix this route grew for.
 * The console's Gateways page kept rendering "Add to Slack" no matter how
 * many times the install succeeded, because a Slack install writes a
 * `slack_installations` row and NO chat identity, and nothing tied that row
 * back to the workspace whose page rendered the button. The Gateways panel
 * now appends its own `workspaceId` here, and it is carried across Slack's
 * redirect INSIDE the signed `state` (never as a bare param) so the callback
 * can attribute the installation.
 *
 * That id is admitted only for a signed-in MEMBER of that workspace, checked
 * server-side right here, before it is signed into anything: an unchecked id
 * would let anyone install a Slack team they control while naming someone
 * else's workspace, and that workspace's console would then render the
 * attacker's Slack as its own connected gateway. A signed-out or non-member
 * caller is refused (401/403) rather than quietly downgraded to an
 * unattributed install — silently dropping it is what the original bug felt
 * like from the user's side, and it would be indistinguishable from success.
 *
 * The param is OPTIONAL and this route stays fully anonymous without it:
 * an install started from Slack's own App Directory has no console session
 * and no workspace to name, and must keep working exactly as before (spec §1
 * — an install can legitimately precede any AgentRail workspace).
 */
export async function GET(request: NextRequest) {
  const clientId = process.env["SLACK_CLIENT_ID"];
  const clientSecret = process.env["SLACK_CLIENT_SECRET"];
  const consolePublicUrl = process.env["CONSOLE_PUBLIC_URL"];

  if (!clientId || !clientSecret || !consolePublicUrl) {
    console.error(
      "[slack-install] SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / CONSOLE_PUBLIC_URL must all be set to start a Slack install."
    );
    return NextResponse.json({ error: "Slack install is not configured" }, { status: 500 });
  }

  const requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId");
  let workspaceId: string | null = null;

  if (requestedWorkspaceId) {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const membership = await getWorkspaceMembership(
      session.user.id,
      requestedWorkspaceId
    );
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    workspaceId = requestedWorkspaceId;
  }

  const state = signSlackOauthState(clientSecret, { workspaceId });
  const redirectUri = buildSlackRedirectUri(consolePublicUrl);
  const authorizeUrl = buildSlackAuthorizeUrl({ clientId, redirectUri, state });

  return NextResponse.redirect(authorizeUrl, { status: 302 });
}
