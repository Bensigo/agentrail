// Unit tests for the weekly spend-by-intent report core (#1339, the last
// remaining piece). No SDK, no live network — the only real HTTP call lives
// in scripts/spend-by-intent.mjs; this exercises the pure query-building and
// response-formatting logic against the EXACT, verified Langfuse Metrics API
// v2 shapes (a real query run against prod, 2026-07-20).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMetricsUrl,
  buildSpendByIntentQuery,
  formatCost,
  formatSpendByIntentRows,
  intentLabelFromTags,
  METRICS_PATH,
  renderSpendByIntentReport,
  resolveWeekWindow,
  SPEND_BY_INTENT_VIEW,
} from "../agent/lib/spend-by-intent.core.mjs";

// ---------------------------------------------------------------------------
// resolveWeekWindow
// ---------------------------------------------------------------------------

test("resolveWeekWindow: default 4 weeks back from an injected now, both timestamps ISO", () => {
  const fixedNow = Date.parse("2026-07-20T12:00:00.000Z");
  const { fromTimestamp, toTimestamp } = resolveWeekWindow({ now: () => fixedNow });
  assert.equal(toTimestamp, "2026-07-20T12:00:00.000Z");
  // 4 weeks = 28 days back.
  assert.equal(fromTimestamp, "2026-06-22T12:00:00.000Z");
});

test("resolveWeekWindow: honors an explicit weeksBack", () => {
  const fixedNow = Date.parse("2026-07-20T00:00:00.000Z");
  const { fromTimestamp, toTimestamp } = resolveWeekWindow({ weeksBack: 1, now: () => fixedNow });
  assert.equal(toTimestamp, "2026-07-20T00:00:00.000Z");
  assert.equal(fromTimestamp, "2026-07-13T00:00:00.000Z");
});

test("resolveWeekWindow: defaults `now` to the real clock when not injected", () => {
  const before = Date.now();
  const { toTimestamp } = resolveWeekWindow({ weeksBack: 1 });
  const after = Date.now();
  const toMillis = Date.parse(toTimestamp);
  assert.ok(toMillis >= before && toMillis <= after);
});

// ---------------------------------------------------------------------------
// buildSpendByIntentQuery — exact shape from the verified contract.
// ---------------------------------------------------------------------------

test("buildSpendByIntentQuery: builds the exact verified Metrics API v2 query shape", () => {
  const query = buildSpendByIntentQuery({
    fromTimestamp: "2026-06-22T00:00:00.000Z",
    toTimestamp: "2026-07-20T00:00:00.000Z",
  });
  assert.deepEqual(query, {
    view: "observations",
    dimensions: [{ field: "tags" }],
    metrics: [{ measure: "totalCost", aggregation: "sum" }],
    filters: [],
    timeDimension: { granularity: "week" },
    fromTimestamp: "2026-06-22T00:00:00.000Z",
    toTimestamp: "2026-07-20T00:00:00.000Z",
  });
  assert.equal(query.view, SPEND_BY_INTENT_VIEW);
});

test("buildSpendByIntentQuery: fromTimestamp/toTimestamp are carried through verbatim, not reformatted", () => {
  const query = buildSpendByIntentQuery({ fromTimestamp: "not-really-iso", toTimestamp: "also-not" });
  assert.equal(query.fromTimestamp, "not-really-iso");
  assert.equal(query.toTimestamp, "also-not");
});

// ---------------------------------------------------------------------------
// buildMetricsUrl
// ---------------------------------------------------------------------------

test("buildMetricsUrl: targets the v2 metrics route and URL-encodes the query JSON", () => {
  const query = buildSpendByIntentQuery({
    fromTimestamp: "2026-06-22T00:00:00.000Z",
    toTimestamp: "2026-07-20T00:00:00.000Z",
  });
  const url = buildMetricsUrl("https://jp.cloud.langfuse.com", query);
  assert.equal(url, `https://jp.cloud.langfuse.com${METRICS_PATH}?query=${encodeURIComponent(JSON.stringify(query))}`);
  // Round-trips back to the exact same object.
  const parsedQuery = JSON.parse(decodeURIComponent(new URL(url).search.slice("?query=".length)));
  assert.deepEqual(parsedQuery, query);
});

test("buildMetricsUrl: trims and de-slashes the base URL", () => {
  const url = buildMetricsUrl("  https://jp.cloud.langfuse.com/  ", { a: 1 });
  assert.equal(url, `https://jp.cloud.langfuse.com${METRICS_PATH}?query=%7B%22a%22%3A1%7D`);
});

// ---------------------------------------------------------------------------
// intentLabelFromTags
// ---------------------------------------------------------------------------

test("intentLabelFromTags: empty tags array → untagged", () => {
  assert.equal(intentLabelFromTags([]), "untagged");
});

test("intentLabelFromTags: missing/non-array tags → untagged", () => {
  assert.equal(intentLabelFromTags(undefined), "untagged");
  assert.equal(intentLabelFromTags(null), "untagged");
});

test("intentLabelFromTags: strips the intent: prefix for this codebase's real tags", () => {
  assert.equal(intentLabelFromTags(["intent:chit-chat"]), "chit-chat");
  assert.equal(intentLabelFromTags(["intent:capable"]), "capable");
});

test("intentLabelFromTags: an unexpected non-intent tag is still rendered, not dropped", () => {
  assert.equal(intentLabelFromTags(["some-other-tag"]), "some-other-tag");
});

test("intentLabelFromTags: multiple tags join with +, since Langfuse tags are inherently multi-valued", () => {
  assert.equal(intentLabelFromTags(["intent:chit-chat", "extra"]), "chit-chat+extra");
});

// ---------------------------------------------------------------------------
// formatCost — the null-vs-0 distinction is the whole point.
// ---------------------------------------------------------------------------

test("formatCost: null → 'no data' (never coalesced to $0.00)", () => {
  assert.equal(formatCost(null), "no data");
});

test("formatCost: undefined → 'no data'", () => {
  assert.equal(formatCost(undefined), "no data");
});

test("formatCost: a genuine 0 → '$0.00' (data exists, cost happened to be zero)", () => {
  assert.equal(formatCost(0), "$0.00");
});

test("formatCost: a positive number → formatted to 2 decimals", () => {
  assert.equal(formatCost(12.3456), "$12.35");
  assert.equal(formatCost(1), "$1.00");
});

test("formatCost: non-finite input degrades to 'no data' rather than printing NaN", () => {
  assert.equal(formatCost(NaN), "no data");
  assert.equal(formatCost("not-a-number"), "no data");
});

// ---------------------------------------------------------------------------
// formatSpendByIntentRows — against the REAL verified response shape.
// ---------------------------------------------------------------------------

const REAL_SHAPE_RESPONSE = {
  data: [
    { tags: [], time_dimension: "2026-06-15", sum_totalCost: null },
    { tags: [], time_dimension: "2026-07-13", sum_totalCost: 0 },
  ],
};

test("formatSpendByIntentRows: matches the real verified response shape, preserving null vs 0", () => {
  const rows = formatSpendByIntentRows(REAL_SHAPE_RESPONSE);
  assert.deepEqual(rows, [
    { week: "2026-06-15", intent: "untagged", cost: "no data" },
    { week: "2026-07-13", intent: "untagged", cost: "$0.00" },
  ]);
});

test("formatSpendByIntentRows: mixed intents across weeks, sorted by week then intent", () => {
  const response = {
    data: [
      { tags: ["intent:capable"], time_dimension: "2026-07-13", sum_totalCost: 4.2 },
      { tags: ["intent:chit-chat"], time_dimension: "2026-07-13", sum_totalCost: 0.01 },
      { tags: [], time_dimension: "2026-07-06", sum_totalCost: null },
    ],
  };
  const rows = formatSpendByIntentRows(response);
  assert.deepEqual(rows, [
    { week: "2026-07-06", intent: "untagged", cost: "no data" },
    { week: "2026-07-13", intent: "capable", cost: "$4.20" },
    { week: "2026-07-13", intent: "chit-chat", cost: "$0.01" },
  ]);
});

test("formatSpendByIntentRows: no data / non-array data → empty rows, never throws", () => {
  assert.deepEqual(formatSpendByIntentRows({}), []);
  assert.deepEqual(formatSpendByIntentRows({ data: [] }), []);
  assert.deepEqual(formatSpendByIntentRows(undefined), []);
});

test("formatSpendByIntentRows: a row with a missing/blank time_dimension falls back to 'unknown' rather than crashing", () => {
  const rows = formatSpendByIntentRows({ data: [{ tags: [], sum_totalCost: 1 }] });
  assert.deepEqual(rows, [{ week: "unknown", intent: "untagged", cost: "$1.00" }]);
});

// ---------------------------------------------------------------------------
// renderSpendByIntentReport
// ---------------------------------------------------------------------------

test("renderSpendByIntentReport: real-shape response renders a readable table with the null/0 distinction intact", () => {
  const report = renderSpendByIntentReport(REAL_SHAPE_RESPONSE, {
    weeksBack: 4,
    fromTimestamp: "2026-06-15T00:00:00.000Z",
    toTimestamp: "2026-07-20T00:00:00.000Z",
  });
  assert.match(report, /Spend by intent — last 4 week\(s\)/);
  assert.match(report, /2026-06-15T00:00:00\.000Z \.\. 2026-07-20T00:00:00\.000Z/);
  assert.match(report, /2026-06-15\s+untagged\s+no data/);
  assert.match(report, /2026-07-13\s+untagged\s+\$0\.00/);
});

test("renderSpendByIntentReport: zero rows renders an explicit 'no data returned' line, not a blank print", () => {
  const report = renderSpendByIntentReport({ data: [] }, { weeksBack: 4 });
  assert.match(report, /Spend by intent — last 4 week\(s\)/);
  assert.match(report, /no data returned/);
});

test("renderSpendByIntentReport: omits the window note when timestamps aren't supplied", () => {
  const report = renderSpendByIntentReport(REAL_SHAPE_RESPONSE, { weeksBack: 4 });
  assert.match(report, /^Spend by intent — last 4 week\(s\)\n/);
  assert.doesNotMatch(report, /\.\./);
});
