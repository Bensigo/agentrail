import { describe, expect, it } from "vitest";
import { ReviewMetricsCohortRow } from "./review-metrics-panel";
import { reviewMetricsCohortUrl } from "./review-metrics-panel-helpers";

type ElementLike = { props?: { children?: unknown } };

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object") {
    return textContent((node as ElementLike).props?.children);
  }
  return "";
}

describe("ReviewMetricsCohortRow", () => {
  it("renders explicit evidence values with their known samples and preserves unknowns", () => {
    const text = textContent(
      ReviewMetricsCohortRow({
        cohort: {
          taskFamily: "dependency-upgrade",
          dateRange: null,
          sampleSize: 2,
          denominator: { openedPullRequests: 2, terminalPullRequests: 1, mergeRate: 1 },
          humanReviewMinutes: { value: 23, knownSampleSize: 1 },
          medianTimeToFirstReviewSeconds: { value: null, knownSampleSize: 0 },
          averageReviewCycles: { value: 1, knownSampleSize: 2 },
          mergeRate: { value: 1, knownSampleSize: 1 },
          postMergeReworkEvents: { value: 0, knownSampleSize: 1 },
          exclusions: ["1 PR without an opened event"],
          limitations: ["Human review minutes are explicit only."],
        },
      })
    );

    expect(text).toContain("dependency-upgrade");
    expect(text).toContain("2 opened · 1 terminal · merge n=1");
    expect(text).toContain("23 min");
    expect(text).toContain("unknown");
    expect(text).toContain("(n=0)");
    expect(text).toContain("1 PR without an opened event");
    expect(text).toContain("Human review minutes are explicit only.");
  });

  it("keeps the client request dated and observation-bounded", () => {
    expect(
      reviewMetricsCohortUrl("ws-1", {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
      })
    ).toBe(
      "/api/v1/workspaces/ws-1/review-metrics/cohorts?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z&observedUntil=2026-08-02T00%3A00%3A00.000Z"
    );
  });
});
