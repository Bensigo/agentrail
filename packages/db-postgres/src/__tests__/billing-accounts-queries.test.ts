import { describe, it, expect, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * billing_accounts.ts's three functions all take `db` as an explicit
 * parameter — the same convention `channel_inbox.ts`'s
 * `stampChannelInboxWorkspace` established (see that module's own
 * doc-comment) — so, same as `stamp-channel-inbox-workspace.test.ts`, the
 * mock here is a plain object passed directly at the call site, no
 * `vi.mock("../db.js")` module interception required. Same "capture the SQL
 * object passed to `db.execute`, render it with drizzle's `PgDialect`"
 * technique as that file and `runner-result-sql.test.ts`, since this
 * package has no live-DB test harness (every spec mocks `db`).
 */
import {
  getBillingAccountForWorkspace,
  getBillingAccountIdForWorkspace,
  listAccountWorkspaceIds,
  countActiveSeats,
  bindStripeCustomer,
  getBillingAccountByStripeCustomerId,
} from "../queries/billing_accounts.js";
import type { Db } from "../db.js";

const captured: unknown[] = [];

/** `resolveWith` is what `db.execute(...)` resolves to — the raw (snake_case)
 * driver rows the query would get back from Postgres. */
function mockDbCapturing(calls: unknown[], resolveWith: unknown[]): Db {
  return {
    execute: (q: unknown) => {
      calls.push(q);
      return Promise.resolve(resolveWith);
    },
  } as unknown as Db;
}

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;
const renderParams = (q: unknown) =>
  new PgDialect().sqlToQuery(q as never).params;

beforeEach(() => {
  captured.length = 0;
});

const RAW_ACCOUNT_ROW = {
  id: "acct-1",
  name: "Acme Inc",
  plan: "trial",
  stripe_customer_id: null,
  stripe_subscription_id: null,
  subscription_status: null,
  current_period_end: null,
  trial_ends_at: new Date("2026-08-12T00:00:00Z"),
  policy_overrides: {},
  created_at: new Date("2026-07-29T00:00:00Z"),
  updated_at: new Date("2026-07-29T00:00:00Z"),
};

describe("getBillingAccountForWorkspace", () => {
  it("joins billing_accounts through workspaces.billing_account_id", async () => {
    const db = mockDbCapturing(captured, [RAW_ACCOUNT_ROW]);

    await getBillingAccountForWorkspace(db, "ws-1");

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/from\s+billing_accounts/i);
    expect(sql).toMatch(/join\s+workspaces/i);
    expect(sql).toMatch(/billing_account_id/i);
  });

  it("scopes the join to the given workspace id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, [RAW_ACCOUNT_ROW]);

    await getBillingAccountForWorkspace(db, "ws-1");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/where.*\bw\.id\s*=/is);
    expect(params).toContain("ws-1");
    expect(sql).not.toContain("ws-1");
  });

  it("maps the raw snake_case row to the camelCase BillingAccountRow shape", async () => {
    const db = mockDbCapturing(captured, [RAW_ACCOUNT_ROW]);

    const result = await getBillingAccountForWorkspace(db, "ws-1");

    expect(result).toEqual({
      id: "acct-1",
      name: "Acme Inc",
      plan: "trial",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      trialEndsAt: RAW_ACCOUNT_ROW.trial_ends_at,
      policyOverrides: {},
      createdAt: RAW_ACCOUNT_ROW.created_at,
      updatedAt: RAW_ACCOUNT_ROW.updated_at,
    });
  });

  it("returns null — never throws — when the workspace has no billing account (unknown workspace or NULL billing_account_id)", async () => {
    const db = mockDbCapturing(captured, []); // INNER JOIN yields zero rows either way

    await expect(
      getBillingAccountForWorkspace(db, "ws-orphan")
    ).resolves.toBeNull();
  });

  /**
   * Regression coverage for review round 1's CRITICAL finding: the prior
   * `new Date(...)` re-wrap (and now `toDate`/`toDateOrNull`,
   * module-private above) had zero discriminating coverage — every
   * existing test above mocks `db.execute` with `RAW_ACCOUNT_ROW`'s
   * ALREADY-`Date` fixture values (`trial_ends_at: new Date(...)`, etc.),
   * so `new Date(dateInstance)` round-trips identically whether or not the
   * fix exists and never exercises the string-input path at all. These
   * mock the RAW WIRE-SHAPE string `db.execute` actually returns
   * ("2026-08-19 09:05:34.525288+00" — a space separator and a bare 2-digit
   * offset, not ISO 8601), pinning the exact resulting epoch so the
   * normalizer itself — not just "is this a Date" — is under test.
   */
  describe("timestamp coercion (raw Postgres wire text -> Date)", () => {
    it("coerces every timestamp field from raw wire-text strings into real Date instances at the exact expected epoch", async () => {
      const rawWireRow = {
        ...RAW_ACCOUNT_ROW,
        current_period_end: "2026-08-19 09:05:34.525288+00",
        trial_ends_at: "2026-08-12 00:00:00.000000+00",
        created_at: "2026-07-29 00:00:00.000000+00",
        updated_at: "2026-07-29 00:00:00.000000+00",
      };
      const db = mockDbCapturing(captured, [rawWireRow]);

      const result = await getBillingAccountForWorkspace(db, "ws-1");

      expect(result?.currentPeriodEnd).toBeInstanceOf(Date);
      expect(result?.currentPeriodEnd?.getTime()).toBe(
        Date.UTC(2026, 7, 19, 9, 5, 34, 525)
      );
      expect(result?.trialEndsAt).toBeInstanceOf(Date);
      expect(result?.trialEndsAt.getTime()).toBe(Date.UTC(2026, 7, 12, 0, 0, 0, 0));
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.createdAt.getTime()).toBe(Date.UTC(2026, 6, 29, 0, 0, 0, 0));
      expect(result?.updatedAt).toBeInstanceOf(Date);
      expect(result?.updatedAt.getTime()).toBe(Date.UTC(2026, 6, 29, 0, 0, 0, 0));
    });

    it("keeps current_period_end null when the raw row's value is null, rather than coercing to the Unix epoch (new Date(null) footgun)", async () => {
      const rawWireRow = {
        ...RAW_ACCOUNT_ROW,
        current_period_end: null,
        trial_ends_at: "2026-08-12 00:00:00.000000+00",
        created_at: "2026-07-29 00:00:00.000000+00",
        updated_at: "2026-07-29 00:00:00.000000+00",
      };
      const db = mockDbCapturing(captured, [rawWireRow]);

      const result = await getBillingAccountForWorkspace(db, "ws-1");

      expect(result?.currentPeriodEnd).toBeNull();
    });

    it("passes an already-Date value through unchanged, by reference (double-wrap safety)", async () => {
      const alreadyDate = new Date("2026-08-19T09:05:34.525Z");
      const rowWithDates = {
        ...RAW_ACCOUNT_ROW,
        current_period_end: alreadyDate,
        trial_ends_at: alreadyDate,
      };
      const db = mockDbCapturing(captured, [rowWithDates]);

      const result = await getBillingAccountForWorkspace(db, "ws-1");

      expect(result?.currentPeriodEnd).toBe(alreadyDate);
      expect(result?.trialEndsAt).toBe(alreadyDate);
    });

    it("normalizes a non-UTC bare 2-digit offset (e.g. -05) deterministically, not relying on engine-specific parsing of the un-normalized wire text", async () => {
      const rawWireRow = {
        ...RAW_ACCOUNT_ROW,
        current_period_end: "2026-08-19 09:05:34.525288-05",
      };
      const db = mockDbCapturing(captured, [rawWireRow]);

      const result = await getBillingAccountForWorkspace(db, "ws-1");

      // -05:00 means this instant is 14:05:34.525 UTC, five hours later.
      expect(result?.currentPeriodEnd?.getTime()).toBe(
        Date.UTC(2026, 7, 19, 14, 5, 34, 525)
      );
    });

    /**
     * Regression coverage for review round 1's second finding: the
     * normalizer fixed the separator and the bare offset but passed a
     * 6-digit microsecond fraction straight through to `new Date(...)`,
     * silently depending on the engine's own leniency to make sense of a
     * fraction longer than the 3-digit ECMA-262 grammar allows — exactly
     * the un-guaranteed behavior this function's own doc-comment says it
     * exists to avoid. The fix truncates to milliseconds BEFORE parsing;
     * this pins the exact resulting epoch through that now-fully-normalized
     * path (not just "does not throw").
     */
    it("truncates a 6-digit microsecond fraction to milliseconds before parsing, not relying on the engine's own leniency for the extra digits", async () => {
      const rawWireRow = {
        ...RAW_ACCOUNT_ROW,
        trial_ends_at: "2026-08-12 00:00:00.654321+00",
      };
      const db = mockDbCapturing(captured, [rawWireRow]);

      const result = await getBillingAccountForWorkspace(db, "ws-1");

      expect(result?.trialEndsAt).toBeInstanceOf(Date);
      expect(result?.trialEndsAt.getTime()).toBe(Date.UTC(2026, 7, 12, 0, 0, 0, 654));
    });
  });
});

describe("getBillingAccountIdForWorkspace", () => {
  it("joins billing_accounts through workspaces.billing_account_id, selecting only the id", async () => {
    const db = mockDbCapturing(captured, [{ id: "acct-1" }]);

    await getBillingAccountIdForWorkspace(db, "ws-1");

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/from\s+billing_accounts/i);
    expect(sql).toMatch(/join\s+workspaces/i);
    expect(sql).toMatch(/billing_account_id/i);
  });

  it("scopes the join to the given workspace id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, [{ id: "acct-1" }]);

    await getBillingAccountIdForWorkspace(db, "ws-1");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/where.*\bw\.id\s*=/is);
    expect(params).toContain("ws-1");
    expect(sql).not.toContain("ws-1");
  });

  it("returns the billing account id", async () => {
    const db = mockDbCapturing(captured, [{ id: "acct-1" }]);

    const result = await getBillingAccountIdForWorkspace(db, "ws-1");

    expect(result).toBe("acct-1");
  });

  it("returns null — never throws — when the workspace has no billing account (unknown workspace or NULL billing_account_id)", async () => {
    const db = mockDbCapturing(captured, []); // INNER JOIN yields zero rows either way

    await expect(
      getBillingAccountIdForWorkspace(db, "ws-orphan")
    ).resolves.toBeNull();
  });
});

describe("listAccountWorkspaceIds", () => {
  it("scopes the query to the given billing account id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, [{ id: "ws-1" }, { id: "ws-2" }]);

    await listAccountWorkspaceIds(db, "acct-1");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/from\s+workspaces/i);
    expect(sql).toMatch(/billing_account_id\s*=/i);
    expect(params).toContain("acct-1");
    expect(sql).not.toContain("acct-1");
  });

  it("returns the list of workspace ids", async () => {
    const db = mockDbCapturing(captured, [{ id: "ws-1" }, { id: "ws-2" }]);

    const result = await listAccountWorkspaceIds(db, "acct-1");

    expect(result).toEqual(["ws-1", "ws-2"]);
  });

  it("returns [] for an account with no workspaces — never throws", async () => {
    const db = mockDbCapturing(captured, []);

    const result = await listAccountWorkspaceIds(db, "acct-empty");

    expect(result).toEqual([]);
  });
});

describe("countActiveSeats", () => {
  it("filters on released_at IS NULL — active means never released (append-and-derive, no mutable counter)", async () => {
    const db = mockDbCapturing(captured, [{ count: 3 }]);

    await countActiveSeats(db, "acct-1");

    const sql = render(captured[0]);
    expect(sql).toMatch(/from\s+seats/i);
    expect(sql).toMatch(/released_at\s+is\s+null/i);
  });

  it("scopes the count to the given billing account id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, [{ count: 3 }]);

    await countActiveSeats(db, "acct-1");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/billing_account_id\s*=/i);
    expect(params).toContain("acct-1");
    expect(sql).not.toContain("acct-1");
  });

  it("returns the count as a number", async () => {
    const db = mockDbCapturing(captured, [{ count: 3 }]);

    const result = await countActiveSeats(db, "acct-1");

    expect(result).toBe(3);
  });

  it("returns 0 for an account with no active seats — never throws", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);

    const result = await countActiveSeats(db, "acct-empty");

    expect(result).toBe(0);
  });
});

describe("bindStripeCustomer", () => {
  it("issues an UPDATE against billing_accounts", async () => {
    const db = mockDbCapturing(captured, []);

    await bindStripeCustomer(db, "acct-1", "cus_123");

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/update\s+billing_accounts/i);
    expect(sql).toMatch(/set\s+stripe_customer_id/i);
  });

  it("is fill-only — guards the UPDATE with stripe_customer_id IS NULL, never clobbers an existing bind", async () => {
    const db = mockDbCapturing(captured, []);

    await bindStripeCustomer(db, "acct-1", "cus_123");

    const sql = render(captured[0]);
    expect(sql).toMatch(/where.*stripe_customer_id\s+is\s+null/is);
  });

  it("scopes the UPDATE to the given billing account id, not a blanket update", async () => {
    const db = mockDbCapturing(captured, []);

    await bindStripeCustomer(db, "acct-1", "cus_123");

    const sql = render(captured[0]);
    expect(sql).toMatch(/where.*\bid\s*=/is);
  });

  it("binds billingAccountId and stripeCustomerId as parameters (never string-interpolated into the SQL text)", async () => {
    const db = mockDbCapturing(captured, []);

    await bindStripeCustomer(db, "acct-1", "cus_123");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(params).toContain("acct-1");
    expect(params).toContain("cus_123");
    expect(sql).not.toContain("acct-1");
    expect(sql).not.toContain("cus_123");
  });
});

describe("getBillingAccountByStripeCustomerId", () => {
  it("selects from billing_accounts scoped to the given stripe customer id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, [RAW_ACCOUNT_ROW]);

    await getBillingAccountByStripeCustomerId(db, "cus_123");

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/from\s+billing_accounts/i);
    expect(sql).toMatch(/where.*stripe_customer_id\s*=/is);
    expect(params).toContain("cus_123");
    expect(sql).not.toContain("cus_123");
  });

  it("maps the raw snake_case row to the camelCase BillingAccountRow shape", async () => {
    const db = mockDbCapturing(captured, [RAW_ACCOUNT_ROW]);

    const result = await getBillingAccountByStripeCustomerId(db, "cus_123");

    expect(result).toEqual({
      id: "acct-1",
      name: "Acme Inc",
      plan: "trial",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      trialEndsAt: RAW_ACCOUNT_ROW.trial_ends_at,
      policyOverrides: {},
      createdAt: RAW_ACCOUNT_ROW.created_at,
      updatedAt: RAW_ACCOUNT_ROW.updated_at,
    });
  });

  it("returns null — never throws — when no billing account is bound to that stripe customer id", async () => {
    const db = mockDbCapturing(captured, []);

    await expect(
      getBillingAccountByStripeCustomerId(db, "cus_unknown")
    ).resolves.toBeNull();
  });

  // Same fix, same remap shape as getBillingAccountForWorkspace above (both
  // call the same module-private toDate/toDateOrNull) — one discriminating
  // case here for parity, not the full matrix already covered above.
  it("coerces raw Postgres wire-text timestamps into real Date instances at the exact expected epoch", async () => {
    const rawWireRow = {
      ...RAW_ACCOUNT_ROW,
      current_period_end: "2026-08-19 09:05:34.525288+00",
      trial_ends_at: "2026-08-12 00:00:00.000000+00",
    };
    const db = mockDbCapturing(captured, [rawWireRow]);

    const result = await getBillingAccountByStripeCustomerId(db, "cus_123");

    expect(result?.currentPeriodEnd).toBeInstanceOf(Date);
    expect(result?.currentPeriodEnd?.getTime()).toBe(
      Date.UTC(2026, 7, 19, 9, 5, 34, 525)
    );
    expect(result?.trialEndsAt).toBeInstanceOf(Date);
    expect(result?.trialEndsAt.getTime()).toBe(Date.UTC(2026, 7, 12, 0, 0, 0, 0));
  });
});
