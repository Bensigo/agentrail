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
  listAccountWorkspaceIds,
  countActiveSeats,
  bindStripeCustomer,
  getBillingAccountByStripeCustomerId,
  applySubscriptionState,
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
});

describe("applySubscriptionState", () => {
  const baseArgs = {
    billingAccountId: "acct-1",
    plan: "growth" as const,
    subscriptionStatus: "active",
    stripeSubscriptionId: "sub_123",
    currentPeriodEnd: new Date("2026-08-29T00:00:00Z"),
  };

  it("issues exactly one UPDATE against billing_accounts", async () => {
    const db = mockDbCapturing(captured, []);

    await applySubscriptionState(db, baseArgs);

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/update\s+billing_accounts/i);
  });

  it("SET clause contains exactly plan, subscription_status, stripe_subscription_id, current_period_end, updated_at — no other columns", async () => {
    const db = mockDbCapturing(captured, []);

    await applySubscriptionState(db, baseArgs);

    const sql = render(captured[0]);
    const setClause = sql.match(/set\s+(.*?)\s+where/is)?.[1] ?? "";
    const setColumns = setClause
      .split(",")
      .map((clause) => clause.trim().split(/\s*=\s*/)[0]!.trim())
      .sort();

    expect(setColumns).toEqual(
      [
        "plan",
        "subscription_status",
        "stripe_subscription_id",
        "current_period_end",
        "updated_at",
      ].sort()
    );
  });

  it("scopes the UPDATE to the given billing account id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, []);

    await applySubscriptionState(db, baseArgs);

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/where\s+id\s*=/i);
    expect(params).toContain("acct-1");
    expect(sql).not.toContain("acct-1");
  });

  it("binds plan, subscriptionStatus, stripeSubscriptionId as parameters (never string-interpolated into the SQL text)", async () => {
    const db = mockDbCapturing(captured, []);

    await applySubscriptionState(db, baseArgs);

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(params).toContain("growth");
    expect(params).toContain("active");
    expect(params).toContain("sub_123");
    expect(params).toContain(baseArgs.currentPeriodEnd);
    expect(sql).not.toContain("sub_123");
  });

  it("writes SQL NULL (not skips the column, not a coalesced default) when stripeSubscriptionId and currentPeriodEnd are null", async () => {
    const db = mockDbCapturing(captured, []);

    await applySubscriptionState(db, {
      billingAccountId: "acct-1",
      plan: "starter",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/stripe_subscription_id\s*=/i);
    expect(sql).toMatch(/current_period_end\s*=/i);
    // Count-based, not just presence: proves BOTH stripeSubscriptionId and
    // currentPeriodEnd are null-bound, not just one of the two.
    expect((params as unknown[]).filter((p) => p === null)).toHaveLength(2);
  });
});
