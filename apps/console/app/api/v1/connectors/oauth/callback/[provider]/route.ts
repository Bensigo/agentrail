import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  isConnectorProvider,
  consumeConnectorOauthState,
  setConnectorSecret,
  serializeOauthEnvelope,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../lib/oauth/types";
import {
  connectedRedirectUrl,
  oauthCallbackUri,
  oauthErrorRedirectUrl,
  type OauthErrorReason,
} from "../../../../../../../lib/oauth/redirect";
// W3-T2: registers the `railway` OAuth adapter into `lib/oauth/types.ts`'s
// shared registry as a side effect of this import — see that file's own
// doc-comment ("REACHABILITY") for why every route that calls
// `oauthAdapterFor`/`oauthConfigFor` must import each provider's adapter
// module directly (mirrors `runner/evidence/route.ts`'s identical idiom for
// evidence adapters). W3-T3 adds a sibling `"../../../../../../../lib/oauth/sentry"`
// import here the same way.
import "../../../../../../../lib/oauth/railway";

const ADMIN_ROLES = ["owner", "admin"];

/**
 * GET /api/v1/connectors/oauth/callback/[provider] (W3-T1, OAuth Connect
 * Wave 3 — `.superpowers/sdd/plan-oauth.md`). The ONE generic callback every
 * OAuth-capable provider is registered with — reachable by anyone on the
 * internet, so every query param is treated as hostile (mirrors
 * `connectors/slack/callback/route.ts`'s own opening line).
 *
 * TENANT BINDING (W3-T1 fix round — independent review CRITICAL-1,
 * `.superpowers/sdd/review-W3T1.md`): the original shape trusted the
 * server-minted `state` ALONE to decide which workspace receives the
 * exchanged credential, with no check on who is actually sitting in the
 * browser completing the flow. That defeats FORGERY (state can't be
 * guessed/replayed) but nothing about MISDIRECTION: an attacker, legitimately
 * owner/admin of their OWN Workspace A, could mint a real, unmodified
 * authorize URL (state bound to Workspace A), send it to an unrelated
 * Victim as a phishing pretext ("reauthorize your integration"), and have
 * Victim's own OAuth grant land in the attacker's workspace the instant
 * Victim completes the VENDOR's own consent screen — Victim need not have
 * an AgentRail account at all. `connectors/github/install-callback/route.ts`
 * — the actually-analogous precedent (a public, tenant-writing OAuth-style
 * callback), NOT the slack callback (which never binds a workspace at
 * OAuth-completion time in the first place, see its own doc-comment) —
 * already solves exactly this by requiring `auth()` and
 * `getWorkspaceMembership` before writing anything. This route now mirrors
 * that gate, one step stronger: the state binds the MINTING user's id
 * (`mintConnectorOauthState`'s third arg), and redemption requires the
 * SESSION to (a) equal that bound minter AND (b) still hold owner/admin
 * membership on the bound workspace — not merely "any member," closing the
 * misdirection path completely rather than narrowing it.
 *
 * ORDER OF CHECKS (each its own `oauth_error` reason, closed set, NEVER the
 * vendor's own error text, and NEVER a detail-leaking distinction between
 * causes — plan pin + review CRITICAL-1's "no detail leak" requirement):
 *   1. `[provider]` path segment isn't a real connector provider ->
 *      `provider_unknown`. Before anything else — a garbage segment makes
 *      every other check meaningless.
 *   2. Vendor sent `?error=` (the user hit Deny, or a vendor-side failure)
 *      -> `denied`. State is NEVER consumed on this branch — a forged hit
 *      must not spend a real single-use state for nothing (mirrors slack's
 *      own "no code exchange even attempted" precedent).
 *   3. `state` or `code` missing -> `state_invalid`. Still no state
 *      consumption (nothing to consume without a state value).
 *   4. No authenticated session -> `state_invalid`. Checked BEFORE
 *      consuming state, mirroring `install-callback/route.ts`'s own
 *      auth()-before-consume ordering (a signed-out hit — e.g. a stale
 *      browser tab — never burns a single-use state that a legitimate,
 *      still-logged-in retry could otherwise redeem).
 *   5. `consumeConnectorOauthState` finds no live match (unknown / expired /
 *      already-consumed) -> `state_invalid`. Collapses all three causes
 *      identically (anti-enumeration, mirrors `consumeGithubInstallState`'s
 *      own posture).
 *   6+ WORKSPACE ID (and the bound minter id) ARE NOW KNOWN — every later
 *      failure redirects to THAT workspace's own connectors page, per the
 *      plan's "redirects to the connectors page" contract; steps 1-5 above
 *      redirect to the workspace-LESS `/dashboard` root instead (mirrors
 *      `install-callback/route.ts`'s own two-tier redirect precedent
 *      exactly).
 *   6. The redeeming session's user does not equal the state's bound
 *      minter, OR is not an owner/admin member of the bound workspace (the
 *      membership could have changed since minting — re-checked fresh,
 *      never trusted from mint time) -> `state_invalid`. Collapsed into the
 *      SAME reason as "state genuinely invalid" — deliberately: a prober
 *      must not be able to distinguish "wrong person" from "expired" from
 *      "never existed" from the redirect alone.
 *   7. No adapter registered for `provider`, OR its OAuth env is unset, OR
 *      `CONSOLE_PUBLIC_URL` is unset (redirect_uri cannot be built) ->
 *      `provider_unconfigured`. Re-checks BOTH independently of the link
 *      route's own mint-time check — either could have changed in the
 *      (normally seconds-long) window between mint and redeem.
 *   8. `adapter.exchange()` throws (network error, vendor rejected the
 *      code, malformed response — the adapter's own concern, this route
 *      only distinguishes "did it throw") -> `exchange_failed`, logged
 *      server-side (provider + workspace + a fixed message ONLY — never
 *      the caught error object, which could carry a response body
 *      containing token material; mirrors slack's own caution).
 *   9. Persisting the rotated envelope (`setConnectorSecret`) throws ->
 *      `store_failed`, logged the same way. The exchange itself DID
 *      succeed here — a real credential was minted and then dropped, our
 *      own infra's fault, not the vendor's.
 *   10. Success -> the plan's pinned `?connected=<provider>` redirect.
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

  // Auth checked BEFORE consuming state — see this route's own doc-comment
  // ("ORDER OF CHECKS", step 4) for why (mirrors install-callback.ts).
  const session = await auth();
  if (!session?.user?.id) {
    return fail(null, "state_invalid");
  }

  const consumed = await consumeConnectorOauthState(provider, state);
  if (!consumed) {
    return fail(null, "state_invalid");
  }
  const { workspaceId, userId: mintedByUserId } = consumed;

  // TENANT BINDING (review CRITICAL-1) — see this route's own doc-comment
  // for the full attack this closes. Both checks collapse to the SAME
  // closed reason so neither is distinguishable from the outside.
  if (session.user.id !== mintedByUserId) {
    return fail(workspaceId, "state_invalid");
  }
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return fail(workspaceId, "state_invalid");
  }

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
    // Fixed, value-free message ONLY — never the caught error itself, which
    // could carry a response body with token material (mirrors
    // slack-callback's own logging caution).
    console.error(
      `[connectors/oauth/callback] token exchange failed (provider=${provider}, workspaceId=${workspaceId})`
    );
    return fail(workspaceId, "exchange_failed");
  }

  try {
    await setConnectorSecret(workspaceId, provider, serializeOauthEnvelope(envelope));
  } catch {
    console.error(
      `[connectors/oauth/callback] failed to persist the exchanged credential (provider=${provider}, workspaceId=${workspaceId})`
    );
    return fail(workspaceId, "store_failed");
  }

  return NextResponse.redirect(connectedRedirectUrl(request.url, workspaceId, provider), {
    status: 302,
  });
}
