import { describe, expect, it } from "vitest";
import type { AcceptanceWorkspaceOutcomeSummary } from "@agentrail/db-postgres";
import {
  AcceptanceOutcomeSummaryPanel,
  formatWorkspaceOutcomeSummaryWindow,
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

describe("formatWorkspaceOutcomeSummaryWindow", () => {
  it("formats the exact UTC range instead of hiding it behind a relative label", () => {
    expect(formatWorkspaceOutcomeSummaryWindow(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-08T00:00:00.000Z")
    )).toBe("Aug 01, 2026 00:00 UTC – Aug 08, 2026 00:00 UTC");
  });
});

describe("AcceptanceOutcomeSummaryPanel", () => {
  it("renders separate trust-outcome cards and keeps Jace verdicts distinct from human decisions", () => {
    const text = normalizedText(AcceptanceOutcomeSummaryPanel({
      summary: summary(),
      activeRange: "7d",
    }));

    expect(text).toContain("Trust outcomes");
    expect(text).toContain("Exact-head evidence and human decisions. Aug 01, 2026 00:00 UTC – Aug 08, 2026 00:00 UTC");
    expect(text).toContain("24h 7d 30d 1y");
    expect(text).toContain("Reviewed PR revisions 3");
    expect(text).toContain("Jace proven 2");
    expect(text).toContain("Jace not proven 1");
    expect(text).toContain("Pending review 3");
    expect(text).toContain("queued 1 · claimed 2");
    expect(text).toContain("Awaiting human decision 2");
    expect(text).toContain("Jace blocked 1");
    expect(text).toContain("Approved 1");
    expect(text).toContain("Changes requested 1");
    expect(text).toContain("Approved with exception 1");
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
      activeRange: "30d",
    }));

    expect(text).toContain("No completed evidence reviews in this range. Pending work remains visible below.");
    expect(text).toContain("Reviewed PR revisions 0");
    expect(text).toContain("Jace not proven 0");
    expect(text).toContain("Changes requested 0");
    expect(text).toContain("Pending review 1");
    expect(text).toContain("Awaiting human decision 1");
  });
});
