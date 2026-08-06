import { describe, expect, it } from "vitest";
import type { AcceptanceWorkspaceOutcomeSummary } from "@agentrail/db-postgres";
import {
  AcceptanceOutcomeSummaryPanel,
  formatWorkspaceOutcomeSummaryWindow,
  workspaceOutcomeSummaryWindow,
} from "./acceptance-outcome-summary";

interface ElementLike {
  type?: unknown;
  props?: { children?: unknown };
}

function textContent(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  const element = node as ElementLike;
  if (typeof element.type === "function") {
    return textContent((element.type as (props: Record<string, unknown>) => unknown)(
      (element as { props?: Record<string, unknown> }).props ?? {}
    ));
  }
  return textContent(element.props?.children);
}

function normalizedText(node: unknown): string {
  return textContent(node).replace(/\s+/g, " ").replace(/\s+:/g, ":").trim();
}

function summary(overrides: Partial<AcceptanceWorkspaceOutcomeSummary> = {}): AcceptanceWorkspaceOutcomeSummary {
  return {
    workspaceId: "workspace-1",
    windowFromUtcInclusive: new Date("2026-08-01T00:00:00.000Z"),
    windowToUtcExclusive: new Date("2026-08-08T00:00:00.000Z"),
    countedAtUtc: new Date("2026-08-08T00:00:00.000Z"),
    reviewedPrRevisionCount: 3,
    jaceVerdicts: { proven: 2, notProven: 1, otherStatuses: { blocked: 1 } },
    humanDecisions: {
      approved: 1,
      changesRequested: 1,
      rejected: 0,
      approvedWithException: 1,
    },
    pendingReviews: { queued: 1, claimed: 2, total: 3 },
    pendingHumanDecisions: 2,
    ...overrides,
  };
}

describe("workspaceOutcomeSummaryWindow", () => {
  it("uses one explicit half-open UTC 30-day window", () => {
    expect(workspaceOutcomeSummaryWindow(new Date("2026-08-31T00:00:00.000Z"))).toEqual({
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-31T00:00:00.000Z"),
    });
  });

  it("formats the exact UTC range instead of hiding it behind a relative label", () => {
    expect(formatWorkspaceOutcomeSummaryWindow(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-08T00:00:00.000Z")
    )).toBe("Aug 01, 2026 00:00 UTC – Aug 08, 2026 00:00 UTC");
  });
});

describe("AcceptanceOutcomeSummaryPanel", () => {
  it("keeps Jace verdicts distinct from human decisions and renders pending work", () => {
    const text = normalizedText(AcceptanceOutcomeSummaryPanel({ summary: summary() }));

    expect(text).toContain("Last 30 days");
    expect(text).toContain("UTC window (half-open): Aug 01, 2026 00:00 UTC – Aug 08, 2026 00:00 UTC");
    expect(text).toContain("Reviewed PR revisions: 3");
    expect(text).toContain("Pending reviews: 3");
    expect(text).toContain("queued 1 · claimed 2");
    expect(text).toContain("Awaiting human decision: 2");
    expect(text).toContain("Jace verdicts");
    expect(text).toContain("not proven: 1");
    expect(text).toContain("blocked: 1");
    expect(text).toContain("Human decisions");
    expect(text).toContain("changes requested: 1");
    expect(text).toContain("approved with exception: 1");
  });

  it("renders honest zeroes and a no-completed-review explanation without hiding current pending work", () => {
    const text = normalizedText(AcceptanceOutcomeSummaryPanel({
      summary: summary({
        reviewedPrRevisionCount: 0,
        jaceVerdicts: { proven: 0, notProven: 0, otherStatuses: {} },
        humanDecisions: {
          approved: 0,
          changesRequested: 0,
          rejected: 0,
          approvedWithException: 0,
        },
        pendingReviews: { queued: 1, claimed: 0, total: 1 },
        pendingHumanDecisions: 1,
      }),
    }));

    expect(text).toContain("No completed evidence reviews landed in this window yet.");
    expect(text).toContain("Reviewed PR revisions: 0");
    expect(text).toContain("not proven: 0");
    expect(text).toContain("changes requested: 0");
    expect(text).toContain("Pending reviews: 1");
    expect(text).toContain("Awaiting human decision: 1");
  });
});
