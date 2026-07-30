import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `cloudflare` evidence adapter (Task P8, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The FINAL Wave-2 provider —
 * `verbs: ["signals", "search_events"]`: `signals` returns pre-aggregated
 * edge-traffic metrics (request count, 5xx error count, bytes served) over
 * the window; `search_events` searches firewall/security events (WAF,
 * rate-limiting, bot-management, custom-rule actions) in the window.
 *
 * CREDENTIAL: a SINGLE secret (no `secretParts`, like sentry/prometheus/
 * grafana/vercel above) — a Cloudflare API Token, sent as `Authorization:
 * Bearer <token>` on every call. This adapter uses its `secret` parameter
 * directly.
 *
 * CLOUDFLARE API SHAPES — confirmed against Cloudflare's own docs during
 * implementation (this task's mandatory first step; NOT trusted from
 * memory). Every URL below was fetched live (developers.cloudflare.com,
 * dated 2026-07-30). Fix Round 1 (coordinator-confirmed critical finding —
 * see "GRAPHQL VARIABLE TYPES" below for the full account): the original
 * submission's doc-verify pass fetched several pages through a
 * SUMMARIZING web-fetch tool and, for the GraphQL variable-type claims
 * specifically, that tool fabricated a citation. This round's re-verify
 * used ONLY raw, unsummarized sources: `curl` against each doc page's own
 * markdown source (`<page>/index.md` — the literal text a human would
 * read, not a model's paraphrase of it) and a community-maintained GraphQL
 * schema INTROSPECTION dump (pages.johnspurlock.com/graphql-schema-docs/
 * cloudflare.html — a ~7MB static page generated from Cloudflare's own
 * live schema, searched directly for exact field/type strings). The
 * `cloudflare/skills` GitHub reference (Cloudflare's own org) remains a
 * corroborating secondary source for prose claims (auth, rate limits,
 * plan availability) but is NOT relied on alone for any GraphQL type name
 * in this file — every type-name claim below is now schema-dump-first:
 *
 *   - AUTH: `Authorization: Bearer <token>` — confirmed
 *     (developers.cloudflare.com/analytics/graphql-api/getting-started/
 *     authentication/; `fundamentals/api/get-started/token-formats/`).
 *     TOKEN FORMAT: Cloudflare's own token-formats page confirms a NEW
 *     scannable, checksummed format per credential type — `cfut_` (User API
 *     Token), `cfat_` (Account API Token), `cfk_` (Global API Key), each
 *     `<prefix>[40 chars][checksum]` — introduced so GitHub's secret-scanning
 *     partner program can fingerprint them (exactly the Vercel/P7 `vcp_`
 *     precedent, now confirmed for Cloudflare too — this module's own test
 *     fixtures must not accidentally match either live-scanned prefix, see
 *     "SECRET FIXTURES" below). The SAME page states the LEGACY, UNPREFIXED
 *     shape "continue[s] to work": a 40-char alphanumeric string for BOTH
 *     User and Account API Tokens (the credential type this connector's
 *     catalog entry asks for — NOT the Global API Key, a materially
 *     different, more powerful credential Cloudflare's own docs call "the
 *     preferred way to interact with Cloudflare APIs" to AVOID via API
 *     Tokens instead). Given TWO independently-valid NEW prefixes (`cfut_`
 *     and `cfat_` both denote "an API Token", the distinction this connector
 *     doesn't need to care about) PLUS the still-valid legacy shape, the
 *     format gate (`connector-helpers.ts`'s `case "cloudflare"`) stays
 *     shape-agnostic DELIBERATELY — mirrors vercel.ts's/prometheus.ts's
 *     identical "no single confirmed shape to gate on" precedent: requiring
 *     either new prefix would reject every still-valid legacy token a
 *     workspace may already hold. Real security lives at Gate 2 (live
 *     verify), unaffected by this format gate's own permissiveness.
 *
 *   - VERIFY: `GET https://api.cloudflare.com/client/v4/user/tokens/verify`
 *     — confirmed, current (searched + corroborated against the resource
 *     reference page for this endpoint). Response:
 *     `{success, result:{id, status:"active"|"disabled"|"expired", …},
 *     errors, messages}`. Genuinely validates the TOKEN ITSELF, independent
 *     of what it's scoped to — a zone-scoped token still resolves an
 *     `id`/`status`, so this endpoint works unmodified for the zone-scoped
 *     tokens this connector's own setup steps ask the operator to create
 *     (confirming this task's own "does it work with zone-scoped tokens"
 *     question). `verify.ts`'s own `verifyCloudflare` checks
 *     `success === true && result.status === "active"` — NOT `success`/HTTP
 *     2xx alone — because the documented `status` enum includes
 *     `"disabled"`/`"expired"` alongside `"active"`; a disabled or expired
 *     token can still return a successful, well-formed response body, and
 *     accepting that as "valid" would store a credential that cannot
 *     actually authenticate a real query.
 *
 *   - SIGNALS — HTTP traffic analytics: `httpRequestsAdaptiveGroups`, a
 *     zone-scoped dataset under `viewer.zones(filter:{zoneTag})` — confirmed
 *     current and available on ALL Cloudflare plans (corroborated across
 *     multiple sources describing it as one of the GraphQL Analytics API's
 *     "essential" datasets, alongside `firewallEventsAdaptive` below; no
 *     first-party per-plan gating table was found for either — the CONFIRMED
 *     `settings` introspection node, `viewer.zones(...).settings { <node> {
 *     enabled } }`, is the documented way to check per-token/per-plan
 *     availability precisely, but calling it is out of scope for this v1 —
 *     see "PLAN CONSTRAINTS" below). This adapter selects ONLY aggregate
 *     fields (`count`, `sum { edgeResponseBytes }`) with NO dimension field
 *     (no `datetimeMinute`/`clientCountryName`/etc.) — confirmed, worked
 *     examples show the *Groups datasets return one row PER SELECTED
 *     DIMENSION COMBINATION, so selecting zero dimensions is what collapses
 *     the whole filtered window to (at most) one implicit summary row — the
 *     mechanism this adapter relies on for pin 2's "signals = single-row
 *     aggregates structurally" (see "SINGLE-ROW DESIGN" below for the belt
 *     this adapter still applies on top).
 *
 *   - SIGNALS' THREE METRICS (this adapter's own disclosed judgment call,
 *     mirrors every sibling's identical "small RED/USE-shaped set" pick):
 *     total requests (`count`, unfiltered), 5xx error count (`count`,
 *     filtered `edgeResponseStatus_geq: 500` — the task's own pinned
 *     metric), and bytes served (`sum.edgeResponseBytes`, unfiltered) — the
 *     latter chosen over a "cache ratio" metric (also suggested by the
 *     task's own brief) because `count`/`sum` are the two aggregate SHAPES
 *     directly confirmed by name across every fetched worked example, while
 *     a cache-hit RATIO's exact aggregate shape (`ratio { … }`, glimpsed but
 *     never seen in a complete worked example) and `cacheStatus`'s exact
 *     enum values were never confirmed precisely enough to embed as a filter
 *     value without guessing — the same "don't guess an unconfirmed enum
 *     string" restraint sentry.ts's `firstNumericValue` and datadog.ts's
 *     `SCOPE_TAG_VALUE_RE` gate both apply elsewhere in this wave.
 *
 *   - ONE GRAPHQL REQUEST (task's own pinned design: "via ONE GraphQL
 *     request where possible"): both `count`-based metrics ride as TWO
 *     ALIASED selections of the SAME `httpRequestsAdaptiveGroups` field
 *     (`requests`/`errorRequests` below) inside a single query document —
 *     GraphQL aliasing is exactly the mechanism that makes "several
 *     differently-filtered aggregates, one HTTP round trip" possible, unlike
 *     Datadog's/Sentry's REST-endpoint siblings (each metric there is a
 *     SEPARATE HTTP call by construction). A genuine, disclosed STRUCTURAL
 *     consequence: because there is only ONE HTTP request for the whole
 *     `signals` verb here (not Datadog's/Sentry's three independent
 *     per-metric fetches), `querySignals` below is — UNLIKE every sibling's
 *     `signals` implementation — NOT wrapped in a per-metric try/catch; it
 *     behaves like every OTHER single-scope verb in this codebase (railway.ts
 *     `changes`, vercel.ts `changes`, this adapter's own `search_events`
 *     below): a thrown fetch (network failure, or the 8s timeout firing)
 *     propagates UNCAUGHT to the route, which already converts it to
 *     `unreachable` (see "FAILURE HANDLING" below for the orthogonal,
 *     GraphQL-level partial-failure handling this still needs).
 *
 *   - SEARCH_EVENTS — firewall/security events: `firewallEventsAdaptive`
 *     (NOT the plan's own generic "firewallEventsAdaptive" belief needing
 *     correction — this IS the confirmed, current dataset name; confirmed
 *     DISTINCT from its aggregated sibling `firewallEventsAdaptiveGroups`,
 *     which this adapter does not use — `search_events` wants one row PER
 *     EVENT, not aggregated counts). Zone-scoped, confirmed available on ALL
 *     plans (same "essential dataset" corroboration as httpRequestsAdaptiveGroups
 *     above). Confirmed fields (a real, complete worked query from Cloudflare's
 *     own tutorial page, `analytics/graphql-api/tutorials/querying-firewall-events/`):
 *     `action`, `source`, `clientIP`, `clientCountryName`, `clientAsn`,
 *     `userAgent`, `clientRequestPath`, `clientRequestQuery`, `datetime`, and
 *     (a second, independently confirmed dataset field, cross-checked via a
 *     Cloudflare Community thread describing it as "The RayId of the
 *     request", shared vocabulary with the aggregated sibling's own
 *     filter/orderBy fields) `rayName` — **NOT** `rayId`, correcting the
 *     plan's own believed field name (the T6/T7 "docs govern over believed
 *     shapes" lesson, repeated once more this wave): the real field is
 *     `rayName`; this adapter reads it and renders it into the pinned `ray=`
 *     slot. `ruleId` (a rule identifier) is ALSO confirmed, via a second
 *     worked example (the `cloudflare/skills` reference's own
 *     `firewallEventsAdaptive` query) selecting exactly
 *     `action source clientIP clientCountryName userAgent
 *     clientRequestHTTPHost clientRequestPath ruleId datetime` — this
 *     adapter reads `ruleId` (preferred) then `source` (fallback) for the
 *     pinned `"{ruleOrSource-120}"` slot (see {@link ruleOrSourceText}), a
 *     literal reading of that field's own name in the task's own render
 *     format. FIX ROUND 1 — every one of these five selected fields
 *     (`action`, `source`, `ruleId`, `rayName`, `datetime`) is now ALSO
 *     independently confirmed directly against the schema introspection
 *     dump's own `ZoneFirewallEventsAdaptive` type definition (the actual
 *     response type this query returns, distinct from its Filter_InputObject
 *     sibling): `action: string!`, `source: string!`, `ruleId: string!`,
 *     `rayName: string!`, `datetime: Time!` — all five present, all five
 *     the exact names this adapter selects, byte-searched directly rather
 *     than trusted from a doc page's prose.
 *
 *   - GRAPHQL VARIABLE TYPES — FIX ROUND 1 CORRECTION. The original
 *     submission claimed `$filter: filter` (a lowercase, dataset-generic
 *     scalar) was "CONFIRMED, verbatim" from Cloudflare's own
 *     `execute-graphql-query`/`compose-graphql-query` docs pages. **That
 *     type never existed anywhere in Cloudflare's schema.** Described
 *     honestly here rather than silently fixed, per this codebase's own
 *     "docs govern over believed shapes" discipline (the T6/T7 lesson, now
 *     applied to this adapter's own earlier mistake): re-fetching BOTH
 *     cited pages' raw markdown source directly (`curl`, not the
 *     summarizing web-fetch tool the original pass used) found ZERO
 *     `$variable: Type` declarations of any kind in either page —
 *     `compose-graphql-query` documents a GraphiQL UI walkthrough almost
 *     entirely via PNG screenshots (nothing for a text-fetch tool to read
 *     at all), and `execute-graphql-query`'s own worked example body is
 *     itself malformed — an ANONYMOUS `{viewer{...}}` query with no
 *     `query OperationName(...)` signature declaring `$zoneTag`/`$filter`
 *     at all, not valid, independently-executable GraphQL as written. The
 *     original "CONFIRMED verbatim" citation was a fabrication by the
 *     summarizing fetch tool — almost certainly produced by conflating the
 *     separate Filtering page's own BNF-style GRAMMAR PRODUCTION literally
 *     named `filter` (`analytics/graphql-api/features/filtering/`: "The
 *     following grammar describes the table filter... `filter { kvs }`" —
 *     a piece of prose notation, not a schema type) with an actual GraphQL
 *     scalar type name. A plausible-sounding inference; entirely wrong.
 *
 *     Re-verified this round from TWO raw, independently-checkable sources
 *     (see this module's own top doc-comment, "CLOUDFLARE API SHAPES", for
 *     the sourcing discipline this failure forced): the actual, confirmed
 *     leaf-level scalar types —
 *       - `zoneTag: string` — confirmed in TWO complete, syntactically
 *         valid worked examples (`tutorials/querying-firewall-events/`'s
 *         own full curl example; `features/filtering/`'s own "General
 *         example") AND independently in the schema dump
 *         (`ZoneFilter_InputObject.zoneTag: string`) — this one part of the
 *         original claim was, in fact, correct.
 *       - `datetime_geq`/`datetime_leq: Time` — confirmed in the schema
 *         dump on BOTH `ZoneHttpRequestsAdaptiveGroupsFilter_InputObject`
 *         and `ZoneFirewallEventsAdaptiveFilter_InputObject` (the identical
 *         scalar on both), corroborated by `features/filtering/`'s own
 *         "General example" (`$start: Time`, used with `datetime_gt` —
 *         same field family, same "scalar operators" group per that page's
 *         own operator table).
 *       - `limit: uint64` — confirmed in the schema dump on BOTH dataset
 *         fields' own argument signature (`httpRequestsAdaptiveGroups(...,
 *         limit: uint64!, ...)`, `firewallEventsAdaptive(..., limit:
 *         uint64!, ...)`) — NOT the GraphQL-spec `Int` the original
 *         submission guessed. No doc-prose worked example anywhere
 *         declares `$limit` as a variable at all (every one inlines a bare
 *         literal, e.g. `limit: 10`) — this specific type has no doc-prose
 *         citation to corroborate against, only the schema dump directly.
 *       - `edgeResponseStatus_geq: uint16` — confirmed in the schema dump
 *         on `ZoneHttpRequestsAdaptiveGroupsFilter_InputObject`
 *         specifically — a materially DIFFERENT scalar from `limit`'s
 *         `uint64` (an HTTP status code fits 16 bits; a row/page count does
 *         not), confirming these are genuinely distinct numeric scalars in
 *         this schema, not one generic "number" type a careless guess
 *         might have assumed.
 *
 *     THE ACTUAL FIX — the reviewer's own prescribed, Cloudflare-idiomatic
 *     pattern (the one every real, COMPLETE worked example in the docs
 *     actually uses): the filter SHAPE is now INLINED directly in the
 *     constant query document (`filter: { datetime_geq: $windowStart,
 *     datetime_leq: $windowEnd }`, literally matching `features/
 *     filtering/`'s own "General example" structure), and ONLY the LEAF
 *     VALUES ride as variables — never the whole filter object as one
 *     opaque variable. This also sidesteps a SECOND, independently
 *     confirmed landmine this round's re-verify turned up: the
 *     dataset-specific NAMED Filter_InputObject type is inconsistently
 *     documented even WITHIN Cloudflare's own official pages —
 *     `compose-graphql-query`'s own prose names it
 *     `ZoneFirewallEventsAdaptiveFilter_InputObject` (matching the schema
 *     dump, confirmed correct), while `querying-firewall-events`'s own
 *     literal, "complete" worked curl example declares
 *     `FirewallEventsAdaptiveFilter_InputObject` — missing the `Zone`
 *     prefix, confirmed WRONG against the schema dump. Even a real,
 *     complete, copy-pasteable official example had a wrong type name in
 *     it. Inlining the filter shape means this adapter never has to name
 *     either form at all — a strictly narrower, more defensible surface.
 *     This STAYS pin-3 compliant: {@link CLOUDFLARE_SIGNALS_QUERY}/
 *     {@link CLOUDFLARE_SEARCH_EVENTS_QUERY} remain constant template
 *     literals with ZERO `${}` interpolation — every value (zoneTag, both
 *     window bounds, the 5xx threshold, limit) still travels as a real
 *     GraphQL variable, just as a LEAF value inside an inlined filter
 *     literal rather than nested inside one opaque whole-filter variable.
 *
 *     FAILURE MODE THIS BUG WOULD HAVE CAUSED, undetected pre-deploy: a
 *     query document declaring a nonexistent variable type is rejected by
 *     Cloudflare's GraphQL server as a validation error on EVERY call —
 *     HTTP 200, a populated `errors` array, `data: null` — which this
 *     adapter's own {@link cloudflareGraphQL} already maps to
 *     `upstream_error` (a real, closed-set degradation reason, not a
 *     crash). A connected Cloudflare workspace would have shown as
 *     successfully verified (live-verify never exercises the GraphQL
 *     endpoint at all — see "VERIFY" above) while `signals`/
 *     `search_events` silently, permanently degraded to `upstream_error`
 *     on every single real call — 100% silent non-functionality behind a
 *     passing connect flow. This test suite's own mocked `fetch` could not
 *     have caught it either (a mock does not validate the query document
 *     against Cloudflare's real GraphQL server) — see "LIVE-TOKEN SMOKE"
 *     immediately below.
 *
 *   - LIVE-TOKEN SMOKE — FLAGGED FOR PRE-DEPLOY, NOT PERFORMED THIS ROUND
 *     (stated honestly, per the lesson directly above): no live Cloudflare
 *     API token is available in this implementation environment. The
 *     corrected query documents in this file have been re-verified against
 *     a real GraphQL schema INTROSPECTION dump (see "GRAPHQL VARIABLE
 *     TYPES" above) — high-confidence, but NOT the same guarantee as an
 *     actual round trip. A pre-deploy smoke test (one real `signals` call
 *     and one real `search_events` call, against a real zone with a real
 *     token) is REQUIRED before this adapter is trusted in production. Do
 *     not treat a schema-dump match as equivalent to a live call having
 *     actually succeeded — it is the best available evidence in this
 *     environment, not a substitute for one.
 *
 *   - GRAPHQL ERROR SHAPE (task's own pinned degradation contract, a
 *     deliberate DIVERGENCE from railway.ts's simpler "any errors present,
 *     regardless of data, collapses to upstream_error"): Cloudflare's own
 *     docs state plainly "GraphQL returns 200 even on query failures" and
 *     instruct always checking `response.errors` — this adapter's
 *     {@link cloudflareGraphQL} does so, and specifically distinguishes: an
 *     `errors` array present WITH `data` null/absent → `upstream_error`
 *     (logged via `console.warn`, never embedded in the returned reason —
 *     degradations carry reason only, per this task's own pin); an `errors`
 *     array present WITH `data` non-null (a genuine GraphQL PARTIAL
 *     failure — plausible here specifically because `signals` asks for TWO
 *     aliased sub-selections in one request, and one can fail while its
 *     sibling succeeds) → render whatever real data came back,
 *     `console.warn` the rest. See {@link querySignals}'s own per-alias
 *     null-check for how a partial failure surfaces as a cap-exempt marker
 *     for exactly the one failed alias, never discarding its sibling's real
 *     result.
 *
 *   - EMPTY ZONES → config_missing (this task's own pinned adjudication,
 *     ported from vercel.ts's identical "404 on an operator-scoped list call
 *     → config_missing" reasoning to GraphQL's own "empty array where we
 *     expected our one configured zone" shape): a 200 response whose
 *     `viewer.zones` array is empty despite a CONFIGURED `cloudflareZoneId`
 *     can only mean the stored zone id doesn't exist, or isn't visible to
 *     this token — a connector CONFIGURATION gap (reconnecting with the
 *     right zone id, or a token actually scoped to it, is what fixes it),
 *     not a credential Cloudflare REJECTED (`unauthorized` — a clean 401/403
 *     is handled earlier, at the HTTP-status tier) and not a transient
 *     upstream problem (`upstream_error`).
 *
 *   - RATE LIMITS (pin 7, closed out): CONFIRMED at
 *     `developers.cloudflare.com/analytics/graphql-api/limits/` — the
 *     GraphQL Analytics API allows 300 queries per 5-minute window per user
 *     ("run at least 1 query every second, or… burst of 300 queries and
 *     then wait 5 minutes" — corroborated by a second source describing the
 *     same limit as cost-based, max ~320/5min), SEPARATE from the general
 *     Cloudflare API's own 1200-requests-per-5-minutes limit (confirmed via
 *     search of the same official limits page). This adapter does not read
 *     rate-limit headers or retry — a 429 falls through the same generic
 *     non-2xx → `upstream_error` mapping as any other non-401/403 failure,
 *     matching every sibling adapter's own precedent. This adapter's own
 *     ONE-request-per-verb design (see "ONE GRAPHQL REQUEST" above) keeps
 *     its own worst-case burst to exactly 1 query per `query()` call
 *     regardless of window size — structurally lighter than every sibling's
 *     own 3-request (signals) or N-request (search_events fan-out) shape.
 *
 *   - PLAN CONSTRAINTS (task's own "document plan constraints honestly"):
 *     both datasets this adapter reads are corroborated as available on
 *     Cloudflare's Free plan (the "essential datasets, all plans" framing
 *     recurring across multiple independent sources) — but Cloudflare's OWN
 *     docs state generally that "not all datasets are available on all
 *     plans" and that higher plans unlock more FIELDS/longer retention/wider
 *     time ranges/larger page sizes on datasets that ARE universally
 *     available, via the confirmed `settings` introspection node
 *     (`viewer.zones(...).settings { httpRequestsAdaptiveGroups { enabled
 *     maxDuration notOlderThan maxPageSize } }`). This adapter does NOT call
 *     `settings` in v1 (an extra request per query, against this adapter's
 *     own "one request" design goal above) — a Free-plan zone with a
 *     shorter `notOlderThan`/`maxDuration` than this adapter's own window
 *     may legitimately return less data than a paid plan would for the
 *     identical query; this degrades to an honest smaller/empty result
 *     (never an error) exactly like any other "zero matching rows" case.
 *
 *   - ACCOUNT TAG NOT NEEDED (task's own explicit question, answered):
 *     BOTH `httpRequestsAdaptiveGroups` and `firewallEventsAdaptive` are
 *     confirmed reachable via `zoneTag` alone (`viewer.zones(filter:
 *     {zoneTag})`) — no worked example for either dataset uses
 *     `accountTag`/`viewer.accounts(...)` at all. Per this task's own pinned
 *     decision, `cloudflareAccountId` (already present, unused, in
 *     `ConnectorConfig` from Task P0) is therefore NOT added to this
 *     provider's catalog entry, NOT read anywhere in this file, and NOT
 *     read by `verify.ts` — a deliberate, documented non-use of an
 *     already-provisioned schema field, not an oversight.
 *
 * SECRET FIXTURES (pin 8): Cloudflare's own live secret-scanning partners
 * (GitHub among them, per the token-formats changelog's own stated purpose)
 * scan for the `cfut_`/`cfat_`/`cfk_` prefixes — this module's own tests
 * never construct a contiguous literal bearing any of them (concat-split,
 * mirrors vercel.test.ts's/connector-helpers.test.ts's identical Fix-Round-2
 * discipline for `vcp_`).
 *
 * RENDERING: `signals` — the Global Constraints' pinned `signal
 * {name}{labels} window_agg={avg|max|p95…} value={n} at={iso}` — EVERY line
 * is stamped at `windowEnd` UNCONDITIONALLY (not a belt fallback for an
 * occasionally-multi-row response, unlike datadog.ts's `.rollup()` belt —
 * structural here: selecting zero dimension fields means Cloudflare's
 * response carries NO per-row timestamp at all, ever, by construction — the
 * same "no single bucket is more correct than another" reasoning
 * langfuse.ts's/datadog.ts's own synthesized-value fallback already
 * establishes, just unconditional rather than conditional). Capped
 * `Math.max(1, q.limit ?? 50)`. `search_events` — the task's own pinned
 * `event {action|-} ray={rayId|-} "{ruleOrSource-120}" at={iso}` (rendered
 * off the CONFIRMED `rayName` field — see "SEARCH_EVENTS" above),
 * chronological (ascending — the task's own pinned ordering), capped
 * `Math.max(1, q.limit ?? 200)`, keeping the MOST RECENT entries when over
 * cap (every sibling's identical "tail of the ascending sort" reasoning).
 *
 * WINDOW FILTERING: server-side (`datetime_geq: $windowStart`/
 * `datetime_leq: $windowEnd` — Fix Round 1: now leaf-variable references
 * inside each query's own INLINED filter literal, not nested inside one
 * whole-object `$filter` variable — see "GRAPHQL VARIABLE TYPES" above) AND
 * client-side ALWAYS (belt-and-braces, every sibling's identical doctrine)
 * — every firewall event's own `datetime` is re-checked against
 * `[windowStart, windowEnd]` regardless of what the server-side filter
 * already did. `signals` has no per-row timestamp to re-filter (see
 * "RENDERING" above) — the WINDOW itself is still enforced server-side via
 * the SAME `$windowStart`/`$windowEnd` variables on both aliased
 * sub-queries.
 *
 * Q.QUERY (`search_events`): CONFIRMED no free-text/search-language field
 * exists anywhere in `firewallEventsAdaptive`'s documented filter surface
 * (every confirmed filter example narrows by exact-match/comparison
 * dimensions — `action`, `source`, `ruleId`, `clientCountryName`,
 * `datetime_*` — never a text-search operator) — this task's own
 * anticipated "likely NOT — then client-side substring only" case, now
 * confirmed rather than assumed. Applied CLIENT-SIDE ONLY, as a substring
 * match against each candidate's own already-rendered line — "client-only
 * by construction", mirroring grafana.ts's/vercel.ts's identical documented
 * absence of a server-side text filter. `signals` has no verb-pinned
 * `q.query` wording and, mirroring every sibling's own generalization,
 * matches against each signal's own `{name}` identifier, CLIENT-SIDE ONLY.
 *
 * Q.SCOPE: NOT used by this adapter (mirrors vercel.ts's identical
 * disclosed decision) — v1's pinned design has exactly one scope dimension,
 * the connected `cloudflareZoneId`, with no second narrowing dimension this
 * task's own brief asks this adapter to expose.
 *
 * FAILURE HANDLING: NEITHER verb's single GraphQL request is try/catch-
 * wrapped locally (see "ONE GRAPHQL REQUEST" above for `signals`; mirrors
 * every sibling's identical single-scope-fetch discipline for
 * `search_events`) — a thrown fetch propagates uncaught to the route, which
 * converts it to `unreachable`. A clean 401/403 maps to `unauthorized`; any
 * other non-2xx maps to `upstream_error`; the GraphQL-level partial-failure
 * handling (see "GRAPHQL ERROR SHAPE" above) is orthogonal to, and runs
 * AFTER, this HTTP-status-tier check. `signals`' two aliased sub-results
 * each degrade independently to a cap-exempt marker line (`(signal {key}:
 * cloudflare upstream_error)`, rendered first) when Cloudflare nulls that
 * ONE alias's field while its sibling still resolves — both aliases failing
 * collapses to the adapter-level `upstream_error` (every sibling's identical
 * "all scopes failing" collapse).
 *
 * CONFIG_MISSING (mirrors every sibling's identical reasoning): a null
 * `secret`, an absent `config.cloudflareZoneId`, OR an empty
 * `viewer.zones` response despite a configured zone id (see "EMPTY ZONES"
 * above) all degrade to `config_missing` — none is the caller's fault, none
 * is a credential Cloudflare itself REJECTED; only reconnecting (or fixing
 * the stored zone id) resolves any of the three.
 *
 * REQUEST HYGIENE mirrors every sibling: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`.
 */

const CLOUDFLARE_GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";
const CLOUDFLARE_FETCH_TIMEOUT_MS = 8000;

const SIGNALS_DEFAULT_LIMIT = 50;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;

// Fetch-side row cap PER ALIAS on the signals query — a belt bound, not an
// assumption: selecting zero dimension fields should structurally collapse
// each aliased httpRequestsAdaptiveGroups selection to one implicit summary
// row (see the module doc-comment, "SIGNALS"), but this is requested
// defensively rather than trusted blindly (pin 2's "belt over whatever
// returns" — see collapseRequestGroups' own doc-comment for the client-side
// half of this belt).
const SIGNALS_ROW_LIMIT = 10;
// Fetch-side row cap on the search_events query — a plain local number, not
// a documented Cloudflare maximum (mirrors railway.ts's/vercel.ts's
// identical disclosed-limitation precedent), generous enough that the
// client-side window/query filtering below has real material to work with.
// A window with more than this many in-window events under-reports — a
// disclosed, accepted v1 bound, same spirit as every sibling's own
// single-page discipline.
const SEARCH_EVENTS_FETCH_LIMIT = 1000;

// The task's own pinned `signals` metric: "error count (edgeResponseStatus
// >= 500)". Fix Round 1: promoted to a named constant, sent as its own
// `$errorStatus: uint16` GraphQL variable (see the module doc-comment,
// "GRAPHQL VARIABLE TYPES") rather than buried in an inline filter-object
// literal — it is still an adapter-authored constant, never derived from
// caller input, but pin 3's "all values travel as variables" now covers it
// too.
const ERROR_STATUS_THRESHOLD = 500;

// Pinned "TITLES ARE UNTRUSTED TEXT" discipline (github.ts's own
// doc-comment) applied to the ruleId/source text — the task's own pinned
// render format spells this out explicitly: "{ruleOrSource-120}".
const RULE_OR_SOURCE_MAX_LEN = 120;

const NO_MATCHING_EVENTS_MARKER = "(no matching events)";
const NO_SIGNALS_MARKER = "(no matching signals)";

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

/** Newline-collapse + truncate to {@link RULE_OR_SOURCE_MAX_LEN} — the
 * pinned "ruleOrSource-120" render slot. */
function truncateRuleOrSource(value: string): string {
  const collapsed = singleLine(value);
  return collapsed.length > RULE_OR_SOURCE_MAX_LEN ? collapsed.slice(0, RULE_OR_SOURCE_MAX_LEN) : collapsed;
}

function cloudflareHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agentrail-console",
  };
}

/**
 * Constant GraphQL query documents (pin 3) — Fix Round 1: the filter SHAPE
 * is now INLINED literally in each document (mirrors `features/filtering/`'s
 * own confirmed "General example" structure — see the module doc-comment,
 * "GRAPHQL VARIABLE TYPES", for the full correction trail); every VALUE
 * (`zoneTag`, both window bounds, the 5xx threshold, `limit`) still rides
 * as a real GraphQL variable, typed per the schema-introspection-confirmed
 * leaf scalar for that exact position — never string-interpolated into the
 * document itself. Exported solely so `cloudflare.test.ts` can assert the
 * EXACT document sent over the wire equals this constant, byte for byte,
 * across calls with different `q.query`/`q.scope` — the mechanical proof
 * that no caller-supplied text can ever alter the query document (this
 * does NOT create a runtime dependency; only the TEST imports these).
 */
export const CLOUDFLARE_SIGNALS_QUERY = `
  query CloudflareSignals($zoneTag: string, $windowStart: Time, $windowEnd: Time, $errorStatus: uint16, $limit: uint64) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        requests: httpRequestsAdaptiveGroups(
          filter: { datetime_geq: $windowStart, datetime_leq: $windowEnd }
          limit: $limit
        ) {
          count
          sum {
            edgeResponseBytes
          }
        }
        errorRequests: httpRequestsAdaptiveGroups(
          filter: { datetime_geq: $windowStart, datetime_leq: $windowEnd, edgeResponseStatus_geq: $errorStatus }
          limit: $limit
        ) {
          count
        }
      }
    }
  }
`;

export const CLOUDFLARE_SEARCH_EVENTS_QUERY = `
  query CloudflareSecurityEvents($zoneTag: string, $windowStart: Time, $windowEnd: Time, $limit: uint64) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        firewallEventsAdaptive(
          filter: { datetime_geq: $windowStart, datetime_leq: $windowEnd }
          limit: $limit
          orderBy: [datetime_ASC]
        ) {
          action
          source
          ruleId
          rayName
          datetime
        }
      }
    }
  }
`;

interface CloudflareGraphQLBody<T> {
  data?: T | null;
  errors?: Array<Record<string, unknown>>;
}

/**
 * One GraphQL POST, mapped to the pinned taxonomy — see the module
 * doc-comment ("GRAPHQL ERROR SHAPE") for the confirmed "HTTP 200 even on
 * query failure" behavior this checks for explicitly, and why a partial
 * failure (errors present, data non-null) is NOT itself a failure return
 * here — it is logged and handed back so each verb's own per-field check
 * can isolate exactly which part of the response is missing. Deliberately
 * NOT try/catch-wrapped around the `fetch` call itself (see the module
 * doc-comment, "FAILURE HANDLING") — a thrown fetch propagates uncaught to
 * whichever caller needs that (the route, for both this adapter's verbs —
 * see "ONE GRAPHQL REQUEST").
 */
async function cloudflareGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await fetch(CLOUDFLARE_GRAPHQL_API, {
    method: "POST",
    headers: cloudflareHeaders(token),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(CLOUDFLARE_FETCH_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "unauthorized" };
  }
  if (!res.ok) {
    return { ok: false, reason: "upstream_error" };
  }

  const body = (await res.json().catch(() => null)) as CloudflareGraphQLBody<T> | null;
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "upstream_error" };
  }

  const errors = Array.isArray(body.errors) ? body.errors : [];
  const hasData = body.data !== null && body.data !== undefined;

  if (errors.length > 0) {
    if (!hasData) {
      // Pin: errors array + data null → upstream_error. Degradations carry
      // REASON ONLY — the raw provider error text is logged here, once, for
      // operator-side debugging, never embedded in the returned reason.
      console.warn("cloudflare graphql request failed:", errors);
      return { ok: false, reason: "upstream_error" };
    }
    // Pin: partial data + errors → render what came, console.warn the rest.
    console.warn("cloudflare graphql partial errors:", errors);
  }

  if (!hasData) {
    return { ok: false, reason: "upstream_error" };
  }
  return { ok: true, data: body.data as T };
}

interface RenderedLine {
  /** Epoch ms — the sort key; never itself rendered raw. */
  at: number;
  line: string;
}

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

interface HttpRequestsGroupRow {
  count?: unknown;
  sum?: { edgeResponseBytes?: unknown } | null;
}

interface SignalsZoneNode {
  requests?: HttpRequestsGroupRow[] | null;
  errorRequests?: HttpRequestsGroupRow[] | null;
}

interface SignalsData {
  viewer?: { zones?: SignalsZoneNode[] | null } | null;
}

/**
 * Sums `count`/`sum.edgeResponseBytes` across every row an alias returned —
 * the client-side half of pin 2's "belt over whatever returns" (see the
 * module doc-comment, "SIGNALS"). SUM, not AVG (unlike datadog.ts's gauge
 * belt): `count` and `sum.edgeResponseBytes` are both genuinely ADDITIVE
 * aggregates — if more than one row somehow survives (should not happen; no
 * dimension field is ever selected on either alias, so Cloudflare should
 * collapse to one implicit summary row by construction), summing them is
 * the CORRECT re-combination, not averaging. A row's `count` that is
 * missing/non-numeric contributes 0 (not skipped, not fabricated — the
 * accumulator simply doesn't advance for that row); `bytes` stays `null`
 * (never a fabricated `0`) unless at least one row carried a usable numeric
 * value, mirroring every sibling's "no data" vs "zero" distinction.
 */
function collapseRequestGroups(rows: HttpRequestsGroupRow[]): { count: number; bytes: number | null } {
  let count = 0;
  let bytes = 0;
  let sawBytes = false;
  for (const row of rows) {
    if (typeof row.count === "number" && Number.isFinite(row.count)) {
      count += row.count;
    }
    const b = row.sum?.edgeResponseBytes;
    if (typeof b === "number" && Number.isFinite(b)) {
      bytes += b;
      sawBytes = true;
    }
  }
  return { count, bytes: sawBytes ? bytes : null };
}

/** `signal {name} window_agg={agg} value={n} at={iso}` — the Global
 * Constraints' pinned `signals` convention. No `{labels}` suffix — this
 * adapter has no `q.scope` dimension to embed (see the module doc-comment,
 * "Q.SCOPE"). */
function renderSignalLine(name: string, aggLabel: string, value: number, atIso: string): string {
  return `signal ${name} window_agg=${aggLabel} value=${value} at=${atIso}`;
}

async function querySignals(token: string, zoneId: string, q: EvidenceQuery): Promise<AdapterResult> {
  // Fix Round 1: flat LEAF-value variables only — the filter SHAPE lives in
  // the query document itself now (see CLOUDFLARE_SIGNALS_QUERY's own
  // doc-comment and the module doc-comment, "GRAPHQL VARIABLE TYPES").
  const variables = {
    zoneTag: zoneId,
    windowStart: q.windowStart,
    windowEnd: q.windowEnd,
    errorStatus: ERROR_STATUS_THRESHOLD,
    limit: SIGNALS_ROW_LIMIT,
  };

  const result = await cloudflareGraphQL<SignalsData>(token, CLOUDFLARE_SIGNALS_QUERY, variables);
  if (!result.ok) return result;

  const zoneNode = result.data.viewer?.zones?.[0];
  // See the module doc-comment ("EMPTY ZONES → config_missing").
  if (!zoneNode) {
    return { ok: false, reason: "config_missing" };
  }

  const atMs = new Date(q.windowEnd).getTime();
  // Every line is stamped at windowEnd unconditionally — see the module
  // doc-comment, "RENDERING": there is structurally no per-row timestamp to
  // read (zero dimension fields selected, by design).
  const atIso = new Date(atMs).toISOString();

  const markers: string[] = [];
  const lines: RenderedLine[] = [];
  let successCount = 0;

  if (Array.isArray(zoneNode.requests)) {
    successCount += 1;
    const { count, bytes } = collapseRequestGroups(zoneNode.requests);
    lines.push({ at: atMs, line: renderSignalLine("cloudflare.requests.count", "count", count, atIso) });
    // A missing/non-numeric bytes value is skipped silently, not a
    // marker — the REQUEST succeeded, only this one derived value has no
    // usable data (mirrors sentry.ts's/datadog.ts's identical "no data" vs
    // "error" distinction).
    if (bytes !== null) {
      lines.push({ at: atMs, line: renderSignalLine("cloudflare.requests.bytes", "sum", bytes, atIso) });
    }
  } else {
    // Cloudflare nulled this ONE aliased field (a GraphQL-level partial
    // failure — see the module doc-comment, "GRAPHQL ERROR SHAPE") while the
    // request as a whole still returned 200 with SOME data. The reason is
    // always `upstream_error` here by construction: `unauthorized` and a
    // wholesale fetch failure are both already handled earlier, at
    // `cloudflareGraphQL`'s own HTTP-status tier / the uncaught-throw path.
    markers.push("(signal requests: cloudflare upstream_error)");
  }

  if (Array.isArray(zoneNode.errorRequests)) {
    successCount += 1;
    const { count } = collapseRequestGroups(zoneNode.errorRequests);
    lines.push({
      at: atMs,
      line: renderSignalLine('cloudflare.requests.errors{status="5xx"}', "count", count, atIso),
    });
  } else {
    markers.push("(signal errors: cloudflare upstream_error)");
  }

  // Every targeted alias failing at once — nothing useful was learned this
  // call. Mirrors every sibling's identical "all scopes failing" collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // `q.query` matches a signal's own name identifier — NOT the whole
  // rendered line (mirrors every sibling's identical `signals` contract).
  let filtered = lines;
  if (q.query) {
    const needle = q.query.toLowerCase();
    filtered = filtered.filter((l) => {
      const identifier = l.line.slice("signal ".length, l.line.indexOf(" window_agg="));
      return identifier.toLowerCase().includes(needle);
    });
  }

  if (filtered.length === 0 && markers.length === 0) {
    return { ok: true, raw: NO_SIGNALS_MARKER };
  }

  // Most-recent-first — consistent with every sibling's identical choice (no
  // verb-specific ordering pinned for `signals`). Every surviving line
  // shares the SAME `atMs` (see "RENDERING" above), so this sort is a
  // stable no-op in practice — kept for structural consistency with every
  // sibling adapter's identical sort step.
  filtered.sort((a, b) => b.at - a.at);

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors every sibling
  // adapter's identical discipline.
  const limit = Math.max(1, q.limit ?? SIGNALS_DEFAULT_LIMIT);
  const cappedLines = filtered.slice(0, limit).map((l) => l.line);
  return { ok: true, raw: [...markers, ...cappedLines].join("\n") };
}

// ---------------------------------------------------------------------------
// search_events
// ---------------------------------------------------------------------------

interface FirewallEventEntry {
  action?: unknown;
  source?: unknown;
  ruleId?: unknown;
  rayName?: unknown;
  datetime?: unknown;
}

interface SearchEventsZoneNode {
  firewallEventsAdaptive?: FirewallEventEntry[] | null;
}

interface SearchEventsData {
  viewer?: { zones?: SearchEventsZoneNode[] | null } | null;
}

/** `event {action|-} ray={rayId|-} "{ruleOrSource-120}" at={iso}` — this
 * task's own pinned field order. `ray=` reads the CONFIRMED real field name
 * `rayName` (correcting the plan's own believed "rayId" guess — see the
 * module doc-comment, "SEARCH_EVENTS"). */
function renderEventLine(action: string, ray: string, ruleOrSource: string, atIso: string): string {
  return `event ${action} ray=${ray} "${ruleOrSource}" at=${atIso}`;
}

/** `ruleId` (preferred, a specific rule identifier) falling back to
 * `source` (a general product category, e.g. `waf`/`ratelimit`) — a literal
 * reading of the task's own pinned "ruleOrSource" field name (see the
 * module doc-comment, "SEARCH_EVENTS"). Both absent → `""` (some event
 * kinds legitimately carry neither). */
function ruleOrSourceText(entry: FirewallEventEntry): string {
  const rule = typeof entry.ruleId === "string" && entry.ruleId ? entry.ruleId : null;
  const source = typeof entry.source === "string" && entry.source ? entry.source : null;
  return truncateRuleOrSource(rule ?? source ?? "");
}

/** Parses + belt-and-braces window-re-filters (never trusts the server-side
 * `datetime_geq`/`datetime_leq` filter alone — same doctrine as every
 * sibling adapter's identical re-filter) fetched firewall-event entries into
 * candidate rendered lines. An entry with an unparseable/absent `datetime`
 * is skipped rather than throwing. */
function parseFirewallEvents(
  entries: FirewallEventEntry[],
  windowStart: string,
  windowEnd: string
): RenderedLine[] {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const out: RenderedLine[] = [];
  for (const entry of entries) {
    const tsRaw = typeof entry.datetime === "string" ? entry.datetime : null;
    if (!tsRaw) continue;
    const atMs = new Date(tsRaw).getTime();
    if (Number.isNaN(atMs)) continue;
    if (atMs < startMs || atMs > endMs) continue;

    const action = typeof entry.action === "string" && entry.action ? entry.action : "-";
    const ray = typeof entry.rayName === "string" && entry.rayName ? entry.rayName : "-";
    const text = ruleOrSourceText(entry);

    out.push({ at: atMs, line: renderEventLine(action, ray, text, new Date(atMs).toISOString()) });
  }
  return out;
}

async function querySearchEvents(token: string, zoneId: string, q: EvidenceQuery): Promise<AdapterResult> {
  // Fix Round 1: flat LEAF-value variables only — see querySignals' own
  // identical comment above.
  const variables = {
    zoneTag: zoneId,
    windowStart: q.windowStart,
    windowEnd: q.windowEnd,
    limit: SEARCH_EVENTS_FETCH_LIMIT,
  };

  const result = await cloudflareGraphQL<SearchEventsData>(token, CLOUDFLARE_SEARCH_EVENTS_QUERY, variables);
  if (!result.ok) return result;

  const zoneNode = result.data.viewer?.zones?.[0];
  // See the module doc-comment ("EMPTY ZONES → config_missing").
  if (!zoneNode) {
    return { ok: false, reason: "config_missing" };
  }

  // A null/non-array `firewallEventsAdaptive` (either a genuinely empty
  // result, or this one field nulled by a GraphQL-level partial failure —
  // see the module doc-comment, "GRAPHQL ERROR SHAPE") is treated the same
  // as zero events, not an error — this verb has only ONE field to read (no
  // sibling alias whose success would make a null here suspicious), mirrors
  // vercel.ts's identical "confirmed nullable array → zero elements, not an
  // error" precedent for its own single-field events response.
  const entries = Array.isArray(zoneNode.firewallEventsAdaptive) ? zoneNode.firewallEventsAdaptive : [];

  let candidates = parseFirewallEvents(entries, q.windowStart, q.windowEnd);

  // No server-side text-search home exists on this dataset (see the module
  // doc-comment, "Q.QUERY") — client-side substring match against the
  // RENDERED LINE, "client-only by construction".
  if (q.query) {
    const needle = q.query.toLowerCase();
    candidates = candidates.filter((c) => c.line.toLowerCase().includes(needle));
  }
  if (candidates.length === 0) {
    return { ok: true, raw: NO_MATCHING_EVENTS_MARKER };
  }

  // Chronological (ascending) — this task's own pinned ordering; never
  // trusts the server's own `orderBy` alone.
  candidates.sort((a, b) => a.at - b.at);

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // every sibling adapter's identical clamp.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  // Keep the MOST RECENT `limit` lines (the tail of the ascending sort) —
  // mirrors every sibling adapter's identical reasoning.
  const capped = candidates.length > limit ? candidates.slice(candidates.length - limit) : candidates;
  return { ok: true, raw: capped.map((c) => c.line).join("\n") };
}

// ---------------------------------------------------------------------------

export const cloudflareAdapter: EvidenceAdapter = {
  provider: "cloudflare",
  verbs: ["signals", "search_events"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "signals":
      case "search_events":
        break;
      default:
        // This adapter declares only [signals, search_events] — the route
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

    const row = await getConnector(workspaceId, "cloudflare");
    const zoneId = row?.config.cloudflareZoneId;
    if (!zoneId) {
      return { ok: false, reason: "config_missing" };
    }

    return q.verb === "signals" ? querySignals(secret, zoneId, q) : querySearchEvents(secret, zoneId, q);
  },
};

registerAdapter(cloudflareAdapter);
