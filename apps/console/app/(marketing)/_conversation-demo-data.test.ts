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
  // Subscription platform Task 3: the landing demo hides cost UNCONDITIONALLY
  // (`{ hideCost: true }`), so the drift guard's expected value must pass the
  // SAME opts the real function now does — otherwise this would only prove
  // getDemoOutcomeMessage matches a builder call it no longer makes.
  it("is byte-identical to the real outcome-format builder's output (hideCost: true)", () => {
    const brief = estimateBrief(DEMO_TASK_INPUT);
    expect(getDemoOutcomeMessage()).toBe(
      buildOutcomeMessage(
        {
          issueNumber: DEMO_ISSUE_NUMBER,
          outcome: "green",
          prUrl: DEMO_PR_URL,
          costUsd: brief.estimateUsd,
          merged: false,
        },
        { hideCost: true }
      )
    );
  });

  // "PR ready", NOT "Merged": the demo shows the DEFAULT posture (merge
  // permission off — `workspaces.merge_permission` defaults false), so the
  // stranger's one Approve never implies merge-on-approve. See the data
  // file's own comment (review fix round, 2026-07-19).
  //
  // Subscription platform Task 3: no dollar segment at all — the landing
  // demo never shows a raw $ figure, matching the brief bubble above it
  // (`scopeSentence`, `approval-scope.ts`) and the real product's own ping
  // once subscriptions are enforced.
  it("matches the real template shape: AgentRail: PR ready — issue #N (pr-url) — no dollar segment", () => {
    expect(getDemoOutcomeMessage()).toBe(
      "AgentRail: PR ready — issue #482 (https://github.com/acme/webhooks/pull/128)"
    );
  });

  // Companion pin (binding constraint): the SAME params, called WITHOUT
  // `hideCost`, still reproduce the exact PRE-Task-3 ($-bearing) shape,
  // byte-for-byte — proof that Task 3 only changed the demo's OWN call site,
  // never the builder's default (opts-omitted) behavior.
  it("companion pin: the same params WITHOUT hideCost reproduce the pre-Task-3 dollar-bearing shape byte-for-byte", () => {
    const brief = estimateBrief(DEMO_TASK_INPUT);
    const withCost = buildOutcomeMessage({
      issueNumber: DEMO_ISSUE_NUMBER,
      outcome: "green",
      prUrl: DEMO_PR_URL,
      costUsd: brief.estimateUsd,
      merged: false,
    });
    expect(withCost).toBe(
      `AgentRail: PR ready — issue #482 (https://github.com/acme/webhooks/pull/128 · $${brief.estimateUsd.toFixed(2)})`
    );
  });
});
