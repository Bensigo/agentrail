import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  isConnectorProvider,
  mintConnectorOauthState,
  clearPendingConnectorOauthStatesForUser,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../../lib/oauth/types";
import { oauthCallbackUri } from "../../../../../../../../lib/oauth/redirect";
import { computeCodeChallengeS256, generateCodeVerifier } from "../../../../../../../../lib/oauth/pkce";
// W3-T2: registers the `railway` OAuth adapter — see the callback route's
// identical import for the full "REACHABILITY" reasoning. W3-T3:
// `lib/oauth/sentry.ts` registers the same way.
import "../../../../../../../../lib/oauth/railway";
import "../../../../../../../../lib/oauth/sentry";

const ADMIN_ROLES = ["owner", "admin"];

/**
 * POST /api/v1/workspaces/[workspaceId]/connectors/oauth/link (W3-T1, OAuth
 * Connect Wave 3 — `.superpowers/sdd/plan-oauth.md`) — mints the single-use
 * OAuth state and returns the vendor's own authorize URL. Session-authed +
 * admin-gated, mirrors `connectors/github/install-link/route.ts`'s own
 * precedent (an explicit button click only): the returned URL carries a
 * single-use, 30-minute `state` bound server-side to THIS
 * (workspaceId, provider) pair — the generic callback route consumes it
 * atomically, so a tampered or replayed state can never bind a token to a
 * workspace the clicker isn't an admin of (see
 * `packages/db-postgres/src/queries/connectors.ts`'s
 * `mintConnectorOauthState`/`consumeConnectorOauthState`). The state also
 * binds THIS session's user id (review CRITICAL-1, W3-T1 fix round) — the
 * callback route requires the redeeming session to match it, closing a
 * login-CSRF-style misdirection where the minter and redeemer were never
 * otherwise required to be the same person (see the callback route's own
 * doc-comment for the full attack + fix).
 *
 * `provider` travels in the BODY (not the URL, unlike github's install-link)
 * — this route is generic across every OAuth-capable provider, per the
 * plan's pinned route shape. Every validation happens BEFORE any DB write:
 * a bad request never mints a state that then goes unused.
 *
 * SESSION-TRANSPORT (W3-T3 fix round, Sentry — `types.ts`'s
 * `stateTransport`): for a provider whose vendor redirect cannot carry
 * `state` at all, this route's job is UNCHANGED in shape (mint the same
 * state-record, return the vendor authorize URL) but adds one extra
 * step — see the call site's own comment below.
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
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can connect via OAuth" },
      { status: 403 }
    );
  }

  let body: { provider?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isConnectorProvider(body.provider)) {
    return NextResponse.json({ error: "Unknown connector provider" }, { status: 400 });
  }

  const adapter = oauthAdapterFor(body.provider);
  if (!adapter) {
    return NextResponse.json(
      { error: "This connector does not support OAuth connect" },
      { status: 400 }
    );
  }

  // Env gating (plan pin): absent env -> 409 with a clear, actionable
  // message, never a half-configured authorize attempt. Checked AFTER the
  // adapter-registered check above (a provider with no adapter at all is a
  // different, earlier failure than one whose adapter exists but isn't
  // enabled on this deployment yet). The generic two-var pair
  // (`oauthConfigFor`) PLUS the adapter's OWN optional `envReady()` (W3-T3
  // fix round — Sentry's third var, `SENTRY_OAUTH_INTEGRATION_SLUG`; absent
  // `envReady` on an adapter defaults to ready, matching every provider
  // before Sentry) — see `types.ts`'s own doc-comment. Both checked here so
  // a slug-missing sentry connect attempt 409s cleanly instead of reaching
  // `authorizeUrl()`'s own throw (which `requireSentryIntegrationSlug`
  // would raise, surfacing as an unhandled 500).
  if (!oauthConfigFor(body.provider) || !(adapter.envReady?.() ?? true)) {
    const label = body.provider.charAt(0).toUpperCase() + body.provider.slice(1);
    return NextResponse.json(
      {
        error: `${label} OAuth isn't configured on this deployment yet. Use an API token instead.`,
      },
      { status: 409 }
    );
  }

  const consolePublicUrl = process.env["CONSOLE_PUBLIC_URL"];
  if (!consolePublicUrl) {
    console.error(
      "[connectors/oauth/link] CONSOLE_PUBLIC_URL must be set to build an OAuth redirect_uri."
    );
    return NextResponse.json(
      { error: "OAuth connect is not configured on this deployment" },
      { status: 500 }
    );
  }

  // PKCE (RFC 7636, W3-T2 fix round) — minted for EVERY oauth connect
  // attempt, unconditionally, and stored in the SAME jsonb state patch as
  // state/expiry/minter (`mintConnectorOauthState`'s optional 4th arg —
  // see `lib/oauth/pkce.ts`'s own doc-comment for why this is generic,
  // provider-agnostic plumbing rather than Railway-specific). Whether the
  // target adapter actually WIRES the resulting `codeChallenge` into its
  // own authorize URL is that adapter's own choice (`AuthorizeUrlInput
  // .codeChallenge`'s doc-comment) — this route always computes and offers
  // it, exactly like it already always builds `ExchangeInput.params`
  // regardless of whether a specific adapter reads it.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallengeS256(codeVerifier);

  // SESSION-TRANSPORT (W3-T3 fix round, Sentry) — see `types.ts`'s
  // `stateTransport` doc-comment and the callback route's own
  // "SESSION-TRANSPORT CSRF ANALYSIS" for the full contract this exists to
  // support: last-mint-wins per (user, provider), across every workspace,
  // BEFORE minting the new one — so a user who opens the connect flow
  // twice (two tabs, a retry) never leaves an earlier, still-pending
  // record around to manufacture false ambiguity for the callback's own
  // "exactly one match" requirement. No-op for `"param"`-transport
  // providers (the mechanism they use — `consumeConnectorOauthState`,
  // keyed by the single-use `state` token itself — has no equivalent
  // ambiguity to guard against).
  if (adapter.stateTransport === "session") {
    await clearPendingConnectorOauthStatesForUser(body.provider, session.user.id);
  }

  const state = await mintConnectorOauthState(workspaceId, body.provider, session.user.id, codeVerifier);
  const redirectUri = oauthCallbackUri(consolePublicUrl, body.provider);
  const url = adapter.authorizeUrl({ state, redirectUri, codeChallenge });

  return NextResponse.json({ url });
}
