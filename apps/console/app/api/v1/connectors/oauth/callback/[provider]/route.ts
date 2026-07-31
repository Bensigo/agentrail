import { NextRequest, NextResponse } from "next/server";
import {
  isConnectorProvider,
  consumeConnectorOauthState,
  setConnectorSecret,
  serializeOauthEnvelope,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../lib/oauth/types";
import {
  connectedRedirectUrl,
  oauthCallbackUri,
  oauthErrorRedirectUrl,
  type OauthErrorReason,
} from "../../../../../../../lib/oauth/redirect";

/**
 * GET /api/v1/connectors/oauth/callback/[provider] (W3-T1, OAuth Connect
 * Wave 3 — `.superpowers/sdd/plan-oauth.md`). The ONE generic callback every
 * OAuth-capable provider is registered with — reachable by anyone on the
 * internet, so every query param is treated as hostile (mirrors
 * `connectors/slack/callback/route.ts`'s own opening line).
 *
 * NO SESSION CHECK (deliberate, disclosed): unlike
 * `connectors/github/install-callback/route.ts` (which requires a session
 * to run its OWN elaborate anti-IDOR ownership check — necessary THERE
 * because that callback is global AND `installation_id` is a low-entropy,
 * guessable, forgeable query param independently valid across ANY
 * workspace), this flow's security boundary is the single-use, 30-minute,
 * high-entropy server-minted `state` alone: `consumeConnectorOauthState`
 * reveals the workspaceId — NEVER a round-tripped query param — and the
 * vendor's `code` is single-use, bound to OUR exact `client_id` +
 * `redirect_uri`, so an attacker who does not control the authorizing
 * vendor account cannot produce a valid one regardless of session state.
 * This mirrors `connectors/slack/callback/route.ts` exactly — the closest
 * real third-party-OAuth2-code-exchange precedent in this codebase, and
 * also session-less for the identical reason.
 *
 * ORDER OF CHECKS (each its own `oauth_error` reason, closed set, NEVER the
 * vendor's own error text — plan pin):
 *   1. `[provider]` path segment isn't a real connector provider ->
 *      `provider_unknown`. Before anything else — a garbage segment makes
 *      every other check meaningless.
 *   2. Vendor sent `?error=` (the user hit Deny, or a vendor-side failure)
 *      -> `denied`. State is NEVER consumed on this branch — a forged hit
 *      must not spend a real single-use state for nothing (mirrors slack's
 *      own "no code exchange even attempted" precedent).
 *   3. `state` or `code` missing -> `state_invalid`. Still no state
 *      consumption (nothing to consume without a state value).
 *   4. `consumeConnectorOauthState` finds no live match (unknown / expired /
 *      already-consumed) -> `state_invalid`. Collapses all three causes
 *      identically (anti-enumeration, mirrors `consumeGithubInstallState`'s
 *      own posture).
 *   5+ WORKSPACE ID IS NOW KNOWN — every later failure redirects to THAT
 *      workspace's own connectors page, per the plan's "redirects to the
 *      connectors page" contract; steps 1-4 above redirect to the
 *      workspace-LESS `/dashboard` root instead (mirrors
 *      `install-callback/route.ts`'s own two-tier redirect precedent
 *      exactly).
 *   5. No adapter registered for `provider`, OR its OAuth env is unset, OR
 *      `CONSOLE_PUBLIC_URL` is unset (redirect_uri cannot be built) ->
 *      `provider_unconfigured`. Re-checks BOTH independently of the link
 *      route's own mint-time check — either could have changed in the
 *      (normally seconds-long) window between mint and redeem.
 *   6. `adapter.exchange()` throws (network error, vendor rejected the
 *      code, malformed response — the adapter's own concern, this route
 *      only distinguishes "did it throw") -> `exchange_failed`.
 *   7. Persisting the rotated envelope (`setConnectorSecret`) throws ->
 *      `store_failed`. The exchange itself DID succeed here — a real
 *      credential was minted and then dropped, our own infra's fault, not
 *      the vendor's.
 *   8. Success -> the plan's pinned `?connected=<provider>` redirect.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ provider: string }> }
) {
  const { provider: providerParam } = await ctx.params;
  const params = request.nextUrl.searchParams;

  const fail = (workspaceId: string | null, reason: OauthErrorReason) =>
    NextResponse.redirect(oauthErrorRedirectUrl(request.url, workspaceId, reason), { status: 302 });

  if (!isConnectorProvider(providerParam)) {
    return fail(null, "provider_unknown");
  }
  const provider = providerParam;

  if (params.get("error")) {
    return fail(null, "denied");
  }

  const state = params.get("state");
  const code = params.get("code");
  if (!state || !code) {
    return fail(null, "state_invalid");
  }

  const consumed = await consumeConnectorOauthState(provider, state);
  if (!consumed) {
    return fail(null, "state_invalid");
  }
  const { workspaceId } = consumed;

  const adapter = oauthAdapterFor(provider);
  if (!adapter || !oauthConfigFor(provider)) {
    return fail(workspaceId, "provider_unconfigured");
  }

  const consolePublicUrl = process.env["CONSOLE_PUBLIC_URL"];
  if (!consolePublicUrl) {
    console.error(
      "[connectors/oauth/callback] CONSOLE_PUBLIC_URL must be set to build an OAuth redirect_uri."
    );
    return fail(workspaceId, "provider_unconfigured");
  }

  // Every OTHER query param besides state/code — Sentry's Public
  // Integration flow carries `installationId` alongside `code` on the SAME
  // generic callback (plan's verified vendor facts); only the Sentry
  // adapter (W3-T3) knows to read it. Never forwards `state`/`code`
  // themselves (already consumed above, and `code` is passed as its own
  // named field).
  const extraParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key === "state" || key === "code") continue;
    extraParams[key] = value;
  }

  const redirectUri = oauthCallbackUri(consolePublicUrl, provider);

  let envelope;
  try {
    envelope = await adapter.exchange({ code, redirectUri, params: extraParams });
  } catch {
    return fail(workspaceId, "exchange_failed");
  }

  try {
    await setConnectorSecret(workspaceId, provider, serializeOauthEnvelope(envelope));
  } catch {
    return fail(workspaceId, "store_failed");
  }

  return NextResponse.redirect(connectedRedirectUrl(request.url, workspaceId, provider), {
    status: 302,
  });
}
