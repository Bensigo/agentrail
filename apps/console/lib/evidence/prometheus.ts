import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `prometheus` evidence adapter (Task P5, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The fifth Wave-2 provider —
 * `verbs: ["signals"]` ONLY (no `search_events`/`traces`/`changes`:
 * Prometheus is a time-series store with no log/event/deploy history of its
 * own to search). Four FIXED RED/USE-shaped queries, evaluated as INSTANT
 * queries (`time=windowEnd`) with an over-window range selector so each is
 * structurally guaranteed to collapse to ONE sample (pin 2) — never raw
 * PromQL from the model (this module's own doc-comment, "FIXED QUERY SET",
 * explains why).
 *
 * CREDENTIAL: a SINGLE secret field (NOT composite — unlike
 * langfuse.ts's/datadog.ts's declared `secretParts`; the task's own explicit
 * "single secret field; NO [composite]" pin) that is EITHER a bearer token
 * OR a `user:pass` pair for HTTP Basic auth, disambiguated by a heuristic —
 * see "AUTH HEURISTIC" below. This is a genuine difference from every prior
 * Wave-2 provider: there is nothing to validate at READ time beyond
 * "non-empty" (the format gate — see `connector-helpers.ts`'s own `case
 * "prometheus"`, catalog-declared: non-empty, ≤512 chars, no whitespace —
 * both a bearer token and a `user:pass` pair satisfy this trivially) because
 * {@link resolvePrometheusAuth} below ALWAYS succeeds for any non-empty
 * string; there is no `splitCompositeSecret`-style "malformed, degrade
 * config_missing" case for this adapter to handle.
 *
 * PROMETHEUS HTTP API SHAPES — confirmed against Prometheus's own docs
 * during implementation (this task's mandatory first step; NOT trusted from
 * memory):
 *
 *   - INSTANT QUERY: `GET/POST /api/v1/query?query=&time=` — confirmed
 *     (`prometheus.io/docs/prometheus/latest/querying/api/`). `time` accepts
 *     `<rfc3339 | unix_timestamp>` — this adapter sends `q.windowEnd`
 *     UNCONVERTED (it is already an RFC3339 string, `Date.toISOString()`'s
 *     own output shape, `…T…Z`) — UNLIKE datadog.ts's confirmed
 *     seconds-request/milliseconds-response asymmetry, there is no unit
 *     conversion anywhere on this adapter's request side, a genuine
 *     simplification worth calling out explicitly (see {@link buildQueryUrl}).
 *     Response: `{status, data:{resultType, result}, errorType?, error?,
 *     warnings?, infos?}` — for `resultType:"vector"` (what every one of
 *     this adapter's four queries produces — see "FIXED QUERY SET" below),
 *     `result` is `[{metric, value:[<unix_time>, "<sample_value>"]}, ...]`.
 *     The timestamp is a NUMBER (unix seconds, confirmed to carry a
 *     fractional part in general); the VALUE is a STRING (confirmed —
 *     `"<sample_value>"`, quoted in the docs' own schema), and Prometheus's
 *     own way of saying "this element has no meaningful number" is a value
 *     string of `NaN`/`+Inf`/`-Inf` (confirmed real: `histogram_quantile`
 *     itself returns NaN on a bucket with zero total observations — a
 *     realistic case for query 3 below on a quiet window) — see
 *     {@link parseSample} for how this is skipped, never coalesced to a
 *     fabricated `0`, mirroring every sibling's identical null-vs-0
 *     discipline.
 *
 *   - VERIFY CHAIN: this task's own MANDATORY first-step instruction asked
 *     for a documented fallback chain (buildinfo → `/-/ready` → a trivial
 *     instant query) rather than a single hard-coded endpoint — implemented
 *     in `verify.ts`'s `verifyPrometheus` (not here; this adapter itself has
 *     no separate "verify" concept, it just queries `/api/v1/query` for real
 *     signals whenever called). Confirmed shapes for all three legs:
 *       - `GET /api/v1/status/buildinfo` — confirmed
 *         (`prometheus.io/docs/prometheus/latest/querying/api/`), response
 *         `{status, data:{version, revision, branch, buildUser, buildDate,
 *         goVersion}}`. Confirmed ADDED IN PROMETHEUS 2.14.0 (Nov 2019, via
 *         the project's own changelog) — a sufficiently old pinned version,
 *         OR a reverse proxy that only allowlists `/api/v1/query` itself
 *         (a real, plausible "hardened Prometheus" shape a security-minded
 *         operator might run), could plausibly 404 this leg. Hence the
 *         chain, not a single endpoint.
 *       - `GET /-/ready` — confirmed
 *         (`prometheus.io/docs/prometheus/latest/management_api/`): "returns
 *         200 when Prometheus is ready to serve traffic (i.e. respond to
 *         queries)"; confirmed to need NO special flag (unlike `/-/reload`/
 *         `/-/quit`, which the SAME page confirms require
 *         `--web.enable-lifecycle` — `/-/ready` carries no such
 *         requirement), so this leg is always available on a stock
 *         Prometheus regardless of how conservatively it's configured.
 *       - A trivial instant query, `query=vector(1)` — confirmed real,
 *         documented, zero-dependency PromQL
 *         (`prometheus.io/docs/prometheus/latest/querying/functions/`:
 *         "`vector(s scalar)` converts the scalar `s` to a float sample and
 *         returns it as a single-element instant vector with no labels") —
 *         needs no stored metric to exist, the closest possible thing to "is
 *         `/api/v1/query` itself alive and syntactically functional", which
 *         is exactly what this adapter's REAL calls depend on, making this
 *         the most meaningful final leg if the first two both 404.
 *     Each leg is tried in order; a 401/403 at ANY leg is a definitive
 *     credential rejection (failed FAST, no point trying the remaining legs
 *     with the same rejected credential — see "AUTH HEURISTIC" below, "fails
 *     loudly"); any other non-2xx or a thrown network error falls through to
 *     the next leg; the LAST leg's own failure is what verify finally
 *     reports.
 *
 *   - PROMQL STRING LITERALS — ESCAPING (pin 3; confirmed from
 *     `prometheus.io/docs/prometheus/latest/querying/basics/` AND
 *     cross-checked against the PromQL lexer's own source,
 *     `promql/parser/lex.go`'s `lexEscape`, rather than trusting the prose
 *     docs alone): "PromQL follows the same escaping rules as Go. For
 *     string literals in single or double quotes, a backslash begins an
 *     escape sequence, which may be followed by `a`, `b`, `f`, `n`, `r`,
 *     `t`, `v` or `\`" — PLUS, confirmed directly from the lexer source
 *     (`lexEscape`'s own accepted-character switch), the string's OWN
 *     OPENING DELIMITER is ALSO a legal escape target (`l.stringOpen`) —
 *     meaning `\"` is valid inside a double-quoted string specifically. This
 *     module uses DOUBLE-quoted strings (matching the task's own pinned
 *     example, `job=~"<escaped-scope>"`, and every sibling adapter's
 *     double-quote convention) — NOT backtick strings, which the same docs
 *     page confirms take NO escaping at all ("escape characters are not
 *     parsed in string literals designated by backticks"), making a raw
 *     backtick character in the input UNREPRESENTABLE in that form — a
 *     strictly worse choice for arbitrary `q.scope` text than double-quoted.
 *
 *   - LABEL MATCHERS ARE REGEXES (pin 3's own "note the value is a REGEX
 *     too"): confirmed (`querying/basics/`) — `=~`/`!~` "select labels that
 *     [do not] regex-match the provided string" and "Regex matches are
 *     fully anchored. A match of `env=~"foo"` is treated as `env=~"^foo$"`"
 *     — all regexes are RE2 syntax. This adapter's pinned matcher shape is
 *     `job=~"<escaped-scope>"` (an `=~` REGEX operator) — task's own pinned
 *     resolution: "treat scope as a literal — escape regex metachars AND
 *     PromQL string chars" (BOTH layers), so `=~`'s regex power is
 *     deliberately NEUTRALIZED for v1 rather than exploited — see "TWO-LAYER
 *     ESCAPING" below for why `=~` is still the operator used (not the
 *     simpler literal-only `=`) despite this.
 *
 *   - AUTH: Prometheus itself ships with NO built-in authentication (general,
 *     well-established operational fact, and this task's own explicit
 *     framing) — in practice an instance is either wide open, or fronted by
 *     a reverse proxy's Basic auth / an oauth2-proxy's Bearer token / (since
 *     2.24) Prometheus's own `--web.config.file` `basic_auth_users`. This
 *     adapter supports BOTH shapes over a SINGLE stored secret field via a
 *     heuristic — see "AUTH HEURISTIC" below.
 *
 * AUTH HEURISTIC (task's own pinned rule, stated explicitly rather than
 * left to a catalog `secretParts` split): {@link resolvePrometheusAuth} —
 * "if the secret contains a colon, treat it as `user:pass` Basic auth
 * (split on the FIRST colon only — see below); else treat the whole string
 * as a bearer token." This is a HEURISTIC, not a certainty (a bearer token
 * COULD theoretically contain a colon; RFC 6750 doesn't forbid it, though a
 * base64url/JWT-shaped token as issued by every mainstream auth proxy never
 * does), disclosed prominently here AND in the catalog card's own
 * `credentialHint` per the task's own instruction — a wrong guess doesn't
 * corrupt anything silently: it sends the WRONG auth scheme to Prometheus,
 * which (if the instance actually enforces auth) rejects it with a clean
 * 401/403, surfacing as "Prometheus rejected this credential" at live
 * verify — "fails loudly", the task's own words, not a silent
 * misconfiguration. DISCLOSED LIMITATION, inherent to the target system, not
 * this heuristic: if the target Prometheus has NO auth layer at all (the
 * common self-hosted default), verify will report success for ANY
 * non-empty credential regardless of which scheme was guessed, or even a
 * wholly wrong one — Prometheus itself never validates the Authorization
 * header when unauthenticated, so there is nothing this adapter (or
 * verify.ts) could check further; this is a property of the target, not a
 * gap in the implementation. SPLIT ON THE FIRST COLON ONLY (not
 * `splitCompositeSecret`'s exact-part-count model, which this adapter
 * deliberately does NOT use for this field): HTTP Basic auth's OWN
 * convention (RFC 7617) is that the user-id may not itself contain a colon,
 * but the PASSWORD may — `curl -u user:pass:word` sends user=`"user"`,
 * password=`"pass:word"`, and every mainstream Basic-auth client parses it
 * the same way. `splitCompositeSecret`'s exact-2-parts model (Langfuse's
 * `pk-lf-…:sk-lf-…`, Datadog's `apiKey:appKey`) is the wrong tool here — it
 * would reject a real `user:pass:word` credential outright (3 parts against
 * a declared 2) rather than parsing it correctly, so this adapter and
 * `verify.ts` each implement their own tiny `indexOf(":")`-based split
 * instead (duplicated between the two files rather than shared — see the
 * module-level note above `resolvePrometheusAuth` for why, mirroring
 * `datadog.ts`'s/`verify.ts`'s existing `DATADOG_SITES` leaf-independence
 * precedent for a DIFFERENT kind of provider-specific constant).
 *
 * FIXED QUERY SET (task's own pinned four; "these metric names are
 * CONVENTIONS not guarantees"): all four are evaluated as INSTANT queries
 * (`time=windowEnd`) with a range selector spanning the WHOLE requested
 * window (`[<W>s]`, {@link rangeSecondsFor} — mirrors datadog.ts's
 * `rollupSecondsFor`/langfuse.ts's `timeDimension`-omission, the SAME "size
 * the query so at most one sample can form" goal via PromQL's own
 * mechanism), each wrapped in an OUTER aggregator (`sum(...)` for three of
 * them, `histogram_quantile(0.95, sum by (le)(...))` for the fourth) that
 * drops every label EXCEPT what it explicitly groups by — since none of the
 * four groups by anything real (query 3's `sum by (le)` itself gets
 * CONSUMED by `histogram_quantile`, leaving no labels at all), each query is
 * STRUCTURALLY GUARANTEED (pin 2) to return AT MOST one vector element,
 * regardless of how many underlying series/targets/histogram buckets
 * contributed to it. The client BELT ({@link fetchMetric}) never assumes
 * this held — it collects every returned, in-margin element and only THEN
 * collapses (zero → no line; one → rendered as returned; more than one →
 * honestly re-combined, `spec.beltAgg` — pinned "sum for rates/counts, max
 * for p95", documented per query below):
 *
 *   1. `prometheus.http.request_rate` — `sum(rate(http_requests_total<scope>
 *      [<W>s]))`. `beltAgg: sum` (a rate is additive across whatever
 *      series survived aggregation).
 *   2. `prometheus.http.error_rate` — the SAME query shape with an added
 *      FIXED matcher, `code=~"5.."` — see "ERROR LABEL NAME — CONFIRMED
 *      AMBIGUOUS" below for why `code` (not the plan's own believed
 *      `status`). `beltAgg: sum` (same reasoning as query 1).
 *   3. `prometheus.http.request_duration_seconds` — `histogram_quantile(0.95,
 *      sum by (le) (rate(http_request_duration_seconds_bucket<scope>
 *      [<W>s])))`. `beltAgg: max` (the task's own pinned choice for
 *      combining more than one surviving p95 value — a pragmatic v1
 *      combination, not a statistically pure merge of two p95s, same
 *      "good enough, disclosed" spirit as every sibling's own belt choice).
 *      Legitimately renders NOTHING on a window with zero HTTP request
 *      observations (`histogram_quantile` returns NaN on an all-zero
 *      histogram — confirmed, see "INSTANT QUERY" above) — an honest
 *      "no data", not a bug, mirroring sentry.ts's identical
 *      Performance-Monitoring-optional p95 gap.
 *   4. `prometheus.up.count` — `sum(up<scope>)` (a GAUGE — no `rate()`, no
 *      range selector at all: `up` is already "1 or 0, right now" per
 *      target). `beltAgg: sum` (counts how many scrape targets are up).
 *
 *   None of these four names is a guarantee any given Prometheus actually
 *   exports the underlying metric (`http_requests_total`,
 *   `http_request_duration_seconds_bucket` are WIDELY-used conventions from
 *   Prometheus's own official client-library examples and instrumentation
 *   middleware, never a spec) — an absent metric renders NO line for that
 *   query, honestly, via the SAME "zero elements survived" path as a
 *   quiet-but-real window; {@link NO_SIGNALS_MARKER}'s own text and this
 *   module's choice to never synthesize a placeholder line both keep this
 *   honest (never implies the target is idle when it may simply not
 *   instrument this metric at all).
 *
 * ERROR LABEL NAME — CONFIRMED AMBIGUOUS (task's own "check the canonical
 * label name convention... pick `status` OR make the label name part of the
 * query set honestly"): doc-verified rather than guessed. Prometheus's OWN
 * official Go client library's `promhttp.InstrumentHandlerCounter` example
 * instrumentation uses the label `code` (confirmed via
 * `github.com/prometheus/client_golang`'s own docs/examples) — AND
 * Kubernetes' own built-in `apiserver_request_total` metric (a Prometheus
 * target countless real clusters already scrape) ALSO uses `code` — the
 * closest thing to a first-party "canonical" answer this ecosystem has.
 * HOWEVER, `status`/`status_code`/`response_code` are ALSO extremely common
 * from other frameworks/exporters (Django-prometheus, various Node.js
 * middleware, nginx ingress controllers, Envoy, Istio) — genuinely split
 * across the ecosystem, exactly as the task's own text anticipated. Per the
 * Global Constraints' "docs govern over this plan's believed shapes" (the
 * T6/T7 lesson), this adapter uses the CONFIRMED first-party convention,
 * `code`, over the plan's own believed `status` — disclosed here as a
 * deliberate, doc-verified correction, not an oversight; a target using a
 * different label name legitimately renders no line for query 2 (the SAME
 * honest "convention not guarantee" gap as every other named metric above).
 *
 * TWO-LAYER ESCAPING (pin 3, "round-trip test both layers"): `q.scope`, when
 * present, is embedded as `job=~"<escaped>"` — TWO independent escaping
 * passes, applied in this order:
 *   1. REGEX-LITERAL layer ({@link escapeRegexMetachars}) — prefixes every
 *      RE2 metacharacter (`\ . + * ? ( ) | [ ] { } ^ $` — the exact set Go's
 *      own `regexp.QuoteMeta` escapes, RE2 being Go's own regex engine and
 *      the one Prometheus documents using) with a backslash, so the
 *      resulting text, once compiled as a regex, matches ONLY the ORIGINAL
 *      literal bytes — turning the `=~` REGEX operator into a de-facto exact
 *      match. This is WHY `=~` is still used (over the simpler literal-only
 *      `=`, which the task does not pin and which would sidestep this layer
 *      entirely) — the task's own pinned shape is `job=~"<escaped-scope>"`,
 *      literally, and this adapter honors that literally rather than
 *      "simplifying" to a different operator the task didn't ask for.
 *   2. PROMQL-STRING layer ({@link escapePromQLString}) — encodes the
 *      LAYER-1 output (which may itself now contain literal backslashes) as
 *      a valid PromQL double-quoted string literal SOURCE TEXT: backslash →
 *      `\\`, `"` → `\"`, plus raw control characters (`\n`/`\r`/`\t`, which
 *      cannot appear as RAW bytes inside a double-quoted string literal's
 *      source at all) → their own Go-style escape sequences. Implemented as
 *      ONE SINGLE regex-replace pass with a callback (not datadog.ts's own
 *      sequential two-`.replace()`-calls idiom) — a deliberate, slightly
 *      more robust choice for this adapter specifically: a single pass
 *      scans the ORIGINAL string exactly once (a JS spec guarantee for
 *      `String.replace` with a global pattern), so there is no possible
 *      "does an earlier pass's own output get wrongly re-processed by a
 *      later pass" ordering hazard to reason about at all, the exact class
 *      of mistake datadog.ts's own doc-comment discusses avoiding via
 *      careful pass ORDERING (backslash-before-quote) — here that
 *      discipline is structural rather than order-dependent.
 *   UNLIKE datadog.ts's `SCOPE_TAG_VALUE_RE` validate-or-ignore gate
 *   (Datadog's own tag-filter mini-grammar has NO documented escape
 *   mechanism at all, per that module's own doc-comment) — PromQL DOES have
 *   a real, complete, documented escape mechanism for arbitrary text, so
 *   THIS adapter never needs a "scope looks unsafe, fall back to unscoped"
 *   branch: {@link scopeMatcher} always succeeds for any non-empty string.
 *   Round-trip tests (`prometheus.test.ts`) simulate BOTH the PromQL
 *   unescape (decode the quoted literal back to LAYER-1's own output) AND
 *   RE2-equivalent literal-match semantics (compile the decoded regex
 *   source, fully anchored per Prometheus's own confirmed `^...$` behavior,
 *   and confirm it matches the ORIGINAL scope exactly and nothing longer/
 *   shorter) — the two-layer discipline pin 3 asks for, verified
 *   end-to-end, not just each layer's own output shape.
 *
 * Q.SCOPE MAPS TO `job=~"..."` ONLY, applied to all four queries (extra
 * per-query matchers, like query 2's fixed `code=~"5.."`, are ADDITIONAL,
 * never a replacement).
 *
 * Q.QUERY IS IGNORED FOR SIGNALS (task's own pinned rule, considered and
 * explicitly rejected the alternative): "q.query (when present) adds
 * `instance=~"<escaped>"`? NO — simpler pinned rule: q.query is ignored for
 * signals... the route already passes both, ignoring one is legal." This
 * adapter reads that literally as "ignored, full stop" — NEITHER embedded
 * server-side (ruled out explicitly, as quoted) NOR applied as a
 * client-side post-filter against each rendered signal's own identifier
 * (the convention every OTHER Wave-2 `signals` adapter — langfuse.ts,
 * sentry.ts, datadog.ts — otherwise follows). This is a deliberate,
 * disclosed DIVERGENCE from those three siblings' own client-side
 * `q.query`-matches-`{name}{labels}` convention, not an oversight: with
 * only four fixed, short signal identifiers total, a text-match filter
 * would rarely narrow anything meaningfully, and the task's own wording
 * ("signals takes scope only") reads as a full, not partial, opt-out.
 * `EvidenceQuery.query` remains a legal field the route may populate for
 * this verb regardless (the type itself is unqualified by provider) — an
 * adapter simply choosing not to consume one of the fields it's handed is
 * explicitly legal per the route's own contract, exactly as the task's own
 * parenthetical states.
 *
 * WINDOW SANITY (pin: "assert sanity... rather than dropping" — a
 * DELIBERATE divergence from every sibling's own belt-and-braces window
 * re-filter): datadog.ts/langfuse.ts/sentry.ts each DROP a returned point
 * whose OWN timestamp falls outside `[windowStart, windowEnd]`, because
 * those three providers' APIs return a SERIES of points spanning a real
 * queried range, and an out-of-range one legitimately belongs to a
 * different bucket. This adapter's underlying call is fundamentally
 * different: an INSTANT query only ever asks for ONE evaluation moment
 * (`time=windowEnd`), and Prometheus's own confirmed contract ties the
 * returned `value`'s timestamp to that SAME requested instant — there is no
 * "wrong bucket" concept here to defend against by dropping. A sample whose
 * own timestamp lands meaningfully far from the requested instant is a sign
 * the backend (`ConnectorConfig.prometheusUrl`'s own doc-comment: "or
 * Prometheus-compatible" — Thanos/Cortex/Mimir/VictoriaMetrics are all
 * explicitly in scope) snapped or rewrote the timestamp, not that the DATA
 * itself is untrustworthy — so {@link fetchMetric} KEEPS and renders every
 * parsed sample regardless (never drops on a window/margin mismatch), at
 * its own REAL returned timestamp (never fabricated — mirrors every
 * sibling's "never render a fabricated timestamp for real data" rule
 * exactly), and separately logs a one-line `console.warn` when a sample
 * lands outside a generous {@link EVAL_MARGIN_MS} margin of the requested
 * instant, so an operator can notice a clock-skewed/non-compliant backend
 * without evidence capture itself failing or silently losing the point. The
 * BELT case (>1 surviving element — a REAL synthesized combination) is
 * stamped at `windowEnd` instead, mirroring datadog.ts's/langfuse.ts's
 * identical "no single point's timestamp is more correct for a synthesized
 * value" fallback — unaffected by this adapter's own single-sample "never
 * drop" divergence, which only concerns whether to KEEP a point, not where
 * a MULTI-point combination gets stamped.
 *
 * RENDERING: the Global Constraints' pinned `signal {name}{labels}
 * window_agg={agg} value={n} at={iso}` — `{labels}` is the EXACT matcher
 * block actually sent in the query for that metric (scope matcher, if any,
 * plus that metric's own fixed extras, e.g. query 2's `code=~"5.."`, comma
 * joined) — a deliberate simplification over datadog.ts's own query-text/
 * render-text split (Datadog's `{*}` "match everything" placeholder is a
 * QUERY-ONLY artifact never mirrored into the render): PromQL has no
 * equivalent "universal matcher" placeholder to omit — an unscoped query
 * either has a matcher block (query 2's fixed `code=~"5.."`, present
 * regardless of scope) or has none at all (queries 1/3/4, unscoped) — so
 * the query text and the rendered `{labels}` text are simply the SAME
 * string, computed once per metric per call, with nothing to reconcile.
 * Capped `Math.max(1, q.limit ?? 50)` — structurally unreachable in
 * practice (task's own "cap trivially satisfied (≤4 lines)": at most one
 * real line per fixed query, four fixed queries, mirrors datadog.ts's own
 * post-fix "cap structurally unreachable from this verb" observation for
 * its three metrics) — the cap machinery is kept regardless, unchanged and
 * still meaningful for a future wider query set, same reasoning datadog.ts
 * gives for its own now-unreachable cap.
 *
 * FAILURE HANDLING mirrors every sibling exactly: each of the FOUR metric
 * sub-fetches gets its OWN try/catch and a cap-exempt marker line,
 * `(signal {key}: prometheus {reason|unreachable})`, rendered first, all
 * run CONCURRENTLY (`Promise.all`). A clean 401/403 maps to `unauthorized`;
 * any other non-2xx OR a malformed/non-object 200 body maps to
 * `upstream_error` (this adapter does not further subdivide, matching every
 * sibling's own precedent). All four metrics failing at once collapses to a
 * TOP-LEVEL `upstream_error` (mirrors every sibling's identical "nothing
 * useful was learned this call" collapse).
 *
 * CONFIG_MISSING (mirrors every sibling's identical reasoning, SIMPLER than
 * every prior Wave-2 provider — see "CREDENTIAL" above for why): a null
 * `secret`, OR an absent `config.prometheusUrl`, degrade to
 * `config_missing` — neither is the caller's fault, neither is a credential
 * Prometheus itself REJECTED (that is `unauthorized`); both are connector
 * configuration gaps only reconnecting (or fixing the stored URL) resolves.
 * `prometheusUrl` is NOT re-validated for scheme here — UNLIKE
 * `datadogSite` (which needs its own allowlist re-check as the ONLY gate
 * standing between an unvalidated stored string and a fetch target, per
 * `datadog.ts`'s own doc-comment) but exactly LIKE `langfuseHost`,
 * `prometheusUrl` is ALREADY scheme-gated at WRITE time by
 * `validateUrlConfigString` (`packages/db-postgres/src/queries/
 * connectors.ts`, confirmed by reading that file directly — `prometheusUrl`
 * is one of the three URL-shaped Wave-2 fields, alongside `langfuseHost`/
 * `grafanaUrl`) — by the time a value reaches a STORED connector row, it is
 * already trusted; this adapter's own read only needs to check for
 * PRESENCE, mirroring `langfuse.ts`'s identical reasoning exactly (see
 * {@link resolvePrometheusUrl}). `verify.ts`'s OWN read, by contrast, DOES
 * re-apply the scheme gate defensively (its existing `resolveHttpUrl`
 * helper, reused verbatim — see that module's own doc-comment) because that
 * value has NOT yet passed `validateUrlConfigString` at verify-time (the
 * SAME "not yet persisted" ordering gap every Wave-2 provider's live-verify
 * hits, first documented in `verify.ts`'s "LANGFUSE HOST — THE ORDERING
 * GAP").
 *
 * REQUEST HYGIENE mirrors every sibling: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`, single attempt (no retries).
 */

const PROMETHEUS_FETCH_TIMEOUT_MS = 8000;
const QUERY_PATH = "/api/v1/query";
const SIGNALS_DEFAULT_LIMIT = 50;

// A generous tolerance for the "assert sanity, never drop" window check —
// see the module doc-comment ("WINDOW SANITY"). 5 minutes is well above any
// realistic Prometheus scrape/eval interval (typically 15s-1m) while still
// catching a genuinely wrong/stale response worth a server-side warning.
const EVAL_MARGIN_MS = 5 * 60 * 1000;

const NO_SIGNALS_MARKER = "(no matching signals)";

type AdapterResult = { ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason };

/** Mirrors `runner/evidence/route.ts`'s own `isValidIsoDate` (and every
 * sibling adapter's duplicate of it) exactly — never assumes the route
 * already validated the window first. */
function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

// ---------------------------------------------------------------------------
// Auth heuristic — see the module doc-comment, "AUTH HEURISTIC".
// ---------------------------------------------------------------------------

export type PrometheusAuth =
  | { scheme: "bearer"; token: string }
  | { scheme: "basic"; user: string; pass: string };

/**
 * `secret` contains a `:` → `user:pass` Basic auth, split on the FIRST
 * colon only (RFC 7617's own convention — a password MAY contain a colon,
 * a user-id may not); no `:` → the whole string is a bearer token. See the
 * module doc-comment for the full reasoning, including why this is NOT
 * `splitCompositeSecret` and why `verify.ts` carries its OWN duplicate of
 * this exact function rather than importing this one (leaf independence,
 * the established `DATADOG_SITES` precedent). EXPORTED solely so
 * `prometheus.test.ts` can assert this function and `verify.ts`'s
 * independent duplicate agree on the SAME table of inputs — the two
 * implementations can never silently drift apart unnoticed even though
 * there is no shared constant to Set-equality-check the way `DATADOG_SITES`
 * allowed.
 */
export function resolvePrometheusAuth(secret: string): PrometheusAuth {
  const idx = secret.indexOf(":");
  if (idx === -1) {
    return { scheme: "bearer", token: secret };
  }
  return { scheme: "basic", user: secret.slice(0, idx), pass: secret.slice(idx + 1) };
}

function prometheusAuthHeaderValue(auth: PrometheusAuth): string {
  return auth.scheme === "bearer"
    ? `Bearer ${auth.token}`
    : `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;
}

function prometheusHeaders(auth: PrometheusAuth): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: prometheusAuthHeaderValue(auth),
    "User-Agent": "agentrail-console",
  };
}

function prometheusFetch(url: string, auth: PrometheusAuth): Promise<Response> {
  return fetch(url, {
    headers: prometheusHeaders(auth),
    signal: AbortSignal.timeout(PROMETHEUS_FETCH_TIMEOUT_MS),
  });
}

/**
 * One GET, mapped to the pinned taxonomy. Deliberately NOT try/catch-wrapped
 * around the `fetch` call itself — see the module doc-comment ("FAILURE
 * HANDLING"): a thrown fetch propagates uncaught to {@link fetchMetric}'s
 * OWN try/catch (the per-metric four-way fan-out).
 */
async function prometheusRequest<T>(
  url: string,
  auth: PrometheusAuth
): Promise<{ ok: true; data: T } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await prometheusFetch(url, auth);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "unauthorized" };
  }
  if (!res.ok) {
    return { ok: false, reason: "upstream_error" };
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "upstream_error" };
  }
  return { ok: true, data: body as T };
}

// ---------------------------------------------------------------------------
// Escaping — see the module doc-comment, "TWO-LAYER ESCAPING".
// ---------------------------------------------------------------------------

// The exact RE2 metacharacter set Go's own `regexp.QuoteMeta` escapes
// (confirmed via that function's own source — Prometheus documents using
// RE2, Go's regex engine). A single global-regex pass (see
// `escapePromQLString`'s own comment for why single-pass matters).
const REGEX_METACHAR_RE = /[\\.+*?()|[\]{}^$]/g;

/** LAYER 1 — makes `value`, once compiled as an (RE2/JS-equivalent) regex,
 * match ONLY its own original literal bytes. See the module doc-comment. */
function escapeRegexMetachars(value: string): string {
  return value.replace(REGEX_METACHAR_RE, "\\$&");
}

/** LAYER 2 — encodes `value` (LAYER 1's own output, which may already
 * contain literal backslashes) as a valid PromQL DOUBLE-QUOTED string
 * literal's source text. A SINGLE regex-replace pass (not sequential
 * `.replace()` calls) — see the module doc-comment for why this ordering
 * hazard, real in datadog.ts's own two-pass design, cannot occur here: a
 * global-pattern `.replace()` scans the ORIGINAL string exactly once, so an
 * escape sequence this function itself introduces is never re-scanned and
 * re-escaped by a later step, because there is no later step. */
function escapePromQLString(value: string): string {
  return value.replace(/[\\"\n\r\t]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return ch;
    }
  });
}

/** Both layers, wrapped in the double-quote delimiters — the full
 * `"<escaped>"` text embedded after `job=~` in {@link scopeMatcher}. */
function quoteScopeAsLiteralRegex(scope: string): string {
  return `"${escapePromQLString(escapeRegexMetachars(scope))}"`;
}

/** The `job=~"<escaped-scope>"` matcher for a present, non-empty `q.scope`
 * — see the module doc-comment ("Q.SCOPE") for why this always succeeds
 * (no validate-or-ignore fallback needed, unlike datadog.ts's `q.scope`
 * handling). */
function scopeMatcher(scope: string): string {
  return `job=~${quoteScopeAsLiteralRegex(scope)}`;
}

/** The full `{matcher,matcher,...}` block for one metric — `q.scope`'s own
 * matcher (if present) FIRST, then that metric's own fixed extra matchers
 * (query 2's `code=~"5.."`) — comma-joined, or `""` (no braces at all, a
 * syntactically legal PromQL selector) when there is nothing to filter by. */
function matchersBlock(scope: string | undefined, extraMatchers: readonly string[]): string {
  const matchers: string[] = [];
  if (scope) matchers.push(scopeMatcher(scope));
  matchers.push(...extraMatchers);
  return matchers.length > 0 ? `{${matchers.join(",")}}` : "";
}

// ---------------------------------------------------------------------------
// The fixed query set — see the module doc-comment, "FIXED QUERY SET".
// ---------------------------------------------------------------------------

interface MetricSpec {
  /** Used only in this metric's own failure marker text. */
  key: string;
  /** The rendered `signal {name}` identifier. */
  name: string;
  /** The rendered `window_agg=` value. */
  aggLabel: "sum" | "p95";
  /** How {@link fetchMetric}'s belt honestly combines >1 surviving element
   * — pinned "sum for rates/counts, max for p95". */
  beltAgg: "sum" | "max";
  /** This metric's own FIXED extra label matchers, beyond `q.scope`'s own —
   * literal PromQL text, never derived from any caller input, so nothing
   * here ever needs escaping. */
  extraMatchers: readonly string[];
  buildQuery: (labelsBlock: string, windowSeconds: number) => string;
}

// See the module doc-comment, "ERROR LABEL NAME — CONFIRMED AMBIGUOUS", for
// the full doc-verify trail behind `code` over the plan's own believed
// `status`.
const ERROR_CODE_MATCHER = 'code=~"5.."';

function metricSpecs(): MetricSpec[] {
  return [
    {
      key: "request_rate",
      name: "prometheus.http.request_rate",
      aggLabel: "sum",
      beltAgg: "sum",
      extraMatchers: [],
      buildQuery: (labels, w) => `sum(rate(http_requests_total${labels}[${w}s]))`,
    },
    {
      key: "error_rate",
      name: "prometheus.http.error_rate",
      aggLabel: "sum",
      beltAgg: "sum",
      extraMatchers: [ERROR_CODE_MATCHER],
      buildQuery: (labels, w) => `sum(rate(http_requests_total${labels}[${w}s]))`,
    },
    {
      key: "p95_duration",
      name: "prometheus.http.request_duration_seconds",
      aggLabel: "p95",
      beltAgg: "max",
      extraMatchers: [],
      buildQuery: (labels, w) =>
        `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket${labels}[${w}s])))`,
    },
    {
      key: "up",
      name: "prometheus.up.count",
      aggLabel: "sum",
      beltAgg: "sum",
      extraMatchers: [],
      buildQuery: (labels) => `sum(up${labels})`,
    },
  ];
}

/** The range-selector width (`[<W>s]`) — sized to the WHOLE queried window
 * so at most one sample can form per query, by construction. Mirrors
 * datadog.ts's `rollupSecondsFor` exactly (ceil'd from the original
 * millisecond bounds, floored to a 1-second minimum defensively — never
 * assumes `windowEnd > windowStart`). */
function rangeSecondsFor(windowStart: string, windowEnd: string): number {
  const spanMs = new Date(windowEnd).getTime() - new Date(windowStart).getTime();
  return Math.max(1, Math.ceil(spanMs / 1000));
}

/** `time=windowEnd` rides UNCONVERTED (see the module doc-comment,
 * "INSTANT QUERY") — no seconds/milliseconds unit conversion anywhere on
 * this adapter's request side. */
function buildQueryUrl(base: string, promql: string, windowEndIso: string): string {
  const params = new URLSearchParams({ query: promql, time: windowEndIso });
  return `${base}${QUERY_PATH}?${params}`;
}

/** `signal {name}{labels} window_agg={agg} value={n} at={iso}` — the Global
 * Constraints' pinned `signals` convention. `labels` is the metric's own
 * FULL matcher block, verbatim — see the module doc-comment, "RENDERING". */
function renderSignalLine(spec: MetricSpec, labels: string, value: number, atIso: string): string {
  return `signal ${spec.name}${labels} window_agg=${spec.aggLabel} value=${value} at=${atIso}`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface RenderedLine {
  /** Epoch ms — the sort key; never itself rendered raw. */
  at: number;
  line: string;
}

interface PrometheusVectorElement {
  metric?: unknown;
  value?: unknown;
}

interface PrometheusQueryData {
  resultType?: unknown;
  result?: unknown;
}

interface PrometheusQueryBody {
  status?: unknown;
  data?: PrometheusQueryData;
}

/** Parses one `result[]` element's `value: [<unix_time>, "<sample_value>"]`
 * pair — see the module doc-comment ("INSTANT QUERY") for the confirmed
 * shape and the NaN/+Inf/-Inf "no data" convention. `JS`'s own `Number()`
 * parses the string `"NaN"` INTO the `NaN` value but does NOT understand
 * `"+Inf"`/`"-Inf"` as numeric literals (both become `NaN` too) — either
 * way `Number.isFinite` catches all three, so no special-casing of the
 * three literal strings is needed. Timestamp is unix SECONDS (confirmed to
 * carry a fractional part in general) — converted to ms via `* 1000`,
 * rounded to avoid float noise. */
function parseSample(el: unknown): { atMs: number; value: number } | null {
  if (!el || typeof el !== "object") return null;
  const value = (el as PrometheusVectorElement).value;
  if (!Array.isArray(value) || value.length < 2) return null;
  const [tsRaw, vRaw] = value as [unknown, unknown];
  if (typeof tsRaw !== "number" || !Number.isFinite(tsRaw)) return null;
  if (typeof vRaw !== "string") return null;
  const parsed = Number(vRaw);
  if (!Number.isFinite(parsed)) return null;
  return { atMs: Math.round(tsRaw * 1000), value: parsed };
}

/** See the module doc-comment, "WINDOW SANITY" — a sample is "sane" when
 * within {@link EVAL_MARGIN_MS} of the single requested evaluation instant
 * (`windowEnd`, NOT the `[windowStart, windowEnd]` range — there is no
 * range to speak of for an instant query). Insane samples are still kept
 * and rendered (see {@link fetchMetric}); this function only decides
 * whether to log a warning. */
function isWithinEvalMargin(atMs: number, requestedAtMs: number): boolean {
  return Math.abs(atMs - requestedAtMs) <= EVAL_MARGIN_MS;
}

/** Rounds a CLIENT-SYNTHESIZED (never a raw API) belt value to 4 decimal
 * places — mirrors datadog.ts's identical `roundSynthesized` exactly, same
 * "avoid a repeating-decimal float tail" reasoning. Applied uniformly to
 * both `sum` and `max` belt outcomes for simplicity (a no-op for `max`,
 * which introduces no arithmetic of its own — cheap and harmless either
 * way). */
function roundSynthesized(value: number): number {
  return Math.round(value * 10000) / 10000;
}

type MetricOutcome = { ok: true; lines: RenderedLine[] } | { ok: false; marker: string };

/**
 * One metric's own fetch — its OWN try/catch (per-metric granularity;
 * mirrors every sibling's `fetchMetric` exactly, applied to a FIXED set of
 * four Prometheus queries run CONCURRENTLY via `Promise.all` in
 * {@link querySignals}). See the module doc-comment for "WINDOW SANITY"
 * (never drops, unlike every sibling) and "FIXED QUERY SET" (the belt
 * combination policy, `spec.beltAgg`).
 */
async function fetchMetric(
  base: string,
  auth: PrometheusAuth,
  spec: MetricSpec,
  scope: string | undefined,
  windowStart: string,
  windowEnd: string
): Promise<MetricOutcome> {
  const labels = matchersBlock(scope, spec.extraMatchers);
  const windowSeconds = rangeSecondsFor(windowStart, windowEnd);
  const promql = spec.buildQuery(labels, windowSeconds);
  const url = buildQueryUrl(base, promql, windowEnd);

  let result: Awaited<ReturnType<typeof prometheusRequest<PrometheusQueryBody>>>;
  try {
    result = await prometheusRequest<PrometheusQueryBody>(url, auth);
  } catch {
    return { ok: false, marker: `(signal ${spec.key}: prometheus unreachable)` };
  }
  if (!result.ok) {
    return { ok: false, marker: `(signal ${spec.key}: prometheus ${result.reason})` };
  }

  const data = result.data.data;
  const elements =
    data && data.resultType === "vector" && Array.isArray(data.result) ? data.result : [];

  const windowEndMs = new Date(windowEnd).getTime();
  const points: Array<{ atMs: number; value: number }> = [];
  for (const el of elements) {
    const sample = parseSample(el);
    if (!sample) continue;
    if (!isWithinEvalMargin(sample.atMs, windowEndMs)) {
      // Deliberate operator-facing diagnostic (no-console isn't an active
      // lint rule in this project — mirrors runner/evidence/route.ts's own
      // unguarded console.error calls) — see the module doc-comment,
      // "WINDOW SANITY".
      console.warn(
        `[lib/evidence/prometheus] '${spec.key}' sample at ${new Date(sample.atMs).toISOString()} ` +
          `is outside the requested instant (${new Date(windowEndMs).toISOString()}) by more than ` +
          `${EVAL_MARGIN_MS}ms — rendering it anyway, never dropped.`
      );
    }
    points.push(sample);
  }

  if (points.length === 0) {
    return { ok: true, lines: [] };
  }
  if (points.length === 1) {
    const { atMs, value } = points[0];
    return {
      ok: true,
      lines: [{ at: atMs, line: renderSignalLine(spec, labels, value, new Date(atMs).toISOString()) }],
    };
  }
  // BELT: more than one element survived — the query's own aggregation did
  // not collapse the response as designed. Never render per-element;
  // re-combine honestly per `spec.beltAgg`, stamped at windowEnd (no single
  // element's timestamp is more "correct" for a synthesized value — mirrors
  // every sibling's identical belt-timestamp fallback).
  const combined =
    spec.beltAgg === "sum"
      ? points.reduce((sum, p) => sum + p.value, 0)
      : Math.max(...points.map((p) => p.value));
  const rounded = roundSynthesized(combined);
  return {
    ok: true,
    lines: [
      { at: windowEndMs, line: renderSignalLine(spec, labels, rounded, new Date(windowEndMs).toISOString()) },
    ],
  };
}

async function querySignals(base: string, auth: PrometheusAuth, q: EvidenceQuery): Promise<AdapterResult> {
  const specs = metricSpecs();
  const outcomes = await Promise.all(
    specs.map((spec) => fetchMetric(base, auth, spec, q.scope, q.windowStart, q.windowEnd))
  );

  const allLines: RenderedLine[] = [];
  const markers: string[] = [];
  let successCount = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      successCount += 1;
      allLines.push(...outcome.lines);
    } else {
      markers.push(outcome.marker);
    }
  }

  // Every targeted metric failing at once — nothing useful was learned this
  // call. Mirrors every sibling's identical "all scopes failing" collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // q.query is DELIBERATELY IGNORED for this verb — see the module
  // doc-comment, "Q.QUERY IS IGNORED FOR SIGNALS". No client-side re-filter
  // here, unlike every sibling `signals` adapter.
  if (allLines.length === 0 && markers.length === 0) {
    return { ok: true, raw: NO_SIGNALS_MARKER };
  }

  // Most-recent-first — consistent with every sibling's identical choice
  // (no verb-specific ordering pinned for `signals`).
  allLines.sort((a, b) => b.at - a.at);

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors every sibling
  // adapter's identical discipline. Floor-clamped so limit:0 (or negative)
  // can't slice a non-empty result down to a bare "" that bypasses the
  // honest-empty marker above.
  const limit = Math.max(1, q.limit ?? SIGNALS_DEFAULT_LIMIT);
  const cappedLines = allLines.slice(0, limit).map((l) => l.line);
  return { ok: true, raw: [...markers, ...cappedLines].join("\n") };
}

// ---------------------------------------------------------------------------

/** Presence + trim + trailing-slash-strip ONLY — see the module doc-comment
 * ("CONFIG_MISSING") for why this adapter, unlike `datadog.ts`'s
 * `resolveDatadogSite`, does NOT re-validate scheme here (mirrors
 * `langfuse.ts`'s identical `host.replace(/\/+$/, "")` read exactly —
 * `prometheusUrl` is already scheme-gated at write time). */
function resolvePrometheusUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

export const prometheusAdapter: EvidenceAdapter = {
  provider: "prometheus",
  verbs: ["signals"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "signals":
        break;
      default:
        // This adapter declares only [signals] — the route never asks it
        // for a verb it didn't declare, but a direct caller (this module's
        // own tests included) is not bound by that, so this stays
        // defensive rather than throwing (mirrors every sibling adapter's
        // identical default case).
        return { ok: false, reason: "bad_request" };
    }

    // See the module doc-comment ("CONFIG_MISSING") — cheapest check (no DB
    // read needed) first, same order as every sibling.
    if (!secret) {
      return { ok: false, reason: "config_missing" };
    }

    const row = await getConnector(workspaceId, "prometheus");
    const base = resolvePrometheusUrl(row?.config.prometheusUrl);
    if (!base) {
      return { ok: false, reason: "config_missing" };
    }

    const auth = resolvePrometheusAuth(secret);
    return querySignals(base, auth, q);
  },
};

registerAdapter(prometheusAdapter);
