import { describe, expect, it } from "vitest";
import {
  capStatusCopy,
  currentUtcMonthWindow,
  formatCostUsd,
  formatMonthLabel,
  formatRelativeTime,
  runStatusLabel,
  spendRatio,
} from "./budget-helpers";

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

  it("renders a large amount with normal two-decimal precision", () => {
    expect(formatCostUsd(40.582196999999994)).toBe("$40.58");
  });
});

describe("currentUtcMonthWindow", () => {
  it("returns the current UTC month's half-open [start, end) window", () => {
    const now = new Date("2026-07-18T15:42:00.000Z");
    expect(currentUtcMonthWindow(now)).toEqual({
      startIso: "2026-07-01T00:00:00.000Z",
      endIso: "2026-08-01T00:00:00.000Z",
    });
  });

  it("rolls over the year at a December boundary", () => {
    const now = new Date("2026-12-25T09:00:00.000Z");
    expect(currentUtcMonthWindow(now)).toEqual({
      startIso: "2026-12-01T00:00:00.000Z",
      endIso: "2027-01-01T00:00:00.000Z",
    });
  });

  it("is stable at the first instant of the month", () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(currentUtcMonthWindow(now)).toEqual({
      startIso: "2026-02-01T00:00:00.000Z",
      endIso: "2026-03-01T00:00:00.000Z",
    });
  });
});

describe("formatMonthLabel", () => {
  it("renders a plain month label", () => {
    expect(formatMonthLabel("2026-07", false)).toBe("Jul 2026");
  });

  it("marks the partial (current) month explicitly", () => {
    expect(formatMonthLabel("2026-07", true)).toBe("Jul 2026 (partial)");
  });

  it("handles January (month index 0) without an off-by-one", () => {
    expect(formatMonthLabel("2026-01", false)).toBe("Jan 2026");
  });

  it("handles December (month index 11)", () => {
    expect(formatMonthLabel("2025-12", false)).toBe("Dec 2025");
  });
});

describe("capStatusCopy", () => {
  it("renders the exhausted state as critical, loud, and matching the notify-copy voice", () => {
    const copy = capStatusCopy("exhausted", 42, 40);
    expect(copy.tone).toBe("critical");
    expect(copy.headline).toBe("Monthly ceiling reached");
    expect(copy.detail).toBe(
      "$42.00 of $40.00 spent this month — new work is paused until the ceiling is raised."
    );
  });

  it("renders the under-ceiling state as positive", () => {
    const copy = capStatusCopy("under", 12.5, 40);
    expect(copy.tone).toBe("positive");
    expect(copy.headline).toBe("Under ceiling");
    expect(copy.detail).toBe("$12.50 of $40.00 spent this month.");
  });

  it("renders the uncapped state as neutral and never mentions a ceiling number", () => {
    const copy = capStatusCopy("uncapped", 7, null);
    expect(copy.tone).toBe("neutral");
    expect(copy.headline).toBe("No ceiling set");
    expect(copy.detail).toBe("$7.00 spent this month — uncapped.");
  });
});

describe("spendRatio", () => {
  it("is null when uncapped (no denominator to compare against)", () => {
    expect(spendRatio(25, null)).toBeNull();
  });

  it("computes a fractional ratio under the ceiling", () => {
    expect(spendRatio(10, 40)).toBe(0.25);
  });

  it("clamps at 1 when spend has crossed the ceiling", () => {
    expect(spendRatio(55, 40)).toBe(1);
  });

  it("clamps at 0 for a non-positive spend", () => {
    expect(spendRatio(0, 40)).toBe(0);
  });

  it("treats a non-positive ceiling as fully exhausted rather than dividing by zero", () => {
    expect(spendRatio(5, 0)).toBe(1);
  });
});

describe("runStatusLabel", () => {
  it("maps every known run status to its plain-English label", () => {
    expect(runStatusLabel("queued")).toBe("Queued");
    expect(runStatusLabel("running")).toBe("Running");
    expect(runStatusLabel("success")).toBe("Succeeded");
    expect(runStatusLabel("failed")).toBe("Failed");
  });

  it("falls back to the raw string for an unrecognized status (stays total, never throws)", () => {
    expect(runStatusLabel("weird")).toBe("weird");
  });
});

describe("formatRelativeTime", () => {
  it("renders 'just now' for a timestamp under 30 seconds old (rounds to 0 minutes)", () => {
    const now = new Date("2026-07-18T12:00:20.000Z");
    const result = formatRelativeTime("2026-07-18T12:00:00.000Z", now);
    expect(result.label).toBe("just now");
  });

  it("renders minutes for under an hour", () => {
    const now = new Date("2026-07-18T12:20:00.000Z");
    const result = formatRelativeTime("2026-07-18T12:00:00.000Z", now);
    expect(result.label).toBe("20m ago");
  });

  it("renders hours for under a day", () => {
    const now = new Date("2026-07-18T15:00:00.000Z");
    const result = formatRelativeTime("2026-07-18T12:00:00.000Z", now);
    expect(result.label).toBe("3h ago");
  });

  it("renders days beyond 24 hours", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const result = formatRelativeTime("2026-07-18T12:00:00.000Z", now);
    expect(result.label).toBe("2d ago");
  });

  it("exposes the absolute time as the title for the hover tooltip", () => {
    const iso = "2026-07-18T12:00:00.000Z";
    const now = new Date("2026-07-18T12:20:00.000Z");
    const result = formatRelativeTime(iso, now);
    expect(result.title).toBe(new Date(iso).toLocaleString());
  });
});
