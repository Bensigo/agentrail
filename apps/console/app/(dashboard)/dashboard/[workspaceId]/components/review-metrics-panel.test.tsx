import { describe, expect, it } from "vitest";
import { ReviewMetricsCohortRow } from "./review-metrics-panel";

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
    expect(text).toContain("23 min");
    expect(text).toContain("unknown");
    expect(text).toContain("(n=0)");
    expect(text).toContain("1 PR without an opened event");
    expect(text).toContain("Human review minutes are explicit only.");
  });
});
