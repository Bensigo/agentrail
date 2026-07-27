import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// getRepositoryByName must match "owner/repo" CASE-INSENSITIVELY.
//
// The two sides of that comparison disagree in production: writes store
// GitHub's own casing (runner/repos passes `created.full_name`, so this
// project's row reads "Bensigo/agentrail"), while reads arrive lowercased
// (agentrail.shared.git.origin_repo_full_name lowercases what it parses out
// of the git remote, and it feeds the factory's wiki client, the
// `context index` push path, and the hydration client).
//
// With an exact `eq` those never matched for any owner carrying an uppercase
// letter — and every caller reads a miss as "no such repo in this workspace",
// silently. The wiki client in particular falls back to a local cache an
// ephemeral clone does not have, so the executor just found nothing and
// carried on. That is why this is pinned at the QUERY level rather than left
// to an integration test: the failure mode is silence, not an error.
//
// Same "mock the chain, render conditions through PgDialect" approach as
// jace_sessions.repin.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { repositories } from "../schema/repositories.js";
import { getRepositoryByName } from "./index.js";

const mockDb = vi.mocked(db);
const dialect = new PgDialect();

function makeChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

function renderedWhere(chain: Record<string, unknown>): { sql: string; params: unknown[] } {
  const captured = (chain.where as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const query = dialect.sqlToQuery(captured);
  return { sql: query.sql, params: query.params };
}

describe("getRepositoryByName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("case-folds BOTH sides of the name comparison", () => {
    const chain = makeChain([]);
    mockDb.select.mockReturnValue(chain as never);

    getRepositoryByName("ws-1", "bensigo/agentrail");

    const actual = renderedWhere(chain);
    const expected = dialect.sqlToQuery(
      and(
        eq(repositories.workspaceId, "ws-1"),
        sql`lower(${repositories.name}) = lower(${"bensigo/agentrail"})`
      )!
    );
    expect(actual.sql).toBe(expected.sql);
    expect(actual.params).toEqual(expected.params);
  });

  it("is not a plain equality on name — the regression this guards", () => {
    const chain = makeChain([]);
    mockDb.select.mockReturnValue(chain as never);

    getRepositoryByName("ws-1", "bensigo/agentrail");

    const exactMatch = dialect.sqlToQuery(
      and(eq(repositories.workspaceId, "ws-1"), eq(repositories.name, "bensigo/agentrail"))!
    );
    expect(renderedWhere(chain).sql).not.toBe(exactMatch.sql);
  });

  it("still scopes to the workspace — case-folding must not widen the scope", () => {
    const chain = makeChain([]);
    mockDb.select.mockReturnValue(chain as never);

    getRepositoryByName("ws-1", "Bensigo/agentrail");

    const rendered = renderedWhere(chain);
    expect(rendered.params).toContain("ws-1");
    expect(rendered.sql).toContain("workspace_id");
  });

  it("returns null rather than undefined when nothing matches", async () => {
    const chain = makeChain([]);
    mockDb.select.mockReturnValue(chain as never);

    await expect(getRepositoryByName("ws-1", "bensigo/nope")).resolves.toBeNull();
  });

  it("returns the row when one matches", async () => {
    const row = { id: "repo-1", workspaceId: "ws-1", name: "Bensigo/agentrail" };
    const chain = makeChain([row]);
    mockDb.select.mockReturnValue(chain as never);

    await expect(getRepositoryByName("ws-1", "bensigo/agentrail")).resolves.toEqual(row);
  });
});
