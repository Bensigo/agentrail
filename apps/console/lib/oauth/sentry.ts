import { oauthConfigFor, registerOauthAdapter } from "./types";
import type {
  AuthorizeUrlInput,
  ExchangeInput,
  OauthEnvelope,
  OauthProviderAdapter,
  PostExchangeInput,
  PostExchangeResult,
} from "./types";

/**
 * OAuth Connect Wave 3, W3-T3 (`.superpowers/sdd/plan-oauth.md`) — Sentry's
 * `OauthProviderAdapter`, over Sentry's PUBLIC INTEGRATION install flow
 * (NOT Sentry's separate, partner-registration-only "OAuth Integration" —
 * see "TWO UNRELATED SENTRY OAUTH MECHANISMS" below, the root of this
 * file's headline finding).
 *
 * DOC-VERIFICATION (BINDING — this session's own discipline after a
 * fabricated citation shipped a fake GraphQL type elsewhere this week):
 * every fact below is a QUOTED line from a RAW `curl` fetch (not a WebFetch
 * summary) of `docs.sentry.io/integrations/integration-platform/
 * public-integration.md` and `docs.sentry.io/api/auth.md` — see the task
 * report for the full quoted trail.
 *
 * ============================================================================
 * STATE CANNOT ROUND-TRIP — read this before changing this file's wiring.
 * ============================================================================
 * The plan's own vendor-facts table (`plan-oauth.md`, and this repo's spec
 * doc) carried a provisional belief: "docs historically say state is
 * supported." That belief does NOT hold for the flow this task is pinned
 * to. `public-integration.md`'s own "OAuth Process" section — read in
 * full, every worked example — documents the redirect as carrying ONLY
 * `code` and `installationId`:
 *
 *   "However, if your integration has a redirect URL configured, the
 *   integration redirects the user's browser to the configured URL with
 *   the grant code and installation ID in the query params."
 *
 * and its own worked Flask handler reads exactly those two, nothing else:
 *
 *   "code = request.args.get('code')
 *    install_id = request.args.get('installationId')"
 *
 * No worked example anywhere on that page shows a `state` value on the
 * redirect, and the one place `"state"` appears at all in that page's own
 * JSON is a field INSIDE the authorization response itself (not a query
 * param), always `null` in the example:
 *
 *   '{ "id": "38", "token": "...", "refreshToken": "...",
 *      "dateCreated": "...", "expiresAt": "...", "state": null,
 *      "application": null }'
 *
 * TWO UNRELATED SENTRY OAUTH MECHANISMS (the likely source of the stale
 * belief): Sentry documents a SEPARATE "OAuth Integration" mechanism
 * (`docs.sentry.io/integrations/integration-platform/oauth-integration/`,
 * pointing to `docs.sentry.io/api/auth.md#oauth2` for the full flow) whose
 * authorize endpoint (`https://sentry.io/oauth/authorize/`) DOES document
 * `state` ("Random string to prevent CSRF attacks") and PKCE, over a
 * completely different endpoint pair (`/oauth/authorize/`, `/oauth/token/`)
 * with different response field names (`access_token`/`refresh_token`/
 * `expires_in`, standard OAuth2 shape). But that mechanism is NOT
 * self-serve — its own doc's "Partner Registration" section is explicit:
 * "Before implementing OAuth, Sentry must register your application.
 * Contact our partnership team with: Client Name, Redirect URIs, ..." —
 * confirmed 404 for any attempt to reach it as a self-registerable app
 * (there is no Developer-Settings-style self-serve flow for it). The
 * plan's own pin ("Sentry: v1 uses the PUBLIC INTEGRATION flow") chose
 * Public Integration SPECIFICALLY because it is self-serve — so this
 * adapter is correctly scoped to Public Integration, and Public
 * Integration's own docs confirm-absent a `state` param, full stop.
 *
 * ============================================================================
 * SESSION-TRANSPORT TENANT BINDING (W3-T3 fix round — coordinator ruling,
 * option B: do not defer, do not ship stateless — implement a mechanism).
 * ============================================================================
 * `stateTransport: "session"` (declared on this adapter below — see
 * `types.ts`'s own doc-comment for the full, provider-agnostic contract).
 * Since the vendor cannot echo a `state` token, the callback route resolves
 * which workspace a hit belongs to by a DIFFERENT, still session-bound
 * mechanism: it requires an authenticated session (exactly like the
 * `"param"` path, same position — BEFORE resolving anything), then looks
 * up the pending record by the REDEEMING SESSION'S OWN user id
 * (`consumeConnectorOauthStateBySessionUser(provider, session.user.id)`,
 * `@agentrail/db-postgres`) instead of by an opaque token pulled off the
 * URL. EXACTLY ONE unexpired pending record for that (provider, userId)
 * pair, across every workspace, is required — zero or multiple is the
 * SAME closed `state_invalid` reason as every other tenant-binding
 * failure, and (critically) NOTHING is consumed on an ambiguous multiple
 * match. The full CSRF-equivalence argument lives on the callback route's
 * own `stateTransport === "session"` branch (search
 * "SESSION-TRANSPORT CSRF ANALYSIS" there) and is mirrored in the spec
 * doc's Sentry section — not restated here to avoid two copies drifting.
 *
 * The link route mints the SAME state-record shape either way
 * (`mintConnectorOauthState`, `oauthState`/`oauthStateExpiresAt`/
 * `oauthUserId` — unchanged), but for a `"session"` provider it FIRST
 * clears every OTHER pending record this user has for this provider,
 * across every workspace (`clearPendingConnectorOauthStatesForUser`,
 * last-mint-wins per (user, provider) — see that function's own
 * doc-comment for the bounded-query shape) — this is what keeps the
 * callback's "exactly one" resolution actually exactly-one in the common
 * case (a user retrying, or double-clicking Connect, doesn't leave a
 * second stale candidate behind to manufacture false ambiguity).
 * `authorizeUrl()` below still never embeds the `state`/`codeChallenge`
 * inputs it's handed (harmless — the link route mints them unconditionally
 * for every provider regardless of transport, mirroring how PKCE is always
 * minted even for a provider that ignores it).
 *
 * ============================================================================
 * INSTALLATION ID THREADING — disclosed choice (task explicitly offered two:
 * "thread it via the envelope OR a refresh input the as-built interface
 * supports").
 * ============================================================================
 * Sentry's refresh call needs `installationId` as part of the URL itself
 * (`.../sentry-app-installations/{installationId}/authorizations/`), but
 * `OauthProviderAdapter.refresh(envelope: OauthEnvelope)` (T1/T2, unchanged
 * by this task) receives ONLY the envelope — no `workspaceId`, no `config`.
 * `exchange()` DOES have `installationId` for free (Sentry's redirect
 * carries it in `ExchangeInput.params`), but that is a DIFFERENT request,
 * long before any later `refresh()` call, and the stored envelope is the
 * ONLY thing that survives between them.
 *
 * CHOSEN: thread it via the envelope's own `refresh` field, JSON-encoded —
 * `refresh = JSON.stringify({installationId, refreshToken})` — rather than
 * extending `OauthProviderAdapter.refresh`'s signature (the interface's own
 * doc-comment already anticipates additive extension here; T2's fix round
 * did exactly that for `postExchange`/PKCE). Reasons:
 *   1. Fully self-contained to this file — zero changes to `core.ts`/
 *      `types.ts` (T1's approved, base-of-the-stack files) or `railway.ts`/
 *      their test suites. Given W3-T1/T2 are already reviewed and merged,
 *      minimizing blast radius on shared plumbing for a need that is
 *      (today) sentry-specific is the more conservative choice; a THIRD
 *      provider later needing refresh-time config is better evidence for
 *      generalizing the interface than a single current case.
 *   2. `access` and `expiresAt` are read/used verbatim elsewhere
 *      (`resolveProviderAuth` returns `access` straight through as the
 *      Bearer credential; `needsRefresh` parses `expiresAt` as a date) —
 *      `refresh` is the ONLY field of the three that is otherwise fully
 *      opaque outside this file (nothing in `core.ts`/db-postgres inspects
 *      its contents, only its presence-as-a-string), making it the one
 *      safe place to carry extra structure.
 *   3. JSON (not a hand-picked delimiter like `installationId::token`)
 *      because Sentry's own refresh token charset is undocumented — a
 *      delimiter risks collision; JSON has none, and this codebase already
 *      uses the identical discriminated-JSON-string-in-an-opaque-column
 *      pattern one layer up (`secret-envelope.ts`'s own
 *      `{"oauth":1,...}` envelope) — applying it one level deeper here is
 *      the SAME idiom, not a new one.
 * `postExchange` decodes the SAME field (it receives the exact envelope
 * `exchange()` just returned) to recover `installationId` for its
 * `configPatch` — no separate plumbing needed for that leg either.
 * `decodeRefreshField` never trusts the shape (throws on anything that
 * isn't `{installationId: string, refreshToken: string}`, both non-empty)
 * — this should only ever fail on a bug in THIS file's own encoding, since
 * nothing else ever writes to `refresh`.
 *
 * ============================================================================
 * REQUEST BODY: JSON, not form-urlencoded (unlike Railway) — confirmed from
 * the docs' own worked Python example, `requests.post(url, json=payload)`,
 * which serializes `payload` as a JSON body with `Content-Type:
 * application/json` — every one of the doc's THREE worked exchange/refresh
 * snippets uses this exact call shape, never `data=`.
 *
 * RESPONSE FIELD NAMES — CONFIRMED, camelCase, NOT the generic-OAuth2 shape
 * (`access_token`/`refresh_token`/`expires_in`) Railway/the unrelated OAuth
 * Integration mechanism use:
 *
 *   '{ "id": "38", "token": "ec48bf...", "refreshToken": "c866f1...",
 *      "dateCreated": "2019-08-07T20:25:09.870Z",
 *      "expiresAt": "2019-08-08T04:25:09.870Z", "state": null,
 *      "application": null }'
 *
 * `token` (not `access_token`), `refreshToken` (not `refresh_token`), and —
 * materially different from every other adapter in this codebase —
 * `expiresAt` is an ABSOLUTE ISO-8601 timestamp already, not an
 * `expires_in` seconds-delta requiring `Date.now() + n*1000` arithmetic
 * (Railway's own `requestToken` does that arithmetic; this adapter uses
 * the vendor's `expiresAt` value directly — it happens to already match
 * `OauthEnvelope.expiresAt`'s own "ISO-8601" contract with zero
 * conversion). Defensively re-validated as a parseable date regardless
 * (never trusts an unconfirmed shape) — a response whose `expiresAt`
 * doesn't parse throws, exactly like a missing `token`/`refreshToken`
 * does.
 *
 * ACCESS TTL — CONFIRMED: "These tokens automatically expire every eight
 * hours, meaning they must be refreshed manually."
 *
 * TOKEN EXCHANGE ENDPOINT + PAYLOAD — CONFIRMED verbatim (the doc's own
 * worked Flask `/setup` handler):
 *
 *   "url = u'https://sentry.io/api/0/sentry-app-installations/{}/
 *    authorizations/'
 *    ...
 *    payload = { 'grant_type': 'authorization_code', 'code': code,
 *                'client_id': 'your-client-id',
 *                'client_secret': 'your-client-secret' }
 *    resp = requests.post(url, json=payload)"
 *
 * EXTERNAL-INSTALL URL — CONFIRMED verbatim: "All public integrations can
 * be installed via a fixed external url:
 * `https://sentry.io/sentry-apps/<your-integration-slug>/external-install/`,
 * that you can expose to users." — the slug comes from
 * `SENTRY_OAUTH_INTEGRATION_SLUG` (this task's own new env var, alongside
 * `SENTRY_OAUTH_CLIENT_ID`/`_CLIENT_SECRET` — all three gate `oauthReady`
 * for sentry: the generic two-var pair via `oauthConfigFor` PLUS this
 * adapter's own `envReady()` below, which the connectors GET route/link
 * route both check alongside it, generically, via the interface's own
 * `envReady?()` capability — see `types.ts`'s own doc-comment).
 *
 * ============================================================================
 * REFRESH METHOD — disclosed deviation from the doc's OWN top recommendation.
 * ============================================================================
 * The docs describe TWO refresh mechanisms and are explicit about their
 * relative standing: "Refreshing Tokens Manually for Integrators
 * (recommended)" — a JWT (HS256, signed with the client secret, custom
 * `urn:sentry:params:oauth:grant-type:jwt-bearer` grant claims) — versus
 * "Refreshing Tokens via Refresh Token (not recommended)": "We recommend
 * Refreshing Tokens Manually as described above. But if you prefer, you
 * can use Refresh Token." This adapter implements the SECOND (refresh-
 * token-grant) mechanism — matching the plan's own pinned design
 * ("refresh via same endpoint grant_type=refresh_token") and this task's
 * own explicit instruction — which the docs confirm is still fully valid
 * and supported, just not their top pick. The doc's own rationale for
 * preferring the JWT method is a specific edge case ("technical anomalies
 * can lead to token refreshing being committed on the Sentry side but then
 * the token is lost in transmission on the way back") that the
 * refresh-token-grant approach is not immune to. Disclosed, not silently
 * chosen: a future task could upgrade this adapter to the JWT method (a
 * materially bigger implementation — HS256 JWT signing, iat/exp/jti
 * claims) the same way Railway's PKCE went from disclosed-gap to
 * implemented across a fix round, if the rotation-loss edge case proves
 * real in practice.
 *
 * ============================================================================
 * VERIFY INSTALL — CONFIRMED present, CONDITIONAL, implemented BEST-EFFORT.
 * ============================================================================
 * "Typically, if you have the redirect URL configured, there is work
 * happening on your end to 'finalize' the installation. If this is the
 * case, we recommend enabling the 'Verify Install' option for your
 * integration. Once enabled, you'll need to send a request marking the
 * installation as officially 'installed': `requests.put(
 * 'https://sentry.io/api/0/sentry-app-installations/{}/'.format(
 * install_id), json={'status': 'installed'})`" — this is an OPT-IN toggle
 * set when the integration is registered in Sentry's Developer Settings
 * (an out-of-band, manual, one-time step — see the spec doc's owner-
 * registration checklist), not something this code can detect from the
 * exchange response. `postExchange` (below) ALWAYS attempts this PUT
 * (never conditionally — there is no reliable in-band signal for whether
 * the toggle is on), using `Authorization: Bearer <fresh access token>`
 * (an INFERENCE, not directly shown in the doc's own snippet — every OTHER
 * authenticated Sentry API call in this codebase and in
 * `docs.sentry.io/api/auth.md`'s "Using Access Tokens" section uses this
 * exact scheme, and no alternative is documented anywhere for this specific
 * endpoint). UNLIKE Railway's `postExchange` verification call (which is
 * deliberately NOT try/caught — a correctness-critical grant-mismatch
 * check that must fail the whole connect closed), this call IS caught and
 * treated as BEST-EFFORT: its own applicability is toggle-dependent and
 * unconfirmed for an integration where the toggle is off (calling a
 * conditionally-relevant PUT unconditionally and failing the ENTIRE connect
 * closed on every ambiguous non-2xx would break the common case where
 * Verify Install isn't even enabled). The downstream failure mode if a
 * genuinely-required verify silently doesn't happen is NOT a silent wrong-
 * data risk (unlike Railway's project-mismatch case) — it degrades LEGIBLY
 * on the next evidence call via the SAME `EvidenceDegradationReason`
 * machinery (`unauthorized`/`upstream_error`), same as any other auth
 * problem — so failing open here, loudly logged, is the safer asymmetry.
 *
 * ============================================================================
 * PKCE — NOT USED. Public Integration's exchange payload
 * (`grant_type`/`code`/`client_id`/`client_secret` only, confirmed above)
 * has no `code_verifier` field in any worked example — this is a
 * confidential-client, client-secret-authenticated exchange with no PKCE
 * concept, unlike Railway's. `AuthorizeUrlInput.codeChallenge`/
 * `ExchangeInput.codeVerifier` are both ignored by this adapter, exactly
 * like `ExchangeInput.params` is ignored by Railway's.
 *
 * CREDENTIAL — same Bearer presentation as every other provider in this
 * codebase (`Authorization: Bearer <token>`,
 * `docs.sentry.io/api/auth.md`'s own "Using Access Tokens" section) —
 * `lib/evidence/sentry.ts` (this task) switches to `resolveProviderAuth`,
 * identical to `lib/evidence/railway.ts`'s W3-T2 switch; nothing about how
 * a credential is PRESENTED changes, only how it is acquired/refreshed.
 */

const SENTRY_API_BASE = "https://sentry.io/api/0";
const SENTRY_OAUTH_TIMEOUT_MS = 8000;

/** Reads sentry's client id/secret (the two vars `oauthConfigFor` already
 * knows how to gate generically). Both routes that call into this adapter
 * gate on `oauthConfigFor` themselves first (mirrors `railway.ts`'s
 * identical defense-in-depth reasoning) — this is a second, redundant
 * check for a direct caller (this module's own tests included). */
function requireSentryClientCredentials(): { clientId: string; clientSecret: string } {
  const config = oauthConfigFor("sentry");
  if (!config) {
    throw new Error(
      "sentry OAuth is not configured (SENTRY_OAUTH_CLIENT_ID/SENTRY_OAUTH_CLIENT_SECRET unset)"
    );
  }
  return config;
}

/** Reads the THIRD env var this provider needs beyond the generic
 * `oauthConfigFor` pair — the Public Integration's slug, used to build the
 * external-install URL. `oauthConfigFor`/the connectors GET route's
 * `oauthReady` derivation only ever check the generic two-var shape (a
 * fixed, provider-agnostic function T1 owns — not modified by this task),
 * so this THIRD gate is enforced here, inside the adapter itself, rather
 * than by widening a shared function for one provider's extra field. */
function requireSentryIntegrationSlug(): string {
  const slug = process.env["SENTRY_OAUTH_INTEGRATION_SLUG"];
  if (!slug) {
    throw new Error("sentry OAuth is not configured (SENTRY_OAUTH_INTEGRATION_SLUG unset)");
  }
  return slug;
}

interface SentryRefreshField {
  installationId: string;
  refreshToken: string;
}

/** See this module's own doc-comment ("INSTALLATION ID THREADING"). */
function encodeRefreshField(installationId: string, refreshToken: string): string {
  return JSON.stringify({ installationId, refreshToken });
}

/** Never trusts the shape — throws on anything that isn't
 * `{installationId: string, refreshToken: string}`, both non-empty. Should
 * only ever fail on a bug in this file's own encoding (nothing else ever
 * writes to an OAuth envelope's `refresh` field for the `"sentry"`
 * provider). */
function decodeRefreshField(refreshField: string): SentryRefreshField {
  let parsed: unknown;
  try {
    parsed = JSON.parse(refreshField);
  } catch {
    throw new Error("sentry oauth envelope's refresh field is not the expected compound JSON shape");
  }
  const installationId =
    parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).installationId === "string"
      ? ((parsed as Record<string, unknown>).installationId as string)
      : null;
  const refreshToken =
    parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).refreshToken === "string"
      ? ((parsed as Record<string, unknown>).refreshToken as string)
      : null;
  if (!installationId || !refreshToken) {
    throw new Error("sentry oauth envelope's refresh field is missing installationId/refreshToken");
  }
  return { installationId, refreshToken };
}

interface SentryAuthorizationResponse {
  token?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
}

/**
 * One POST to the authorizations endpoint, shared by `exchange`
 * (grant_type=authorization_code) and `refresh` (grant_type=refresh_token)
 * — the only difference between the two calls is which grant params they
 * pass in, exactly mirroring `railway.ts`'s `requestToken` split. Never
 * try/catch-wrapped around the `fetch` call itself: a thrown fetch
 * propagates uncaught to whichever caller needs that (`exchange()`'s throw
 * is the callback route's own `exchange_failed` branch; `refresh()`'s
 * throw is `core.ts`'s `resolveProviderAuth` degrading to `unauthorized`).
 */
async function requestAuthorization(
  installationId: string,
  grantParams: Record<string, string>
): Promise<{ access: string; refreshToken: string; expiresAt: string }> {
  const { clientId, clientSecret } = requireSentryClientCredentials();

  const res = await fetch(
    `${SENTRY_API_BASE}/sentry-app-installations/${encodeURIComponent(installationId)}/authorizations/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "agentrail-console",
      },
      // JSON body — see this module's own doc-comment ("REQUEST BODY").
      body: JSON.stringify({ ...grantParams, client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(SENTRY_OAUTH_TIMEOUT_MS),
    }
  );

  if (!res.ok) {
    // Never echoes the response body — same discipline as railway.ts's
    // identical caution.
    throw new Error(`sentry oauth authorizations endpoint returned HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => null)) as SentryAuthorizationResponse | null;
  const token = typeof body?.token === "string" && body.token ? body.token : null;
  const refreshToken = typeof body?.refreshToken === "string" && body.refreshToken ? body.refreshToken : null;
  const expiresAt = typeof body?.expiresAt === "string" && body.expiresAt ? body.expiresAt : null;

  if (!token || !refreshToken || !expiresAt || Number.isNaN(new Date(expiresAt).getTime())) {
    throw new Error("sentry oauth authorizations endpoint returned an unexpected response shape");
  }

  return { access: token, refreshToken, expiresAt };
}

/** Best-effort — see this module's own doc-comment ("VERIFY INSTALL") for
 * why this is caught rather than propagated. Logs a fixed, value-free
 * message (installationId + status/error, never a response body) on
 * failure, mirroring `core.ts`'s established token-free logging
 * discipline. */
async function verifyInstallBestEffort(installationId: string, accessToken: string): Promise<void> {
  try {
    const res = await fetch(`${SENTRY_API_BASE}/sentry-app-installations/${encodeURIComponent(installationId)}/`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "agentrail-console",
      },
      body: JSON.stringify({ status: "installed" }),
      signal: AbortSignal.timeout(SENTRY_OAUTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[oauth/sentry] verify-install PUT returned a non-2xx status (installationId=${installationId}, status=${res.status}) — best-effort, does not fail the connect (see this module's own doc-comment, "VERIFY INSTALL")`
      );
    }
  } catch {
    console.error(
      `[oauth/sentry] verify-install PUT failed (installationId=${installationId}) — best-effort, does not fail the connect (see this module's own doc-comment, "VERIFY INSTALL")`
    );
  }
}

export const sentryOauthAdapter: OauthProviderAdapter = {
  provider: "sentry",

  // W3-T3 fix round — see this module's own doc-comment
  // ("SESSION-TRANSPORT TENANT BINDING") and `types.ts`'s `stateTransport`
  // doc-comment for the full contract.
  stateTransport: "session",

  // W3-T3 fix round — the third env var (SENTRY_OAUTH_INTEGRATION_SLUG)
  // beyond the generic oauthConfigFor pair; read generically by the
  // connectors GET route/link route alongside oauthConfigFor.
  envReady(): boolean {
    return Boolean(process.env["SENTRY_OAUTH_INTEGRATION_SLUG"]);
  },

  /** Pure and synchronous per `OauthProviderAdapter`'s own contract. See
   * this module's own doc-comment ("STATE CANNOT ROUND-TRIP") for why
   * `state`/`codeChallenge` are both deliberately IGNORED — embedding
   * either would be silently misleading, since Sentry's external-install
   * URL neither accepts nor echoes them back (tenant binding for this
   * provider happens a different way entirely — see
   * "SESSION-TRANSPORT TENANT BINDING" immediately below that section). */
  authorizeUrl(_input: AuthorizeUrlInput): string {
    requireSentryClientCredentials();
    const slug = requireSentryIntegrationSlug();
    return `https://sentry.io/sentry-apps/${encodeURIComponent(slug)}/external-install/`;
  },

  /** `installationId` comes from `ExchangeInput.params` — the generic
   * callback route forwards every non-state/code query param verbatim (see
   * `connectors/oauth/callback/[provider]/route.ts`'s own doc-comment,
   * "Every OTHER query param besides state/code"), and Sentry's redirect
   * always carries it (doc-confirmed). `redirectUri`/`codeVerifier` are
   * both unused — Sentry's exchange payload has no room for either (see
   * this module's own doc-comment, "PKCE — NOT USED"). */
  async exchange({ code, params }: ExchangeInput): Promise<OauthEnvelope> {
    const installationId = params["installationId"];
    if (!installationId) {
      throw new Error(
        "sentry oauth exchange missing installationId (Sentry's Public Integration redirect always carries it — this indicates a bug, or a non-Sentry request reaching this adapter)"
      );
    }
    const result = await requestAuthorization(installationId, {
      grant_type: "authorization_code",
      code,
    });
    return {
      access: result.access,
      refresh: encodeRefreshField(installationId, result.refreshToken),
      expiresAt: result.expiresAt,
    };
  },

  /** `installationId` is recovered from the envelope's own `refresh` field
   * — see this module's own doc-comment ("INSTALLATION ID THREADING").
   * Always returns whatever `refreshToken` the response carries, re-encoded
   * with the SAME installationId (it never changes across refreshes) —
   * mirrors railway.ts's "never reuse the token it was called with"
   * discipline for the underlying vendor token; `core.ts`'s
   * `resolveProviderAuth` already persists exactly what this returns. */
  async refresh(envelope: OauthEnvelope): Promise<OauthEnvelope> {
    const { installationId, refreshToken } = decodeRefreshField(envelope.refresh);
    const result = await requestAuthorization(installationId, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return {
      access: result.access,
      refresh: encodeRefreshField(installationId, result.refreshToken),
      expiresAt: result.expiresAt,
    };
  },

  /** Two jobs, both unconditional: (1) best-effort verify-install (see this
   * module's own doc-comment, "VERIFY INSTALL") — never fails the connect;
   * (2) persist `sentryInstallationId` via `configPatch` so it survives for
   * a LATER `refresh()` call to read back out of the envelope regardless
   * (this configPatch is a convenience for visibility/support, per the
   * task's own explicit ask — `refresh()` above never reads config, only
   * the envelope). Unlike railway's postExchange, there is no
   * grant-mismatch to reconcile here — a Sentry Public Integration install
   * has no per-connect "which resource did the user pick" step the way
   * `project:viewer` does, so this always succeeds once the envelope
   * itself is well-formed. */
  async postExchange({ envelope }: PostExchangeInput): Promise<PostExchangeResult> {
    const { installationId } = decodeRefreshField(envelope.refresh);
    await verifyInstallBestEffort(installationId, envelope.access);
    return { ok: true, configPatch: { sentryInstallationId: installationId } };
  },
};

// Registers the adapter into the shared in-process registry — mirrors
// `railway.ts`'s identical call. W3-T3 fix round: this module IS now
// side-effect-imported by the three live routes (see each route's own
// `import "./sentry"` line) — `oauthReady` for sentry reflects the real
// three-env-var gate (`oauthConfigFor` + this adapter's own `envReady()`)
// once this module is reachable, matching `types.ts`'s own "REACHABILITY"
// doc-comment.
registerOauthAdapter(sentryOauthAdapter);
