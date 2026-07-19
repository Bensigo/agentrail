import { describe, expect, it } from "vitest";
import { estimateBrief } from "../../lib/alignment";
import { buildOutcomeMessage } from "../../lib/outcome-format";
import {
  DEMO_ISSUE_NUMBER,
  DEMO_PR_URL,
  DEMO_TASK_INPUT,
  getDemoBrief,
  getDemoOutcomeMessage,
} from "./_conversation-demo-data";

// Drift guards (#1279 PR ①): the landing demo must never hardcode a number
// the real product actually computes. Both tests below re-derive the
// expected value from the SAME real functions the marketing module imports,
// independently of that module's internals — if `_conversation-demo-data.ts`
// is ever edited to hardcode a literal instead of calling the real function,
// these still only pass by coincidence today and will drift out of sync the
// next time estimate.ts or outcome-format.ts's shape changes.

describe("getDemoBrief", () => {
  it("is exactly what estimateBrief computes for the demo task — no invented numbers", () => {
    expect(getDemoBrief()).toEqual(estimateBrief(DEMO_TASK_INPUT));
  });

  it("estimate is strictly positive (a real brief, not a placeholder $0)", () => {
    expect(getDemoBrief().estimateUsd).toBeGreaterThan(0);
  });
});

describe("getDemoOutcomeMessage", () => {
  it("is byte-identical to the real outcome-format builder's output", () => {
    const brief = estimateBrief(DEMO_TASK_INPUT);
    expect(getDemoOutcomeMessage()).toBe(
      buildOutcomeMessage({
        issueNumber: DEMO_ISSUE_NUMBER,
        outcome: "green",
        prUrl: DEMO_PR_URL,
        costUsd: brief.estimateUsd,
        merged: true,
      })
    );
  });

  it("matches the real template shape: AgentRail: Merged — issue #N (pr-url · $X.XX)", () => {
    expect(getDemoOutcomeMessage()).toMatch(
      /^AgentRail: Merged — issue #482 \(https:\/\/github\.com\/acme\/webhooks\/pull\/128 · \$\d+\.\d{2}\)$/
    );
  });
});
