import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  isConnectorProvider,
  consumeConnectorOauthState,
  consumeConnectorOauthStateBySessionUser,
  setConnectorSecret,
  serializeOauthEnvelope,
  getWorkspaceMembership,
  getConnector,
  upsertConnector,
} from "@agentrail/db-postgres";
import {
  oauthAdapterFor,
  oauthConfigFor,
  type OauthEnvelope,
  type PostExchangeResult,
} from "../../../../../../../lib/oauth/types";
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
// evidence adapters). W3-T3: `lib/oauth/sentry.ts` registers the same way.
import "../../../../../../../lib/oauth/railway";
import "../../../../../../../lib/oauth/sentry";

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
 * SESSION-TRANSPORT (W3-T3 fix round, Sentry — see `types.ts`'s
 * `stateTransport` doc-comment): the paragraph above describes
 * `"param"`-transport tenant binding specifically (state carries the bound
 * minter id, checked against the redeeming session). A provider whose
 * vendor redirect cannot carry `state` AT ALL needs a DIFFERENT mechanism
 * to achieve the SAME property — see step 5 below ("SESSION-TRANSPORT CSRF
 * ANALYSIS") for the full, separately-argued equivalence; it is not weaker,
 * just differently keyed (by the redeeming session's own user id instead
 * of an echoed token).
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
 *   3. `code` missing -> `state_invalid`. For a `"param"`-transport
 *      provider (the default — see `types.ts`'s `stateTransport`
 *      doc-comment), `state` is ALSO required at this same point, checked
 *      right after `code`. A `"session"`-transport provider (Sentry) has
 *      no `state` to check at all — its redirect never carries one
 *      (doc-confirmed absence, `lib/oauth/sentry.ts`'s own doc-comment).
 *      Neither transport has consumed anything yet at this point.
 *   4. No authenticated session -> `state_invalid`. Checked BEFORE
 *      resolving any pending record, for BOTH transports, mirroring
 *      `install-callback/route.ts`'s own auth()-before-consume ordering (a
 *      signed-out hit — e.g. a stale browser tab — never burns a
 *      single-use state that a legitimate, still-logged-in retry could
 *      otherwise redeem).
 *   5. Resolving the pending record fails -> `state_invalid`, collapsing
 *      every cause identically (anti-enumeration, mirrors
 *      `consumeGithubInstallState`'s own posture) — HOW this resolution
 *      happens differs by transport, and this is the fix round's actual
 *      new mechanism:
 *        - `"param"`: `consumeConnectorOauthState(provider, state)` finds
 *          no live match (unknown / expired / already-consumed).
 *        - `"session"`: `consumeConnectorOauthStateBySessionUser(provider,
 *          session.user.id)` — SESSION-TRANSPORT CSRF ANALYSIS (why this is
 *          CSRF-EQUIVALENT to the param-transport mechanism, not a weaker
 *          substitute forced by necessity): tenant binding here is "does
 *          the REDEEMING session's own user id have EXACTLY ONE pending
 *          record for this provider," not "does the redeeming session
 *          match a token the vendor echoed back" (there is none to echo).
 *          Walk the misdirection attack from `mintConnectorOauthState`'s
 *          own doc-comment through to completion under this mechanism: an
 *          attacker mints a state under THEIR OWN session (any user can
 *          mint for any workspace they admin) and sends the resulting
 *          authorize URL to a Victim as a phishing pretext.
 *            - If Victim completes Sentry's consent screen while NOT
 *              signed into AgentRail, step 4 above already rejects
 *              (`state_invalid`, nothing resolved) — same as today.
 *            - If Victim IS signed into AgentRail, THIS step resolves by
 *              VICTIM's own session user id — the pending record was
 *              minted under the ATTACKER's user id, so the lookup finds
 *              ZERO matches for Victim. The grant Sentry just issued is
 *              discarded, never exchanged, never lands in the attacker's
 *              workspace. Symmetrically, an attacker cannot complete a
 *              VICTIM-minted flow either — they'd need the victim's own
 *              session, which they don't have.
 *            - The attacker CAN complete their OWN minted flow under
 *              their OWN session — that is just a normal, legitimate
 *              connect, not an attack.
 *            - Same-user, two-workspace ambiguity (this one user has TWO
 *              pending sentry attempts open at once — e.g. two tabs, two
 *              workspaces they admin) resolves to MULTIPLE candidates ->
 *              REJECTED, and — critically —
 *              `consumeConnectorOauthStateBySessionUser` consumes NEITHER
 *              (see that function's own doc-comment,
 *              `@agentrail/db-postgres`): there is no vendor-echoed token
 *              here to disambiguate which pending attempt this specific
 *              `code`/`installationId` belongs to, so picking one would
 *              risk silently connecting the WRONG workspace. A disclosed
 *              UX tradeoff (finish one connect attempt before starting a
 *              second), not a security hole — this reasoning is mirrored
 *              in the spec doc's Sentry section.
 *   6+ WORKSPACE ID (and the bound minter id) ARE NOW KNOWN — every later
 *      failure redirects to THAT workspace's own connectors page, per the
 *      plan's "redirects to the connectors page" contract; steps 1-5 above
 *      redirect to the workspace-LESS `/dashboard` root instead (mirrors
 *      `install-callback/route.ts`'s own two-tier redirect precedent
 *      exactly).
 *   6. PARAM-TRANSPORT ONLY: the redeeming session's user does not equal
 *      the state's bound minter -> `state_invalid` (collapsed into the
 *      same reason as "state genuinely invalid," same anti-enumeration
 *      reasoning as step 5). Not applicable to `"session"` transport — its
 *      own step-5 lookup is ALREADY keyed by the redeeming session's user
 *      id, so this equality is tautological there, not a separate check.
 *      BOTH transports then re-verify the resolved user is STILL an
 *      owner/admin member of the resolved workspace (the membership could
 *      have changed since minting — re-checked fresh, never trusted from
 *      mint time) -> `state_invalid`.
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
 *      containing token material; mirrors slack's own caution). PKCE
 *      (W3-T2 fix round): `code_verifier` (from the consumed state, if the
 *      minting adapter requested PKCE) rides alongside `code`/`redirectUri`
 *      into this SAME call — an adapter that required a challenge at
 *      authorize time throws here if it comes back missing, landing on
 *      this identical `exchange_failed` branch (no new reason needed).
 *   9. `adapter.postExchange()` (W3-T2 fix round, OPTIONAL — absent for a
 *      provider with nothing to reconcile) runs NEXT, before anything is
 *      persisted: `{ok:false, reason}` (e.g. Railway's `project_not_granted`
 *      when the OAuth grant doesn't cover the workspace's configured
 *      project) fails the connect with THAT specific closed reason,
 *      credential never stored; a THROW (the adapter's own verification
 *      call erroring) is treated exactly like an `exchange()` throw ->
 *      `exchange_failed`, logged the same value-free way. See
 *      `lib/oauth/types.ts`'s `postExchange` doc-comment for the full
 *      contract.
 *   10. Persisting the rotated envelope (`setConnectorSecret`) throws ->
 *      `store_failed`, logged the same way. The exchange (and any
 *      postExchange check) DID succeed here — a real credential was minted
 *      and then dropped, our own infra's fault, not the vendor's.
 *   11. Success -> the plan's pinned `?connected=<provider>` redirect. A
 *      `postExchange`-returned `configPatch` (e.g. Railway auto-filling
 *      `railwayProjectId` when the grant covered exactly one project) is
 *      persisted via `upsertConnector` as a BEST-EFFORT step after the
 *      credential write succeeds — its own failure is logged but does NOT
 *      flip this outcome to a failure redirect; the connection is already
 *      genuinely live and usable (see this route's own inline comment at
 *      the call site for the full reasoning).
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

  const code = params.get("code");
  if (!code) {
    return fail(null, "state_invalid");
  }

  // W3-T3 fix round — peek at the registered adapter's declared transport
  // (see this route's own doc-comment, "ORDER OF CHECKS" step 3, and
  // `types.ts`'s `stateTransport` doc-comment for the full contract). A
  // synchronous, side-effect-free registry lookup — reused below for the
  // REAL provider_unconfigured check (step 7) so this is only ever called
  // once per request. Absent adapter / undeclared field -> `"param"`,
  // today's universal behavior — matches every provider before Sentry and
  // every existing fixture in this route's own test suite, none of which
  // declare this field.
  const adapter = oauthAdapterFor(provider);
  const stateTransport = adapter?.stateTransport ?? "param";

  // PARAM-TRANSPORT ONLY: `state` is ALSO required at this same point,
  // right after `code` — see step 3. A `"session"`-transport provider's
  // redirect never carries one at all (doc-confirmed absence), so nothing
  // to check here for it.
  let state: string | null = null;
  if (stateTransport === "param") {
    state = params.get("state");
    if (!state) {
      return fail(null, "state_invalid");
    }
  }

  // Auth checked BEFORE resolving any pending record, for BOTH transports
  // — see this route's own doc-comment ("ORDER OF CHECKS", step 4) for why
  // (mirrors install-callback.ts).
  const session = await auth();
  if (!session?.user?.id) {
    return fail(null, "state_invalid");
  }

  let workspaceId: string;
  let mintedByUserId: string;
  let codeVerifier: string | null;

  if (stateTransport === "session") {
    // SESSION-TRANSPORT CSRF ANALYSIS — see this route's own doc-comment
    // ("ORDER OF CHECKS", step 5) for the full attack-tree walk this
    // resolution is equivalent-strength against. `mintedByUserId` below
    // equals `session.user.id` BY CONSTRUCTION (the lookup was keyed by
    // it) — no separate equality check is needed the way param-transport's
    // step 6 needs one.
    const resolved = await consumeConnectorOauthStateBySessionUser(provider, session.user.id);
    if (!resolved) {
      return fail(null, "state_invalid");
    }
    workspaceId = resolved.workspaceId;
    mintedByUserId = resolved.userId;
    codeVerifier = resolved.codeVerifier;
  } else {
    const consumed = await consumeConnectorOauthState(provider, state!);
    if (!consumed) {
      return fail(null, "state_invalid");
    }
    workspaceId = consumed.workspaceId;
    mintedByUserId = consumed.userId;
    codeVerifier = consumed.codeVerifier;

    // TENANT BINDING (review CRITICAL-1) — param-transport only, see this
    // route's own doc-comment ("ORDER OF CHECKS", step 6) for the full
    // attack this closes. Collapses to the SAME closed reason as every
    // other tenant-binding failure so neither is distinguishable from the
    // outside.
    if (session.user.id !== mintedByUserId) {
      return fail(workspaceId, "state_invalid");
    }
  }

  // Re-verified fresh for BOTH transports — never trusted from mint time
  // (the membership could have changed since).
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return fail(workspaceId, "state_invalid");
  }

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

  let envelope: OauthEnvelope;
  try {
    envelope = await adapter.exchange({
      code,
      redirectUri,
      params: extraParams,
      // PKCE (W3-T2 fix round) — `undefined` (never `null`) when the mint
      // never carried one, matching `ExchangeInput.codeVerifier`'s own
      // optional-string typing; an adapter that required a challenge at
      // authorize time (Railway) throws below if this comes back missing,
      // landing on the SAME exchange_failed branch this catch already
      // handles.
      codeVerifier: codeVerifier ?? undefined,
    });
  } catch {
    // Fixed, value-free message ONLY — never the caught error itself, which
    // could carry a response body with token material (mirrors
    // slack-callback's own logging caution).
    console.error(
      `[connectors/oauth/callback] token exchange failed (provider=${provider}, workspaceId=${workspaceId})`
    );
    return fail(workspaceId, "exchange_failed");
  }

  // W3-T2 fix round (review Finding #1) — see this route's own doc-comment
  // ("ORDER OF CHECKS", step 9) and `lib/oauth/types.ts`'s `postExchange`
  // doc-comment for the full contract. `configPatch` (if any) is applied
  // AFTER the credential itself is safely stored, below.
  let configPatch: Record<string, string> | undefined;
  if (adapter.postExchange) {
    let currentConfig: Record<string, unknown>;
    try {
      const current = await getConnector(workspaceId, provider);
      // `ConnectorConfig` is a named interface (no index signature) — the
      // cast is safe: every one of its declared fields is a string/boolean/
      // number, each already a structural subtype of `unknown`.
      currentConfig = (current?.config ?? {}) as Record<string, unknown>;
    } catch {
      console.error(
        `[connectors/oauth/callback] failed to read the current config for postExchange (provider=${provider}, workspaceId=${workspaceId})`
      );
      return fail(workspaceId, "exchange_failed");
    }

    let postResult: PostExchangeResult;
    try {
      postResult = await adapter.postExchange({ envelope, config: currentConfig });
    } catch {
      // Same value-free logging discipline as the exchange() catch above —
      // this is the adapter's OWN verification call (e.g. Railway's
      // externalWorkspaces query) erroring, not a vendor rejection of the
      // credential itself, but it fails the connect exactly the same way:
      // closed, credential never stored.
      console.error(
        `[connectors/oauth/callback] postExchange threw (provider=${provider}, workspaceId=${workspaceId})`
      );
      return fail(workspaceId, "exchange_failed");
    }

    if (!postResult.ok) {
      return fail(workspaceId, postResult.reason);
    }
    configPatch = postResult.configPatch;
  }

  try {
    await setConnectorSecret(workspaceId, provider, serializeOauthEnvelope(envelope));
  } catch {
    console.error(
      `[connectors/oauth/callback] failed to persist the exchanged credential (provider=${provider}, workspaceId=${workspaceId})`
    );
    return fail(workspaceId, "store_failed");
  }

  // Best-effort (W3-T2 fix round): a postExchange configPatch (e.g.
  // Railway auto-filling railwayProjectId when the grant covered exactly
  // one project — case (b), `lib/oauth/railway.ts`'s own doc-comment) is a
  // convenience, not the credential itself — the connect has ALREADY
  // genuinely succeeded above. A failure here degrades to "connected, but
  // the project id wasn't auto-filled" — the SAME state postExchange's own
  // case (c) deliberately produces on purpose (config left unset, existing
  // not-configured handling applies) — never a reason to report the whole
  // connect as failed after the credential is already safely stored.
  if (configPatch) {
    try {
      await upsertConnector(workspaceId, provider, { config: configPatch });
    } catch {
      console.error(
        `[connectors/oauth/callback] postExchange configPatch failed to persist (provider=${provider}, workspaceId=${workspaceId})`
      );
    }
  }

  return NextResponse.redirect(connectedRedirectUrl(request.url, workspaceId, provider), {
    status: 302,
  });
}
