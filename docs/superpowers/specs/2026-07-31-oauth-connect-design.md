# OAuth Connect — one-click Railway & Sentry, token-paste forever

**Date:** 2026-07-31 · **Status:** approved (`.superpowers/sdd/plan-oauth.md`) · **Phasing:** W3-T1 core (this PR) → W3-T2 Railway adapter → W3-T3 Sentry adapter → W3-T4 wrap

## Problem

Connecting an observability provider today means pasting a hand-copied API
token — correct, but friction for the two providers that are both fully
self-serve (no sales call, no approval queue) AND expose a real OAuth flow:
Railway and Sentry. The other six observability providers in the catalog
(Langfuse, Datadog, Prometheus, Grafana, Vercel, Cloudflare) either have no
OAuth surface worth building against or aren't worth the vendor-registration
overhead yet — token-paste is, and stays, the right mechanism for them (see
Out of scope).

## Architecture

OAuth is a token-**minting** mechanism layered onto the existing connector
system — it never changes how an evidence adapter *presents* a credential
upstream (still `Authorization: Bearer <token>`); only credential
*acquisition* and *storage* differ. One generic core (this PR: envelope
storage, state minting, the callback route, env gating, sheet wiring) plus
per-provider exchange adapters (W3-T2, W3-T3). `connectMethod` in the
catalog stays `"secret"` for both providers, unchanged — OAuth is an
*additive* connect option, not a replacement.

## Verified vendor facts (plan session)

| | Railway | Sentry |
|---|---|---|
| Flow | Standard authorization-code OAuth2 | Public Integration install flow |
| Authorize | `GET https://backboard.railway.com/oauth/auth` (confirmed W3-T2 — **corrects** the plan's own placeholder, which guessed `railway.com/oauth/authorize`; see "W3-T2 doc-verification" below) | Vendor-hosted install screen at the FIXED external URL `https://sentry.io/sentry-apps/<slug>/external-install/` (confirmed W3-T3) |
| Token exchange | `POST https://backboard.railway.com/oauth/token`, HTTP Basic client auth (confirmed W3-T2) | `POST https://sentry.io/api/0/sentry-app-installations/{installationId}/authorizations/`, JSON body, `grant_type=authorization_code` (confirmed W3-T3 — JSON, not form-urlencoded) |
| Callback params | `code`, `state` | `code`, **`installationId`** — **NO `state`** (confirmed-absent, W3-T3 — **corrects** this table's own prior placeholder; see "W3-T3 doc-verification" below). Tenant binding is resolved a DIFFERENT way instead — see "Session-transport tenant binding" below (W3-T3 fix round). |
| `stateTransport` | `"param"` (the default) | `"session"` |
| Scopes | `project:viewer offline_access openid`, `prompt=consent` (required to get a refresh token back) | granted at Public Integration registration time, not per-authorize |
| Access TTL | 1 hour | 8 hours (confirmed W3-T3) |
| Refresh | rotates the refresh token on every use; refresh token itself is valid ~1 year | same exchange endpoint, `grant_type=refresh_token` (confirmed W3-T3 — docs' own TOP recommendation is a different JWT-bearer mechanism; this is the documented, supported, "not recommended" alternative — see below) |
| Data API | Same GraphQL API + queries the evidence adapter (`lib/evidence/railway.ts`) already uses — only auth resolution changes | Bearer, same as today |

Sentry's extra `installationId` param is why the callback route forwards
*every* non-`state`/`code` query param to the adapter (`ExchangeInput.params`)
instead of hard-coding a two-field shape — Railway's adapter simply ignores
it.

### W3-T2 doc-verification (Railway)

Raw-fetched (curl, not WebFetch — this session's binding discipline after a
fabricated citation shipped a fake GraphQL type elsewhere this week) from
`docs.railway.com/integrations/oauth/{quickstart,login-and-tokens,
scopes-and-user-consent,creating-an-app,troubleshooting}.md`. One correction,
everything else confirmed:

- **Corrected:** the authorize endpoint is `GET https://backboard.railway.com/oauth/auth`
  — *"Redirect the user to the authorization endpoint: `GET
  https://backboard.railway.com/oauth/auth`"* (login-and-tokens.md). The
  plan's own "`railway.com/oauth/authorize`-family" was a provisional
  placeholder (explicitly flagged there as needing re-verification) — wrong
  on both host and path.
- **Confirmed**, exact: token endpoint `POST https://backboard.railway.com/oauth/token`,
  HTTP Basic client auth (`client_secret_basic`) — *"curl -X POST
  https://backboard.railway.com/oauth/token -u
  \"YOUR_CLIENT_ID:YOUR_CLIENT_SECRET\" -H \"Content-Type:
  application/x-www-form-urlencoded\" -d \"grant_type=authorization_code\"
  ..."* (quickstart.md).
- **Confirmed**, real and resource-scoped: *"`project:viewer` | Viewer
  access to user-selected projects"* (scopes-and-user-consent.md) — not an
  identity-only scope. `offline_access` requires `prompt=consent`: *"The
  `offline_access` scope grants refresh tokens ... but only when combined
  with `prompt=consent`"* (same page) — sent unconditionally on every
  authorize call by the adapter, never only on first connect.
- **Confirmed**: `expires_in: 3600`; *"Access tokens expire after one
  hour."* (login-and-tokens.md).
- **Confirmed, sharper than the plan's summary**: refresh tokens rotate, and
  *"using a rotated refresh token immediately revokes the entire
  authorization. This behavior helps detect potentially leaked tokens."*
  (troubleshooting.md) — not a soft failure, a full disconnect requiring
  reconnect. ~1-year lifetime and the 100-token cap both confirmed verbatim:
  *"The new refresh token has a fresh one-year lifetime from the time of
  issuance."* / *"Each user authorization can have a maximum of 100 refresh
  tokens. If you exceed this limit, the oldest tokens are revoked
  automatically."* (login-and-tokens.md). `lib/oauth/railway.ts`'s
  `refresh()` always returns whatever `refresh_token` the response carries;
  `core.ts`'s `resolveProviderAuth` already persists exactly that.
- **PKCE — confirmed optional for this client type, IMPLEMENTED (upgraded in
  the W3-T2 fix round)**: *"Web (Confidential) | Client Secret: Required |
  PKCE: Recommended"* vs. *"Native (Public) | Client Secret: None | PKCE:
  Required"* (creating-an-app.md). The FIRST submission read the table cell
  alone and disclosed PKCE as deliberately skipped; independent review
  (Finding #2, `.superpowers/sdd/review-W3T2.md`) pointed out the SAME
  page's prose is more emphatic: *"Even though web apps have a client
  secret, implementing PKCE is **strongly recommended**. PKCE protects
  against authorization code interception if an attacker manages to
  observe the redirect."* Combined with Cloudflare's own OAuth (a
  documented future phase) REQUIRING PKCE regardless of client type, the
  coordinator's scope ruling upgraded this to "now, S256" — see "PKCE +
  post-exchange project-grant check (W3-T2 fix round)" below for the
  design.

### W3-T2 fix round doc-verification (PKCE param names)

Re-fetched (curl) from `creating-an-app.md`'s own worked PKCE example —
param names confirmed verbatim, nothing guessed:

- Authorize URL adds `&code_challenge=CODE_CHALLENGE&code_challenge_method=S256`
  to the SAME `response_type`/`client_id`/`redirect_uri`/`scope` params
  already sent.
- Token exchange adds `-d "code_verifier=CODE_VERIFIER"` alongside the
  existing `grant_type=authorization_code`/`code`/`redirect_uri` fields, at
  the SAME `-u "CLIENT_ID:CLIENT_SECRET"` Basic-authed endpoint — no
  separate PKCE endpoint, no change to the auth method.

### W3-T3 doc-verification (Sentry) — and a headline finding: state cannot round-trip

Raw-fetched (curl, not WebFetch) from
`docs.sentry.io/integrations/integration-platform/public-integration.md`
and `docs.sentry.io/api/auth.md`. **Public Integration's own redirect
carries NO `state` parameter — confirmed absent, not merely unconfirmed —
correcting this doc's own prior vendor-facts table (which had carried
`state` in the Sentry callback-params cell since the planning session).**
This is the session's headline finding, not a footnote: per this task's own
binding instruction to stop rather than ship a stateless flow, the FIRST
W3-T3 submission implemented the complete `OauthProviderAdapter`
(`lib/oauth/sentry.ts`) but deliberately left it unreachable pending a
coordinator ruling on how tenant binding should work for a vendor that
cannot round-trip `state`. **Resolved in the W3-T3 fix round** — see
"Session-transport tenant binding" below the design section for the
mechanism the coordinator ruled for and Sentry's live status as of that
round.

- **State — confirmed absent for Public Integration.** The redirect
  section's own worked Flask handler reads exactly two params, nothing
  else: *"code = request.args.get('code') / install_id =
  request.args.get('installationId')"* — and the page's prose is explicit
  that the redirect carries *"the grant code and installation ID in the
  query params"*, no third value. The doc's only appearance of the word
  `"state"` in this flow is a field INSIDE the authorization JSON response
  (always `null` in the worked example), not a redirect query param.
- **Two unrelated Sentry OAuth mechanisms — the likely source of the stale
  belief.** Sentry ALSO documents a completely separate "OAuth Integration"
  mechanism (`integration-platform/oauth-integration/`, pointing to
  `/api/auth/#oauth2`) whose authorize endpoint
  (`https://sentry.io/oauth/authorize/`) DOES document `state`
  (*"Random string to prevent CSRF attacks"*) and PKCE — but that mechanism
  is explicitly NOT self-serve: *"Before implementing OAuth, Sentry must
  register your application. Contact our partnership team with: Client
  Name, Redirect URIs, ..."* (confirmed by a 404 on any attempt to reach a
  self-registration flow for it). The plan's own pin ("v1 uses the PUBLIC
  INTEGRATION flow") chose Public Integration specifically because it's
  self-serve — so the state-supporting mechanism was never actually in
  scope; the belief that "state is supported" conflated the two.
- **Confirmed — external-install URL, exact:** *"All public integrations
  can be installed via a fixed external url:
  `https://sentry.io/sentry-apps/<your-integration-slug>/external-install/`"*
  — matches the plan's own believed shape.
- **Confirmed — token exchange endpoint + JSON body (not form-urlencoded,
  unlike Railway):** *"url =
  'https://sentry.io/api/0/sentry-app-installations/{}/authorizations/'
  ... payload = \{'grant_type': 'authorization_code', 'code': code,
  'client_id': 'your-client-id', 'client_secret': 'your-client-secret'\}
  ... resp = requests.post(url, json=payload)"* — `requests.post(...,
  json=...)` serializes a JSON body; every one of the doc's three worked
  exchange/refresh snippets uses this same call shape.
- **Confirmed, and materially different from Railway/every other adapter —
  response field names + `expiresAt` shape:** *"\{ 'id': '38', 'token':
  '...', 'refreshToken': '...', 'dateCreated': '...', 'expiresAt':
  '2019-08-08T04:25:09.870Z', 'state': null, 'application': null \}"* —
  `token` (not `access_token`), `refreshToken` (not `refresh_token`,
  camelCase), and `expiresAt` is an ABSOLUTE ISO-8601 timestamp already
  (not an `expires_in` seconds-delta) — the adapter uses it verbatim, no
  `Date.now() + n*1000` arithmetic.
- **Confirmed — access TTL:** *"These tokens automatically expire every
  eight hours, meaning they must be refreshed manually."*
- **Confirmed, with a disclosed deviation from the doc's OWN top pick —
  refresh mechanism.** The docs describe TWO refresh paths and rank them
  explicitly: *"Refreshing Tokens Manually for Integrators (recommended)"*
  — a JWT (HS256, signed with the client secret, a custom
  `urn:sentry:params:oauth:grant-type:jwt-bearer` grant) — versus
  *"Refreshing Tokens via Refresh Token (not recommended)"*: *"We recommend
  Refreshing Tokens Manually as described above. But if you prefer, you can
  use Refresh Token."* This adapter implements the SECOND (refresh-token
  grant), matching the plan's own pinned design and this task's explicit
  instruction — still fully documented and supported, just not Sentry's
  top pick (their stated reason: a token-loss-in-transit edge case the
  JWT method sidesteps). Disclosed, not silently chosen — a future task
  could upgrade to the JWT method the same way Railway's PKCE went from
  disclosed-gap to implemented.
- **Confirmed, conditional — Verify Install.** *"If you have the redirect
  URL configured, there is work happening on your end to 'finalize' the
  installation. If this is the case, we recommend enabling the 'Verify
  Install' option for your integration. Once enabled, you'll need to send a
  request marking the installation as officially 'installed':
  `requests.put('https://sentry.io/api/0/sentry-app-installations/{}/'
  .format(install_id), json=\{'status': 'installed'\})`"* — an OPT-IN
  toggle set at registration time (Developer Settings), not detectable from
  the exchange response. `postExchange` calls this UNCONDITIONALLY but
  BEST-EFFORT (caught, logged, never fails the connect) — see the design
  section below for why this is the safer asymmetry versus Railway's
  fail-closed postExchange.

### W3-T5 doc-verification (Sentry webhooks) — unplanned fast-follow

Raw `curl` (not WebFetch) of `docs.sentry.io/integrations/integration-platform/webhooks.md`
and its `webhooks/installation.md` child page, fetched fresh this task.

- **Confirmed, quoted — signature header + computation.** The doc's own
  worked snippet: *"const hmac = crypto.createHmac(\"sha256\", secret);
  hmac.update(JSON.stringify(request.body), \"utf8\"); const digest =
  hmac.digest(\"hex\"); return digest ===
  request.headers[\"sentry-hook-signature\"];"* — header
  `Sentry-Hook-Signature` (read as `sentry-hook-signature`), HMAC-SHA256 hex
  digest, keyed by *"your Client Secret"* — the SAME `SENTRY_OAUTH_CLIENT_SECRET`
  W3-T3's token exchange already reads (one Public Integration, one Client
  Secret, two uses). Implemented over the RAW request bytes rather than the
  snippet's own `JSON.stringify(request.body)` re-serialization — disclosed
  deviation, not a vendor requirement either way (a re-parse/re-stringify
  round-trip isn't guaranteed byte-identical to the wire body); matches this
  codebase's existing raw-body-first discipline (`github/webhook`,
  `billing/stripe/webhook`).
- **Confirmed, quoted — resource/action.** `Sentry-Hook-Resource` header
  value for this event family, from `webhooks/installation.md`'s own
  "Sentry-Hook-Resource Header" section: *"'Sentry-Hook-Resource':
  'installation'"*. Its `action` field (body, not header): *"type: string,
  description: `created` or `deleted`"* — the ONLY two values.
- **Confirmed, quoted — installation uuid location.** The general page:
  *"installation: An object with the `uuid` of the installation so that you
  can map the webhook request to the appropriate installation"* (present on
  every resource type, top-level). The installation resource's own worked
  payload confirms the exact shape: top-level `"installation": {"uuid":
  "a8e5d37a-696c-4c54-adb5-b3f28d64c7de"}`, duplicated at
  `data.installation.uuid` inside the richer resource-specific object. The
  receiver reads the top-level, resource-agnostic copy.
- **Not vendor-mandated, disclosed as this codebase's own default —
  response code.** The docs state only a latency bound (*"Webhooks should
  respond within 1 second. Otherwise, the response is considered a
  timeout."*) — no explicit retry-on-non-2xx policy is documented anywhere
  on either page. "200 for every verified event" is therefore this
  receiver's own defensive choice (matching `billing/stripe/webhook`'s
  identical "recognized-but-ignored -> 200" convention), not a quoted
  vendor fact.

### W3-T6 doc-verification (Cloudflare) — phase 2, promoted from "planned" to as-built

Raw `curl` of `developers.cloudflare.com/fundamentals/oauth/{index,
authorizing-an-application,create-an-oauth-client,integrate-with-cloudflare}
/index.md`, `.../fundamentals/api/reference/permissions/index.md`, `.../
analytics/graphql-api/getting-started/authentication/api-token-auth/index.md`
— plus Cloudflare's own LIVE OIDC discovery document at
`https://dash.cloudflare.com/.well-known/openid-configuration`, fetched
fresh this task and treated as a primary source (it is the real production
server's own self-description, more authoritative than prose about it).

- **Confirmed, two independent sources agree verbatim** — endpoints:
  *"Authorization: `https://dash.cloudflare.com/oauth2/auth`; Token:
  `https://dash.cloudflare.com/oauth2/token`; Revoke:
  `https://dash.cloudflare.com/oauth2/revoke`"* (`integrate-with-cloudflare
  /index.md`), matching the discovery document's own
  `authorization_endpoint`/`token_endpoint`/`revocation_endpoint` fields
  exactly. `revoke` has no home on `OauthProviderAdapter` (T1's interface
  doesn't define one) — not wired, same as every other provider.
- **CORRECTS a claim already shipped in this doc and in `railway.ts`'s own
  doc-comment** (W3-T2's PKCE paragraph above: *"Combined with Cloudflare's
  own OAuth ... REQUIRING PKCE regardless of client type"*). The raw doc's
  own client-type table says otherwise: *"Server-side web app or backend
  service | Authorization Code with a client secret | client_secret_basic
  or client_secret_post | **Optional/not required** | Browser-based,
  mobile, desktop, or CLI app | Authorization Code with PKCE | none |
  **Required, S256**"* (`create-an-oauth-client/index.md`, "Choose a
  flow"). PKCE is required only for a public client with no secret — for a
  server-side backend service (this console, exactly Railway's own "Web
  (Confidential)" category), it is optional, mirroring Railway's own
  "Recommended, not Required" finding almost exactly. **Implemented
  anyway, REQUIRED by this adapter** — this task's own brief pins it
  (mirroring Railway's identical fix-round choice, reusing the SAME shared
  `lib/oauth/pkce.ts` plumbing built partly in anticipation of this task),
  not because the docs mandate it for this client type.
- **Confirmed — scopes correspond to API token permission names**: *"OAuth
  scope names correspond to Cloudflare API token permission names. Use the
  Cloudflare API documentation to identify the permissions your client
  needs."* (`create-an-oauth-client/index.md`, "Select scopes"). Two kinds,
  confirmed separately: universal ones via the live discovery document's
  own `scopes_supported: ["offline_access", "offline", "openid"]` (this
  adapter sends `openid offline_access`, the standard OIDC pair, on every
  authorize call); the RESOURCE/permission scope (what actually grants
  Analytics read access) is **genuinely undocumented as a fixed string** —
  the docs are explicit it is discovered per-account, not published:
  *"Fetch the available scopes from the API. Use the scope ID when you
  create a client through the API."* / *"Search for and select the scopes
  required for your client."* (same page). **Never guessed** — shipped as a
  new, REQUIRED `CLOUDFLARE_OAUTH_SCOPE` env var (mirrors Sentry's own
  `SENTRY_OAUTH_INTEGRATION_SLUG` third-var precedent) the owner fills in
  from the same dashboard scope-picker at registration time. The underlying
  permission needed is the SAME one the pre-existing token-paste path
  already asks for — confirmed present and human-readable: *"Analytics Read
  | Grants read access to \[analytics\]... "* under "Zone permissions"
  (`fundamentals/api/reference/permissions/index.md`), independently
  reconfirmed via the Analytics API's own token-setup walkthrough: *"select
  Account in the first drop-down list, Account Analytics from the second
  drop-down list, and Read from the third"*
  (`analytics/graphql-api/getting-started/authentication/api-token-auth
  /index.md`).
- **Confirmed — auth method**: `token_endpoint_auth_methods_supported:
  ["client_secret_post", "client_secret_basic", "private_key_jwt", "none"]`
  (discovery document). This adapter uses `client_secret_basic` (matches
  Railway's own precedent and the registration form's own worked API
  example, `"token_endpoint_auth_method": "client_secret_basic"`) — the
  owner must select the SAME method when registering the client; a mismatch
  is a registration error this code cannot detect.
- **NOT shown in a worked example anywhere** (unlike Railway's literal
  worked `curl` commands) — the exact authorize/token request PARAM NAMES.
  Inferred from RFC 6749's standard Authorization Code shape, licensed by
  the discovery document's own internally-consistent declared support
  (`response_types_supported` includes `"code"`;
  `grant_types_supported` includes `"authorization_code"`/`"refresh_token"`),
  cross-confirmed by prose ruling out every other flow for third-party
  clients: *"Cloudflare OAuth clients support the OAuth 2.0 Authorization
  Code flow. Cloudflare does not support Client Credentials, Implicit,
  Resource Owner Password Credentials, Device Authorization, or other OAuth
  grant types for third-party clients."* (`create-an-oauth-client
  /index.md`, "Supported OAuth flows").
- **Genuinely undocumented, confirmed by absence — access TTL.** No fetched
  page states a number, matching this task's own pre-stated expectation.
  `expires_in` is treated LENIENTLY (a disclosed, NOT vendor-confirmed
  300-second fallback when absent/invalid) — a deliberate asymmetry from
  Railway's stricter "missing expires_in throws," justified because
  Railway's own docs show a CONFIRMED worked example WITH the field present
  (so its absence there is a real anomaly), while no such example exists
  for Cloudflare to be absent from. `access_token`/`refresh_token`
  themselves remain strictly required either way — there is no safe
  fallback for "no token at all."
- **New finding, no equivalent in Railway's or Sentry's own registration
  steps — PUBLIC vs. PRIVATE client visibility.** *"New OAuth clients
  default to private visibility. Private clients can only be authorized by
  members of the parent Cloudflare account."* (`create-an-oauth-client
  /index.md`). Since every AgentRail workspace's own Cloudflare account is
  unrelated to whichever account registers this OAuth client, a client left
  at the PRIVATE default would only work for ONE account's own members.
  Promoting to PUBLIC requires completing "Client name / Logo / Client URL
  / Scopes" and **domain ownership verification** — a DNS TXT record:
  *"Cloudflare polls this DNS record until it is found or until the request
  times out after two days."* and *"Setting a client's visibility to public
  is permanent."* — a multi-day-capable, one-time owner action that gates
  `oauthReady` meaning anything for any workspace outside the registering
  account. See "Owner registration steps" below.
- **Confirmed — the OAuth grant IS resource-scoped, at the ACCOUNT level**:
  *"Account selection: Choose which Cloudflare account(s) the application
  can access"* (`authorizing-an-application/index.md`), corroborated by a
  2026-04-14 changelog entry (*"you can now select specific accounts
  instead of granting access to all your accounts"*). This is WHY there is
  no `postExchange` for Cloudflare (unlike Railway's): the grant granularity
  (account) does not map onto this connector's own config granularity
  (zone) the way Railway's `project:viewer` maps 1:1 onto
  `railwayProjectId`, verifying it would need a DIFFERENT permission
  ("Zone Read") than the one this connector's scope already requests
  ("Analytics Read"), and — most importantly — `lib/evidence/cloudflare.ts`'s
  own PRE-EXISTING "empty `viewer.zones` despite a configured zone id ->
  `config_missing`" pin (Task P8, unmodified) already degrades a
  wrong-account/wrong-zone token LEGIBLY on every single evidence call, not
  just once at connect time the way Railway's gap needed a one-time check to
  close.

## Design (pinned)

**Storage** — the encrypted plaintext behind the existing `connectors.secret`
column is now one of two shapes, discriminated after decrypt (no schema
migration, no new column): a legacy/token-paste value is the raw string,
verbatim; an OAuth value is
`{"oauth":1,"access":"...","refresh":"...","expiresAt":"<iso>"}`.
`packages/db-postgres/src/secret-envelope.ts` — `parseSecretEnvelope`
(discriminate) / `serializeOauthEnvelope` (wrap) — sits beside `crypto.ts`,
never inside it: encryption doesn't care what's inside the plaintext.
`hasSecret`/masking/write-only semantics are unchanged either way.

**State** — `mintGithubInstallState`/`consumeGithubInstallState`
(`github-app-token.ts`) turned out to be GitHub-hardcoded (two dedicated
columns on `workspaces`, one in-flight state per *workspace*, no provider
dimension) — not generic enough to reuse, and the plan pins no migration.
The chosen no-migration alternative: mint into `connectors.config` (the
plan's own offered fallback), keyed per `(workspaceId, provider)` via FOUR
ephemeral jsonb fields — `oauthState`, `oauthStateExpiresAt`, `oauthUserId`
(added in the W3-T1 fix round below), and `oauthPkceVerifier` (added in the
W3-T2 fix round — the PKCE `code_verifier`, riding in the SAME patch rather
than a second storage mechanism) — written and cleared with a **surgical**
jsonb `||`-merge / `-`-delete (the same idiom
`queries/investigations.ts`'s `claimLessonPromotion` already established).
Two independent protections, BOTH directions (fix round — an independent
review caught the original design only had the first):
  - `mintConnectorOauthState`/`consumeConnectorOauthState` never route
    through `upsertConnector`'s whole-column replace, so minting/consuming a
    state can't clobber an unrelated config field.
  - `completeConfig` now PRESERVES these three keys across an unrelated
    write (the reverse direction — a pending state used to be silently
    wiped by, e.g., a teammate's own connector edit landing on the same
    row), while a separate `toClientSafeConfig` strip still ensures none of
    the three ever reach a `ConnectorRowView` a route hands back to a
    browser — preserved in storage, invisible in the read model.
Single-use is enforced by one atomic
`UPDATE … WHERE state matches AND unexpired … RETURNING` — proven against a
REAL Postgres concurrent race (not just a mock) by an automated
`.integration.test.ts` (mirroring this package's `queue-retry-backoff`
precedent): N genuinely concurrent redemption attempts against the same
state resolve exactly once.

`oauthUserId` (fix round, CRITICAL-1 below) binds the MINTING user's id
alongside the workspace — `consumeConnectorOauthState` returns it so the
callback route can enforce that only the minter (still an owner/admin) may
redeem what they minted.

**Callback** — `GET /api/v1/connectors/oauth/callback/[provider]` is the ONE
route every OAuth-capable provider registers, reachable by anyone on the
internet. State alone binds the WORKSPACE (single-use, 30-minute,
high-entropy, server-minted — the ONLY source of the workspace id, never a
round-tripped query param), but that is not enough on its own: it defeats
*forgery* (a state can't be guessed or replayed) but nothing about
*misdirection* — nothing originally required the person who *minted* a
state and the person who *redeems* it to be the same person. An
independent review caught this (CRITICAL-1, fix round): an attacker,
legitimately owner/admin of their own workspace, could mint a real
authorize URL and send it to an unrelated victim as a phishing pretext,
landing the victim's own OAuth grant in the attacker's workspace. The
callback now requires an authenticated session AND binds the MINTING
user's id into the state itself
(`mintConnectorOauthState`'s third argument) — redemption requires the
session to (a) equal that bound minter and (b) still hold owner/admin
membership on the bound workspace (re-checked fresh, never trusted from
mint time), mirroring `connectors/github/install-callback/route.ts`'s own
session+membership gate for the same class of public, tenant-writing
OAuth-style callback (the actually-analogous precedent — NOT
`connectors/slack/callback/route.ts`, which never binds a workspace at
OAuth-completion time in the first place, so has no equivalent gate to
mirror). Failure reasons are a closed set — six at W3-T1, SEVEN as of the
W3-T2 fix round —
`state_invalid | provider_unknown | provider_unconfigured | denied |
exchange_failed | store_failed | project_not_granted` — never the vendor's
own error text, and the tenant-binding failure collapses into the SAME
`state_invalid` reason as a genuinely-expired state (anti-enumeration: a
prober cannot distinguish "wrong person" from "never existed" from the
redirect alone). Success redirects to `?connected=<provider>`; every
failure redirects to `?oauth_error=<reason>` (workspace-scoped once the
state has resolved a workspace id; the workspace-less `/dashboard` root
before that). A `?connected=`/`?oauth_error=` result was NEVER actually
surfaced to the user until the W3-T2 fix round — see "Sheet UX" below.

**Authorize-link** — `POST /api/v1/workspaces/[workspaceId]/connectors/oauth/link`
(owner/admin only, `{provider}` in the body) mints the state and returns the
vendor's authorize URL. 409, not 500, when the provider's OAuth env is unset
— a clear, actionable "use an API token instead" message, checked *before*
any state is minted.

**Env gating** — per-provider `<PROVIDER>_OAUTH_CLIENT_ID` /
`<PROVIDER>_OAUTH_CLIENT_SECRET`. The connectors GET route derives
`oauthReady: boolean` per provider server-side — **both** a registered
adapter *and* both env vars must be present; absent either, the sheet shows
token-paste only. This is why `oauthReady` is false everywhere immediately
after this PR merges: W3-T1 ships zero provider adapters on purpose.

**Refresh** — `apps/console/lib/oauth/core.ts`'s `resolveProviderAuth(workspaceId, provider)`
is the seam W3-T2/T3 wire evidence adapters through instead of reading
`connectors.secret` directly: decrypt → discriminate → a legacy token
returns verbatim (no refresh concept applies) → an OAuth envelope within a
2-minute expiry skew refreshes via the provider's adapter, persists the
rotated envelope, and returns the fresh access token. Never throws — every
failure (nothing stored, a corrupted secret, no adapter, a rejected refresh)
degrades to a typed `{ok:false, reason:"config_missing"|"unauthorized"}`,
the same vocabulary `lib/evidence/types.ts`'s `EvidenceDegradationReason`
already speaks. Single-flight: an in-process `Map<"workspaceId:provider",
Promise>` (console runs one replica) so two concurrent callers never fire
two competing refreshes against a vendor that rotates the refresh token on
use — verified with two simultaneous callers triggering exactly one
`refresh()` call. Bounded to ~30s (fix round — a hung `refresh()` with no
internal timeout of its own would otherwise wedge that
`(workspaceId,provider)` key's map entry forever): a timeout is treated
exactly like any other rejection, degrading to `unauthorized` and clearing
the map key so the next call starts fresh. Fix round: every catch in this
file now logs a fixed, value-free message (provider + workspaceId only,
never the caught error) — matching the callback route's own asserted
logging discipline, which previously only covered `exchange()`/
`setConnectorSecret` failures IN THE ROUTE, not `resolveProviderAuth`'s own
internal failures.

**PKCE + post-exchange project-grant check (W3-T2 fix round)** — two
ADDITIVE extensions to the T1 seam, both from independent review
(`.superpowers/sdd/review-W3T2.md`):

- *PKCE (Finding #2, upgraded from a disclosed gap to "implemented,
  S256").* `apps/console/lib/oauth/pkce.ts` — `generateCodeVerifier`/
  `computeCodeChallengeS256`, generic and provider-agnostic (reused by any
  future adapter, not Railway-specific). The link route mints a
  `code_verifier` for EVERY connect attempt, unconditionally, alongside
  `state` (`mintConnectorOauthState`'s new optional 4th arg — see "State"
  above) and hands the derived `code_challenge` to `adapter.authorizeUrl()`
  via an additive optional field; the callback route reads the verifier
  back off the consumed state and hands it to `adapter.exchange()` the same
  way. Railway's own adapter REQUIRES both (throws if either is missing —
  a deliberate choice: having built the shared plumbing, silently degrading
  to non-PKCE would be a worse, harder-to-notice failure than a loud throw).
- *Post-exchange project-grant check (Finding #1, MEDIUM-HIGH).* `project:viewer`
  is a RESOURCE-scoped grant — the user picks which Railway project(s) to
  share on Railway's OWN consent screen, independently of this workspace's
  stored `railwayProjectId`. Nothing previously reconciled the two: a
  mismatch could silently connect and later render as an
  honest-looking-but-wrong "(no deployments in window)" instead of a
  legible error. Fix: `OauthProviderAdapter` gains an OPTIONAL
  `postExchange(input: {envelope, config})` method the callback route calls
  AFTER `exchange()` succeeds but BEFORE persisting. Railway's
  implementation lists the grant's actual projects (`externalWorkspaces {
  projects { id name } }`, doc-confirmed) and applies three rules: (a)
  configured `railwayProjectId` NOT in the granted set → reject closed with
  the new `project_not_granted` reason, credential never stored; (b)
  unconfigured + the grant covers EXACTLY ONE project → auto-fill
  `railwayProjectId` via a `configPatch` (merged through `upsertConnector`
  → `completeConfig`, the SAME preserve-list machinery that already
  protects the ephemeral oauth-state keys) — kills the dual-selection UX
  gap in the common case; (c) unconfigured + zero or multiple projects →
  connect anyway, config stays unset (the SAME "config_missing on evidence
  calls until the admin sets a project id" state the legacy token-paste
  flow already produces when a token is pasted without the project id
  filled in — not a new gap). The verification call itself is deliberately
  NOT try/caught inside `postExchange` — a failure there fails the WHOLE
  connect closed (`exchange_failed`), never silently skips the check.
  **Live-smoke flag:** this exact call cannot be exercised against a real
  Railway OAuth app until one is registered (none is yet) — doc-confirmed
  and defensively parsed, but the first real post-registration connect
  attempt is this code path's actual live-smoke test.
- A `configPatch`'s own persistence (`upsertConnector`) is best-effort: a
  failure there is logged but does NOT flip an otherwise-successful connect
  to a failure redirect — the credential is already genuinely stored and
  usable at that point.

**Sentry adapter (W3-T3)** — `lib/oauth/sentry.ts` implements the full
`OauthProviderAdapter` (`authorizeUrl`/`exchange`/`refresh`/`postExchange`)
against the doc-verified facts above:

- *Installation id threading.* Sentry's refresh call needs `installationId`
  in the URL itself, but `refresh(envelope)` (T1/T2, unchanged) receives
  only the envelope, no workspaceId/config. Disclosed choice (the task
  offered two: thread it via the envelope, or extend the interface with a
  refresh input): threaded via the envelope's own `refresh` field, JSON-
  encoded as `{installationId, refreshToken}`, rather than extending
  `OauthProviderAdapter.refresh`'s signature — fully self-contained to this
  one file, zero changes to T1/T2's already-reviewed `core.ts`/`types.ts`/
  `railway.ts`. `postExchange` decodes the SAME field (it receives the
  exact envelope `exchange()` just returned) to recover `installationId`
  for its `configPatch` — no separate plumbing for that leg either.
- *`sentryInstallationId` config field* — declared on `ConnectorConfig`
  exactly like `railwayProjectId` (schema doc-comment, `completeConfig`
  preserve-line, never added to `EPHEMERAL_CONFIG_KEYS`) — non-secret,
  survives an unrelated write, visible in every `ConnectorRowView`. Written
  by `postExchange`'s `configPatch`, same best-effort persistence path
  Railway's own `configPatch` already established.
- *Verify Install — best-effort, not fail-closed* (unlike Railway's
  correctness-critical, deliberately-not-caught grant-mismatch check):
  Verify Install's applicability is an opt-in vendor-side toggle this code
  cannot detect from the exchange response, so `postExchange` always
  attempts the PUT but never fails the connect on its failure — the
  downstream risk if a genuinely-required verify is silently skipped is a
  LEGIBLE `unauthorized`/`upstream_error` degradation on a later evidence
  call (the same machinery any other auth problem already produces), not a
  silent wrong-data risk the way an unreconciled Railway project grant
  could be.
- *No PKCE* — Public Integration's exchange payload has no `code_verifier`
  field in any worked example; `codeChallenge`/`codeVerifier` are both
  ignored by this adapter, mirroring how Railway's adapter ignores
  `ExchangeInput.params`.

### Session-transport tenant binding (W3-T3 fix round — coordinator ruling, option B)

The FIRST W3-T3 submission stopped here: Sentry's Public Integration
redirect cannot carry `state`, and the callback route's `state`/`code`
requirement is a security gate (tenant binding, CSRF) applying to every
provider identically — so that submission implemented the complete adapter
but deliberately left it unreachable (no side-effect import into the three
routes that make a provider adapter live), pending a coordinator decision
on how to proceed. **The ruling: do not defer, do not ship stateless —
implement a session-based mechanism.** Sentry is live as of this fix round.

**SECOND fix round (independent review Finding 1, `.superpowers/sdd/
review-W3T3.md`):** the mechanism and CSRF-analysis text below were
corrected — the original text overclaimed "CSRF-equivalent, not weaker"
without qualifying WHICH attack shape that covers. See the CSRF analysis
subsection below for the honest scope (equivalent against misdirection,
genuinely weaker against artifact interception + replay) and the
per-transport TTL shipped as the one real mitigation.

**The mechanism.** `OauthProviderAdapter` gains an ADDITIVE, optional
`stateTransport?: "param" | "session"` capability flag (mirrors
`postExchange`'s own additive-capability precedent). `"param"` (the
default when absent — Railway, explicitly, unchanged) is everything above:
the vendor round-trips `state`; the callback consumes it by that exact
token. `"session"` (Sentry) replaces the LOOKUP mechanism, not the
underlying storage: the link route still mints the SAME state-record shape
(`mintConnectorOauthState` — `oauthState`/`oauthStateExpiresAt`/
`oauthUserId`, unchanged) into `connectors.config` jsonb, but for a
session-transport provider it FIRST calls
`clearPendingConnectorOauthStatesForUser(provider, userId)` — last-mint-
wins per (user, provider), across every workspace, so a user retrying the
connect flow (two tabs, backing out of the vendor's consent screen and
trying again) never leaves an earlier, still-pending record around. The
authorize URL still carries no `state` param (Sentry's adapter never
embeds the `state`/`codeChallenge` inputs it's handed — harmless, since the
link route mints/offers them unconditionally for every provider regardless
of transport, same as PKCE).

At the callback, a session-transport hit skips the `state` presence check
entirely (only `code` is required) but is otherwise gated identically:
session required BEFORE anything else (same position as `"param"`
transport). The pending record is then resolved by the REDEEMING
SESSION'S OWN user id instead of an opaque token —
`consumeConnectorOauthStateBySessionUser(provider, session.user.id)`
(`@agentrail/db-postgres`) — requiring EXACTLY ONE unexpired match across
every workspace; zero or multiple is the SAME closed `state_invalid`
reason as every other tenant-binding failure, and critically, **nothing is
consumed on an ambiguous multiple match**.

**CSRF analysis — honestly scoped (independent review Finding 1, W3-T3
SECOND fix round).** The FIRST fix round's own text here claimed
session-transport is "CSRF-equivalent, not a weaker substitute forced by
necessity." That claim is correct for exactly one attack shape and was
wrong to state without qualification — it is genuinely weaker against a
second, materially different one, never previously discussed. Both are
covered below.

*Equivalent against MISDIRECTION* — walk the SAME phishing attack the
"Callback" section above describes through to completion under
session-transport. An attacker, legitimately owner/admin of their own
Workspace A, mints a state under THEIR OWN session and sends the resulting
Sentry authorize URL to a Victim as a phishing pretext.
- If Victim completes Sentry's consent screen while NOT signed into
  AgentRail, the callback's session requirement already rejects
  (`state_invalid`) before anything is resolved — same as today.
- If Victim IS signed into AgentRail, the lookup resolves by VICTIM's own
  session user id — the pending record was minted under the ATTACKER's
  user id, so this finds ZERO matches for Victim. The OAuth grant Sentry
  just issued is discarded: never exchanged, never lands in the attacker's
  workspace. Symmetrically, an attacker cannot complete a VICTIM-minted
  flow either — they would need the victim's own authenticated session,
  which they don't have and cannot forge.
- The attacker CAN complete their OWN minted flow under their OWN
  session — that is simply a normal, legitimate connect, not an attack.
- Same-user, two-workspace ambiguity (one legitimate user has TWO pending
  Sentry attempts open at once — e.g. two tabs, two workspaces they admin)
  resolves to MULTIPLE candidates → REJECTED, and neither is consumed:
  there is no vendor-echoed token to disambiguate which pending attempt
  this specific `code`/`installationId` belongs to, so picking one would
  risk silently connecting the WRONG workspace's attempt. A disclosed UX
  tradeoff (finish one connect attempt before starting a second, or let
  the first's TTL lapse), not a security hole.

*NOT equivalent — strictly weaker — against ARTIFACT INTERCEPTION +
REPLAY*, a different attack shape entirely: Victim's own browser is
legitimately redirected to `?code=X&installationId=Y` by Sentry. Before
that request completes (tab closed, network blip, or it just hasn't
happened yet), the URL leaks independently — browser history on a shared
machine, an access log, a pasted support-ticket screenshot. An unrelated
Attacker, with zero relationship to Victim, starts their OWN ordinary
connect attempt (trivial — anyone can mint a pending record for
themselves), then hits the callback with the LEAKED `code`/`installationId`
instead of their own. The lookup resolves — correctly, BY DESIGN — to
Attacker's own pending record (exactly one candidate, exactly as intended
for a legitimate connect). `exchange()` is then called with the leaked
artifact; if Sentry still honors it, VICTIM's real Sentry installation
lands in ATTACKER's workspace. **Root cause: nothing here (or achievable
here) binds the specific `code`/`installationId` VALUE to the specific
pending record being resolved** — the lookup only proves "the redeemer has
a pending mint of their own," true for any attacker willing to start a
real connect attempt first. Param-transport closes this structurally (a
leaked `state`+`code` pair is useless without ALSO controlling the
minter's own session — account takeover, at which point OAuth binding is
moot); session-transport cannot, because the vendor round-trips nothing to
check that correlation against. A first-party nonce cookie was considered
and rejected as a fix: the attacker's own browser carries the attacker's
OWN valid cookie from their OWN legitimate mint, satisfying it just as
well — a cookie can only prove "this pending record belongs to the browser
presenting it" (which session/userId binding already establishes), never
"this code legitimately arose from this flow." Inherent to tenant binding
built on a vendor redirect that echoes nothing back, not a bug in this
implementation.

Two narrowing facts, stated honestly — neither is a fix:
1. Sentry's grant codes are ASSUMED single-use and short-lived, per
   ordinary OAuth2 hygiene (RFC 6749 §4.1.2: a code "MUST NOT" be used more
   than once and "MUST expire shortly") — but this is NOT vendor-confirmed:
   neither raw-fetched doc page states an explicit code TTL or single-use
   guarantee for this endpoint. IF true, a replay attempted AFTER Victim's
   own callback already completed successfully dies at Sentry's OWN
   exchange endpoint (an already-used code) — the live exploitable window
   is specifically "a callback that never completed," not an arbitrarily
   long one.
2. The pending record's own TTL bounds how long an attacker's own
   catch-a-leaked-artifact setup stays viable. **The one real mitigation
   this round ships:** session-transport pending records now use a
   DELIBERATELY SHORTER TTL than param-transport's default —
   `SESSION_TRANSPORT_OAUTH_STATE_TTL_MS` (10 minutes) vs.
   `OAUTH_STATE_TTL_MS` (30, unchanged for param-transport, which has no
   equivalent gap to shrink). Enforced entirely at mint time (the link
   route passes the shorter TTL into `mintConnectorOauthState`'s new
   optional 5th argument only for `stateTransport === "session"`) — neither
   consume function needs, or has, any transport-conditional logic of its
   own; both simply compare the already-shorter stored
   `oauthStateExpiresAt` against `now`, exactly as before. This narrows the
   practical exploit window; it does not close the gap.

**Atomicity under concurrency** — proven against a REAL Postgres, not just
argued: `consumeConnectorOauthStateBySessionUser` runs `SELECT ... FOR
UPDATE` (locking every candidate row) inside a `db.transaction`, then a
guarded `UPDATE ... WHERE id = <locked row> AND oauthState IS NOT NULL` in
the SAME transaction. This is deliberately NOT this package's own
documented EvalPlanQual CTE-guard gotcha shape (a CTE's WHERE clause is
evaluated once at snapshot time and never re-checked when an outer
statement's write finally acquires the lock) — the qualifying `SELECT`
itself IS the locking read here, and Postgres's own READ COMMITTED
locking-read semantics re-evaluate a blocked `SELECT ... FOR UPDATE`'s
WHERE clause against the freshly-committed row version once unblocked, so
a second racing caller correctly sees zero candidates once the first has
consumed the only match. `oauth-state-consume-race.integration.test.ts`
extends the existing param-transport race proof with a session-transport
sibling: N genuinely concurrent calls against the same pending record
resolve exactly once, matching the original mechanism's own guarantee
exactly.

**Env gating.** `OauthProviderAdapter` also gains an additive, optional
`envReady?(): boolean` — a provider's own check for EXTRA env vars beyond
the generic `oauthConfigFor`-checked `<PROVIDER>_OAUTH_CLIENT_ID`/
`_CLIENT_SECRET` pair. Sentry's implementation checks
`SENTRY_OAUTH_INTEGRATION_SLUG` (needed to build the external-install
URL). Read generically — never a provider name hardcoded into either
shared route — by the connectors GET route's `oauthReady` derivation and
the link route's 409 env-gate, alongside (never instead of)
`oauthConfigFor`. Absent `envReady` on an adapter defaults to ready,
unaffected for every provider before Sentry.

The full attack-tree reasoning above is mirrored in
`connectors/oauth/callback/[provider]/route.ts`'s own doc-comment
("SESSION-TRANSPORT CSRF ANALYSIS") and `lib/oauth/sentry.ts`'s own
("SESSION-TRANSPORT TENANT BINDING") — this section, not restated
piecemeal, is the canonical version; the code comments point back here.

## Sheet UX

`connectMethod` never flips (plan pin) — a secret-method provider always
renders `<SecretManage>`, never the oauth-native `<OAuthManage>` GitHub uses.
When `oauthReady` is true and the connector isn't already connected,
`SecretManage` renders a primary **"Connect {label}"** button (posts to the
generic link route, redirects the browser) above a quiet **"Use an API
token instead"** disclosure that reveals the exact same token form on
demand — a one-way reveal, no re-hide affordance. Without `oauthReady`, the
component renders *exactly* today's form, byte-identical (the same JSX
value, not a re-implementation) — zero visual regression for every other
provider. **Narrowed by W3-T4:** four providers (Grafana, Prometheus,
Langfuse, Datadog) now render one extra static sentence inside that shared
form value itself (`tokenStandardNote`, below) — still the one JSX value
returned from both the `oauthReady` and non-`oauthReady` branches (no new
branch, no re-implementation), so "byte-identical" now means "identical
across both branches for a given provider," not "identical to the
pre-W3-T4 form" for those four specifically.

Sentry's catalog entry (`connector-helpers.ts`) declares an `oauthHint`
(W3-T3) — LIVE as of the W3-T3 fix round: `oauthReady` for sentry reflects
the real three-env-var gate (`oauthConfigFor` + `sentryOauthAdapter`'s own
`envReady()`), so once all three `SENTRY_OAUTH_*` vars are set on a
deployment, the "Connect Sentry" primary button renders exactly like
Railway's — session-transport tenant binding (see "Session-transport
tenant binding" above) makes the whole flow actually completable now.

**Token-only sheet copy (W3-T4).** `ConnectorConnectMeta.tokenStandardNote`
— declared by exactly Grafana, Prometheus, Langfuse, Datadog — renders one
calm sentence inside `tokenForm` itself (the shared token-paste form, not
gated on `oauthReady` the way `oauthHint` is, since these four providers'
`oauthReady` is never true): API-token connect is this provider's standard
integration method, stated plainly, never a "coming soon"/apology framing.
Datadog's additionally names why the form asks for two values (its
already-composite API key + application key pair). Railway and Sentry keep
their own `oauthHint` instead — that field already covers "why token-paste
is fine here" for a provider that also offers OAuth; `tokenStandardNote`
is for the four that don't and never will this wave (see "Out of scope").

**Connect-result banner (W3-T2 fix round)** — T1 shipped the callback's
`?connected=<provider>`/`?oauth_error=<reason>` redirect but nothing ever
read it: a connect attempt (success OR any failure) landed back on the
connectors page with zero visible feedback beyond the connector's own state
quietly changing. Closed because the NEW `project_not_granted` reason
needs a legible "what do I do now," and the sheet itself is already closed
by redirect time (the browser navigated away to the vendor's consent
screen, so there is no open sheet left to caption). `ConnectorsPanel`
(`connectors-panel.tsx`) renders a small dismissible banner reading these
two params generically off the closed `OAUTH_ERROR_REASONS` set — one
sentence per reason (all seven), a success line for `connected`, nothing
for an unrecognized/missing param. Dismissing strips the query params
(`router.replace`) so a later refresh doesn't re-show a stale result.

## Phased rollout

1. **W3-T1 (this PR):** the seam — envelope helpers, state, both routes,
   `oauthReady`, sheet wiring, `resolveProviderAuth`. No provider adapters
   registered; `oauthReady` is false everywhere; behavior is unchanged for
   every real user.
2. **W3-T2:** Railway's `OauthProviderAdapter` (doc-verify the exact
   authorize URL first), `lib/evidence/railway.ts` switched to
   `resolveProviderAuth`, both envelope kinds tested. Fix round (independent
   review): PKCE (S256, shared plumbing) implemented; the
   `postExchange` project-grant check + `project_not_granted` closed
   reason; connect-result banner; T1's `core.ts` gained token-free logging
   on every refresh-failure path + a persist-after-vendor-success test.
3. **W3-T3:** Sentry's Public Integration adapter, `installationId` handling,
   `lib/evidence/sentry.ts` switched over. FIRST submission stopped short of
   live reachability — doc-verification found Sentry's Public Integration
   flow cannot round-trip a `state` value, which the (then-only) callback
   mechanism required for every provider — and flagged it for a coordinator
   ruling rather than shipping a stateless flow or improvising a fix
   mid-task. **Fix round (coordinator ruling, option B — do not defer, do
   not ship stateless): SESSION-TRANSPORT tenant binding implemented and
   wired live** — see "Session-transport tenant binding" above for the
   full mechanism and CSRF-equivalence argument. Sentry is live as of this
   fix round, on equal footing with Railway.
4. **W3-T4:** token-only sheet copy for four of the six providers that stay
   token-paste forever — Grafana, Prometheus, Langfuse, Datadog (the plan's
   own W3-T4 scope, `plan-oauth.md`; Vercel and Cloudflare did not get the
   same catalog note — see "Out of scope" below) — wave-final review, this
   doc's as-built section.
5. **Turn-on (ops, after W3-T2/T3 merge):** register both vendor apps
   (below), set their env vars on the deployment. No further code change
   flips `oauthReady` on for either provider — it is purely env + adapter
   presence (Sentry's own `envReady()` folded into that same check).
6. **W3-T6 (phase 2, unplanned-timing fast-follow of the plan's own
   "documented future phase"):** Cloudflare's `OauthProviderAdapter`
   (PKCE-required, reusing the SAME shared `./pkce.ts` plumbing W3-T2 built
   partly in anticipation of this), `lib/evidence/cloudflare.ts` switched to
   `resolveProviderAuth`. No `postExchange` (disclosed decision — see "W3-T6
   doc-verification" above). New third env var `CLOUDFLARE_OAUTH_SCOPE`
   (mirrors Sentry's `envReady()` pattern) since the resource-permission
   scope ID is genuinely undocumented as a fixed string. Registration has a
   new blocking step neither Railway nor Sentry needed: promoting the OAuth
   client from Cloudflare's PRIVATE default to PUBLIC visibility, which
   requires DNS domain verification (up to two days) — see "Owner
   registration steps" below.

## Owner registration steps

All three providers need the **exact** redirect URI registered on the
vendor side — a mismatch is the #1 real-world OAuth integration failure, so
this is not "a URL like…", it is the literal string:

- Production: `https://www.heyjace.com/api/v1/connectors/oauth/callback/railway`,
  `https://www.heyjace.com/api/v1/connectors/oauth/callback/sentry`, and
  `https://www.heyjace.com/api/v1/connectors/oauth/callback/cloudflare`
- Local dev (`CONSOLE_PUBLIC_URL=http://localhost:3000`, this repo's
  documented default): `http://localhost:3000/api/v1/connectors/oauth/callback/railway`,
  `.../sentry`, and `.../cloudflare` — substitute your own dev port if it
  differs.

Sentry additionally needs its **Webhook URL** registered (a separate field
on the same Public Integration form, W3-T5 — see "W3-T5 doc-verification"
above): production `https://www.heyjace.com/api/v1/connectors/webhooks/sentry`,
local dev `http://localhost:3000/api/v1/connectors/webhooks/sentry`. Same
Client Secret as the OAuth exchange signs both — no separate credential to
issue or store.

**Railway:** register an OAuth application from the target **workspace's**
own settings — **Settings → Developer → New OAuth App** (confirmed W3-T2,
`creating-an-app.md`: OAuth apps are workspace-scoped and created by
workspace admins, not an account-level setting) — app type **Web
(Confidential)**, with the redirect URI above; note the issued client
id/secret (shown once); set `RAILWAY_OAUTH_CLIENT_ID` /
`RAILWAY_OAUTH_CLIENT_SECRET` on the deployment.

**Sentry:** register a **Public Integration** (Sentry → Settings →
Developer Settings → New Public Integration) with the redirect URI above
as its Redirect URL and the webhook URL above as its Webhook URL; note the
issued client id/secret and the integration's own slug; set
`SENTRY_OAUTH_CLIENT_ID` / `SENTRY_OAUTH_CLIENT_SECRET` /
`SENTRY_OAUTH_INTEGRATION_SLUG`. Live as of the W3-T3 fix round — see
"Session-transport tenant binding" above for how tenant binding works
without a vendor-echoed `state`. **The uninstall webhook is now LIVE
(W3-T5, deferred-no-longer):** `installation.deleted` clears the
affected workspace's stored secret + `sentryInstallationId`, so an
uninstall on Sentry's own side no longer requires the operator to notice
and manually disconnect — see
`apps/console/app/api/v1/connectors/webhooks/sentry/route.ts`.

**Cloudflare (W3-T6):** register an OAuth client at Cloudflare → **Manage
Account → OAuth clients → Create client**
(`dash.cloudflare.com/?to=/:account/oauth-clients`) — Response type `code`,
Grant type `authorization_code`, Token authentication method
`client_secret_basic` (must match this adapter's own choice — see "W3-T6
doc-verification" above), Redirect URL from the list above; search the
scopes picker for the permission matching "Analytics Read" under Zone
permissions (same one the token-paste path's own setup steps ask for) — NOT
the similarly-named, ALSO-real "Account Analytics Read" (a different,
account-scoped permission) — confirmed 2026-08-01 from the live dashboard
picker as `analytics.read` (an operator-dashboard reading, not a
vendor-doc-guaranteed string — see "W3-T6 doc-verification" above); note
the resulting scope ID(s) for `CLOUDFLARE_OAUTH_SCOPE`, verifying against
your own dashboard picker since this can change without notice; note the
issued client id/secret;
set `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` /
`CLOUDFLARE_OAUTH_SCOPE` on the deployment. **Then promote the client to
PUBLIC visibility** (Cloudflare → the client's action menu → Change
Visibility) — new clients default to PRIVATE (authorizable only by members
of the registering account), which would make this connect button
functionally unusable for every OTHER workspace's own Cloudflare account;
promotion requires completing the client's Logo/Client URL fields and a DNS
TXT domain-verification record that Cloudflare polls for "until it is found
or until the request times out after two days" — plan this as a multi-day
lead time before Cloudflare OAuth is usable wave-wide, not a same-deploy
toggle. This is a materially bigger registration lift than Railway's or
Sentry's own steps, both single-session dashboard actions.

Once every provider's env vars are set (and its own task has merged so its
adapter is registered), `oauthReady` flips true server-side automatically
for it — no redeploy-time toggle beyond the env vars themselves (Sentry's
`envReady()` gates on all three of its vars; Cloudflare's own `envReady()`
gates on `CLOUDFLARE_OAUTH_SCOPE` the same way).

## Out of scope

- Vercel, Datadog, Langfuse, Grafana, Prometheus OAuth — none are in this
  wave; token-paste is the permanent, correct mechanism for all five.
  **Correction (W3-T4):** the one-line "this is the standard integration
  method" sheet note (`ConnectorConnectMeta.tokenStandardNote`, not an
  apology, no "coming soon") went to only FOUR of these five — Grafana,
  Prometheus, Langfuse, Datadog, exactly `plan-oauth.md`'s own W3-T4 task
  line — not all six original candidates as an earlier draft of this bullet
  claimed. Vercel's exclusion from the sheet note is simply the plan's own
  W3-T4 scope pin, not a claim about its own OAuth roadmap either way.
  **Cloudflare moved OUT of this list (W3-T6)** — its own OAuth phase,
  previously "documented future," is now built; see "W3-T6
  doc-verification" above and "As-built addendum (W3-T6)" below.
- Datadog's own MCP server / any MCP-based connect mechanism — a different
  integration shape entirely, not evaluated here.
- ~~Sentry's uninstall webhook~~ — **shipped W3-T5** (unplanned fast-follow,
  see "As-built" below); no longer out of scope.
- Per-user OAuth identity (this is a per-*workspace* credential, exactly
  like today's pasted tokens — one connection shared by the workspace, not
  one per team member).

## As-built (W3-T1..T4)

Eight material deviations from this doc's own originally-pinned design,
each already folded into its relevant section above — collected here as
the single compact list the wave's own W3-T4 task calls for. Every item
below is a pointer to the section carrying the full reasoning, not a
restatement of it.

1. **State store is `connectors.config` jsonb, not a reused GitHub
   mechanism** (W3-T1) — `mintGithubInstallState` turned out to be
   GitHub-hardcoded (two dedicated `workspaces` columns, one
   workspace-scoped state, no provider dimension); the plan's own
   no-migration fallback was used instead. See "State" under Design.
2. **`postExchange` hook + `project_not_granted` + auto-fill** (W3-T2 fix
   round) — reconciles Railway's resource-scoped `project:viewer` grant
   against the workspace's configured project id, closed with a new
   closed reason and single-project auto-fill. See "PKCE + post-exchange
   project-grant check."
3. **PKCE (S256), generic shared plumbing** (W3-T2 fix round) — upgraded
   from a disclosed v1 gap to implemented now: `lib/oauth/pkce.ts`, reused
   by any future adapter via the same state-record jsonb patch. See the
   same section.
4. **Sentry state-transport correction** (W3-T3, both fix rounds) —
   doc-verification found Sentry's redirect carries no `state` param at
   all (the plan's own vendor-facts table was wrong); shipped
   adapter-complete-but-unreachable pending a coordinator ruling, then
   wired live via session-transport tenant binding (a per-user pending
   marker, not an echoed token). The second fix round corrected an
   overclaim that this was flatly CSRF-equivalent to param-transport —
   it's equivalent against misdirection but honestly disclosed as weaker
   against artifact interception + replay, with a shorter TTL (item 7) as
   the one real mitigation. See "Session-transport tenant binding."
5. **Connect-result banner** (W3-T2 fix round) — W3-T1 shipped the
   callback's `?connected=<provider>`/`?oauth_error=<reason>` redirect but
   nothing ever read it; closed once `project_not_granted` needed a
   legible surface. See "Sheet UX."
6. **`getConnectorRaw`/`toRawView` split** (W3-T1 fix round) — the
   ephemeral-oauth-key preserve-list fix was a silent no-op because the
   merge read "existing" config through the already-client-stripped public
   `getConnector`; fixed with an internal, never-exported raw-view read
   path. See "State."
7. **Per-transport state TTLs** (W3-T3 second fix round) —
   `mintConnectorOauthState` gained an optional `ttlMs`; session-transport
   uses a deliberately shorter `SESSION_TRANSPORT_OAUTH_STATE_TTL_MS` (10
   min) than param-transport's unchanged `OAUTH_STATE_TTL_MS` (30 min),
   narrowing item 4's disclosed exploit window. See "Session-transport
   tenant binding."
8. **`envReady` third-env-var gate** (W3-T3 fix round) —
   `OauthProviderAdapter` gained an additive, optional `envReady?()` beyond
   the generic client id/secret pair; Sentry's checks
   `SENTRY_OAUTH_INTEGRATION_SLUG`, folded into both `oauthReady`
   derivation and the link route's 409 env-gate. See "Env gating."

W3-T4 itself shipped as this doc always scoped it — the `tokenStandardNote`
sheet copy for Grafana/Prometheus/Langfuse/Datadog (see "Sheet UX") plus
this appendix and the stale-cross-reference sweep below — no deviation
from the original plan.

**Stale cross-references corrected this task** (the wave-final consistency
review `plan-oauth.md`'s own W3-T4 line calls for): the Problem section's
provider count ("five" → six, matching its own parenthetical list of six
names); the phased-rollout W3-T4 line and the "Out of scope" section both
undercounted/overcounted which providers got the `tokenStandardNote` sheet
note (corrected to the actual four); the Sheet UX section's
"byte-identical" claim narrowed to account for the four providers that now
render one extra static sentence in the shared token-form value.

## As-built addendum (W3-T5 — Sentry webhook receiver, unplanned fast-follow)

Not part of the original wave plan (`plan-oauth.md` scoped `installation.deleted`
as a v2 follow-up — see the "Out of scope" correction above): pulled forward
because the owner registered Sentry's Public Integration and its form
requires a Webhook URL immediately, not later.

`POST /api/v1/connectors/webhooks/sentry` (route + a sibling
`sentry-webhook-helpers.ts`, `apps/console/app/api/v1/connectors/webhooks/sentry/`)
verifies `Sentry-Hook-Signature` (HMAC-SHA256 hex over the raw request
body, keyed by the SAME `SENTRY_OAUTH_CLIENT_SECRET` the OAuth exchange
already reads, timing-safe compare) before parsing anything. Env unset ->
503 (never a signature bypass); bad/missing signature -> 401; every OTHER
verified event -> 200 (Sentry's own docs document no explicit
retry-on-non-2xx policy, so this is a defensive default, not a vendor
requirement — see "W3-T5 doc-verification" above). `installation.deleted`
resolves every workspace whose `sentry` connector config carries the
payload's installation uuid
(`findConnectorsBySentryInstallationId`, new — `@agentrail/db-postgres`)
and clears each one's stored secret + `sentryInstallationId`
(`clearSentryConnectorForInstallation`, new — its own UPDATE re-checks
workspaceId/provider/installationId in its own WHERE, never trusting the
lookup's snapshot). `installation.created` and every other resource/action
are a 200 no-op — this console's token acquisition rides the OAuth
redirect flow, never the webhook.

**Full report + doc-verification trail:** `.superpowers/sdd/task-W3T5-report.md`.

## As-built addendum (W3-T6 — Cloudflare OAuth adapter, phase 2)

The plan's own "documented future phase" for Cloudflare (referenced
throughout W3-T2's PKCE reasoning above) — promoted to as-built. Full
doc-verification trail: "W3-T6 doc-verification (Cloudflare)" above; full
quoted trail also in `.superpowers/sdd/task-W3T6-report.md`.

`lib/oauth/cloudflare.ts` mirrors `railway.ts`'s shape (`authorizeUrl`/
`exchange`/`refresh`, `stateTransport: "param"`, PKCE S256 REQUIRED via the
shared `./pkce.ts` plumbing) with three material deviations, each disclosed
in the adapter's own doc-comment:

1. **`CLOUDFLARE_OAUTH_SCOPE`, a new required third env var** (`envReady()`,
   mirrors Sentry's `SENTRY_OAUTH_INTEGRATION_SLUG`) — the resource-
   permission scope ID is genuinely undocumented as a fixed string
   (Cloudflare's own docs: discovered per-account via a dashboard
   scope-picker or an authenticated `GET /oauth/scopes` call, never
   published in prose) — never guessed, made operator-supplied instead.
2. **No `postExchange`** — unlike Railway's, closing a project-grant
   mismatch. Three independent reasons (full reasoning in "W3-T6
   doc-verification" above): `cloudflareAccountId` is confirmed unused by
   the evidence adapter; Cloudflare's own consent grant is account-scoped,
   which doesn't map cleanly onto this connector's zone-scoped config the
   way Railway's project grant maps onto `railwayProjectId`; and — the
   decisive reason — `lib/evidence/cloudflare.ts`'s own PRE-EXISTING "empty
   `viewer.zones` despite a configured zone id → `config_missing`" pin
   (Task P8, unmodified) already closes the equivalent silent-mismatch risk
   on EVERY evidence call, not just once at connect time.
3. **Lenient `expires_in` handling** — a disclosed, NOT vendor-confirmed
   300-second fallback when the field is absent/invalid, versus Railway's
   strict throw-on-missing. Justified asymmetry: Railway's docs show a
   CONFIRMED worked example WITH the field present; no equivalent example
   exists for Cloudflare. `access_token`/`refresh_token` themselves remain
   strictly required either way.

`lib/evidence/cloudflare.ts` switches to `resolveProviderAuth(workspaceId,
"cloudflare")`, byte-identical GraphQL query documents
(`CLOUDFLARE_SIGNALS_QUERY`/`CLOUDFLARE_SEARCH_EVENTS_QUERY` untouched) —
mirrors `railway.ts`'s/`sentry.ts`'s identical W3-T2/T3 switch exactly.

**New finding with no Railway/Sentry equivalent:** Cloudflare OAuth clients
default to PRIVATE visibility (authorizable only by members of the
registering account) and must be promoted to PUBLIC — a DNS domain-
verification step that can take up to two days — before any OTHER
workspace's Cloudflare account can use the connect button at all. See
"Owner registration steps" above; this is now the long-lead-time item in
the wave's own rollout, not a same-deploy env-var flip.

**Vendor verification outcome: one correction, everything else confirmed
or explicitly disclosed as undocumented.** The correction: Cloudflare's own
docs say PKCE is "Optional/not required" for a server-side confidential
client (required only for a public client with no secret) — contradicting
both this session's prior research and a claim already shipped in
`railway.ts`'s own doc-comment ("Cloudflare's own OAuth ... REQUIRING PKCE
regardless of client type"). Implemented as REQUIRED anyway, per this
task's own brief, not because the docs mandate it for this client type.
Nothing found contradicts the adapter's ability to mint a token the
evidence adapter's GraphQL queries can actually use — the "cannot grant
what's needed" stop condition never triggered.

**Full report + doc-verification trail:** `.superpowers/sdd/task-W3T6-report.md`.
