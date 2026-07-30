import { describe, expect, it } from "vitest";
import {
  planLabel,
  renewalLabel,
  seatLimitForPlan,
  seatsLabel,
  statusChip,
  STATUS_CHIP_TONE_CLASSNAME,
} from "./billing-helpers";

describe("planLabel", () => {
  it("labels every BillingPlan value", () => {
    expect(planLabel("trial")).toBe("Trial");
    expect(planLabel("starter")).toBe("Starter");
    expect(planLabel("growth")).toBe("Growth");
    expect(planLabel("enterprise")).toBe("Enterprise");
  });

  it("humanizes an out-of-union plan value instead of rendering undefined (review round 1 minor: account.plan arrives through an unchecked DB cast)", () => {
    expect(planLabel("custom_plan")).toBe("Custom plan");
  });
});

describe("seatLimitForPlan", () => {
  it("returns each known plan's real seat limit", () => {
    expect(seatLimitForPlan("trial")).toBe(10);
    expect(seatLimitForPlan("starter")).toBe(4);
    expect(seatLimitForPlan("growth")).toBe(10);
    expect(seatLimitForPlan("enterprise")).toBe(10);
  });

  it("falls back to trial's seat limit for an out-of-union plan value instead of crashing (review round 1 minor)", () => {
    expect(seatLimitForPlan("custom_plan")).toBe(10);
  });
});

describe("renewalLabel", () => {
  it("returns a plain no-subscription notice for null (trial, or a canceled subscription)", () => {
    expect(renewalLabel(null)).toBe("No active subscription");
  });

  it("renders 'Renews <date>' in plain month/day/year, UTC so it's deterministic regardless of host timezone", () => {
    expect(renewalLabel(new Date("2026-08-29T00:00:00.000Z"))).toBe("Renews Aug 29, 2026");
  });

  it("stays on the stored UTC calendar day even close to a local-timezone midnight boundary", () => {
    // 23:30 UTC on Dec 31 must never roll to Jan 1 just because a host
    // machine's local clock is ahead of UTC — timeZone: "UTC" is what
    // guarantees that.
    expect(renewalLabel(new Date("2026-12-31T23:30:00.000Z"))).toBe("Renews Dec 31, 2026");
  });
});

describe("seatsLabel", () => {
  it("renders '<used> of <limit>'", () => {
    expect(seatsLabel(3, 10)).toBe("3 of 10");
  });

  it("renders zero used plainly", () => {
    expect(seatsLabel(0, 4)).toBe("0 of 4");
  });

  it("renders an over-limit count as-is — no special-casing in the string itself", () => {
    expect(seatsLabel(12, 10)).toBe("12 of 10");
  });
});

describe("statusChip", () => {
  it("returns null when there's no subscription status to report", () => {
    expect(statusChip(null)).toBeNull();
  });

  it.each([
    ["active", "Active", "positive"],
    ["trialing", "Trialing", "neutral"],
    ["past_due", "Past due", "warning"],
    ["canceled", "Canceled", "neutral"],
    ["incomplete", "Incomplete", "warning"],
    ["incomplete_expired", "Expired", "critical"],
    ["paused", "Paused", "warning"],
    ["unpaid", "Unpaid", "critical"],
  ] as const)("maps Stripe status %s to label %s / tone %s", (status, label, tone) => {
    expect(statusChip(status)).toEqual({ label, tone });
  });

  it("never renders a raw underscored status — humanizes an unrecognized future Stripe status instead of throwing", () => {
    expect(statusChip("some_future_status")).toEqual({
      label: "Some future status",
      tone: "neutral",
    });
  });
});

describe("STATUS_CHIP_TONE_CLASSNAME", () => {
  it("has a classname for every tone statusChip can return", () => {
    for (const tone of ["positive", "neutral", "warning", "critical"] as const) {
      expect(STATUS_CHIP_TONE_CLASSNAME[tone]).toEqual(expect.any(String));
      expect(STATUS_CHIP_TONE_CLASSNAME[tone].length).toBeGreaterThan(0);
    }
  });
});
