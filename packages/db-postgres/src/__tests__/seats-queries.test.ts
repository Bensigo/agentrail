import { describe, it, expect, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * seats.ts's five functions all take `db` as an explicit parameter — the
 * same `billing_accounts.ts` convention (see `billing-accounts-queries.test.ts`'s
 * own doc-comment) — so the mock here is a plain object passed directly at
 * the call site, no `vi.mock("../db.js")` module interception required.
 * Same "capture the SQL object passed to `db.execute`, render it with
 * drizzle's `PgDialect`" technique as that file.
 */
import {
  claimSeat,
  releaseSeat,
  releaseUserSeatForAccount,
  collapseIdentitySeatsForUser,
  listActiveSeatsWithHolders,
} from "../queries/seats.js";
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

/**
 * For `collapseIdentitySeatsForUser`: a `Db` whose `.transaction(fn)` invokes
 * `fn` with a `tx` that captures every `execute()` call, in order, and
 * resolves each from `resolveQueue` (also in call order) — this is what lets
 * a test prove the whole multi-statement operation runs inside exactly ONE
 * transaction (a single `db.transaction` call), rather than as several
 * independent `db.execute` calls that could interleave with someone else's
 * writes between them.
 */
function mockTxDbCapturing(calls: unknown[], resolveQueue: unknown[][]): Db {
  let callIndex = 0;
  const tx = {
    execute: (q: unknown) => {
      calls.push(q);
      const result = resolveQueue[callIndex] ?? [];
      callIndex += 1;
      return Promise.resolve(result);
    },
  };
  return {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
}

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;
const renderParams = (q: unknown) => new PgDialect().sqlToQuery(q as never).params;

beforeEach(() => {
  captured.length = 0;
});

describe("claimSeat", () => {
  describe("user subject", () => {
    it("inserts into seats with user_id set", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
        claimedVia: "console",
      });
      expect(captured).toHaveLength(1);
      const sql = render(captured[0]);
      expect(sql).toMatch(/insert into\s+seats/i);
      expect(sql).toMatch(/\buser_id\b/i);
    });

    it("guards the insert with ON CONFLICT against the active-user partial index, repeating its WHERE predicate", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
        claimedVia: "console",
      });
      const sql = render(captured[0]);
      expect(sql).toMatch(/on conflict\s*\(\s*billing_account_id\s*,\s*user_id\s*\)/i);
      expect(sql).toMatch(/where.*released_at\s+is\s+null.*user_id\s+is\s+not\s+null/is);
      expect(sql).toMatch(/do nothing/i);
    });

    it("never mentions chat_identity_id — this branch only ever writes user_id", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
        claimedVia: "console",
      });
      const sql = render(captured[0]);
      expect(sql).not.toMatch(/chat_identity_id/i);
    });

    it("binds billingAccountId, userId, and claimedVia as parameters, never string-interpolated", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
        claimedVia: "telegram",
      });
      const sql = render(captured[0]);
      const params = renderParams(captured[0]);
      expect(params).toEqual(["acct-1", "user-1", "telegram"]);
      expect(sql).not.toContain("acct-1");
      expect(sql).not.toContain("user-1");
      expect(sql).not.toContain("telegram");
    });
  });

  describe("chat identity subject", () => {
    it("inserts into seats with chat_identity_id set", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
        claimedVia: "telegram",
      });
      expect(captured).toHaveLength(1);
      const sql = render(captured[0]);
      expect(sql).toMatch(/insert into\s+seats/i);
      expect(sql).toMatch(/chat_identity_id/i);
    });

    it("guards the insert with ON CONFLICT against the active-identity partial index, repeating its WHERE predicate", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
        claimedVia: "telegram",
      });
      const sql = render(captured[0]);
      expect(sql).toMatch(
        /on conflict\s*\(\s*billing_account_id\s*,\s*chat_identity_id\s*\)/i
      );
      expect(sql).toMatch(
        /where.*released_at\s+is\s+null.*chat_identity_id\s+is\s+not\s+null/is
      );
      expect(sql).toMatch(/do nothing/i);
    });

    it("never mentions a bare user_id column — this branch only ever writes chat_identity_id", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
        claimedVia: "telegram",
      });
      const sql = render(captured[0]);
      expect(sql).not.toMatch(/\buser_id\b/i);
    });

    it("binds billingAccountId, chatIdentityId, and claimedVia as parameters, never string-interpolated", async () => {
      const db = mockDbCapturing(captured, []);
      await claimSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
        claimedVia: "discord",
      });
      const sql = render(captured[0]);
      const params = renderParams(captured[0]);
      expect(params).toEqual(["acct-1", "ci-1", "discord"]);
      expect(sql).not.toContain("acct-1");
      expect(sql).not.toContain("ci-1");
      expect(sql).not.toContain("discord");
    });
  });

  it("never issues a separate lookup before the INSERT — ON CONFLICT DO NOTHING is the whole call, one statement", async () => {
    const db = mockDbCapturing(captured, []);
    await claimSeat(db, {
      billingAccountId: "acct-1",
      subject: { userId: "user-1" },
      claimedVia: "console",
    });
    expect(captured).toHaveLength(1);
  });
});

describe("releaseSeat", () => {
  it("issues an UPDATE against seats, setting released_at to now()", async () => {
    const db = mockDbCapturing(captured, []);
    await releaseSeat(db, "seat-1");
    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/update\s+seats/i);
    expect(sql).toMatch(/set\s+released_at\s*=\s*now\(\)/i);
  });

  it("is fill-only — guards the UPDATE with released_at IS NULL, never re-releases an already-released seat", async () => {
    const db = mockDbCapturing(captured, []);
    await releaseSeat(db, "seat-1");
    const sql = render(captured[0]);
    expect(sql).toMatch(/where.*released_at\s+is\s+null/is);
  });

  it("scopes the UPDATE to the given seat id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, []);
    await releaseSeat(db, "seat-1");
    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/where.*\bid\s*=/is);
    expect(params).toContain("seat-1");
    expect(sql).not.toContain("seat-1");
  });
});

describe("releaseUserSeatForAccount", () => {
  it("issues an UPDATE against seats, setting released_at to now()", async () => {
    const db = mockDbCapturing(captured, []);
    await releaseUserSeatForAccount(db, { billingAccountId: "acct-1", userId: "user-1" });
    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/update\s+seats/i);
    expect(sql).toMatch(/set\s+released_at\s*=\s*now\(\)/i);
  });

  it("is fill-only — guards the UPDATE with released_at IS NULL", async () => {
    const db = mockDbCapturing(captured, []);
    await releaseUserSeatForAccount(db, { billingAccountId: "acct-1", userId: "user-1" });
    const sql = render(captured[0]);
    expect(sql).toMatch(/where.*released_at\s+is\s+null/is);
  });

  it("scopes to billing_account_id AND user_id, bound not interpolated", async () => {
    const db = mockDbCapturing(captured, []);
    await releaseUserSeatForAccount(db, { billingAccountId: "acct-1", userId: "user-1" });
    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/where.*billing_account_id\s*=/is);
    expect(sql).toMatch(/\buser_id\s*=/i);
    expect(params).toEqual(expect.arrayContaining(["acct-1", "user-1"]));
    expect(sql).not.toContain("acct-1");
    expect(sql).not.toContain("user-1");
  });
});

describe("collapseIdentitySeatsForUser", () => {
  it("runs entirely inside one db.transaction — never calls db.execute directly", async () => {
    let transactionCalls = 0;
    const db = {
      transaction: (fn: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        return fn({ execute: () => Promise.resolve([]) });
      },
      execute: () => {
        throw new Error("must not call db.execute directly — everything must go through tx");
      },
    } as unknown as Db;

    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });
    expect(transactionCalls).toBe(1);
  });

  it("first selects every billing account where the identity holds an active seat", async () => {
    const db = mockTxDbCapturing(captured, [[]]);
    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/select\s+billing_account_id/i);
    expect(sql).toMatch(/from\s+seats/i);
    expect(sql).toMatch(/where.*chat_identity_id\s*=/is);
    expect(sql).toMatch(/released_at\s+is\s+null/i);
    expect(params).toContain("ci-1");
    expect(sql).not.toContain("ci-1");
  });

  it("does nothing further when the identity holds no active seat anywhere", async () => {
    const db = mockTxDbCapturing(captured, [[]]);
    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });
    expect(captured).toHaveLength(1); // just the discovery SELECT
  });

  it("for each account found, claims a user-seat then releases the identity-seat, in that order", async () => {
    const db = mockTxDbCapturing(captured, [
      [{ billing_account_id: "acct-1" }, { billing_account_id: "acct-2" }],
    ]);
    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });

    // 1 discovery SELECT + (1 claim + 1 release) per account.
    expect(captured).toHaveLength(5);

    const claim1 = render(captured[1]);
    expect(claim1).toMatch(/insert into\s+seats/i);
    expect(claim1).toMatch(/\buser_id\b/i);
    expect(claim1).toMatch(/on conflict/i);
    expect(claim1).toMatch(/do nothing/i);

    const release1 = render(captured[2]);
    expect(release1).toMatch(/update\s+seats/i);
    expect(release1).toMatch(/set\s+released_at\s*=\s*now\(\)/i);
    expect(release1).toMatch(/chat_identity_id\s*=/i);

    const claim2 = render(captured[3]);
    expect(claim2).toMatch(/insert into\s+seats/i);

    const release2 = render(captured[4]);
    expect(release2).toMatch(/update\s+seats/i);
  });

  it("scopes each account's claim to that account's billing_account_id and the given userId, bound not interpolated", async () => {
    const db = mockTxDbCapturing(captured, [[{ billing_account_id: "acct-1" }]]);
    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });

    const claimParams = renderParams(captured[1]);
    const claimSql = render(captured[1]);
    expect(claimParams).toEqual(expect.arrayContaining(["acct-1", "user-1"]));
    expect(claimSql).not.toContain("acct-1");
    expect(claimSql).not.toContain("user-1");
  });

  it("scopes each account's release to that account's billing_account_id and the identity, fill-only", async () => {
    const db = mockTxDbCapturing(captured, [[{ billing_account_id: "acct-1" }]]);
    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });

    const releaseSql = render(captured[2]);
    const releaseParams = renderParams(captured[2]);
    expect(releaseSql).toMatch(/where.*released_at\s+is\s+null/is);
    expect(releaseParams).toEqual(expect.arrayContaining(["acct-1", "ci-1"]));
    expect(releaseSql).not.toContain("acct-1");
  });

  it("binds the CORRECT account per iteration — account 2's claim/release use acct-2, not a stale acct-1", async () => {
    const db = mockTxDbCapturing(captured, [
      [{ billing_account_id: "acct-1" }, { billing_account_id: "acct-2" }],
    ]);
    await collapseIdentitySeatsForUser(db, { chatIdentityId: "ci-1", userId: "user-1" });

    const claim1Params = renderParams(captured[1]);
    const release1Params = renderParams(captured[2]);
    const claim2Params = renderParams(captured[3]);
    const release2Params = renderParams(captured[4]);

    expect(claim1Params).toEqual(expect.arrayContaining(["acct-1", "user-1"]));
    expect(release1Params).toEqual(expect.arrayContaining(["acct-1", "ci-1"]));
    expect(claim2Params).toEqual(expect.arrayContaining(["acct-2", "user-1"]));
    expect(release2Params).toEqual(expect.arrayContaining(["acct-2", "ci-1"]));
    // The account ids must not be swapped or stuck on the first iteration's value.
    expect(claim2Params).not.toEqual(claim1Params);
    expect(release2Params).not.toEqual(release1Params);
  });
});

describe("listActiveSeatsWithHolders", () => {
  const RAW_USER_SEAT_ROW = {
    id: "seat-1",
    claimed_via: "console",
    claimed_at: new Date("2026-07-20T00:00:00Z"),
    user_id: "user-1",
    chat_identity_id: null,
    user_name: "Ada Lovelace",
    user_email: "ada@example.com",
    identity_display_name: null,
    identity_platform: null,
  };

  const RAW_IDENTITY_SEAT_ROW = {
    id: "seat-2",
    claimed_via: "telegram",
    claimed_at: new Date("2026-07-21T00:00:00Z"),
    user_id: null,
    chat_identity_id: "ci-1",
    user_name: null,
    user_email: null,
    identity_display_name: "Grace",
    identity_platform: "telegram",
  };

  it("selects from seats LEFT JOIN users LEFT JOIN chat_identities, scoped to active seats for the account", async () => {
    const db = mockDbCapturing(captured, [RAW_USER_SEAT_ROW]);
    await listActiveSeatsWithHolders(db, "acct-1");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(sql).toMatch(/from\s+seats/i);
    expect(sql).toMatch(/left join\s+users/i);
    expect(sql).toMatch(/left join\s+chat_identities/i);
    expect(sql).toMatch(/where.*billing_account_id\s*=/is);
    expect(sql).toMatch(/released_at\s+is\s+null/i);
    expect(params).toContain("acct-1");
    expect(sql).not.toContain("acct-1");
  });

  it("labels a user-held seat with the user's name", async () => {
    const db = mockDbCapturing(captured, [RAW_USER_SEAT_ROW]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]).toMatchObject({
      id: "seat-1",
      holderKind: "user",
      holderLabel: "Ada Lovelace",
    });
  });

  it("falls back to email when the user has no name", async () => {
    const db = mockDbCapturing(captured, [{ ...RAW_USER_SEAT_ROW, user_name: null }]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]?.holderLabel).toBe("ada@example.com");
  });

  it("falls back to a generic label — never a raw UUID — when the user has neither name nor email", async () => {
    const db = mockDbCapturing(captured, [
      { ...RAW_USER_SEAT_ROW, user_name: null, user_email: null },
    ]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]?.holderLabel).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(result[0]?.holderLabel).toBe("Unknown member");
  });

  it("labels an identity-held seat with display_name + platform", async () => {
    const db = mockDbCapturing(captured, [RAW_IDENTITY_SEAT_ROW]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]).toMatchObject({
      id: "seat-2",
      holderKind: "identity",
      holderLabel: "Grace (telegram)",
    });
  });

  it("falls back to a generic label + platform — never a raw UUID — when the identity has no display_name", async () => {
    const db = mockDbCapturing(captured, [
      { ...RAW_IDENTITY_SEAT_ROW, identity_display_name: null },
    ]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]?.holderLabel).toBe("Unknown (telegram)");
  });

  it("passes claimedVia through as-is", async () => {
    const db = mockDbCapturing(captured, [RAW_USER_SEAT_ROW]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]?.claimedVia).toBe("console");
  });

  it("coerces claimed_at from raw Postgres wire-text into a real Date at the exact expected epoch", async () => {
    const db = mockDbCapturing(captured, [
      { ...RAW_USER_SEAT_ROW, claimed_at: "2026-07-20 09:05:34.525288+00" },
    ]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]?.claimedAt).toBeInstanceOf(Date);
    expect(result[0]?.claimedAt.getTime()).toBe(Date.UTC(2026, 6, 20, 9, 5, 34, 525));
  });

  it("passes an already-Date claimed_at through unchanged (double-wrap safety)", async () => {
    const db = mockDbCapturing(captured, [RAW_USER_SEAT_ROW]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");
    expect(result[0]?.claimedAt).toBe(RAW_USER_SEAT_ROW.claimed_at);
  });

  it("returns [] for an account with no active seats", async () => {
    const db = mockDbCapturing(captured, []);
    const result = await listActiveSeatsWithHolders(db, "acct-empty");
    expect(result).toEqual([]);
  });

  it("maps a mixed result set (user-held + identity-held rows together) without cross-contamination, preserving row order", async () => {
    const db = mockDbCapturing(captured, [RAW_USER_SEAT_ROW, RAW_IDENTITY_SEAT_ROW]);
    const result = await listActiveSeatsWithHolders(db, "acct-1");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "seat-1",
      holderKind: "user",
      holderLabel: "Ada Lovelace",
    });
    expect(result[1]).toMatchObject({
      id: "seat-2",
      holderKind: "identity",
      holderLabel: "Grace (telegram)",
    });
  });
});
