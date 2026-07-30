import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import { splitCompositeSecret } from "./composite-secret";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `datadog` evidence adapter (Task P4, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The fourth Wave-2 provider — every
 * mechanism it needs (composite secrets, config pass-through for live
 * verify, a documented-site allowlist gate on an untrusted fetch-target
 * config value, quoted free text with a round-trip-tested unescape) was
 * established by P0-P3; this module composes them, it invents nothing new
 * except the site allowlist (P2/P3 had no fetch-target config value to
 * validate — `langfuseHost`/`sentryOrg` are either scheme-gated generically
 * by `validateUrlConfigString` or not URL-shaped at all).
 *
 * `verbs: ["signals", "search_events"]`: `signals` returns three
 * pre-aggregated USE-shaped host metrics (CPU, load, memory) over the
 * window; `search_events` searches Datadog Log Management for messages
 * matching a free-text term.
 *
 * CREDENTIAL: a COMPOSITE secret, `apiKey:appKey` (Task P0's
 * `secretParts`/`splitCompositeSecret` mechanism, same shape as
 * langfuse.ts's `pk-lf-…:sk-lf-…` pair). Datadog's own docs (confirmed
 * below) require BOTH keys on every read call, unlike Langfuse/Sentry's
 * single-secret-suffices-for-reads shape.
 *
 * DATADOG API SHAPES — confirmed against Datadog's own docs
 * (docs.datadoghq.com) during implementation (this task's mandatory first
 * step; NOT trusted from memory):
 *
 *   - Auth headers: `DD-API-KEY: <apiKey>` + `DD-APPLICATION-KEY: <appKey>`
 *     — confirmed via every fetched endpoint's own curl example
 *     (`/api/v1/query`, `/api/v2/validate_keys`, `/api/v2/logs/events/search`
 *     all show both headers). `docs.datadoghq.com/api/latest/authentication/`
 *     itself states it more generally: "Requests that write data require...
 *     an API key. Requests that READ data require full access and ALSO
 *     require an application key" — every verb this adapter implements is a
 *     read, so BOTH keys are mandatory on every call, confirming the task's
 *     own premise.
 *
 *   - SITE ROUTING: `https://api.{site}` — confirmed via the regional
 *     endpoint tables on `docs.datadoghq.com/api/latest/metrics` (9 rows)
 *     and `docs.datadoghq.com/getting_started/site/` (the "Site Parameter"
 *     column, which is the EXACT string the `api.` host is built from,
 *     distinct from that page's "Site URL" column — the web UI's `app.`
 *     host, which this adapter never uses). The 9 confirmed values are
 *     {@link DATADOG_SITES} below. Datadog is SaaS-only (no self-host
 *     option, unlike Langfuse/Prometheus/Grafana) — this is a genuinely
 *     CLOSED, small, documented set, which is why this adapter uses a
 *     STRICT ALLOWLIST rather than the scheme-only gate
 *     `validateUrlConfigString` (`packages/db-postgres/src/queries/
 *     connectors.ts`) applies to `langfuseHost`/`prometheusUrl`/
 *     `grafanaUrl` — those three legitimately need to accept an operator's
 *     own self-host origin, so a scheme gate is the right (and only
 *     possible) bound; Datadog has no such legitimate variability, so a
 *     closed allowlist is BOTH safe and loses nothing. `datadogSite` itself
 *     is validated at WRITE time only via `validateSimpleConfigString` (a
 *     bare non-empty-string, ≤256-chars check, confirmed by reading
 *     `queries/connectors.ts` directly — it is NOT one of that file's three
 *     URL-shaped fields) — this adapter is the ONLY place the site is ever
 *     checked against the allowlist before becoming a `fetch` target (see
 *     {@link resolveDatadogSite}).
 *
 *   - VERIFY ENDPOINT: `GET /api/v2/validate_keys` (confirmed — NOT the
 *     plan's believed `/api/v1/validate`, which a WebSearch of Datadog's own
 *     docs confirms validates the API key ONLY, never exercising the
 *     application key at all). `/api/v2/validate_keys`'s own docs state
 *     plainly: "Check that the API key and application key used for the
 *     request are both valid" — a single side-effect-free GET that
 *     genuinely exercises the composite pair this connector stores, exactly
 *     the task's own "find the cheapest read that validates BOTH" request.
 *     Response `{"status":"ok"}` on success.
 *
 *   - SIGNALS (metrics query): `GET /api/v1/query?from=&to=&query=` —
 *     confirmed (`docs.datadoghq.com/api/latest/metrics`, cross-checked via
 *     context7's indexed copy of the same page, including a working
 *     TypeScript/Python/curl example each). `from`/`to` are EPOCH SECONDS
 *     (confirmed twice over: the param doc says "seconds since the Unix
 *     epoch", and the official TS/Python examples both divide a
 *     millisecond `Date`/`datetime` by 1000 to build them) — but the
 *     RESPONSE's own `pointlist` entries are `[epoch_MILLISECONDS, value]`
 *     pairs (confirmed via the docs' own worked response example, whose
 *     `pointlist`/`from_date`/`to_date` values are unambiguously
 *     millisecond-scale, e.g. `1681683300000`). This SECONDS-request /
 *     MILLISECONDS-response asymmetry is real, confirmed, and easy to get
 *     backwards — see {@link fetchMetric}'s own doc-comment for how this
 *     adapter handles the two directions independently rather than reusing
 *     one conversion constant for both. Response shape: `{status, series:
 *     [{metric, scope, pointlist: [[atMs, value|null], ...], ...}]}`.
 *     NO-MATCH BEHAVIOR (task's own "confirm what happens with no matching
 *     series"): could not find a first-party Datadog statement pinning this
 *     exactly for `/api/v1/query` itself — the closest documented signal
 *     found (a DataDog/datadog-agent GitHub issue) describes a DIFFERENT
 *     component (the Kubernetes Cluster Agent's External Metrics Provider,
 *     which wraps this same query for HPA autoscaling) returning a
 *     synthesized 422 for "no series found" — that is a distinct code path
 *     from the public REST endpoint this adapter calls directly, and a
 *     second, independent source explicitly distinguishes the two ("empty
 *     series responses with status 200/OK are expected behavior when a
 *     query matches no data points" — the plain-REST-API behavior, not the
 *     Cluster Agent's). Given the residual ambiguity, this adapter is
 *     written to be CORRECT UNDER EITHER OUTCOME rather than betting on
 *     one: a 200 with `series: []` (or absent) contributes zero lines with
 *     `ok: true` (no marker — an empty result is not a failure, mirroring
 *     P2/P3's identical "zero usable points, still success" per-metric
 *     handling); any NON-2xx status (whatever Datadog might actually return
 *     for a genuinely malformed query) falls through the existing
 *     `datadogRequest` taxonomy into a cap-exempt per-metric failure marker,
 *     the same as a real outage. Neither branch requires the ambiguity to
 *     be resolved.
 *
 *   - SIGNALS' THREE METRICS are this adapter's own disclosed judgment call
 *     (mirrors langfuse.ts's/sentry.ts's identical disclosed picks) — see
 *     {@link metricSpecs}'s own doc-comment for why USE-shaped Datadog Agent
 *     defaults were chosen over a RED-shaped APM metric set.
 *
 *   - SEARCH_EVENTS (log search): `POST /api/v2/logs/events/search` —
 *     confirmed (`docs.datadoghq.com/api/latest/logs`, cross-checked via
 *     context7 against multiple client-library examples in different
 *     languages, all agreeing on the same body shape). Body: `{filter:
 *     {query?, from, to, indexes?}, sort?, page?: {limit?}}`. `filter.from`/
 *     `filter.to` are ISO-8601 STRINGS (confirmed via several worked
 *     examples, e.g. `"2020-09-17T11:48:36+01:00"`) — UNLIKE the metrics
 *     endpoint above, these ride straight through from `EvidenceQuery`'s own
 *     ISO strings with NO unit conversion, a genuine and easy-to-conflate
 *     difference between this adapter's two verbs. `filter.query` is
 *     OPTIONAL and, per a confirmed worked example that omits it entirely
 *     (`{filter:{from,to}}`, no `query` key at all) while still returning
 *     scoped results, its absence means "match everything in the window" —
 *     UNLIKE Sentry's `is:unresolved` implicit-narrowing default, there is
 *     no hidden default to override here, so this adapter OMITS
 *     `filter.query` entirely when `q.query` is absent, rather than Sentry's
 *     "always send, even blank" convention (see "Q.QUERY" below). `sort`:
 *     the wire values are the literal strings `"timestamp"` (ascending) /
 *     `"-timestamp"` (descending) — confirmed against the TypeScript
 *     client's own generated model source
 *     (`packages/datadog-api-client-v2/models/LogsSort.ts`,
 *     `github.com/DataDog/datadog-api-client-typescript`): `export const
 *     TIMESTAMP_ASCENDING = "timestamp"`. `page.limit`: confirmed default
 *     100 / max 1000 for this endpoint — see {@link LOGS_PAGE_LIMIT}'s own
 *     comment for why this adapter requests the confirmed max rather than
 *     the default. Response: `{data: [{id, attributes: {message, timestamp,
 *     service, status, ...}}], meta}` — `status`/`service` fields confirmed
 *     via multiple worked response examples (e.g. `"status": "info"`,
 *     `"service": "datadog.agent"`), a direct match for the task's own
 *     pinned `log {status|-} {service|-} ...` render format.
 *
 *   - LOG SEARCH SYNTAX — QUOTING (pin 3): confirmed directly from
 *     `docs.datadoghq.com/logs/explorer/search_syntax/` (quoted verbatim,
 *     not paraphrased): a bare double-quoted phrase, `"hello world"`,
 *     "searches only the log message for hello and dolly words" (a
 *     MESSAGE-field phrase search — the exact field this adapter's own
 *     rendered `"{message}"` line reflects, a clean match with no `*:`
 *     all-attributes prefix needed). "The following characters are
 *     considered special and require escaping with the `\` character: `-`
 *     `!` `&&` `||` `>` `>=` `<` `<=` `(` `)` `{` `}` `[` `]` `"` `*` `?`
 *     `:` `\` `#`, and spaces" — CRITICALLY, unlike Sentry's grammar (whose
 *     own confirmed parser source had NO `\\`-to-`\` production at all, the
 *     exact thing Task P3's Fix Round 1 CODA got burned by assuming without
 *     checking), Datadog's OWN documented reserved-character list
 *     explicitly INCLUDES the backslash character itself — meaning `\`
 *     DOES need escaping here, and blindly copying Sentry's corrected
 *     "never double a backslash" fix would be WRONG for Datadog
 *     specifically. See {@link quoteLogSearchText}'s own doc-comment for the
 *     full quoting design and why wrapping the whole query in a double-quoted
 *     phrase is sufficient (matches the docs' own stated equivalence,
 *     `@my_attribute:hello\:world` OR `@my_attribute:"hello:world"` — quoting
 *     neutralizes the reserved-character list without needing to escape each
 *     one individually; only the quote delimiter itself and the escape
 *     character itself need their own escaping inside the quotes, the
 *     standard shape of every quoted-string grammar this codebase has
 *     touched so far).
 *
 * Q.SCOPE (`signals` only — task's own explicit instruction: "design 2-4
 * fixed RED/USE-shaped queries... parameterized by q.scope as a tag
 * filter"): embedded as a `{service:<scope>}` tag filter on all three fixed
 * metric queries when present; `search_events` does NOT read `q.scope` at
 * all — no sibling adapter uses `q.scope` for its search-like verb either,
 * and the task's own instruction scopes this to `signals` specifically, so
 * this adapter does not scope-creep beyond what's pinned. Datadog's metric
 * tag-filter mini-grammar (`{key:value,key2:value2}`) has NO documented
 * quote/escape mechanism at all (unlike the log search grammar above) — so
 * pin 3's "quote/escape per the provider's documented semantics" cannot be
 * satisfied by quoting here; instead this adapter VALIDATES `q.scope`
 * against a conservative safe-charset allowlist ({@link SCOPE_TAG_VALUE_RE})
 * before embedding it, and silently falls back to the unscoped `{*}` filter
 * for anything that doesn't match (never a partial/best-effort escape of a
 * grammar with no defined escape unit to round-trip against) — a
 * validate-or-ignore gate is the correct, safe mechanism for a DSL with no
 * quoting primitive, not an oversight of pin 3's intent.
 *
 * RENDERING: `signals` — the Global Constraints' pinned `signal
 * {name}{labels} window_agg={avg|max|p95...} value={n} at={iso}`, one line
 * PER RETURNED POINT (never assumes exactly one), capped
 * `Math.max(1, q.limit ?? 50)`. `search_events` — the task's own pinned
 * `log {status|-} {service|-} "{message-first-120-chars}" at={iso}`,
 * chronological (ascending — ordering the task's own brief pins
 * explicitly), capped `Math.max(1, q.limit ?? 200)`, keeping the MOST
 * RECENT entries when over cap (railway.ts's/sentry.ts's identical "keep
 * the tail of the ascending sort" reasoning — not itself pinned by this
 * task, so mirrored from the established sibling precedent rather than
 * invented fresh).
 *
 * WINDOW FILTERING: server-side (`from`/`to` on both endpoints, in each
 * endpoint's own confirmed unit) AND client-side (belt-and-braces, every
 * sibling's identical doctrine, unqualified by verb) — every log's own
 * `attributes.timestamp` and every metric point's own `pointlist[0]`
 * millisecond timestamp is re-checked against `[windowStart, windowEnd]`
 * regardless of what the server-side params already did.
 *
 * Q.QUERY (`search_events`): quoted via {@link quoteLogSearchText} before it
 * ever reaches `filter.query` (pin 3). The CLIENT-side re-filter is,
 * DELIBERATELY, a substring match against the FULL RENDERED LINE — NOT
 * message-only the way langfuse.ts's `name` re-filter or sentry.ts's
 * `title` re-filter are scoped. This is an explicit, task-pinned deviation
 * from those two siblings' "match one specific field" convention (this
 * task's own brief: "client-side substring re-filter on the rendered
 * line"), not an oversight — a caller can therefore match on `status=`/
 * `service=` text too, not just the message. `signals` has no verb-pinned
 * `q.query` wording and, mirroring langfuse.ts's/sentry.ts's own
 * generalization, matches against each signal's `{name}{labels}` identifier
 * specifically (CLIENT-SIDE ONLY — none of {@link metricSpecs}'s three
 * fixed queries ever vary by `q.query`, the same "free text never changes
 * WHICH fixed metrics run" restraint P5's own pinned caution states for a
 * different provider).
 *
 * FAILURE HANDLING mirrors every sibling exactly: `search_events` is a
 * SINGLE-SCOPE, single-page fetch — NOT try/catch-wrapped locally (a thrown
 * fetch propagates uncaught to the route, converted to `unreachable`).
 * `signals`' THREE metric sub-fetches each get their own try/catch and a
 * cap-exempt marker line, `(signal {key}: datadog {reason|unreachable})`,
 * rendered first. A clean 401/403 maps to `unauthorized`; any other non-2xx
 * OR a malformed/non-object 200 body maps to `upstream_error` (this adapter
 * does not further subdivide, matching every sibling's own precedent).
 *
 * CONFIG_MISSING (mirrors every sibling's identical reasoning): a null
 * `secret`, a `secret` that fails `splitCompositeSecret`, OR an absent /
 * not-on-the-allowlist `config.datadogSite` all degrade to `config_missing`
 * — none is the caller's fault, none is a credential Datadog itself
 * REJECTED (that is `unauthorized`); every one is a connector configuration
 * gap only reconnecting (or fixing the stored site) resolves. An
 * allowlist-rejected site is deliberately folded into the SAME reason as
 * "absent" (not a new taxonomy entry) — from the caller's perspective it is
 * equally "this connector isn't usably configured," and a malicious/garbled
 * stored site value is exactly the shape `config_missing` already exists to
 * describe defensively, per {@link resolveDatadogSite}'s own doc-comment.
 *
 * REQUEST HYGIENE mirrors every sibling: an 8s `AbortSignal.timeout` per
 * request, `User-Agent: agentrail-console`.
 */

const DATADOG_FETCH_TIMEOUT_MS = 8000;
const METRICS_PATH = "/api/v1/query";
const LOGS_SEARCH_PATH = "/api/v2/logs/events/search";

// Datadog's own confirmed default (100) / max (1000) page size for
// `/api/v2/logs/events/search`'s `page.limit`. This adapter requests the
// CONFIRMED MAX in its single (no cursor-following — task's own "single
// page, no retries" pin) fetch, rather than the smaller default — unlike
// sentry.ts's SEARCH_EVENTS_PAGE_SIZE=100 (Sentry's own confirmed max,
// which sits BELOW that adapter's 200-line render default and so can never
// actually fill it), requesting Datadog's confirmed max here means this
// adapter's fetch-side bound does not needlessly undercut the render-side
// default cap below. A window with more than 1000 in-window logs still
// under-reports — a disclosed, accepted v1 bound, same spirit as every
// sibling's single-page discipline.
const LOGS_PAGE_LIMIT = 1000;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;
const SIGNALS_DEFAULT_LIMIT = 50;

// Pinned "TITLES ARE UNTRUSTED TEXT" discipline (github.ts's own doc-comment)
// applied to log messages — the one adapter-side transformation, nothing
// else. The task's own pinned render format spells this out explicitly:
// "message-first-120-chars".
const MESSAGE_MAX_LEN = 120;

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

/** The one adapter-side message transformation the task pins for this
 * verb's free-text field (github.ts's "TITLES ARE UNTRUSTED TEXT"
 * precedent, applied here to log messages instead of PR/issue titles). */
function truncateMessage(message: string): string {
  const collapsed = singleLine(message);
  return collapsed.length > MESSAGE_MAX_LEN ? collapsed.slice(0, MESSAGE_MAX_LEN) : collapsed;
}

/** Declares this connector's two-part credential shape for
 * `splitCompositeSecret` — display metadata only (`{name}` strings), not
 * imported from the catalog so this adapter stays independent of
 * `connector-helpers.ts` (mirrors langfuse.ts, the first composite
 * adapter). Must match `connector-helpers.ts`'s real `datadog` catalog
 * entry's `secretParts` in SHAPE (two parts) — the ORDER (API key first,
 * application key second) is what actually matters, since only
 * `parts.length` and positional indexing are used below. EXPORTED solely so
 * `datadog.test.ts` can assert this constant's part count against the real
 * catalog entry's `secretParts.length` directly (pin 4) — the two
 * declarations can never silently drift apart unnoticed. This does NOT
 * create a runtime dependency on the catalog; only the TEST imports both. */
export const DATADOG_SECRET_SPEC = {
  secretParts: [{ name: "API key" }, { name: "Application key" }],
};

/**
 * The 9 confirmed Datadog site parameter values (this module's own
 * doc-comment, "SITE ROUTING") — the exact strings the `https://api.{site}`
 * host is built from. `config.datadogSite` is UNVALIDATED beyond "a
 * non-empty string ≤256 chars" at write time (confirmed by reading
 * `packages/db-postgres/src/queries/connectors.ts` directly —
 * `validateSimpleConfigString`, not the URL-scheme-gated
 * `validateUrlConfigString` the wave's three self-hostable fields use), so
 * THIS function is the only gate standing between an arbitrary stored
 * string and becoming a `fetch` target — treated with the same "this
 * becomes part of a URL we hand to `fetch`" seriousness as `verify.ts`'s
 * own `resolveHttpUrl`, just via a closed allowlist instead of a scheme
 * check (see the module doc-comment for why an allowlist is the right, not
 * merely adequate, choice specifically for Datadog). Case-insensitive
 * (trimmed + lowercased before the membership check) since a site value is
 * a hostname component, not a case-sensitive token. Returns `null` for
 * anything not an exact match — including a value that merely CONTAINS a
 * real site as a substring (e.g. `datadoghq.com.attacker.example`), which a
 * permissive regex could wrongly accept but an exact Set membership check
 * cannot. */
const DATADOG_SITES = new Set([
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ddog-gov.com",
  "us2.ddog-gov.com",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
]);

function resolveDatadogSite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return DATADOG_SITES.has(trimmed) ? trimmed : null;
}

function datadogHeaders(apiKey: string, appKey: string, extra?: Record<string, string>): HeadersInit {
  return {
    Accept: "application/json",
    "DD-API-KEY": apiKey,
    "DD-APPLICATION-KEY": appKey,
    "User-Agent": "agentrail-console",
    ...extra,
  };
}

function datadogFetch(
  url: string,
  apiKey: string,
  appKey: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<Response> {
  return fetch(url, {
    method: init?.method,
    body: init?.body,
    headers: datadogHeaders(apiKey, appKey, init?.headers),
    signal: AbortSignal.timeout(DATADOG_FETCH_TIMEOUT_MS),
  });
}

/**
 * One request (GET or POST — both this adapter's endpoints share the same
 * status/body-shape taxonomy), mapped to the pinned reason set. Deliberately
 * NOT try/catch-wrapped around the `fetch` call itself — see this module's
 * own doc-comment ("FAILURE HANDLING"): a thrown fetch propagates uncaught
 * to whichever caller needs that (the route, for the single-scope
 * `search_events` fetch; `fetchMetric`'s OWN try/catch, for the
 * three-metric `signals` fan-out).
 */
async function datadogRequest<T>(
  url: string,
  apiKey: string,
  appKey: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ ok: true; data: T } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await datadogFetch(url, apiKey, appKey, init);
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
// search_events (Log Search)
// ---------------------------------------------------------------------------

interface RenderedLine {
  /** Epoch ms — the sort key; never itself rendered raw. */
  at: number;
  line: string;
}

interface LogEntry {
  attributes?: {
    message?: unknown;
    timestamp?: unknown;
    service?: unknown;
    status?: unknown;
  };
}

/** `log {status|-} {service|-} "{message}" at={iso}` — this task's own
 * pinned field order. */
function renderLogLine(status: string, service: string, message: string, atIso: string): string {
  return `log ${status} ${service} "${message}" at=${atIso}`;
}

/**
 * Wraps free text in Datadog's documented quoted-phrase syntax before it
 * rides in `filter.query` — see the module doc-comment ("LOG SEARCH SYNTAX
 * — QUOTING") for the confirmed docs text this implements. UNLIKE
 * sentry.ts's `quoteSearchText` (whose Fix Round 1 CODA discovered Sentry's
 * grammar has NO `\\`-to-`\` production, so doubling a backslash there was
 * a real regression), Datadog's OWN documented reserved-character list
 * explicitly names the backslash character itself as needing escaping —
 * this function therefore DOES double a literal backslash (`\` → `\\`)
 * before escaping the quote delimiter (`"` → `\"`), the conventional order
 * for a grammar that defines `\\` as "one literal backslash" (running the
 * backslash pass FIRST means the backslash the quote-escaping pass
 * introduces is never itself re-escaped by a later pass — order matters and
 * is deliberate, not incidental). The whole thing is then wrapped in `"`
 * delimiters, producing a MESSAGE-field phrase search (confirmed: a bare
 * `"..."` query is documented to search the message field specifically —
 * see the module doc-comment). Called unconditionally on every non-empty
 * `q.query` (mirrors sentry.ts's FOLD 1 "quoted always" uniformity). See
 * `datadog.test.ts`'s round-trip describe block for tests that decode this
 * function's wire output back through Datadog's OWN documented escape rule
 * and assert the original text is recovered exactly — the exact discipline
 * that would have caught Sentry's coda regression before it shipped. */
function quoteLogSearchText(text: string): string {
  const backslashesEscaped = text.replace(/\\/g, "\\\\");
  const quotesEscaped = backslashesEscaped.replace(/"/g, '\\"');
  return `"${quotesEscaped}"`;
}

interface LogsSearchBody {
  filter: { from: string; to: string; query?: string };
  sort: string;
  page: { limit: number };
}

function buildLogsSearchBody(windowStart: string, windowEnd: string, query: string | undefined): LogsSearchBody {
  const filter: LogsSearchBody["filter"] = { from: windowStart, to: windowEnd };
  // Confirmed: `filter.query` is OPTIONAL and its absence means "match
  // everything in the window" (a real worked example omits the key
  // entirely) — UNLIKE sentry.ts, which always sends an explicit "" to
  // override a hidden default. There is no equivalent hidden default here,
  // so this adapter omits the key rather than sending a value with nothing
  // to override (see the module doc-comment, "SEARCH_EVENTS").
  if (query) {
    filter.query = quoteLogSearchText(query);
  }
  return {
    filter,
    sort: "timestamp", // ascending — confirmed wire value (LogsSort.ts)
    page: { limit: LOGS_PAGE_LIMIT },
  };
}

/** Parses + belt-and-braces window-re-filters (never trusts the server-side
 * `filter.from`/`filter.to` alone — same doctrine as every sibling
 * adapter's identical re-filter) fetched log entries into candidate
 * rendered lines. An entry missing `attributes` or an unparseable
 * `attributes.timestamp` is skipped rather than throwing. */
function parseLogs(entries: LogEntry[], windowStart: string, windowEnd: string): RenderedLine[] {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const out: RenderedLine[] = [];
  for (const entry of entries) {
    const attrs = entry.attributes;
    if (!attrs || typeof attrs !== "object") continue;
    const tsRaw = typeof attrs.timestamp === "string" ? attrs.timestamp : null;
    if (!tsRaw) continue;
    const atMs = new Date(tsRaw).getTime();
    if (Number.isNaN(atMs)) continue;
    if (atMs < startMs || atMs > endMs) continue;

    const status = typeof attrs.status === "string" && attrs.status ? attrs.status : "-";
    const service = typeof attrs.service === "string" && attrs.service ? attrs.service : "-";
    const message = typeof attrs.message === "string" ? truncateMessage(attrs.message) : "";

    out.push({ at: atMs, line: renderLogLine(status, service, message, new Date(atMs).toISOString()) });
  }
  return out;
}

async function querySearchEvents(
  base: string,
  apiKey: string,
  appKey: string,
  q: EvidenceQuery
): Promise<AdapterResult> {
  const body = buildLogsSearchBody(q.windowStart, q.windowEnd, q.query);
  const result = await datadogRequest<{ data?: unknown }>(`${base}${LOGS_SEARCH_PATH}`, apiKey, appKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok) return result;

  const entries = Array.isArray(result.data.data) ? (result.data.data as LogEntry[]) : [];
  let candidates = parseLogs(entries, q.windowStart, q.windowEnd);

  // Task's own pin: the client-side re-filter matches the RENDERED LINE in
  // full — deliberately broader than langfuse.ts's/sentry.ts's "one named
  // field only" convention (see the module doc-comment, "Q.QUERY").
  if (q.query) {
    const needle = q.query.toLowerCase();
    candidates = candidates.filter((c) => c.line.toLowerCase().includes(needle));
  }
  if (candidates.length === 0) {
    return { ok: true, raw: NO_MATCHING_EVENTS_MARKER };
  }

  // Chronological (ascending) — this task's own pinned ordering.
  candidates.sort((a, b) => a.at - b.at);

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // every sibling adapter's identical clamp.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  // Keep the MOST RECENT `limit` lines (the tail of the ascending sort) —
  // mirrors sentry.ts's/railway.ts's identical reasoning (not itself pinned
  // by this task; mirrored from established sibling precedent).
  const capped = candidates.length > limit ? candidates.slice(candidates.length - limit) : candidates;
  return { ok: true, raw: capped.map((c) => c.line).join("\n") };
}

// ---------------------------------------------------------------------------
// signals (Metrics)
// ---------------------------------------------------------------------------

interface MetricSpec {
  /** Used only in this metric's own failure marker text. */
  key: string;
  /** The rendered `signal {name}` identifier. */
  name: string;
  /** The Datadog metric name, e.g. `system.cpu.user`. */
  metric: string;
  /** The query-string aggregator prefix AND the rendered `window_agg=`
   * value — this adapter always uses `avg` (see this function's own
   * doc-comment for why). */
  aggregator: "avg";
}

/**
 * The THREE fixed queries this adapter runs every `signals` call — a
 * disclosed judgment call (mirrors langfuse.ts's/sentry.ts's identical
 * disclosed "small RED-shaped set" picks), but for a materially different
 * reason: Langfuse's "observations" and Sentry's "issues" are FIXED PRODUCT
 * NOUNS that exist for any connected project by construction. Datadog has
 * no such universal metric name — its own confirmed APM "trace metrics"
 * family is per-integration (`trace.django.request`, `trace.express.request`,
 * …, no single cross-language name), so a RED-shaped pick would either
 * guess a framework-specific name likely absent for most accounts, or
 * require probing which integration is active (out of scope for a "2-4
 * FIXED queries" v1). This adapter instead uses THREE well-documented
 * Datadog Agent DEFAULT system-check metrics (USE-shaped: Utilization via
 * CPU, Saturation via load, a second Utilization dimension via memory) —
 * broadly present for any host running the standard Agent (Datadog's most
 * universal product surface) regardless of language/framework, though
 * still NOT guaranteed for a logs-only or serverless-only account, which
 * will legitimately see empty series for all three (an honest "no data",
 * not an error — exactly like sentry.ts's `p95_duration` on an
 * error-tracking-only project). `q.scope`, when present and safe (see the
 * module doc-comment, "Q.SCOPE"), narrows all three via a `service:` tag
 * filter — chosen over `host:` for consistency with `EvidenceQuery.scope`'s
 * own doc-comment framing ("e.g. a repo, a service name") and because
 * Datadog's Unified Service Tagging convention applies `service:` broadly
 * across both infra and APM data, not just traces. */
function metricSpecs(): MetricSpec[] {
  return [
    { key: "cpu", name: "datadog.system.cpu.user", metric: "system.cpu.user", aggregator: "avg" },
    { key: "load", name: "datadog.system.load.1", metric: "system.load.1", aggregator: "avg" },
    { key: "mem", name: "datadog.system.mem.pct_usable", metric: "system.mem.pct_usable", aggregator: "avg" },
  ];
}

/** A conservative safe-charset allowlist for embedding `q.scope` as a
 * Datadog tag VALUE — see the module doc-comment ("Q.SCOPE") for why this
 * is a validate-or-ignore gate rather than an escape function (Datadog's
 * tag-filter mini-grammar has no documented quoting mechanism to escape
 * into). Matches the shape a real service/repo name takes in practice
 * (alphanumeric, dot, underscore, hyphen) — anything else (a comma, brace,
 * colon, or space that could inject an additional tag matcher or break the
 * `{...}` structure) is rejected, and the caller falls back to the unscoped
 * query rather than risk a structurally-altered filter. */
const SCOPE_TAG_VALUE_RE = /^[A-Za-z0-9_.-]+$/;

/** The `{service:<scope>}` tag filter for a safe `q.scope`, or the
 * universal `{*}` "no filter" tag scope (Datadog's own documented "match
 * everything" idiom) when `q.scope` is absent or fails
 * {@link SCOPE_TAG_VALUE_RE}. Also doubles as the rendered `{labels}`
 * suffix (empty string for the unscoped case) — see {@link renderSignalLine}. */
function tagFilterFor(scope: string | undefined): string {
  if (scope && SCOPE_TAG_VALUE_RE.test(scope)) {
    return `{service:${scope}}`;
  }
  return "{*}";
}

function buildMetricsUrl(base: string, spec: MetricSpec, tagFilter: string, windowStart: string, windowEnd: string): string {
  // CONFIRMED: `from`/`to` are epoch SECONDS on the REQUEST side (this
  // module's own doc-comment, "SIGNALS") — the opposite unit from the
  // RESPONSE's millisecond `pointlist` timestamps, handled independently in
  // {@link fetchMetric} below.
  const fromSec = Math.floor(new Date(windowStart).getTime() / 1000);
  const toSec = Math.floor(new Date(windowEnd).getTime() / 1000);
  const query = `${spec.aggregator}:${spec.metric}${tagFilter}`;
  const params = new URLSearchParams({ from: String(fromSec), to: String(toSec), query });
  return `${base}${METRICS_PATH}?${params}`;
}

/** `signal {name}{labels} window_agg={agg} value={n} at={iso}` — the
 * Global Constraints' pinned `signals` convention. `labels` is the SAME
 * `{service:...}`/`` text {@link tagFilterFor} computed for the query
 * itself (empty string when unscoped) — so a rendered line honestly states
 * which scope (if any) the number reflects, mirroring langfuse.ts's/
 * sentry.ts's `{level="ERROR"}`-style labels convention. */
function renderSignalLine(spec: MetricSpec, labels: string, value: number, atIso: string): string {
  return `signal ${spec.name}${labels} window_agg=${spec.aggregator} value=${value} at=${atIso}`;
}

interface MetricsQueryBody {
  status?: unknown;
  series?: unknown;
}

interface DatadogSeries {
  pointlist?: unknown;
}

type MetricOutcome = { ok: true; lines: RenderedLine[] } | { ok: false; marker: string };

/**
 * One metric's own fetch — its OWN try/catch (per-metric granularity;
 * mirrors langfuse.ts's/sentry.ts's `fetchMetric` exactly, applied to a
 * FIXED set of three Datadog metrics). Each returned `pointlist` entry is
 * rendered as its OWN line (never assumes exactly one point per series, nor
 * exactly one series). UNIT HANDLING (this module's own doc-comment,
 * "SIGNALS"): a `pointlist` entry's timestamp is read as MILLISECONDS
 * DIRECTLY — no division, no multiplication — the opposite of
 * {@link buildMetricsUrl}'s own `/1000` conversion for the REQUEST params;
 * conflating the two directions was the single easiest mistake this
 * adapter could make, so they are implemented, commented, and tested
 * independently rather than sharing one "the conversion factor" constant. A
 * point whose value is `null`/non-numeric (Datadog's own "no data this
 * point" signal within an otherwise-populated series) is skipped, never
 * rendered as a fabricated `value=0`. A point whose timestamp lands outside
 * `[windowStart, windowEnd]` is skipped too (belt-and-braces — mirrors
 * every sibling adapter's identical re-filter, unqualified by verb). */
async function fetchMetric(
  base: string,
  apiKey: string,
  appKey: string,
  spec: MetricSpec,
  tagFilter: string,
  labels: string,
  windowStart: string,
  windowEnd: string
): Promise<MetricOutcome> {
  let result: Awaited<ReturnType<typeof datadogRequest<MetricsQueryBody>>>;
  try {
    result = await datadogRequest<MetricsQueryBody>(
      buildMetricsUrl(base, spec, tagFilter, windowStart, windowEnd),
      apiKey,
      appKey
    );
  } catch {
    return { ok: false, marker: `(signal ${spec.key}: datadog unreachable)` };
  }
  if (!result.ok) {
    return { ok: false, marker: `(signal ${spec.key}: datadog ${result.reason})` };
  }

  const series = Array.isArray(result.data.series) ? (result.data.series as DatadogSeries[]) : [];
  const windowStartMs = new Date(windowStart).getTime();
  const windowEndMs = new Date(windowEnd).getTime();

  const lines: RenderedLine[] = [];
  for (const s of series) {
    const pointlist = Array.isArray(s?.pointlist) ? (s.pointlist as unknown[]) : [];
    for (const point of pointlist) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [atMsRaw, valueRaw] = point as [unknown, unknown];
      if (typeof atMsRaw !== "number" || !Number.isFinite(atMsRaw)) continue;
      // Datadog's own "no data this point" signal is `null`, never
      // coalesced to 0 (langfuse.ts's/sentry.ts's identical null-vs-0
      // discipline) — skipped here rather than rendering a fabricated
      // value.
      if (typeof valueRaw !== "number" || !Number.isFinite(valueRaw)) continue;
      if (atMsRaw < windowStartMs || atMsRaw > windowEndMs) continue;

      lines.push({ at: atMsRaw, line: renderSignalLine(spec, labels, valueRaw, new Date(atMsRaw).toISOString()) });
    }
  }
  return { ok: true, lines };
}

async function querySignals(base: string, apiKey: string, appKey: string, q: EvidenceQuery): Promise<AdapterResult> {
  const tagFilter = tagFilterFor(q.scope);
  const labels = q.scope && SCOPE_TAG_VALUE_RE.test(q.scope) ? tagFilter : "";
  const specs = metricSpecs();
  const outcomes = await Promise.all(
    specs.map((spec) => fetchMetric(base, apiKey, appKey, spec, tagFilter, labels, q.windowStart, q.windowEnd))
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
  // call. Mirrors langfuse.ts's/sentry.ts's identical "all scopes failing"
  // collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // `q.query` matches a signal's own name+labels identifier — NOT the whole
  // rendered line (mirrors langfuse.ts's/sentry.ts's identical `signals`
  // contract; see the module doc-comment).
  let filtered = allLines;
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

  // Most-recent-first — consistent with langfuse.ts's/sentry.ts's identical
  // choice (no verb-specific ordering pinned for `signals`).
  filtered.sort((a, b) => b.at - a.at);

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors every sibling
  // adapter's identical discipline.
  const limit = Math.max(1, q.limit ?? SIGNALS_DEFAULT_LIMIT);
  const cappedLines = filtered.slice(0, limit).map((l) => l.line);
  return { ok: true, raw: [...markers, ...cappedLines].join("\n") };
}

// ---------------------------------------------------------------------------

export const datadogAdapter: EvidenceAdapter = {
  provider: "datadog",
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

    // See this module's own doc-comment ("CONFIG_MISSING") — every check
    // below degrades identically, and in this order specifically: cheapest
    // checks (no DB read needed) first.
    if (!secret) {
      return { ok: false, reason: "config_missing" };
    }
    const split = splitCompositeSecret(DATADOG_SECRET_SPEC, secret);
    if (!split.ok) {
      return { ok: false, reason: "config_missing" };
    }
    const [apiKey, appKey] = split.parts;

    const row = await getConnector(workspaceId, "datadog");
    const site = resolveDatadogSite(row?.config.datadogSite);
    if (!site) {
      return { ok: false, reason: "config_missing" };
    }
    const base = `https://api.${site}`;

    return q.verb === "signals"
      ? querySignals(base, apiKey, appKey, q)
      : querySearchEvents(base, apiKey, appKey, q);
  },
};

registerAdapter(datadogAdapter);
