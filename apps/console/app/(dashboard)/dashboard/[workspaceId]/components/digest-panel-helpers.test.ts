import { describe, expect, it } from "vitest";
import {
  formatCostUsd,
  formatNeedsYouBreakdown,
  formatTrendPct,
  formatWeekRangeLabel,
  inProgressStateLabel,
  isAtOrPastCurrentWeek,
  shiftWeek,
} from "./digest-panel-helpers";

describe("inProgressStateLabel", () => {
  it("maps running to 'In progress' (spec §3 vocabulary)", () => {
    expect(inProgressStateLabel("running")).toBe("In progress");
  });

  it("maps queued to 'Assigned' (spec §3 vocabulary)", () => {
    expect(inProgressStateLabel("queued")).toBe("Assigned");
  });
});

describe("formatCostUsd", () => {
  it("renders a whole-cent amount with two decimals", () => {
    expect(formatCostUsd(12.5)).toBe("$12.50");
  });

  it("renders exactly $0 without extra precision", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });

  it("renders sub-cent amounts with four decimals so they don't round to zero", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
  });
});

describe("formatTrendPct", () => {
  it("renders a positive trend with a plus sign", () => {
    expect(formatTrendPct(24.6)).toBe("+25% vs last week");
  });

  it("renders a negative trend with the sign already on the number", () => {
    expect(formatTrendPct(-13.2)).toBe("-13% vs last week");
  });

  it("renders no-change copy for a 0% trend", () => {
    expect(formatTrendPct(0)).toBe("No change vs last week");
  });

  it("renders no-baseline copy when trend is null", () => {
    expect(formatTrendPct(null)).toBe("No prior-week data to compare");
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
