import { getConnector } from "@agentrail/db-postgres";
import { registerAdapter } from "./registry";
import { resolveProviderAuth } from "../oauth/core";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `sentry` evidence adapter (Task P3, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`). The second Wave-2 provider —
 * proves the "add a provider = catalog entry + adapter" property (Task 7's
 * `railway` first, Task P2's `langfuse` for a COMPOSITE secret) now for a
 * SINGLE-secret provider that ALSO needs TWO non-secret companion config
 * values (`sentryOrg` + `sentryProject`, both required).
 *
 * `verbs: ["search_events", "signals"]`: `search_events` searches
 * error-tracking ISSUES (Sentry's grouped-event unit — one row per distinct
 * error, not one row per raw occurrence) in the window by free-text query;
 * `signals` returns three pre-aggregated RED-shaped metrics (event count,
 * level=error count, p95 transaction duration) over the SAME window.
 *
 * CREDENTIAL: a SINGLE secret (no `secretParts` — unlike langfuse.ts's
 * composite pair), an org OR user auth token, sent as
 * `Authorization: Bearer <token>` on every call. UPDATED (OAuth Connect
 * Wave 3, W3-T3, `.superpowers/sdd/plan-oauth.md`): the bearer value is no
 * longer the raw `secret` parameter this function receives — it is now
 * resolved via `resolveProviderAuth(workspaceId, "sentry")`
 * (`lib/oauth/core.ts`), identical to `lib/evidence/railway.ts`'s own
 * W3-T2 switch. A legacy pasted token is returned verbatim (byte-identical
 * behavior to before this task — and, per `lib/oauth/sentry.ts`'s own
 * doc-comment, "STATE CANNOT ROUND-TRIP", token-paste remains the ONLY way
 * to connect Sentry today regardless of this switch); an OAuth-connected
 * envelope would be auto-refreshed when within its 2-minute expiry skew,
 * with the rotated envelope persisted before the (possibly new) access
 * token is returned — this path is written and tested now so it needs no
 * further change once a future task resolves the state-round-trip gap and
 * OAuth connect actually becomes reachable. `secret` itself is kept ONLY
 * as the pre-existing cheap "is anything stored at all" gate below
 * (`!secret -> config_missing`) — same reasoning as railway.ts's identical
 * comment. A `resolveProviderAuth` failure degrades to `unauthorized` via
 * THIS adapter's existing, closed `EvidenceDegradationReason` set —
 * `resolveProviderAuth`'s own result type (`"config_missing" |
 * "unauthorized"`) is already a subset of it, so no new degradation
 * vocabulary is introduced.
 *
 * SENTRY API SHAPES — confirmed against Sentry's own docs and source during
 * implementation (this task's mandatory first step; NOT trusted from
 * memory):
 *   - Token formats: `sntrys_…` (organization auth token) / `sntryu_…`
 *     (user auth token) — confirmed against Sentry's own source
 *     (`src/sentry/types/token.py`: `USER="sntryu_"`, `ORG="sntrys_"`, also
 *     `USER_APP="sntrya_"`/`INTEGRATION="sntryi_"`, both DELIBERATELY out
 *     of scope for v1's format gate — see `connector-helpers.ts`'s own
 *     `case "sentry"` doc-comment for why only the two most common kinds
 *     are accepted).
 *   - Auth: `Authorization: Bearer <token>` (docs.sentry.io/api/auth/).
 *   - `search_events`: `GET /api/0/organizations/{org}/issues/` (NOT the
 *     project-scoped `/projects/{org}/{project}/issues/`, which
 *     docs.sentry.io itself flags as replaced by this one, and — confirmed
 *     independently — does not document `start`/`end` at all, only
 *     relative `statsPeriod` presets, which cannot express an arbitrary
 *     `[windowStart, windowEnd]`). Params used: `project` (confirmed to
 *     accept an id OR SLUG — docs.sentry.io's own words, "Project
 *     IDs/slugs to filter"), `query` (free text + `key:value` tokens;
 *     ALWAYS sent explicitly, even `""` — see "QUERY DEFAULT" below),
 *     `start`/`end` (ISO-8601 — see "DATE RANGE PARAMS" below for why
 *     `statsPeriod` is deliberately omitted), `sort=date`, `limit` (max
 *     100 — see `SEARCH_EVENTS_PAGE_SIZE` below). Response: a BARE JSON
 *     array of issue objects (confirmed — not `{data: [...]}`); fields
 *     used: `id`, `shortId`, `title`, `level`, `count` (a STRING per
 *     Sentry's own example, `"1"` — rendered as-is, never parsed to a
 *     number), `lastSeen` (this adapter's chosen window/render timestamp —
 *     an issue's most recent occurrence; `firstSeen` is not used).
 *   - `signals`: `GET /api/0/organizations/{org}/events/stats/` (the
 *     confirmed exact path is `/events/stats/`, NOT `/events-stats/` as
 *     the plan's own believed shape guessed). Params: `query` (Discover
 *     search syntax — see "PROJECT SCOPING ASYMMETRY" below for why THIS
 *     endpoint's project scoping rides in `query` as a `project:{slug}`
 *     token rather than the dedicated `project` param), `yAxis`
 *     (`count()` / `p95(transaction.duration)` — both confirmed-supported
 *     example values), `start`/`end` (`statsPeriod` "cannot combine with
 *     start/end" per docs — omitted), `interval` (bucket width — see
 *     "BUCKETING" below). Response (single `yAxis` per call, which is all
 *     this adapter ever sends): `{ data: [[unixSeconds, [{<key>: value}]],
 *     ...], start, end }` — confirmed via a literal worked example in the
 *     docs.
 *
 * DATE RANGE PARAMS: Sentry's shared `get_date_range_from_params` utility
 * (`sentry/api/utils.py`) only falls back to a DEFAULT window when NEITHER
 * `statsPeriod` NOR `start`+`end` is present in the request — an explicit
 * `start`/`end` pair is never silently overridden by any default
 * `statsPeriod`. This adapter therefore omits `statsPeriod` entirely and
 * sends `start`/`end` on every call — mirroring langfuse.ts's identical
 * Fix Round 1 lesson ("omit the field whose presence would override what
 * we actually want sent"), now confirmed for Sentry specifically rather
 * than assumed by analogy.
 *
 * QUERY DEFAULT (`search_events`): the issues endpoint's `query` param
 * defaults to `is:unresolved` ONLY when the param is omitted entirely; this
 * adapter always sends it explicitly (`q.query ?? ""`), so a resolved
 * issue that was active in-window is never silently hidden.
 *
 * PROJECT SCOPING ASYMMETRY (a real, confirmed difference between the two
 * endpoints, not an oversight): the `issues` endpoint's own docs explicitly
 * say its `project` param accepts "Project IDs/slugs" (plural — both
 * forms), so this adapter sends `project=<sentryProject>` (the STORED
 * SLUG) there directly. The `events/stats` endpoint's own docs describe
 * `project` as `integer` / "Project ID" ONLY — no confirmed slug support —
 * and this adapter has only ever stored a SLUG (`config.sentryProject`, a
 * human-typed value, e.g. `"web"` — never a numeric id). Rather than risk
 * silently sending an unscoped org-wide query (a real over-broad-data
 * leak: every OTHER project in the org would blend into "signals" for a
 * workspace that connected exactly one project), this adapter embeds
 * `project:{slug}` as a SEARCH TOKEN in the `query` string instead —
 * confirmed as a real, documented search property
 * (docs.sentry.io/concepts/search/searchable-properties/issues/: "`project`
 * — ... Example: `project:my-app`"), and `events/stats`'s own `query`
 * param documentation says it "uses the same syntax as the events query
 * endpoint" — the same search language the confirmed `project:` token
 * belongs to. This is the SAFER of the two confirmable options, not a
 * guess. See "Q.QUERY" below for the colon-in-free-text risk this same
 * structured-search-DSL choice creates for `search_events`, and how
 * {@link quoteSearchText} closes it (Fix Round 1, FOLD 1).
 *
 * VERIFY ENDPOINT (chosen over the plan's believed org-only shape — see
 * `verify.ts`'s own doc-comment, "SENTRY (Task P3)"): `GET
 * /api/0/projects/{org}/{project}/` validates BOTH org and project (and
 * the token's access to that SPECIFIC project) in one side-effect-free
 * call.
 *
 * BUCKETING (`signals`, the P2 lesson: "no time bucketing unless
 * unavoidable; if unavoidable, cap buckets and mark truncation honestly"):
 * unlike Langfuse's v2 metrics API (a genuinely bucket-free mode exists —
 * omit `timeDimension`), Sentry's `events/stats` has no confirmed "one
 * aggregate, no bucketing" mode — `interval` only controls bucket WIDTH,
 * and the docs themselves warn "Sentry may adjust this to ensure a
 * reasonable number of data points" (it does not always honor the
 * requested width exactly). This adapter requests `interval` sized to the
 * FULL window width in minutes ({@link intervalForWindow}) — biasing
 * strongly toward exactly one bucket in the common case — but, like
 * langfuse.ts's `fetchMetric`, never ASSUMES that shape: every returned
 * data point is rendered as its OWN `signal` line (skipping
 * non-numeric/null values — Sentry's own "no data" signal, never
 * fabricated as `0`), so a request Sentry chose to bucket more finely than
 * asked degrades to multiple honest, individually-timestamped lines rather
 * than a silently wrong merged number. The existing overall `limit` cap
 * (never a dedicated bucket-count cap) is what "cap buckets" means in
 * practice here, identical to how langfuse.ts already handles this same
 * case.
 *
 * VALUE KEY (`signals`): the docs' own single worked example
 * (`yAxis=count()`) shows the per-point value nested as `{"count": n}` —
 * the aggregation's OWN name, parens stripped. No worked example exists
 * for `p95(transaction.duration)`'s own key naming, so rather than guess a
 * specific string, {@link firstNumericValue} reads the first NUMERIC value
 * out of the inner object generically, regardless of its key name —
 * correct under either possible naming convention, and never silently
 * reads the wrong field if Sentry's actual key differs from a guessed
 * literal.
 *
 * SIGNALS' THREE METRICS are this adapter's own judgment call for a small
 * RED-shaped set (mirrors langfuse.ts's identical disclosed judgment call —
 * the plan pins "error counts (+ p95 if available)", not an exact list):
 * `sentry.events.count` (throughput), `sentry.events.count{level="error"}`
 * (the level=error subset — Sentry issues also carry `warning`/`fatal`/
 * `info`/`debug`, so this is a real narrowing, not a relabeling of the
 * first metric), `sentry.events.p95_duration` (p95 transaction duration —
 * ONLY populated for a project with Performance Monitoring / transactions
 * enabled; an error-tracking-only project legitimately renders no line for
 * this metric, which is an honest "no data," not a bug).
 *
 * RENDERING: `search_events` — `event {shortId|id} level={level|-}
 * "{title}" count={count|-} at={iso}` (pinned by this task); one per
 * issue, CHRONOLOGICAL (ascending — mirrors railway.ts's identical
 * `search_events` ordering), capped `Math.max(1, q.limit ?? 200)`, keeping
 * the MOST RECENT entries when over cap (railway.ts's identical "keep the
 * tail of the ascending sort" reasoning). `signals` — the Global
 * Constraints' pinned `signal {name}{labels} window_agg={agg} value={n}
 * at={iso}`, capped `Math.max(1, q.limit ?? 50)`.
 *
 * WINDOW FILTERING: server-side (`start`/`end` on both endpoints) AND
 * client-side (belt-and-braces, the P2 lesson, unqualified by verb) —
 * every issue's own `lastSeen` and every stats data point's own bucket
 * timestamp is re-checked against `[windowStart, windowEnd]` regardless of
 * what the server-side params already did.
 *
 * Q.QUERY: `search_events` (pinned by this task, unlike every prior
 * adapter's "do not trust an unconfirmed server-side filter" caution —
 * this one IS confirmed: "the optional raw search is treated as a single
 * token and searches event titles/messages,"
 * docs.sentry.io/concepts/search/) is sent server-side in `query`
 * (alongside the always-present `project=` param) AND re-applied
 * client-side as a case-insensitive substring match against each issue's
 * OWN (truncated) title specifically — belt-and-braces against Sentry's
 * search matching a DIFFERENT field (message/culprit) than what the
 * rendered line's `"{title}"` promises.
 *
 * QUOTING (`search_events`, Fix Round 1, FOLD 1 — coordinator review): a
 * raw, unquoted `q.query` containing a colon is this adapter's actual core
 * use case gone wrong — a real error title/message is overwhelmingly
 * likely to look like `"TypeError: x is undefined"`, and Sentry's search
 * grammar reads an unquoted `word:word` shape as a `key:value` FILTER
 * TOKEN, not free text (confirmed against Sentry's own parser source,
 * `src/sentry/api/event_search.py`) — silently narrowing or erroring the
 * search server-side, a FALSE NEGATIVE the client-side title re-filter
 * cannot recover (it only re-filters what Sentry actually returned).
 * {@link quoteSearchText} wraps `q.query` in Sentry's documented
 * QUOTED-VALUE syntax before it ever reaches the `query` param — confirmed
 * grammar: `quoted_value = '"' ('\"' / [^"])* '"'`. Fix Round 1 CODA
 * (confirm-pass regression, found AFTER the first fix round shipped): the
 * grammar's `unescape` step — what the PARSER does to the matched text,
 * the half that actually matters for round-tripping — strips ONLY `\"`
 * pairs back to a literal `"`; it has NO `\\`-to-`\` production at all. A
 * bare backslash therefore passes through UNTOUCHED, both on the wire and
 * after unescaping. The first fix round's `quoteSearchText` DOUBLED every
 * backslash before escaping quotes (the conventional algorithm for a
 * grammar that DOES define `\\` as "one literal backslash") — WRONG for
 * THIS grammar specifically: doubling turns a real path/message like
 * `C:\path\to\file` into wire text `C:\\path\\to\\file`, which Sentry's
 * unescape leaves doubled (no rule strips it back down), so the search
 * silently looks for a string that will essentially never appear in real
 * data — the exact false-negative failure class this whole fold exists to
 * prevent. Corrected: {@link quoteSearchText} escapes ONLY literal `"`
 * characters (`\"`) and leaves every bare backslash exactly as typed — no
 * doubling, no other transform. This still leaves ONE narrow, INHERITED
 * edge case unresolved (a limitation of Sentry's own grammar, not this
 * function): a value ending in an ODD number of trailing backslashes
 * immediately before the closing quote can combine with that delimiter
 * and misparse — not a shape any realistic error title/message hits, and
 * not fixable client-side without a grammar the server doesn't actually
 * implement. Round-trip-tested in `sentry.test.ts` (Fix Round 1 coda)
 * against a simulated unescape (`\" → "`, global, nothing else) for colon
 * text, embedded quotes, a backslash path, and a mixed case — pinning the
 * SEMANTICS Sentry's real parser implements, not merely this function's
 * own output shape (the gap that let the backslash-doubling bug pass the
 * first review round). Every `q.query` is quoted
 * ALWAYS, even a plain single word with nothing to escape — uniformity
 * over conditional logic (coordinator's own pinned choice), so the
 * server-side query text has exactly one shape to reason about. `signals`
 * has no verb-pinned `q.query` wording and, unlike `search_events`, NEVER
 * embeds `q.query` into any Sentry-bound `query` string at all (confirmed
 * — none of {@link metricSpecs}'s three fixed queries reference it) —
 * mirrors langfuse.ts's own generalization instead: matched against each
 * signal's `{name}{labels}` identifier, CLIENT-SIDE ONLY (the three metric
 * queries themselves never vary by `q.query`, same "do not let free text
 * change WHICH fixed metrics run" restraint P5's own pinned caution states
 * for a different provider) — so there is nothing for this fold to quote
 * on the `signals` side; confirmed, not overlooked.
 *
 * RATE LIMITS: single page per endpoint (`search_events` — one
 * `limit=100` GET, no cursor-following; this task's own pinned rate-limit
 * discipline, a deliberate v1 bound — a window with over 100 in-window
 * issues under-reports, disclosed), capped page size, no retry loops
 * (docs.sentry.io/api/ratelimits/: `X-Sentry-Rate-Limit-*` headers exist,
 * but this adapter does not read them or retry — a 429 falls through the
 * same generic non-2xx → `upstream_error` mapping as any other non-401/403
 * failure, matching every sibling adapter's precedent of not subdividing
 * further).
 *
 * FAILURE HANDLING: `search_events` is a SINGLE-SCOPE fetch (one page, one
 * endpoint) — NOT try/catch-wrapped locally, mirrors langfuse.ts's
 * `traces`/railway.ts's `changes` (a thrown fetch propagates uncaught to
 * the route, which converts it to `unreachable`). `signals`' THREE metric
 * sub-fetches each get their own try/catch and a cap-exempt marker line,
 * `(signal {key}: sentry {reason|unreachable})`, rendered first — mirrors
 * langfuse.ts's `fetchMetric` exactly. A clean 401/403 maps to
 * `unauthorized`; any other non-2xx OR a malformed body (non-array for
 * issues, non-object for stats) maps to `upstream_error` (this adapter
 * does not further subdivide into `unexpected_status`/`bad_body`, matching
 * every sibling adapter's own precedent).
 *
 * CONFIG_MISSING (mirrors every sibling adapter's identical reasoning): a
 * null `secret`, an absent `config.sentryOrg`, OR an absent
 * `config.sentryProject` all degrade to `config_missing` — none is the
 * caller's fault, none is a credential Sentry itself rejected (that is
 * `unauthorized`); only reconnecting fixes any of the three. Checked in
 * that order (cheapest first, same as every sibling).
 *
 * REQUEST HYGIENE mirrors `railway.ts`/`langfuse.ts`: an 8s
 * `AbortSignal.timeout` per request, `User-Agent: agentrail-console`.
 */

const SENTRY_API = "https://sentry.io/api/0";
const SENTRY_FETCH_TIMEOUT_MS = 8000;

// Sentry's own documented per-page maximum for the issues endpoint — see
// this module's own doc-comment ("RATE LIMITS") for why this adapter takes
// exactly one page rather than following `cursor`.
const SEARCH_EVENTS_PAGE_SIZE = 100;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;
const SIGNALS_DEFAULT_LIMIT = 50;

// Pinned "TITLES ARE UNTRUSTED TEXT" discipline (github.ts's own doc-comment)
// applied to issue titles — the one adapter-side transformation, nothing else.
const TITLE_MAX_LEN = 120;

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

/** The one adapter-side title transformation the spec pins for free-text
 * provider fields (github.ts's "TITLES ARE UNTRUSTED TEXT" precedent). */
function truncateTitle(title: string): string {
  const collapsed = singleLine(title);
  return collapsed.length > TITLE_MAX_LEN ? collapsed.slice(0, TITLE_MAX_LEN) : collapsed;
}

function sentryHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agentrail-console",
  };
}

function sentryFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: sentryHeaders(token),
    signal: AbortSignal.timeout(SENTRY_FETCH_TIMEOUT_MS),
  });
}

/**
 * One GET, mapped to the pinned taxonomy. Deliberately NOT try/catch-wrapped
 * around the `fetch` call itself — see this module's own doc-comment
 * ("FAILURE HANDLING"): a thrown fetch propagates uncaught to whichever
 * caller needs that (the route, for the single-scope `search_events` fetch;
 * `fetchMetric`'s OWN try/catch, for the three-metric `signals` fan-out).
 * The body shape check accepts both an object AND a bare array (Sentry's
 * `search_events` response is a bare array — see the module doc-comment) —
 * each caller further narrows with its own `Array.isArray` check.
 */
async function sentryGet<T>(
  url: string,
  token: string
): Promise<{ ok: true; data: T } | { ok: false; reason: EvidenceDegradationReason }> {
  const res = await sentryFetch(url, token);
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
// search_events
// ---------------------------------------------------------------------------

interface SentryIssueEntry {
  id?: unknown;
  shortId?: unknown;
  level?: unknown;
  title?: unknown;
  count?: unknown;
  lastSeen?: unknown;
}

interface RenderedLine {
  /** Epoch ms — the sort key; never itself rendered raw. */
  at: number;
  line: string;
}

/** `event {shortId|id} level={level|-} "{title}" count={count|-} at={iso}` —
 * pinned field order (this task's own brief). */
function renderEventLine(idText: string, level: string, title: string, countText: string, atIso: string): string {
  return `event ${idText} level=${level} "${title}" count=${countText} at=${atIso}`;
}

/** Wraps free text in Sentry's documented quoted-value syntax before it
 * rides in the `query` param — see the module doc-comment ("QUOTING",
 * Fix Round 1 CODA) for the confirmed grammar and unescape rule. Escapes
 * ONLY literal `"` characters (`\"`) — a bare backslash is left EXACTLY as
 * typed, never doubled: Sentry's own unescape has no `\\`-to-`\`
 * production, so doubling would leave every backslash permanently doubled
 * after the server unescapes, corrupting real paths/messages like
 * `C:\path\to\file` into a search for text that will essentially never
 * appear in real data (the regression the coda fixed). Called
 * unconditionally on every non-empty `q.query` (Fix Round 1, FOLD 1) —
 * never conditionally, so the server-side query text has one shape
 * regardless of whether the text happens to contain a colon today. */
function quoteSearchText(text: string): string {
  const escaped = text.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** One page (this adapter's own rate-limit discipline — see the module
 * doc-comment, "RATE LIMITS") of the organization's issues, scoped to the
 * connected project via the dedicated `project` param (confirmed to accept
 * a slug — see the module doc-comment, "PROJECT SCOPING ASYMMETRY"),
 * window-filtered server-side. `query` is whatever the caller hands in
 * VERBATIM — already {@link quoteSearchText}-quoted when it carries real
 * `q.query` text (see the module doc-comment, "QUOTING") — this function
 * itself is quoting-agnostic, just a plain param passthrough. NOT yet
 * client-filtered/rendered (parsing is separated into {@link parseIssues}
 * so the belt-and-braces re-filter and the client-side title re-match stay
 * independently testable, mirroring langfuse.ts's `fetchTraces`/
 * `parseTraces` split). */
async function fetchIssues(
  token: string,
  org: string,
  project: string,
  windowStart: string,
  windowEnd: string,
  query: string
): Promise<{ ok: true; entries: SentryIssueEntry[] } | { ok: false; reason: EvidenceDegradationReason }> {
  const params = new URLSearchParams({
    project,
    query,
    start: windowStart,
    end: windowEnd,
    sort: "date",
    limit: String(SEARCH_EVENTS_PAGE_SIZE),
  });
  const url = `${SENTRY_API}/organizations/${encodeURIComponent(org)}/issues/?${params}`;
  const result = await sentryGet<unknown>(url, token);
  if (!result.ok) return result;
  const entries = Array.isArray(result.data) ? (result.data as SentryIssueEntry[]) : [];
  return { ok: true, entries };
}

/** Parses + belt-and-braces window-re-filters (never trusts the server-side
 * `start`/`end` filter alone — same doctrine as every sibling adapter's
 * identical re-filter) fetched issue entries into candidate rendered lines,
 * EACH carrying its own truncated `title` alongside the rendered text so
 * {@link querySearchEvents} can apply `q.query`'s "match the title, not the
 * whole line" contract without re-parsing. An entry missing BOTH `shortId`
 * and `id`, or carrying an unparseable `lastSeen`, is skipped rather than
 * throwing. */
function parseIssues(
  entries: SentryIssueEntry[],
  windowStart: string,
  windowEnd: string
): Array<RenderedLine & { title: string }> {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const out: Array<RenderedLine & { title: string }> = [];
  for (const entry of entries) {
    const idText =
      typeof entry.shortId === "string" && entry.shortId
        ? entry.shortId
        : typeof entry.id === "string" && entry.id
          ? entry.id
          : null;
    const lastSeenRaw = typeof entry.lastSeen === "string" ? entry.lastSeen : null;
    if (!idText || !lastSeenRaw) continue;
    const atMs = new Date(lastSeenRaw).getTime();
    if (Number.isNaN(atMs)) continue;
    if (atMs < startMs || atMs > endMs) continue;

    const level = typeof entry.level === "string" && entry.level ? entry.level : "-";
    const title = typeof entry.title === "string" ? truncateTitle(entry.title) : "";
    const countText =
      typeof entry.count === "string" && entry.count
        ? entry.count
        : typeof entry.count === "number" && Number.isFinite(entry.count)
          ? String(entry.count)
          : "-";

    out.push({
      at: atMs,
      title,
      line: renderEventLine(singleLine(idText), level, title, countText, new Date(atMs).toISOString()),
    });
  }
  return out;
}

async function querySearchEvents(
  token: string,
  org: string,
  project: string,
  q: EvidenceQuery
): Promise<AdapterResult> {
  // Fix Round 1, FOLD 1: q.query is quoted (never sent bare) so an embedded
  // colon — a real error title's overwhelmingly common shape, "TypeError: x
  // is undefined" — cannot be misread as a key:value search token server
  // side. An absent q.query still sends a bare "" (unchanged): there is no
  // free text to quote, and the empty string's own job (override Sentry's
  // `is:unresolved` default — see the module doc-comment, "QUERY DEFAULT")
  // is unrelated to this fold.
  const serverQuery = q.query ? quoteSearchText(q.query) : "";
  const result = await fetchIssues(token, org, project, q.windowStart, q.windowEnd, serverQuery);
  if (!result.ok) return result;

  // The CLIENT-side re-filter matches the RAW, unquoted q.query against
  // each issue's own title — belt-and-braces against whatever Sentry's
  // server-side search actually matched, unaffected by this fold (pinned:
  // "Keep the client-side substring re-filter unchanged").
  let candidates = parseIssues(result.entries, q.windowStart, q.windowEnd);
  if (q.query) {
    const needle = q.query.toLowerCase();
    candidates = candidates.filter((c) => c.title.toLowerCase().includes(needle));
  }
  if (candidates.length === 0) {
    return { ok: true, raw: NO_MATCHING_EVENTS_MARKER };
  }

  // Chronological (ascending) — pinned (mirrors railway.ts's identical
  // search_events ordering; see the module doc-comment, "RENDERING").
  candidates.sort((a, b) => a.at - b.at);

  // Floor-clamped so limit:0 (or negative) can't slice a non-empty result
  // down to a bare "" that bypasses the honest-empty marker above — mirrors
  // every sibling adapter's identical clamp.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  // Keep the MOST RECENT `limit` lines (the tail of the ascending sort) —
  // mirrors railway.ts's identical reasoning: a debugging investigator is
  // better served by recency than an arbitrary truncation from the
  // window's start. Output stays chronological.
  const capped = candidates.length > limit ? candidates.slice(candidates.length - limit) : candidates;
  return { ok: true, raw: capped.map((c) => c.line).join("\n") };
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
  yAxis: string;
  /** This metric's own `query` param value — ALWAYS scoped to the
   * connected project (see the module doc-comment, "PROJECT SCOPING
   * ASYMMETRY"), optionally narrowed further (the level=error metric). */
  query: string;
  /** The rendered `window_agg=` value. */
  aggLabel: string;
}

/** The THREE fixed RED-shaped queries this adapter runs every `signals`
 * call — see this module's own doc-comment ("SIGNALS' THREE METRICS") for
 * why these three, and why fixed rather than model-supplied. */
function metricSpecs(project: string): MetricSpec[] {
  const scoped = `project:${project}`;
  return [
    { key: "count", name: "sentry.events.count", labels: "", yAxis: "count()", query: scoped, aggLabel: "count" },
    {
      key: "errors",
      name: "sentry.events.count",
      labels: '{level="error"}',
      yAxis: "count()",
      query: `${scoped} level:error`,
      aggLabel: "count",
    },
    {
      key: "p95_duration",
      name: "sentry.events.p95_duration",
      labels: "",
      yAxis: "p95(transaction.duration)",
      query: scoped,
      aggLabel: "p95",
    },
  ];
}

/** Bucket width sized to the FULL window (in minutes — the finest,
 * confirmed-documented unit) — biases toward exactly one returned bucket
 * per metric; see the module doc-comment ("BUCKETING") for why this
 * adapter never ASSUMES that outcome regardless. */
function intervalForWindow(windowStart: string, windowEnd: string): string {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  const minutes = Math.max(1, Math.ceil((endMs - startMs) / 60_000));
  return `${minutes}m`;
}

function buildStatsUrl(org: string, spec: MetricSpec, windowStart: string, windowEnd: string): string {
  const params = new URLSearchParams({
    query: spec.query,
    yAxis: spec.yAxis,
    start: windowStart,
    end: windowEnd,
    interval: intervalForWindow(windowStart, windowEnd),
  });
  return `${SENTRY_API}/organizations/${encodeURIComponent(org)}/events/stats/?${params}`;
}

/** `signal {name}{labels} window_agg={agg} value={n} at={iso}` — the
 * Global Constraints' pinned `signals` convention. */
function renderSignalLine(spec: MetricSpec, value: number, atIso: string): string {
  return `signal ${spec.name}${spec.labels} window_agg=${spec.aggLabel} value=${value} at=${atIso}`;
}

/** Reads the first NUMERIC value out of a stats data point's inner object,
 * regardless of its key name — see the module doc-comment ("VALUE KEY")
 * for why this is deliberately name-agnostic rather than guessing a
 * specific key string. */
function firstNumericValue(point: unknown): number | null {
  if (!point || typeof point !== "object") return null;
  for (const v of Object.values(point as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

interface StatsBody {
  data?: unknown;
}

type MetricOutcome = { ok: true; lines: RenderedLine[] } | { ok: false; marker: string };

/** One metric's own fetch — its OWN try/catch (per-metric granularity;
 * mirrors langfuse.ts's `fetchMetric` exactly, applied to a FIXED set of
 * three Sentry metrics instead of three Langfuse ones). Each returned
 * `[timestamp, [point]]` pair is rendered as its OWN line — see the module
 * doc-comment ("BUCKETING") for why this never assumes exactly one pair. A
 * pair whose timestamp lands outside `[windowStart, windowEnd]` is skipped
 * (belt-and-braces — mirrors every sibling adapter's identical re-filter,
 * unqualified by verb). A pair with no usable numeric value ({@link
 * firstNumericValue} returns null — Sentry's own "no data" signal) is
 * skipped, never rendered as a fabricated `value=0`. */
async function fetchMetric(
  token: string,
  org: string,
  spec: MetricSpec,
  windowStart: string,
  windowEnd: string
): Promise<MetricOutcome> {
  let result: Awaited<ReturnType<typeof sentryGet<StatsBody>>>;
  try {
    result = await sentryGet<StatsBody>(buildStatsUrl(org, spec, windowStart, windowEnd), token);
  } catch {
    return { ok: false, marker: `(signal ${spec.key}: sentry unreachable)` };
  }
  if (!result.ok) {
    return { ok: false, marker: `(signal ${spec.key}: sentry ${result.reason})` };
  }

  const points = Array.isArray(result.data.data) ? result.data.data : [];
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();

  const lines: RenderedLine[] = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [tsRaw, innerArr] = point as [unknown, unknown];
    const tsSeconds = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? tsRaw : null;
    if (tsSeconds === null) continue;
    const atMs = tsSeconds * 1000;
    // Belt-and-braces window re-filter — mirrors langfuse.ts's fetchMetric
    // (Fix Round 1, FIX 2) exactly.
    if (atMs < startMs || atMs > endMs) continue;

    const innerPoint = Array.isArray(innerArr) ? innerArr[0] : innerArr;
    const value = firstNumericValue(innerPoint);
    if (value === null) continue;

    lines.push({ at: atMs, line: renderSignalLine(spec, value, new Date(atMs).toISOString()) });
  }
  return { ok: true, lines };
}

async function querySignals(token: string, org: string, project: string, q: EvidenceQuery): Promise<AdapterResult> {
  const specs = metricSpecs(project);
  const outcomes = await Promise.all(
    specs.map((spec) => fetchMetric(token, org, spec, q.windowStart, q.windowEnd))
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
  // call. Mirrors langfuse.ts's/railway.ts's identical "all scopes failing"
  // collapse.
  if (successCount === 0) {
    return { ok: false, reason: "upstream_error" };
  }

  // `q.query` matches a signal's own name+labels identifier — NOT the whole
  // rendered line (mirrors langfuse.ts's identical `signals` contract; see
  // the module doc-comment).
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

  // Most-recent-first — consistent with langfuse.ts's identical choice (no
  // verb-specific ordering pinned for `signals`).
  filtered.sort((a, b) => b.at - a.at);

  // Markers are CAP-EXEMPT and rendered FIRST — mirrors langfuse.ts's/
  // railway.ts's identical discipline.
  const limit = Math.max(1, q.limit ?? SIGNALS_DEFAULT_LIMIT);
  const cappedLines = filtered.slice(0, limit).map((l) => l.line);
  return { ok: true, raw: [...markers, ...cappedLines].join("\n") };
}

// ---------------------------------------------------------------------------

export const sentryAdapter: EvidenceAdapter = {
  provider: "sentry",
  verbs: ["search_events", "signals"],
  async query(workspaceId, q: EvidenceQuery, secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }

    switch (q.verb) {
      case "search_events":
      case "signals":
        break;
      default:
        // This adapter declares only [search_events, signals] — the route
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

    const row = await getConnector(workspaceId, "sentry");
    const org = row?.config.sentryOrg;
    if (!org) {
      return { ok: false, reason: "config_missing" };
    }
    const project = row?.config.sentryProject;
    if (!project) {
      return { ok: false, reason: "config_missing" };
    }

    // OAuth Connect Wave 3, W3-T3 — see this module's own doc-comment
    // ("CREDENTIAL") for the full contract. `auth.reason` is already a
    // member of this adapter's own `EvidenceDegradationReason` union, so it
    // passes straight through with no mapping.
    const auth = await resolveProviderAuth(workspaceId, "sentry");
    if (!auth.ok) {
      return { ok: false, reason: auth.reason };
    }

    return q.verb === "search_events"
      ? querySearchEvents(auth.secret, org, project, q)
      : querySignals(auth.secret, org, project, q);
  },
};

registerAdapter(sentryAdapter);
