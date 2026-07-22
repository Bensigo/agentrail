import { describe, it, expect } from "vitest";
import {
  formatCostUsd,
  goalStatusLabel,
  goalStatusPillClassName,
  goalEndedReason,
  leashRatio,
  formatRelativeTime,
} from "./goals-helpers";

describe("formatCostUsd", () => {
  it("formats a normal amount to two decimals", () => {
    expect(formatCostUsd(12.5)).toBe("$12.50");
  });

  it("formats a sub-cent amount to four decimals so it never silently rounds to $0.00", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
  });

  it("treats exactly zero as the normal two-decimal case", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("goalStatusLabel", () => {
  it("labels every lifecycle status (goalStatusEnum: active -> reached|leashed|paused|abandoned)", () => {
    expect(goalStatusLabel("active")).toBe("Active");
    expect(goalStatusLabel("reached")).toBe("Reached");
    expect(goalStatusLabel("leashed")).toBe("Leashed");
    expect(goalStatusLabel("paused")).toBe("Paused");
    expect(goalStatusLabel("abandoned")).toBe("Abandoned");
  });
});

describe("goalStatusPillClassName", () => {
  it("reached is the positive/green tone (a genuine success)", () => {
    expect(goalStatusPillClassName("reached")).toContain("--green-11");
  });

  it("leashed is the critical/red tone (hit its issue or spend ceiling)", () => {
    expect(goalStatusPillClassName("leashed")).toContain("--red-11");
  });

  it("paused is the warning/yellow tone (stuck rule tripped, needs a human)", () => {
    expect(goalStatusPillClassName("paused")).toContain("--yellow-11");
  });

  it("abandoned and active are both the calm neutral/gray tone", () => {
    expect(goalStatusPillClassName("abandoned")).toContain("--gray-11");
    expect(goalStatusPillClassName("active")).toContain("--gray-11");
  });
});

describe("goalEndedReason", () => {
  it("displays the recorded statusReason verbatim, sentence-cased", () => {
    expect(
      goalEndedReason({ status: "leashed", statusReason: "leash exhausted: issues filed 10/10" })
    ).toBe("Leash exhausted: issues filed 10/10");
  });

  it("displays a stuck-rule reason verbatim", () => {
    expect(
      goalEndedReason({
        status: "paused",
        statusReason: "stuck: 2 consecutive non-green outcomes (threshold 2)",
      })
    ).toBe("Stuck: 2 consecutive non-green outcomes (threshold 2)");
  });

  it("displays a reached-check reason verbatim", () => {
    expect(
      goalEndedReason({ status: "reached", statusReason: "check reached: 5/5 green outcomes" })
    ).toBe("Check reached: 5/5 green outcomes");
  });

  it("falls back to a generic per-status sentence when statusReason is null (should-never-happen defensive case) — never blank, never throws", () => {
    expect(goalEndedReason({ status: "abandoned", statusReason: null })).toBe(
      "Manually abandoned."
    );
    expect(goalEndedReason({ status: "leashed", statusReason: "" })).toBe(
      "Stopped automatically after hitting its issue or spend limit."
    );
  });
});

describe("leashRatio", () => {
  it("computes a normal ratio", () => {
    expect(leashRatio(3, 10)).toBeCloseTo(0.3);
  });

  it("clamps above 1 down to 1 (over budget)", () => {
    expect(leashRatio(15, 10)).toBe(1);
  });

  it("clamps below 0 up to 0 (defensive against a negative value)", () => {
    expect(leashRatio(-5, 10)).toBe(0);
  });

  it("treats a non-positive max as fully exhausted rather than dividing by zero", () => {
    expect(leashRatio(5, 0)).toBe(1);
    expect(leashRatio(0, 0)).toBe(1);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");

  it("labels under a minute as 'just now'", () => {
    expect(formatRelativeTime(new Date("2026-07-22T11:59:45.000Z"), now).label).toBe("just now");
  });

  it("labels minutes", () => {
    expect(formatRelativeTime(new Date("2026-07-22T11:45:00.000Z"), now).label).toBe("15m ago");
  });

  it("labels hours", () => {
    expect(formatRelativeTime(new Date("2026-07-22T06:00:00.000Z"), now).label).toBe("6h ago");
  });

  it("labels days", () => {
    expect(formatRelativeTime(new Date("2026-07-19T12:00:00.000Z"), now).label).toBe("3d ago");
  });

  it("accepts an ISO string, same as a Date", () => {
    expect(formatRelativeTime("2026-07-22T11:45:00.000Z", now).label).toBe("15m ago");
  });
});
