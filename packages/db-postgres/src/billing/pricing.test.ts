import { describe, it, expect } from "vitest";
import {
  FLAT_SERVER_FEE_CENTS,
  FLAT_PROFIT_CENTS,
  usdToCents,
  taskPriceCents,
} from "./pricing.js";

/**
 * #1290 — the customer-facing price math is pure and deterministic, so it is
 * pinned by an EXACT-cents table (no mocks). Money is integer cents
 * throughout; every expected value is a whole number.
 */

describe("flat pricing constants", () => {
  it("are the documented starting assumptions (tunable, integer cents)", () => {
    expect(FLAT_SERVER_FEE_CENTS).toBe(50); // $0.50
    expect(FLAT_PROFIT_CENTS).toBe(100); // $1.00
  });

  it("are whole integer cents (never fractional / float)", () => {
    expect(Number.isInteger(FLAT_SERVER_FEE_CENTS)).toBe(true);
    expect(Number.isInteger(FLAT_PROFIT_CENTS)).toBe(true);
  });
});

describe("usdToCents — the one float→integer money boundary", () => {
  const table: Array<[number, number]> = [
    [0, 0],
    [0.01, 1],
    [1, 100],
    [1.5, 150],
    [12.34, 1234],
    // Classic float trap: 0.1 + 0.2 dollars must land on an exact cent.
    [0.1 + 0.2, 30],
    // Rounds to nearest cent.
    [0.005, 1],
    [0.004, 0],
    // Negative preserved (safe for debits).
    [-2.5, -250],
  ];
  it.each(table)("usdToCents(%s) === %i", (usd, cents) => {
    expect(usdToCents(usd)).toBe(cents);
    expect(Number.isInteger(usdToCents(usd))).toBe(true);
  });
});

describe("taskPriceCents = actual_token_cost + FLAT_SERVER_FEE + FLAT_PROFIT", () => {
  // [actualTokenCostCents, expectedPriceCents]
  const table: Array<[number, number]> = [
    // Zero token cost still charges both flat amounts (50 + 100).
    [0, 150],
    // 1 cent of tokens.
    [1, 151],
    // $0.30 of tokens -> 30 + 50 + 100.
    [30, 180],
    // $1.234 of tokens rounded to 123 cents -> 123 + 150.
    [123, 273],
    // A large task: $5.00 tokens.
    [500, 650],
    // Defensive rounding of a stray fractional cent input.
    [10.4, 160],
    [10.5, 161],
    // Defensive: a (nonsensical) negative token cost still adds the flats.
    [-10, 140],
  ];
  it.each(table)(
    "taskPriceCents({ actualTokenCostCents: %s }) === %i",
    (tokenCents, expected) => {
      const price = taskPriceCents({ actualTokenCostCents: tokenCents });
      expect(price).toBe(expected);
      expect(Number.isInteger(price)).toBe(true);
    }
  );

  it("equals the sum of its three named parts (no hidden markup)", () => {
    const tokenCents = 42;
    expect(taskPriceCents({ actualTokenCostCents: tokenCents })).toBe(
      tokenCents + FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS
    );
  });

  it("end-to-end: a $0.30-token task bills $1.80 (30 + 50 + 100 cents)", () => {
    const tokenCents = usdToCents(0.3);
    expect(tokenCents).toBe(30);
    expect(taskPriceCents({ actualTokenCostCents: tokenCents })).toBe(180);
  });
});
