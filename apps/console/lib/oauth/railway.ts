import { oauthConfigFor, registerOauthAdapter } from "./types";
import type { AuthorizeUrlInput, ExchangeInput, OauthEnvelope, OauthProviderAdapter } from "./types";

/**
 * OAuth Connect Wave 3, W3-T2 (`.superpowers/sdd/plan-oauth.md`) — Railway's
 * `OauthProviderAdapter`. Fills in T1's seam (`./types.ts`/`./core.ts`,
 * unchanged by this task): `authorizeUrl` builds the vendor's consent-screen
 * URL, `exchange` turns a callback `code` into the first `OauthEnvelope`,
 * `refresh` mints a new one from a (possibly expired) prior envelope.
 * `resolveProviderAuth` (`./core.ts`) calls `refresh` on our behalf and
 * persists whatever it returns — this file's ONLY job is to talk to Railway
 * correctly and return the exact rotated pair Railway issued.
 *
 * DOC-VERIFICATION (BINDING — this session's own discipline after a
 * fabricated citation shipped a fake GraphQL type elsewhere this week):
 * every fact below is a QUOTED line from a RAW `curl` fetch (not a WebFetch
 * summary) of `docs.railway.com/integrations/oauth/{quickstart,
 * login-and-tokens,scopes-and-user-consent,creating-an-app,
 * troubleshooting}.md` — see the task report for the full quoted trail.
 *
 *   - Authorize endpoint — **CORRECTS the plan's own placeholder**
 *     (`plan-oauth.md` wrote "railway.com/oauth/authorize-family," flagged
 *     there as needing re-verification): the raw doc's actual worked
 *     example is `GET https://backboard.railway.com/oauth/auth`
 *     (login-and-tokens.md: "Redirect the user to the authorization
 *     endpoint: `GET https://backboard.railway.com/oauth/auth`"). NOT
 *     `railway.com` (bare host), NOT `/oauth/authorize` (path) — both
 *     details the plan's shorthand got wrong. The raw docs win; this is
 *     that correction, loudly.
 *   - Token endpoint — CONFIRMED exactly as the plan stated:
 *     `POST https://backboard.railway.com/oauth/token`, HTTP Basic client
 *     auth (quickstart.md's own worked curl: `curl -X POST
 *     https://backboard.railway.com/oauth/token -u
 *     "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" -H "Content-Type:
 *     application/x-www-form-urlencoded" -d "grant_type=authorization_code"
 *     ...`) — the client secret rides in the `Authorization: Basic` header,
 *     never a `client_secret` body field (`client_secret_basic`, per
 *     creating-an-app.md's own auth-method table; `client_secret_post` is
 *     ALSO documented as valid for a Web/Confidential app, but the doc's
 *     own worked example uses Basic, so this adapter matches that example
 *     rather than picking the untested alternative).
 *   - Scopes — CONFIRMED, all three real and documented
 *     (scopes-and-user-consent.md's own table): `openid` ("Required for all
 *     requests"), `project:viewer` ("Viewer access to user-selected
 *     projects" — a REAL resource-scoped grant, not identity-only; this is
 *     what lets the OAuth-issued access token call the exact same
 *     `deployments`/`deploymentLogs` GraphQL queries `lib/evidence/
 *     railway.ts` already uses), `offline_access` ("Receive refresh tokens
 *     (requires `prompt=consent`)"). `prompt=consent` is sent on EVERY
 *     authorize call, unconditionally — this adapter's `OauthEnvelope`
 *     always needs a `refresh` value (`types.ts`'s own `refresh: string`,
 *     not optional), and the docs are explicit that omitting `prompt=
 *     consent` can silently skip the consent screen on a returning user and
 *     issue NO refresh token at all (login-and-tokens.md: "Without it,
 *     returning users might skip consent through automatic approval, and
 *     no refresh token would be issued").
 *   - Access TTL — CONFIRMED: `expires_in: 3600` in the docs' own worked
 *     JSON example, and prose ("Access tokens expire after one hour.").
 *   - Refresh rotation — CONFIRMED, with a sharper edge than the plan's
 *     summary conveyed: troubleshooting.md states plainly that "using a
 *     rotated refresh token immediately revokes the entire authorization.
 *     This behavior helps detect potentially leaked tokens." — reusing a
 *     stale refresh token is not a soft failure, it is a full disconnect
 *     the operator must manually reconnect from. This adapter's `refresh()`
 *     therefore ALWAYS returns whatever `refresh_token` the response
 *     carries (see `requestToken` below) — `resolveProviderAuth`
 *     (`core.ts`) already persists exactly what `refresh()` returns, so
 *     correctness here is entirely on this file reading the response
 *     faithfully, never reusing the token it was called with. ~1-year
 *     refresh-token lifetime and the 100-token cap are both confirmed
 *     verbatim (login-and-tokens.md: "The new refresh token has a fresh
 *     one-year lifetime from the time of issuance." /
 *     "Each user authorization can have a maximum of 100 refresh tokens.
 *     If you exceed this limit, the oldest tokens are revoked
 *     automatically.").
 *   - GraphQL data API — CONFIRMED unchanged:
 *     `POST https://backboard.railway.com/graphql/v2`, same endpoint
 *     `lib/evidence/railway.ts` already calls — this task does not touch
 *     those queries at all (see that file's own W3-T2 doc-comment update).
 *
 * PKCE — DISCLOSED CHOICE: NOT IMPLEMENTED in v1. creating-an-app.md's own
 * app-type table is explicit that PKCE is "Recommended" (not required) for
 * a "Web (Confidential)" client — REQUIRED only for a "Native (Public)"
 * client, which this console is not (the client secret is held server-side,
 * never shipped to a browser). Two independent reasons this adapter still
 * doesn't add it: (1) the docs' own stated benefit — "protects against
 * authorization code interception if an attacker manages to observe the
 * redirect" — is a materially smaller risk for a confidential client that
 * ALSO authenticates the token-exchange call with a secret Railway has
 * never disclosed to anyone but this deployment; PKCE hardens the case
 * where an attacker captures ONLY the `code`, which still cannot be
 * exchanged without the client secret this adapter already requires. (2)
 * T1's `OauthProviderAdapter` interface (`types.ts`, out of scope to
 * redesign here) has no channel to carry a PKCE `code_verifier` from the
 * pure, synchronous `authorizeUrl()` call through to the later `exchange()`
 * call: `exchange(input: ExchangeInput)` receives `{code, redirectUri,
 * params}` — never the original `state` — so there is no key this adapter
 * could even use to look up a verifier it minted at authorize time without
 * a T1 route/state-storage change. If a future task revisits this, the
 * natural seam is threading `state` (or a derived value) through to
 * `exchange()` so a verifier can round-trip via the SAME `connectors.config`
 * ephemeral-key mechanism `mintConnectorOauthState` already uses.
 *
 * REFRESH_TOKEN OMITTED FROM A RESPONSE — DISCLOSED CHOICE: every worked
 * JSON example in the raw docs (initial exchange AND refresh) shows
 * `refresh_token` present on every successful response — troubleshooting.md
 * even frames a MISSING refresh token as a configuration mistake on the
 * CALLER's side ("No refresh token in response: To receive a refresh
 * token, your authorization request must include both the `offline_access`
 * scope and `prompt=consent`" — which this adapter always sends, so a
 * response missing it would mean Railway silently deviated from every
 * documented example). `requestToken` therefore treats an ABSENT
 * `refresh_token` (or `access_token`, or a non-numeric `expires_in`) as a
 * malformed/unconfirmed response shape and THROWS rather than guessing —
 * the same "never trust an unconfirmed API shape" doctrine
 * `lib/evidence/railway.ts`'s own doc-comment already establishes for this
 * provider. A throw here is exactly what both callers already expect:
 * `exchange()` throwing is the callback route's own `exchange_failed`
 * branch; `refresh()` throwing is `core.ts`'s `resolveProviderAuth`
 * degrading to `unauthorized` (operator reconnects) — neither is new
 * vocabulary.
 */

const RAILWAY_OAUTH_AUTHORIZE_URL = "https://backboard.railway.com/oauth/auth";
const RAILWAY_OAUTH_TOKEN_URL = "https://backboard.railway.com/oauth/token";

// openid required by every request (scopes-and-user-consent.md); project:viewer
// is the resource grant this adapter's own GraphQL calls need;
// offline_access + prompt=consent (below) together are what makes Railway
// issue a refresh_token at all. Space-separated, matching every worked
// example in the docs (openid listed first in each one).
const RAILWAY_OAUTH_SCOPES = "openid project:viewer offline_access";

const RAILWAY_OAUTH_TIMEOUT_MS = 8000;

/** Reads railway's client id/secret, throwing a clear error if unset. Both
 * routes that ever call into this adapter (`connectors/oauth/link`,
 * `connectors/oauth/callback/[provider]`) already gate on `oauthConfigFor`
 * themselves before reaching here (link's own 409 branch; the callback's
 * `provider_unconfigured` branch) — this is defense in depth for a direct
 * caller (this module's own tests included), not a path production traffic
 * is expected to hit. */
function requireRailwayOauthConfig(): { clientId: string; clientSecret: string } {
  const config = oauthConfigFor("railway");
  if (!config) {
    throw new Error(
      "railway OAuth is not configured (RAILWAY_OAUTH_CLIENT_ID/RAILWAY_OAUTH_CLIENT_SECRET unset)"
    );
  }
  return config;
}

function railwayTokenHeaders(clientId: string, clientSecret: string): HeadersInit {
  return {
    // client_secret_basic (creating-an-app.md's auth-method table) — see
    // this module's own doc-comment ("Token endpoint") for why Basic over
    // the also-documented client_secret_post.
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "agentrail-console",
  };
}

interface RailwayTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * One POST to the token endpoint, shared by `exchange` (grant_type=
 * authorization_code) and `refresh` (grant_type=refresh_token) — the only
 * difference between the two calls is which grant params they pass in.
 * Never try/catch-wrapped around the `fetch` call itself: a thrown fetch
 * (network error, the timeout firing) propagates uncaught to whichever
 * caller needs that — `exchange()`'s throw is the callback route's own
 * `exchange_failed` branch; `refresh()`'s throw is `core.ts`'s
 * `resolveProviderAuth` degrading to `unauthorized` — both already expect
 * "this adapter's call can reject," neither needs a second, local catch
 * here.
 */
async function requestToken(grantParams: Record<string, string>): Promise<OauthEnvelope> {
  const { clientId, clientSecret } = requireRailwayOauthConfig();

  const res = await fetch(RAILWAY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: railwayTokenHeaders(clientId, clientSecret),
    body: new URLSearchParams(grantParams).toString(),
    signal: AbortSignal.timeout(RAILWAY_OAUTH_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Never echoes the response body — an OAuth error body is not usually
    // sensitive (`{error:"invalid_grant"}`), but this adapter has no way to
    // confirm that for every possible Railway error shape, and the
    // callback route's own logging discipline (never log the caught error
    // object verbatim — see its doc-comment) is easiest to honor if this
    // adapter's own thrown message never carries vendor response text
    // either.
    throw new Error(`railway oauth token endpoint returned HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => null)) as RailwayTokenResponse | null;
  const accessToken = typeof body?.access_token === "string" && body.access_token ? body.access_token : null;
  const refreshToken = typeof body?.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;
  const expiresIn =
    typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : null;

  // See this module's own doc-comment ("REFRESH_TOKEN OMITTED FROM A
  // RESPONSE — DISCLOSED CHOICE") for why a missing field throws rather
  // than falling back to a guess.
  if (!accessToken || !refreshToken || expiresIn === null) {
    throw new Error("railway oauth token endpoint returned an unexpected response shape");
  }

  return {
    access: accessToken,
    refresh: refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export const railwayOauthAdapter: OauthProviderAdapter = {
  provider: "railway",

  /** Pure and synchronous per `OauthProviderAdapter`'s own contract — the
   * one I/O this does is a `process.env` read (via `oauthConfigFor`), not
   * network. */
  authorizeUrl({ state, redirectUri }: AuthorizeUrlInput): string {
    const { clientId } = requireRailwayOauthConfig();
    const url = new URL(RAILWAY_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", RAILWAY_OAUTH_SCOPES);
    url.searchParams.set("state", state);
    // Unconditional, every call — see this module's own doc-comment
    // ("Scopes") for why this must never be conditional on "first-time
    // connect."
    url.searchParams.set("prompt", "consent");
    return url.toString();
  },

  /** `ExchangeInput.params` (every non-state/code query param Railway's
   * redirect carried, e.g. the `iss` issuer param login-and-tokens.md's own
   * example shows) is deliberately ignored — Railway's callback needs
   * nothing beyond `code`/`redirect_uri`, unlike Sentry's Public
   * Integration flow (plan's own verified vendor facts), which is why
   * `ExchangeInput` carries that bag at all. */
  async exchange({ code, redirectUri }: ExchangeInput): Promise<OauthEnvelope> {
    return requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
  },

  async refresh(envelope: OauthEnvelope): Promise<OauthEnvelope> {
    return requestToken({
      grant_type: "refresh_token",
      refresh_token: envelope.refresh,
    });
  },
};

registerOauthAdapter(railwayOauthAdapter);
