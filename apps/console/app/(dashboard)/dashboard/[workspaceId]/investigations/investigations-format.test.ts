import { describe, expect, it } from "vitest";
import { KIND_ORDER, countOpenHypotheses, eligibilityPillLabel, groupItemsByKind } from "./investigations-format";
import type { InvestigationItem } from "@agentrail/db-postgres";

function item(overrides: Partial<InvestigationItem> = {}): InvestigationItem {
  return {
    id: "item-1",
    investigationId: "inv-1",
    kind: "timeline_event",
    body: "checkout started returning 500s around 14:02 UTC",
    mechanism: "",
    state: null,
    evidenceRefs: [],
    data: {},
    authority: "jace",
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    updatedAt: new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  };
}

describe("groupItemsByKind", () => {
  it("includes every kind from KIND_ORDER as a key, even with zero items — an empty kind is itself signal", () => {
    const grouped = groupItemsByKind([]);
    expect(Object.keys(grouped)).toEqual(KIND_ORDER);
    for (const kind of KIND_ORDER) {
      expect(grouped[kind]).toEqual([]);
    }
  });

  it("buckets each item under its own kind, preserving input order within a bucket", () => {
    const a = item({ id: "a", kind: "hypothesis", body: "first" });
    const b = item({ id: "b", kind: "hypothesis", body: "second" });
    const c = item({ id: "c", kind: "finding" });

    const grouped = groupItemsByKind([a, b, c]);

    expect(grouped.hypothesis.map((i) => i.id)).toEqual(["a", "b"]);
    expect(grouped.finding.map((i) => i.id)).toEqual(["c"]);
    expect(grouped.evidence).toEqual([]);
  });

  it("orders kinds as timeline_event, evidence, hypothesis, finding, verdict, lesson_candidate", () => {
    expect(KIND_ORDER).toEqual([
      "timeline_event",
      "evidence",
      "hypothesis",
      "finding",
      "verdict",
      "lesson_candidate",
    ]);
  });
});

describe("countOpenHypotheses", () => {
  it("counts only kind:'hypothesis' items with state:'open'", () => {
    expect(
      countOpenHypotheses([
        { kind: "hypothesis", state: "open" },
        { kind: "hypothesis", state: "supported" },
        { kind: "hypothesis", state: "refuted" },
        { kind: "hypothesis", state: "inconclusive" },
        { kind: "hypothesis", state: "open" },
        { kind: "finding", state: null },
        { kind: "timeline_event", state: null },
      ])
    ).toBe(2);
  });

  it("is zero for an empty item list", () => {
    expect(countOpenHypotheses([])).toBe(0);
  });

  it("ignores an open-state item of a non-hypothesis kind (state is only meaningful for hypotheses)", () => {
    expect(countOpenHypotheses([{ kind: "finding", state: "open" as never }])).toBe(0);
  });
});

describe("eligibilityPillLabel", () => {
  it("is the green 'Eligible' tone with no tooltip when eligible", () => {
    const pill = eligibilityPillLabel({ eligible: true, blocking: [] });
    expect(pill).toEqual({ tone: "eligible", label: "Eligible" });
    expect(pill.tooltip).toBeUndefined();
  });

  it("is the amber 'Not eligible' tone, with the blocking reasons joined into the tooltip, when ineligible", () => {
    const pill = eligibilityPillLabel({
      eligible: false,
      blocking: ["no supported hypothesis with mechanism and evidence", "no refuted rival hypothesis and no solePlausible finding"],
    });
    expect(pill.tone).toBe("ineligible");
    expect(pill.label).toBe("Not eligible");
    expect(pill.tooltip).toBe(
      "no supported hypothesis with mechanism and evidence; no refuted rival hypothesis and no solePlausible finding"
    );
  });

  it("relays blocking reasons verbatim, never re-deriving eligibility from anything else", () => {
    const pill = eligibilityPillLabel({ eligible: false, blocking: ["single reason"] });
    expect(pill.tooltip).toBe("single reason");
  });
});
