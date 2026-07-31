import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import { splitCompositeSecret } from "./composite-secret";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `langfuse` evidence adapter (Task P2, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The first Wave-2 provider —
 * proves the "add a provider = catalog entry + adapter + credential pair"
 * property (Task 7's `railway` proved it first) now for a COMPOSITE-secret
 * provider (Task P0's `splitCompositeSecret`) and for the two verbs Task P1
 * added to the closed set (`signals`/`traces`).
 *
 * `verbs: ["traces", "signals"]`: `traces` lists exemplar traces in the
 * window; `signals` returns a handful of pre-aggregated RED-shaped metrics
 * (observation count, error count, p95 latency) over the SAME window.
 *
 * CREDENTIAL: a COMPOSITE secret, `pk-lf-…:sk-lf-…` (Task P0's
 * `secretParts`/`splitCompositeSecret` mechanism — see that module's own
 * doc-comment). Unlike railway.ts/github.ts, this adapter's incoming
 * `secret` parameter is NOT the raw credential to send — the evidence
 * route (`runner/evidence/route.ts`) hands every adapter the RAW STORED
 * string unconditionally (it does not know or care which providers are
 * composite), so THIS adapter is responsible for its own
 * `splitCompositeSecret` call before it can authenticate anything.
 *
 * LANGFUSE API SHAPES — confirmed against Langfuse's own docs and API
 * definition source during implementation (this task's mandatory first
 * step; NOT trusted from memory):
 *   - Auth: HTTP Basic, public key as username, secret key as password —
 *     `curl -u public-key:secret-key https://cloud.langfuse.com/api/public/projects`
 *     (langfuse.com/docs/api-and-data-platform/features/public-api).
 *   - `GET /api/public/traces` — confirmed query params (fern source,
 *     `github.com/langfuse/langfuse/blob/main/fern/apis/server/definition/
 *     trace.yml`): `page`, `limit`, `userId`, `name`, `sessionId`,
 *     `fromTimestamp`, `toTimestamp`, `orderBy` (`[field].[asc/desc]`),
 *     `tags`, `version`, `release`, `environment`, `fields`, `filter` (a
 *     JSON string, advanced). Response: `{ data: TraceWithDetails[], meta
 *     }`. `TraceWithDetails` (fern source, `commons.yml`) fields used here:
 *     `id: string`, `name: nullable<string>`, `timestamp: datetime`,
 *     `latency: optional<nullable<double>>` — documented as "Latency of
 *     trace in seconds" (NOT milliseconds — converted below). CONFIRMED
 *     ABSENT from `TraceWithDetails`: any status/level/error field — see
 *     "STATUS FIELD — CONFIRMED ABSENT" below.
 *   - `GET /api/public/v2/metrics?query=<URL-encoded JSON>` — the SAME
 *     endpoint/shape `apps/jace/agent/lib/spend-by-intent.core.mjs`
 *     verified against a REAL live prod Langfuse project (2026-07-20; see
 *     that module's own header comment) — reused here per this task's own
 *     instruction. Query shape (fern source, `metrics.yml`): `{ view,
 *     dimensions, metrics: [{measure, aggregation}], filters, timeDimension?:
 *     {granularity}, fromTimestamp, toTimestamp }` — `timeDimension` is
 *     confirmed OPTIONAL ("Optional. Default: null. If provided, results
 *     will be grouped by time."; Fix Round 1 fetched this directly rather
 *     than trusting the initial submission's guess) and this adapter
 *     OMITS it (see "SIGNALS DESIGN" below). Response: `{ data: [{
 *     time_dimension, ..., "{aggregation}_{measure}": number|null }] }`
 *     (the `{aggregation}_{measure}` row-key pattern is the SAME one
 *     spend-by-intent.core.mjs's confirmed real response used, e.g.
 *     `sum_totalCost`). CONFIRMED (fern source, `metrics.yml`): v2's
 *     `view: "traces"` was REMOVED ("no longer available in v2" — the
 *     plan's own believed `GET /api/public/metrics` daily-metrics shape is
 *     ALSO not how v2 works) — `view: "observations"` remains, with
 *     `measure` values including `count`/`latency` and `aggregation`
 *     values including `count`/`p50`.."p99`, and a `level` dimension
 *     (`DEBUG`/`DEFAULT`/`WARNING`/`ERROR`) usable as a FILTER (not just a
 *     groupby) — see "SIGNALS DESIGN" below for why this is a clean fit,
 *     not a "no fit" case.
 *
 * STATUS FIELD — CONFIRMED ABSENT (KNOWN v1 GAP, pinned render format's own
 * escape hatch): the pinned `traces` render format is `trace {id} {name}
 * duration_ms={n} status={ok|error} at={iso}`, and this task's own brief
 * says "if a status/level field doesn't exist, render status=- and
 * document." `TraceWithDetails` (confirmed above) carries NO status/level/
 * error field of its own — a trace's constituent OBSERVATIONS can each
 * carry a `level`, but reading those would mean an extra per-trace fetch
 * (`observations` list, one call PER exemplar trace — an N+1 fan-out this
 * v1 does not do, the same "do not risk the whole verb / a much larger
 * fetch on an unconfirmed-worth-it shape" restraint railway.ts's own
 * "ENV FIELD" gap applies). `status` therefore renders `-`
 * UNCONDITIONALLY for every trace line in v1 — an honest "unknown", not a
 * guess.
 *
 * LATENCY UNIT CONVERSION: `TraceWithDetails.latency` is SECONDS
 * (confirmed above); the pinned format's field is `duration_ms`, so this
 * adapter converts (`Math.round(latency * 1000)`) per this task's own
 * instruction ("if latency is seconds, convert"). A `null`/absent latency
 * renders `duration_ms=-` (never a fabricated `0`, which would misread as
 * "instant").
 *
 * SIGNALS DESIGN (the plan's own escape hatch — "if no clean signals fit
 * exists, implement traces only... and record the decision prominently" —
 * DELIBERATELY NOT TAKEN here; recorded prominently instead, per that same
 * instruction, because a clean fit DOES exist): the Metrics API v2's
 * `observations` view (confirmed above) supports exactly the small,
 * pre-aggregated RED-shaped queries the pinned `signals` convention wants —
 * "never raw series dumps." Three FIXED queries per call (no user-supplied
 * PromQL/query-language — mirrors P5's own pinned "do NOT accept raw
 * PromQL from the model" caution, applied here even though nothing in
 * Langfuse's shape technically requires it, because a fixed, small,
 * reviewable query set is the safer default regardless):
 *   1. `langfuse.observations.count` (measure=count, aggregation=count) —
 *      throughput.
 *   2. `langfuse.observations.count{level="ERROR"}` (same measure/agg,
 *      filtered `level = "ERROR"`) — errors.
 *   3. `langfuse.observations.latency_seconds` (measure=latency,
 *      aggregation=p95) — duration. Kept in Langfuse's OWN unit (seconds,
 *      named accordingly) rather than converted — the pinned `signals`
 *      format's `value={n}` carries no forced unit the way `traces`'
 *      `duration_ms` does, so there is no "honest mapping" reason to
 *      convert; the `_seconds` suffix keeps the unit unambiguous in the
 *      rendered text itself.
 * `timeDimension` is DELIBERATELY OMITTED from every query (Fix Round 1,
 * FIX 1 — see {@link buildMetricsUrl}'s own doc-comment): confirmed directly
 * against `metrics.yml` (not the initial submission's guess) as "Optional.
 * Default: null. If provided, results will be grouped by time." — omitting
 * it means each of the three fixed queries returns exactly ONE aggregate
 * row for the whole window, by construction. This is the clean "3
 * pre-aggregated numbers" reading of the pinned `signals` convention, and
 * it removes the risk of a wide window's time-bucketed rows silently
 * outnumbering the cap. `fetchMetric` still iterates the response
 * defensively (never assumes exactly one row, and belt-and-braces
 * window-re-filters any row that DOES carry a `time_dimension` — Fix Round
 * 1, FIX 2) rather than hard-coding a single-row read, since a malformed or
 * future-changed response should degrade gracefully, not throw. A row
 * whose aggregated value is `null` (Langfuse's own "no data this bucket"
 * signal — see spend-by-intent.core.mjs's identical null-vs-0 discipline)
 * is SKIPPED, not rendered as a fabricated `value=0`/`value=null` — the
 * `signal` line format's own contract is a real number.
 *
 * REQUEST HYGIENE mirrors `railway.ts`/`github.ts`: an 8s
 * `AbortSignal.timeout` per request, `User-Agent: agentrail-console`.
 *
 * FAILURE HANDLING mirrors `railway.ts`'s own split exactly: `traces` is a
 * SINGLE-SCOPE, multi-page fetch (see `TRACES_MAX_PAGES` below) — NOT
 * try/catch-wrapped locally, so a thrown fetch propagates uncaught to the
 * ROUTE, which converts it to `unreachable` (`runner/evidence/route.ts`'s
 * own doc-comment, FAN-OUT step 3). `signals`' THREE metric sub-fetches
 * (railway.ts's `search_events` precedent, one dynamic per-deployment
 * fan-out; here, three FIXED per-metric ones) each get their own try/catch
 * and a cap-exempt marker line, `(signal {key}: langfuse {reason|
 * unreachable})`, rendered first. A clean 401/403 maps to `unauthorized`;
 * any other non-2xx OR a malformed/non-object 200 body maps to
 * `upstream_error` (this adapter does not further subdivide into
 * `unexpected_status`/`bad_body`, matching railway.ts/github.ts's own
 * precedent).
 *
 * CONFIG_MISSING (pinned decision, mirrors railway.ts's identical
 * reasoning): a null `secret`, a `secret` that fails `splitCompositeSecret`
 * (should not happen through the route — `validateConnectorCredential`'s
 * Gate 1 already rejects a malformed composite before storage — but this
 * adapter does not assume that gate ran, same "never trust the caller
 * validated first" discipline as `isValidIsoDate` below), OR an absent
 * `config.langfuseHost` all degrade to `config_missing` — NONE of these are
 * the caller's (the investigation's) fault, and none is a credential
 * Langfuse itself REJECTED (that is `unauthorized`); every one is a
 * connector CONFIGURATION gap only reconnecting fixes. `langfuseHost` is
 * NOT re-validated for scheme here the way `verify.ts`'s own
 * `resolveHttpUrl` must — by the time a value reaches a STORED connector
 * row, `validateUrlConfigString`
 * (`packages/db-postgres/src/queries/connectors.ts`) has already
 * scheme-gated it at write time (`connectors/route.ts`'s PUT); this
 * adapter's own read only needs to check for PRESENCE.
 *
 * `q.query` (pinned: "filters by trace name substring case-insensitive
 * client-side" for `traces` — no confirmed exact-vs-substring semantics
 * for the `name` server param, so, mirroring railway.ts's own "filter is
 * DELIBERATELY NOT wired" caution for its own unconfirmed-semantics
 * server-side filter, `name` is NOT sent server-side here either; only
 * `fromTimestamp`/`toTimestamp`, whose semantics ARE unambiguous, ride
 * server-side): matched against each trace's own `name` field specifically
 * (not the whole rendered line — id/timestamp/duration are not "the trace
 * name"). For `signals` (no verb-specific wording pinned), the same
 * "match the name, not the whole line" spirit is generalized: matched
 * against each signal's own `{name}{labels}` identifier portion.
 */

const LANGFUSE_FETCH_TIMEOUT_MS = 8000;
const TRACES_PATH = "/api/public/traces";
const METRICS_PATH = "/api/public/v2/metrics";

// A plain local number, not a documented Langfuse maximum (mirrors
// railway.ts's DEPLOYMENTS_FETCH_LIMIT / github.ts's PR_PER_PAGE — neither
// confirmed a server-side max either). TRACES_MAX_PAGES mirrors github.ts's
// PR_MAX_PAGES multi-page-fetch hygiene: `fromTimestamp`/`toTimestamp` DO
// narrow server-side here (unlike GitHub's PR endpoint, which has no merge-
// window filter), so this is a "the window can hold more than one page"
// safety margin, not a fetch-horizon-uncertainty mechanism — a window
// whose in-range traces exceed TRACES_PER_PAGE * TRACES_MAX_PAGES will
// under-report; a disclosed, accepted v1 bound, same spirit as
// SEARCH_EVENTS_MAX_DEPLOYMENTS in railway.ts.
const TRACES_PER_PAGE = 100;
const TRACES_MAX_PAGES = 2;
const TRACES_DEFAULT_LIMIT = 50;
const SIGNALS_DEFAULT_LIMIT = 50;

// Pinned "TITLES ARE UNTRUSTED TEXT" discipline (github.ts's own doc-comment)
// applied to trace names — the one adapter-side transformation, nothing else.
const NAME_MAX_LEN = 120;

const NO_TRACES_MARKER = "(no matching traces)";
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
 * rendered "one record per line" line in two — mirrors railway.ts's
 * identical helper. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/** The one adapter-side name transformation the spec pins for free-text
 * provider fields (github.ts's "TITLES ARE UNTRUSTED TEXT" precedent) —
 * see this module's own doc-comment for why nothing else touches the text. */
function truncateName(name: string): string {
  const collapsed = singleLine(name);
  return collapsed.length > NAME_MAX_LEN ? collapsed.slice(0, NAME_MAX_LEN) : collapsed;
}

/** Declares this connector's two-part credential shape for
 * `splitCompositeSecret` — display metadata only (`{name}` strings), not
 * imported from the catalog so this adapter stays independent of
 * `connector-helpers.ts` (mirrors railway.ts/github.ts, neither of which
 * imports the catalog either — this is the FIRST composite adapter, so
 * this independence is a new pattern, not yet proven elsewhere). Must
 * match `connector-helpers.ts`'s real `langfuse` catalog entry's
 * `secretParts` in SHAPE (two parts) — the ORDER (public key first, secret
 * key second) is what actually matters, since only `parts.length` and
 * positional indexing are used below, not the `name` strings themselves
 * (those exist purely for `splitCompositeSecret`'s own error messages).
 * EXPORTED (Fix Round 1 fold-in) solely so `langfuse.test.ts` can assert
 * this constant's part count against the real catalog entry's
 * `secretParts.length` directly — the two declarations can never silently
 * drift apart unnoticed. This does NOT create a runtime dependency on the
 * catalog (the adapter itself still never imports `connector-helpers.ts`);
 * only the TEST imports both. */
export const LANGFUSE_SECRET_SPEC = {
  secretParts: [{ name: "Public key" }, { name: "Secret key" }],
};

function langfuseHeaders(publicKey: string, secretKey: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
    "User-Agent": "agentrail-console",
  };
}

function langfuseFetch(url: string, publicKey: string, secretKey: string): Promise<Response> {
  return fetch(url, {
    headers: langfuseHeaders(publicKey, secretKey),
    signal: AbortSignal.timeout(LANGFUSE_FETCH_TIMEOUT_MS),
  });
}

/**
 * One GET, mapped to the pinned taxonomy. Deliberately NOT try/catch-wrapped
 * around the `fetch` call itself — see this module's own doc-comment
 * ("FAILURE HANDLING"): a thrown fetch propagates uncaught to whichever
 * caller needs that (the route, for the single-scope `traces` fetch;
 * `fetchMetric`'s OWN try/catch, for the three-metric `signals` fan-out).
 */
async function langfuseGet<T>(
  url: string,
  publicKey: string,
  secretKey: string
): Promise<{ ok: true; data: T } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await langfuseFetch(url, publicKey, secretKey);
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
// traces
// ---------------------------------------------------------------------------

interface LangfuseTraceEntry {
  id?: unknown;
  name?: unknown;
  timestamp?: unknown;
  latency?: unknown;
}

interface RenderedLine {
  /** Epoch ms — the sort key; never itself rendered raw. */
  at: number;
  line: string;
}

/** `trace {id} {name} duration_ms={n|-} status=- at={iso}` — pinned field
 * order; `status` is always `-` in v1 (see this module's own doc-comment,
 * "STATUS FIELD — CONFIRMED ABSENT"). */
function renderTraceLine(id: string, name: string, durationMsText: string, atIso: string): string {
  return `trace ${id} ${name} duration_ms=${durationMsText} status=- at=${atIso}`;
}

/** Fetches up to {@link TRACES_MAX_PAGES} pages of traces, most-recent-first
 * server-side (`orderBy=timestamp.desc`), window-filtered server-side
 * (`fromTimestamp`/`toTimestamp`) — NOT yet client-filtered/rendered (see
 * {@link parseTraces} below, called separately so the belt-and-braces
 * re-filter and `q.query` name-match stay independently testable). */
async function fetchTraces(
  base: string,
  publicKey: string,
  secretKey: string,
  windowStart: string,
  windowEnd: string
): Promise<{ ok: true; entries: LangfuseTraceEntry[] } | { ok: false; reason: EvidenceDegradationReason }> {
  const collected: LangfuseTraceEntry[] = [];
  for (let page = 1; page <= TRACES_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      fromTimestamp: windowStart,
      toTimestamp: windowEnd,
      limit: String(TRACES_PER_PAGE),
      page: String(page),
      orderBy: "timestamp.desc",
    });
    const result = await langfuseGet<{ data?: unknown }>(`${base}${TRACES_PATH}?${params}`, publicKey, secretKey);
    if (!result.ok) return result;

    const entries = Array.isArray(result.data.data) ? (result.data.data as LangfuseTraceEntry[]) : [];
    collected.push(...entries);
    if (entries.length < TRACES_PER_PAGE) break; // last page
  }
  return { ok: true, entries: collected };
}

/** Parses + belt-and-braces window-re-filters (never trusts the server-side
 * `fromTimestamp`/`toTimestamp` filter alone — same doctrine as every
 * sibling adapter's identical re-filter) fetched trace entries into
 * candidate rendered lines, EACH carrying its own `name` alongside the
 * rendered text so {@link queryTraces} can apply `q.query`'s "match the
 * name, not the whole line" contract without re-parsing. A node missing an
 * `id`/unparseable `timestamp` is skipped rather than throwing. */
function parseTraces(
  entries: LangfuseTraceEntry[],
  windowStart: string,
  windowEnd: string
): Array<RenderedLine & { name: string }> {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const out: Array<RenderedLine & { name: string }> = [];
  for (const entry of entries) {
    const id = typeof entry.id === "string" && entry.id ? entry.id : null;
    const tsRaw = typeof entry.timestamp === "string" ? entry.timestamp : null;
    if (!id || !tsRaw) continue;
    const atMs = new Date(tsRaw).getTime();
    if (Number.isNaN(atMs)) continue;
    if (atMs < startMs || atMs > endMs) continue;

    const name = typeof entry.name === "string" && entry.name ? truncateName(entry.name) : "-";
    const latency =
      typeof entry.latency === "number" && Number.isFinite(entry.latency) ? entry.latency : null;
    const durationMsText = latency === null ? "-" : String(Math.round(latency * 1000));

    out.push({
      at: atMs,
      name,
      line: renderTraceLine(singleLine(id), name, durationMsText, new Date(atMs).toISOString()),
    });
  }
  return out;
}

async function queryTraces(
  base: string,
  publicKey: string,
  secretKey: string,
  q: EvidenceQuery
): Promise<AdapterResult> {
  const result = await fetchTraces(base, publicKey, secretKey, q.windowStart, q.windowEnd);
  if (!result.ok) return result;

  let candidates = parseTraces(result.entries, q.windowStart, q.windowEnd);
  if (q.query) {
    const needle = q.query.toLowerCase();
    candidates = candidates.filter((c) => c.name.toLowerCase().includes(needle));
  }
  if (candidates.length === 0) {
    return { ok: true, raw: NO_TRACES_MARKER };
  }

  // Defensive — do not trust the server's own `orderBy` (mirrors railway.ts:
  // "do not trust server edge ordering"). Most-recent-first — pinned.
  candidates.sort((a, b) => b.at - a.at);

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // every sibling adapter's identical clamp.
  const limit = Math.max(1, q.limit ?? TRACES_DEFAULT_LIMIT);
  return { ok: true, raw: candidates.slice(0, limit).map((c) => c.line).join("\n") };
}

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

interface MetricSpec {
  /** Used only in this metric's own failure marker text. */
  key: string;
  /** The rendered `signal {name}` identifier. */
  name: string;
  /** The rendered `{labels}` suffix — `""` when there are none. */
  labels: string;
  measure: string;
  aggregation: string;
  filters: unknown[];
}

/** The THREE fixed RED-shaped queries this adapter runs every `signals`
 * call — see this module's own doc-comment ("SIGNALS DESIGN") for why these
 * three, and why fixed rather than model-supplied. */
function metricSpecs(): MetricSpec[] {
  return [
    {
      key: "count",
      name: "langfuse.observations.count",
      labels: "",
      measure: "count",
      aggregation: "count",
      filters: [],
    },
    {
      key: "errors",
      name: "langfuse.observations.count",
      labels: '{level="ERROR"}',
      measure: "count",
      aggregation: "count",
      filters: [{ column: "level", operator: "=", value: "ERROR", type: "string" }],
    },
    {
      key: "latency_p95",
      name: "langfuse.observations.latency_seconds",
      labels: "",
      measure: "latency",
      aggregation: "p95",
      filters: [],
    },
  ];
}

/** The v2 Metrics API's confirmed row-key convention for an aggregated
 * value column, `{aggregation}_{measure}` — the SAME pattern
 * spend-by-intent.core.mjs's confirmed real response uses (`sum_totalCost`
 * for `{measure:"totalCost",aggregation:"sum"}`). */
function metricValueKey(spec: MetricSpec): string {
  return `${spec.aggregation}_${spec.measure}`;
}

/** `timeDimension` is DELIBERATELY OMITTED (Fix Round 1, FIX 1 — reviewer
 * fetched `metrics.yml` directly: "Optional. Default: null. If provided,
 * results will be grouped by time." — confirmed, not a guess): omitting it
 * means each of the three fixed queries returns exactly ONE aggregate row
 * for the whole `[fromTimestamp, toTimestamp]` window, by construction —
 * the clean "3 pre-aggregated numbers" reading of the pinned `signals`
 * convention, and it removes the possibility of a wide window's time-
 * bucketed rows silently outnumbering the cap (see {@link fetchMetric}'s
 * own doc-comment for the belt-and-braces row-level window check kept
 * anyway). */
function buildMetricsUrl(base: string, spec: MetricSpec, windowStart: string, windowEnd: string): string {
  const query = {
    view: "observations",
    dimensions: [],
    metrics: [{ measure: spec.measure, aggregation: spec.aggregation }],
    filters: spec.filters,
    fromTimestamp: windowStart,
    toTimestamp: windowEnd,
  };
  return `${base}${METRICS_PATH}?query=${encodeURIComponent(JSON.stringify(query))}`;
}

/** `signal {name}{labels} window_agg={agg} value={n} at={iso}` — pinned
 * convention. */
function renderSignalLine(spec: MetricSpec, value: number, atIso: string): string {
  return `signal ${spec.name}${spec.labels} window_agg=${spec.aggregation} value=${value} at=${atIso}`;
}

interface MetricRow {
  time_dimension?: unknown;
  [key: string]: unknown;
}

type MetricOutcome = { ok: true; lines: Array<RenderedLine> } | { ok: false; marker: string };

/** One metric's own fetch — its OWN try/catch (per-metric granularity;
 * mirrors railway.ts's `fetchDeploymentLogs`, applied to a FIXED set of
 * three metrics instead of a dynamic per-deployment fan-out). With
 * `timeDimension` omitted (Fix Round 1, FIX 1 — see {@link buildMetricsUrl}'s
 * own doc-comment) a compliant response carries exactly one row per metric
 * and no `time_dimension` at all; this function still iterates `rows`
 * generically rather than assuming that shape (defense in depth, not a
 * behavior change). Fix Round 1, FIX 2: any row that DOES carry a
 * `time_dimension` outside `[windowStart, windowEnd]` is skipped — the SAME
 * belt-and-braces client-side re-filter {@link parseTraces} applies to
 * traces and railway.ts's `fetchDeploymentLogs` applies to log lines, now
 * genuinely mirrored here rather than merely claimed (the initial
 * submission's doc-comment overclaimed this parity without the check). A
 * row carrying no `time_dimension` (the expected, now-only case with FIX 1)
 * is kept, stamped with `windowEnd` for `at=`. */
async function fetchMetric(
  base: string,
  publicKey: string,
  secretKey: string,
  spec: MetricSpec,
  windowStart: string,
  windowEnd: string
): Promise<MetricOutcome> {
  let result: Awaited<ReturnType<typeof langfuseGet<{ data?: unknown }>>>;
  try {
    result = await langfuseGet<{ data?: unknown }>(
      buildMetricsUrl(base, spec, windowStart, windowEnd),
      publicKey,
      secretKey
    );
  } catch {
    return { ok: false, marker: `(signal ${spec.key}: langfuse unreachable)` };
  }
  if (!result.ok) {
    return { ok: false, marker: `(signal ${spec.key}: langfuse ${result.reason})` };
  }

  const rows = Array.isArray(result.data.data) ? (result.data.data as MetricRow[]) : [];
  const valueKey = metricValueKey(spec);
  const windowStartMs = new Date(windowStart).getTime();
  const windowEndMs = new Date(windowEnd).getTime();

  const lines: RenderedLine[] = [];
  for (const row of rows) {
    const raw = row[valueKey];
    // Langfuse's own "no data this bucket" signal is `null`, never
    // coalesced to 0 (spend-by-intent.core.mjs's identical discipline) —
    // skipped here rather than rendering a fabricated value.
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;

    const bucketRaw = typeof row.time_dimension === "string" ? row.time_dimension : null;
    const bucketMs = bucketRaw ? new Date(bucketRaw).getTime() : NaN;
    // Fix Round 1, FIX 2 — belt-and-braces: a row carrying a PARSEABLE
    // bucket outside the window is skipped, never trusted blindly. A row
    // with no bucket at all (absent/null/unparseable `time_dimension` — the
    // expected shape now that FIX 1 omits `timeDimension` from the query)
    // is unaffected by this check and falls through to the windowEnd
    // fallback below.
    if (Number.isFinite(bucketMs) && (bucketMs < windowStartMs || bucketMs > windowEndMs)) continue;
    const atMs = Number.isFinite(bucketMs) ? bucketMs : windowEndMs;

    lines.push({ at: atMs, line: renderSignalLine(spec, raw, new Date(atMs).toISOString()) });
  }
  return { ok: true, lines };
}

async function querySignals(
  base: string,
  publicKey: string,
  secretKey: string,
  q: EvidenceQuery
): Promise<AdapterResult> {
  const specs = metricSpecs();
  const outcomes = await Promise.all(
    specs.map((spec) => fetchMetric(base, publicKey, secretKey, spec, q.windowStart, q.windowEnd))
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
  // call. Mirrors railway.ts's/github.ts's identical "all scopes failing"
  // collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // `q.query` matches a signal's own name+labels identifier — NOT the whole
  // rendered line (mirrors this module's own `traces` contract; see the
  // module doc-comment).
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

  // Most-recent-first — consistent with `traces`/`changes` (no verb-specific
  // ordering pinned for `signals`; see the module doc-comment).
  filtered.sort((a, b) => b.at - a.at);

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors railway.ts's/
  // github.ts's identical Fix Round 1 discipline.
  const limit = Math.max(1, q.limit ?? SIGNALS_DEFAULT_LIMIT);
  const cappedLines = filtered.slice(0, limit).map((l) => l.line);
  return { ok: true, raw: [...markers, ...cappedLines].join("\n") };
}

// ---------------------------------------------------------------------------

export const langfuseAdapter: EvidenceAdapter = {
  provider: "langfuse",
  verbs: ["traces", "signals"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "traces":
      case "signals":
        break;
      default:
        // This adapter declares only [traces, signals] — the route never
        // asks it for a verb it didn't declare, but a direct caller (this
        // module's own tests included) is not bound by that, so this stays
        // defensive rather than throwing (mirrors every sibling adapter's
        // identical default case).
        return { ok: false, reason: "bad_request" };
    }

    // See this module's own doc-comment ("CONFIG_MISSING") — every check
    // below degrades identically, and in this order specifically: cheapest
    // checks (no DB read needed) first.
    if (!secret) {
      return { ok: false, reason: "config_missing" };
    }
    const split = splitCompositeSecret(LANGFUSE_SECRET_SPEC, secret);
    if (!split.ok) {
      return { ok: false, reason: "config_missing" };
    }
    const [publicKey, secretKey] = split.parts;

    const row = await getConnector(workspaceId, "langfuse");
    const host = row?.config.langfuseHost;
    if (!host) {
      return { ok: false, reason: "config_missing" };
    }
    const base = host.replace(/\/+$/, "");

    return q.verb === "traces"
      ? queryTraces(base, publicKey, secretKey, q)
      : querySignals(base, publicKey, secretKey, q);
  },
};

registerAdapter(langfuseAdapter);
