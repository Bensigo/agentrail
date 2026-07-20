// Weekly spend-by-intent report for Jace (#1339, the last remaining piece).
//
// Every chat trace #1339 PR② stamps carries exactly one Langfuse trace tag —
// "intent:chit-chat" or "intent:capable" (agent/lib/instrumentation.core.mjs's
// buildStepStartedResult) — and Langfuse's custom model registrations already
// price every model this codebase uses, so `totalCost` in Langfuse is real,
// not a silent $0. This script queries Langfuse's Metrics API v2
// (GET /api/public/v2/metrics), grouping observations' summed totalCost by
// tag and by week, and prints a human-readable report so spend can be
// eyeballed per intent over time — chit-chat traffic should trend toward
// near-zero (or simply absent) cost once it's routed to a cheap subagent.
//
// All query-building and response-formatting logic lives in the pure
// agent/lib/spend-by-intent.core.mjs (no SDK, no network of its own) — this
// wrapper only resolves env, does the one real fetch, and prints. Same
// pure-core/thin-wrapper split as agent/lib/instrumentation.core.mjs /
// agent/instrumentation.ts.
//
// How to run:
//   node scripts/spend-by-intent.mjs [weeksBack]
//
//   weeksBack   optional positional arg — how many weeks back to look
//               (default 4)
//
// Environment:
//   LANGFUSE_PUBLIC_KEY   Langfuse project public key — same var
//                         isLangfuseConfigured (agent/lib/instrumentation.core.mjs)
//                         checks; reused here rather than re-derived
//   LANGFUSE_SECRET_KEY   Langfuse project secret key
//   LANGFUSE_BASE_URL     Langfuse deployment base URL (e.g. https://cloud.langfuse.com)
//
// When any of the three is unset, this prints an explanation and exits 1 —
// it never silently no-ops or prints an empty report.

import { isLangfuseConfigured } from "../agent/lib/instrumentation.core.mjs";
import {
  buildMetricsUrl,
  buildSpendByIntentQuery,
  renderSpendByIntentReport,
  resolveWeekWindow,
} from "../agent/lib/spend-by-intent.core.mjs";

const DEFAULT_WEEKS_BACK = 4;

/**
 * Parse the optional `weeksBack` positional CLI arg. Throws on a
 * non-positive/non-numeric value so a typo fails loudly instead of silently
 * querying the wrong window.
 *
 * @param {readonly string[]} argv
 * @returns {number}
 */
function parseWeeksBack(argv) {
  const raw = argv[2];
  if (raw === undefined) return DEFAULT_WEEKS_BACK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`weeksBack must be a positive number, got "${raw}"`);
  }
  return n;
}

async function main() {
  const env = process.env;
  if (!isLangfuseConfigured(env)) {
    console.error(
      "Langfuse is not configured: set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, " +
        "and LANGFUSE_BASE_URL to run the spend-by-intent report.",
    );
    process.exit(1);
    return;
  }

  const weeksBack = parseWeeksBack(process.argv);
  const { fromTimestamp, toTimestamp } = resolveWeekWindow({ weeksBack });
  const query = buildSpendByIntentQuery({ fromTimestamp, toTimestamp });
  const url = buildMetricsUrl(env.LANGFUSE_BASE_URL, query);

  // Basic Auth over public:secret key, matching the real transport
  // agent/hooks/langfuse-verdict-score.ts's pushScore uses for
  // POST /api/public/scores.
  const token = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString(
    "base64",
  );
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Basic ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Langfuse metrics API returned HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  const body = await res.json();

  console.log(renderSpendByIntentReport(body, { weeksBack, fromTimestamp, toTimestamp }));
}

main().catch((err) => {
  console.error(`FAIL: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
