import { describe, expect, it } from "vitest";
import { formatUsdCents, lowBalanceMessage, walletTransactionLabel } from "./wallet-helpers";

describe("formatUsdCents", () => {
  it("renders a positive amount in plain dollars", () => {
    expect(formatUsdCents(2500)).toBe("$25.00");
  });

  it("renders zero", () => {
    expect(formatUsdCents(0)).toBe("$0.00");
  });

  it("renders a negative amount with a leading minus, not inside the dollar sign", () => {
    expect(formatUsdCents(-150)).toBe("-$1.50");
  });

  it("never leaves a bare cents integer or a raw float", () => {
    expect(formatUsdCents(1)).toBe("$0.01");
    expect(formatUsdCents(99)).toBe("$0.99");
  });
});

describe("walletTransactionLabel", () => {
  it("labels top_up as Top-up (never 'credits')", () => {
    expect(walletTransactionLabel("top_up")).toBe("Top-up");
  });

  it("labels task_charge as Task charge", () => {
    expect(walletTransactionLabel("task_charge")).toBe("Task charge");
  });
});

describe("lowBalanceMessage", () => {
  it("returns null for a zero balance (not low — just empty)", () => {
    expect(lowBalanceMessage(0)).toBeNull();
  });

  it("returns null for a positive balance", () => {
    expect(lowBalanceMessage(500)).toBeNull();
  });

  it("returns a plain-English message for a negative balance, in dollars", () => {
    expect(lowBalanceMessage(-150)).toBe(
      "Balance is -$1.50. The next task won't start until you top up."
    );
  });

  it("never uses 'credits'/'tokens'/'quota' vocabulary (house rule)", () => {
    const msg = lowBalanceMessage(-100) ?? "";
    expect(msg.toLowerCase()).not.toMatch(/credits|tokens|quota/);
  });
});
