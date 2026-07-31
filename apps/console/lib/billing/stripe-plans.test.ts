import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePlanFromPriceId,
  subscriptionBillingConfigured,
  subscriptionPriceId,
  type StripePlanEnv,
} from "./stripe-plans";

const FULL_ENV: StripePlanEnv = {
  STRIPE_PRICE_STARTER: "price_starter_123",
  STRIPE_PRICE_GROWTH: "price_growth_456",
};

describe("subscriptionPriceId: reads the plan's configured Stripe Price id", () => {
  it('"starter" -> STRIPE_PRICE_STARTER', () => {
    expect(subscriptionPriceId("starter", FULL_ENV)).toBe("price_starter_123");
  });

  it('"growth" -> STRIPE_PRICE_GROWTH', () => {
    expect(subscriptionPriceId("growth", FULL_ENV)).toBe("price_growth_456");
  });

  it("unset env var -> null", () => {
    expect(subscriptionPriceId("starter", {})).toBeNull();
  });

  it("empty-string env var -> null (treated as unset, not a valid Price id)", () => {
    expect(subscriptionPriceId("growth", { STRIPE_PRICE_GROWTH: "" })).toBeNull();
  });

  it("does not throw when called with no env argument (exercises the process.env default param)", () => {
    expect(() => subscriptionPriceId("starter")).not.toThrow();
  });
});

describe("resolvePlanFromPriceId: the inverse lookup, against the SAME env-configured mapping", () => {
  it("starter's configured price id -> \"starter\"", () => {
    expect(resolvePlanFromPriceId("price_starter_123", FULL_ENV)).toBe("starter");
  });

  it("growth's configured price id -> \"growth\"", () => {
    expect(resolvePlanFromPriceId("price_growth_456", FULL_ENV)).toBe("growth");
  });

  it("unknown price id -> null", () => {
    expect(resolvePlanFromPriceId("price_unknown_999", FULL_ENV)).toBeNull();
  });

  it("no price envs configured -> null, never a guessed plan", () => {
    expect(resolvePlanFromPriceId("price_starter_123", {})).toBeNull();
  });

  it("does not throw when called with no env argument", () => {
    expect(() => resolvePlanFromPriceId("price_starter_123")).not.toThrow();
  });
});

describe("subscriptionBillingConfigured: both price ids present AND isStripeConfigured()", () => {
  const ORIGINAL_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];

  beforeEach(() => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_dummy_for_stripe_plans_test";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET_KEY === undefined) delete process.env["STRIPE_SECRET_KEY"];
    else process.env["STRIPE_SECRET_KEY"] = ORIGINAL_SECRET_KEY;
  });

  it("true when both price ids AND STRIPE_SECRET_KEY are present", () => {
    expect(subscriptionBillingConfigured(FULL_ENV)).toBe(true);
  });

  it("false when STRIPE_PRICE_STARTER is missing", () => {
    expect(
      subscriptionBillingConfigured({ STRIPE_PRICE_GROWTH: "price_growth_456" })
    ).toBe(false);
  });

  it("false when STRIPE_PRICE_GROWTH is missing", () => {
    expect(
      subscriptionBillingConfigured({ STRIPE_PRICE_STARTER: "price_starter_123" })
    ).toBe(false);
  });

  it("false when both price ids are present but STRIPE_SECRET_KEY is not (isStripeConfigured() false)", () => {
    delete process.env["STRIPE_SECRET_KEY"];
    expect(subscriptionBillingConfigured(FULL_ENV)).toBe(false);
  });

  it("false when nothing is configured", () => {
    delete process.env["STRIPE_SECRET_KEY"];
    expect(subscriptionBillingConfigured({})).toBe(false);
  });

  it("does not throw when called with no env argument (exercises the process.env default param)", () => {
    expect(() => subscriptionBillingConfigured()).not.toThrow();
  });
});
