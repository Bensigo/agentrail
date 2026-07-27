import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * #1480 — the `repositories.name` case mismatch is a property of the COLUMN,
 * not of `getRepositoryByName`.
 *
 * Writes store GitHub's own casing (`runner/repos` passes `created.full_name`,
 * so this project's row reads "Bensigo/agentrail"); reads arrive lowercased
 * (`agentrail.shared.git.origin_repo_full_name` lowercases what it parses out
 * of the git remote). #1478 folded `getRepositoryByName` and scoped itself to
 * that function's nine callers — but two more exact matches on the same column
 * survived it, and one of them INSERTS on a miss.
 *
 * These pin both, and pin the invariant #1478's own reasoning assumed but
 * nothing enforced: a case variant must not manufacture a second repositories
 * row. There is no unique constraint on `(workspace_id, name)` to catch that
 * (migrations/0003_add_repositories.sql creates only the workspaces FK), so
 * the guarantee has to live here.
 *
 * Same "mock the chain, render conditions through PgDialect" approach the rest
 * of this suite uses (see claim-queue-entry-work-item.test.ts).
 */

const mockState = vi.hoisted(() => ({
  executeCalls: 0,
  claimRow: undefined as Record<string, unknown> | undefined,
  /**
   * A FAITHFUL fake of the `repositories` table, not a canned result.
   *
   * A mock that returns a row regardless of the `where` it was handed would
   * pass whether or not the query case-folds — the exact tautology that let
   * this bug survive #1478's own test suite. Instead `limit()` below RENDERS
   * the captured condition and applies it, so "finds the row" and "does not
   * insert a duplicate" are genuine claims about the SQL under test.
   */
  repoTable: [] as Array<{ id: string; workspaceId: string; name: string }>,
  /** What `getLatestOnboardMemoryAt`'s aggregate select resolves to, when set. */
  aggregateRows: undefined as Array<Record<string, unknown>> | undefined,
  /** Every `where(...)` condition the select chain received. */
  capturedWheres: [] as unknown[],
  /** `true` once `.orderBy(...)` is called on the select chain. */
  orderByCalled: false,
  /** Which tables `db.insert` was called with, in order. */
  insertedInto: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  db: {
    execute: async () => {
      mockState.executeCalls += 1;
      if (mockState.executeCalls <= 2) return []; // reconcileStaleRuns sweeps
      return mockState.claimRow ? [mockState.claimRow] : [];
    },
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = (cond: unknown) => {
        mockState.capturedWheres.push(cond);
        return chain;
      };
      chain.orderBy = () => {
        mockState.orderByCalled = true;
        return chain;
      };
      // Apply the condition the query actually built, rather than handing
      // back a canned row — see `repoTable`'s comment.
      chain.limit = async () => {
        const cond = mockState.capturedWheres[mockState.capturedWheres.length - 1];
        const { sql, params } = new PgDialect().sqlToQuery(cond as never);
        const [workspaceId, name] = params as [string, string];
        // `lower(x) = lower($n)` folds; a bare `=` does not. This is the ONE
        // behavioral difference the fix introduces, so the fake honors it.
        const folds = /lower\([^)]*"name"\)\s*=\s*lower\(/.test(sql);
        return mockState.repoTable
          .filter(
            (r) =>
              r.workspaceId === workspaceId &&
              (folds ? r.name.toLowerCase() === name.toLowerCase() : r.name === name)
          )
          .map((r) => ({ id: r.id }));
      };
      // `getLatestOnboardMemoryAt` awaits the chain directly after `where`
      // (no limit) — make it thenable so both shapes resolve.
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(mockState.aggregateRows ?? []).then(resolve);
      return chain;
    },
    insert: (table: unknown) => {
      mockState.insertedInto.push(table);
      return {
        values: () => ({
          onConflictDoUpdate: async () => undefined,
          returning: async () => [{ id: "repo-new" }],
        }),
      };
    },
  },
}));

import { claimQueueEntry } from "../queries/runner.js";
import { getLatestOnboardMemoryAt } from "../queries/index.js";
import { repositories } from "../schema/repositories.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;

/** An entry whose `external_id` carries a parseable, LOWERCASED slug — the
 * exact shape `deriveRepoSlug` passes straight through to the lookup. */
const CLAIMABLE_ROW = {
  id: "qe-1",
  workspace_id: "ws-1",
  source: "github",
  kind: "issue",
  external_id: "bensigo/agentrail#42",
  title: "Fix it",
  body: "body",
  tier: 0,
  estimated_budget_usd: null,
  model_override: null,
};

beforeEach(() => {
  mockState.executeCalls = 0;
  mockState.claimRow = undefined;
  mockState.repoTable = [];
  mockState.aggregateRows = undefined;
  mockState.capturedWheres = [];
  mockState.orderByCalled = false;
  mockState.insertedInto = [];
});

describe("findOrCreateRepository — reached through claimQueueEntry", () => {
  it("matches a stored 'Bensigo/agentrail' from a lowercased slug, and does NOT insert a second row", async () => {
    mockState.claimRow = CLAIMABLE_ROW;
    // The workspace already has the repo — stored with GitHub's own casing.
    mockState.repoTable = [{ id: "repo-existing", workspaceId: "ws-1", name: "Bensigo/agentrail" }];

    await claimQueueEntry("ws-1");

    // The regression this exists for: an exact `eq` would have missed the
    // stored row and inserted a colliding `bensigo/agentrail` alongside it.
    expect(mockState.insertedInto).not.toContain(repositories);
  });

  it("folds BOTH sides of the name comparison — not a plain equality", async () => {
    mockState.claimRow = CLAIMABLE_ROW;
    // Stored with GitHub's own casing, as `runner/repos` writes it.
    mockState.repoTable = [{ id: "repo-existing", workspaceId: "ws-1", name: "Bensigo/agentrail" }];

    await claimQueueEntry("ws-1");

    const sql = mockState.capturedWheres.map(render).join(" | ");
    expect(sql).toContain("lower");
    // Both sides, not just the column: `lower(name) = 'Bensigo/Agentrail'`
    // would still miss on a differently-cased INPUT.
    expect(sql).toMatch(/lower\([^)]*"name"\)\s*=\s*lower\(/);
  });

  it("still scopes to the workspace — case-folding must not widen the scope", async () => {
    mockState.claimRow = CLAIMABLE_ROW;
    // Stored with GitHub's own casing, as `runner/repos` writes it.
    mockState.repoTable = [{ id: "repo-existing", workspaceId: "ws-1", name: "Bensigo/agentrail" }];

    await claimQueueEntry("ws-1");

    expect(mockState.capturedWheres.map(render).join(" | ")).toContain("workspace_id");
  });

  it("orders the lookup, so a workspace that already holds colliding rows resolves the same one every time", async () => {
    mockState.claimRow = CLAIMABLE_ROW;
    // Stored with GitHub's own casing, as `runner/repos` writes it.
    mockState.repoTable = [{ id: "repo-existing", workspaceId: "ws-1", name: "Bensigo/agentrail" }];

    await claimQueueEntry("ws-1");

    // Without this, `.limit(1)` over two colliding rows is a coin flip and the
    // same issue can ingest cost against a different repository_id per run.
    expect(mockState.orderByCalled).toBe(true);
  });
});

describe("getLatestOnboardMemoryAt", () => {
  it("folds BOTH sides of the name comparison (the OTHER exact match #1478 left behind)", async () => {
    mockState.aggregateRows = [{ onboardedAt: null, count: 0 }];

    await getLatestOnboardMemoryAt("ws-1", "bensigo/agentrail");

    const sql = mockState.capturedWheres.map(render).join(" | ");
    expect(sql).toMatch(/lower\([^)]*"name"\)\s*=\s*lower\(/);
  });

  it("still scopes to the workspace and to onboarder-written memory", async () => {
    mockState.aggregateRows = [{ onboardedAt: null, count: 0 }];

    await getLatestOnboardMemoryAt("ws-1", "bensigo/agentrail");

    const sql = mockState.capturedWheres.map(render).join(" | ");
    expect(sql).toContain("workspace_id");
    expect(sql).toContain("written_by");
  });
});
