import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isPricingClaimLive } from "./_pricing-gate";

const ORIGINAL = process.env["NEXT_PUBLIC_BILLING_VERIFIED_LIVE"];

beforeEach(() => {
  delete process.env["NEXT_PUBLIC_BILLING_VERIFIED_LIVE"];
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["NEXT_PUBLIC_BILLING_VERIFIED_LIVE"];
  else process.env["NEXT_PUBLIC_BILLING_VERIFIED_LIVE"] = ORIGINAL;
});

describe("isPricingClaimLive (landing honesty gate, #1415)", () => {
  it("defaults to false when unset (default OFF)", () => {
    expect(isPricingClaimLive()).toBe(false);
  });

  it("is true only for the exact string \"1\"", () => {
    process.env["NEXT_PUBLIC_BILLING_VERIFIED_LIVE"] = "1";
    expect(isPricingClaimLive()).toBe(true);
  });

  it.each(["true", "TRUE", "yes", "on", "0", "false", ""])(
    "is false for any other truthy-looking value (%s) — only exact \"1\" enables it",
    (value) => {
      process.env["NEXT_PUBLIC_BILLING_VERIFIED_LIVE"] = value;
      expect(isPricingClaimLive()).toBe(false);
    }
  );
});
