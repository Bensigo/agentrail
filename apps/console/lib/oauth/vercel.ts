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
 * OAuth Connect Wave 3, W3-T9 (`.superpowers/sdd/plan-oauth.md` — this task
 * post-dates the plan's own original W3-T1..T4 scope; see the spec doc's
 * "As-built addendum (W3-T9)" for the full record). Vercel's
 * `OauthProviderAdapter`. Fills in T1's seam (`./types.ts`/`./core.ts`,
 * unchanged by this task) the same way `./railway.ts`/`./sentry.ts`/
 * `./cloudflare.ts` did — this file's ONLY job is to talk to Vercel's OAuth
 * server correctly and return an envelope `resolveProviderAuth` (`./core.ts`)
 * can present as `Authorization: Bearer <access>`, unchanged, to
 * `lib/evidence/vercel.ts`'s own REST calls.
 *
 * ============================================================================
 * DOC-VERIFICATION (BINDING — this session's own discipline, raw `curl`
 * fetches of the doc pages' own markdown source, `<page>.md`, never a
 * WebFetch summary — see this repo's own `feedback-raw-fetch-doc-verification`
 * memory note for why). Sources, all fetched live 2026-08-02 (fix round,
 * `.superpowers/sdd/review-W3T9.md` Finding 2: `integrations/index.md`
 * below 404s — `<page>.md` has no `/index` suffix on this site, unlike
 * Cloudflare's/Sentry's own doc platforms; corrected to `integrations.md`,
 * re-verified the cited quotes are present there verbatim):
 * `vercel.com/docs/integrations.md`,
 * `vercel.com/docs/integrations/create-integration.md`,
 * `vercel.com/docs/integrations/create-integration/submit-integration.md`,
 * `vercel.com/docs/integrations/create-integration/vercel-api-integrations.md`,
 * `vercel.com/docs/integrations/create-integration/approval-checklist.md`,
 * plus a full-corpus grep of `vercel.com/docs/llms-full.txt` (7.6MB, every
 * doc page concatenated) for `oauth/access_token`, `refresh_token`,
 * `expires_in`, `installation_id`, `access_token` — the SAME technique this
 * file's own doc-comment cites as ground truth for what is, and is NOT,
 * documented anywhere on the site.
 * ============================================================================
 *
 * (1) INTEGRATION TYPE — three DISTINCT Vercel mechanisms exist; only ONE
 * grants REST API access to a user's own deployments, and it is NOT the
 * newest-sounding one:
 *   - **"Connectable account" integration, external installation flow —
 *     THE ONE THIS ADAPTER USES.** Self-serve: created via the SAME "Create
 *     Integration" form as a native integration, choosing the connectable-
 *     account type — no partnership, no sales call. Confirmed self-serve
 *     framing: "These integrations allow you to connect Vercel with an
 *     existing account on a third-party platform or service" —
 *     `integrations.md`. This is the ONLY mechanism whose own doc page
 *     is titled "Building Integrations with **Vercel REST API**" and whose
 *     worked flow ends at `Authorization: Bearer <access_token>` against
 *     `api.vercel.com`'s real endpoints (`/v7/deployments`, `/v9/projects/…`,
 *     `/v2/user` — the exact three `lib/evidence/vercel.ts` already calls).
 *   - **"Native integration" / Marketplace Provider API — NOT this, ruled
 *     out.** Confirmed to REQUIRE a Vercel partnership, not self-serve:
 *     "Native integrations allow a two-way connection between Vercel and
 *     third-parties Vercel has partnered with" — `integrations.md`
 *     (no bold in the source); "In order to create native integrations,
 *     please share your `team_id` and Integration's URL Slug with Vercel in
 *     your shared Slack channel… You can sign up to be a native integration
 *     provider [at /marketplace/program]" — `create-integration.md`. This
 *     mechanism's own "Vercel API authentication" section (a DIFFERENT doc
 *     page, `create-integration/marketplace-api.md`) confirms a DIFFERENT
 *     credential path entirely: "You receive this token during the
 *     installation process when you call the [Upsert Installation API]…
 *     The response includes a `credentials` object with an `access_token`"
 *     — VERCEL calls INTO the
 *     integration's OWN server (an "integration server" this connector would
 *     have to stand up and operate) and hands IT a token to call BACK into
 *     Vercel's BILLING API on behalf of an installation — the inverse
 *     direction, and a materially bigger build (implementing the Marketplace
 *     Provider API, billing webhooks, etc.), from what a read-only
 *     deployments/events connector needs. Out of scope, correctly.
 *   - **"Sign in with Vercel" / OIDC — NOT this, unrelated, already ruled
 *     out by `lib/evidence/vercel.ts`'s own prior doc-comment ("AUTH,"
 *     `vca_`/`vcr_` token prefixes) — RE-CONFIRMED independently this
 *     session** via the full-corpus grep: its own token-exchange endpoint
 *     issues `{access_token: "vca_...", refresh_token, expires_in,
 *     token_type: 'bearer'}` over a `grant_type: authorization_code |
 *     refresh_token` shape and a `cookieStore`-based session pattern for an
 *     END USER signing into a THIRD PARTY's own app "with Vercel" — a
 *     completely different response shape, a completely different
 *     credential (bound to whichever human is signing in, not to this
 *     connector's own workspace-level grant), and NOT a REST API credential
 *     at all (confirmed already, unchanged by this task).
 *
 * (2) ENDPOINTS — CONFIRMED verbatim:
 *   - **Authorize** (the "External installation flow" — "When you're
 *     initiating the installation from your application," exactly this
 *     connect button's own case, as opposed to a user browsing Vercel's OWN
 *     marketplace UI — see "(4) STATE TRANSPORT" below for why this
 *     distinction matters): "Use this URL to start the process:
 *     `https://vercel.com/integrations/:slug/new` - `:slug` is the name you
 *     added in the Create Integration form" — `submit-integration.md`,
 *     "External installation flow". CORRECTS a plausible guess this task's
 *     own brief anticipated verifying (a shared host+`client_id` param URL,
 *     Railway/Cloudflare's own shape) — Vercel, like Sentry's own
 *     `external-install/` URL, is instead a PER-INTEGRATION URL PATH keyed
 *     by slug, needing a THIRD env var (see "(6) SCOPES + REGISTRATION"
 *     below) exactly like Sentry's `SENTRY_OAUTH_INTEGRATION_SLUG`
 *     precedent. Confirmed query params accepted on THIS specific URL: only
 *     `state` (see "(4)" below) — no worked example anywhere shows
 *     `client_id`/`redirect_uri`/`scope` as accepted input params here (the
 *     slug alone identifies which integration — and therefore which
 *     `redirect_uri`/scopes — is being installed; both are configured ONCE,
 *     server-side, at integration-creation time, not requested per-flow).
 *   - **Token exchange:** `POST https://api.vercel.com/v2/oauth/access_token`
 *     — CONFIRMED exactly as this task's brief anticipated —
 *     `vercel-api-integrations.md`. Body `application/x-www-form-urlencoded`
 *     with FOUR required fields, ALL confirmed verbatim from the doc's own
 *     table: `client_id`, `client_secret`, `code`, `redirect_uri`. **Auth
 *     method — a CONFIRMED, MATERIAL DIFFERENCE from Railway's/Cloudflare's
 *     `client_secret_basic`:** `client_id`/`client_secret` ride IN THE BODY
 *     (`client_secret_post`-shaped, RFC 6749 §2.3.1), NOT an `Authorization:
 *     Basic` header — the doc's own table lists both as request-BODY keys,
 *     with no Basic-auth mention anywhere on this page. This adapter's own
 *     `exchange()` sends exactly those four body fields and no
 *     `Authorization` header on the exchange call itself.
 *   - **Redirect URL query params** (what THIS adapter's `code`/
 *     `redirectUri`/`params` receive back, per the callback route's own
 *     generic forwarding — "External installation flow" table,
 *     `submit-integration.md`): `code`, `teamId`, `configurationId`, `next`,
 *     `state`, `source=external`. `next`/`configurationId`/`source` are
 *     read-but-unused by this adapter in v1 — see "(4)"/"(5)" below for why
 *     `state`/`teamId` are the only two that matter here, and DISCLOSED
 *     v1 SCOPE below for why `configurationId` (Vercel's own installation-
 *     tracking id, distinct from `sentryInstallationId`'s functional need —
 *     Sentry's refresh call NEEDS its installation id in the URL path;
 *     Vercel's exchange/verify calls need no equivalent id at all) is not
 *     persisted: nothing downstream reads it, and — unlike Sentry — there is
 *     no documented uninstall-webhook receiver for this connector yet
 *     (a documented, disclosed follow-up, exactly mirroring
 *     `sentry.ts`'s own pre-W3-T5 "not v1" framing for its uninstall
 *     webhook, before that shipped).
 *
 * (3) TOKEN LIFETIME — NO REFRESH, CONFIRMED BY EXPLICIT WORDING AND BY
 * ABSENCE. The doc's own words (bold exactly as in the source — only
 * "30 minutes"/"once" are emphasized there, not "long-lived"): "This
 * short-lived parameter is valid for **30 minutes** and can be exchanged
 * **once** for a long-lived access token" — `vercel-api-integrations.md`.
 * Neither `refresh_token` NOR `expires_in` (nor any TTL number in prose) appears
 * ANYWHERE tied to this endpoint in the ENTIRE doc corpus (the full-corpus
 * grep above) — a genuine, confirmed-by-absence gap, the SAME "docs say
 * nothing, so build defensively rather than guess" doctrine
 * `cloudflare.ts`'s own "ACCESS TTL" section already establishes for this
 * codebase. What DOES bound a Vercel integration token's life, confirmed, is
 * INSTALLATION STATE, not a clock: "Each installation of your integration is
 * stored and tracked as a configuration." FIX ROUND (review Finding 3 —
 * the sequencing below was inverted in the first pass; corrected):
 * disablement is IMMEDIATE, not delayed 30 days — "If an owner(s) of an
 * integration leaves the team… the integration will be flagged as
 * disabled[; t]he team will receive an email to take action (transfer
 * ownership) within 30 days, otherwise the integration will be deleted,"
 * and separately, "When integration configurations are disabled: Any API
 * requests will fail with a `403` HTTP status code and a `code` of
 * `integration_configuration_disabled`" — both `vercel-api-integrations.md`.
 * The 403s begin the moment the owner leaves (disablement is immediate);
 * the 30-day window is the DEADLINE before the more severe, separate
 * outcome — permanent deletion — not a delay before the 403s start. A
 * plain 403 is ALREADY `lib/evidence/vercel.ts`'s own `unauthorized`
 * degradation (unchanged by this task) — no new mapping needed for this
 * event to surface legibly, regardless of the corrected timeline.
 *
 * **`refresh()` below is therefore a DOCUMENTED, DELIBERATE NO-OP that
 * always REJECTS** — never a network call, never a crash. This is safe
 * specifically BECAUSE `expiresAt` (below) is stamped to a fixed far-future
 * sentinel: `core.ts`'s `needsRefresh()` will not treat this envelope as
 * needing a refresh under any normal clock, so `refresh()` is not expected
 * to ever actually run in practice — but IF it somehow did (a future bug, an
 * administrative forced-refresh, clock skew), `core.ts`'s own
 * `resolveProviderAuth` contract (its own doc-comment: "NEVER throws… a
 * caller… treats `{ok:false, reason:'unauthorized'}` exactly like today's
 * 'the provider rejected the credential' case") already degrades a rejecting
 * `refresh()` to `unauthorized` — proven GENERICALLY by `core.test.ts`'s own
 * fake-adapter coverage (`"degrades to unauthorized (never throws) when the
 * adapter's refresh() rejects"`), so this adapter needs no bespoke handling
 * beyond the clean, immediate reject itself. This is exactly the task's own
 * framing: "a documented no-op/unsupported that never breaks
 * resolveProviderAuth."
 *
 * `expiresAt`: the {@link OauthEnvelope}/`OauthCredential` shape is FROZEN
 * (`@agentrail/db-postgres`'s `parseSecretEnvelope`/`serializeOauthEnvelope`
 * — `expiresAt: string`, REQUIRED, no "absent" representation exists) — this
 * adapter stamps {@link VERCEL_OAUTH_ENVELOPE_EXPIRES_AT_SENTINEL}, a FIXED,
 * clearly-a-sentinel far-future ISO date, rather than computing
 * `Date.now() + <N years>` (which would imply a false precision about a
 * duration nothing documents). "Far-future," per the task's own framing —
 * chosen over inventing a numeric TTL this adapter has zero grounds to
 * assert.
 *
 * (4) STATE TRANSPORT — CONFIRMED to round-trip, but ONLY for the flow this
 * adapter actually uses. `submit-integration.md` documents THREE distinct
 * installation flows, each with its OWN query-param table on the redirect
 * back to us:
 *   - **"External installation flow"** (ours — "When you're initiating the
 *     installation from your application"): `state` IS listed — "Random
 *     string to be passed back upon completion. It is used to protect
 *     against CSRF attacks." CONFIRMED.
 *   - **"Marketplace installation flow"** (installs started from Vercel's
 *     OWN `/integrations` browse page) and **"Deploy button installation
 *     flow"**: `state` is ABSENT from both of these flows' own query-param
 *     tables.
 * `stateTransport: "param"` (declared explicitly below, mirroring
 * `railway.ts`'s/`cloudflare.ts`'s own explicitness) is therefore correct —
 * this connect button ALWAYS drives the external flow (the link route always
 * sends the user to `authorizeUrl()`'s own `/integrations/:slug/new` URL,
 * never to Vercel's marketplace page). **DISCLOSED, V1-SCOPED LIMITATION:**
 * per "(6)" below, this integration stays at Vercel's default "Community"
 * (unlisted) badge in v1 — structurally UNREACHABLE via the marketplace-flow
 * path, since an unlisted integration "do **not** appear in the marketplace"
 * (`create-integration.md`) at all. IF this integration is ever submitted
 * for, and granted, full public marketplace listing (a distinct, optional,
 * future decision — see "(6)"), a state-less marketplace-flow install
 * becomes POSSIBLE and this route's `"param"`-transport requirement (`state`
 * required right after `code`, per the callback route's own "ORDER OF
 * CHECKS" step 3) would reject it — a real, disclosed follow-up
 * consideration for that FUTURE decision, structurally identical in spirit
 * to Sentry's own `"session"`-transport fallback, not a v1 gap.
 *
 * (5) TEAM SCOPING + TEAM ID THREADING — CONFIRMED: "The response of your
 * `code` exchange request includes a `team_id` property. If `team_id` is not
 * null, you know that this integration was installed on a team… append the
 * `teamId` query parameter to each API request" — `vercel-api-integrations.md`
 * ("Interacting with Teams"). This is EXACTLY `lib/evidence/vercel.ts`'s own
 * pre-existing `config.vercelTeamId`/`appendTeamId` shape (Task P7,
 * unmodified by this task) — a team-scoped install's token only works
 * against that team's own resources, so `vercelTeamId` MUST agree with
 * whichever team (if any) the OAuth grant actually bound to.
 *
 * **THREADING (mirrors `sentry.ts`'s own "INSTALLATION ID THREADING"
 * precedent exactly, adapted for a provider with NO real refresh token to
 * also carry):** `postExchange` (`types.ts`) receives only `{envelope,
 * config}` — no raw exchange-response fields, no `ExchangeInput.params`. The
 * ONLY way to get `team_id` from `exchange()` (which sees the real response)
 * to `postExchange` (which runs moments later, after `types.ts`'s own
 * interface is done) is the envelope itself — and `access`/`expiresAt` are
 * both read/used verbatim elsewhere in `core.ts`, leaving `refresh` as the
 * one field this file fully owns and nothing else inspects the CONTENTS of
 * (only its presence-as-a-string, `parseSecretEnvelope`'s own contract).
 * `refresh` is therefore stamped `JSON.stringify({teamId: string | null})`
 * — NOT a real refresh token (there is none, per "(3)" above) but a small,
 * opaque, self-describing payload `postExchange` decodes
 * ({@link decodeRefreshField}). Safe specifically because `refresh()` above
 * NEVER reads or interprets this field's contents (it rejects
 * unconditionally, regardless of what `envelope.refresh` holds) — unlike
 * Sentry's OWN encoding, which a LATER `refresh()` call must successfully
 * decode to keep working.
 *
 * `team_id` is read DEFENSIVELY from the exchange RESPONSE body first (the
 * token's own self-description — the more authoritative of two redundant
 * sources, mirrors `lib/evidence/vercel.ts`'s own "the more modern/canonical
 * field wins" doctrine for `readyState`-over-`state`/`createdAt`-over-
 * `created`), falling back to the REDIRECT's own `teamId` query param
 * (`ExchangeInput.params.teamId` — confirmed present on the SAME "External
 * installation flow" table cited in "(4)") only if the response is missing
 * it — belt-and-braces, since the exact response JSON shape for this
 * endpoint is NOT confirmed by any worked example anywhere (see "(3)"'s own
 * "confirmed by absence" framing — the SAME gap applies to this field's
 * exact response key, though the prose explicitly names it `team_id`,
 * snake_case, unlike `access_token` which the doc never shows in a response
 * example at all and is inferred from RFC 6749/the request table's own
 * snake_case convention).
 *
 * `postExchange` uses the decoded `teamId` for exactly ONE thing — an
 * AUTO-FILL, mirroring `railway.ts`'s own case-(b) (`configPatch` when
 * unset), but requiring ZERO extra network calls (unlike Railway's
 * `externalWorkspaces` verification query): when `config.vercelTeamId` is
 * unset/empty AND the grant turned out to be team-scoped,
 * `configPatch: {vercelTeamId: teamId}`; otherwise `{ok:true}`, no patch.
 * **DISCLOSED: NO mismatch-verification gate** (unlike Railway's
 * fail-closed `project_not_granted` when `railwayProjectId` is configured
 * but NOT in the OAuth grant's own resource set) — deliberately, for reasons
 * mirroring `cloudflare.ts`'s own "NO postExchange" reasoning #3 rather than
 * Railway's own gap: (a) Vercel's grant is not RESOURCE-scoped the way
 * Railway's `project:viewer` is — there is no "pick which project(s) to
 * share" step on Vercel's own consent screen at all, only team-vs-personal
 * scope selection, so there is no enumerable "granted project set" to
 * reconcile `vercelProjectId` against the way Railway's `externalWorkspaces`
 * query enumerates granted PROJECTS specifically; (b) a team-mismatch (an
 * already-configured `vercelTeamId` that disagrees with the newly-granted
 * scope) is NOT a silent-wrong-data risk the way Railway's was — Vercel's
 * own troubleshooting prose for this exact shape is explicit that a
 * `teamId` the token isn't actually scoped to fails LOUDLY — under its own
 * "403 Forbidden responses" heading: "Ensure you are not missing the
 * `teamId` query parameter… Ensure the Scope of Your Access Token is
 * properly set" — `vercel-api-integrations.md`; `lib/evidence/vercel.ts`'s
 * own `vercelGet` already maps every 401/403 to `unauthorized` (Task P7, unmodified) — a
 * PRE-EXISTING, ONGOING, per-call safety net, not a connect-time-only one,
 * the same decisive point `cloudflare.ts`'s own doc-comment makes for its
 * own equivalent decision.
 *
 * (6) REVIEW / APPROVAL GATE — GENUINELY AMBIGUOUS, NOT settled either
 * direction. FIX ROUND (independent review, `.superpowers/sdd/
 * review-W3T9.md`, Finding 1): the first pass here quoted only the
 * favorable half of `create-integration.md` and stamped "VERIFIED
 * SELF-SERVE" as flat fact — the SAME page contains directly conflicting
 * language, never previously quoted or addressed. Both passages below are
 * real, both are about the connectable-account path specifically, and
 * they are not reconciled by anything else fetched.
 *
 * FAVORABLE (the "After integration creation" → "Connectable account
 * integrations" section — more specific, reads like the actual
 * post-creation state): "Once you have created your connectable account
 * integration, it will be assigned the **Community** badge and be
 * available for external users to download. You can share it with users
 * either through your site…" — `create-integration.md`.
 *
 * CONFLICTING (the SAME page's own top-level numbered overview, step 3 —
 * its own qualifier, "if it's a connectable account integration," ties
 * this to exactly this integration type, not just native integrations,
 * which are steps 4-5): "Once your integration is approved, you can share
 * it for users to install if it's a connectable account integration" — and,
 * of the very form this task's own env-var comments tell an owner to
 * submit: "The Create Integration form must be completed in full before
 * you can submit your integration for review" — both `create-integration.md`.
 *
 * WHAT THIS DOES AND DOES NOT RESOLVE: `approval-checklist.md`'s own
 * connectable-account checklist (independently confirmed) is entirely
 * about marketplace LISTING polish (image cropping, install-wizard UX,
 * "Examples: MongoDB Atlas, Sanity") — real, and unambiguously about the
 * SEPARATE 500-install public-listing step below, but it does NOT touch
 * the CREATION-time question the conflicting passage above raises, either
 * way. Whether "approved"/"submit… for review" there means (a) a real gate
 * blocking even the integration CREATOR's own first install attempt at
 * `/integrations/:slug/new`, (b) a gate on sharing the link with OTHERS
 * specifically while the creator can self-install regardless, or (c) stale
 * boilerplate the more specific "After integration creation" section
 * supersedes, is NOT determinable from the docs fetched — this adapter's
 * own evidence does not cleanly distinguish those readings (the favorable
 * quote's own wording, "available for **external** users to download,"
 * sits awkwardly with reading (b) specifically, so that narrower split is
 * NOT assumed here either).
 *
 * THE ONE REMAINING UNTESTED SEAM (disclosed, not resolved by this task):
 * the FIRST live connect attempt, after an owner registers the integration
 * and sets the three env vars below, is the actual test. If it fails on
 * the very first try, "still pending Vercel's own approval, wait and
 * retry" is a live possibility, not necessarily a misconfiguration or a
 * rejected credential — this file does not, and cannot, distinguish that
 * case from an ordinary `exchange_failed`/`unauthorized` today. No
 * operator-facing copy anywhere in this codebase should promise "no
 * waiting" until a real connect attempt settles this.
 *
 * WHAT IS STILL SETTLED, either way: public marketplace LISTING
 * (discoverability on Vercel's own `/integrations` browse page) is a
 * SEPARATE, OPTIONAL, LATER step, gated by manual review only after 500+
 * active installations: "The integration must have at least 500 active
 * installations… email integrations@vercel.com with your request to be
 * reviewed for listing" — `create-integration.md`; independently
 * re-confirmed by `approval-checklist.md`'s own "Complete the relevant
 * checklist, then email integrations@vercel.com with your request to be
 * reviewed." This is unambiguously about LISTING, never about functional
 * OAuth/API access, and this connector never intends to pursue it
 * (AgentRail's own connect button links directly to the external-install
 * URL, exactly like Sentry's own direct external-install link) — so the
 * 500-install threshold is confirmed irrelevant here regardless of how
 * the creation-time question above eventually resolves.
 *
 * SCOPES (registration-time picker, NOT a per-authorize-request param — see
 * "(2)" above): CONFIRMED table of selectable API Scopes,
 * `vercel-api-integrations.md` ("Scopes") — this adapter's own THREE calls
 * (`lib/evidence/vercel.ts`'s `/v2/user`, `/v9/projects/{id}`,
 * `/v7/deployments`, `/v3/deployments/{id}/events`) need exactly THREE, each
 * at **Read** (never Read/Write — this connector is read-only, mirrors every
 * sibling observability adapter's own least-privilege framing): `user`
 * ("Get information about the current user"), `project` ("Access project
 * details and settings"), `deployment` ("Interact with deployments"). No
 * `team` scope is needed — using the `teamId` QUERY PARAMETER on an
 * already-scoped call is confirmed to need only the resource's own read
 * scope (the docs' own 403-troubleshooting text points at "the teamId query
 * parameter"/"the Scope of your Access Token," never a missing `team` API
 * scope specifically) — this is a v1, disclosed minimal-scope choice; the
 * owner registration steps (spec doc, "Owner registration steps") name all
 * three explicitly so a registering owner doesn't over-grant.
 *
 * PKCE — NOT USED. No worked example anywhere shows a `code_challenge`/
 * `code_verifier` field on EITHER the authorize URL's own accepted params
 * ("(2)" above — `state` is the only confirmed one) or the token-exchange
 * body's own four confirmed fields — a confidential-client,
 * client-id/secret-authenticated exchange with no PKCE concept, exactly
 * mirroring `sentry.ts`'s own "PKCE — NOT USED" finding.
 * `AuthorizeUrlInput.codeChallenge`/`ExchangeInput.codeVerifier` are both
 * ignored by this adapter, same as Sentry's.
 *
 * CREDENTIAL PRESENTATION — unchanged from every other provider:
 * `Authorization: Bearer <token>` (this is what `lib/evidence/vercel.ts`'s
 * own `vercelHeaders` already sends today over a token-paste secret, and
 * continues to send byte-identically after this task's
 * `resolveProviderAuth` switch — see that file's own doc-comment update).
 *
 * REQUEST HYGIENE mirrors every sibling: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`. The response body is never
 * echoed into a thrown error message (same caution as every sibling
 * adapter's own `requestToken`/`requestAuthorization`).
 */

const VERCEL_OAUTH_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";
const VERCEL_OAUTH_TIMEOUT_MS = 8000;

/** See this module's own doc-comment, "TOKEN LIFETIME" — a fixed, clearly-a-
 * sentinel far-future ISO date, never computed from an asserted TTL nothing
 * documents. `core.ts`'s `needsRefresh()` will not treat an envelope stamped
 * with this value as due for refresh under any realistic clock. */
const VERCEL_OAUTH_ENVELOPE_EXPIRES_AT_SENTINEL = "2099-12-31T23:59:59.000Z";

/** The THIRD env var this provider needs beyond the generic `oauthConfigFor`
 * pair — the integration's own URL Slug, needed to build the
 * per-integration authorize URL (`https://vercel.com/integrations/<slug>/new`
 * — see this module's own doc-comment, "(2) ENDPOINTS"). Mirrors
 * `sentry.ts`'s identical `SENTRY_OAUTH_INTEGRATION_SLUG_ENV_KEY` shape —
 * shared by `requireVercelIntegrationSlug`, `envReady()`, and
 * `extraEnvKeys()` below (W3-T8 convention) so the literal key name lives in
 * exactly one place. */
const VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY = "VERCEL_OAUTH_INTEGRATION_SLUG";

/** Reads vercel's client id/secret (the two vars `oauthConfigFor` already
 * knows how to gate generically). Both routes that call into this adapter
 * gate on `oauthConfigFor` themselves first (mirrors every sibling adapter's
 * identical defense-in-depth reasoning) — this is a second, redundant check
 * for a direct caller (this module's own tests included). */
function requireVercelOauthConfig(): { clientId: string; clientSecret: string } {
  const config = oauthConfigFor("vercel");
  if (!config) {
    throw new Error(
      "vercel OAuth is not configured (VERCEL_OAUTH_CLIENT_ID/VERCEL_OAUTH_CLIENT_SECRET unset)"
    );
  }
  return config;
}

/** Reads the THIRD env var this provider needs — see
 * {@link VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY}'s own doc-comment. */
function requireVercelIntegrationSlug(): string {
  const slug = process.env[VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY];
  if (!slug) {
    throw new Error(`vercel OAuth is not configured (${VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY} unset)`);
  }
  return slug;
}

interface VercelRefreshField {
  teamId: string | null;
}

/** See this module's own doc-comment ("(5) TEAM SCOPING + TEAM ID
 * THREADING"). */
function encodeRefreshField(teamId: string | null): string {
  return JSON.stringify({ teamId });
}

/** Never trusts the shape — throws on anything that isn't `{teamId: string |
 * null}` (the `teamId` KEY must be present; its VALUE legitimately may be
 * `null` — a personal-scope install). Should only ever fail on a bug in this
 * file's own encoding, since nothing else ever writes to an OAuth envelope's
 * `refresh` field for the `"vercel"` provider — mirrors `sentry.ts`'s
 * identical `decodeRefreshField` "internal-bug signal, not a vendor
 * rejection" framing. */
function decodeRefreshField(refreshField: string): VercelRefreshField {
  let parsed: unknown;
  try {
    parsed = JSON.parse(refreshField);
  } catch {
    throw new Error("vercel oauth envelope's refresh field is not the expected compound JSON shape");
  }
  if (!parsed || typeof parsed !== "object" || !("teamId" in parsed)) {
    throw new Error("vercel oauth envelope's refresh field is missing teamId");
  }
  const teamIdRaw = (parsed as Record<string, unknown>).teamId;
  return { teamId: typeof teamIdRaw === "string" && teamIdRaw ? teamIdRaw : null };
}

function vercelTokenHeaders(): HeadersInit {
  return {
    // client_secret_post-shaped (client_id/client_secret ride in the BODY,
    // not a Basic header) — see this module's own doc-comment, "(2)
    // ENDPOINTS," for the confirmed citation. A MATERIAL difference from
    // railway.ts's/cloudflare.ts's own client_secret_basic.
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "agentrail-console",
  };
}

interface VercelTokenResponse {
  access_token?: unknown;
  /** Confirmed present in prose ("Interacting with Teams"), but no worked
   * JSON example anywhere confirms this exact key spelling — read
   * defensively, with `ExchangeInput.params.teamId` (the redirect's own
   * query param, also confirmed) as a fallback. See this module's own
   * doc-comment, "(5)". */
  team_id?: unknown;
}

export const vercelOauthAdapter: OauthProviderAdapter = {
  provider: "vercel",
  // Explicit (mirrors railway.ts's/cloudflare.ts's own explicitness, even
  // though "param" is the interface's own default when absent) — see this
  // module's own doc-comment, "(4) STATE TRANSPORT," for the confirmed
  // citation AND the disclosed v1-scoped caveat (would need reconsideration
  // if this integration is ever promoted to full public marketplace
  // listing — not a v1 concern, since an unlisted "Community"-badge
  // integration is structurally unreachable via the state-less marketplace
  // flow).
  stateTransport: "param",

  // The third env var beyond the generic oauthConfigFor pair — see
  // VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY's own doc-comment. Read generically
  // by the connectors GET route's oauthReady derivation and the link route's
  // 409 env-gate, exactly like sentry.ts's/cloudflare.ts's identical
  // envReady().
  envReady(): boolean {
    return Boolean(process.env[VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY]);
  },

  // W3-T8 (owner-visible OAuth setup state) — the NAME of the same third env
  // var envReady above checks the PRESENCE of, so the connectors GET route's
  // oauthSetup.missingEnv can report it by name when absent. Mirrors
  // sentry.ts's/cloudflare.ts's identical extraEnvKeys(). See types.ts's own
  // extraEnvKeys doc-comment.
  extraEnvKeys(): string[] {
    return [VERCEL_OAUTH_INTEGRATION_SLUG_ENV_KEY];
  },

  /** Pure and synchronous per `OauthProviderAdapter`'s own contract — the
   * only I/O this does is `process.env` reads (via `oauthConfigFor`/
   * `requireVercelIntegrationSlug`), not network. `redirectUri` is
   * deliberately NOT embedded — see this module's own doc-comment, "(2)
   * ENDPOINTS": Vercel's authorize URL is a per-integration, slug-keyed path
   * with no confirmed accepted query params beyond `state`; the redirect
   * target is a single, statically pre-registered value on the integration
   * itself (still SENT dynamically at exchange time, in `exchange()` below,
   * where the doc confirms it as a required body field). PKCE fields are
   * ignored — see "PKCE — NOT USED" above. `requireVercelOauthConfig()` is
   * called for its defensive validation even though the URL itself never
   * embeds the client id — mirrors `sentry.ts`'s identical
   * validate-but-unused pattern. */
  authorizeUrl({ state }: AuthorizeUrlInput): string {
    requireVercelOauthConfig();
    const slug = requireVercelIntegrationSlug();
    const url = new URL(`https://vercel.com/integrations/${encodeURIComponent(slug)}/new`);
    url.searchParams.set("state", state);
    return url.toString();
  },

  /** `params.teamId` (from the redirect, confirmed present on the External
   * installation flow — see "(4)"/"(5)" above) is read as a DEFENSIVE
   * FALLBACK for `team_id`, used only if the exchange response itself omits
   * it. `configurationId`/`next`/`source` are available via `params` but
   * deliberately unused in v1 — see this module's own doc-comment, "(2)
   * ENDPOINTS," for why. */
  async exchange({ code, redirectUri, params }: ExchangeInput): Promise<OauthEnvelope> {
    const { clientId, clientSecret } = requireVercelOauthConfig();

    const res = await fetch(VERCEL_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: vercelTokenHeaders(),
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(VERCEL_OAUTH_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Never echoes the response body — same discipline as every sibling
      // adapter's own requestToken/requestAuthorization.
      throw new Error(`vercel oauth token endpoint returned HTTP ${res.status}`);
    }

    const body = (await res.json().catch(() => null)) as VercelTokenResponse | null;
    const accessToken = typeof body?.access_token === "string" && body.access_token ? body.access_token : null;
    if (!accessToken) {
      throw new Error("vercel oauth token endpoint returned an unexpected response shape");
    }

    const responseTeamId = typeof body?.team_id === "string" && body.team_id ? body.team_id : null;
    const redirectTeamId = typeof params["teamId"] === "string" && params["teamId"] ? params["teamId"] : null;
    const teamId = responseTeamId ?? redirectTeamId;

    return {
      access: accessToken,
      refresh: encodeRefreshField(teamId),
      expiresAt: VERCEL_OAUTH_ENVELOPE_EXPIRES_AT_SENTINEL,
    };
  },

  /** ALWAYS rejects — see this module's own doc-comment, "(3) TOKEN
   * LIFETIME," for the full, confirmed-by-explicit-wording-and-by-absence
   * reasoning: Vercel's own docs describe this as a "long-lived access
   * token" with no `refresh_token`/`expires_in` documented anywhere for this
   * endpoint. Never inspects `envelope.refresh`'s contents (unlike
   * `sentry.ts`'s own `refresh()`, which MUST decode its compound field to
   * keep working) — this is a clean, immediate, documented no-op, not a
   * network call that could hang or leak a vendor response body. */
  async refresh(_envelope: OauthEnvelope): Promise<OauthEnvelope> {
    throw new Error(
      "vercel oauth access tokens are long-lived with no documented refresh mechanism (confirmed by explicit " +
        "wording and by the total absence of a refresh_token/expires_in field anywhere in Vercel's own docs for " +
        "this endpoint) — resolveProviderAuth (core.ts) degrades this rejection to 'unauthorized', prompting an " +
        "operator reconnect, exactly like a vendor-rejected refresh on any other provider"
    );
  },

  /** See this module's own doc-comment, "(5) TEAM SCOPING + TEAM ID
   * THREADING," for the full auto-fill contract and the disclosed reasoning
   * for why this does NOT also fail-closed on a team mismatch the way
   * `railway.ts`'s own `postExchange` does for an out-of-grant project. */
  async postExchange({ envelope, config }: PostExchangeInput): Promise<PostExchangeResult> {
    const { teamId } = decodeRefreshField(envelope.refresh);

    const configuredRaw = config["vercelTeamId"];
    const configuredTeamId = typeof configuredRaw === "string" && configuredRaw.trim() ? configuredRaw.trim() : null;

    if (!configuredTeamId && teamId) {
      return { ok: true, configPatch: { vercelTeamId: teamId } };
    }
    return { ok: true };
  },
};

registerOauthAdapter(vercelOauthAdapter);
