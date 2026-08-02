import { describe, expect, it } from "vitest";
import {
  capacityText,
  capacityUsedText,
  formatNeedsYouBreakdown,
  formatWeekRangeLabel,
  inProgressStateLabel,
  isAtOrPastCurrentWeek,
  seatsInUseText,
  shiftWeek,
  shippedStripText,
} from "./digest-panel-helpers";

describe("inProgressStateLabel", () => {
  it("maps running to 'In progress' (spec §3 vocabulary)", () => {
    expect(inProgressStateLabel("running")).toBe("In progress");
  });

  it("maps queued to 'Assigned' (spec §3 vocabulary)", () => {
    expect(inProgressStateLabel("queued")).toBe("Assigned");
  });
});

describe("formatWeekRangeLabel", () => {
  it("renders a Monday-to-Sunday range from the exclusive-end week", () => {
    const label = formatWeekRangeLabel({
      start: "2026-07-13T00:00:00.000Z",
      end: "2026-07-20T00:00:00.000Z",
    });
    expect(label).toBe("Jul 13 – Jul 19, 2026");
  });
});

describe("formatNeedsYouBreakdown", () => {
  it("lists both categories when both are non-zero", () => {
    expect(
      formatNeedsYouBreakdown({ escalatedToHuman: 2, parked: 1 })
    ).toBe("2 escalated to human, 1 blocked");
  });

  it("omits a zero category", () => {
    expect(formatNeedsYouBreakdown({ escalatedToHuman: 0, parked: 3 })).toBe(
      "3 blocked"
    );
  });

  it("returns an empty string when there is nothing to report", () => {
    expect(formatNeedsYouBreakdown({ escalatedToHuman: 0, parked: 0 })).toBe("");
  });
});

describe("shiftWeek", () => {
  it("shifts a week start forward by n weeks", () => {
    expect(shiftWeek("2026-07-13", 1)).toBe("2026-07-20");
  });

  it("shifts a week start backward by n weeks", () => {
    expect(shiftWeek("2026-07-13", -1)).toBe("2026-07-06");
  });

  it("is a no-op for delta 0", () => {
    expect(shiftWeek("2026-07-13", 0)).toBe("2026-07-13");
  });
});

describe("isAtOrPastCurrentWeek", () => {
  it("is true when the displayed week's end is still in the future (the current week)", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const week = { end: "2026-07-20T00:00:00.000Z" };
    expect(isAtOrPastCurrentWeek(week, now)).toBe(true);
  });

  it("is false for a past week whose end has already elapsed", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const week = { end: "2026-07-13T00:00:00.000Z" };
    expect(isAtOrPastCurrentWeek(week, now)).toBe(false);
  });
});

describe("capacityText (subscription slice 6 plan card — pinned copy)", () => {
  it("renders the pinned 'used of total tasks this month' phrasing", () => {
    expect(capacityText(3, 10)).toBe("3 of 10 tasks this month");
  });

  it("renders zero usage without special-casing", () => {
    expect(capacityText(0, 200)).toBe("0 of 200 tasks this month");
  });
});

describe("seatsInUseText (2026-08-02 owner ruling — no customer-facing trial; usage-only seats row for the digest's no-plan card)", () => {
  it("renders '<n> in use'", () => {
    expect(seatsInUseText(3)).toBe("3 in use");
  });

  it("renders zero plainly", () => {
    expect(seatsInUseText(0)).toBe("0 in use");
  });
});

describe("capacityUsedText (2026-08-02 owner ruling — usage-only capacity row for the digest's no-plan card; still tasks, never dollars)", () => {
  it("renders '<n> tasks this month'", () => {
    expect(capacityUsedText(42)).toBe("42 tasks this month");
  });

  it("renders zero plainly", () => {
    expect(capacityUsedText(0)).toBe("0 tasks this month");
  });
});

describe("shippedStripText (subscription slice 6 all-time-shipped strip — pinned copy)", () => {
  it("renders the pinned 'n tasks shipped all-time' phrasing", () => {
    expect(shippedStripText(128)).toBe("128 tasks shipped all-time");
  });

  it("renders zero without special-casing", () => {
    expect(shippedStripText(0)).toBe("0 tasks shipped all-time");
  });

  it("renders singular count with the same plural phrasing (house style: never editorializes grammar)", () => {
    expect(shippedStripText(1)).toBe("1 tasks shipped all-time");
  });
});
