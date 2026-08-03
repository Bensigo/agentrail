// reviewer_suppressions — read-only Arc E2 Judgment Ledger consumer.
//
// It fetches per-repo suppression rules derived from repeated dismissed
// review_outcome judgment events. The tool never writes, never gates, and
// degrades to an empty rule set on configuration, network, route, or storage
// failure so review can continue.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { reviewerSuppressions } from "../lib/reviewer_suppressions.core.mjs";

const TIMEOUT_MS = 8000;

async function realTransport(
  url: string,
  init: { headers: Record<string, string> },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers: init.headers, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

export default defineTool({
  description:
    "Read-only: fetch per-repo reviewer suppression rules. A rule exists only " +
    "after at least three review_outcome judgment events dismissed the same " +
    "normalized finding class for this repo. Use once after fetch_pr_diff. " +
    "When a real finding matches a returned findingClass, suppress that " +
    "finding from findings and add an investigated entry explaining the " +
    "suppression with the rule's count and sourceEventIds. Writes nothing, " +
    "needs no approval, and returns no rules when the console cannot load " +
    "suppression state.",
  inputSchema: z.object({
    repo: z.string().min(1).describe("owner/name of the reviewed repo, given to you in your task."),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return reviewerSuppressions({
      env: process.env,
      eveSessionId,
      repo: input.repo,
      transport: realTransport,
    });
  },
});
