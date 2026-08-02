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
 * PKCE — IMPLEMENTED (W3-T2 fix round, independent review upgrade —
 * `.superpowers/sdd/review-W3T2.md`, Finding #2). The FIRST submission
 * disclosed this as deliberately skipped; the review's own citation check
 * was accurate but incomplete, and the coordinator's scope ruling upgraded
 * it to "now, S256." The full, honest citation this time: creating-an-app.md's
 * app-type table says PKCE is "Recommended" (not required) for a "Web
 * (Confidential)" client, REQUIRED only for "Native (Public)" — but that
 * SAME doc's prose is more emphatic than the table cell alone conveys:
 * "Even though web apps have a client secret, implementing PKCE is
 * **strongly recommended**. PKCE protects against authorization code
 * interception if an attacker manages to observe the redirect." Given that
 * emphasis, AND that Cloudflare's own OAuth (a documented future phase,
 * per the coordinator's own scope ruling) was BELIEVED at the time to
 * REQUIRE PKCE regardless of client type, the generic plumbing (`./pkce.ts`,
 * `mintConnectorOauthState`'s optional 4th arg, `types.ts`'s additive
 * `codeChallenge`/`codeVerifier` fields) is built once, shared, rather than
 * retrofitted per-provider later.
 *
 * CORRECTED (W3-T6, `lib/oauth/cloudflare.ts`'s own doc-comment + live
 * verification — see `.superpowers/sdd/task-W3T6-report.md`): that belief
 * about Cloudflare was wrong. Cloudflare's own docs say PKCE is
 * "Optional/not required" for a server-side confidential client (the exact
 * category both this console and Railway's own adapter fall into) — REQUIRED
 * only for a public client with no secret, mirroring THIS adapter's own
 * "Recommended, not Required" finding almost exactly, not a stricter rule.
 * Both adapters still send PKCE unconditionally regardless — not because
 * either vendor's docs mandate it for a confidential client, but as
 * deliberate defense-in-depth now that the shared plumbing exists; the
 * doc-comment sentence above is left in place as the historical record of
 * what motivated building `./pkce.ts` generically in the first place, not
 * as a current claim about Cloudflare. This adapter REQUIRES both fields
 * (throws if either is missing —
 * see `authorizeUrl`/`exchange` below) rather than treating them as
 * best-effort: having built the shared plumbing, silently degrading to
 * non-PKCE on a missing field would be a worse, harder-to-notice failure
 * mode than a loud, immediate throw. `code_challenge`/`code_challenge_method`
 * (authorize) and `code_verifier` (token exchange) param NAMES confirmed
 * verbatim against creating-an-app.md's own worked PKCE example:
 * `&code_challenge=CODE_CHALLENGE&code_challenge_method=S256` on the
 * authorize URL; `-d "code_verifier=CODE_VERIFIER"` alongside
 * `grant_type=authorization_code`/`code`/`redirect_uri` at the SAME Basic-
 * authed token endpoint (no separate PKCE endpoint).
 *
 * POST-EXCHANGE PROJECT-GRANT CHECK — W3-T2 fix round, independent review
 * Finding #1 (MEDIUM-HIGH): `project:viewer` is a RESOURCE-scoped grant —
 * the user picks WHICH project(s) to share on Railway's OWN consent
 * screen, independently of whatever this workspace has typed into its own
 * `railwayProjectId` config field. Nothing previously tied these two
 * together: an admin could configure `railwayProjectId="proj-A"`, then
 * connect via OAuth and pick `proj-B` on Railway's consent screen — every
 * subsequent evidence call would then query `proj-A` with a `proj-B`-scoped
 * token, and (per the review's own doc-verify trail — no fetched page
 * documents what `deployments(input:{projectId: <out-of-grant>})` actually
 * returns) COULD render as an honest-looking-but-wrong "(no deployments in
 * window)" rather than a legible error, if Railway resolves an
 * out-of-grant project id to an empty result rather than a GraphQL error.
 *
 * `postExchange` closes this at CONNECT time, before the credential is
 * ever stored: with the fresh access token, it lists every project the
 * grant actually covers via `externalWorkspaces { projects { id name } } }`
 * — confirmed, verbatim, from `docs.railway.com/integrations/oauth/
 * fetching-workspaces-or-projects.md`: "Project queries work similarly but
 * use the `externalWorkspaces` field, which returns workspaces along with
 * the specific projects the user granted access to. This requires a
 * project scope (`project:viewer` or `project:member`) in the original
 * authorization request." — then applies exactly three rules (the
 * coordinator's own pinned a/b/c):
 *   (a) `railwayProjectId` IS configured and is NOT in the granted set ->
 *       `{ok:false, reason:"project_not_granted"}` — the callback route
 *       fails the connect closed, credential never stored, admin sees a
 *       legible reason (redirect.ts's own doc-comment) instead of a
 *       connector that looks connected but silently answers nothing.
 *   (b) `railwayProjectId` is UNSET and the grant covers EXACTLY ONE
 *       project -> `{ok:true, configPatch:{railwayProjectId:<that id>}}` —
 *       auto-fills the field via the SAME `completeConfig` merge path
 *       every other config write already goes through (its preserve-list
 *       already protects the ephemeral oauth-state keys; this is an
 *       ordinary, non-ephemeral field), killing the dual-selection UX gap
 *       in the common case (a workspace connecting one Railway project for
 *       the first time via OAuth never has to ALSO hand-type the id).
 *   (c) `railwayProjectId` is UNSET and the grant covers ZERO or MULTIPLE
 *       projects -> `{ok:true}` (no patch) — deliberately generalizes the
 *       coordinator's literal "multiple grants" case to "not exactly one":
 *       auto-filling only when there is a single unambiguous choice is the
 *       same restraint either way. Falls through to the SAME "connected,
 *       config_missing on evidence calls until the admin sets a project
 *       id" state the legacy token-paste flow already produces when a
 *       token is pasted without the project id field filled in (verified
 *       by reading `lib/evidence/railway.ts`'s own `!projectId ->
 *       config_missing` gate and `connector-helpers.ts`'s
 *       `evidenceCapabilities`, which credentials this row on
 *       `enabled && hasSecret` alone, independent of `railwayProjectId` —
 *       this is NOT a new gap, and NOT silent: it degrades LEGIBLY per
 *       provider in the evidence route's own `degradations` array).
 * The already-configured-and-IN-grant case (not spelled out above) is the
 * implicit fourth outcome: `{ok:true}`, nothing to patch, nothing wrong.
 *
 * FAIL-CLOSED ON THE VERIFICATION CALL ITSELF: `fetchGrantedProjects`
 * (below) is deliberately NOT try/caught inside `postExchange` — a network
 * error or malformed response from Railway's OWN `externalWorkspaces` call
 * propagates uncaught, which the callback route treats exactly like a
 * thrown `exchange()` (`exchange_failed`), failing the WHOLE connect
 * attempt rather than silently skipping the one check this method exists
 * to make possible. This is the safety-first choice: the alternative
 * (catch-and-proceed-unverified) would reopen exactly the silent-mismatch
 * risk this fix closes, for the sake of tolerating a transient Railway
 * hiccup at connect time — a rare, one-time-per-connect-attempt call the
 * admin can simply retry.
 *
 * LIVE-SMOKE FLAG (disclosed, per the coordinator's own instruction): this
 * exact call — a real `externalWorkspaces` query against a real,
 * newly-issued Railway OAuth access token — CANNOT be exercised end-to-end
 * until a real Railway OAuth app is registered (this deployment has none
 * yet; `RAILWAY_OAUTH_CLIENT_ID`/`_SECRET` are unset everywhere today). The
 * query shape and field names are doc-confirmed (quoted above), and the
 * response-parsing logic below is defensive (never assumes a field exists
 * without checking), but the FIRST real OAuth connect attempt after the
 * vendor app is registered should be treated as this code path's actual
 * live-smoke test — flagged here so it isn't silently assumed proven by
 * the mocked test suite alone.
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

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

// Doc-confirmed verbatim against fetching-workspaces-or-projects.md — see
// this module's own doc-comment ("POST-EXCHANGE PROJECT-GRANT CHECK") for
// the quoted source line. Deliberately a BARE query (no variables) — the
// endpoint scopes the result to whatever the CALLER's own token was
// granted, nothing to parameterize.
const EXTERNAL_WORKSPACES_QUERY = `
  query {
    externalWorkspaces {
      id
      name
      projects {
        id
        name
      }
    }
  }
`;

interface RailwayExternalWorkspaceNode {
  id?: unknown;
  name?: unknown;
  projects?: Array<{ id?: unknown; name?: unknown }> | null;
}

interface RailwayGrantedProject {
  id: string;
  name: string;
}

/**
 * Lists every project the OAuth grant actually covers — the project-scope
 * analogue of the evidence adapter's own `fetchProjectDeployments`, but
 * this module's own, self-contained call (`lib/oauth/` and
 * `lib/evidence/` stay independent, never importing each other, even
 * though both talk to the same Railway GraphQL endpoint). Deliberately NOT
 * try/caught here — see this module's own doc-comment ("FAIL-CLOSED ON THE
 * VERIFICATION CALL ITSELF") for why a thrown fetch (network error,
 * malformed response) must propagate to the callback route rather than
 * being swallowed.
 */
async function fetchGrantedProjects(accessToken: string): Promise<RailwayGrantedProject[]> {
  const res = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "agentrail-console",
    },
    body: JSON.stringify({ query: EXTERNAL_WORKSPACES_QUERY }),
    signal: AbortSignal.timeout(RAILWAY_OAUTH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`railway externalWorkspaces query returned HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => null)) as
    | { data?: { externalWorkspaces?: RailwayExternalWorkspaceNode[] | null }; errors?: unknown }
    | null;
  if (!body || (Array.isArray(body.errors) && body.errors.length > 0) || body.data === undefined) {
    throw new Error("railway externalWorkspaces query returned an unexpected response shape");
  }

  const workspaces = body.data?.externalWorkspaces ?? [];
  const projects: RailwayGrantedProject[] = [];
  for (const ws of workspaces) {
    for (const p of ws.projects ?? []) {
      if (typeof p.id === "string" && p.id) {
        projects.push({ id: p.id, name: typeof p.name === "string" ? p.name : "" });
      }
    }
  }
  return projects;
}

export const railwayOauthAdapter: OauthProviderAdapter = {
  provider: "railway",
  // W3-T3 fix round: explicit, even though "param" is the interface's own
  // default when absent — Railway's redirect DOES carry a vendor-echoed
  // `state` (doc-confirmed, W3-T2), so the callback resolves it by
  // consuming that single-use token, unchanged by this fix round. See
  // `types.ts`'s own `stateTransport` doc-comment.
  stateTransport: "param",

  /** Pure and synchronous per `OauthProviderAdapter`'s own contract — the
   * one I/O this does is a `process.env` read (via `oauthConfigFor`), not
   * network. PKCE REQUIRED (see this module's own doc-comment, "PKCE —
   * IMPLEMENTED") — throws if the link route didn't supply a
   * `codeChallenge`, rather than silently authorizing without it. */
  authorizeUrl({ state, redirectUri, codeChallenge }: AuthorizeUrlInput): string {
    const { clientId } = requireRailwayOauthConfig();
    if (!codeChallenge) {
      throw new Error(
        "railway oauth authorizeUrl missing PKCE code_challenge (the link route always mints one — this indicates a bug)"
      );
    }
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
    // PKCE S256 — param names confirmed verbatim against
    // creating-an-app.md's own worked example (this module's own
    // doc-comment, "PKCE — IMPLEMENTED").
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  /** `ExchangeInput.params` (every non-state/code query param Railway's
   * redirect carried, e.g. the `iss` issuer param login-and-tokens.md's own
   * example shows) is deliberately ignored — Railway's callback needs
   * nothing beyond `code`/`redirect_uri`/`code_verifier`, unlike Sentry's
   * Public Integration flow (plan's own verified vendor facts), which is
   * why `ExchangeInput` carries that bag at all. PKCE REQUIRED, same
   * reasoning as `authorizeUrl` above — throws rather than silently
   * exchanging without the verifier that matches the challenge this
   * adapter sent at authorize time (Railway's own token endpoint would
   * reject a PKCE-initiated exchange missing `code_verifier` anyway per RFC
   * 7636, but a local, immediate, clearly-worded throw is easier to
   * diagnose than a generic HTTP 400 from the vendor). */
  async exchange({ code, redirectUri, codeVerifier }: ExchangeInput): Promise<OauthEnvelope> {
    if (!codeVerifier) {
      throw new Error(
        "railway oauth exchange missing PKCE code_verifier (the callback route always threads one through from the minted state — this indicates a bug)"
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

  /** See this module's own doc-comment ("POST-EXCHANGE PROJECT-GRANT
   * CHECK") for the full a/b/c contract. */
  async postExchange({ envelope, config }: PostExchangeInput): Promise<PostExchangeResult> {
    const projects = await fetchGrantedProjects(envelope.access);
    const grantedIds = new Set(projects.map((p) => p.id));

    const configuredRaw = config["railwayProjectId"];
    const configuredId =
      typeof configuredRaw === "string" && configuredRaw.trim() ? configuredRaw.trim() : null;

    if (configuredId) {
      if (!grantedIds.has(configuredId)) {
        return { ok: false, reason: "project_not_granted" };
      }
      return { ok: true };
    }

    // Nothing configured yet — auto-fill ONLY when the grant is
    // unambiguous (exactly one project). Zero or multiple both fall
    // through to "leave unset," matching today's pre-existing
    // not-configured handling (case (c), see this module's own
    // doc-comment).
    if (projects.length === 1) {
      return { ok: true, configPatch: { railwayProjectId: projects[0]!.id } };
    }
    return { ok: true };
  },
};

registerOauthAdapter(railwayOauthAdapter);
