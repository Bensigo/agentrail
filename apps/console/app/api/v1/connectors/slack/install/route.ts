import { NextRequest, NextResponse } from "next/server";
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
 */
export async function GET(_request: NextRequest) {
  const clientId = process.env["SLACK_CLIENT_ID"];
  const clientSecret = process.env["SLACK_CLIENT_SECRET"];
  const consolePublicUrl = process.env["CONSOLE_PUBLIC_URL"];

  if (!clientId || !clientSecret || !consolePublicUrl) {
    console.error(
      "[slack-install] SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / CONSOLE_PUBLIC_URL must all be set to start a Slack install."
    );
    return NextResponse.json({ error: "Slack install is not configured" }, { status: 500 });
  }

  const state = signSlackOauthState(clientSecret);
  const redirectUri = buildSlackRedirectUri(consolePublicUrl);
  const authorizeUrl = buildSlackAuthorizeUrl({ clientId, redirectUri, state });

  return NextResponse.redirect(authorizeUrl, { status: 302 });
}
