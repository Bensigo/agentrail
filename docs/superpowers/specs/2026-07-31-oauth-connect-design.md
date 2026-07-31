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
| Authorize | `railway.com/oauth/authorize`-family (exact URL re-verified in W3-T2 against the quickstart doc) | Vendor-hosted install screen for the registered Public Integration |
| Token exchange | `POST backboard.railway.com/oauth/token` | `POST /api/0/sentry-app-installations/{installationId}/authorizations/`, `grant_type=authorization_code` |
| Callback params | `code`, `state` | `code`, `state`, **`installationId`** (extra — see below) |
| Scopes | `project:viewer offline_access openid`, `prompt=consent` (required to get a refresh token back) | granted at Public Integration registration time, not per-authorize |
| Access TTL | 1 hour | 8 hours |
| Refresh | rotates the refresh token on every use; refresh token itself is valid ~1 year | same exchange endpoint, `grant_type=refresh_token` |
| Data API | Same GraphQL API + queries the evidence adapter (`lib/evidence/railway.ts`) already uses — only auth resolution changes | Bearer, same as today |

Sentry's extra `installationId` param is why the callback route forwards
*every* non-`state`/`code` query param to the adapter (`ExchangeInput.params`)
instead of hard-coding a two-field shape — Railway's adapter simply ignores
it.

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
plan's own offered fallback), keyed per `(workspaceId, provider)` via two
ephemeral jsonb fields, `oauthState`/`oauthStateExpiresAt`, written and
cleared with a **surgical** jsonb `||`-merge / `-`-delete (the same idiom
`queries/investigations.ts`'s `claimLessonPromotion` already established) —
never through `upsertConnector`'s whole-column replace, so an unrelated
connector write can't silently wipe a pending state, and the state can never
leak back out through any GET response (it is deliberately excluded from
`completeConfig`'s preserved-fields whitelist). Single-use is enforced by one
atomic `UPDATE … WHERE state matches AND unexpired … RETURNING` — verified
live against Postgres: a replay of an already-consumed state resolves
`null`, never twice.

**Callback** — `GET /api/v1/connectors/oauth/callback/[provider]` is the ONE
route every OAuth-capable provider registers, reachable by anyone on the
internet. No session check: unlike GitHub's App-install callback (global URL
+ a low-entropy, guessable `installation_id` — its own anti-IDOR problem),
this flow's entire security boundary is the single-use, 30-minute,
high-entropy server-minted `state`, which is also the ONLY source of the
workspace id (never a round-tripped query param) — mirrors
`connectors/slack/callback/route.ts`, the closest real third-party-OAuth2
precedent in this codebase, which is session-less for the identical reason.
Failure reasons are a closed, six-value set —
`state_invalid | provider_unknown | provider_unconfigured | denied |
exchange_failed | store_failed` — never the vendor's own error text.
Success redirects to `?connected=<provider>`; every failure redirects to
`?oauth_error=<reason>` (workspace-scoped once the state has resolved a
workspace id; the workspace-less `/dashboard` root before that).

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
`refresh()` call.

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

## Phased rollout

1. **W3-T1 (this PR):** the seam — envelope helpers, state, both routes,
   `oauthReady`, sheet wiring, `resolveProviderAuth`. No provider adapters
   registered; `oauthReady` is false everywhere; behavior is unchanged for
   every real user.
2. **W3-T2:** Railway's `OauthProviderAdapter` (doc-verify the exact
   authorize URL first), `lib/evidence/railway.ts` switched to
   `resolveProviderAuth`, both envelope kinds tested.
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

**Railway:** register an OAuth application (Railway's developer/account
settings — the exact console path is confirmed alongside the authorize URL
in W3-T2, since both come from the same doc-verify pass) with the redirect
URI above; note the issued client id/secret; set
`RAILWAY_OAUTH_CLIENT_ID` / `RAILWAY_OAUTH_CLIENT_SECRET` on the deployment.

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
