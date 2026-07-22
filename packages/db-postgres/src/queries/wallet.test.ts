import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #1290 — wallet ledger queries. Mocked-db unit tests (this package has no
 * live-DB harness; every query spec mocks `db` — see run_outcomes.test.ts's
 * own note). The pricing math itself is real (billing/pricing.ts is NOT
 * mocked) so the completion charge is exercised end-to-end through
 * taskPriceCents.
 *
 * Covers the quality-bar cases: the balance SUM, the admission gate
 * (balance ≥ estimate, incl. the overage-goes-negative case that blocks the
 * NEXT admission), and the completion charge's idempotency + overage.
 */

// A drizzle-style chainable, thenable select result: every builder method
// returns the same object; awaiting it resolves the configured rows.
function selectResult(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "groupBy"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

let insertedValues: Array<Record<string, unknown>> = [];
let insertReturn: unknown[] = [];
let executeReturn: unknown[] = [];
let lastExecuteArg: unknown;

vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(() => selectResult([])),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return { returning: vi.fn(() => Promise.resolve(insertReturn)) };
      }),
    })),
    execute: vi.fn((arg: unknown) => {
      lastExecuteArg = arg;
      return Promise.resolve(executeReturn);
    }),
  },
}));

import { db } from "../db.js";
import {
  isBillingEnabled,
  getWalletBalanceCents,
  recordWalletTransaction,
  walletCanAdmit,
  peekNextClaimEstimateUsd,
  chargeCompletedTask,
} from "./wallet.js";
import {
  FLAT_SERVER_FEE_CENTS,
  FLAT_PROFIT_CENTS,
} from "../billing/pricing.js";

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues = [];
  insertReturn = [];
  executeReturn = [];
  lastExecuteArg = undefined;
  mockDb.select = vi.fn(() => selectResult([]) as ReturnType<typeof db.select>);
});

describe("isBillingEnabled", () => {
  it("returns the workspace flag when set true", async () => {
    mockDb.select = vi.fn(
      () => selectResult([{ billingEnabled: true }]) as ReturnType<typeof db.select>
    );
    expect(await isBillingEnabled("ws-1")).toBe(true);
  });

  it("returns false when the flag is false", async () => {
    mockDb.select = vi.fn(
      () => selectResult([{ billingEnabled: false }]) as ReturnType<typeof db.select>
    );
    expect(await isBillingEnabled("ws-1")).toBe(false);
  });

  it("defaults to false (billing off) when the workspace row is missing", async () => {
    mockDb.select = vi.fn(() => selectResult([]) as ReturnType<typeof db.select>);
    expect(await isBillingEnabled("ws-missing")).toBe(false);
  });
});

describe("getWalletBalanceCents — balance is the running SUM", () => {
  it("returns the summed integer cents", async () => {
    mockDb.select = vi.fn(
      () => selectResult([{ balance: 1250 }]) as ReturnType<typeof db.select>
    );
    expect(await getWalletBalanceCents("ws-1")).toBe(1250);
  });

  it("returns 0 for a workspace with no ledger rows (COALESCE / ?? 0)", async () => {
    mockDb.select = vi.fn(
      () => selectResult([{ balance: 0 }]) as ReturnType<typeof db.select>
    );
    expect(await getWalletBalanceCents("ws-empty")).toBe(0);
  });

  it("can be NEGATIVE after an overage charge (balance is a signed SUM)", async () => {
    mockDb.select = vi.fn(
      () => selectResult([{ balance: -320 }]) as ReturnType<typeof db.select>
    );
    expect(await getWalletBalanceCents("ws-overdrawn")).toBe(-320);
  });
});

describe("walletCanAdmit — admission check (balance ≥ estimate)", () => {
  function withBalance(cents: number) {
    mockDb.select = vi.fn(
      () => selectResult([{ balance: cents }]) as ReturnType<typeof db.select>
    );
  }

  it("admits when balance covers the estimate exactly (>=, boundary)", async () => {
    withBalance(500); // $5.00
    expect(await walletCanAdmit("ws-1", 5.0)).toBe(true);
  });

  it("admits when balance exceeds the estimate", async () => {
    withBalance(1000);
    expect(await walletCanAdmit("ws-1", 3.5)).toBe(true);
  });

  it("blocks when balance is one cent short of the estimate", async () => {
    withBalance(499); // $4.99
    expect(await walletCanAdmit("ws-1", 5.0)).toBe(false);
  });

  it("a NEGATIVE balance (post-overage) blocks the NEXT admission until a top-up lands", async () => {
    withBalance(-1); // overdrawn
    expect(await walletCanAdmit("ws-1", 0.5)).toBe(false);
  });

  it("admits without reading the balance for a null/zero/negative estimate (nothing to cover)", async () => {
    const spy = vi.fn(() => selectResult([{ balance: 0 }]) as ReturnType<typeof db.select>);
    mockDb.select = spy;
    expect(await walletCanAdmit("ws-1", 0)).toBe(true);
    expect(await walletCanAdmit("ws-1", Number.NaN)).toBe(true);
    // Never even queried the balance — there's nothing to gate on.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("peekNextClaimEstimateUsd", () => {
  it("returns the oldest queued entry's estimate", async () => {
    mockDb.select = vi.fn(
      () =>
        selectResult([{ estimatedBudgetUsd: 4.25 }]) as ReturnType<typeof db.select>
    );
    expect(await peekNextClaimEstimateUsd("ws-1")).toBe(4.25);
  });

  it("returns null when nothing is queued", async () => {
    mockDb.select = vi.fn(() => selectResult([]) as ReturnType<typeof db.select>);
    expect(await peekNextClaimEstimateUsd("ws-1")).toBeNull();
  });

  it("returns null when the next entry carries no estimate (brief-less / alignment-off)", async () => {
    mockDb.select = vi.fn(
      () =>
        selectResult([{ estimatedBudgetUsd: null }]) as ReturnType<typeof db.select>
    );
    expect(await peekNextClaimEstimateUsd("ws-1")).toBeNull();
  });
});

describe("recordWalletTransaction — append-only writer + top-up seam", () => {
  it("inserts a positive top_up row (the clean Stripe funding seam)", async () => {
    insertReturn = [{ id: "wt-1" }];
    await recordWalletTransaction({
      workspaceId: "ws-1",
      kind: "top_up",
      amountUsdCents: 2000,
      description: "Top-up",
    });
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      workspaceId: "ws-1",
      kind: "top_up",
      amountUsdCents: 2000,
      runId: null,
      taskRef: null,
      description: "Top-up",
    });
  });

  it("defaults runId/taskRef to null and description to '' when omitted", async () => {
    insertReturn = [{ id: "wt-2" }];
    await recordWalletTransaction({
      workspaceId: "ws-1",
      kind: "top_up",
      amountUsdCents: 500,
    });
    expect(insertedValues[0]).toMatchObject({
      runId: null,
      taskRef: null,
      description: "",
    });
  });
});

describe("chargeCompletedTask — completion charge (idempotent, overage-allowed)", () => {
  it("posts a NEGATIVE task_charge priced by taskPriceCents (real token cost + flats)", async () => {
    executeReturn = [{ id: "wt-charge-1" }]; // a row inserted → charged
    const tokenCents = 30; // $0.30 of tokens
    const result = await chargeCompletedTask({
      workspaceId: "ws-1",
      runId: "run-1",
      taskRef: "owner/repo#42",
      actualTokenCostCents: tokenCents,
    });

    const expectedPrice = tokenCents + FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS; // 180
    expect(result.charged).toBe(true);
    expect(result.priceCents).toBe(expectedPrice);
    // A charge is money OUT → the ledger amount is negative.
    expect(result.amountUsdCents).toBe(-expectedPrice);
    expect(result.amountUsdCents).toBeLessThan(0);
  });

  it("idempotent per run: a duplicate delivery (ON CONFLICT DO NOTHING → no row) reports charged=false, never double-charges", async () => {
    executeReturn = []; // ON CONFLICT matched the existing charge → 0 rows
    const result = await chargeCompletedTask({
      workspaceId: "ws-1",
      runId: "run-1",
      actualTokenCostCents: 30,
    });
    expect(result.charged).toBe(false);
    // The price it WOULD have posted is still computed (for logging), unchanged.
    expect(result.priceCents).toBe(30 + FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS);
  });

  it("overage: charges the full real price even when it exceeds the pre-task estimate — the DB write is unconditional (balance may go negative)", async () => {
    executeReturn = [{ id: "wt-charge-2" }];
    // A pricey task ($9.00 of tokens) whose price will overrun a small
    // admission estimate — chargeCompletedTask posts it in full regardless.
    const result = await chargeCompletedTask({
      workspaceId: "ws-1",
      runId: "run-big",
      taskRef: "owner/repo#99",
      actualTokenCostCents: 900,
    });
    expect(result.charged).toBe(true);
    expect(result.amountUsdCents).toBe(-(900 + FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS)); // -1050
    // The charge issues exactly one INSERT ... ON CONFLICT statement.
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(lastExecuteArg).toBeDefined();
  });

  it("a zero-token task still charges the two flat amounts", async () => {
    executeReturn = [{ id: "wt-charge-3" }];
    const result = await chargeCompletedTask({
      workspaceId: "ws-1",
      runId: "run-free",
      actualTokenCostCents: 0,
    });
    expect(result.priceCents).toBe(FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS); // 150
    expect(result.amountUsdCents).toBe(-(FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS));
  });
});
