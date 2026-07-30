import { describe, expect, it } from "vitest";
import {
  canStartCheckout,
  claimedViaLabel,
  planLabel,
  releaseSeatButtonLabel,
  renewalLabel,
  seatClaimedLabel,
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

describe("canStartCheckout", () => {
  it("allows checkout when the account has no Stripe subscription yet", () => {
    expect(canStartCheckout({ stripeSubscriptionId: null })).toBe(true);
  });

  it("blocks starting a second checkout once the account already has a subscription (final whole-slice review, Critical: an already-subscribed account could otherwise start a SECOND, independent Stripe subscription)", () => {
    expect(canStartCheckout({ stripeSubscriptionId: "sub_x" })).toBe(false);
  });
});

describe("seatClaimedLabel", () => {
  it("renders 'Claimed <date>' in plain month/day/year, UTC — same format as renewalLabel's date", () => {
    expect(seatClaimedLabel(new Date("2026-07-20T09:05:34.000Z"))).toBe("Claimed Jul 20, 2026");
  });

  it("stays on the stored UTC calendar day even close to a local-timezone midnight boundary", () => {
    // 23:30 UTC on Dec 31 must never roll to Jan 1 just because a host
    // machine's local clock is ahead of UTC — same rationale as
    // renewalLabel's own equivalent test above.
    expect(seatClaimedLabel(new Date("2026-12-31T23:30:00.000Z"))).toBe("Claimed Dec 31, 2026");
  });
});

describe("claimedViaLabel", () => {
  it.each([
    ["console", "Console"],
    ["telegram", "Telegram"],
    ["discord", "Discord"],
    ["slack", "Slack"],
  ] as const)("labels claimedVia %s as %s", (claimedVia, label) => {
    expect(claimedViaLabel(claimedVia)).toBe(label);
  });

  it("humanizes an out-of-union claimedVia value instead of rendering undefined or a raw snake_case string (SeatWithHolder.claimedVia arrives through an unchecked DB cast, same posture as planLabel)", () => {
    expect(claimedViaLabel("some_future_channel")).toBe("Some future channel");
  });
});

describe("releaseSeatButtonLabel", () => {
  it("includes the seat holder's label so multiple Release buttons in one list are distinguishable to a screen reader", () => {
    expect(releaseSeatButtonLabel("Ada Lovelace")).toBe("Release seat for Ada Lovelace");
  });

  it("works with a generic fallback holder label just as plainly — never a raw id either way", () => {
    expect(releaseSeatButtonLabel("Unknown member")).toBe("Release seat for Unknown member");
  });
});
