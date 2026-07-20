// Pure, dependency-free core for the weekly spend-by-intent report (#1339,
// the last remaining piece). No SDK, no network primitives of its own: the
// one real dependency — the HTTP call to Langfuse's Metrics API v2 — lives in
// the thin `scripts/spend-by-intent.mjs` wrapper, exactly like
// `fetch_run_evidence.core.mjs` injects its `transport` and
// `instrumentation.core.mjs` injects its `createSpanProcessor`. This module
// only builds the query and formats the response, so both are unit-testable
// without a live Langfuse project.
//
// Why this report exists: #1339 PR② stamps every chat trace with exactly one
// Langfuse trace tag — `"intent:chit-chat"` or `"intent:capable"`
// (agent/lib/instrumentation.core.mjs's `buildStepStartedResult`, attribute
// `LANGFUSE_TRACE_TAGS_ATTRIBUTE`) — and Langfuse's custom model
// registrations already price every model this codebase uses, so
// `totalCost` in Langfuse is real, not a silent $0. Grouping observations'
// summed `totalCost` by `tags` and by week lets spend be eyeballed per
// intent over time: chit-chat traffic should trend toward near-zero (or
// simply absent) cost once it's routed to a cheap subagent.
//
// Contract verified against a REAL query run against the live prod Langfuse
// project (2026-07-20) — this is not a guess at the API shape:
//
//   GET {LANGFUSE_BASE_URL}/api/public/v2/metrics?query=<URL-encoded JSON>
//   Authorization: Basic base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)
//
//   query = {
//     "view": "observations",
//     "dimensions": [{"field": "tags"}],
//     "metrics": [{"measure": "totalCost", "aggregation": "sum"}],
//     "filters": [],
//     "timeDimension": {"granularity": "week"},
//     "fromTimestamp": "<ISO datetime>",
//     "toTimestamp": "<ISO datetime>"
//   }
//
//   response = { "data": [
//     {"tags": [], "time_dimension": "2026-06-15", "sum_totalCost": null},
//     {"tags": [], "time_dimension": "2026-07-13", "sum_totalCost": 0}
//   ]}
//
// Two shape notes, both load-bearing for the formatter below:
//  - `tags` is an ARRAY per row (Langfuse tags are inherently multi-valued),
//    but every trace THIS codebase produces carries exactly one tag, so in
//    practice each row's `tags` has 0 or 1 elements. `tags: []` means "no
//    tag at all" (traces that predate this instrumentation, or Langfuse was
//    unconfigured at the time) and is labeled "untagged" — never crashed on,
//    never silently dropped.
//  - `sum_totalCost` can be `null` ("no data that week" — a real signal, NOT
//    coalesced to 0, mirroring apps/console/lib/alignment's own
//    `costPerSuccess: number | null` null-vs-0 convention) or a genuine `0`
//    (data exists, cost happened to be zero). The formatter preserves this
//    distinction ("no data" vs "$0.00") rather than collapsing it.

/** The Langfuse Metrics API v2 path, joined onto the configured base URL. */
export const METRICS_PATH = "/api/public/v2/metrics";

/** The Metrics API `view` this report queries — per-observation cost. */
export const SPEND_BY_INTENT_VIEW = "observations";

/** Prefix every intent trace tag carries (`"intent:chit-chat"`, `"intent:capable"`). */
export const INTENT_TAG_PREFIX = "intent:";

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the `[fromTimestamp, toTimestamp]` ISO window for "the last
 * `weeksBack` weeks", ending at `now`. `now` is an injected epoch-millis
 * function (same convention as `console_gated_approval.core.mjs`'s `now:
 * deps.now ?? Date.now` seam) so this is deterministic in tests.
 *
 * @param {{ weeksBack?: number, now?: () => number }} [params]
 * @returns {{ fromTimestamp: string, toTimestamp: string }}
 */
export function resolveWeekWindow({ weeksBack = 4, now = Date.now } = {}) {
  const toMillis = now();
  const fromMillis = toMillis - weeksBack * MS_PER_WEEK;
  return {
    fromTimestamp: new Date(fromMillis).toISOString(),
    toTimestamp: new Date(toMillis).toISOString(),
  };
}

/**
 * Build the Langfuse Metrics API v2 query object for the spend-by-intent
 * view: total cost summed per week, grouped by trace tag. Matches the
 * exact, verified shape in this module's header comment.
 *
 * @param {{ fromTimestamp: string, toTimestamp: string }} params
 * @returns {{
 *   view: "observations",
 *   dimensions: [{ field: "tags" }],
 *   metrics: [{ measure: "totalCost", aggregation: "sum" }],
 *   filters: [],
 *   timeDimension: { granularity: "week" },
 *   fromTimestamp: string,
 *   toTimestamp: string,
 * }}
 */
export function buildSpendByIntentQuery({ fromTimestamp, toTimestamp }) {
  return {
    view: SPEND_BY_INTENT_VIEW,
    dimensions: [{ field: "tags" }],
    metrics: [{ measure: "totalCost", aggregation: "sum" }],
    filters: [],
    timeDimension: { granularity: "week" },
    fromTimestamp,
    toTimestamp,
  };
}

/**
 * Build the full Metrics API v2 URL: the base URL (trimmed + de-slashed,
 * matching `fetch_run_evidence.core.mjs`'s `buildBundleUrl` convention) with
 * the query JSON URL-encoded into the `query` param.
 *
 * @param {string} baseUrl
 * @param {Record<string, unknown>} query
 * @returns {string}
 */
export function buildMetricsUrl(baseUrl, query) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  return `${base}${METRICS_PATH}?query=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * Human-readable label for one metrics row's `tags` array.
 *  - `[]` (no tag at all) → `"untagged"`.
 *  - `["intent:chit-chat"]` → `"chit-chat"` (the `"intent:"` prefix is
 *    stripped — the report is already titled "by intent").
 *  - Any other/unexpected tag(s) (not this codebase's convention today, but
 *    tags are inherently multi-valued in Langfuse in general) are still
 *    rendered rather than dropped, joined with `"+"`.
 *
 * @param {readonly unknown[] | undefined} tags
 * @returns {string}
 */
export function intentLabelFromTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return "untagged";
  return tags
    .map((tag) => {
      const s = String(tag ?? "");
      return s.startsWith(INTENT_TAG_PREFIX) ? s.slice(INTENT_TAG_PREFIX.length) : s;
    })
    .join("+");
}

/**
 * Format one row's `sum_totalCost` for display. `null`/`undefined` (no data
 * that week — never coalesced to 0) renders as `"no data"`; any other
 * non-finite value degrades to the same `"no data"` label rather than
 * printing `NaN`/`undefined`; a genuine finite number (including `0`)
 * renders as `"$X.XX"`.
 *
 * @param {number|null|undefined} sumTotalCost
 * @returns {string}
 */
export function formatCost(sumTotalCost) {
  if (sumTotalCost === null || sumTotalCost === undefined) return "no data";
  const n = Number(sumTotalCost);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "no data";
}

/**
 * Format the raw Metrics API v2 response into rows sorted by week then
 * intent — the shape both `renderSpendByIntentReport` and any other
 * consumer print/inspect directly.
 *
 * @param {{ data?: readonly { tags?: readonly unknown[], time_dimension?: string, sum_totalCost?: number|null }[] }} apiResponse
 * @returns {{ week: string, intent: string, cost: string }[]}
 */
export function formatSpendByIntentRows(apiResponse) {
  const data = Array.isArray(apiResponse?.data) ? apiResponse.data : [];
  return data
    .map((row) => ({
      week: typeof row?.time_dimension === "string" && row.time_dimension ? row.time_dimension : "unknown",
      intent: intentLabelFromTags(row?.tags),
      cost: formatCost(row?.sum_totalCost),
    }))
    .sort((a, b) => (a.week === b.week ? a.intent.localeCompare(b.intent) : a.week.localeCompare(b.week)));
}

/**
 * Render the full human-readable weekly-by-intent-tag report: a header line
 * (the lookback window, when supplied) followed by an aligned week/intent/
 * cost table, or an explicit "no data" line when the API returned zero rows
 * (e.g. no traffic yet — never a blank/confusing empty print).
 *
 * @param {{ data?: readonly { tags?: readonly unknown[], time_dimension?: string, sum_totalCost?: number|null }[] }} apiResponse
 * @param {{ weeksBack?: number, fromTimestamp?: string, toTimestamp?: string }} [window]
 * @returns {string}
 */
export function renderSpendByIntentReport(apiResponse, { weeksBack, fromTimestamp, toTimestamp } = {}) {
  const rows = formatSpendByIntentRows(apiResponse);
  const windowNote = fromTimestamp && toTimestamp ? ` (${fromTimestamp} .. ${toTimestamp})` : "";
  const header = `Spend by intent — last ${weeksBack ?? "?"} week(s)${windowNote}`;

  if (rows.length === 0) {
    return `${header}\n\n(no data returned)`;
  }

  const weekHeader = "week";
  const intentHeader = "intent";
  const weekWidth = Math.max(weekHeader.length, ...rows.map((r) => r.week.length));
  const intentWidth = Math.max(intentHeader.length, ...rows.map((r) => r.intent.length));

  const lines = [
    header,
    "",
    `${weekHeader.padEnd(weekWidth)}  ${intentHeader.padEnd(intentWidth)}  cost`,
    ...rows.map((r) => `${r.week.padEnd(weekWidth)}  ${r.intent.padEnd(intentWidth)}  ${r.cost}`),
  ];
  return lines.join("\n");
}
