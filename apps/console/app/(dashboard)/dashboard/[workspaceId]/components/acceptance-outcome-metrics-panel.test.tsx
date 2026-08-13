import { describe, expect, it } from "vitest";
import { AcceptanceOutcomeMetricsSummary } from "./acceptance-outcome-metrics-panel";

type ElementLike = { props?: { children?: unknown } };

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object") return textContent((node as ElementLike).props?.children);
  return "";
}

describe("AcceptanceOutcomeMetricsSummary", () => {
  it("keeps zero, not-recorded, and unknown/excluded counts visibly distinct", () => {
    const text = textContent(AcceptanceOutcomeMetricsSummary({
      data: {
        cohort: {
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
          observedUntil: "2026-08-02T00:00:00.000Z",
        },
        counts: {
          eligible: 3,
          approved: 0,
          approvedWithException: 1,
          changesRequested: 0,
          rejected: 0,
          notRecorded: 2,
          excludedUnknown: 4,
          signedMerged: 1,
          deploymentObserved: 0,
          incidentObserved: 1,
          reverted: 0,
        },
      },
    }));

    expect(text).toContain("Eligible sample3");
    expect(text).toContain("Approved0");
    expect(text).toContain("Approved with exception1");
    expect(text).toContain("Not recorded2");
    expect(text).toContain("Unknown / excluded4");
    expect(text).toContain("Observed lineage");
    expect(text).toContain("Signed merged1");
    expect(text).toContain("Deployment observed0");
    expect(text).toContain("Incident observed1");
    expect(text).toContain("Reverted0");
    expect(text).toContain("Not recorded = no valid receipt");
    expect(text).toContain("Unknown / excluded ≠ zero");
    expect(text).not.toContain("Human decision observations");
  });
});
