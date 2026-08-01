import { oauthConfigFor, registerOauthAdapter } from "./types";
import type { AuthorizeUrlInput, ExchangeInput, OauthEnvelope, OauthProviderAdapter } from "./types";

/**
 * OAuth Connect Wave 3, W3-T6 (`.superpowers/sdd/plan-oauth.md`) — Cloudflare's
 * `OauthProviderAdapter`. Fills in T1's seam (`./types.ts`/`./core.ts`,
 * unchanged by this task) the same way `./railway.ts` did — this file's ONLY
 * job is to talk to Cloudflare's OAuth server correctly and return the exact
 * rotated pair it issues; `resolveProviderAuth` (`./core.ts`) calls
 * `refresh` on our behalf and persists whatever it returns.
 *
 * DOC-VERIFICATION (BINDING — this session's own discipline after a
 * fabricated citation shipped a fake GraphQL type elsewhere this week, see
 * `lib/evidence/cloudflare.ts`'s own doc-comment for that history): every
 * fact below is read from a RAW `curl` fetch of the doc page's own markdown
 * source (`<page>/index.md`) OR Cloudflare's own LIVE OIDC discovery
 * document at `https://dash.cloudflare.com/.well-known/openid-configuration`
 * — the single most authoritative source available (it is the real
 * production server's own self-description, not prose ABOUT the server) —
 * never a WebFetch summary. Sources: `developers.cloudflare.com/fundamentals/
 * oauth/{index,authorizing-an-application,create-an-oauth-client,
 * integrate-with-cloudflare}/index.md`, `.../fundamentals/api/reference/
 * permissions/index.md`, `.../analytics/graphql-api/getting-started/
 * authentication/api-token-auth/index.md`, and the live discovery document.
 *
 *   - ENDPOINTS — CONFIRMED, from TWO independent sources (the prose doc AND
 *     the live discovery document agree verbatim):
 *       "* Authorization: `https://dash.cloudflare.com/oauth2/auth`
 *        * Token: `https://dash.cloudflare.com/oauth2/token`
 *        * Revoke: `https://dash.cloudflare.com/oauth2/revoke`"
 *       — `integrate-with-cloudflare/index.md`. The live discovery document
 *     independently confirms the same three URLs verbatim
 *     (`authorization_endpoint`/`token_endpoint`/`revocation_endpoint`) plus
 *     reveals this is a standard OIDC provider (issuer
 *     `https://dash.cloudflare.com`) — this matters below, since it licenses
 *     reading the discovery document's own declared support surface as an
 *     authoritative source for exact param names the PROSE docs never show
 *     in a worked example (unlike Railway's, which has literal worked
 *     `curl` examples for every call this adapter makes). `revoke` has no
 *     home on {@link OauthProviderAdapter} (T1's interface doesn't define a
 *     revoke capability) — confirmed present, not wired, out of scope here,
 *     same as every other adapter in this codebase.
 *
 *   - PKCE — **CORRECTS a session-research belief AND a stale claim already
 *     shipped in `lib/oauth/railway.ts`'s own doc-comment and the spec doc**
 *     ("Combined with Cloudflare's own OAuth ... REQUIRING PKCE regardless
 *     of client type"). The raw doc's own client-type table says otherwise:
 *       "| Server-side web app or backend service | Authorization Code with
 *        a client secret | client_secret_basic or client_secret_post |
 *        Optional/not required |
 *        | Browser-based, mobile, desktop, or CLI app | Authorization Code
 *        with PKCE | none | Required, S256 |"
 *       — `create-an-oauth-client/index.md`, "Choose a flow". PKCE is
 *     required ONLY for a public client with no secret — for a server-side
 *     backend service (this console's own case, exactly Railway's "Web
 *     (Confidential)" category), it is "Optional/not required," mirroring
 *     Railway's own "Recommended, not Required" finding almost exactly. The
 *     docs win — flagged loudly, per this session's own binding instruction.
 *     **Implemented anyway, REQUIRED by this adapter** — not because the
 *     docs mandate it, but because this task's own brief pins it (mirroring
 *     Railway's identical W3-T2 fix-round choice: the shared PKCE plumbing
 *     already exists, `./pkce.ts`, built specifically so a future adapter
 *     like this one never has to retrofit it) and because Cloudflare's own
 *     docs still independently confirm PKCE IS a real, supported mechanism
 *     for this client type: `code_challenge_methods_supported: ["plain",
 *     "S256"]` (live discovery document) — S256 used exclusively, same
 *     reasoning as `./pkce.ts`'s own doc-comment. `authorizeUrl`/`exchange`
 *     below throw if the PKCE fields are missing, exactly like
 *     `railway.ts`'s identical "required, not best-effort" choice.
 *
 *   - CLIENT TYPE / AUTH METHOD — server-side backend service (this
 *     console), so: Authorization Code WITH a client secret,
 *     `client_secret_basic` (chosen over the also-documented
 *     `client_secret_post`, matching Railway's own precedent and the
 *     REGISTRATION form's own worked example — see "REGISTRATION" below).
 *     Confirmed as a valid, live-server-supported method:
 *     `token_endpoint_auth_methods_supported: ["client_secret_post",
 *     "client_secret_basic", "private_key_jwt", "none"]` (live discovery
 *     document). The owner MUST select "client_secret_basic" as the Token
 *     authentication method when registering the client (a per-client
 *     setting chosen once at creation, per `create-an-oauth-client.md`'s own
 *     worked API example: `"token_endpoint_auth_method":
 *     "client_secret_basic"`) — a mismatch here is a registration error, not
 *     something this code can detect or correct.
 *
 *   - SCOPES — CONFIRMED that scope strings correspond to API token
 *     permission names: "OAuth scope names correspond to Cloudflare API
 *     token permission names. Use the Cloudflare API documentation to
 *     identify the permissions your client needs." — `create-an-oauth-client
 *     /index.md`, "Select scopes". Two DIFFERENT kinds of scope, confirmed
 *     from two different angles:
 *       1. UNIVERSAL / OIDC-standard, confirmed via the live discovery
 *          document's own `scopes_supported: ["offline_access", "offline",
 *          "openid"]` — sent on EVERY authorize call, unconditionally
 *          (`CLOUDFLARE_OAUTH_BASE_SCOPES` below): `openid` (identity) and
 *          `offline_access` (refresh-token issuance — the OIDC-standard
 *          name; `offline` also appears in the discovery document but no
 *          worked example anywhere confirms it does anything DIFFERENT from
 *          `offline_access`, so this adapter sends the standard-named one
 *          only, never guessing that the second alias is required too).
 *       2. RESOURCE/PERMISSION scope (what actually grants read access to
 *          this connector's data) — **GENUINELY UNDOCUMENTED as a fixed,
 *          citable string.** The docs are explicit that the exact scope ID
 *          is discovered per-account, not published in prose: "Fetch the
 *          available scopes from the API. Use the scope ID when you create
 *          a client through the API. `curl
 *          "https://api.cloudflare.com/client/v4/oauth/scopes" -H
 *          "Authorization: Bearer $API_TOKEN"`" (same page) — this requires
 *          an authenticated call this implementation environment cannot
 *          make (no live Cloudflare credential available, same disclosed
 *          limitation `lib/evidence/cloudflare.ts`'s own "LIVE-TOKEN SMOKE"
 *          section already carries for its GraphQL queries). The dashboard
 *          flow is the same: "When you create or edit an OAuth client, all
 *          available scopes are displayed. Search for and select the scopes
 *          required for your client" (same page) — a human clicking through
 *          a search UI, not a string this code can read anywhere. The one
 *          worked example present (`"scopes": ["workers-platform.read"]`,
 *          same page's API-creation curl example) proves the SHAPE
 *          (`<product-slug>.<action>`) but is Workers-specific, not
 *          Analytics-specific — extrapolating an exact slug like
 *          `zone-analytics.read` or `analytics.read` from one unrelated
 *          example would be exactly the kind of guess this session's own
 *          binding discipline exists to prevent (the fabricated-GraphQL-type
 *          incident this file's sibling `lib/evidence/cloudflare.ts` already
 *          documents in detail). **CHOSEN, DISCLOSED: `CLOUDFLARE_OAUTH_SCOPE`
 *          is a NEW, REQUIRED env var** (checked via `envReady()` below,
 *          exactly mirroring `sentry.ts`'s own `SENTRY_OAUTH_INTEGRATION_SLUG`
 *          third-var precedent) — the space-separated resource-scope
 *          string(s) the owner obtains from the SAME dashboard search UI (or
 *          the `GET /oauth/scopes` call above) at OAuth-client-creation
 *          time and pastes into the deployment's env, rather than a value
 *          this code invents. This is SAFE regardless of whichever of two
 *          plausible server behaviors is real (whether an omitted
 *          resource-scope in the authorize request defaults to the client's
 *          full preregistered scope, or requires explicit enumeration — the
 *          docs don't say which): requesting exactly the scope the client
 *          was ALSO registered with is a no-op under the "defaults to full
 *          registered scope" reading and the REQUIRED explicit request under
 *          the other, so this design is correct under either. The permission
 *          the owner needs to search for and select is **`Analytics Read`**
 *          (exact string) — the SAME one the existing token-paste path
 *          already asks for — confirmed present, human-readable, under
 *          "Zone permissions" (not "Account permissions") in
 *          `fundamentals/api/reference/permissions/index.md`: "| Analytics
 *          Read | Grants read access to [analytics](...zone-analytics/). |"
 *          — matching `connector-helpers.ts`'s own pre-existing
 *          `credentialHint` for this connector's token-paste path ("scoped
 *          to the zone's Analytics: Read permission").
 *
 *          **DISAMBIGUATION TRAP (W3-T6 fix round, independent review —
 *          `.superpowers/sdd/review-W3T6.md` Finding 1):** the SAME
 *          reference table ALSO lists a distinct, real, similarly-named
 *          `Account Analytics Read` permission under "Account permissions"
 *          — a DIFFERENT, account-scoped grant this connector's zone-keyed
 *          queries (`viewer.zones(filter:{zoneTag})`) do NOT need. The
 *          first submission of this file cited
 *          `analytics/graphql-api/getting-started/authentication/
 *          api-token-auth/index.md`'s own token-setup walkthrough — "select
 *          _Account_ in the first drop-down list, _Account Analytics_ from
 *          the second drop-down list, and _Read_ from the third" — as
 *          corroboration; that walkthrough's own next line states plainly
 *          "This example scopes **account-level** permissions for read
 *          access to the Analytics API," meaning it actually demonstrates
 *          creating a token with `Account Analytics Read`, the WRONG
 *          permission for this connector — not independent confirmation of
 *          `Analytics Read` at all. Removed as a citation for that reason;
 *          `permissions/index.md`'s own "Zone permissions" table entry
 *          (quoted above) is the sole, correct, sufficient source. Recorded
 *          here, not silently fixed, because a citation mistake on this
 *          EXACT provider is what this whole file's own doc-comment already
 *          exists to guard against (the fabricated-GraphQL-type incident,
 *          `lib/evidence/cloudflare.ts`'s own doc-comment) — this one was a
 *          real citation that supported the wrong conclusion, not a
 *          fabrication, but the same discipline applies: catch it, name it,
 *          don't paper over it.
 *
 *   - REQUEST PARAM NAMES (authorize URL query params, token POST body) —
 *     **NOT shown in a worked example anywhere in Cloudflare's own docs**
 *     (unlike Railway's literal worked `curl` commands) — inferred from RFC
 *     6749's standard Authorization Code shape, licensed by the live
 *     discovery document's own declared support surface being internally
 *     consistent with exactly that shape (`response_types_supported`
 *     includes `"code"`; `grant_types_supported` includes
 *     `"authorization_code"`/`"refresh_token"`; `response_modes_supported`
 *     includes `"query"`). Cross-confirmed by prose: "Cloudflare OAuth
 *     clients support the OAuth 2.0 Authorization Code flow. Cloudflare does
 *     not support Client Credentials, Implicit, Resource Owner Password
 *     Credentials, Device Authorization, or other OAuth grant types for
 *     third-party clients." (`create-an-oauth-client/index.md`, "Supported
 *     OAuth flows") — ruling out every OTHER `response_type`/`grant_type`
 *     the discovery document lists as supported in general (those exist for
 *     Cloudflare's OWN first-party tools, e.g. Wrangler, not third-party
 *     clients like this one). Authorize:
 *     `response_type=code&client_id=...&redirect_uri=...&scope=...&state=...
 *     &code_challenge=...&code_challenge_method=S256`. Token (form-urlencoded
 *     body, RFC 6749 standard, matching Railway's own body encoding):
 *     `grant_type=authorization_code&code=...&redirect_uri=...
 *     &code_verifier=...` for exchange, `grant_type=refresh_token
 *     &refresh_token=...` for refresh — both Basic-authed per "CLIENT
 *     TYPE / AUTH METHOD" above.
 *
 *   - ACCESS TTL — genuinely undocumented, confirmed by ABSENCE: no fetched
 *     page (prose or discovery document) states a number, matching this
 *     task's own pre-stated expectation ("access-token TTL not clearly
 *     documented → build refresh regardless"). `expires_in` is RFC
 *     6749 §5.1 "RECOMMENDED," not required, so treated LENIENTLY here —
 *     a DELIBERATE, DISCLOSED asymmetry from `railway.ts`'s stricter
 *     "missing expires_in throws" (Railway's own docs show a confirmed
 *     worked JSON example WITH `expires_in` present, so its absence there
 *     really would be an anomaly; no such confirmed example exists for
 *     Cloudflare to be absent FROM). A present, valid, positive
 *     `expires_in` is used as-is; an absent/invalid one falls back to
 *     {@link CLOUDFLARE_OAUTH_FALLBACK_TTL_SECONDS} — a short, disclosed,
 *     NOT vendor-confirmed number chosen to fail TOWARD refreshing sooner
 *     rather than trusting an assumed long lifetime, the exact same
 *     "fail toward refreshing on uncertainty" doctrine `core.ts`'s own
 *     `needsRefresh` already applies to an unparseable `expiresAt`. This is
 *     the one place this adapter is lenient where every sibling is strict —
 *     `access_token`/`refresh_token` themselves are STILL required (missing
 *     either throws, same as `railway.ts` — there is no safe fallback for
 *     "we have no token at all," unlike "we don't know exactly how long
 *     this token lasts").
 *
 *   - REFRESH ROTATION — not confirmed either way (no worked refresh example
 *     found). Defensively safe regardless: `refresh()` below always returns
 *     whatever `refresh_token` the response carries (never reuses the one it
 *     was called with), the same construction `railway.ts`/`sentry.ts` both
 *     use regardless of their own confirmed/unconfirmed rotation facts —
 *     correct whether Cloudflare rotates on every use (like Railway) or
 *     issues a stable refresh token (unconfirmed which).
 *
 *   - PUBLIC vs. PRIVATE CLIENT VISIBILITY — **a registration-blocking fact
 *     with no equivalent in Railway's or Sentry's own registration steps,
 *     flagged loudly for the owner registration checklist below.** "New
 *     OAuth clients default to private visibility. Private clients can only
 *     be authorized by members of the parent Cloudflare account." —
 *     `create-an-oauth-client/index.md`. Since this console's own users each
 *     have THEIR OWN, unrelated Cloudflare accounts (not members of whatever
 *     account registers this OAuth client), a client left at the PRIVATE
 *     default would only ever let ONE account's own members complete an
 *     authorize flow — functionally broken for every other workspace. The
 *     client MUST be promoted to PUBLIC, which requires: "Required fields:
 *     Client name / Logo / Client URL / Scopes" AND "OAuth clients must
 *     complete domain verification for the client URL before they can be
 *     made public" — a DNS TXT record the owner must create and wait on:
 *     "Cloudflare polls this DNS record until it is found or until the
 *     request times out after two days," and "Setting a client's visibility
 *     to public is permanent. You cannot change the visibility back to
 *     private." (same page). None of this is code this adapter can perform
 *     — it is a one-time, multi-day-capable owner action, sequenced BEFORE
 *     `oauthReady` can mean anything for any workspace outside the
 *     registering account.
 *
 *   - ACCOUNT-SCOPED CONSENT (confirmed, informs the "NO postExchange"
 *     decision below): "Account selection: Choose which Cloudflare
 *     account(s) the application can access" — `authorizing-an-application
 *     /index.md`; corroborated by a 2026-04-14 changelog entry: "you can now
 *     select specific accounts instead of granting access to all your
 *     accounts" (`changelog/post/2026-04-14-oauth-consent-and-revoke`).
 *     Cloudflare's OAuth grant IS resource-scoped, like Railway's
 *     `project:viewer` — but at the ACCOUNT level, not the ZONE level this
 *     connector's own config (`cloudflareZoneId`) is keyed by.
 *
 *   - NO postExchange (disclosed decision, unlike Railway's
 *     `postExchange`): three independent reasons, each alone sufficient.
 *     (1) `cloudflareAccountId` — the field a Railway-style auto-fill would
 *     populate — is CONFIRMED UNUSED by this connector's own evidence
 *     adapter (`lib/evidence/cloudflare.ts`'s own doc-comment, "ACCOUNT TAG
 *     NOT NEEDED": both GraphQL datasets are reachable via `zoneTag` alone)
 *     — nothing would ever read an auto-filled value. (2) The grant
 *     granularity Cloudflare actually exposes at consent (ACCOUNT) does not
 *     map cleanly onto this connector's own config granularity (ZONE) the
 *     way Railway's `project:viewer` grant maps 1:1 onto
 *     `railwayProjectId` — an account can own many zones, so there is no
 *     analogous "auto-fill the one zone" case the way Railway auto-fills
 *     the one granted project. (3) Verifying zone-level access would need a
 *     `GET /zones` call, which needs the "Zone Read" permission group
 *     (`permissions/index.md`'s own table) — a DIFFERENT permission from
 *     the "Analytics Read" one this connector's OAuth scope is set up to
 *     request (see "SCOPES" above); asking for it would either fail closed
 *     (a token scoped only to Analytics Read lacks it) or force the owner
 *     to grant a broader permission than the connector actually needs,
 *     unlike Railway's `externalWorkspaces` check (which reuses the SAME
 *     `project:viewer` scope the adapter already needs — no extra
 *     permission required there). Most importantly: unlike Railway's
 *     evidence adapter (which, pre-fix, could render an honest-looking
 *     "(no deployments in window)" for an out-of-grant project — the exact
 *     silent-mismatch risk `postExchange` was built to close), Cloudflare's
 *     evidence adapter ALREADY has an equivalent, PRE-EXISTING check that
 *     runs on EVERY call, not just once at connect time: `lib/evidence/
 *     cloudflare.ts`'s own "EMPTY ZONES → config_missing" pin (Task P8,
 *     unmodified by this task) degrades LEGIBLY whenever `viewer.zones`
 *     comes back empty for a configured `cloudflareZoneId` — whatever the
 *     cause (wrong account granted, a since-revoked zone, a typo'd id). A
 *     connect-time `postExchange` check here would duplicate a
 *     PRE-EXISTING, ONGOING (not just connect-time) safety property, not
 *     close a gap the way Railway's did.
 *
 *   - CREDENTIAL PRESENTATION — unchanged from every other provider:
 *     `Authorization: Bearer <token>` (this is what `lib/evidence/
 *     cloudflare.ts`'s own `cloudflareHeaders` already sends, and continues
 *     to send byte-identically after this task's `resolveProviderAuth`
 *     switch — see that file's own doc-comment).
 *
 *   - REGISTRATION (owner action, dashboard-only — no self-serve API path
 *     documented for this specific step beyond what "Create your OAuth
 *     client" already covers): "Go to **Manage Account** > **OAuth
 *     clients**. Select **Create client**." (`create-an-oauth-client
 *     /index.md`) — direct link `https://dash.cloudflare.com/?to=/:account/
 *     oauth-clients`. Configure: Client name; Response type `code`; Grant
 *     type `authorization_code`; Token authentication method
 *     `client_secret_basic` (must match this adapter's own choice above);
 *     Redirect URL(s) — the exact registered redirect URI this console
 *     sends is `https://www.heyjace.com/api/v1/connectors/oauth/callback/
 *     cloudflare` in production (the canonical WWW host — apex 301s and
 *     drops POSTs, per the wave's own hard-won `docs/oauth-www-urls`
 *     correction, #1555) or `http://localhost:3000/api/v1/connectors/
 *     oauth/callback/cloudflare` in local dev; Scopes — search for and
 *     select the permission matching "Analytics Read" under "Zone
 *     permissions" — NOT the similarly-named, ALSO-real "Account Analytics
 *     Read" (a different, account-scoped permission; see "SCOPES" above) —
 *     then note the resulting scope ID(s) for `CLOUDFLARE_OAUTH_SCOPE`.
 *     Then PROMOTE TO PUBLIC (see "PUBLIC vs. PRIVATE CLIENT VISIBILITY"
 *     above) — required before any workspace outside the registering
 *     account can use this connect button at all, and involves a DNS TXT
 *     record verification step that can take up to two days.
 */

const CLOUDFLARE_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_OAUTH_TIMEOUT_MS = 8000;

// `openid` (identity) + `offline_access` (refresh-token issuance) — BOTH
// confirmed present in the live discovery document's own `scopes_supported`
// (see this module's own doc-comment, "SCOPES"). Sent unconditionally,
// alongside the operator-supplied resource scope below — never conditional
// on "first connect."
const CLOUDFLARE_OAUTH_BASE_SCOPES = "openid offline_access";

// See this module's own doc-comment ("ACCESS TTL") — NOT a vendor-confirmed
// number; a short, disclosed fallback used ONLY when a token response omits
// `expires_in` entirely, biasing toward an earlier refresh rather than
// trusting an assumed long lifetime.
//
// KNOWN, DISCLOSED, NOT-YET-RULED-OUT WINDOW (W3-T6 fix round, independent
// review Finding 3, `.superpowers/sdd/review-W3T6.md` — accepted-as-
// documented, no behavior change): when this fallback fires, the envelope
// is stamped `expiresAt = now + 300s`. `core.ts`'s `REFRESH_SKEW_MS` (2
// minutes) means `needsRefresh()` only flips true ~180s after mint — for
// that first ~180s window, `resolveProviderAuth` serves the token as
// "still fresh" without re-checking it. If Cloudflare's real, undocumented
// access-token TTL is shorter than ~180s (not confirmed either way — see
// "ACCESS TTL" above), an evidence call in that window gets a genuine 401
// from Cloudflare, correctly mapped to a legible `unauthorized` degradation
// by `cloudflareGraphQL` (never a crash), self-healing once the fallback
// window naturally elapses and the next proactive refresh fires. This is
// the SAFER of the two possible fallback biases (erring toward refreshing
// sooner, per "ACCESS TTL" above) — narrowing the window further (e.g. a
// smaller fallback constant) would trade this disclosed, self-healing
// corner case for MORE unnecessary refresh calls in the common case where
// Cloudflare's real TTL is longer, which nothing fetched suggests it isn't.
// Not a bug; a documented, accepted property of any undocumented-TTL
// fallback, kept exactly this way rather than "fixed."
const CLOUDFLARE_OAUTH_FALLBACK_TTL_SECONDS = 300;

const CLOUDFLARE_OAUTH_SCOPE_ENV_KEY = "CLOUDFLARE_OAUTH_SCOPE";

/** Reads cloudflare's client id/secret, throwing a clear error if unset.
 * Both routes that ever call into this adapter (`connectors/oauth/link`,
 * `connectors/oauth/callback/[provider]`) already gate on `oauthConfigFor`
 * themselves before reaching here — this is defense in depth for a direct
 * caller (this module's own tests included), mirroring
 * `railway.ts`'s/`sentry.ts`'s identical `requireXOauthConfig` helpers. */
function requireCloudflareOauthConfig(): { clientId: string; clientSecret: string } {
  const config = oauthConfigFor("cloudflare");
  if (!config) {
    throw new Error(
      "cloudflare OAuth is not configured (CLOUDFLARE_OAUTH_CLIENT_ID/CLOUDFLARE_OAUTH_CLIENT_SECRET unset)"
    );
  }
  return config;
}

/** Reads the THIRD env var this provider needs beyond the generic
 * `oauthConfigFor` pair — see this module's own doc-comment ("SCOPES") for
 * why the resource-permission scope cannot be a hardcoded constant.
 * Mirrors `sentry.ts`'s identical `requireSentryIntegrationSlug` shape. */
function requireCloudflareOauthScope(): string {
  const scope = process.env[CLOUDFLARE_OAUTH_SCOPE_ENV_KEY];
  if (!scope) {
    throw new Error(`cloudflare OAuth is not configured (${CLOUDFLARE_OAUTH_SCOPE_ENV_KEY} unset)`);
  }
  return scope;
}

function cloudflareTokenHeaders(clientId: string, clientSecret: string): HeadersInit {
  return {
    // client_secret_basic — see this module's own doc-comment ("CLIENT
    // TYPE / AUTH METHOD").
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "agentrail-console",
  };
}

interface CloudflareTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * One POST to the token endpoint, shared by `exchange` (grant_type=
 * authorization_code) and `refresh` (grant_type=refresh_token) — mirrors
 * `railway.ts`'s identical `requestToken` split. Never try/catch-wrapped
 * around the `fetch` call itself: a thrown fetch propagates uncaught to
 * whichever caller needs that (`exchange()`'s throw is the callback route's
 * own `exchange_failed` branch; `refresh()`'s throw is `core.ts`'s
 * `resolveProviderAuth` degrading to `unauthorized`).
 */
async function requestToken(grantParams: Record<string, string>): Promise<OauthEnvelope> {
  const { clientId, clientSecret } = requireCloudflareOauthConfig();

  const res = await fetch(CLOUDFLARE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: cloudflareTokenHeaders(clientId, clientSecret),
    body: new URLSearchParams(grantParams).toString(),
    signal: AbortSignal.timeout(CLOUDFLARE_OAUTH_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Never echoes the response body — same discipline as railway.ts's/
    // sentry.ts's identical caution.
    throw new Error(`cloudflare oauth token endpoint returned HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => null)) as CloudflareTokenResponse | null;
  const accessToken = typeof body?.access_token === "string" && body.access_token ? body.access_token : null;
  const refreshToken = typeof body?.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;

  // access_token/refresh_token: STILL required, no safe fallback — see this
  // module's own doc-comment ("ACCESS TTL") for why expires_in ALONE gets
  // lenient treatment immediately below, and why these two do not.
  if (!accessToken || !refreshToken) {
    throw new Error("cloudflare oauth token endpoint returned an unexpected response shape");
  }

  const rawExpiresIn = body?.expires_in;
  const expiresIn =
    typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
      ? rawExpiresIn
      : CLOUDFLARE_OAUTH_FALLBACK_TTL_SECONDS;

  return {
    access: accessToken,
    refresh: refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export const cloudflareOauthAdapter: OauthProviderAdapter = {
  provider: "cloudflare",
  // Explicit, even though "param" is the interface's own default when
  // absent (mirrors railway.ts's identical explicitness) — Cloudflare is a
  // standard OAuth2/OIDC authorization-code flow (confirmed via the live
  // discovery document), and nothing in any fetched doc suggests `state` is
  // dropped from the redirect the way Sentry's Public Integration flow
  // confirmed-drops it. See this module's own doc-comment ("REQUEST PARAM
  // NAMES").
  stateTransport: "param",

  // The third env var beyond the generic oauthConfigFor pair — see this
  // module's own doc-comment ("SCOPES"). Read generically by the
  // connectors GET route's `oauthReady` derivation and the link route's
  // 409 env-gate, exactly like sentry.ts's identical envReady().
  envReady(): boolean {
    return Boolean(process.env[CLOUDFLARE_OAUTH_SCOPE_ENV_KEY]);
  },

  /** Pure and synchronous per `OauthProviderAdapter`'s own contract — the
   * only I/O this does is `process.env` reads (via `oauthConfigFor`/
   * `requireCloudflareOauthScope`), not network. PKCE REQUIRED (see this
   * module's own doc-comment, "PKCE") — throws if the link route didn't
   * supply a `codeChallenge`, mirroring railway.ts's identical choice. */
  authorizeUrl({ state, redirectUri, codeChallenge }: AuthorizeUrlInput): string {
    const { clientId } = requireCloudflareOauthConfig();
    const resourceScope = requireCloudflareOauthScope();
    if (!codeChallenge) {
      throw new Error(
        "cloudflare oauth authorizeUrl missing PKCE code_challenge (the link route always mints one — this indicates a bug)"
      );
    }
    const url = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", `${CLOUDFLARE_OAUTH_BASE_SCOPES} ${resourceScope}`);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  /** `ExchangeInput.params` (every non-state/code query param Cloudflare's
   * redirect carried) is deliberately ignored — nothing in any fetched doc
   * documents an extra param this adapter needs beyond the standard
   * `code`/`redirect_uri`/`code_verifier`, mirroring railway.ts's identical
   * choice. PKCE REQUIRED, same reasoning as `authorizeUrl` above. */
  async exchange({ code, redirectUri, codeVerifier }: ExchangeInput): Promise<OauthEnvelope> {
    if (!codeVerifier) {
      throw new Error(
        "cloudflare oauth exchange missing PKCE code_verifier (the callback route always threads one through from the minted state — this indicates a bug)"
      );
    }
    return requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
  },

  async refresh(envelope: OauthEnvelope): Promise<OauthEnvelope> {
    return requestToken({
      grant_type: "refresh_token",
      refresh_token: envelope.refresh,
    });
  },

  // No postExchange — see this module's own doc-comment ("NO postExchange")
  // for the full, three-part disclosed reasoning.
};

registerOauthAdapter(cloudflareOauthAdapter);
