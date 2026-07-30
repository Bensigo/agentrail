import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `createWorkspace` is the normal (non-owner-elect) workspace creation path:
 * inside ONE transaction, insert the workspace row, then grant its creator
 * an `owner` membership. Slice-3 Task 6 adds a THIRD write to the same
 * transaction — a trial `billing_accounts` row, stamped onto the workspace —
 * closing the gap the 0062 migration's backfill left standing for NEW
 * workspaces (see that migration + `schema/billing_accounts.ts` for the
 * full design, and `completeOwnerElectWorkspace`'s own doc-comment for the
 * sibling path this mirrors). There is no live-DB harness in this package
 * (every spec mocks `db`) — mirroring `create-workspace-owner-elect.test.ts`
 * and `replace-memory-items.test.ts`, `db.transaction` is mocked to run its
 * callback against the same mock `db`, capturing every statement's table,
 * values, and (for the guarded UPDATE) WHERE condition. The WHERE condition
 * is opaque as a raw object, so — mirroring `create-workspace-owner-elect
 * .test.ts` — it is rendered via drizzle's `PgDialect` and compared to the
 * literal condition it must encode.
 */

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{ op: "insert" | "update"; table: unknown }>,
  workspaceRow: undefined as unknown,
  billingAccountRow: undefined as unknown,
  insertValuesByCallIndex: [] as unknown[],
  insertErrorForTable: undefined as { table: unknown; error: Error } | undefined,
  updateSet: undefined as unknown,
  updateWhere: undefined as unknown,
  updateTable: undefined as unknown,
}));

vi.mock("../db.js", () => {
  const db = {
    // Run the callback against the same mock so every statement (workspace
    // insert, membership insert, billing-account insert, workspace stamp)
    // is captured as happening "inside" the one transaction — same idiom as
    // create-workspace-owner-elect.test.ts / replace-memory-items.test.ts.
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    insert: (table: unknown) => ({
      values: (v: unknown) => {
        const run = async () => {
          mockState.calls.push({ op: "insert", table });
          mockState.insertValuesByCallIndex.push(v);
          if (mockState.insertErrorForTable?.table === table) {
            throw mockState.insertErrorForTable.error;
          }
        };
        return {
          returning: async () => {
            await run();
            if (table === workspaces) return [mockState.workspaceRow];
            if (table === billingAccounts) return [mockState.billingAccountRow];
            return [];
          },
          // workspaceMemberships is inserted with no .returning() chained
          // (the real code just `await`s the .values(...) call directly) —
          // this makes the returned object itself awaitable.
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            run().then(() => resolve(undefined), reject);
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (s: unknown) => ({
        where: async (w: unknown) => {
          mockState.calls.push({ op: "update", table });
          mockState.updateTable = table;
          mockState.updateSet = s;
          mockState.updateWhere = w;
          return undefined;
        },
      }),
    }),
  };
  return { db };
});

import { workspaces } from "../schema/workspaces.js";
import { workspaceMemberships } from "../schema/workspace_memberships.js";
import { billingAccounts } from "../schema/billing_accounts.js";
import { createWorkspace } from "../queries/index.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-30T00:00:00Z");
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockState.calls = [];
  mockState.insertValuesByCallIndex = [];
  mockState.insertErrorForTable = undefined;
  mockState.updateTable = undefined;
  mockState.updateSet = undefined;
  mockState.updateWhere = undefined;
  mockState.workspaceRow = {
    id: "ws-new-1",
    name: "Acme",
    slug: "acme",
    createdAt: NOW,
    updatedAt: NOW,
    baselineWindowDays: 30,
    discordWebhookUrl: null,
    billingAccountId: null,
  };
  mockState.billingAccountRow = {
    id: "acct-new-1",
    name: "Acme",
    plan: "trial",
    trialEndsAt: new Date(NOW.getTime() + FOURTEEN_DAYS_MS),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkspace", () => {
  it("inserts the workspace row into `workspaces` with exactly {name, slug}", async () => {
    await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(mockState.calls[0]).toEqual({ op: "insert", table: workspaces });
    expect(mockState.insertValuesByCallIndex[0]).toEqual({ name: "Acme", slug: "acme" });
  });

  it("grants the creator an owner membership on the new workspace", async () => {
    await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(mockState.calls[1]).toEqual({ op: "insert", table: workspaceMemberships });
    expect(mockState.insertValuesByCallIndex[1]).toEqual({
      workspaceId: "ws-new-1",
      userId: "user-1",
      role: "owner",
    });
  });

  it("inserts a trial billing account named after the workspace, trialEndsAt = now + 14 days", async () => {
    await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(mockState.calls[2]).toEqual({ op: "insert", table: billingAccounts });
    expect(mockState.insertValuesByCallIndex[2]).toEqual({
      name: "Acme",
      plan: "trial",
      trialEndsAt: new Date(NOW.getTime() + FOURTEEN_DAYS_MS),
    });
  });

  it("stamps the new workspace's billing_account_id, guarded by billing_account_id IS NULL (idempotent-shaped, mirrors the 0062 backfill and completeOwnerElectWorkspace)", async () => {
    await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(mockState.calls[3]).toEqual({ op: "update", table: workspaces });
    expect(mockState.updateSet).toEqual({ billingAccountId: "acct-new-1" });
    expect(renderCondition(mockState.updateWhere)).toEqual(
      renderCondition(and(eq(workspaces.id, "ws-new-1"), isNull(workspaces.billingAccountId)))
    );
  });

  it("runs all four writes in order: workspace insert, membership insert, billing-account insert, workspace stamp — all inside the one transaction", async () => {
    await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(mockState.calls.map((c) => c.op)).toEqual(["insert", "insert", "insert", "update"]);
    expect(mockState.calls.map((c) => c.table)).toEqual([
      workspaces,
      workspaceMemberships,
      billingAccounts,
      workspaces,
    ]);
  });

  it("returns the workspace row reflecting the freshly-stamped billing_account_id, not the stale pre-stamp null", async () => {
    const result = await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(result.billingAccountId).toBe("acct-new-1");
    expect(result.id).toBe("ws-new-1");
  });

  it("skips billing-account creation entirely when the freshly-inserted workspace row already carries a billing_account_id (defensive guard parity with completeOwnerElectWorkspace, even though createWorkspace never sets one today)", async () => {
    mockState.workspaceRow = {
      ...(mockState.workspaceRow as Record<string, unknown>),
      billingAccountId: "acct-already-there",
    };

    const result = await createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" });

    expect(mockState.calls.map((c) => c.op)).toEqual(["insert", "insert"]);
    expect(mockState.calls.some((c) => c.table === billingAccounts)).toBe(false);
    expect(result.billingAccountId).toBe("acct-already-there");
  });

  it("a different name/slug/userId triple is bound exactly, not a stale one from a prior call", async () => {
    mockState.workspaceRow = {
      id: "ws-new-2",
      name: "Beta",
      slug: "beta",
      createdAt: NOW,
      updatedAt: NOW,
      baselineWindowDays: 30,
      discordWebhookUrl: null,
      billingAccountId: null,
    };
    mockState.billingAccountRow = { id: "acct-new-2", name: "Beta", plan: "trial" };

    await createWorkspace({ name: "Beta", slug: "beta", userId: "user-2" });

    expect(mockState.insertValuesByCallIndex[0]).toEqual({ name: "Beta", slug: "beta" });
    expect(mockState.insertValuesByCallIndex[1]).toEqual({
      workspaceId: "ws-new-2",
      userId: "user-2",
      role: "owner",
    });
    expect(mockState.insertValuesByCallIndex[2]).toMatchObject({ name: "Beta", plan: "trial" });
    expect(renderCondition(mockState.updateWhere)).toEqual(
      renderCondition(and(eq(workspaces.id, "ws-new-2"), isNull(workspaces.billingAccountId)))
    );
  });

  it("propagates a thrown billing-account insert error rather than swallowing it — the membership grant above it still ran (same transaction, so it rolls back together, not left half-done by this function's own logic)", async () => {
    const err = new Error("billing_accounts insert failed");
    mockState.insertErrorForTable = { table: billingAccounts, error: err };

    await expect(
      createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" })
    ).rejects.toThrow(err);

    expect(mockState.calls.map((c) => c.op)).toEqual(["insert", "insert", "insert"]);
  });

  it("propagates a thrown workspace-insert error (e.g. a slug unique violation) and never reaches the membership grant or billing account", async () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "workspaces_slug_unique"'),
      { code: "23505" }
    );
    mockState.insertErrorForTable = { table: workspaces, error: err };

    await expect(
      createWorkspace({ name: "Acme", slug: "acme", userId: "user-1" })
    ).rejects.toThrow(err);

    expect(mockState.calls).toEqual([{ op: "insert", table: workspaces }]);
  });
});
