import { describe, expect, it } from "vitest";
import { AREA_ORDER, groupItemsByArea, isBlockingItem } from "./briefs-format";
import type { BriefItem } from "@agentrail/db-postgres";

function item(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    id: "item-1",
    briefId: "brief-1",
    area: "scope",
    statement: "single approver model",
    evidence: "for now since am the only one approve to publish it",
    kind: "required",
    state: "open",
    resolution: null,
    authority: "jace",
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("groupItemsByArea", () => {
  it("includes every area from AREA_ORDER as a key, even with zero items — an empty area is itself signal", () => {
    const grouped = groupItemsByArea([]);
    expect(Object.keys(grouped)).toEqual(AREA_ORDER);
    for (const area of AREA_ORDER) {
      expect(grouped[area]).toEqual([]);
    }
  });

  it("buckets each item under its own area, preserving input order within a bucket", () => {
    const a = item({ id: "a", area: "problem", statement: "first" });
    const b = item({ id: "b", area: "problem", statement: "second" });
    const c = item({ id: "c", area: "users" });

    const grouped = groupItemsByArea([a, b, c]);

    expect(grouped.problem.map((i) => i.id)).toEqual(["a", "b"]);
    expect(grouped.users.map((i) => i.id)).toEqual(["c"]);
    expect(grouped.constraints).toEqual([]);
  });
});

describe("isBlockingItem", () => {
  it("mirrors computeBriefReadiness's predicate: true only for open + unknown", () => {
    expect(isBlockingItem({ state: "open", kind: "unknown" })).toBe(true);
  });

  it("is false once state is resolved even if kind stayed unknown-shaped in the argument", () => {
    expect(isBlockingItem({ state: "resolved", kind: "unknown" })).toBe(false);
  });

  it("is false for any non-unknown kind regardless of state", () => {
    expect(isBlockingItem({ state: "open", kind: "required" })).toBe(false);
    expect(isBlockingItem({ state: "open", kind: "optional" })).toBe(false);
    expect(isBlockingItem({ state: "open", kind: "out-of-scope" })).toBe(false);
  });
});
