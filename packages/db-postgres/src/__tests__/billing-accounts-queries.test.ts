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
