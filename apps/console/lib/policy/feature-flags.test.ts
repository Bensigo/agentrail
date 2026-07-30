import { describe, expect, it } from "vitest";
import { subscriptionsEnforced } from "./feature-flags";

describe("subscriptionsEnforced: the arc's kill-switch, off by default", () => {
  it("unset -> false", () => {
    expect(subscriptionsEnforced({})).toBe(false);
  });

  it('exactly "1" -> true', () => {
    expect(subscriptionsEnforced({ BILLING_SUBSCRIPTIONS_ENFORCED: "1" })).toBe(true);
  });

  it('"true" does NOT enable it -- unlike lib/alignment/feature-flags.ts\'s isTruthyFlag, only the literal "1" does', () => {
    expect(subscriptionsEnforced({ BILLING_SUBSCRIPTIONS_ENFORCED: "true" })).toBe(false);
  });

  it('"0" -> false', () => {
    expect(subscriptionsEnforced({ BILLING_SUBSCRIPTIONS_ENFORCED: "0" })).toBe(false);
  });

  it("empty string -> false", () => {
    expect(subscriptionsEnforced({ BILLING_SUBSCRIPTIONS_ENFORCED: "" })).toBe(false);
  });
});

describe("subscriptionsEnforced: defaults to reading the real process.env when no env override is given", () => {
  it("does not throw when called with no arguments (exercises the process.env default param)", () => {
    expect(() => subscriptionsEnforced()).not.toThrow();
  });
});
