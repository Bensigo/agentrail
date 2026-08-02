import { NextRequest, NextResponse } from "next/server";
import { upsertSlackInstallation } from "@agentrail/db-postgres";
import {
  SLACK_OAUTH_ACCESS_URL,
  buildSlackOauthAccessBody,
  buildSlackRedirectUri,
  normalizeSlackOauthResponse,
  readSlackOauthState,
  renderSlackConnectedPage,
  renderSlackErrorPage,
} from "../../../../../../lib/slack-oauth";

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * GET /api/v1/connectors/slack/callback — task 2 of the multi-workspace
 * install (spec §2, §5). This path is the ONE Slack registered as the
 * app's OAuth redirect, and it is reachable by anyone on the internet:
 * every query param below is treated as hostile, and no branch ever writes
 * a row on anything less than a fully verified, fully populated,
 * non-Enterprise-Grid installation.
 *
 * Order of checks, each a distinct failure mode with its own test:
 *
 * 1. `error` present (e.g. `access_denied` — the user hit Deny) -> friendly
 *    page, no row written, no code exchange even attempted (there is no
 *    code to exchange on this branch).
 * 2. Config missing (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/
 *    `CONSOLE_PUBLIC_URL`) -> fail closed, 500, before `state` is even
 *    looked at (verifying `state` needs the same secret).
 * 3. `state` missing/expired/mismatched -> rejected, and the code exchange
 *    below is NEVER reached — a forged callback must not spend a real
 *    Slack authorization code.
 * 4. `code` missing -> rejected, no exchange attempted.
 * 5. The exchange itself throws (network) -> generic failure page; only a
 *    fixed message is logged, never the request body (carries
 *    `client_secret` + `code`) or the thrown error object.
 * 6. `oauth.v2.access` returns `ok: false` -> no row written; logged
 *    WITHOUT the code, the client secret, or a token (`slack-oauth.ts`'s
 *    `normalizeSlackOauthResponse` never surfaces those in its `reason`/
 *    `slackError` fields).
 * 7. `is_enterprise_install === true` -> refused outright (spec §5): Grid
 *    org-wide installs break `team_id` keying, so guessing here would risk
 *    delivering one org's messages to another. No row written.
 * 8. A 2xx body missing `access_token`, `bot_user_id`, or `team.id` ->
 *    treated as a failure, never a partial write.
 * 9. Everything checks out -> `upsertSlackInstallation`, then the
 *    "connected" page telling the user to `/invite @Jace` and mention it.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const slackError = params.get("error");
  if (slackError) {
    return html(
      renderSlackErrorPage(
        "Install cancelled",
        "The Slack install was cancelled or declined. Nothing was saved — you can try again anytime."
      )
    );
  }

  const clientId = process.env["SLACK_CLIENT_ID"];
  const clientSecret = process.env["SLACK_CLIENT_SECRET"];
  const consolePublicUrl = process.env["CONSOLE_PUBLIC_URL"];

  if (!clientId || !clientSecret || !consolePublicUrl) {
    console.error(
      "[slack-callback] SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / CONSOLE_PUBLIC_URL must all be set to complete a Slack install."
    );
    return html(
      renderSlackErrorPage(
        "Slack install is not configured",
        "Something is misconfigured on our end. Please try again later."
      ),
      500
    );
  }

  // CSRF: reject on missing/expired/mismatched state BEFORE ever touching
  // `code` — a forged hit on this public URL must never get as far as
  // spending a real authorization code.
  //
  // The same signed state is also the ONLY source of the workspace this
  // install gets attributed to. Reading it here rather than from a query
  // param is what makes the attribution trustworthy: the install route
  // already checked that the signed-in caller was a member of that workspace
  // before signing it in, and any edit to the payload fails the HMAC above,
  // landing on this very branch. `workspaceId` is null for an install that
  // started outside the console (Slack's App Directory), which stores
  // unattributed exactly as it did before.
  const state = params.get("state");
  const verifiedState = readSlackOauthState(clientSecret, state);
  if (!verifiedState) {
    return html(
      renderSlackErrorPage(
        "Link expired",
        "This Slack install link expired or is invalid. Start the install again from Jace."
      ),
      400
    );
  }

  const code = params.get("code");
  if (!code) {
    return html(
      renderSlackErrorPage("Install failed", "Slack did not send an authorization code. Please try again."),
      400
    );
  }

  const redirectUri = buildSlackRedirectUri(consolePublicUrl);
  const body = buildSlackOauthAccessBody({ clientId, clientSecret, code, redirectUri });

  let json: unknown;
  try {
    const res = await fetch(SLACK_OAUTH_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    json = await res.json();
  } catch {
    // Never log `body` (carries client_secret + code) or the caught error
    // itself — only a fixed, value-free message.
    console.error("[slack-callback] failed to reach Slack's oauth.v2.access endpoint");
    return html(renderSlackErrorPage("Install failed", "Couldn't reach Slack. Please try again."), 502);
  }

  const normalized = normalizeSlackOauthResponse(json);

  if (!normalized.ok) {
    if (normalized.reason === "enterprise_install") {
      return html(
        renderSlackErrorPage(
          "Enterprise Grid isn't supported yet",
          "Jace doesn't support org-wide Slack Enterprise Grid installs yet. Install Jace into a single workspace instead."
        )
      );
    }

    // "not_ok" / "missing_fields": Slack's own short error enum (e.g.
    // "invalid_code") is safe to log — it is never the code, the client
    // secret, or a token.
    console.error(
      `[slack-callback] oauth exchange did not produce a usable installation (reason=${normalized.reason}` +
        (normalized.reason === "not_ok" && normalized.slackError ? `, slackError=${normalized.slackError}` : "") +
        ")"
    );
    return html(
      renderSlackErrorPage("Install failed", "Slack couldn't complete the install. Please try again."),
      400
    );
  }

  await upsertSlackInstallation({
    teamId: normalized.installation.teamId,
    teamName: normalized.installation.teamName,
    botToken: normalized.installation.botToken,
    botUserId: normalized.installation.botUserId,
    installedBySlackUserId: normalized.installation.installedBySlackUserId,
    scopes: normalized.installation.scopes,
    enterpriseId: normalized.installation.enterpriseId,
    workspaceId: verifiedState.workspaceId,
  });

  return html(renderSlackConnectedPage(normalized.installation.teamName));
}
