# OAuth Connect — one-click Railway & Sentry, token-paste forever

**Date:** 2026-07-31 · **Status:** approved (`.superpowers/sdd/plan-oauth.md`) · **Phasing:** W3-T1 core (this PR) → W3-T2 Railway adapter → W3-T3 Sentry adapter → W3-T4 wrap

## Problem

Connecting an observability provider today means pasting a hand-copied API
token — correct, but friction for the two providers that are both fully
self-serve (no sales call, no approval queue) AND expose a real OAuth flow:
Railway and Sentry. The other five observability providers in the catalog
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
| Authorize | `GET https://backboard.railway.com/oauth/auth` (confirmed W3-T2 — **corrects** the plan's own placeholder, which guessed `railway.com/oauth/authorize`; see "W3-T2 doc-verification" below) | Vendor-hosted install screen for the registered Public Integration |
| Token exchange | `POST https://backboard.railway.com/oauth/token`, HTTP Basic client auth (confirmed W3-T2) | `POST /api/0/sentry-app-installations/{installationId}/authorizations/`, `grant_type=authorization_code` |
| Callback params | `code`, `state` | `code`, `state`, **`installationId`** (extra — see below) |
| Scopes | `project:viewer offline_access openid`, `prompt=consent` (required to get a refresh token back) | granted at Public Integration registration time, not per-authorize |
| Access TTL | 1 hour | 8 hours |
| Refresh | rotates the refresh token on every use; refresh token itself is valid ~1 year | same exchange endpoint, `grant_type=refresh_token` |
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
provider, and for railway/sentry themselves until W3-T2/T3 land.

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
   `lib/evidence/sentry.ts` switched over.
4. **W3-T4:** token-only sheet copy for the five providers that stay
   token-paste forever, wave-final review, this doc's as-built section.
5. **Turn-on (ops, after W3-T2/T3 merge):** register the vendor apps (below),
   set the env vars on the deployment. No further code change flips
   `oauthReady` on — it is purely env + adapter presence.

## Owner registration steps

Both providers need the **exact** redirect URI registered on the vendor
side — a mismatch is the #1 real-world OAuth integration failure, so this is
not "a URL like…", it is the literal string:

- Production: `https://heyjace.com/api/v1/connectors/oauth/callback/railway`
  and `https://heyjace.com/api/v1/connectors/oauth/callback/sentry`
- Local dev (`CONSOLE_PUBLIC_URL=http://localhost:3000`, this repo's
  documented default): `http://localhost:3000/api/v1/connectors/oauth/callback/railway`
  and `.../sentry` — substitute your own dev port if it differs.

**Railway:** register an OAuth application from the target **workspace's**
own settings — **Settings → Developer → New OAuth App** (confirmed W3-T2,
`creating-an-app.md`: OAuth apps are workspace-scoped and created by
workspace admins, not an account-level setting) — app type **Web
(Confidential)**, with the redirect URI above; note the issued client
id/secret (shown once); set `RAILWAY_OAUTH_CLIENT_ID` /
`RAILWAY_OAUTH_CLIENT_SECRET` on the deployment.

**Sentry:** register a **Public Integration** (Sentry → Settings →
Developer Settings → New Public Integration) with the redirect URI above as
its Redirect URL; note the issued client id/secret; set
`SENTRY_OAUTH_CLIENT_ID` / `SENTRY_OAUTH_CLIENT_SECRET`. The uninstall
webhook Sentry also offers is a documented v2 follow-up, not part of v1.

Once both are set (and W3-T2/T3 have merged so an adapter is actually
registered), `oauthReady` flips true server-side automatically — no
redeploy-time toggle beyond the env vars themselves.

## Out of scope

- Cloudflare, Vercel, Datadog, Langfuse, Grafana, Prometheus OAuth — none
  are in this wave; token-paste is the permanent, correct mechanism for them
  (W3-T4 gives each a one-line "this is the category standard" sheet note,
  not an apology).
- Datadog's own MCP server / any MCP-based connect mechanism — a different
  integration shape entirely, not evaluated here.
- Sentry's uninstall webhook (would let a vendor-side uninstall
  auto-disconnect the connector) — documented follow-up, v1 relies on the
  operator noticing and disconnecting manually.
- Per-user OAuth identity (this is a per-*workspace* credential, exactly
  like today's pasted tokens — one connection shared by the workspace, not
  one per team member).

## As-built (W3-T4, appended when the wave closes)

_Pending — filled in once W3-T2/T3/T4 land._
