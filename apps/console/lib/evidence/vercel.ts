import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `vercel` evidence adapter (Task P7, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The sixth Wave-2 provider —
 * `verbs: ["changes", "search_events"]`: `changes` lists deployments in the
 * window; `search_events` searches those deployments' build/runtime events.
 * The closest sibling template is `railway.ts` (also `changes` +
 * `search_events` over "deployments" as the unit of change, also needs the
 * "serving-at-window-start" candidate-widening rule for `search_events` —
 * cited below); URL-param-only request construction (no DSL) follows
 * `grafana.ts`'s freshest precedent.
 *
 * CREDENTIAL: a SINGLE secret (no `secretParts`, like sentry/prometheus/
 * grafana above) — a Vercel Access Token, sent as `Authorization: Bearer
 * <token>` on every call. This adapter uses its `secret` parameter
 * directly, same shape as every prior single-secret provider.
 *
 * VERCEL REST API SHAPES — confirmed against Vercel's own docs during
 * implementation (this task's mandatory first step; NOT trusted from
 * memory; every URL below was fetched live, dated 2026-07-30 unless noted):
 *
 *   - AUTH: `Authorization: Bearer <token>` — confirmed
 *     (vercel.com/docs/rest-api/authentication; restated on every
 *     individual endpoint page as "Authentication: bearerToken: HTTP
 *     bearer"). TOKEN FORMAT (Fix Round 1 correction — the initial
 *     submission's "no documented prefix" claim was STALE, caught in
 *     review): Vercel's Feb 9 2026 changelog
 *     (vercel.com/changelog/new-token-formats-and-secret-scanning,
 *     "Introducing new token formats and secret scanning") DOES now
 *     document prefixed formats per credential type — `vcp_` (personal
 *     access tokens), `vci_` (integration tokens), `vca_`/`vcr_` (the
 *     SEPARATE "Sign in with Vercel" OAuth app access/refresh tokens — see
 *     below), `vck_` (API keys, e.g. AI Gateway) — introduced specifically
 *     so GitHub's secret-scanning partner program could fingerprint them;
 *     GitHub's own March 2026 changelog confirms it added live detectors
 *     for these Vercel prefixes that same month (a real, current risk this
 *     module's own test fixtures must not accidentally match — see below).
 *     CRITICALLY, per that same changelog and independently corroborated by
 *     GitGuardian's own detector documentation for the classic "Vercel API
 *     Access Token" (explicitly flagged `Prefixed: False` in GitGuardian's
 *     own detector metadata): the LEGACY, UNPREFIXED personal/team Access
 *     Token shape — created at Settings → Tokens, the credential type THIS
 *     connector's catalog entry asks the workspace operator to paste —
 *     REMAINS VALID alongside the new `vcp_`-prefixed one; Vercel did not
 *     retire or reissue existing tokens. The format gate
 *     (`connector-helpers.ts`'s `case "vercel"`) therefore stays
 *     shape-agnostic DELIBERATELY, not from an absence of documentation:
 *     tightening it to require `vcp_` would reject every legacy,
 *     still-valid, unprefixed token a workspace may already hold (or create
 *     via an older CLI/dashboard flow) — mirrors `prometheus.ts`'s identical
 *     "no single confirmed shape to gate on" precedent (non-empty, no
 *     embedded whitespace, ≤512 chars — a bound wide enough for either
 *     generation); real security lives at Gate 2 (live verify), unaffected.
 *     Do NOT confuse `vca_`/`vcr_` with this connector's credential at all
 *     — "Sign in with Vercel" (vercel.com/docs/sign-in-with-vercel/tokens)
 *     is a DIFFERENT, unrelated OAuth feature whose Access/Refresh Tokens
 *     are issued to a third-party app's END USERS who sign in "with
 *     Vercel"; they are structurally NOT a REST API credential and would
 *     not even work as one.
 *   - VERIFY (token leg): `GET /v2/user` — CONFIRMED, current, unchanged
 *     from this task's believed shape
 *     (vercel.com/docs/rest-api/reference/endpoints/user/get-the-user).
 *     Response `{ user: { id, ... } }` (full form) OR
 *     `{ user: { limited: true, id, ... } }` (reduced-privilege form) —
 *     BOTH forms carry `id`. No query params documented on this endpoint
 *     (no `teamId` — it always resolves the token's own bound principal).
 *   - VERIFY (project leg, `verify.ts`'s own concern — see that module's
 *     doc-comment): `GET /v9/projects/{idOrName}` — CONFIRMED, current
 *     (vercel.com/docs/rest-api/reference/endpoints/projects/
 *     find-a-project-by-id-or-name). `teamId`/`slug` query params
 *     confirmed. 200 response confirmed to include `id`.
 *   - CHANGES — deployments listing: `GET /v7/deployments` — a REAL,
 *     DOC-CONFIRMED CORRECTION from this task's own believed `/v6/`
 *     (vercel.com/docs/rest-api/reference/endpoints/deployments/
 *     list-deployments, fetched live) — exactly the "docs govern over
 *     believed shapes" doctrine the Global Constraints call out (the T6/T7
 *     lesson, now repeated for this task). Confirmed query params:
 *     `projectId`, `teamId`, `slug`, `limit`, and — genuinely redundant —
 *     TWO window-param pairs: `from`/`to` (listed inline among an
 *     otherwise-alphabetical param block: app, from, limit, projectId,
 *     projectIds, target, to, users) and `since`/`until` (appended AFTER
 *     that alphabetical block, out of order — evidence of a later
 *     addition). This adapter uses `since`/`until` as canonical: it is the
 *     ONLY window-param pair the deployment-events endpoint below ALSO
 *     supports (that endpoint has no `from`/`to` equivalent at all) —
 *     cross-endpoint consistency, a disclosed judgment call, not a second
 *     doc citation. Confirmed response fields: `uid` (NOT `id` — the
 *     deployment identifier), `readyState` (in the object's own REQUIRED
 *     field list; enum BLOCKED/BUILDING/CANCELED/DELETED/ERROR/
 *     INITIALIZING/QUEUED/READY) vs. a near-duplicate `state` (same enum,
 *     NOT in the required list) — `readyState` is used as the canonical
 *     `state=` render value (the one Vercel's own schema marks required);
 *     `state` is a defensive fallback only. `createdAt` (REQUIRED, number)
 *     vs. a near-duplicate `created` (ALSO required, number) — `createdAt`
 *     used as canonical (mirrors the same "the more modern name is
 *     required, use it" reasoning as readyState-over-state), `created` a
 *     defensive fallback. Both are confirmed epoch MILLISECONDS by
 *     cross-endpoint consistency: the User resource's OWN `createdAt` is
 *     explicitly documented as "UNIX timestamp (in milliseconds)"
 *     (vercel.com/docs/rest-api/reference/endpoints/user/get-the-user) —
 *     the SAME field name, same API, extrapolated as the same unit
 *     (disclosed inference, not independently re-confirmed for the
 *     deployments resource specifically). `meta` — confirmed present,
 *     "Metadata information from the Git provider," but with NO documented
 *     sub-schema on this endpoint (exactly `railway.ts`'s own `meta`
 *     situation for its `commitHash` field) — see "COMMIT META FIELDS"
 *     below.
 *   - SEARCH_EVENTS — deployment events: `GET
 *     /v3/deployments/{idOrUrl}/events` — CONFIRMED, path UNCHANGED from
 *     this task's believed shape (vercel.com/docs/rest-api/reference/
 *     endpoints/deployments/get-deployment-events). Confirmed FULL param
 *     list: `direction` (backward/forward, default forward — this adapter
 *     never sends it, since every result is re-sorted client-side
 *     regardless, per every sibling adapter's "never trust server
 *     ordering" doctrine), `follow` (live-stream mode — never set; this
 *     adapter always gets the `application/json`, non-streaming response
 *     shape), `limit`, `name` (a build ID, not used), `since`/`until`
 *     (confirmed: "Timestamp for when build logs should be pulled
 *     from"/"...up until" — time bounds, CONFIRMED to exist, answering this
 *     task's own mandatory-first-step question), `statusCode`, `delimiter`,
 *     `builds`, `teamId`, `slug`. CONFIRMED ABSENT: no type-filter query
 *     param of any kind, and no free-text query param either — answering
 *     this task's own anticipated "client-only by construction" framing for
 *     `q.query` (see "Q.QUERY" below). Response shape: CONFIRMED to be a
 *     genuine `oneOf` UNION across THREE real object shapes — NOT a clean
 *     flat triple like railway.ts's `{timestamp,message,severity}`. `type`
 *     (string enum: command/delimiter/deployment-state/
 *     edge-function-invocation/exit/fatal/metric/middleware/
 *     middleware-invocation/report/stderr/stdout, or `alias-assigned` for
 *     the third branch) is present at the top level in every branch.
 *     TIMESTAMP (Fix Round 1 correction — the initial submission read
 *     `created` only, silently dropping the third branch): the first two
 *     branches' own `required` lists both include `created` (number), but
 *     the THIRD branch — `alias-assigned` events, confirmed
 *     `required: [alias, aliasError, aliasWarning, date, deploymentId,
 *     type]` — has NO `created` field at all, only `date` (number). Read
 *     as `entry.created ?? entry.date` (see {@link eventTimestamp}) so an
 *     alias-assigned event (e.g. a deployment's alias being (re)pointed —
 *     a real, debugging-relevant occurrence) renders at its own `date`
 *     instead of being silently skipped; `type` already renders correctly
 *     for it via the existing generic `entry.type` read. An entry with
 *     NEITHER `created` NOR `date` is still skipped — now the ONLY
 *     remaining silent-skip case for a missing timestamp (a genuinely
 *     undocumented/malformed shape, not one of the three confirmed
 *     branches). `text` is OPTIONAL and appears in two different places
 *     depending on branch: top-level (`entry.text`, the flatter branch) or
 *     nested (`entry.payload.text`, the wrapped branch) — read defensively
 *     as `entry.text ?? entry.payload?.text ?? ""` (see {@link eventText});
 *     the `alias-assigned` branch carries neither, so it renders with an
 *     empty quoted text, same as any other text-less event kind
 *     (`delimiter`/`exit`).
 *     The TOP-LEVEL response array is ALSO confirmed `nullable: true` (a
 *     legitimate "no events" response can be a bare JSON `null`, not just
 *     `[]`) — this adapter's own `vercelGet` deliberately does NOT treat a
 *     null body as an error (unlike a stricter "malformed body" gate would)
 *     precisely because Vercel's OWN schema documents null as a valid,
 *     meaningful empty response for this endpoint specifically; each
 *     caller narrows with its own `Array.isArray` check instead (mirrors
 *     `grafana.ts`'s/`prometheus.ts`'s identical "malformed/absent 2xx body
 *     → zero elements, not an error" precedent, extended to cover a
 *     doc-confirmed null case rather than an unconfirmed one).
 *   - TEAM SCOPING: `teamId` query param CONFIRMED present on every
 *     endpoint this adapter calls (deployments-list, deployment-events, and
 *     — `verify.ts`'s own concern — get-project) — "The Team identifier to
 *     perform the request on behalf of." Sent whenever
 *     `config.vercelTeamId` is configured; omitted otherwise, falling back
 *     to the token's own personal/team-bound scope (a Vercel Access Token
 *     is itself scoped to either a personal account or one team at
 *     creation time) — see "TEAM SCOPING" in the per-function doc-comments
 *     below for where this is threaded through.
 *
 * RATE LIMITS (pin 7, closed out explicitly): CONFIRMED — Vercel documents
 * an extensive first-party rate-limit table (vercel.com/docs/limits,
 * "Rate limits" section), enforced via `X-RateLimit-Limit`/
 * `X-RateLimit-Remaining`/`X-RateLimit-Reset` response headers (this
 * adapter does not read or retry on them — a 429 falls through the same
 * generic non-2xx → `upstream_error` mapping as any other non-401/403
 * failure, matching every sibling adapter's precedent of not subdividing
 * further or retrying). Specific documented rows covering this adapter's
 * own calls: "Deployments retrieval per minute." = 500/min (`user` scope,
 * 2000/min on Enterprise) and "Deployments list per minute." = 1000/min
 * (`user` scope) — both cover the `/v7/deployments` calls `changes` and
 * `search_events` share; "User retrieval per minute." = 500/min (`owner`
 * scope) covers the `/v2/user` verify call. Searched specifically for a
 * distinctly-named row covering `/v3/deployments/{id}/events` and did NOT
 * find one in that table — disclosed honestly rather than assumed; this
 * adapter's own `SEARCH_EVENTS_MAX_DEPLOYMENTS`/`SEARCH_EVENTS_BATCH_SIZE`
 * bounds (below) keep its own worst-case burst small regardless (at most
 * 10 event-fetch calls per `search_events` invocation, 5 concurrent).
 *
 * COMMIT META FIELDS (`meta.commitSha`/`meta.commitMessage` sourced for
 * the pinned `commit={sha7|-} "{message-80|-}"` render slots — see
 * {@link commitInfoFromMeta}): NOT first-party-schema-documented on the
 * deployments-LIST endpoint (`meta` is an opaque object there, exactly
 * railway.ts's own `meta.commitHash` situation). TWO plausible key-naming
 * conventions exist in the wild, genuinely ambiguous from docs alone: (1)
 * provider-prefixed (`githubCommitSha`/`githubCommitMessage`/
 * `githubCommitRef`) — corroborated by MULTIPLE independent community
 * sources (Vercel CLI `--meta` flag discussions, a `vercel/vercel` GitHub
 * discussion on finding a deployment by commit SHA) describing exactly
 * this convention for a deployment's populated git metadata; (2) bare
 * (`commitSha`/`commitMessage`/`commitRef`) — this IS first-party-schema-
 * documented, but on a DIFFERENT endpoint and for a DIFFERENT direction
 * (Fix Round 1 correction — the initial submission mis-cited this as the
 * CREATE-deployment endpoint's `gitSource` object; it is actually a
 * SEPARATE sibling request field on that SAME endpoint, `gitMetadata`,
 * confirmed "Populates initial git metadata for different git providers,"
 * carrying exactly `commitAuthorName`/`commitAuthorEmail`/`commitMessage`/
 * `commitRef`/`commitSha`/`dirty`/`ci*` — `gitSource` itself, by contrast,
 * uses ENTIRELY DIFFERENT field names, `sha`/`ref` (it specifies WHICH
 * commit to deploy FROM, not metadata ABOUT one — a different concern; its
 * own required-field variants are keyed by `type`/`sha`/`ref`/`repoId`/
 * `org`/`repo`, no `commitSha`/`commitMessage` anywhere in it). This
 * correction, if anything, STRENGTHENS hypothesis (2) as a candidate: a
 * field literally named "populates git metadata" is a closer conceptual
 * match to this adapter's own read-side `meta` bag than a "which commit to
 * deploy" input ever was. vercel.com/docs/rest-api/reference/endpoints/
 * deployments/create-a-new-deployment — what a CALLER supplies when
 * creating a deployment, not what Vercel reports back on a LIST read, so
 * still not a DIRECT confirmation of the list endpoint's own `meta` shape).
 * Since either convention is plausible for the read-side `meta` bag and a
 * wrong guess here only ever degrades ONE line's commit columns to `-` (a
 * plain JSON object property read, unlike railway.ts's GraphQL field-name
 * risk, where a wrong guess could break the WHOLE query) — this adapter
 * checks BOTH conventions defensively, bare keys first (the one convention
 * that IS schema-documented somewhere in this API, even if not on this
 * exact endpoint), falling back through the three provider-prefixed
 * variants (github/gitlab/bitbucket), and finally `-`. A live token can
 * confirm the real key in a follow-up, exactly like railway.ts's own
 * disclosed "ENV FIELD" v1 gap invites for its unconfirmed field.
 *
 * SHARED CANDIDATE FETCH — a deliberate, disclosed STRUCTURAL DIVERGENCE
 * from railway.ts's identical-looking `fetchProjectDeployments` (railway's
 * own `deployments` query has NO documented window argument at all, so it
 * fetches its most-recent N deployments completely unfiltered by date);
 * Vercel's `/v7/deployments` DOES document `since`/`until`, so this
 * adapter's OWN `fetchProjectDeployments` uses ONE of them server-side —
 * `until=windowEnd` — while deliberately NOT ALSO sending `since=
 * windowStart`: `search_events` needs visibility into the single
 * deployment CREATED BEFORE windowStart that was still serving (and
 * logging) when the window opened (see "SEARCH_EVENTS CANDIDATE
 * SELECTION" below, cited from railway.ts's own Fix Round 1 FIX 1c) — a
 * `since=windowStart` bound would silently exclude that deployment from
 * this fetch entirely, before either verb's own client-side candidate
 * selection ever runs. `until=windowEnd` narrows the fetch to "at or
 * before the window closes" (server-side, per pin 1's "where the API
 * supports it") without that conflict; BOTH verbs still derive their own
 * candidate SELECTION from this one shared fetch CLIENT-SIDE (belt-and-
 * braces, unconditionally — pin 1's other half), mirroring railway.ts's
 * `changesCandidates`/`searchEventsCandidates` split exactly. Bounded by
 * {@link DEPLOYMENTS_FETCH_LIMIT} (a plain local number, not a documented
 * Vercel maximum) — same disclosed v1 limitation as railway.ts's identical
 * bound: a window whose matching deployments (or whose serving-at-start
 * deployment) are all older than the project's most recent
 * {@link DEPLOYMENTS_FETCH_LIMIT} as of windowEnd will under-report.
 *
 * SEARCH_EVENTS CANDIDATE SELECTION (cited verbatim from railway.ts's own
 * Fix Round 1, FIX 1c — the SAME rule, same reasoning, ported to Vercel's
 * field names): a deployment's `createdAt` is when it STARTED, not when it
 * stopped serving — a long-lived, still-running deployment created well
 * BEFORE `windowStart` was still emitting events throughout the whole
 * window, and a naive "deployments created within [windowStart,
 * windowEnd]" filter (correct for `changes`) silently EXCLUDES it for
 * `search_events`. Fixed identically: `search_events`'s candidate set is
 * `changesCandidates` (deployments created IN the window) PLUS the single
 * most recent deployment created AT OR BEFORE `windowStart` (deduped by
 * `uid`) — see {@link searchEventsCandidates}. `changes` is UNCHANGED
 * (`changesCandidates` alone).
 *
 * Q.QUERY (`search_events`): CONFIRMED to have NO server-side home on the
 * deployment-events endpoint (see "SEARCH_EVENTS" above — the FULL
 * documented param list has no free-text field) — this task's own
 * anticipated "client-only by construction" case, now confirmed rather
 * than assumed. Applied CLIENT-SIDE ONLY, as a substring match against
 * each candidate's own already-rendered line (mirrors `railway.ts`'s
 * identical "match the same text the caller receives" transparency
 * choice, since Vercel's own event `text` field — unlike Sentry's
 * `title`/Grafana's `text` — has no natural second competing field to
 * choose between rendering vs. matching).
 *
 * ESCAPING / NO DSL (pin 3): CONFIRMED — neither endpoint this adapter
 * calls (`/v7/deployments`, `/v3/deployments/{id}/events`) has ANY
 * free-text/query-language parameter; every value this adapter sends
 * (`projectId`, `teamId`, `since`, `until`, `limit`) is a plain id or
 * number, carried via `URLSearchParams` (automatic percent-encoding) —
 * structurally the Grafana case (this module's own freshest precedent for
 * "URL-param-only, nothing to escape by construction"). `q.query` never
 * rides server-side at all (see "Q.QUERY" above) and `q.scope` is not used
 * by this adapter (v1's pinned design has exactly one scope dimension —
 * the connected `vercelProjectId` project — with no second narrowing
 * dimension the task asks this adapter to expose) — so there is no
 * caller-supplied free text in any request URL this adapter builds AT ALL,
 * a stronger position than Grafana's own (which still threads `q.scope`
 * through `tags=`). Round-trip proof therefore reduces to: `q.query` never
 * appears in the request URL (`vercel.test.ts`), the same proof shape
 * `grafana.test.ts` uses for its own "no server-side home" parameters.
 *
 * WINDOW FILTERING: server-side where documented and non-conflicting (see
 * "SHARED CANDIDATE FETCH" above for `changes`/`search_events`'s shared
 * fetch; `since`/`until` on the PER-DEPLOYMENT events fetch, where there is
 * no serving-at-start conflict to avoid) AND client-side ALWAYS
 * (belt-and-braces, unqualified by verb) — every deployment's own
 * `createdAt`/`created` and every event's own `created` is re-checked
 * against `[windowStart, windowEnd]` regardless of what the server-side
 * params already did.
 *
 * FAILURE HANDLING mirrors `railway.ts`'s own split exactly (pinned
 * decision, restated per this task's own template pointer): the
 * SINGLE-SCOPE `fetchProjectDeployments` call (shared by both verbs) is
 * NOT wrapped in a try/catch of its own — a thrown fetch (network error,
 * or the 8s timeout firing) propagates uncaught to the ROUTE, which
 * already catches an adapter's thrown `query()` call and reports
 * `unreachable`. A clean, non-throwing 401/403 maps to `unauthorized`; a
 * clean 404 maps to `config_missing` (this task's own pinned adjudication
 * — see {@link vercelGet}'s own doc-comment, "notFoundReason," for the
 * full reasoning: a 404 on the operator-scoped deployments-LIST call can
 * only mean the configured `vercelProjectId` doesn't exist/isn't visible,
 * a connector configuration gap, not a rejected credential); any OTHER
 * non-2xx maps to `upstream_error` (this adapter does not further
 * subdivide into `unexpected_status`/`bad_body`, matching every sibling
 * adapter's own precedent). `search_events`'s PER-DEPLOYMENT
 * `fetchDeploymentEvents` sub-fetches DO each get their own try/catch and
 * a cap-exempt marker line (`(deployment {uid}: vercel {reason|
 * unreachable})`, rendered first) — mirrors `railway.ts`'s per-deployment
 * marker discipline exactly; a 404 THERE is NOT remapped to
 * `config_missing` (a specific, already-discovered deployment id 404ing is
 * a transient/upstream case, not an operator mistake — see
 * {@link vercelGet}'s own doc-comment for why this distinction is drawn at
 * the CALL SITE, not inside the shared helper).
 *
 * CONFIG_MISSING (mirrors every sibling adapter's identical reasoning): a
 * null `secret`, OR an absent `config.vercelProjectId`, both degrade to
 * `config_missing` — neither is the caller's fault, neither is a
 * credential Vercel itself REJECTED (that is `unauthorized`); only
 * reconnecting the workspace's Vercel connector fixes either.
 * `config.vercelTeamId` is OPTIONAL (a personal-account-scoped project has
 * none) — its absence never degrades anything; it is simply omitted from
 * every request when absent (personal scope, per "TEAM SCOPING" above).
 *
 * REQUEST HYGIENE mirrors every sibling: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`.
 */

const VERCEL_API = "https://api.vercel.com";
const VERCEL_FETCH_TIMEOUT_MS = 8000;

// How many of the project's most-recent-as-of-windowEnd deployments this
// adapter looks at as its own candidate set before further client-side
// window filtering — mirrors railway.ts's DEPLOYMENTS_FETCH_LIMIT in
// spirit (a plain local number, not a documented Vercel maximum). See the
// module doc-comment ("SHARED CANDIDATE FETCH") for the disclosed v1
// under-reporting limitation this bound accepts.
const DEPLOYMENTS_FETCH_LIMIT = 100;

const CHANGES_DEFAULT_LIMIT = 50;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;

// EXPLICIT PIN (this task's own brief): bounds how many of the in-window
// (+ serving-at-start) candidate deployments' events are fetched at all —
// mirrors railway.ts's own MAX_DEPLOYMENTS bound in spirit, but at the
// task's own pinned figure of 10 rather than railway's 20.
const SEARCH_EVENTS_MAX_DEPLOYMENTS = 10;
// How many events to request per deployment — generous enough that the
// client-side window/query filtering below has real material to work with.
const SEARCH_EVENTS_EVENTS_PER_DEPLOYMENT = 200;
// Bounds concurrent in-flight per-deployment events calls — mirrors
// railway.ts's SEARCH_EVENTS_BATCH_SIZE (same reasoning: without this, a
// window with SEARCH_EVENTS_MAX_DEPLOYMENTS candidates would fire that
// many concurrent requests in one burst).
const SEARCH_EVENTS_BATCH_SIZE = 5;

// Pinned render format: `commit={sha7|-}` — a short, 7-character SHA.
const COMMIT_SHA_LEN = 7;
// Pinned render format: `"{message-80|-}"` for a deployment's commit
// message.
const MESSAGE_MAX_LEN = 80;
// Pinned render format: `"{text-120}"` for a deployment event's text —
// mirrors every sibling adapter's identical "TITLES ARE UNTRUSTED TEXT"
// discipline (github.ts's own doc-comment) applied to free-text provider
// fields.
const TEXT_MAX_LEN = 120;

const NO_DEPLOYMENTS_MARKER = "(no deployments in window)";
const NO_MATCHING_LOGS_MARKER = "(no matching log lines)";

type AdapterResult = { ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason };

/** Mirrors `runner/evidence/route.ts`'s own `isValidIsoDate` (and every
 * sibling adapter's duplicate of it) exactly — never assumes the route
 * already validated the window first. */
function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** Collapse embedded newlines so a free-text field can never split a
 * rendered "one record per line" line in two — mirrors every sibling
 * adapter's identical helper. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/** Newline-collapse + truncate to {@link MESSAGE_MAX_LEN} — the pinned
 * "message-80" render slot for a deployment's commit message. */
function truncateMessage(value: string): string {
  const collapsed = singleLine(value);
  return collapsed.length > MESSAGE_MAX_LEN ? collapsed.slice(0, MESSAGE_MAX_LEN) : collapsed;
}

/** Newline-collapse + truncate to {@link TEXT_MAX_LEN} — the pinned
 * "text-120" render slot for a deployment event's text. */
function truncateText(value: string): string {
  const collapsed = singleLine(value);
  return collapsed.length > TEXT_MAX_LEN ? collapsed.slice(0, TEXT_MAX_LEN) : collapsed;
}

function vercelHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agentrail-console",
  };
}

/**
 * One GET, mapped to the pinned taxonomy. Deliberately NOT try/catch-wrapped
 * around the `fetch` call itself — see the module doc-comment ("FAILURE
 * HANDLING"). Deliberately does NOT reject a `null`/malformed JSON body as
 * an error (unlike a stricter generic gate would) — see the module
 * doc-comment ("SEARCH_EVENTS" / body shape) for why the deployment-events
 * endpoint's response is CONFIRMED nullable by Vercel's own schema; each
 * caller narrows `data` with its own shape check instead.
 *
 * `notFoundReason` (this task's own pinned adjudication, "404 project →
 * config_missing"): the deployments-LIST endpoint's own documented status
 * codes include 404 (confirmed — see the module doc-comment, "CHANGES —
 * deployments listing"), and a 404 there can ONLY mean the operator-
 * configured `projectId` doesn't exist or isn't visible to this token — a
 * connector CONFIGURATION gap (reconnecting with the right project id is
 * what fixes it), not a credential Vercel REJECTED (`unauthorized`) and not
 * a transient upstream problem (`upstream_error`) — mirrors
 * `config_missing`'s own definition (`types.ts`) precisely. Callers scoped
 * by an operator-supplied id ({@link fetchProjectDeployments}) pass
 * `"config_missing"` here; the per-deployment events fetch
 * ({@link fetchDeploymentEvents}) does NOT — a 404 there would mean a
 * specific, ALREADY-DISCOVERED deployment id vanished between the list
 * call and this one (a genuine transient/upstream case, not an operator
 * mistake), so it stays on the generic non-2xx → `upstream_error` path,
 * folded into that verb's existing per-candidate marker handling either
 * way.
 */
async function vercelGet(
  url: string,
  token: string,
  notFoundReason?: EvidenceDegradationReason
): Promise<{ ok: true; data: unknown } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await fetch(url, {
    headers: vercelHeaders(token),
    signal: AbortSignal.timeout(VERCEL_FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 404 && notFoundReason) {
    return { ok: false, reason: notFoundReason };
  }
  if (!res.ok) {
    return { ok: false, reason: "upstream_error" };
  }
  const data = await res.json().catch(() => null);
  return { ok: true, data };
}

/** Appends `teamId` when configured — every endpoint this adapter calls
 * documents this same param ("The Team identifier to perform the request
 * on behalf of") — see the module doc-comment ("TEAM SCOPING"). Omitted
 * entirely (not sent as an empty string) when absent, falling back to the
 * token's own personal/team-bound scope. */
function appendTeamId(params: URLSearchParams, teamId: string | undefined): void {
  if (teamId) params.set("teamId", teamId);
}

/** A trimmed, non-empty string, or `null` — used defensively for both the
 * deployments-list response's string fields and {@link commitInfoFromMeta}'s
 * candidate keys. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Defensive read of a deployment's commit sha/message off its loosely-typed
 * `meta` bag — see the module doc-comment ("COMMIT META FIELDS") for the
 * two-hypothesis reasoning (bare `commitSha`/`commitMessage`, checked
 * first, vs. the three provider-prefixed variants) and why a wrong guess
 * here only ever degrades this ONE line's two columns to `-`, never the
 * whole call. */
function commitInfoFromMeta(meta: unknown): { sha: string; message: string } {
  if (!meta || typeof meta !== "object") return { sha: "-", message: "-" };
  const m = meta as Record<string, unknown>;

  const shaRaw =
    nonEmptyString(m.commitSha) ??
    nonEmptyString(m.githubCommitSha) ??
    nonEmptyString(m.gitlabCommitSha) ??
    nonEmptyString(m.bitbucketCommitSha);
  const messageRaw =
    nonEmptyString(m.commitMessage) ??
    nonEmptyString(m.githubCommitMessage) ??
    nonEmptyString(m.gitlabCommitMessage) ??
    nonEmptyString(m.bitbucketCommitMessage);

  return {
    sha: shaRaw ? shaRaw.slice(0, COMMIT_SHA_LEN) : "-",
    message: messageRaw ? truncateMessage(messageRaw) : "-",
  };
}

interface VercelDeploymentNode {
  uid?: unknown;
  readyState?: unknown;
  state?: unknown;
  createdAt?: unknown;
  created?: unknown;
  meta?: unknown;
}

interface VercelDeployment {
  uid: string;
  state: string;
  createdAtMs: number;
  createdAtIso: string;
  commitSha: string;
  commitMessage: string;
}

/** Fetches AND parses the project's candidate deployments (bounded by
 * {@link DEPLOYMENTS_FETCH_LIMIT}, server-side filtered to "at or before
 * windowEnd" via `until` — deliberately NOT ALSO server-side filtered by
 * `since`/windowStart), most-recent-first. Both verbs derive their own
 * candidate SELECTION from this one shared fetch client-side (see
 * {@link changesCandidates} / {@link searchEventsCandidates} below) — see
 * the module doc-comment ("SHARED CANDIDATE FETCH") for the full reasoning
 * behind this deliberate divergence from railway.ts's own unfiltered
 * shared fetch. */
async function fetchProjectDeployments(
  token: string,
  projectId: string,
  teamId: string | undefined,
  windowEnd: string
): Promise<{ ok: true; deployments: VercelDeployment[] } | { ok: false; reason: EvidenceDegradationReason }> {
  const params = new URLSearchParams({
    projectId,
    until: String(new Date(windowEnd).getTime()),
    limit: String(DEPLOYMENTS_FETCH_LIMIT),
  });
  appendTeamId(params, teamId);

  // 404 → config_missing (this task's own pinned adjudication) — see
  // vercelGet's own doc-comment ("notFoundReason") for the full reasoning.
  const result = await vercelGet(`${VERCEL_API}/v7/deployments?${params}`, token, "config_missing");
  if (!result.ok) return result;

  const body = result.data as { deployments?: unknown } | null;
  const rawList = Array.isArray(body?.deployments) ? body!.deployments : [];

  const deployments: VercelDeployment[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as VercelDeploymentNode;

    const uid = typeof node.uid === "string" ? node.uid : null;
    const createdAtRaw =
      typeof node.createdAt === "number"
        ? node.createdAt
        : typeof node.created === "number"
          ? node.created
          : null;
    if (!uid || createdAtRaw === null || Number.isNaN(createdAtRaw)) continue;

    // `readyState` is canonical (it is in the object's own REQUIRED field
    // list); `state` (a near-duplicate, NOT required) is a defensive
    // fallback only — see the module doc-comment ("CHANGES — deployments
    // listing").
    const state =
      nonEmptyString(node.readyState) ?? nonEmptyString(node.state) ?? "-";
    const { sha, message } = commitInfoFromMeta(node.meta);

    deployments.push({
      uid,
      state,
      createdAtMs: createdAtRaw,
      createdAtIso: new Date(createdAtRaw).toISOString(),
      commitSha: sha,
      commitMessage: message,
    });
  }

  // Defensive — do not trust the server's own list ordering (never
  // documented as most-recent-first in any fetched example), mirrors
  // railway.ts's identical precedent.
  deployments.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { ok: true, deployments };
}

/** `changes`' candidate set: deployments CREATED within
 * `[windowStart, windowEnd]` (inclusive both ends), most-recent-first — a
 * deployment that merely happened to be running through the window,
 * without itself being created in it, is not a "change" that occurred in
 * the window. Cited verbatim from railway.ts's own identical function. */
function changesCandidates(
  all: VercelDeployment[],
  windowStart: string,
  windowEnd: string
): VercelDeployment[] {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  return all.filter((d) => d.createdAtMs >= startMs && d.createdAtMs <= endMs);
}

/** `search_events`' candidate set — see the module doc-comment
 * ("SEARCH_EVENTS CANDIDATE SELECTION", cited from railway.ts's own Fix
 * Round 1 FIX 1c): {@link changesCandidates} PLUS the single most recent
 * deployment created AT OR BEFORE `windowStart` — the one actually serving
 * (and logging) when the window opens. Deduped by `uid` (the
 * serving-at-start deployment can already be in-window when its own
 * `createdAt` lands exactly at `windowStart`, since `changesCandidates`'
 * lower bound is inclusive). Most-recent-first. */
function searchEventsCandidates(
  all: VercelDeployment[],
  windowStart: string,
  windowEnd: string
): VercelDeployment[] {
  const startMs = new Date(windowStart).getTime();
  const inWindow = changesCandidates(all, windowStart, windowEnd);

  let servingAtStart: VercelDeployment | null = null;
  for (const d of all) {
    if (d.createdAtMs <= startMs && (!servingAtStart || d.createdAtMs > servingAtStart.createdAtMs)) {
      servingAtStart = d;
    }
  }

  const merged =
    servingAtStart && !inWindow.some((d) => d.uid === servingAtStart!.uid)
      ? [...inWindow, servingAtStart]
      : inWindow;
  return merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** `deployment {uid} state={state} at={iso} commit={sha7|-} "{message-80|-}"`
 * — this task's own pinned field order. */
function renderChangeLine(d: VercelDeployment): string {
  return `deployment ${d.uid} state=${d.state} at=${d.createdAtIso} commit=${d.commitSha} "${d.commitMessage}"`;
}

async function queryChanges(
  token: string,
  projectId: string,
  teamId: string | undefined,
  q: EvidenceQuery
): Promise<AdapterResult> {
  const result = await fetchProjectDeployments(token, projectId, teamId, q.windowEnd);
  if (!result.ok) return result;
  const candidates = changesCandidates(result.deployments, q.windowStart, q.windowEnd);
  if (candidates.length === 0) {
    return { ok: true, raw: NO_DEPLOYMENTS_MARKER };
  }

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // every sibling adapter's identical clamp.
  const limit = Math.max(1, q.limit ?? CHANGES_DEFAULT_LIMIT);
  const limited = candidates.slice(0, limit);
  return { ok: true, raw: limited.map(renderChangeLine).join("\n") };
}

interface VercelEventEntry {
  type?: unknown;
  created?: unknown;
  /** The THIRD confirmed response branch (Fix Round 1 — see the module
   * doc-comment, "SEARCH_EVENTS"): an `alias-assigned` event carries `date`
   * instead of `created` — its own `required` list has no `created` field
   * at all. Read as a fallback — see {@link eventTimestamp}. */
  date?: unknown;
  text?: unknown;
  payload?: unknown;
}

interface RenderedLogLine {
  at: number;
  line: string;
}

/** Reads an event's free text defensively across the two response
 * branches confirmed by this adapter's own doc-verify (see "SEARCH_EVENTS"
 * above): top-level `entry.text` (the flatter branch) or nested
 * `entry.payload.text` (the wrapped branch). Absent in both → `""` (some
 * event kinds, e.g. `delimiter`/`exit`, legitimately carry no text). */
function eventText(entry: VercelEventEntry): string {
  if (typeof entry.text === "string") return entry.text;
  const payload = entry.payload;
  if (payload && typeof payload === "object") {
    const payloadText = (payload as Record<string, unknown>).text;
    if (typeof payloadText === "string") return payloadText;
  }
  return "";
}

/** Reads an event's own timestamp as `created ?? date` (Fix Round 1 — see
 * the module doc-comment, "SEARCH_EVENTS"): `created` is present on the
 * two branches this adapter originally confirmed, but the THIRD confirmed
 * branch — `alias-assigned` events — carries ONLY `date` (its own
 * `required` list has no `created` field). Without this fallback, every
 * alias-assigned event was silently dropped, indistinguishable from a
 * malformed entry. An entry with NEITHER field is still skipped — now the
 * ONLY remaining silent-skip case for a missing timestamp (a genuinely
 * undocumented/malformed shape, not a known real branch). */
function eventTimestamp(entry: VercelEventEntry): number | null {
  if (typeof entry.created === "number" && Number.isFinite(entry.created)) {
    return entry.created;
  }
  if (typeof entry.date === "number" && Number.isFinite(entry.date)) {
    return entry.date;
  }
  return null;
}

/** `log {type|-} "{text-120}" at={iso}` — this task's own pinned field
 * order. */
function renderLogLine(type: string, text: string, atIso: string): string {
  return `log ${type} "${text}" at=${atIso}`;
}

type DeploymentEventsOutcome = { ok: true; lines: RenderedLogLine[] } | { ok: false; marker: string };

/** One deployment's events — its OWN try/catch (per-deployment
 * granularity; see the module doc-comment, "FAILURE HANDLING"). Sends
 * `since`/`until` server-side (no serving-at-start conflict here — this
 * fetch targets ONE already-selected candidate's own event stream, not the
 * shared candidate-discovery fetch) AND re-filters each returned event's
 * own timestamp (`created ?? date` — see {@link eventTimestamp}) against
 * the SAME window client-side — belt-and-braces, never trusting the
 * server-side filter alone (mirrors railway.ts's FIX 1a/1b precedent
 * exactly). */
async function fetchDeploymentEvents(
  token: string,
  deploymentId: string,
  teamId: string | undefined,
  windowStart: string,
  windowEnd: string
): Promise<DeploymentEventsOutcome> {
  const params = new URLSearchParams({
    since: String(new Date(windowStart).getTime()),
    until: String(new Date(windowEnd).getTime()),
    limit: String(SEARCH_EVENTS_EVENTS_PER_DEPLOYMENT),
  });
  appendTeamId(params, teamId);

  let result: Awaited<ReturnType<typeof vercelGet>>;
  try {
    result = await vercelGet(
      `${VERCEL_API}/v3/deployments/${encodeURIComponent(deploymentId)}/events?${params}`,
      token
    );
  } catch {
    return { ok: false, marker: `(deployment ${deploymentId}: vercel unreachable)` };
  }
  if (!result.ok) {
    return { ok: false, marker: `(deployment ${deploymentId}: vercel ${result.reason})` };
  }

  // Confirmed nullable-array response (see the module doc-comment,
  // "SEARCH_EVENTS") — a non-array (including a legitimate `null`) is
  // treated as zero events, not an error.
  const entries = Array.isArray(result.data) ? result.data : [];

  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const lines: RenderedLogLine[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as VercelEventEntry;

    const createdMs = eventTimestamp(entry);
    if (createdMs === null) continue;
    // Client-side re-filter (belt-and-braces) — inclusive bounds,
    // independent of whatever the server-side since/until actually did
    // with this entry.
    if (createdMs < startMs || createdMs > endMs) continue;

    const type = nonEmptyString(entry.type) ?? "-";
    const text = truncateText(eventText(entry));
    lines.push({
      at: createdMs,
      line: renderLogLine(type, text, new Date(createdMs).toISOString()),
    });
  }
  return { ok: true, lines };
}

/** Split `items` into fixed-size, order-preserving batches — mirrors
 * railway.ts's/factory.ts's identical helper. */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function querySearchEvents(
  token: string,
  projectId: string,
  teamId: string | undefined,
  q: EvidenceQuery
): Promise<AdapterResult> {
  const result = await fetchProjectDeployments(token, projectId, teamId, q.windowEnd);
  if (!result.ok) return result;
  const candidates = searchEventsCandidates(result.deployments, q.windowStart, q.windowEnd);
  if (candidates.length === 0) {
    return { ok: true, raw: NO_MATCHING_LOGS_MARKER };
  }

  // Bounds the fan-out — EXPLICIT PIN (this task's own brief): cap at 10,
  // not railway.ts's own 20. `searchEventsCandidates` already sorts
  // most-recent-first.
  const targetDeployments = candidates.slice(0, SEARCH_EVENTS_MAX_DEPLOYMENTS);

  const allLines: RenderedLogLine[] = [];
  const markers: string[] = [];
  let successCount = 0;
  for (const batch of chunk(targetDeployments, SEARCH_EVENTS_BATCH_SIZE)) {
    const outcomes = await Promise.all(
      batch.map((d) => fetchDeploymentEvents(token, d.uid, teamId, q.windowStart, q.windowEnd))
    );
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successCount += 1;
        allLines.push(...outcome.lines);
      } else {
        markers.push(outcome.marker);
      }
    }
  }

  // Every targeted deployment's event fetch failed — nothing useful was
  // learned this call. Mirrors railway.ts's/sentry.ts's identical "all
  // scopes failing" collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // Substring match against the SAME text the caller receives — no server-
  // side home exists for this endpoint (see the module doc-comment,
  // "Q.QUERY").
  let filtered = allLines;
  if (q.query) {
    const needle = q.query.toLowerCase();
    filtered = filtered.filter((l) => l.line.toLowerCase().includes(needle));
  }

  // Chronological (ascending) — pinned.
  filtered.sort((a, b) => a.at - b.at);

  if (filtered.length === 0 && markers.length === 0) {
    return { ok: true, raw: NO_MATCHING_LOGS_MARKER };
  }

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors railway.ts's
  // identical discipline: a busy deployment's real lines filling the cap
  // must never silently push a sibling deployment's failure marker out of
  // the response. Only the real log lines are subject to `limit`.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  // Keep the MOST RECENT `limit` lines (the tail of the ascending sort) —
  // mirrors every sibling adapter's identical reasoning: a debugging
  // investigator is better served by recency than an arbitrary truncation
  // from the window's start. Output stays chronological.
  const cappedLines = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;

  return { ok: true, raw: [...markers, ...cappedLines.map((l) => l.line)].join("\n") };
}

export const vercelAdapter: EvidenceAdapter = {
  provider: "vercel",
  verbs: ["changes", "search_events"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "changes":
      case "search_events":
        break;
      default:
        // This adapter declares only [changes, search_events] — the route
        // never asks it for a verb it didn't declare, but a direct caller
        // (this module's own tests included) is not bound by that, so this
        // stays defensive rather than throwing (mirrors every sibling
        // adapter's identical default case).
        return { ok: false, reason: "bad_request" };
    }

    // See the module doc-comment ("CONFIG_MISSING") — cheapest check (no DB
    // read needed) first, same order as every sibling.
    if (!secret) {
      return { ok: false, reason: "config_missing" };
    }

    const row = await getConnector(workspaceId, "vercel");
    const projectId = row?.config.vercelProjectId;
    if (!projectId) {
      return { ok: false, reason: "config_missing" };
    }
    // Optional — see the module doc-comment ("CONFIG_MISSING" / "TEAM
    // SCOPING"): absence never degrades, it just means personal scope.
    const teamId = row?.config.vercelTeamId;

    return q.verb === "changes"
      ? queryChanges(secret, projectId, teamId, q)
      : querySearchEvents(secret, projectId, teamId, q);
  },
};

registerAdapter(vercelAdapter);
